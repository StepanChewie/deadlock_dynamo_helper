# Deadlock Adaptive Builder Production Release Design

> **Historical design record.** At the time of writing this documented the referenced work; parts have since been implemented, refined by the ADRs, or superseded. It is kept for provenance, not as current instructions. Current architecture: `docs/architecture.md`; decisions: `docs/decisions/`.

## Status

Approved requirements captured from the production-release roadmap request on 2026-09-07. This document is the normative architecture contract for the implementation roadmap in `docs/superpowers/plans/2026-09-07-deadlock-adaptive-builder-production-release-roadmap.md`.

## Goal

Production recommendation must execute only this evidence-bounded pipeline:

```text
exact ruleset/catalog
  -> executable item mechanics
  -> canonical inventory transition
  -> published BuildStrategySpec
  -> persisted sticky StrategySession
  -> one active strategy goal
  -> legal candidates
  -> situational constraints
  -> scoring
  -> semantic PlanAction[]
  -> recommendedBuild compatibility projection
  -> Overwolf semantic rendering
```

When any critical input is unavailable, unknown, stale, mismatched, or invalid, the result is explicitly unavailable, blocked, or out of distribution. Production never invokes the legacy item-centric planner, reuses a previous recommendation as a substitute for current evidence, guesses mechanics, or reconstructs transactions in the UI.

## Non-negotiable ordering

1. Select or reconcile one whole strategy before item scoring.
2. Resolve the active strategy goal before transaction generation.
3. Prove legality before scoring.
4. Apply every `BUY`, `UPGRADE`, `SELL`, and `REPLACE` through one canonical transition engine.
5. Compile semantic actions from strategy goals and canonical transactions.
6. Derive `recommendedBuild` only from semantic actions.
7. Render semantic actions directly in Overwolf.

## Production response contract

`AdaptiveRecommendationResultV1` becomes a discriminated union:

```ts
type AdaptiveRecommendationResultV1 =
  | AdaptiveReadyRecommendationV1
  | AdaptiveUnavailableRecommendationV1;
```

A ready result has `ready: true` and guarantees:

- exact `rulesetId` and `catalogSha256`;
- a validated strategy artifact and selected `strategyId`;
- persisted strategy-session identity and state;
- a valid build contract;
- evidence provenance and version provenance;
- `planActions: readonly AdaptivePlanActionV1[]`;
- at least one semantic action unless the build contract is legitimately `COMPLETE`;
- `recommendedBuild`, while compatibility requires it, derived only from `planActions`.

An unavailable result has `ready: false`, exact blockers, an `ABSTAIN` or non-transaction status, and no actionable build. It may expose diagnostic provenance, but it cannot carry a stale or fabricated recommendation.

## Semantic action model

One `AdaptivePlanActionV1` is one user-facing intent:

- `BUY` targets one item;
- `UPGRADE` targets one item and names all consumed components;
- `REPLACE` targets one item and names the item to sell;
- `WAIT` or `BLOCKED` describes a non-transaction state tied to the intended target;
- `COMPLETE` exists only when every mandatory and committed terminal condition is satisfied.

Requirements such as souls, flex, shop availability, prerequisites, consumed components, or a replacement sale are embedded in the action. They are not separate user-facing cards. `planActionId` is the card identity; item ID is not an identity or deduplication key.

The existing transaction-plan compiler, validator, reconciler, and canonical projections remain useful implementation primitives, but `AdaptivePlanStepV1`/barrier rows cannot remain the public source of truth. Migration readers may parse persisted V1 step sessions, but production writers and responses emit semantic actions.

## Exact mechanics contract

For the exact `(rulesetId, catalogSha256)` scope, production must load a validated mechanics record containing:

- base slots by item category;
- maximum flex slots;
- exact active-item capacity;
- investment breakpoints;
- executable upgrade recipes and prices;
- sell/refund policy;
- shop-opportunity evidence policy.

Missing or mismatched records fail closed. `DEFAULT_RECOMMENDATION_CANDIDATE_RULES`, inferred flex from time/objectives/inventory size, assumed shop availability, or fabricated upgrade prices are prohibited in the production path.

Known recipe topology and executable transaction mechanics remain separate. Topology may prove lineage satisfaction, but only a verified executable recipe may create an `UPGRADE` transaction.

## Published strategy artifact

Runtime consumes an immutable, schema-validated artifact produced offline. It does not mine archetypes from raw matches during recommendation.

The artifact envelope contains:

```text
schemaVersion
heroId
rulesetId
catalogSha256
strategyArtifactVersion
strategyCompilerVersion
generatedAt
sourceDatasetRevision
sourceSha256
strategies[]
```

Every strategy is exact-scope, references only known items, embeds its situational windows, and passes all publication gates. The artifact is persisted immutably, content-addressed, hydrated at startup, and rejected on invalid schema, SHA, duplicate IDs, unknown items, scope mismatch, or failed feasibility proof.

## Strategy proof and publication

Publication requires all of the following:

- support and stability meet configured thresholds;
- canonical representative replay is 100%;
- every mandatory path is executable;
- every published XOR alternative proof is replayed from its exact before-state;
- every terminal variant is capacity-feasible;
- no critical mechanics value is `UNKNOWN`;
- situational metadata is explicit and version-bound to the strategy.

Each branch proof validates action IDs, legality, canonical inventory transitions, slot and active capacity, goal satisfaction, downstream mandatory continuation, and terminal feasibility. A valid representative path never substitutes for alternative validation.

## Sticky strategy session

Strategy state is persisted by `(matchId, player identity)` and includes:

- selected strategy and posterior vector;
- `PROVISIONAL`, `COMMITTED`, `DIVERGED`, or `OUT_OF_DISTRIBUTION` state;
- selected and committed branches;
- irreversible investment markers;
- active goal and build-contract revision;
- prior plan-action reconciliation state.

Initial switching is relatively permissive. After commitment or irreversible investment, a higher deterministic threshold applies. Small score changes do not switch strategies. Divergence first rebases the current strategy while preserving an unexpected item whenever a legal completion path exists. If that fails, the selector chooses one complete feasible strategy. It never combines goals from multiple strategies. No feasible strategy yields explicit OOD.

Posterior components are separately observable and deterministic: prior/support, purchase-prefix likelihood, timing likelihood, draft likelihood when causally available, inventory progression, branch commitment, and divergence. Future match events are forbidden inputs.

## Build contract and capacity proof

The build contract proves completion of all remaining mandatory goals, not just the next transaction. Every future mandatory goal has one exit classification:

```text
READY
LOCKED_BY_FLEX
LOCKED_BY_SELL
LOCKED_BY_UPGRADE_COMPRESSION
BLOCKED
```

Only observed upgrade compression, an explicit strategy sell/replace exit, a verified future flex prerequisite, or an observed archetype exit may prove capacity. A temporary item is sellable for planning only when the selected strategy explicitly allows that exit. Missing proof yields `REPLAN_REQUIRED` or OOD.

## Situational recommendation contract

Situational choices exist only inside a selected strategy's explicit windows. Each window defines its ID, purpose, candidate item IDs, maximum item count, maximum core delay, and reserved slots. Runtime compares a supported interruption against `CONTINUE_CORE`; `OPTIONAL` does not imply situational.

Targets must belong to the current enemy roster and use fresh, threshold-qualified evidence. Target hysteresis prevents oscillation. `VS_HERO_WPA` is labeled `MATCHUP_STAT`; it never becomes a mechanical-causality claim without a separate mechanics source. No hero-item pairing is hardcoded.

## Offline trajectory and mining contract

Only canonically replayable `PlannerTrajectoryV2` records enter mining. Each transaction records match/player identity, hero, exact ruleset and catalog SHA, current roster, time, action and transaction identities, source and consumed/removed/added items, soul delta, inventory and state fingerprints, slot and investment states, and terminal contract.

Rejected and unexplained transactions remain visible in audit output. Publication requires zero inventory drift and zero unknown patch identity. Clustering excludes outcome/win rate and compares at least feature-vector, sequence-aware, and hierarchical baselines using stability, noise, interpretability, replay feasibility, and sample consistency. Outcome is evaluation-only.

## UI contract

Overwolf renders exactly one card per `AdaptivePlanActionV1`. Requirements appear inside that card. Missing `planActions` in a response claiming readiness is a contract error and renders unavailable; the client never reconstructs cards from `recommendedBuild`.

Generated item and hero catalogs are checked against canonical seeds. Unknown hero labels are omitted or block the affected `Against` label. Production never invents `Hero #123`.

## Completion and evidence semantics

`COMPLETE` requires all mandatory goals, committed branches, and terminal constraints to be satisfied. `HOLD`, `WAIT`, no current purchase, or a full inventory cannot imply completion. Optional and situational goals do not block completion.

Previous results may support hysteresis and session comparison only. They cannot substitute for unavailable current evidence. All response provenance needed for deterministic offline reproduction is mandatory.

## Verification policy

- GitHub Actions are not used for this release.
- Every test, build, catalog check, and audit is executed locally with the repository's real scripts.
- Every zero-tolerance replay and strategy correctness metric equals exactly zero on the release corpus.
- No assertion, release threshold, or regression is weakened to obtain green output.
- Merge to `main` and production deployment are forbidden until every release gate in the implementation roadmap is green.

