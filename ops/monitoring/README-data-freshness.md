# Watching the freshness of build data

## Why this exists

On 2026-09-17 the app produced **no build at all** for hours, and nothing anywhere
said so. Two things had quietly stopped:

- the global collection was hanging, so no new evidence was written;
- statlocker had rolled to a new patch, and the archetype snapshots and the
  matchup rows were still built for the previous one.

Both were invisible. `/deadlock/adaptive/v1/status` still reported a recent
`lastSuccessAt` — that field is shared with the per-hero path, so it says
"something refreshed", not that the global data did. And the collection's errors
were being swallowed into a `lastError` the endpoint did not expose.

The lesson is **not** "refresh more often". The refresh does run every 30 minutes,
and the cadence was verified across seven consecutive cycles. It is that a refresh
which stops working looks exactly like a healthy one until someone compares the
data's age against the cadence it is supposed to have. This unit makes that
comparison on a schedule, out of process, where a bug in the API cannot hide it.

## What it checks

| Check | Fails when | Default |
|---|---|---|
| Global evidence (`WPA_PATCH_DATA`, `T4_CHAINS`) | older than 2 h (cadence is 30 min) | `DEADLOCK_GLOBAL_MAX_AGE_SEC` |
| Matchup rows (`VS_HERO_WPA`) | upstream last reached more than 36 h ago (cadence 24 h) | `DEADLOCK_WPA_MAX_AGE_SEC` |
| Archetype snapshots | newest active one older than 36 h | `DEADLOCK_ARCHETYPE_MAX_AGE_SEC` |
| Patch consistency | newest evidence patch ≠ newest archetype patch | always on |
| Database reachable | `select 1` does not return | always on |

Two notes on what is deliberately *not* checked:

- **Per-hero datasets** (`CONSENSUS_SKELETON`, `PRO_BUILD_ANALYSIS`,
  `HERO_LEADERBOARD`, `WPA_FILTERED_ITEMS`) are only refreshed while heroes are
  active. Alerting on them would fire every time nobody played for a day.
- **`VS_HERO_WPA` in the evidence table** is always `UNAVAILABLE` by design — the
  dataset is relational-only and the snapshot store refuses it. That row's age is
  not a signal.
- **The age of the published `VS_HERO_WPA` snapshot is not used either**, even
  though an earlier version of this check read it. The raw snapshot is
  deduplicated by content hash, so its `fetchedAt` only advances when the upstream
  payload actually changes. Statlocker served byte-identical matchup data from
  2026-09-18 to 2026-09-21 — confirmed by a cycle that fetched it and got HTTP 200
  with the same hash — and the row's age grew the whole time while the data was
  perfectly fresh. The check now reads `vsHeroWpaLastCheckAt` from the status
  endpoint, which the refresh service records whenever it reaches upstream,
  published or not. That answers "how long since we last looked", which is the
  question that distinguishes a healthy refresh from one that has stopped.

  A consequence worth knowing: the value is in-memory, so it is absent for about a
  minute after the API restarts. The check treats absent as unknown rather than
  stale — the refresh re-runs within a minute of start anyway — and an unreachable
  status endpoint is reported as a finding in its own right.

The **patch-consistency** check is the one that would have caught the outage
outright. The app resolves a single patch id for the whole identity from the
newest evidence row, while archetype snapshots and matchup rows are built per
patch; when those drift, `getActive` finds nothing and every request answers
`BUILD_ARCHETYPE_V2_UNAVAILABLE`.

## Alerts

Alerts go to `DISCORD_WEBHOOK_URL`, falling back to `/etc/deadlock-health-watch.env`
so rotating the webhook stays a one-place change. `ALERT_CMD` receives
`<level> <message>` if you would rather route it elsewhere.

It speaks up on a **state change**: once when it goes bad, then at most every
`DEADLOCK_REMIND_MIN` minutes while still bad, and once when it recovers. A
persistent problem does not become a stream of duplicates, and a recovery is
reported rather than inferred from silence.

The unit exits 1 when something is stale, so `systemctl --failed` shows it too —
a second, independent signal from the alert itself.

## Install

The deploy workflow installs it from the checkout on every deploy (see
`.github/workflows/deploy.yml`). It also runs it once during the deploy and turns
a finding into a **warning, not a failure**: a stale dataset is a symptom to
investigate, and making it gate the pipeline would turn a reporting signal into an
outage path.

Config lives in `/etc/deadlock-data-freshness.env` and is never touched by the
deploy — thresholds and the webhook are server state, not repository state. The
file is sourced **before** the defaults are resolved, so a value in it wins over
an exported variable; for a one-off override point `DEADLOCK_FRESHNESS_CONF` at a
scratch file.

## Proving the alert path

Set `DEADLOCK_FRESHNESS_TEST_ALERT=1` and the message opens with
`TEST ALERT - not an incident`. Do this **whenever** you exercise the failure
path: the point of the test is to prove delivery, so it posts a real message to
the production channel — but without the marker it is word-for-word identical to a
genuine incident, and on 2026-09-16 that is exactly what happened with the backup
alert, which came back as a reported outage.

```
sudo DEADLOCK_FRESHNESS_TEST_ALERT=1 \
  DEADLOCK_GLOBAL_MAX_AGE_SEC=1 \
  /usr/local/bin/deadlock-data-freshness-watch.sh
```

That forces a stale verdict (everything is older than one second) without touching
any data.

## Journal

```
journalctl -t deadlock-data-freshness
```
