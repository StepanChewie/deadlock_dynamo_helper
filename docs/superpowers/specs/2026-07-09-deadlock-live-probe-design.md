# Deadlock Analysis Storage Refactor Design

> **Historical design record.** At the time of writing this documented the referenced work; parts have since been implemented, refined by the ADRs, or superseded. It is kept for provenance, not as current instructions. Current architecture: `docs/architecture.md`; decisions: `docs/decisions/`.

## Goal

Move all game-analysis domain data out of runtime JSON files and into PostgreSQL, while keeping `ndjson` raw live-event logs only as a technical append-only trace.

## Scope

### Included

- PostgreSQL-backed storage for hero and item reference data
- PostgreSQL-backed storage for crawled matches, players, player items, and skill upgrades
- PostgreSQL-backed crawler state and crawl run history
- Removal of runtime dependency on:
  - `heroes-map.json`
  - `items-map.json`
  - `storage/deadlock-live/dynamo-matches.json`
- A status endpoint/page showing ingest health and current crawl progress
- Fresh refill of the database via crawler after deployment

### Excluded

- Migration of old cached data from JSON into the new schema
- Removal of `ndjson` raw event logs
- Historical data backfill from prior tables beyond what the crawler can fetch again

## Constraints

- `ndjson` raw logs remain on disk as technical logs only
- All business/runtime lookup data must come from PostgreSQL
- JSON files may be used one time during the refactor to seed tables, but not in runtime code afterward
- Existing NestJS + TypeORM structure should be preserved where practical

## Current Problems

- `AllHeroesAnalysisService` loads hero and item mappings from JSON files on startup
- `HeroAnalysisService` uses file-backed `dynamo-matches.json` as a runtime cache/source of truth
- `MatchPlayer.items` and `MatchPlayer.skillsOrder` are stored as `jsonb`, limiting queryability
- There is no dedicated operational status page for total saved matches and active ingest state

## Target Architecture

### Reference Tables

- `heroes`
  - `hero_id` unique
  - `name`
  - timestamps

- `items`
  - `item_id` unique
  - `name`
  - `class_name`
  - `item_slot_type`
  - `cost`
  - `item_tier`
  - timestamps

### Match Data Tables

- `matches`
  - `match_id` unique
  - `start_time`
  - `duration_s`
  - `average_badge`
  - `winning_team`
  - `source_status`
  - `last_error`
  - timestamps

- `match_players`
  - FK to `matches`
  - FK to `heroes` through `hero_id`
  - `team`
  - `won`
  - `kills`
  - `deaths`
  - `assists`
  - `net_worth`
  - timestamps

- `match_player_items`
  - FK to `match_players`
  - FK to `items` through `item_id`
  - `purchase_time_s`
  - `sold_time_s`
  - `slot_order`
  - timestamps

- `match_player_skill_upgrades`
  - FK to `match_players`
  - `ability_id`
  - `upgrade_order`
  - `upgrade_time_s`
  - timestamps

### Crawl State Tables

- `crawler_runs`
  - `crawler_type`
  - `status`
  - `target_matches`
  - `discovered_matches`
  - `processed_matches`
  - `started_at`
  - `finished_at`
  - `last_error`

- `crawler_state`
  - `crawler_type` unique
  - `is_crawling`
  - `current`
  - `total`
  - `current_match_id`
  - `status`
  - `last_success_at`
  - `last_error`
  - `updated_at`

## Runtime Flow

1. App starts and loads TypeORM entities only.
2. A one-time import path reads `heroes-map.json` and `items-map.json` and writes them into `heroes` and `items`.
3. Runtime services read heroes/items from PostgreSQL only.
4. Crawlers discover and process matches, saving all structured data into PostgreSQL.
5. Hero and build analysis endpoints query PostgreSQL, not disk caches.
6. Operators inspect `/deadlock/admin/ingest` or `/deadlock/admin/ingest/status` for current ingest health.

## Operational Status Surface

### JSON

- `GET /deadlock/admin/ingest/status`

Returns:

- total matches in DB
- total match players in DB
- total heroes in DB
- total items in DB
- whether crawl is active
- crawler type
- current processed count
- target count
- current match id
- current status string
- last success time
- last error
- latest crawler run metadata

### HTML

- `GET /deadlock/admin/ingest`

Simple debug/admin page polling the JSON endpoint every few seconds.

## Transition Plan

1. Add the new entities and wire them into TypeORM.
2. Add a one-time import service for heroes/items from existing JSON files.
3. Refactor hero/item lookup code to use repositories.
4. Replace file-backed Dynamo cache behavior with PostgreSQL-backed reads/writes.
5. Add crawler state persistence.
6. Add status endpoint/page.
7. Remove runtime references to mapping/cache JSON files.
8. Rebuild and repopulate by running the crawler from a clean state.

## Risks

- The existing unique constraint on `match_players` by `(matchId, heroId)` may be too weak if duplicate heroes ever appear in non-standard modes; keep current assumption unless evidence says otherwise.
- Full removal of `jsonb` fields may require broader service/test updates than the current code suggests.
- With `synchronize: true`, schema churn is fast but risky; validation on VPS is mandatory before claiming completion.

## Acceptance Criteria

- Runtime code no longer reads `heroes-map.json`, `items-map.json`, or `dynamo-matches.json`
- Hero and item reference data live in PostgreSQL tables
- Match player items and skill upgrades are queryable in normalized tables
- Crawl progress/status is stored in PostgreSQL and visible through a status endpoint/page
- Application starts, crawler runs, and new matches are persisted without relying on runtime JSON files
