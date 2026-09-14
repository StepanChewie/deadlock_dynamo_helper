# Deadlock Live Probe — Architecture Overview

Yarn workspace monorepo that captures real-time *Deadlock* game events through Overwolf, persists raw events, and produces adaptive in-game build recommendations. The production pipeline is **evidence-bounded**: when a critical input is missing, stale, or invalid, the system returns an explicit "unavailable" result instead of a stale or fabricated recommendation.

```text
Overwolf client (GEP live events)
  -> POST events (NDJSON persistence + state reduction)
  -> Adaptive pipeline v2 (Statlocker archetypes + live adaptation)
  -> AdaptivePlanActionV1[] (BUY / UPGRADE / SELL / REPLACE / WAIT / BLOCKED / COMPLETE)
  -> recommendedBuild compatibility projection
  -> Overwolf semantic rendering (one card per action)
```

## Repository layout

| Path | Purpose |
|---|---|
| `apps/api` | NestJS API: event ingestion, NDJSON logging, adaptive recommendation pipeline, debug inspector, database access |
| `apps/overwolf-client` | Overwolf runtime app: GEP integration, event buffering, transport to the API, in-game overlay and debug window |
| `packages/deadlock-build-domain` | Pure domain library: recommendation ruleset catalog, item graph, candidate generation, inventory reduction, capacity-driven replacement |
| `packages/shared` | Shared TypeScript DTOs and state types |
| `deploy.sh` | Manual VPS deploy: rsync + docker build + migrations + `docker compose up` (used when Actions are skipped) |
| `ops/nginx` | Reverse-proxy configuration for the VPS deployment |
| `docs/decisions/` | Architecture Decision Records (ADRs) |
| `docs/superpowers/` | Historical design specs and implementation plans (design authority for the ADRs) |

## API modules (`apps/api/src`)

| Module | Responsibility |
|---|---|
| `statlocker-adaptive` | The production recommendation pipeline v2: archetype compilation from Statlocker evidence, per-match strategy sessions, family-first full-build resolution, transaction planning, capacity-driven replacement, semantic validation, economy rules |
| `deadlock-live` | Live event ingestion, NDJSON persistence, inventory shadow replay |
| `build-debug-v2` | Password-protected read-only production debugger for the adaptive pipeline |
| `statlocker-probe` | Statlocker data access and probing |
| `database` | TypeORM data source, migrations |

## Recommendation pipeline v2 (production path)

The exact non-negotiable ordering (design: ADR-002..ADR-006):

1. Load validated mechanics for the exact `(rulesetId, catalogSha256)` scope — fail closed on mismatch.
2. Hydrate the immutable, content-addressed strategy artifact; select or reconcile one whole strategy before item scoring.
3. Resolve the active strategy goal (family-first, see ADR-005) before transaction generation.
4. Prove legality before scoring; apply every `BUY`/`UPGRADE`/`SELL`/`REPLACE` through the canonical transition engine.
5. Compile semantic `AdaptivePlanActionV1[]` — requirements are embedded in actions, never separate cards.
6. Derive `recommendedBuild` only from `planActions` (compatibility projection).
7. Render semantic actions directly in Overwolf.

Any unavailable, unknown, stale, mismatched, or invalid critical input produces an explicit `ready: false` result with exact blockers. The legacy item-centric planner, stale-recommendation substitution, guessed mechanics, and UI-side transaction reconstruction are prohibited.

### Evidence layers

1. **Statlocker `PRO_BUILD_ANALYSIS`** (top 10 hero profiles via `HERO_LEADERBOARD`) — build structure, observed family progressions, purchase timing (ADR-003).
2. **Statlocker hero-item WPA + live threat** — matchup weighting, replacement ranking, `VS_HERO_WPA` archetype selection against the full enemy roster (ADR-004, ADR-006).
3. **Verified game mechanics** (item graph, recipes, prices, slots, capacity) — execution validation only (ADR-006).

No training or policy learning uses our own players' or match data (ADR-007).

## Overwolf client (`apps/overwolf-client/src`)

- GEP event capture and buffering, transport to the API.
- Adaptive recommendation clients: polling, force refresh, full-build path, v2 cutover.
- Presentation layers: `adaptive-recommendation-presentation.ts` (aggregates plan steps so each planned item appears exactly once), transaction-plan and roadmap presentations, decision-debug presentation.
- Desktop window renders all statuses; the in-game overlay filters `OWNED` items.

## Domain library (`packages/deadlock-build-domain/src`)

Pure, framework-free logic shared by the API and tests: `recommendation-ruleset-catalog.ts` (strict catalog compilation, upgrade recipes), item graph (family/lineage relationships, `isComponentAncestor`), `recommendation-candidate-generator.ts`, `inventory-reducer.ts`, diagnostic match parsing and baseline models.

## Commands

| Command | Description |
|---|---|
| `yarn install --ignore-engines` | Install dependencies |
| `yarn build` | Build all workspaces (domain first) |
| `yarn test` | Run all workspace test suites |
| `yarn lint` | Lint all workspaces |
| `yarn db:migrate` / `db:revert` / `db:migrations` / `db:generate` | TypeORM migrations for the API |
| `yarn workspace @deadlock-live-probe/api start:dev` | Run API in watch mode |

Database reset, backup, migration, and metadata reprocessing: `docs/database-migrations.md`.

## Testing

- `apps/api/test/*` — unit + e2e suites; the deterministic real-Billy fixture (`billy-real` golden) guards end-to-end recommendation shape; `statlocker-build-v2-real-data` suites validate against captured Statlocker evidence.
- `apps/overwolf-client/src/*.spec.ts` — presentation contracts, including zero-duplicate item cards and `OWNED` overlay filtering.
- Offline validation, then direct cutover: there is no V1 shadow mode and no legacy fallback (ADR-003).

## Deployment

- GitHub Actions: `ci.yml` (tests), `deploy.yml` (push to `main` triggers the self-hosted runner on the VPS), `adaptive-production-debug.yml`.
- VPS runs Docker Compose (`docker-compose.yml`, container `deadlock_dynamo_helper-api-1`); `ops/nginx` terminates TLS/routing.
- Economy-rules bootstrap is passed to compose via env (`c6baf71e`); live-event JSON body limit is 10 MB (`c3246943`).

## Documentation map

| Doc | Content |
|---|---|
| `docs/architecture.md` | This overview |
| `docs/decisions/` | ADR-001…ADR-007 — architecture decisions with rationale |
| `docs/overwolf-deadlock-live-probe-runbook.md` | Setup, sideloading, live validation |
| `docs/overwolf-production-release.md` | API deployment, unpacked Overwolf build, developer-mode loading, rollback |
| `docs/database-migrations.md` | DB reset/backup/migration procedures |
| `docs/versioned-item-catalogs.md`, `docs/historical-catalogs-and-ruleset-windows.md` | Catalog versioning and ruleset windows |
| `docs/statlocker-vs-hero-wpa-semantics.md` | WPA evidence semantics |
| `docs/diagnostic-baseline.md` | Diagnostic baseline tooling |
| `docs/superpowers/specs/` | Normative design documents (historical authority) |
| `docs/superpowers/plans/` | Implementation plans (historical) |
