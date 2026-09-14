# ADR-001: PostgreSQL as the sole runtime source of truth

## Status

Accepted

## Date

2026-07-09

## Context

All game-analysis domain data (hero reference data, item reference data, crawled matches, players, player items, skill upgrades, crawler state) lived in runtime JSON files: `heroes-map.json`, `items-map.json`, `storage/deadlock-live/dynamo-matches.json`. This caused:

- no schema validation, indexes, or queryable state — every consumer parsed files into memory;
- crawler runs had no durable run history or resumable state;
- reference data and business data were indistinguishable from technical logs;
- multi-process access (API + crawler + scripts) had no consistent view of the data.

Raw live game events were (and are) captured as append-only NDJSON logs.

## Decision

PostgreSQL (via the existing NestJS + TypeORM stack) is the authoritative store for all business and runtime lookup data:

- hero and item reference data;
- crawled matches, players, player items, skill upgrades;
- crawler state and crawl run history.

NDJSON raw live-event logs remain on disk strictly as an append-only technical trace, never as a runtime lookup source. JSON files may be used exactly once to seed tables during a refactor, and never again from runtime code.

## Alternatives Considered

### Keep JSON files with an in-process cache layer

- Pros: zero migration work, trivially inspectable.
- Cons: no cross-process consistency, no indexes, unbounded memory parsing; the problems above stay.
- Rejected: the crawler/API consistency issues were the direct cause of production incidents.

### Document DB (MongoDB)

- Pros: schema-free, matches the JSON shape 1:1.
- Cons: the analysis domain is relational (matches → players → items → skill upgrades); we would manage joins manually or duplicate data.
- Rejected: relational data in a document store.

## Consequences

- A status endpoint shows ingest health and crawl progress instead of ad-hoc file inspection.
- Fresh data refill happens through the crawler after deployment; no backfill of legacy JSON content.
- Database reset/backup/migration procedures live in `docs/database-migrations.md`.
- Later decisions (ADR-003, ADR-007) could then remove the crawler and ML pipeline entirely by pruning tables (`chore(db): drop legacy match and crawler tables`), because the storage boundary was already clean.
