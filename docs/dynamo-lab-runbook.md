# Dynamo Lab Runbook

This guide walks through starting the Dynamo Lab telemetry bridge, loading the Overwolf client, and verifying real-time game telemetry and adaptive build recommendations from a Deadlock session.

---

## Prerequisites

Before you start, make sure you have the following installed:
1. **Node.js** (v20+ recommended, works with v18 using `--ignore-engines`)
2. **Yarn** (v1.22.x)
3. **Overwolf** (configured with Developer Mode enabled)
4. **Deadlock** (installed on Steam)

---

## Quick Start Instructions

### 1. Install Dependencies

Run from the root of the workspace to resolve and link workspace packages:

```bash
yarn install --ignore-engines
```

### 2. Build the Shared Package and Overwolf Client

Compile shared types and create the Overwolf Webpack bundle:

```bash
yarn workspace @dynamo-lab/shared build
```

```bash
yarn workspace @dynamo-lab/overwolf-client build
```

The production build also synchronizes `apps/overwolf-client/public` to the configured Windows sideload location.

### 3. Run the NestJS Ingest API

Launch the NestJS backend on port `3000`:

```bash
yarn workspace @dynamo-lab/api start:dev
```

Verify that the server has booted and is listening on `http://localhost:3000`.

---

## Loading the Overwolf App

1. Open the **Overwolf Client**.
2. Go to **Settings** > **Support** > **Development Options**.
3. Click **Load unpacked extension...**.
4. Select `apps/overwolf-client/public`, which contains `manifest.json`.
5. Confirm that the client (manifest `meta.name`, currently `Dynamo Lab` v0.1.15) opens and reaches `REGISTERED` after Deadlock starts.
6. Reload the unpacked extension after every new Overwolf client build.

---

## Telemetry Verification Flow

1. Launch **Deadlock** from Steam.
2. Confirm that GEP Integration changes to **REGISTERED**.
3. Confirm that the connection indicator changes to **NestJS API connected & sending** after the first telemetry batch.
4. Join a test lobby or Sandbox match.
5. Open `http://localhost:3000/deadlock/live/debug`.
6. Verify:
   - Match ID is extracted.
   - Game time updates.
   - The local player is identified.
   - Hero ID and inventory updates are present.
   - Raw events continue to arrive.

---

## Adaptive recommendation verification

The in-game overlay renders the semantic actions returned by `POST /deadlock/adaptive/v2/recommend` (`ready`, `blockers`, `nextAction`, `fullBuild`). The legacy per-second traversal snapshot endpoints (`/deadlock/live/build-recommendations`) were removed with the v1 serving path.

1. Check serving status and evidence freshness:

```bash
curl -sS https://aboba-telegramovich.duckdns.org/deadlock/adaptive/v1/status | jq
```

2. After entering a match, request a recommendation directly:

```bash
curl -sS -X POST -H 'Content-Type: application/json' \
  -d '{"matchId":"<match-id>"}' \
  https://aboba-telegramovich.duckdns.org/deadlock/adaptive/v2/recommend \
  | jq '{ready, blockers, nextAction, lock, degradedReasons}'
```

3. In the Overwolf in-game window verify the HUD shows the next action with its embedded requirements (souls, flex, consumed components, replacement sale) — one card per action, no duplicated items.

4. Buy, upgrade or sell an item and verify the next action changes without restarting the app.

5. When a critical input is missing or stale, verify the HUD shows an explicit unavailable state with blockers instead of an earlier recommendation.

6. End the match and verify the overlay clears the previous match state.

---

## Telemetry Storage and Logging

Raw event batches are stored as NDJSON:

- `apps/api/storage/deadlock-live/{matchId}.ndjson`
- `apps/api/storage/deadlock-live/unknown.ndjson` for events received before match ID resolution

Tail the files with:

```bash
tail -f apps/api/storage/deadlock-live/*.ndjson
```

---

## Match Data Deletion

The published privacy policy says a player can have their match data removed, so
there is a tool that does exactly that. It is deliberately awkward to fire by
accident: it is a dry run unless `--yes` is passed.

### What it removes

| Where | What |
| --- | --- |
| `adaptive_feedback_v1` | post-match usefulness votes for the match |
| `adaptive_build_iterations_v1` | build iteration history rows |
| `build_archetype_match_locks_v2` | the match's archetype lock rows |
| `storage/deadlock-live/<matchId>.ndjson` | the raw event log file |

The three tables are cleared in a single transaction, so an interrupted run
cannot leave a match half deleted and looking like it was never stored.

### Running it

Against a local database:

```bash
yarn data:delete-match --match-id <matchId>
```

Against the production container, run the **compiled** entry point. The runtime
image installs production dependencies only, so `ts-node` is not present and
`yarn data:delete-match` cannot work there:

```bash
docker compose exec api node dist/src/scripts/delete-match-data.js --match-id <matchId>
```

`--match-id` repeats, so several matches can be handled in one invocation:

```bash
docker compose exec api node dist/src/scripts/delete-match-data.js \
  --match-id <matchA> --match-id <matchB> --yes
```

### Dry run first

Both forms are dry runs until `--yes` is passed:

```
Match data deletion - DRY RUN (pass --yes to apply)

match 6f2c1e...
  adaptive_feedback_v1: would delete 1 row(s)
  adaptive_build_iterations_v1: would delete 14 row(s)
  build_archetype_match_locks_v2: would delete 1 row(s)
  raw event log: would delete /app/apps/api/storage/deadlock-live/6f2c1e....ndjson (18342 bytes)

1 match(es), 16 row(s) matched.
```

Check the counts look plausible, then re-run with `--yes`. Deletion cannot be
undone, so if the request is contested, take a database backup first.

### Known limitation: events stored before the match id was known

Events that arrive before the match id is resolved are written to
`storage/deadlock-live/unknown.ndjson`, whose lines carry no match id at all.
Those events cannot be attributed to a match, so this tool cannot selectively
remove them. If a request demands them, the whole `unknown.ndjson` file has to
go, which also discards every other player's pre-resolution events from that
window — decide that with the requester rather than silently.

### Verifying a deletion

Re-run the dry run and confirm every count is zero and the log file is gone:

```bash
docker compose exec api node dist/src/scripts/delete-match-data.js --match-id <matchId>
```

The tool is the authoritative check because it uses the same match-id
sanitisation as the writer. To confirm straight from the database:

```bash
docker exec aboba-telegramovich-postgres-1 psql -U postgres -d deadlock_builds -c \
  "select count(*) from adaptive_build_iterations_v1 where \"matchId\" = '<matchId>';"
```
