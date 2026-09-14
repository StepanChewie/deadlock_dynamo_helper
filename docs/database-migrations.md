# Database migrations

The API schema is managed by TypeORM migrations. `synchronize` is disabled.

## Backup before the first reset

Create a full backup as a rollback artifact:

```bash
pg_dump \
  --format=custom \
  --no-owner \
  --no-privileges \
  -h localhost \
  -U postgres \
  deadlock_builds \
  > deadlock-before-migrations.dump
```

Do not restore this dump into the new migrated database unless a rollback is required. Static reference data is rebuilt from the repository seed and the Deadlock assets importer.

## Clean database bootstrap

Drop and recreate the development database:

```bash
psql -h localhost -U postgres -d postgres \
  -c 'DROP DATABASE IF EXISTS deadlock_builds WITH (FORCE);'

psql -h localhost -U postgres -d postgres \
  -c 'CREATE DATABASE deadlock_builds;'
```

Run the migrations:

```bash
yarn db:migrate
```

Start the API:

```bash
yarn workspace @deadlock-live-probe/api start:dev
```

On startup, `ReferenceDataImportService` restores the hero and item seeds. When `DEADLOCK_API_KEY` is configured, it also refreshes current items and component recipes from the assets API.

The API can run pending migrations automatically when explicitly enabled:

```bash
DB_RUN_MIGRATIONS=true yarn workspace @deadlock-live-probe/api start
```

## Verification

```sql
SELECT COUNT(*) FROM heroes;
SELECT COUNT(*) FROM items;
SELECT COUNT(*) FROM item_components;
SELECT COUNT(*) FROM game_rulesets;
SELECT COUNT(*) FROM item_catalog_versions;
SELECT COUNT(*) FROM recommendation_item_catalog_versions;
```

The first three tables are populated when the API starts. The versioned catalog tables (`game_rulesets`, `item_catalog_*`) are populated by the catalog importer (`POST /deadlock/reference-data/catalogs/import`, see `docs/versioned-item-catalogs.md`); the recommendation pipeline reads the `recommendation_item_catalog_*` tables.

## Migration commands

```bash
yarn db:migrations
yarn db:migrate
yarn db:revert
```

Generate a future migration:

```bash
yarn db:generate src/database/migrations/describe-change
```

## Build iteration history retention

`adaptive_build_iterations_v1` keeps per-iteration recommendation history for
incident review only (ADR-007 forbids using it as a training corpus).

- Retention: `ADAPTIVE_BUILD_ITERATION_TTL_DAYS` (default 30). The hourly
  cleanup job deletes unpinned rows older than the cutoff in bounded passes of
  5000 rows per pass, up to 20 passes per run, and returns the summed affected
  row count. A pass that returns fewer than 5000 rows stops the loop early.
- Pin a match under review so cleanup skips it:
  `UPDATE adaptive_build_iterations_v1 SET pinned = true WHERE "matchId" = '<matchId>';`
- Row size: `ADAPTIVE_BUILD_ITERATION_MAX_JSON_KB` (default 64) caps the `plan`
  and `rejects` columns; a capped row stores `truncated = true`.
