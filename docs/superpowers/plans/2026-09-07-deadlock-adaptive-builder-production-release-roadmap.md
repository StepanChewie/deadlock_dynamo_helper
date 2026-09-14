# Deadlock Adaptive Builder Production Release Implementation Plan

> **Historical design record.** At the time of writing this documented the referenced work; parts have since been implemented, refined by the ADRs, or superseded. It is kept for provenance, not as current instructions. Current architecture: `docs/architecture.md`; decisions: `docs/decisions/`.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Release Deadlock Adaptive Builder with one fail-closed, strategy-first, canonical-transaction architecture whose semantic `planActions` are the only production recommendation source of truth.

**Architecture:** Preserve the existing item graph, canonical candidate transition, strategy mining/compiler/registry, build-contract, and transaction-plan primitives. Tighten their boundaries into an exact-scope offline artifact pipeline and a persisted single-strategy runtime, remove every reachable legacy/default/stale-plan fallback, compile semantic actions directly, and make both compatibility projection and Overwolf depend only on those actions.

**Tech Stack:** TypeScript 5.9, NestJS 11, TypeORM/PostgreSQL, Yarn 1 workspaces, Jest/ts-jest, `@deadlock-live-probe/build-domain`, `@deadlock-live-probe/shared`, Overwolf/Webpack, Docker on Linux ARM64.

**Spec:** `docs/superpowers/specs/2026-09-07-deadlock-adaptive-builder-production-release-design.md`

## Global Constraints

- Strategy is selected before item scoring.
- Goal is selected before transaction generation.
- Legality is proven before scoring.
- Every `BUY`, `UPGRADE`, `SELL`, and `REPLACE` uses one canonical transition engine.
- `planActions` is the production source of truth; `recommendedBuild` is projection-only.
- No production fallback to the legacy item-centric planner, flat compatibility plan, previous recommendation, consensus skeleton, default mechanics, or fabricated label.
- Missing critical evidence, mechanics, scope, strategy, or proof fails closed as unavailable, blocked, or OOD.
- No hardcoded hero-item rule and no inferred mechanical causality from correlation.
- Every deterministic tie-breaker is explicit.
- All code and generated artifacts are validated locally; do not run GitHub Actions.
- Do not implement on `main`; do not merge until every release gate is green.
- Do not weaken assertions, delete regressions, or lower a release threshold to make a gate pass.

---

## Baseline audit: 2026-09-07

The roadmap is based on local `main` at `8ad59890`. The requested branch `agent/implement-adaptive-builder-correctness-situational-v2-red` is not present in current local or remote refs. Execution must resolve that discrepancy before code work; it must not assume that current `main` is the requested branch.

### Existing foundations to retain

- `RecommendationItemGraph` and canonical recommendation candidates already model lineage, recommendation eligibility, and state projection.
- `AdaptivePlanSessionV1`, transaction compiler, validator, reconciler, projection, and focused full-slot regressions already exist.
- `BuildStrategySpecV1`, compiler, archetype miner, feasibility service, registry, persistent snapshot store, and historical trajectory pipeline already exist.
- Branch feasibility enumerates branch selections and rejects unreachable paths.
- The strategy snapshot store persists immutable payloads and validates content hashes.
- Direct shop provenance validation exists in the V8 live-state pipeline.
- Strategy-first, transaction-first, upgrade-lineage, slot-pressure, replacement-safety, and Overwolf presentation tests provide a substantial regression base.

### Confirmed production blockers

| Blocker | Current evidence | Required end state |
|---|---|---|
| Requested branch unresolved | no matching local/remote branch ref | exact starting history identified, backed up, and rebased onto fresh `origin/main` |
| Evidence fallback | `adaptive-recommendation-v1.service.ts` calls `previousEvidenceFallback` / `emptyEvidenceFallback` | unavailable evidence returns `ready: false` and no actionable plan |
| Legacy/flat serving fallback | `adaptive-planner-serving-router-v1.service.ts` routes to legacy, shadow, or flat compat | production router has one strategy/semantic path; shadow tooling is unreachable from endpoint |
| Consensus fallback | facade compiles `ConsensusStrategyFallbackV1` when registry is empty | missing exact published strategy returns unavailable/OOD |
| Optional semantic contract | shared result has optional `planSession`; no required `planActions` | discriminated union with required semantic actions for ready results |
| Compatibility inversion | planner and facade still inspect/build `recommendedBuild` directly | one `planActions -> recommendedBuild` projection and no reverse dependency |
| Barrier cards | Overwolf maps transaction steps and barriers separately | one card per semantic action with embedded requirements |
| Default mechanics | `finalLegalityRules()` falls back to `DEFAULT_RECOMMENDATION_CANDIDATE_RULES` | exact mechanics or fail closed |
| Fabricated shop opportunity | transaction compiler uses reconstructed `AVAILABLE` for wait-for-shop projection | direct observed source or explicit unknown/block |
| Incomplete artifact identity | strategy scope omits catalog/artifact/compiler/dataset identity inside the artifact contract | fully versioned exact-scope artifact envelope and provenance |
| Transient strategy state | session is reconciled from prior response/helper state | repository-backed `(matchId, player)` sticky session |
| Composite posterior | selector uses one conformance formula plus support/stability | explicit prior/prefix/timing/draft likelihood components |
| Incomplete branch proof contract | feasibility explores branch selections from synthetic initial state | exact per-proof replay, downstream continuation, and terminal proof |
| UI hero fallback risk | item presentation still has numeric diagnostic fallbacks; hero check script is absent | generated hero catalog check and no fabricated production label |

---

## Critical path

```text
WP0 branch safety
 -> WP1 fail-closed response boundary
 -> WP2 semantic PlanAction contract
 -> WP3 exact mechanics and canonical transactions
 -> WP4 offline strategy proof and artifact publication
 -> WP5 persisted multi-strategy session
 -> WP6 whole-strategy rebase and future capacity proof
 -> WP7 situational evidence and causality
 -> WP8 Overwolf semantic-only UI
 -> WP9 audit metrics, golden corpus, determinism, startup validation
 -> WP10 legacy deletion, full local matrix, manual audit
 -> WP11 merge and ARM64 rollout
```

No work package may be declared complete from compilation alone. Each package ends in a focused regression gate and a fresh review of the production call path.

---

## WP0: Recover the intended branch and establish a safe baseline

**Outcome:** implementation starts from an identified feature history rebased onto current `origin/main`, with a recoverable backup and a green TypeScript baseline.

**Files:** no product files should change while resolving history. Record the resolved refs and baseline commands in this roadmap's execution log or a dedicated release evidence document.

- [ ] Fetch all remotes and prune stale refs without switching away from the current checkout until uncommitted user files are accounted for.
- [ ] Resolve `agent/implement-adaptive-builder-correctness-situational-v2-red` from local refs, remote refs, reflogs, existing worktrees, or commit ancestry. If it cannot be found, stop and report the missing history instead of silently substituting `main`.
- [ ] Inspect the existing dirty state (`CURRENT-ROADMAP.md` deletion, `CURRENT_ROADMAP.MD`, `.codex/`, `AGENTS.md`, and `graphify-out/`) and preserve it; do not stash, delete, or commit unrelated user changes without explicit direction.
- [ ] Create a named backup branch and annotated tag at the resolved feature head.
- [ ] Create an isolated implementation worktree from fresh `origin/main`, then rebase or cherry-pick the feature commits in dependency order.
- [ ] Resolve conflicts in favor of strategy-first, transaction-first, exact-mechanics semantics. Never restore a legacy fallback to resolve a conflict.
- [ ] Run shared, domain, API, and Overwolf TypeScript builds before functional edits.
- [ ] Record `git rev-parse HEAD`, `git merge-base HEAD origin/main`, the backup ref, and actual command output.

**Gate WP0:** the intended history is proven, recoverable, rebased, conflict-free, and compiling. No product behavior is changed to obtain the baseline.

---

## WP1: Make the endpoint fail closed and remove recommendation substitution

**Primary files:**

- `apps/api/src/statlocker-adaptive/adaptive-recommendation-v1.service.ts`
- `apps/api/src/statlocker-adaptive/adaptive-planner-serving-router-v1.service.ts`
- `apps/api/src/statlocker-adaptive/strategy-first-adaptive-planner-facade-v1.service.ts`
- `apps/api/src/statlocker-adaptive/strategy-first-legacy-planner-adapter-v1.service.ts`
- `apps/api/src/statlocker-adaptive/consensus-strategy-fallback-v1.service.ts`
- `apps/api/src/statlocker-adaptive/adaptive-recommendation-v1.controller.ts`
- `docker-compose.yml`

**Focused tests:** adaptive recommendation, serving router, controller, missing evidence, missing strategy, and strategy-first facade suites.

- [ ] Add RED tests proving that unavailable/stale/mismatched critical evidence never returns a previous actionable recommendation.
- [ ] Add RED tests proving that missing exact strategy, invalid transaction plan, promotion failure, and exact-mechanics failure never invoke legacy or flat compatibility planners.
- [ ] Introduce one explicit unavailable result constructor with sorted blockers, zero confidence, no ranked candidates, and `ABSTAIN`/non-transaction action.
- [ ] Delete `previousEvidenceFallback` and any path that uses yesterday's/previous `recommendedBuild` as the current recommendation. Retain previous state only for hysteresis and session comparison.
- [ ] Delete production calls to `AdaptiveBuildPlannerV1Service` legacy routing, `planFlatCompat`, and `ConsensusStrategyFallbackV1Service`.
- [ ] Remove environment-controlled production fallback behavior (`ADAPTIVE_ZERO_FALLBACK`, legacy/shadow serving modes) from the endpoint. If shadow comparison remains for offline diagnostics, isolate it behind a non-serving command/service with no endpoint dependency.
- [ ] Ensure transaction validation failure, registry miss, artifact mismatch, and OOD return explicit blockers rather than throwing a generic 500 or falling back.
- [ ] Add `legacyFallbackInvocationRate` instrumentation at the boundary and assert it remains exactly zero.

**Gate WP1:** all failure modes are honest and non-actionable; the production endpoint has a single reachable planner architecture.

---

## WP2: Establish `planActions` as the mandatory production contract

**Primary files:**

- `packages/shared/src/adaptive-recommendation-v1.ts`
- `packages/shared/src/adaptive-transaction-plan-v1.ts`
- `packages/shared/src/index.ts`
- `apps/api/src/statlocker-adaptive/transaction-plan-step-v1.ts`
- `apps/api/src/statlocker-adaptive/transaction-plan-compiler-v1.service.ts`
- `apps/api/src/statlocker-adaptive/transaction-plan-reconciler-v1.service.ts`
- `apps/api/src/statlocker-adaptive/transaction-plan-validator-v1.service.ts`
- `apps/api/src/statlocker-adaptive/transaction-plan-projection-v1.ts`
- `apps/api/src/statlocker-adaptive/strategy-first-transaction-plan-v1.service.ts`

**Interfaces produced:**

```ts
interface AdaptivePlanActionV1 {
  planActionId: string;
  strategyId: string;
  goalId: string;
  type: 'BUY' | 'UPGRADE' | 'REPLACE' | 'WAIT' | 'BLOCKED' | 'COMPLETE';
  state: 'NEXT' | 'PLANNED' | 'BLOCKED' | 'COMPLETE';
  targetItemId?: number;
  sellItemId?: number;
  consumedItemIds: readonly number[];
  requirements: readonly AdaptivePlanRequirementV1[];
  projectedBefore: AdaptivePlanProjectionV1;
  projectedAfter?: AdaptivePlanProjectionV1;
  reasonCodes: readonly string[];
}
```

- [ ] Add shared RED serialization and type-contract tests for ready, complete, and unavailable results.
- [ ] Define a discriminated ready/unavailable union. `ready: true` requires exact strategy/build/evidence/version provenance and `planActions`; `ready: false` cannot contain actionable actions or a future compatibility build.
- [ ] Replace public standalone barrier steps with requirements embedded in their target semantic action. Preserve a migration parser only for already persisted V1 sessions.
- [ ] Compile semantic actions directly from selected strategy goals plus canonical transactions and projected states.
- [ ] Reconcile action identity by `planActionId`, never by item ID. Prove that two legitimate actions involving the same item retain distinct identities.
- [ ] Make `projectRecommendedBuildFromPlanActionsV1()` the only compatibility projection.
- [ ] Remove every `recommendedBuild -> mechanics`, `recommendedBuild -> source item`, `recommendedBuild -> action type`, and `recommendedBuild -> sell decision` dependency.
- [ ] Keep `recommendedBuild` only if required by an external V1 consumer; mark its removal boundary and ensure the endpoint can remove it in a future schema version without changing planner behavior.
- [ ] Define completion as an empty transactional action list plus explicit `COMPLETE` build contract, never as missing actions.

**Gate WP2:** a ready response is impossible to construct without valid semantic actions or legitimate completion, and the compatibility build is a one-way projection.

---

## WP3: Pin exact mechanics and converge all transactions on one engine

**Primary files:**

- `apps/api/src/statlocker-adaptive/adaptive-economy-v1.ts`
- `apps/api/src/statlocker-adaptive/recommendation-economy-rules-store-v1.service.ts`
- `apps/api/src/statlocker-adaptive/adaptive-decision-state-v1.service.ts`
- `packages/deadlock-build-domain/src/recommendation-ruleset-catalog.ts`
- `packages/deadlock-build-domain/src/recommendation-candidate-generator.ts`
- `packages/deadlock-build-domain/src/recommendation-action-domain.ts`
- `apps/api/src/statlocker-adaptive/adaptive-planner-transition-v1.ts`
- `apps/api/src/statlocker-adaptive/transaction-plan-compiler-v1.service.ts`

- [ ] Add RED tests for missing exact economy, unknown active capacity, unknown flex, unknown shop, catalog mismatch, and unknown upgrade transaction.
- [ ] Version an exact mechanics registry keyed by `(rulesetId, catalogSha256)` with base slots by type, maximum flex, active capacity, investment breakpoints, sell policy, and executable upgrade pricing.
- [ ] Remove `DEFAULT_RECOMMENDATION_CANDIDATE_RULES` from all production callers. Missing exact record yields `RULESET_ECONOMY_MECHANICS_UNKNOWN`.
- [ ] Accept flex only from explicit live fields (`flex_slots`, `unlocked_flex_slots`, `flex_slot_count`). Remove objective/time/inventory-size inference.
- [ ] Pass `activeCapacityEvidence` through every production candidate-generation call. Permit actions that do not increase active count; block an increase when capacity is unknown or exceeded.
- [ ] Bind shop opportunity to the validated direct live source. `UNKNOWN` produces a wait/block requirement and never an assumed `AVAILABLE`.
- [ ] Separate known recipe topology from executable upgrade mechanics. Unknown price blocks `UPGRADE`; it does not erase lineage and does not fabricate cost.
- [ ] Route `BUY`, multi-step `UPGRADE`, `SELL`, and `REPLACE` through the same canonical candidate projection function in immediate selection, horizon compilation, replay, feasibility proof, and golden evaluation.
- [ ] Preserve consumed-component multiplicity and remove consumed instances immediately. A consumed item can never reappear as owned or sellable downstream.
- [ ] Lock the full-inventory regression `Close Quarters -> Point Blank -> Escalating Resilience`: Point Blank consumes Close Quarters and sells no unrelated item.

**Gate WP3:** unknown mechanics produce zero transactions, exact mechanics produce identical transitions in live planning and offline replay, and all upgrade-lineage regressions pass.

---

## WP4: Turn offline mining into a production artifact pipeline

**Primary files:**

- `apps/api/src/statlocker-adaptive/planner-trajectory-v2.ts`
- `apps/api/src/statlocker-adaptive/planner-trajectory-builder-v2.service.ts`
- `apps/api/src/statlocker-adaptive/historical-planner-trajectory-extractor-v2.service.ts`
- `apps/api/src/statlocker-adaptive/historical-build-trajectory-source-v2.service.ts`
- `apps/api/src/statlocker-adaptive/build-archetype-features-v1.ts`
- `apps/api/src/statlocker-adaptive/build-archetype-miner-v1.service.ts`
- `apps/api/src/statlocker-adaptive/build-strategy-compiler-v1.service.ts`
- `apps/api/src/statlocker-adaptive/build-strategy-feasibility-v1.service.ts`
- `apps/api/src/statlocker-adaptive/build-strategy-validator-v1.service.ts`
- `apps/api/src/statlocker-adaptive/build-strategy-snapshot-store-v1.service.ts`
- `apps/api/src/statlocker-adaptive/build-strategy-registry-v1.service.ts`
- `apps/api/src/statlocker-adaptive/build-strategy-mining-pipeline-v1.service.ts`

- [ ] Expand `PlannerTrajectoryV2` validation to require every identity, action, source, inventory/state fingerprint, slot/investment state, and terminal-contract field from the design.
- [ ] Canonically replay every accepted transaction. Reject unexplained transactions and retain deterministic rejection codes and counts.
- [ ] Produce the trajectory audit metrics: counts, replay coverage, unknown transaction rate, inventory drift, unknown patch identity, and ruleset coverage.
- [ ] Make `inventoryDriftCount = 0` and `unknownPatchIdentityCount = 0` hard publication gates. Report unknown transaction rate separately; never hide rejected records.
- [ ] Ensure mining features exclude outcome and win rate. Compare feature-vector, sequence-aware, and hierarchical baselines using stability, noise, interpretability, replay feasibility, and sample consistency.
- [ ] Extend the artifact envelope with catalog SHA, artifact/compiler versions, generation time, source dataset revision, and source hash.
- [ ] Replay each published XOR proof from its recorded exact before-state. Verify action IDs, legality, transitions, slot/active capacity, goal satisfaction, mandatory downstream continuation, and terminal feasibility.
- [ ] Reject publication on unknown critical mechanics, scope mismatch, unavailable required item, invalid terminal capacity, or any invalid branch proof.
- [ ] Persist the immutable artifact first, then atomically activate it. Hydration must select one exact active artifact deterministically and reject duplicates or ambiguity.
- [ ] Provide a local publication command that emits a machine-readable audit report and exits non-zero on any hard gate.

**Gate WP4:** a versioned exact-scope artifact can be built reproducibly from accepted trajectories, and only fully replay-valid strategies enter the registry.

---

## WP5: Implement real multi-strategy selection and persisted sticky sessions

**Primary files:**

- `apps/api/src/statlocker-adaptive/build-strategy-selector-v1.service.ts`
- `apps/api/src/statlocker-adaptive/build-strategy-session-v1.service.ts`
- `apps/api/src/statlocker-adaptive/strategy-first-build-planner-v1.service.ts`
- `apps/api/src/statlocker-adaptive/strategy-first-adaptive-planner-facade-v1.service.ts`
- `apps/api/src/statlocker-adaptive/adaptive-replay-v1.service.ts`
- `apps/api/src/deadlock-live/entities/` for a persisted session entity and migration
- `apps/api/src/statlocker-adaptive/statlocker-adaptive.module.ts`

- [ ] Add RED tests with multiple feasible strategies proving selection happens before item scoring and never mixes goals.
- [ ] Load all strategies for exact `(heroId, rulesetId, catalogSha256)`; do not synthesize a strategy from consensus when the set is empty.
- [ ] Split posterior calculation into observable `priorWeight`, `purchasePrefixLikelihood`, `timingLikelihood`, `draftLikelihood`, inventory-progression likelihood, branch commitment, and divergence components.
- [ ] Permit initial inputs only from hero/scope, support/prior, quality/confidence, and causally available draft/roster evidence. Add purchase prefix, timing, branch, inventory, and divergence only during live updates. Forbid future events.
- [ ] Persist session state by `(matchId, player identity)` with optimistic revision control and deterministic serialization.
- [ ] Encode `PROVISIONAL`, `COMMITTED`, `DIVERGED`, and `OUT_OF_DISTRIBUTION` transitions explicitly.
- [ ] Apply a higher deterministic switching threshold after irreversible investment or branch commitment. Add hysteresis tests for small score fluctuations and exact posterior ties.
- [ ] Persist selected/committed branches and prohibit a committed branch from being silently replaced.
- [ ] On no feasible/conforming strategy, persist and return OOD; do not retain a Frankenstein plan.
- [ ] Include posterior components, session revision/state, strategy identity, and switch reason codes in response provenance and offline replay input.

**Gate WP5:** repeated identical observations keep the same strategy/session; meaningful evidence updates the posterior deterministically; no response combines strategies.

---

## WP6: Rebase divergence and prove the entire remaining capacity path

**Primary files:**

- `apps/api/src/statlocker-adaptive/build-contract-v1.service.ts`
- `apps/api/src/statlocker-adaptive/build-slot-planner-v1.service.ts`
- `apps/api/src/statlocker-adaptive/build-investment-policy-v1.service.ts`
- `apps/api/src/statlocker-adaptive/strategy-first-build-planner-v1.service.ts`
- `apps/api/src/statlocker-adaptive/transaction-plan-compiler-v1.service.ts`
- `apps/api/src/statlocker-adaptive/transaction-plan-validator-v1.service.ts`

- [ ] Add RED regressions for an unexpected temporary item, preservation during rebase, explicit later exit, impossible current strategy, and whole-strategy switch.
- [ ] Mark an unexpected purchase as external investment. Never auto-sell it merely because it is absent from the strategy.
- [ ] Recompute remaining base/flex/active capacity and rebase the current strategy while a complete legal path exists.
- [ ] Use only strategy-observed upgrade compression, sell/replace exits, flex prerequisites, and archetype exit items.
- [ ] If rebase fails, evaluate complete published strategies and switch to the nearest whole feasible strategy. Never splice goals.
- [ ] Add the exit classification `READY | LOCKED_BY_FLEX | LOCKED_BY_SELL | LOCKED_BY_UPGRADE_COMPRESSION | BLOCKED` for every future mandatory goal.
- [ ] Make missing future capacity proof yield `REPLAN_REQUIRED`; make absence of any whole feasible strategy yield OOD.
- [ ] Ensure `COMPLETE` requires all mandatory goals, committed branches, hard investment objectives, and terminal constraints. `HOLD`, `WAIT`, no purchase, or full inventory remain incomplete.
- [ ] Verify completed/committed goals and owned descendants are protected from unrelated sell or replacement throughout horizon projection.

**Gate WP6:** every published future mandatory target has a replayable capacity exit path, divergence preserves legal user investments, and impossible paths are explicit.

---

## WP7: Bind situational decisions to strategy windows and current evidence

**Primary files:**

- `apps/api/src/statlocker-adaptive/build-strategy-v1.ts`
- `apps/api/src/statlocker-adaptive/build-strategy-compiler-v1.service.ts`
- `apps/api/src/statlocker-adaptive/build-situational-resolver-v1.service.ts`
- `apps/api/src/statlocker-adaptive/strategy-first-situational-overlay-v1.service.ts`
- `apps/api/src/statlocker-adaptive/statlocker-evidence.service.ts`
- `apps/api/src/deadlock-live/hero-build-matchup-statistics.service.ts`
- `apps/overwolf-client/src/situational-item-metadata.ts`

- [ ] Remove `ADAPTIVE_SITUATIONAL_WINDOWS_JSON` as production truth; embed windows in the versioned strategy artifact.
- [ ] Require every window to provide `windowId`, purpose, target item IDs/families, maximum items, maximum core-delay souls, and reserved slots.
- [ ] Remove `OPTIONAL -> situational` inference and all purpose inference from item names.
- [ ] Filter target heroes against the current match roster before scoring. Reject stale, cross-match, absent, or under-threshold evidence.
- [ ] Compare each allowed situational interruption against `CONTINUE_CORE`, including slot reservation, investment impact, and core-delay budget.
- [ ] Add target hysteresis so small evidence changes do not oscillate the situational target.
- [ ] Label `VS_HERO_WPA` evidence as `MATCHUP_STAT`. Require a separate mechanics source for `MECHANICAL_COUNTER` and remove any hardcoded Knockdown/Vindicta/Grey Talon rule.
- [ ] Verify ruleset/catalog/strategy-artifact identity on every situational decision and include evidence snapshot IDs in provenance.

**Gate WP7:** every situational action is allowed by the selected strategy, supported by fresh current-roster evidence, and causally labeled without mechanical overclaiming.

---

## WP8: Make Overwolf a semantic-only renderer

**Primary files:**

- `apps/overwolf-client/src/adaptive-recommendation-client.ts`
- `apps/overwolf-client/src/adaptive-recommendation-presentation.ts`
- `apps/overwolf-client/src/adaptive-transaction-plan-presentation.ts`
- `apps/overwolf-client/src/ui.ts`
- `apps/overwolf-client/scripts/generate-adaptive-item-catalog.js`
- a canonical hero-catalog generator/check script and generated output

- [ ] Add RED tests proving `ready: true` without `planActions` renders unavailable and never falls back to `recommendedBuild`.
- [ ] Render one card per `AdaptivePlanActionV1`, keyed by `planActionId`.
- [ ] Render souls, flex, shop, prerequisites, consumed upgrade components, and replacement sale as requirements inside the action card.
- [ ] Remove standalone barrier cards and item-ID deduplication. Keep distinct semantic actions involving the same item.
- [ ] Remove UI reconstruction of upgrade/buy/replace/sell mechanics from compatibility fields.
- [ ] Generate item and hero catalogs from canonical seeds and add deterministic `--check` scripts for both.
- [ ] Remove numeric production hero names. Omit or block an `Against` label when canonical name resolution fails.
- [ ] Cover unavailable, blocked, OOD, wait, replace, multi-step upgrade, duplicate-item/different-action, and complete presentations.

**Gate WP8:** the UI is a pure rendering projection of semantic actions, with no mechanics, fallback, or invented labels.

---

## WP9: Add absolute correctness gates, golden corpus, determinism, and startup validation

**Primary files:**

- `apps/api/src/statlocker-adaptive/adaptive-recommendation-observability-v1.service.ts`
- `apps/api/src/statlocker-adaptive/strategy-first-invariants-v1.ts`
- `apps/api/src/statlocker-adaptive/transaction-plan-invariants-v1.ts`
- shared release-gate contracts under `packages/shared/src/`
- golden fixtures and focused specs under `apps/api/test/` and `apps/overwolf-client/src/`
- `apps/api/src/statlocker-adaptive/statlocker-adaptive.module.ts`

- [ ] Preserve the existing replay metrics and require each to equal zero on the golden/release corpus: illegal action, projected inventory drift, selling consumed items, missed executable upgrade, unrelated replacement for upgrade, duplicate barrier card, plan/build mismatch, unsupported situational target, stale hero target, and ruleset/patch mismatch.
- [ ] Add `strategyMixingRate`, `invalidBranchSwitchRate`, `mandatoryGoalAbandonmentRate`, `unprovenCapacityPathRate`, `strategyCompletionFalsePositiveRate`, `strategyPosteriorOscillationRate`, `unknownMechanicsTransactionRate`, and `legacyFallbackInvocationRate`.
- [ ] Require zero for every correctness violation; do not accept averages near zero.
- [ ] Build golden scenarios for direct buy/upgrade, multi-step/full-slot upgrade, consumed-item protection, valid replace, divergence preservation, whole-strategy switch, branch commitment, all capacity exit types, unknown mechanics/evidence/scope, accepted/rejected situational interruption, stale roster target, repeated item across distinct actions, true completion, incomplete hold, OOD, and the Close Quarters lineage regression.
- [ ] Run identical replay inputs repeatedly and across serialization round trips. Assert the same strategy, goal, action, action ID, ordering, blockers, and response.
- [ ] Make Map/Set traversal, medoid choice, posterior ties, branch alternatives, and target ordering explicitly sorted.
- [ ] Validate all mandatory production assets during startup: exact mechanics, exact catalog mapping, generated metadata, published strategy registry, schema/JSON/SHA, item references, duplicate IDs, and scope.
- [ ] Choose one configured startup behavior: fail process startup for invalid mandatory assets, or start the endpoint in explicit not-ready mode with stable blockers. Do not defer discovery until the first live match.
- [ ] Add full provenance: ruleset, catalog SHA, artifact/strategy/session/compiler/planner/scorer/config versions, and evidence snapshot IDs.

**Gate WP9:** all zero-tolerance metrics are zero, deterministic replay is byte-stable after canonical serialization, and bad production assets are caught at startup.

---

## WP10: Delete legacy code and execute the complete local release matrix

**Deletion/audit search:**

```bash
rg -n -i "fallback|legacy|recommendedBuild|DEFAULT_RECOMMENDATION_CANDIDATE_RULES|previous plan|preserve plan|reconstruct" apps packages
```

Every hit must be classified as deleted, compatibility projection-only, offline migration-only, test fixture, or unrelated vocabulary. Compatibility and migration code must have no import/call path from the production endpoint.

- [ ] Delete the legacy planner adapter, consensus strategy fallback, serving fallback branches, stale evidence preservation, UI reconstruction, and unused promotion flags once no production imports remain.
- [ ] Remove obsolete optional fields, migration-only `any` assertions, non-exhaustive switches, dead exports, and circular dependencies.
- [ ] Verify all transport fields are readonly and JSON-serializable; convert Map/Set domain views deterministically at the boundary.
- [ ] Run `graphify update .` after code changes and use `graphify path/query` to confirm no production endpoint path reaches legacy/fallback units.
- [ ] Run `git diff --check`.
- [ ] Run focused RED/GREEN tests after each work package, then the full commands below from a clean implementation worktree.

**Local release commands:**

```bash
yarn workspace @deadlock-live-probe/shared test
yarn workspace @deadlock-live-probe/build-domain test
yarn workspace @deadlock-live-probe/api test
yarn workspace @deadlock-live-probe/api build
yarn workspace @deadlock-live-probe/overwolf-client check:item-catalog
yarn workspace @deadlock-live-probe/overwolf-client check:hero-catalog
yarn workspace @deadlock-live-probe/overwolf-client test
yarn workspace @deadlock-live-probe/overwolf-client build:bundle
yarn workspaces run lint
yarn workspaces run build
yarn workspaces run test
git diff --check
```

`check:hero-catalog` does not exist in the 2026-09-07 baseline; WP8 must add the real script before this matrix can be green.

**Manual architecture audit:** follow this exact chain and answer five questions at each boundary:

```text
live state
 -> decision state
 -> exact ruleset mechanics
 -> strategy registry
 -> strategy session
 -> build contract
 -> active goal
 -> candidate generator
 -> scorer
 -> situational arbiter
 -> canonical transition
 -> planActions
 -> response
 -> Overwolf rendering
```

Questions: Is there a legacy production path? A guessed mechanic? A reconstructed transaction? Stale state? An implicit fallback? Any yes blocks release.

**Gate WP10:** every local command has recorded passing output, the production dependency graph has no fallback path, and the manual audit has five “no” answers at every layer.

---

## WP11: Merge and deploy only after all gates are green

- [ ] Re-fetch `origin/main`, rebase the completed branch, rerun the complete local matrix, and verify no conflict reintroduced fallback behavior.
- [ ] Perform a correctness-focused code review covering API contracts, canonical mechanics, artifact validation, persisted session concurrency, determinism, and UI rendering.
- [ ] Merge only the reviewed feature commits and release evidence. Do not include unrelated dirty workspace files.
- [ ] Build the production API image for `linux/arm64`, verify its architecture and embedded revision, and retain a rollback image.
- [ ] Deploy via WSL `ssh my-vps` with the explicit `DEADLOCK_API_IMAGE`, `--no-build`, and API-only recreation. Do not recreate PostgreSQL.
- [ ] Verify container health, exact revision, `/deadlock/adaptive/v1/status` HTTP 200, and expected legacy recommendation route HTTP 404.
- [ ] Run a production smoke scenario that exercises exact scope resolution, strategy loading/session persistence, a legal semantic action, unavailable evidence fail-closed behavior, and Overwolf semantic rendering.
- [ ] Record any infrastructure failure separately from local correctness evidence. Never describe a job with no executed steps as green CI.

**Gate WP11:** the exact reviewed revision is healthy on ARM64 production, the new endpoint is the only recommendation path, rollback is available, and smoke evidence matches the release contract.

---

## Final release checklist

- [ ] Intended feature history resolved and backed up.
- [ ] Branch rebased on freshly fetched `origin/main` with zero conflicts.
- [ ] Local compile, builds, tests, catalog checks, and lint scripts green.
- [ ] No production fallback path or previous-plan substitution.
- [ ] Ready response requires semantic `planActions`; unavailable response is non-actionable.
- [ ] `recommendedBuild` is projection-only.
- [ ] Exact ruleset/catalog mechanics only; unknown mechanics produce no transaction.
- [ ] Published strategies are exact-scope and fully versioned.
- [ ] Every mandatory path, XOR alternative, and terminal variant is replay-valid.
- [ ] Strategy session is persisted, sticky, deterministic, and single-strategy.
- [ ] Divergence preserves unexpected items when a legal completion exists.
- [ ] Every future mandatory goal has a proven capacity exit.
- [ ] Flex and active capacity are evidence-bounded.
- [ ] Shop opportunity is observed or blocks the action.
- [ ] Upgrades canonically consume components and never sell unrelated items.
- [ ] Situational windows originate in the strategy artifact.
- [ ] Situational targets belong to the current roster and evidence is fresh.
- [ ] Matchup statistics are not presented as mechanical causality.
- [ ] Overwolf renders one card per semantic action and invents no hero label.
- [ ] Build completion reflects mandatory/committed terminal satisfaction only.
- [ ] Replay and strategy correctness metrics are exactly zero.
- [ ] Identical input produces identical strategy, goal, actions, IDs, order, blockers, and response.
- [ ] Startup validates every mandatory production asset.
- [ ] Manual architecture audit is clean.
- [ ] Exact ARM64 revision is healthy in production with rollback preserved.

## Execution evidence record

For each work package, append a dated entry containing:

- feature and base commit SHAs;
- focused RED command and observed failure;
- focused GREEN command and passing count;
- full commands and exit codes;
- generated artifact IDs and SHA256 values;
- zero-tolerance metric report;
- reviewer findings and resolutions;
- deployment image tag, architecture, revision, health, endpoints, and rollback tag.

Absence of recorded output means the gate is not green.
