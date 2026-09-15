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
yarn workspace @deadlock-live-probe/shared build
```

```bash
yarn workspace @deadlock-live-probe/overwolf-client build
```

The production build also synchronizes `apps/overwolf-client/public` to the configured Windows sideload location.

### 3. Run the NestJS Ingest API

Launch the NestJS backend on port `3000`:

```bash
yarn workspace @deadlock-live-probe/api start:dev
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
