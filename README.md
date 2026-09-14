# Deadlock Live Probe

Yarn workspace monorepo capturing real-time *Deadlock* game events through Overwolf, transporting them to a NestJS API for raw event persistence, reducing a minimal match state, and displaying telemetry details on a live debug dashboard.

## 📁 Repository Structure

- `apps/api`: NestJS API server owning event ingestion, NDJSON logging, state reduction, and the debug inspector.
- `apps/overwolf-client`: Overwolf runtime app integrating GEP, event buffering, and transport to the API.
- `packages/shared`: Common TypeScript DTOs and state types.

## 🚀 Quick Start Commands

- **Install dependencies:** `yarn install --ignore-engines`
- **Run database migrations:** `yarn db:migrate`
- **Build packages:** `yarn build`
- **Run test suites:** `yarn test`

For the system architecture, evidence model, and module map, see the [Architecture Overview](docs/architecture.md). Architecture decisions and their rationale are recorded as ADRs in [`docs/decisions/`](docs/decisions/).

Database reset, backup, migration, and raw metadata reprocessing instructions are in [`docs/database-migrations.md`](docs/database-migrations.md).

For setup, sideloading, and live validation, see the [Overwolf Deadlock Live Probe Runbook](docs/overwolf-deadlock-live-probe-runbook.md).

For API deployment, unpacked Overwolf build, Developer Mode loading, live verification, and rollback, see the [Overwolf Sideload Rollout Runbook](docs/overwolf-production-release.md).
