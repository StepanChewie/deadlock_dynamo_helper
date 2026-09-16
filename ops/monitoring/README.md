# Monitoring the API container

## Why this exists

On 2026-09-16 the API container was unusable for **30 hours** and nobody noticed.
It had accumulated 14 179 zombie processes until the cgroup task counter was pinned
at `14192/14192`, so every `fork()` returned `EAGAIN`.

The reason it went unnoticed is the part worth remembering: **the service kept
answering HTTP 200 in 8 ms the whole time.** Node is single-process and
event-driven, so it serves requests without forking. Anything that monitors the
HTTP endpoint — and the stack here has no monitors at all, Uptime Kuma included —
stays green through the entire outage. Only two signals actually moved:

- the container's own health status, because its healthcheck forks `node -e`, and
- the cgroup task counter.

`deadlock-health-watch` watches exactly those.

## What it checks

| Check | Fails when |
|---|---|
| Container state | not `running` |
| Docker health | anything other than `healthy` (reports `FailingStreak`) |
| cgroup tasks | `pids.current` above `DEADLOCK_PIDS_WARN` (default 500), or unreadable |

The pids threshold is deliberately far below the ceiling: the point is to catch
growth **before** saturation, because at `pids.current == pids.max` the
healthcheck can never recover on its own.

## Install

```sh
sudo install -m 0755 ops/monitoring/deadlock-health-watch.sh /usr/local/bin/
sudo install -m 0644 ops/monitoring/deadlock-health-watch.service /etc/systemd/system/
sudo install -m 0644 ops/monitoring/deadlock-health-watch.timer   /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now deadlock-health-watch.timer
```

Check it:

```sh
systemctl list-timers deadlock-health-watch.timer
systemctl start deadlock-health-watch.service && journalctl -t deadlock-health-watch -n 20
```

## Notifications

Out of the box the script only writes to the journal, which is a local record, not
an alert. To get pushed notifications, create `/etc/deadlock-health-watch.env`:

```sh
# Discord webhook (create in the channel: Integrations -> Webhooks)
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...

# Or any command; receives <level> <message> as $1 and $2
# ALERT_CMD=/usr/local/bin/my-notifier

# Or an Uptime Kuma push monitor URL (Monitor type: Push)
# KUMA_PUSH_URL=http://127.0.0.1:3001/api/push/XXXXXXXX
```

Then `sudo systemctl restart deadlock-health-watch.timer` is not needed — the
config is read on every run.

The same file also carries the targets and thresholds (`DEADLOCK_CONTAINER`,
`DEADLOCK_PIDS_WARN`, `DEADLOCK_REMIND_MIN`, `DEADLOCK_STATE_FILE`); see the
table at the end. A value set there wins over the built-in default.

Keep the file `root:root 600`. A Discord webhook URL is a bearer credential —
anyone holding it can post to the channel without authentication — and the script
sources the file as root.

If a notification fails, the script logs
`notify: discord post FAILED (alert was not delivered)` to the journal. It uses
`curl --fail`, so an HTTP error from Discord is caught rather than silently
treated as success; a monitoring script that drops its own alerts quietly would
be worse than none.

Levels: `ALERT` on the transition into a bad state, `STILL-BAD` as a reminder every
`DEADLOCK_REMIND_MIN` (default 60), `RECOVERED` on the way back. The state file
`/var/lib/deadlock-health-watch/state` keeps this from spamming every minute.

## Test it without breaking anything

Force a bad state by pointing the script at a scratch config that loads the real
one and then lowers the threshold. This exercises the full production path —
config file, detection, notification — and posts a **real** alert, which is the
part worth verifying:

```sh
sudo install -m 600 /dev/null /tmp/scratch.env   # 600: it will carry the webhook
sudo tee /tmp/scratch.env >/dev/null <<'EOF'
source /etc/deadlock-health-watch.env
DEADLOCK_PIDS_WARN=1
EOF

sudo DEADLOCK_CONF=/tmp/scratch.env \
     DEADLOCK_STATE_FILE=/tmp/scratch.state \
     /usr/local/bin/deadlock-health-watch.sh; echo "exit=$? (1 = problem detected)"
journalctl -t deadlock-health-watch -n 5

sudo rm -f /tmp/scratch.env /tmp/scratch.state
```

`DEADLOCK_STATE_FILE` is redirected as well, so the latched state production
relies on is left alone. Run it a second time to confirm a sustained fault does
**not** re-alert — that is what `DEADLOCK_REMIND_MIN` gates.

Do **not** test by exporting `DEADLOCK_PIDS_WARN=1` on its own. The config file
is sourced after the environment is read and assigns the key outright, so a value
in `/etc/deadlock-health-watch.env` wins and the exported override is silently
ignored. Redirect the whole file with `DEADLOCK_CONF` instead.

A clean run is silent and exits 0. A detected problem logs one line, exits 1, and
therefore also shows up in `systemctl --failed` — a second, independent signal
that does not depend on any notification channel working.

## Overriding

| Variable | Default |
|---|---|
| `DEADLOCK_CONTAINER` | `deadlock_dynamo_helper-api-1` |
| `DEADLOCK_PIDS_WARN` | `500` |
| `DEADLOCK_REMIND_MIN` | `60` |
| `DEADLOCK_CONF` | `/etc/deadlock-health-watch.env` |
| `DEADLOCK_STATE_FILE` | `/var/lib/deadlock-health-watch/state` |
