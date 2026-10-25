# Match History Menu Design

Date: 2026-10-25
Status: approved in chat, spec pending review
Environments: **UAT only** (branch `uat`; nothing merges to `main` until the
feature is wanted in production and in the Overwolf store build)

## Why

The app already captures every match its users play — the Overwolf client
streams GEP events (roster, items, match clock) to `/deadlock/live/events`,
where they land as raw NDJSON logs (pruned to 32 × 4 MB) and a handful of
Postgres rows (feedback, iterations, locks). None of it is visible to the
user. This feature gives each user a "Матчи" tab: their match list, the
roster of each match, and — once the public Deadlock API has caught up, which
lags behind the live game — the full official match data.

## Scope

In scope (this iteration):

- `app_users_v1` and `match_history_v1` tables, written from the live ingest
- Read API: users list, a user's matches, one match's detail
- Enrichment cron: fetch `https://api.deadlock-api.com/v1/matches/{id}`
  (with key if configured, falling back to keyless on 401/403), store raw
  payload
- Client: third desktop nav tab "Матчи" (list + detail)

Out of scope (deliberate):

- User enrichment (MMR/rank via `players/{steam_id}`) — the users table is
  the hook; add later
- Win/loss and official stats before enrichment succeeds — phase 1 shows only
  what we capture live (no `match_over`/victory GEP event exists today)
- Auth on the new endpoints — the whole API is unauthenticated today; adding
  it here alone would be theater
- Retention/pruning — keep forever; volume is one row per match per user
  (ponytail: revisit when the table passes a million rows)

## Data model

One migration, TypeORM pattern as in
`1789401600000-create-adaptive-feedback-v1.ts`.

### `app_users_v1`

| column | type | notes |
|---|---|---|
| `steamId` | varchar(32) PK | from the roster's `is_local` player |
| `playerName` | varchar(128) | latest name seen; nullable — GEP may omit |
| `lastClientId` | varchar(128) | latest Overwolf client id seen |
| `firstSeenAt` | timestamptz NOT NULL DEFAULT now() | |
| `lastSeenAt` | timestamptz NOT NULL DEFAULT now() | |

### `match_history_v1`

| column | type | notes |
|---|---|---|
| `matchId` | varchar(128) PK | sanitized as in `resolveMatchLogPath` |
| `localSteamId` | varchar(32) NOT NULL | owner of the match (is_local player) |
| `localHeroId` | int | final snapshot |
| `kills` / `deaths` / `assists` | int | final snapshot of the local player |
| `souls` | bigint | final snapshot |
| `durationSec` | int | max `match_clock` seen |
| `players` | jsonb NOT NULL DEFAULT '[]' | final roster, all players: steamId, name, heroId, heroName, team, lane, level, kills, deaths, assists, souls, heroDamage, objectDamage, healing, isLocal |
| `startedAt` | timestamptz NOT NULL | first ingested event time (server clock) |
| `lastEventAt` | timestamptz NOT NULL | last ingested event time |
| `enrichmentStatus` | varchar(16) NOT NULL DEFAULT 'PENDING' | PENDING / DONE / NOT_FOUND / FAILED |
| `enrichmentAttempts` | int NOT NULL DEFAULT 0 | |
| `enrichmentFetchedAt` | timestamptz | |
| `enrichment` | jsonb | raw `/v1/matches/{id}` response |
| `createdAt` / `updatedAt` | timestamptz NOT NULL DEFAULT now() | |

Index: `(localSteamId, startedAt DESC)`, plus partial index on
`(enrichmentStatus)` WHERE status IN ('PENDING','FAILED','NOT_FOUND') for the
cron scan.

No match-count column on users — counted on read; volume is tiny.

## Write path

New module `apps/api/src/match-history/`:

- `MatchHistoryService.applyBatch(batch: OverwolfLiveBatchDto): Promise<void>`
  — a pure projection from canonicalized events to the two tables, upserting.
  For each batch: collect roster snapshots; the `isLocal` player sets
  `localSteamId`; the final roster payload of each player wins; `match_clock`
  max wins for `durationSec`. Called from
  `LiveIngestController.ingestEvents` **after** `rawEventLogService`, wrapped
  in the same style try/catch — a history write failure logs a warning and
  never fails the ingest.
- Input is the already-`canonicalizeLiveBatchForStateV2` batch, so roster
  payloads arrive in the canonical shape (`isLocal`, `heroId`, …), the same
  one `live-match-state.service.ts` consumes.

## Read API

`MatchHistoryController`, prefix `deadlock/match-history`:

- `GET /deadlock/match-history/users` — all users with match counts,
  ordered by `lastSeenAt DESC`
- `GET /deadlock/match-history/users/:steamId/matches?limit=50` — list for
  one user, newest first, capped at 200
- `GET /deadlock/match-history/:matchId` — full row (summary, players,
  enrichment when present)

## Enrichment cron

`MatchEnrichmentService`, `@Cron('*/15 * * * *')` (ScheduleModule is already
registered for the reference-data cron):

1. Pick up to 20 rows: `enrichmentStatus` PENDING, or FAILED with
   `enrichmentAttempts < 8`, or NOT_FOUND with `lastEventAt` younger than
   7 days — and `lastEventAt` at least 10 minutes ago (official data lags).
2. `GET https://api.deadlock-api.com/v1/matches/{matchId}` via the existing
   `getDeadlockApiRequestConfig()`. Key policy, per owner's call: if a key is
   configured use it; on 401/403 retry the same request keyless; no key
   configured means keyless from the start.
3. 200 → store raw body in `enrichment`, status DONE. 404 → NOT_FOUND
   (the match may surface later; the 7-day window re-tries). 429 or 5xx or
   network error → FAILED, `enrichmentAttempts + 1`.
4. Re-entrancy guard, same pattern as `refreshRecommendationCatalog()`.

## Client

`apps/overwolf-client`:

- New nav-item "Матчи" in `desktop.html` (`nav-matches`), alongside Build and
  Settings; same tab-switching mechanism.
- `matches-view.ts`: list (hero name, date, K/D/A, souls, duration; a
  win/loss badge when `enrichment` has landed; a muted "официалы ждутся"
  marker while PENDING/NOT_FOUND) and a detail view (roster table of 10,
  enrichment stats when present).
- Default user: the local steam id the client already resolves from its own
  live session; a dropdown of all users (from `/users`) switches the view.

## Error handling

- History projection failure: warn-log, ingest still returns `{ok:true}`.
- Cron fetch failure: per-match status/attempts as above; cron itself never
  throws across matches.
- Unknown steamId / matchId on reads: 404.
- Malformed `limit`: 400 (existing ValidationPipe behavior).

## Testing

Jest, repo style:

- projection spec: batch → user upsert + match upsert (final roster wins,
  isLocal detection, match_clock max, first/last event stamps)
- cron spec: 200→DONE, 404→NOT_FOUND, 401→keyless retry→DONE, 429→FAILED,
  candidate window rules (10-min lag, 7-day NOT_FOUND, 8-attempt cap, 20-row
  cap), re-entrancy
- controller spec: the three GETs, 404s, limit clamping
- client spec: list/detail presentation incl. PENDING badge, in the style of
  `adaptive-recommendation-presentation.spec.ts`

## Traps this must respect

- `sanitizeMatchId` for the PK — same containment reasoning as
  `resolveMatchLogPath`; validate before insert.
- Roster payloads may be partial (GEP sends diffs) — merge by steamId, final
  full snapshot per player wins, never replace with an emptier payload.
- `match_clock` can arrive out of order — max, not last.
- Cron must not fight the deploy path: UAT compose runs migrations on deploy
  (`DB_RUN_MIGRATIONS`), the same flow picks the new migration up.
