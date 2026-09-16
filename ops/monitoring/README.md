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

Levels: `ALERT` on the transition into a bad state, `STILL-BAD` as a reminder every
`DEADLOCK_REMIND_MIN` (default 60), `RECOVERED` on the way back. The state file
`/var/lib/deadlock-health-watch/state` keeps this from spamming every minute.

## Test it without breaking anything

Force a bad state by lowering the threshold — the script reads thresholds from the
environment, and the config file only carries notification settings, so this does
not touch production:

```sh
sudo DEADLOCK_PIDS_WARN=1 /usr/local/bin/deadlock-health-watch.sh; echo "exit=$?"
journalctl -t deadlock-health-watch -n 5
sudo rm -f /var/lib/deadlock-health-watch/state   # clear the latched state
```

## Overriding

| Variable | Default |
|---|---|
| `DEADLOCK_CONTAINER` | `deadlock_dynamo_helper-api-1` |
| `DEADLOCK_PIDS_WARN` | `500` |
| `DEADLOCK_REMIND_MIN` | `60` |
| `DEADLOCK_CONF` | `/etc/deadlock-health-watch.env` |
| `DEADLOCK_STATE_FILE` | `/var/lib/deadlock-health-watch/state` |
