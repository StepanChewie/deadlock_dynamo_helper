# Dynamo Lab

Yarn workspace monorepo that captures real-time *Deadlock* game events through Overwolf and serves **adaptive build recommendations** from a NestJS API: raw event persistence, live match-state reduction, the archetype-based v2 recommendation pipeline, and the in-game HUD / desktop presentation.

## 📁 Repository Structure

- `apps/api`: NestJS API server owning event ingestion, NDJSON logging, state reduction, and the debug inspector.
- `apps/overwolf-client`: Overwolf runtime app integrating GEP, event buffering, and transport to the API.
- `packages/deadlock-build-domain`: pure domain library (ruleset catalog, item graph, candidate generation, inventory reduction).
- `packages/shared`: common TypeScript DTOs and state types.
- `ops/nginx`: reverse-proxy configuration for the VPS deployment.
- `docs/`: architecture overview, ADRs, runbooks and historical design records.

## 🚀 Quick Start Commands

- **Install dependencies:** `yarn install --ignore-engines`
- **Run database migrations:** `yarn db:migrate`
- **Build packages:** `yarn build`
- **Run test suites:** `yarn test`

For the system architecture, evidence model, and module map, see the [Architecture Overview](docs/architecture.md). Architecture decisions and their rationale are recorded as ADRs in [`docs/decisions/`](docs/decisions/).

Database reset, backup, migration, and raw metadata reprocessing instructions are in [`docs/database-migrations.md`](docs/database-migrations.md).

For setup, sideloading, and live validation, see the [Dynamo Lab Runbook](docs/dynamo-lab-runbook.md).

For API deployment, unpacked Overwolf build, Developer Mode loading, live verification, and rollback, see the [Overwolf Sideload Rollout Runbook](docs/overwolf-production-release.md).
