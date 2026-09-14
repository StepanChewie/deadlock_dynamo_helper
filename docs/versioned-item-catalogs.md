# Versioned Item Catalogs and Ruleset Resolution

## Purpose

The API stores immutable item and recipe snapshots by Deadlock client version. Historical matches can then be evaluated against the item definitions that existed when the match was played instead of the current live catalog.

The current `items` and `item_components` tables remain the operational latest snapshot used by existing code. The versioned tables are separate:

- `game_rulesets`
- `item_catalog_versions`
- `item_catalog_items`
- `item_catalog_recipes`

## Import API

List versions available from Deadlock API:

```bash
curl http://localhost:3000/deadlock/reference-data/catalogs/available
```

Import the latest available version:

```bash
curl -X POST \
  -H 'Content-Type: application/json' \
  -d '{}' \
  http://localhost:3000/deadlock/reference-data/catalogs/import
```

Import the latest five versions:

```bash
curl -X POST \
  -H 'Content-Type: application/json' \
  -d '{"maxVersions":5}' \
  http://localhost:3000/deadlock/reference-data/catalogs/import
```

Import explicit versions:

```bash
curl -X POST \
  -H 'Content-Type: application/json' \
  -d '{"clientVersions":[6518,6579],"force":true}' \
  http://localhost:3000/deadlock/reference-data/catalogs/import
```

Import every version known to Deadlock API:

```bash
curl -X POST \
  -H 'Content-Type: application/json' \
  -d '{"importAll":true}' \
  http://localhost:3000/deadlock/reference-data/catalogs/import
```

`importAll` is intentionally not the default because a complete historical backfill may issue many external requests and create a large amount of PostgreSQL data.

Each item stores normalized fields such as `itemType`, slot, cost, tier, shop state, active-item state, and activation type. The complete source item is also retained in `rawPayload`.

## Diagnostics

List imported catalogs:

```bash
curl http://localhost:3000/deadlock/reference-data/catalogs
```

Inspect a versioned recipe graph:

```bash
curl http://localhost:3000/deadlock/reference-data/catalogs/6518/recipes
```

List rulesets:

```bash
curl http://localhost:3000/deadlock/reference-data/rulesets
```

## Ruleset Resolution Priority (removed)

Match-level resolution was part of the removed raw-match pipeline. The priority chain `OBSERVED` / `DEMO_METADATA` / `TIME_WINDOW` / `UNKNOWN` (confidence `1.0` / `0.95` / `0.75` / `0`) and the `raw_match_metadata` write no longer exist in the runtime: the table was dropped in migration `1789142400000-drop-legacy-match-and-crawler-tables`. Nothing today resolves a ruleset per match; the adaptive pipeline scopes itself by `(rulesetId, catalogSha256)` of the current catalog.

## Time Windows

Catalog import creates one ruleset per client version but does not invent patch release timestamps. Configure verified windows manually or from a future authoritative patch feed:

```bash
curl -X PUT \
  -H 'Content-Type: application/json' \
  -d '{
    "validFrom":"2026-01-01T00:00:00.000Z",
    "validTo":"2026-02-01T00:00:00.000Z",
    "status":"active"
  }' \
  http://localhost:3000/deadlock/reference-data/rulesets/6518/window
```

Windows are validated with an exclusive `validTo`; adjacent windows are valid. Matches near a window boundary are intentionally left unresolved instead of guessed. There is no configurable boundary margin in the current resolver.

## Match-level ruleset resolution (removed)

The raw-match resolution endpoints (`/deadlock/analysis/raw-matches/...`), the `raw_match_metadata` table and the legacy match/crawler tables were removed in `chore(db): drop legacy match and crawler tables` (migration `1789142400000-drop-legacy-match-and-crawler-tables`). Versioned catalogs are now consumed by the adaptive recommendation pipeline through the `recommendation_item_catalog_*` tables; see `docs/architecture.md`.

## Deployment

Build the updated image, run the new migration, and start the API:

```bash
sudo docker compose build api
sudo docker compose run --rm api node apps/api/run-migrations.js
sudo docker compose up -d api
```

Import at least the latest catalog:

```bash
curl -X POST \
  -H 'Content-Type: application/json' \
  -d '{}' \
  http://localhost:3000/deadlock/reference-data/catalogs/import
```

Verify:

```sql
SELECT * FROM migrations ORDER BY timestamp;
SELECT COUNT(*) FROM game_rulesets;
SELECT COUNT(*) FROM item_catalog_versions;
SELECT COUNT(*) FROM item_catalog_items;
SELECT COUNT(*) FROM item_catalog_recipes;
SELECT COUNT(*) FROM recommendation_item_catalog_versions;
```
