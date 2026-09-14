# ADR-006: Capacity-driven replacement and verified-mechanics upgrades

## Status

Accepted

## Date

2026-09-12

## Context

Two related defects in the Adaptive pipeline: (1) production data could collapse an observed upgrade family into a direct terminal purchase — a confirmed upgrade such as *Quicksilver Reload → Mercurial Magnum* silently degraded to `BUY terminal` when upgrade mechanics were missing from enrichment (the same root cause as the *Point Blank* / *Close Quarters* contradictory-sell bug); (2) capacity was treated as a limit on the number of selected desired families, which truncated build timelines at 12 purchase goals even though only *simultaneously held* inventory is limited to 12.

Design authority: `docs/superpowers/specs/2026-09-12-statlocker-adaptive-progression-replacement-design.md`.

## Decision

- **Capacity applies to held inventory, never to the build timeline.** Full build timelines may contain more than 12 transaction rows; held inventory must never exceed 12 items.
- **Replacement is capacity-driven and lazy**: it runs only when all 12 slots are occupied and the next planned action requires a new slot.
- Replacement candidates are ranked from Statlocker hero-item usefulness and purchase-time evidence, with matchup-specific protection based on the full enemy team.
- **A confirmed upgrade never falls back to direct `BUY terminal`.** Statlocker evidence determines that a progression is an upgrade; verified game mechanics determine only whether it can be executed. If executable mechanics are unavailable, the result fails closed (per ADR-002's fail-closed contract) — it does not fabricate a purchase.
- Topology (known lineage) and executable mechanics (verified recipe + price) remain separate concerns; only a verified executable recipe may create an `UPGRADE` transaction.

## Alternatives Considered

### Derive `soulsCost` heuristically and keep planning the upgrade

- Pros: pipeline always returns an actionable plan.
- Cons: fabricated prices violate the exact-mechanics contract and can produce unrealizable transactions.
- Rejected: fail-closed beats fail-wrong. (The catalog-compilation fallback `soulsCost = max(0, target - component)` from the dedup roadmap is applied only where direct purchase costs are *known*, which is evidence, not fabrication.)

### Plan replacements eagerly at build-compile time

- Pros: the plan is "complete" from the start.
- Cons: replaces items that may never need replacing, discards committed investment, and reacts to a schedule instead of actual inventory state.
- Rejected: replacement is a consequence of capacity pressure, not a build goal.

## Consequences

- Late-game builds keep progressing past 12 purchases; the HUD shows the next action, not 12 terminal buys.
- Deterministic real-Billy E2E fixture guards the upgrade-vs-buy distinction.
