# ADR-002: Semantic action model for production recommendations

## Status

Accepted

## Date

2026-09-07

## Context

The V1 recommendation pipeline emitted transaction-plan steps and prerequisite barrier rows (`WAIT_FOR_FLEX`, `WAIT_FOR_GOLD`, `TRANSACTION`) as the public source of truth. The Overwolf UI mapped every raw step to a standalone item card, so one planned purchase (e.g. *Dispel Magic*) appeared 2–3 times in the build list. The UI also reconstructed transaction semantics (sells, upgrades) that the API had already compiled, and reused previous recommendations when current evidence was missing — producing stale or fabricated guidance.

Design authority: `docs/superpowers/specs/2026-09-07-deadlock-adaptive-builder-production-release-design.md`.

## Decision

1. `AdaptiveRecommendationResultV1` is a discriminated union: `AdaptiveReadyRecommendationV1` (`ready: true`) or `AdaptiveUnavailableRecommendationV1` (`ready: false`). An unavailable result carries exact blockers and never carries a stale or fabricated build.
2. One `AdaptivePlanActionV1` = one user-facing intent: `BUY`, `UPGRADE` (names all consumed components), `REPLACE` (names the item to sell), `WAIT`/`BLOCKED`, or `COMPLETE`. Requirements (souls, flex, shop availability, consumed components, replacement sale) are embedded in the action — they are never separate user-facing cards.
3. `planActionId` is the card identity; the item ID is not an identity or deduplication key.
4. `recommendedBuild` is a compatibility projection derived only from `planActions`, never independently.
5. The transaction-plan compiler/validator/reconciler remain internal primitives, but V1 step sessions are not the public contract. Readers may parse persisted V1 sessions; production writers emit semantic actions.
6. Mechanics load is fail-closed: for the exact `(rulesetId, catalogSha256)` scope a validated mechanics record must exist (slots, flex capacity, upgrade recipes and prices, sell/refund policy, shop-opportunity evidence). `DEFAULT_RECOMMENDATION_CANDIDATE_RULES`, inferred flex, assumed shop availability, and fabricated upgrade prices are prohibited in the production path.

## Alternatives Considered

### Keep barrier rows and aggregate them in the UI

- Pros: no API change.
- Cons: leaves the UI reconstructing transactions; every consumer re-implements deduplication; the plan-step format cannot express upgrade lineage (see the *Point Blank* / *Close Quarters* roadmap bug).
- Rejected: presentation-layer aggregation fixes the symptom, not the contract.

### Hide unavailable results and serve the last good recommendation

- Pros: overlay always shows something.
- Cons: a recommendation without current evidence is fabricated guidance.
- Rejected: explicit `ready: false` with blockers is the contract.

## Consequences

- Zero duplicated item cards by construction (identity is the action, not the item).
- Overwolf renders semantic actions directly; UI-side transaction reconstruction is dead code.
- Every missing-input case must be enumerated as a blocker — coverage of blocker cases is a test surface.
- ADR-005 later refined how upgrade/consumption semantics are computed, on the same action contract.
