# Build iteration history and per-player isolation — design

Status: draft for review
Date: 2026-09-14
Related: ADR-004 (immutable per-match archetype lock), ADR-007 (no self-training on own match data), ADR-008 (per-player isolation of match decisions)

## 1. Context

Two problems, discovered while scoping "persist every build iteration so a support complaint can be replayed".

### 1.1 A second player in the same match gets no build

Both `build_archetype_match_locks_v2` and the in-memory `BuildDebugTraceStoreV2Service` are keyed by `matchId` alone.

Match `M`, player A on Haze (`steamId 111`), player B on Wraith (`steamId 222`):

1. A requests a recommendation. No lock for `M` exists, so the system selects an archetype for Haze and inserts a lock row keyed by `M`.
2. B requests a recommendation. `BuildArchetypeSessionV2Service.get('M')` returns A's lock. The hero check in `AdaptiveRecommendationV2Service.reuseLock` fails (`lock.heroId !== decision.state.heroId`) and the response is `ready:false` with `LOCKED_ARCHETYPE_HERO_MISMATCH`. B never receives a build.
3. `BuildDebugTraceStoreV2Service` is keyed by `M` as well, so the two players' traces overwrite each other. Hysteresis reads `previousPlan` from that shared slot, so B's plan search can be suppressed by comparing against A's plan.

Everything else is already per-player: live match state (`playersBySteamId`), decision state, inventory, souls evidence, item graph, evidence bundles.

### 1.2 There is no build history

Today nothing durable records what the system recommended over the course of a match:

- `BuildDebugTraceStoreV2Service` keeps 8 revisions per match in process memory with a 1 hour TTL; a restart erases it.
- The response body of `POST /deadlock/adaptive/v2/recommend` is never persisted.
- Raw Overwolf events go to NDJSON files (`raw-event-log.service.ts`) and are not read by any code path.

A support report of the form "my build was wrong at minute 12" cannot be answered: there is no record of what the build was, when it changed, or why an alternative was rejected.

## 2. Goals

- Each player in a match has their own archetype lock and their own decision trace.
- Every change of the recommended build, and every change of the not-ready blocker set, is persisted with enough context to explain "what was recommended, when, and why".
- A complaint can be answered from SQL alone.
- Storage growth is bounded and explicit.

## 3. Non-goals

- No UI for reviewing history. The read path is SQL. (The existing build debugger is currently broken and is not repaired here.)
- No reuse of this data as a training corpus — ADR-007 forbids it. The table name and a column comment must make the prohibition visible.
- No changes to the response DTO consumed by the Overwolf client.

## 4. Part A — per-player isolation

Key change everywhere: `matchId` → `(matchId, steamId)`.

### A1. ADR-008

New ADR recording that the archetype lock and decision trace are scoped per player within a match, refining ADR-004's "one archetype per match".

### A2. Lock table migration

`build_archetype_match_locks_v2` today:

```
CONSTRAINT "PK_build_archetype_match_locks_v2" PRIMARY KEY ("matchId")
```

Migration steps, in one transaction:

1. `DELETE FROM "build_archetype_match_locks_v2"` — a lock is only meaningful inside an active match (ADR-004); rows from finished matches are dead weight and cannot be attributed to a player after the fact.
2. `ALTER TABLE ... ADD COLUMN "steamId" varchar(32) NOT NULL` — safe because the table is now empty, and it avoids a sentinel value: every new lock is written with a resolved player.
3. Drop the old primary key, add `PRIMARY KEY ("matchId", "steamId")`.
4. Add index `("steamId", "lockedAt")` for support lookups; keep the existing `("heroId", "lockedAt")`.

`down()` recreates the `matchId`-only primary key; dropped rows are not restored (documented no-op, same convention as `1789142400000-drop-legacy-match-and-crawler-tables`).

Deployment note: a match in progress during the deploy loses its lock and re-selects an archetype once. Deploy outside live play.

### A3. `BuildArchetypeSessionV2Service`

- `get(matchId, steamId)` / `getOrLock(matchId, steamId, input)`.
- The entity gains `steamId` as a primary column.
- `validateMatchId` and a new `validateSteamId` (non-empty, length ≤ 32) run before every query.
- Race handling stays as is: unique violation `23505` re-reads and returns the winner.

### A4. `BuildDebugTraceStoreV2Service`

- Internal key becomes the string `matchId|steamId` for both `matches` and `streams`.
- `BuildDecisionTraceV2` gains `steamId: string`.
- `revision` must increase per `(matchId, steamId)`; the existing `put()` guard is checked against that key.
- API: `put(trace)`, `get(matchId, steamId)`, `revisions(matchId, steamId)`, `observe(matchId, steamId)`.
- `listActive()` returns `{ matchId, steamId, revision, stateRevision, generatedAt }`.

### A5. `AdaptiveRecommendationV2Service`

- `this.session.get(matchId, decision.localSteamId)` instead of `get(request.matchId)`.
- `this.traceStore.get(matchId, decision.localSteamId)`, and `put()` carries the same `steamId`.
- `decision.localSteamId` is resolved by `AdaptiveDecisionStateV1Service.build()` before any lock or trace access, so no new resolution logic is needed on this path.
- Recommendation logic itself is unchanged.

### A6. Debug endpoints

`/debug/build-v2` keeps its password guard and gains the player dimension:

- `GET /debug/build-v2/matches` → list of `(matchId, steamId, revision, stateRevision, generatedAt)`.
- `GET /debug/build-v2/matches/:matchId?steamId=…` → trace for that player.
- `GET /debug/build-v2/matches/:matchId/stream?steamId=…` → SSE for that player.

The broken debug page is not repaired here; the endpoints are changed so that they are correct whenever the page is fixed.

## 5. Part B — build iteration history

### B1. Table `adaptive_build_iterations_v1`

| Column | Type | Notes |
|---|---|---|
| `id` | bigserial PK | read order |
| `matchId` | varchar(128) NOT NULL | |
| `steamId` | varchar(32) NOT NULL | sentinel `unknown` when the local player is unresolved; NOT NULL because the previous-state check and the last-row lookup are keyed on `(matchId, steamId)` |
| `heroId` | integer NULL | |
| `gameTimeSec` | integer NULL | |
| `kind` | varchar(16) NOT NULL | `PLAN` or `NOT_READY` |
| `fingerprint` | char(64) NOT NULL | see B2 |
| `stateRevision` | varchar(64) NOT NULL | state revision of the iteration |
| `plan` | jsonb NULL | `fullBuild` steps + validation + degradedReasons (kind `PLAN`) |
| `rejects` | jsonb NULL | `REJECTED` / `SUPPRESSED_BY_HYSTERESIS` extract (both kinds, when available) |
| `archetype` | jsonb NULL | archetypeId, snapshotId, selection scores |
| `score` | jsonb NOT NULL | total, confidence |
| `evidence` | jsonb NOT NULL | per dataset: available, freshness, rowCount, reasonCodes |
| `context` | jsonb NOT NULL | inventory item ids, capacity, spendable souls, enemy hero ids, enemy threats |
| `blockers` | jsonb NULL | blocker codes for kind `NOT_READY` |
| `truncated` | boolean NOT NULL DEFAULT false | set when the size limit trimmed `plan` or `rejects` |
| `pinned` | boolean NOT NULL DEFAULT false | exempt from retention cleanup |
| `capturedAt` | timestamptz NOT NULL | |

Indexes:

- `idx_build_iteration_last_v1 (matchId, steamId, id DESC)` — the last-row lookup that the dedupe check (B3) uses
- `(matchId, capturedAt)`
- `(steamId, capturedAt DESC)`
- partial `(capturedAt) WHERE pinned = false` for cleanup

> Changed 2026-09-14/15: the two partial unique indexes `uq_build_iteration_plan_v1` and `uq_build_iteration_not_ready_v1` no longer exist and are replaced by the last-row search index above. Deduplication is now a comparison against the previous stored state, because the user requires that returning to a previous state is itself a change and must be recorded (A → B → A is three rows). See B3.

Column comment on `rejects` and on the table must state: incident review only, never a training corpus (ADR-007).

### B2. Fingerprints and reject extraction (pure functions)

`build-iteration-fingerprint-v1.ts`, no I/O:

- `planFingerprint(steps)` — sha256 over the ordered `action|buyItemId|sellItemId|recipeId` list from `fullBuild.steps`. Order is significant; A → B → A produces three distinct fingerprints.
- `blockerFingerprint(blockers)` — sha256 over the sorted, de-duplicated blocker list. Order is not significant.
- `extractRejects(stages)` — from `BuildDecisionTraceV2.stages`, keeps only entries with `disposition` `REJECTED` or `SUPPRESSED_BY_HYSTERESIS`, per stage, preserving `reasonCodes` and identifiers (itemId / archetypeId / sell+buy pair).
- Size limit: serialized `plan` and `rejects` are capped (default 64 KB each); `truncated` is set on the row when either cap bites. Over the cap, `plan` is stored as a compact projection (steps reduced to `sequence` / `action` / `buyItemId` / `sellItemId` / `recipeId` / `reasonCodes`, `semanticValidation.finalFamilyStates` emptied) and `rejects` drops half of the entries of every stage until it fits. Configurable via `ADAPTIVE_BUILD_ITERATION_MAX_JSON_KB`.

### B3. `BuildIterationHistoryV1Service.record()`

```
record(input): void   // never throws to the caller
  1. build the row (fingerprint source by kind: plan steps or blockers)
  2. read the previous state for (matchId, steamId): in-process cache first, otherwise one `findOne` with order id DESC
  3. if it has the same `kind` AND the same `fingerprint`, return without writing
  4. otherwise INSERT the row and cache `{ kind, fingerprint }` for the pair
  5. on error: log warn, return
```

Deduplication is a comparison against the previous stored state, not a unique constraint. The comparison is made across kinds: a `PLAN` never collapses into a `NOT_READY` even when both would carry an equal fingerprint. In-memory state does exist, and it is bounded to one `{ kind, fingerprint }` entry per `(matchId, steamId)`; it only saves the `findOne`. After a process restart the cache is empty and the previous state is re-hydrated from the table by that one `findOne`, so an unchanged state still writes nothing.

Two consequences, and these are the user's requirement rather than implementation detail:

- A return to a previous state is a change: `A → B → A` writes three rows. The former unique-index scheme collapsed the second `A` into the first row and lost the oscillation.
- Five unchanged ticks still write exactly one row.

`recommend` is already debounced (1500 ms) and payload-deduplicated on the client, so the write rate is a handful per player per minute.

### B4. Capture object and the single write site

`BuildIterationCaptureV1` — a plain request-scoped object created by the controller and passed as an optional second argument to `AdaptiveRecommendationV2Service.recommend(request, capture)`. The service fills it with objects it already has: `decision.localSteamId`, trace stages, resolved plan, archetype selection, snapshot, evidence bundle, slot capacity, enemy threat scores. Nothing is recomputed.

Why not read `traceStore.get()` afterwards: the store is keyed per player only after part A, but reading it after the fact can still return another concurrent revision for the same player. The capture is exact and cheap.

Controller flow:

1. resolve `steamId` best-effort: `body.localSteamId` → marked-local player from live state → sentinel `unknown` (never throws);
2. `capture = new BuildIterationCaptureV1()`;
3. `result = await service.recommend(request, capture)`, including the `LIVE_STATE_NOT_READY` catch branch;
4. `history.record({ matchId, steamId: capture.steamId ?? resolvedSteamId, result, capture })` — awaited, wrapped in try/catch, a failure only logs a warning.

`record()` classifies the outcome by `result.ready`: `true` → `PLAN` (an empty step list is a legitimate complete build and fingerprints as such); `false` → `NOT_READY` with `result.blockers`.

### B5. Retention and pin

- TTL: `ADAPTIVE_BUILD_ITERATION_TTL_DAYS`, default 30.
- Hourly `@Cron`: `DELETE FROM adaptive_build_iterations_v1 WHERE pinned = false AND "capturedAt" < now() - interval`, in batches of 5000 per pass to avoid long locks.
- Pin is a manual SQL update; no endpoint (the read path is SQL, so the write path for pin can be too).
- `resolveLocalSteamId` failures produce `steamId = 'unknown'` rows; they are ordinary retention candidates.

## 6. Read path (SQL)

Last matches for a player:

```sql
SELECT DISTINCT ON ("matchId") "matchId", max("capturedAt") AS last_at
FROM adaptive_build_iterations_v1
WHERE "steamId" = $1
GROUP BY "matchId"
ORDER BY "matchId", last_at DESC
LIMIT 20;
```

Timeline for a complaint:

```sql
SELECT "gameTimeSec", kind, "steamId", "heroId", "fingerprint", blockers,
       plan->'validation' AS plan_validation, archetype->'archetypeId' AS archetype_id,
       "capturedAt"
FROM adaptive_build_iterations_v1
WHERE "matchId" = $1 AND "steamId" = $2
ORDER BY id;
```

Both players in one match:

```sql
SELECT "steamId", kind, count(*)
FROM adaptive_build_iterations_v1
WHERE "matchId" = $1
GROUP BY "steamId", kind;
```

Pin a match under review:

```sql
UPDATE adaptive_build_iterations_v1 SET pinned = true WHERE "matchId" = $1;
```

## 7. Testing

| Level | Cases |
|---|---|
| pure functions | plan fingerprint: order significant, A → B → A distinct; blocker fingerprint: order insignificant; rejects extract: only `REJECTED` / `SUPPRESSED_BY_HYSTERESIS`; size cap sets `truncated` |
| history service | identical state twice → one row; five identical ticks → one row; `A → B → A` → three rows; two players in one match → two rows; `PLAN → NOT_READY → PLAN` → three rows; restart re-hydrates the previous state and appends only real changes; insert failure does not throw |
| session service | two players, same match, different locks; same player race → unique violation path |
| trace store | revisions counted per player; `observe` returns the requested player's trace |
| recommendation e2e | two clients in one match receive different builds and both get history rows; the second player no longer receives `LOCKED_ARCHETYPE_HERO_MISMATCH`; hysteresis uses the same player's previous plan |
| migrations | integration spec covering the lock table rebuild and the new history table |
| retention | expired unmatched rows deleted, `pinned` rows kept |

## 8. Rollout order

Part A first, then part B, in the order of sections A1 → A6, B1 → B5. The response contract is untouched, so the deployed Overwolf client needs no update. The lock migration is destructive to dead rows only and should deploy outside live play.

## 9. Risks

| Risk | Handling |
|---|---|
| Lock migration deletes rows of a match in progress | deploy outside live play; one archetype re-selection at worst |
| Trace store key change breaks the (already broken) debug page further | endpoints are corrected in the same change; the page itself stays out of scope |
| Hysteresis behaviour changes in multi-player matches | intended: it stops borrowing another player's plan |
| Row size growth | 64 KB cap per JSON column with `truncated` flag |
| History mistaken for a training corpus | explicit column/table comment, ADR-007 referenced in the spec and the ADR |

## 10. Found incidentally, out of scope

Not fixed here; recorded so they are not lost:

- `build_strategy_snapshots_v1` — created by migrations, zero runtime references, absent from `DATABASE_ENTITIES`. Superseded by `build_archetype_snapshots_v2`. Candidate for `DROP TABLE`.
- Eleven legacy tables from migration `1788220800000` (`recommendation_decisions_v8`, `recommendation_decision_candidates_v8`, `recommendation_evidence_snapshots_v8`, `recommendation_exposure_acks_v8`, `recommendation_telemetry_events`, `recommendation_telemetry_rejections_v8`, `model_bundle_registry_v1`, `recommendation_dataset_registry_v1`, `recommendation_value_dataset_registry_v1`, `recommendation_roadmap_evidence_v1`, `adaptive_recommendation_decisions_v1`) — no runtime writes, no entities; kept alive only by `production-database-policy.spec.ts`.
- `InventoryShadowReplayService` — runs on every event batch, exposes two GET endpoints, has no consumer outside its own tests.
- Raw NDJSON event log — written, never read.
- `dynamo-matches.json` under `apps/api/storage` — pre-ADR-001 leftover.
- Unauthenticated debug endpoints: `/deadlock/live/debug`, `/deadlock/live/states`, `/deadlock/live/events/recent`, `/deadlock/tools/statlocker/*` expose live-match steamIds, names, heroes and KDA.
