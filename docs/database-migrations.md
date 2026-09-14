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
