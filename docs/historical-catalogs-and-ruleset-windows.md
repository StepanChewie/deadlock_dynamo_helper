# Historical catalogs and verified ruleset windows

This flow backfills old item catalogs without importing every available client version in one request. Ruleset dates are applied separately from a verified manifest because the asset version list does not provide authoritative release timestamps.

## API

- `GET /deadlock/reference-data/catalogs/history/status`
- `POST /deadlock/reference-data/catalogs/history/import`
- `GET /deadlock/reference-data/rulesets/windows/status`
- `POST /deadlock/reference-data/rulesets/windows/validate`
- `PUT /deadlock/reference-data/rulesets/windows`

## Historical catalog backfill

The importer processes missing versions newest first. The cursor is exclusive and should be copied from `nextBeforeClientVersion` into the next request.

```json
{
  "limit": 5,
  "beforeClientVersion": 6630,
  "language": "english",
  "continueOnError": false
}
```

The server caps one batch at 25 versions. Each version remains transactional and idempotent. A failed version is returned in `retryClientVersions`; with `continueOnError: false`, the cursor is kept so the failed version is retried by the next request.

## Shared catalog content

Client builds can have identical item payloads. Every client version still receives its own `item_catalog_versions` and `game_rulesets` row, but identical payload hashes share one physical set of `item_catalog_items` and `item_catalog_recipes`.

`contentCatalogVersionId` points an alias version to the canonical catalog content. API responses expose both the requested catalog id and the effective content catalog id. Recipe graph and match replay resolve this link automatically.

The history status includes:

- `distinctPayloadCount`
- `deduplicatedVersionCount`

The deduplication migration converts existing duplicate payloads and removes only duplicate physical item and recipe rows. Its rollback restores those rows before dropping the link.

## Verified window manifest

A window manifest must include a provenance string and exact ISO timestamps. By default, every referenced client version must already have both a ruleset and an imported catalog.

```json
{
  "source": "verified-release-log-2026-07-11",
  "replaceExistingWindows": true,
  "requireCatalogs": true,
  "entries": [
    {
      "clientVersion": 6500,
      "validFrom": "2026-06-01T00:00:00.000Z",
      "validTo": "2026-06-15T00:00:00.000Z",
      "status": "active",
      "evidence": {
        "reference": "release-log-entry-id"
      }
    },
    {
      "clientVersion": 6600,
      "validFrom": "2026-06-15T00:00:00.000Z",
      "status": "active",
      "evidence": {
        "reference": "release-log-entry-id"
      }
    }
  ]
}
```

Always validate the same body with `POST /rulesets/windows/validate` before applying it. The validator rejects invalid dates, duplicate versions, non-monotonic version order, missing rulesets or catalogs, and overlapping active windows. Adjacent windows are valid because `validTo` is exclusive.

`replaceExistingWindows: true` clears windows that are not present in the manifest. The manifest hash, source, evidence, and apply timestamp are retained in `game_rulesets.rawMetadata`.

## Re-resolve and replay (removed)

Historical match reprocessing (`force: true`, `resolveRuleset: true`) and the raw-match ruleset resolution it drove were removed with the legacy match pipeline: `raw_match_metadata` and the match/crawler tables were dropped in migration `1789142400000-drop-legacy-match-and-crawler-tables`. The catalog and window APIs above remain; there is no match replay endpoint in the current runtime.
