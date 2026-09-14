# ADR-005: Family-first lifetime builds

## Status

Accepted

## Date

2026-09-11

## Context

The original Statlocker Build Strategy V2 model (ADR-003) treated high-frequency archetype items as independent lifetime semantic goals with sticky historical completion. Review of the real Billy E2E showed this generates mechanically legal but strategically meaningless churn: the planner buys one item only to immediately replace it with another, merely to mark multiple `CORE` goals as completed.

Design authority: `docs/superpowers/specs/2026-09-11-statlocker-build-strategy-v2-family-first-design.md`. This is a continuation of ADR-003/ADR-004, not a parallel architecture.

## Decision

- The semantic unit of a build is the item **family** (e.g. *Close Quarters → Point Blank*), not the individual item.
- A full build is an **inventory-evolution plan**, not a fixed final inventory. It may be longer than simultaneous inventory capacity and contains `BUY`, `UPGRADE`, `SELL`, and `REPLACE` transitions.
- The family-first full-build resolver resolves one active family at a time; held components are upgraded **in place** and consumed from the simulated inventory the moment the upgrade executes.
- Structural items are classified hard core / soft core / branch (`OR`/`CHOICE`) / flexible-situational. Hard core is protected unless an explicit future policy changes that.
- `OR`/`CHOICE` resolution is matchup-driven (per ADR-004), preserving the structural meaning of the branch.

## Alternatives Considered

### Keep per-item lifetime goals with sticky completion

- Pros: simpler bookkeeping.
- Cons: goal completion decoupled from strategy — the churn above is the direct result.
- Rejected.

### Treat the build as a fixed 12-item final inventory

- Pros: easy to render.
- Cons: cannot express upgrade paths (12+ purchases), forced early replacement planning, and contradicts the lifetime-build goal.
- Rejected: see ADR-006 for the capacity model.

## Consequences

- Upgrade lineage is preserved end-to-end: an observed upgrade (e.g. *Quicksilver Reload → Mercurial Magnum*) stays an upgrade; `itemGraph.isComponentAncestor()` backstops recipe-based detection.
- The transaction compiler can never sell an item that was already consumed by an upgrade.
- Downstream presentation aggregates per family, so one family = one card with embedded requirements (consistent with ADR-002).
