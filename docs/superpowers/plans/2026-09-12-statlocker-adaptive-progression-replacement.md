# Statlocker Adaptive Progression and Replacement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Statlocker Adaptive preserve Statlocker-confirmed upgrade progressions, allow full-build timelines longer than 12 transactions while never holding more than 12 items, and perform sell/replacement only at 12/12 capacity using verified Statlocker lifecycle and full-team matchup evidence.

**Architecture:** Keep recommendation evidence, mechanics validation, target replacement gating, sell protection, and sell ranking as separate layers. The archetype compiler emits same-profile observed progression edges. The desired-state resolver emits an ordered goal timeline without using 12 as a lifetime goal cap. The transaction planner executes those goals, invokes replacement only for a new-slot BUY at 12/12, and delegates replacement decisions to focused services. Statlocker Item Meta Model evidence ranks eligible sell candidates, while `VS_HERO_WPA` can hard-protect items against the current enemy team. Missing or unverified mechanics/evidence fails closed instead of inventing a direct purchase or sell policy.

**Tech Stack:** TypeScript, NestJS, TypeORM, Jest, Yarn workspaces, `@deadlock-live-probe/build-domain`.

**Spec:** `docs/superpowers/specs/2026-09-12-statlocker-adaptive-progression-replacement-design.md`

## Global Constraints

- Statlocker aggregate evidence plus verified game mechanics/catalog data are the only allowed policy sources.
- Do not train or infer sell behavior from our own users, local match history, `MatchPlayer` trajectories, or `historical-build-trajectory-source-v2`.
- `MAX_HELD_ITEMS = 12` is an inventory invariant, not a build-step or lifetime family-count limit.
- The replacement algorithm must never run before inventory is full. Its trigger is exactly: `heldItems.length === 12 && nextActionRequiresNewSlot`.
- `12/12 + UPGRADE` must not invoke sell logic because the component is consumed in place.
- A Statlocker-confirmed progression must never silently collapse to a direct terminal BUY when mechanics or upgrade pricing are unavailable.
- Never synthesize a component progression from catalog ancestry alone.
- Never treat raw item `cost` as proof of direct-shop legality. Use the strict graph contract, where `directPurchaseCost` exists only for verified shopable, enabled items with known cost.
- Do not use optional `earlyWpa`, `midWpa`, `lateWpa`, `laneWpa`, or `postLaneWpa` fields for this feature; they are not present in the current real snapshots inspected for this project.
- Do not relabel median purchase time as average purchase time. The Item Meta Model source must expose and verify the actual average-purchase-time coordinate used by the Statlocker graph before lifecycle ranking is enabled.
- Matchup sell protection stays disabled until absolute WPA and minimum-confidence thresholds are calibrated from real `VS_HERO_WPA` snapshot distributions and committed as versioned configuration.
- Each task follows red-green-refactor: add the failing test first, run it and confirm the expected failure, make the smallest implementation, rerun the focused test, then run affected tests before committing.
- Do not add `| null` to TypeScript return signatures.
- Keep code comments in English.

---

## Task 1: Preserve verified upgrade-pricing policy and lock down direct-purchase semantics

**Files:**
- Modify: `apps/api/src/statlocker-adaptive/recommendation-economy-rules-store-v1.service.ts`
- Test: `apps/api/test/recommendation-economy-rules-store-v1.spec.ts`
- Test or add focused catalog coverage under the existing `packages/deadlock-build-domain` Jest test location for `recommendation-ruleset-catalog.ts`
- Reference only: `apps/api/src/statlocker-adaptive/adaptive-economy-v1.ts`
- Reference only: `packages/deadlock-build-domain/src/recommendation-ruleset-catalog.ts`

**Interfaces:**

Keep the existing domain shape:

```ts
export interface RecommendationEconomyRulesV1 {
  rulesetId: string;
  catalogSha256: string;
  baseSlots?: number;
  baseSlotsByType: Readonly<Record<InventorySlotType, number>>;
  maxFlexSlots: number;
  maxActiveItems: number;
  investmentBreakpoints: Readonly<Record<AdaptiveInvestmentTypeV1, readonly number[]>>;
  upgradePricingPolicy?: RecommendationUpgradePricingPolicyV1;
  source?: string;
}
```

`normalizeRules()` must preserve and clone `upgradePricingPolicy` and `source` rather than dropping them. Validation must reject malformed supplied policy fields with the same constraints already enforced by the environment parser: known mode, finite ratio in `[0, 1]`, and evidence of `OBSERVED` or `RECONSTRUCTED`.

Do not add a default `componentCreditRatio` to `createCanonicalEconomyRulesV1`. A missing verified source must remain missing.

The strict recommendation graph must retain the existing direct-purchase contract:

```text
item available in ruleset
AND shopable.value === true
AND disabled.value === false
AND directPurchaseCost is known
=> graph item has directPurchaseCost
```

No new direct-purchase tri-state is required unless a failing strict-catalog test proves the graph cannot distinguish this case.

- [ ] Add a store round-trip test that publishes rules with `upgradePricingPolicy` and `source`, reads the persisted payload, resolves it with `resolveExact()`, and asserts `mode`, `componentCreditRatio`, `evidence`, and `source` survive unchanged.
- [ ] Run `yarn workspace @deadlock-live-probe/api test -- test/recommendation-economy-rules-store-v1.spec.ts` and confirm the new test fails because normalization drops the policy/source.
- [ ] Extend `validateRules()` and `normalizeRules()` to preserve validated `upgradePricingPolicy` and `source` without inventing missing values.
- [ ] Rerun the focused API test and confirm it passes.
- [ ] Add a strict-catalog test proving a raw item with a cost but `shopable=false` or `disabled=true` does not receive graph `directPurchaseCost`, while a verified shopable/enabled item does.
- [ ] Run the focused build-domain catalog test and confirm the contract passes without adding a second direct-purchase model.
- [ ] Run `yarn build:domain` and the economy store test again.
- [ ] Commit with message `fix: preserve verified upgrade pricing rules`.

---

## Task 2: Compile explicit same-profile progression edges with lineage-specific timing

**Files:**
- Modify: `apps/api/src/statlocker-adaptive/build-archetype-v2.ts`
- Modify: `apps/api/src/statlocker-adaptive/build-archetype-compiler-v2.service.ts`
- Test: `apps/api/test/build-archetype-compiler-v2.spec.ts`

**Interfaces:**

Add an explicit edge to the archetype model:

```ts
export interface BuildObservedProgressionEdgeV2 {
  fromItemId: number;
  toItemId: number;
  sourceProfileCount: number;
  orderedProfileCount: number;
  orderConfidence: number;
  timing: {
    fromMedianBuyTimeS: number;
    toMedianBuyTimeS: number;
    fromSpreadS: number;
    toSpreadS: number;
  };
  evidence: 'STATLOCKER_SAME_PROFILE';
}
```

Add to `BuildArchetypeFamilyV2`:

```ts
progressionEdges?: readonly BuildObservedProgressionEdgeV2[];
```

The field is optional for persisted/replay compatibility, but newly compiled V2 archetypes always emit it.

For every catalog ancestry pair inside one family, build edge evidence only from profiles containing both exact item IDs. Reuse the existing order timing rule exactly:

```ts
from.medianBuyTimeS + STATLOCKER_BUILD_V2_CONFIG.orderTimingToleranceS < to.medianBuyTimeS
```

Profiles whose two times fall inside the tolerance are non-directional and do not count in the confidence denominator. Match existing order-edge semantics:

```ts
orderConfidence = orderedProfileCount / directionalProfileCount
```

The accepted edge must satisfy:

```ts
sourceProfileCount >= STATLOCKER_BUILD_V2_CONFIG.minOrderSourceProfiles
orderConfidence >= STATLOCKER_BUILD_V2_CONFIG.softOrderConfidence
```

The timing medians/spreads on the accepted edge come only from the same profiles that support `from -> to`; generic per-node timing is not reused for progression execution.

- [ ] Add compiler tests for two or more same profiles containing component and terminal in the correct order; assert one `STATLOCKER_SAME_PROFILE` edge is emitted with confidence and lineage-specific timing.
- [ ] Add a test where component is present only in profile A and terminal only in profile B; assert no progression edge is emitted.
- [ ] Add a test with same-profile evidence below `0.65`; assert no edge is emitted.
- [ ] Add a test where timings are within `45` seconds; assert those observations do not create directional support.
- [ ] Run `yarn workspace @deadlock-live-probe/api test -- test/build-archetype-compiler-v2.spec.ts` and confirm the new assertions fail because the model has no explicit edges.
- [ ] Implement edge compilation as a focused helper called by `compileFamily()`. Use the item graph only to validate ancestry candidates; do not add catalog-only items to the family.
- [ ] Keep `progressionNodes` for family membership/terminal semantics, but stop treating their global timing order as proof of an upgrade edge.
- [ ] Rerun the focused compiler tests and confirm they pass.
- [ ] Commit with message `feat: compile observed progression edges`.

---

## Task 3: Make progression execution edge-driven and fail closed

**Files:**
- Modify: `apps/api/src/statlocker-adaptive/full-build-transaction-planner-v2.service.ts`
- Test: `apps/api/test/full-build-transaction-planner-v2.spec.ts`
- Modify if needed for reason typing only: `apps/api/src/statlocker-adaptive/full-build-plan-v2.ts`

**Interfaces:**

Replace graph-inferred observed paths with paths composed from `family.progressionEdges` plus strict mechanics validation.

Introduce focused helpers with these responsibilities:

```ts
function findConfirmedProgressionPath(
  family: BuildArchetypeFamilyV2,
  terminalItemId: number,
  inventoryItemIds: readonly number[],
  itemGraph: RecommendationItemGraph,
  rulesetId: string,
): ConfirmedProgressionPathV2 | undefined
```

```ts
interface ConfirmedProgressionPathV2 {
  heldItemId?: number;
  path: readonly number[];
  timingByItemId: ReadonlyMap<number, number>;
}
```

A progression transition is executable only when both are true:

```text
accepted Statlocker edge exists
AND executableOneSlotRecipe(target, component, inventory, graph, rulesetId) exists
```

For a weak/unconfirmed lineage, the terminal may be a standalone entry only when `verifiedDirectPurchasable()` sees strict-graph `directPurchaseCost` for the terminal. Rename the current helper for clarity; do not infer legality from raw catalog fields inside the planner.

For a confirmed edge whose recipe is unavailable, block the chain and emit a specific reason. Do not search for a direct-terminal fallback.

Use edge-specific timing for `comparePendingProgressions()` when scheduling component and upgrade steps.

- [ ] Add a planner test where progression nodes imply ancestry but `progressionEdges` is empty; assert the component is not invented.
- [ ] Add a planner test where the terminal is strictly direct-purchasable and no accepted edge exists; assert standalone `BUY terminal` remains legal.
- [ ] Add a planner test where a confirmed edge exists but executable recipe/pricing is unavailable; assert no `BUY terminal` action is emitted and the reason includes `CONFIRMED_PROGRESSION_RECIPE_UNAVAILABLE` or `UPGRADE_PRICING_UNVERIFIED` according to the failure.
- [ ] Extend the existing interleaving test so edge timing, not global node timing, yields `BUY component`, another family BUY, then `UPGRADE terminal`.
- [ ] Run `yarn workspace @deadlock-live-probe/api test -- test/full-build-transaction-planner-v2.spec.ts` and confirm the new tests fail on the current graph-inferred path logic.
- [ ] Implement edge-driven path finding and edge-specific timing.
- [ ] Preserve the existing one-slot UPGRADE behavior at 12/12.
- [ ] Rerun the planner test file and confirm all old and new cases pass.
- [ ] Commit with message `fix: fail closed on unverified build progression`.

---

## Task 4: Convert desired state from a 12-family final set into an ordered eligible goal timeline

**Files:**
- Modify: `apps/api/src/statlocker-adaptive/build-desired-state-v2.service.ts`
- Test: `apps/api/test/build-desired-state-v2.spec.ts`
- Modify callers: `apps/api/src/statlocker-adaptive/family-first-full-build-resolver-v2.service.ts`

**Interfaces:**

Extend each desired family state with explicit goal semantics:

```ts
export type DesiredFamilyGoalKindV2 =
  | 'REQUIRED'
  | 'CHOICE_SELECTED'
  | 'OPTIONAL'
  | 'SITUATIONAL_MATCHUP_SELECTED';

export interface DesiredFamilyStateV2 {
  familyId: number;
  requirement: BuildFamilyRequirementV2 | 'CHOICE';
  goalKind: DesiredFamilyGoalKindV2;
  selectedTerminalItemId: number;
  selectedTerminalKind: 'DEFAULT_TERMINAL' | 'OPTIONAL_TERMINAL';
  groupId?: string;
  score: number;
  confidence: number;
  reasonCodes: readonly string[];
  sourceProfiles?: readonly DesiredFamilySourceProfileV2[];
}
```

Remove `totalCapacity` from `ResolveDesiredBuildStateV2Input`; inventory capacity belongs to transaction planning, not lifetime goal selection.

Goal-selection policy:

- `REQUIRED`: always include.
- `CHOICE`: include only the existing `minSelect` winners for each CHOICE group; non-selected alternatives never reappear later.
- `OPTIONAL`: include as an eligible timeline goal; it may later be skipped at 12/12 if replacement value is insufficient.
- `SITUATIONAL`: include only when current matchup support is real. Reuse existing configured evidence gates instead of introducing new numbers:
  - `confidence >= STATLOCKER_BUILD_V2_CONFIG.outsideMatchupDiscovery.minConfidence`;
  - `score >= STATLOCKER_BUILD_V2_CONFIG.outsideMatchupDiscovery.minNormalizedSupport + STATLOCKER_BUILD_V2_CONFIG.outsideMatchupDiscovery.buyMinImprovement`.

Keep output deterministic in archetype family order so the transaction planner can then interleave actual steps by progression timing.

- [ ] Add a desired-state test with more than 12 eligible REQUIRED/OPTIONAL goals and assert the resolver returns more than 12 instead of truncating at `totalCapacity`.
- [ ] Add a CHOICE test proving only `minSelect` winners become goals even though capacity no longer truncates the list.
- [ ] Add SITUATIONAL tests for insufficient confidence/support (excluded) and sufficient confidence/support (included with `SITUATIONAL_MATCHUP_SELECTED`).
- [ ] Run `yarn workspace @deadlock-live-probe/api test -- test/build-desired-state-v2.spec.ts` and confirm the >12 test fails on the current capacity slice.
- [ ] Remove the capacity throw/slice from desired-state resolution and add `goalKind`.
- [ ] Update `FamilyFirstFullBuildResolverV2Service` call sites to stop passing `totalCapacity` into desired-state resolution.
- [ ] Rerun focused desired-state tests and family-first resolver tests that compile against the changed input.
- [ ] Commit with message `refactor: model full build as ordered goals`.

---

## Task 5: Extract reusable transition-value evaluation for the replacement gate

**Files:**
- Add: `apps/api/src/statlocker-adaptive/full-build-transition-value-v2.service.ts`
- Add: `apps/api/test/full-build-transition-value-v2.spec.ts`
- Modify: `apps/api/src/statlocker-adaptive/full-build-resolver-v2.service.ts`
- Modify: `apps/api/src/statlocker-adaptive/statlocker-adaptive.module.ts`
- Reference: `apps/api/src/statlocker-adaptive/build-item-utility-v2.service.ts`

**Interfaces:**

Create a focused service so family-first replacement can reuse the same whole-inventory improvement semantics as the generic resolver instead of duplicating numbers:

```ts
export interface FullBuildTransitionValueV2Input {
  heroId: number;
  archetype: BuildArchetypeV2;
  itemGraph: RecommendationItemGraph;
  currentInventoryItemIds: readonly number[];
  resultingInventoryItemIds: readonly number[];
  currentGameTimeS: number;
  enemyHeroIds: readonly number[];
  enemyThreats: readonly EnemyThreatWeightV1[];
  vsHeroRows: readonly StatlockerVsHeroWpaAggregateSourceV1[];
}

export interface FullBuildTransitionValueV2Result {
  improvement: number;
  confidence: number;
  currentNormalized: number;
  resultingNormalized: number;
}
```

The implementation must reuse `BuildItemUtilityV2Service` and the same inventory aggregation behavior currently embedded in `FullBuildResolverV2Service.evaluateTransitions()`. Move the calculation, not the policy threshold, into the service.

Add a second pure policy helper or method:

```ts
passesReplacementImprovement(
  result: FullBuildTransitionValueV2Result,
  replacingCoreItem: boolean,
): boolean
```

It uses existing `fullBuildResolver.replacementMinImprovement` / `coreReplacementMinImprovement` and existing minimum-confidence rules. REQUIRED incoming goals can bypass the improvement threshold later, but they never bypass mechanics or protection constraints.

- [ ] Add focused tests that reproduce current generic-resolver inventory improvement and replacement threshold outcomes for normal and core replacement.
- [ ] Run the focused new test and confirm it fails before the service exists.
- [ ] Extract the inventory value computation from `FullBuildResolverV2Service` into `FullBuildTransitionValueV2Service` without changing generic resolver outcomes.
- [ ] Register the new service in `StatlockerAdaptiveModule` and inject it into `FullBuildResolverV2Service`.
- [ ] Rerun the new test plus existing full-build resolver tests and confirm no behavior drift.
- [ ] Commit with message `refactor: extract full build transition value`.

---

## Task 6: Prove the Statlocker Item Meta Model data source before enabling lifecycle ranking

**Files:**
- Add captured raw fixture: `apps/api/test/fixtures/statlocker-item-meta-model/billy.raw.json`
- Add expected manually verified fixture: `apps/api/test/fixtures/statlocker-item-meta-model/billy.expected.json`
- Modify: `apps/api/src/statlocker-adaptive/statlocker-adaptive.types.ts`
- Modify: `apps/api/src/statlocker-adaptive/statlocker-normalizer.service.ts`
- Add or extend focused normalizer test under `apps/api/test/` for `WPA_FILTERED_ITEMS`

**Hard gate:** Do not proceed to Tasks 7-12 until this task proves that the collector payload used for `WPA_FILTERED_ITEMS` corresponds to the Statlocker hero Item Meta Model values required by the spec. The proof must compare at least several item IDs against the Statlocker table/graph for the same hero and patch. If the endpoint does not expose the graph's average purchase time and general WPA, stop execution and revise the ingestion source; do not substitute median purchase time, our own history, or synthetic values.

**Interfaces:**

Add lifecycle-specific normalized fields only after the fixture proves their raw keys:

```ts
export interface StatlockerHeroItemLifecycleV1 {
  heroId: number;
  itemId: number;
  generalWpa: number;
  averagePurchaseTimeS: number;
  sampleSize?: number;
}
```

Keep this distinct from the older optional phase-WPA parser fields. If `WPA_FILTERED_ITEMS` remains the verified source, `normalizeWpaFilteredItems()` should emit or expose these explicit lifecycle facts rather than making callers interpret `StatlockerWpaItemV1.purchaseTiming.medianPurchaseSec` as average time.

- [ ] Capture the raw `/api/info/wpa-filtered-items?hero_id=6` response for the same Billy/patch view used for manual verification and commit the fixture with no credentials or user-specific data.
- [ ] Record several matching `itemId`, general WPA, and average purchase-time values from the Statlocker Item Meta Model table/page into `billy.expected.json`.
- [ ] Add a normalization contract test comparing those exact values to the raw fixture.
- [ ] Run the focused test. If the raw endpoint cannot produce the expected average purchase time and WPA, stop this implementation plan at the hard gate and identify the correct Statlocker aggregate endpoint before editing downstream ranking code.
- [ ] Once equivalence is proven, add `StatlockerHeroItemLifecycleV1` and parse the exact verified raw fields.
- [ ] Assert no feature code reads `earlyWpa`, `midWpa`, `lateWpa`, `laneWpa`, or `postLaneWpa` for replacement.
- [ ] Run the focused normalizer test and confirm the fixture contract passes.
- [ ] Commit with message `test: verify Statlocker item lifecycle source`.

---

## Task 7: Schedule and persist verified per-hero lifecycle evidence

**Files:**
- Modify: `apps/api/src/statlocker-adaptive/statlocker-refresh.service.ts`
- Modify as required by the verified Task 6 payload: `apps/api/src/statlocker-adaptive/statlocker-browser-collector.service.ts`
- Modify: `apps/api/src/statlocker-adaptive/statlocker-normalizer.service.ts`
- Add: `apps/api/src/statlocker-adaptive/statlocker-item-lifecycle-repository-v1.service.ts`
- Modify: `apps/api/src/statlocker-adaptive/statlocker-adaptive.module.ts`
- Test: add focused refresh/repository tests under `apps/api/test/`
- Reference: `apps/api/src/statlocker-adaptive/statlocker-snapshot-store.service.ts`

**Interfaces:**

```ts
export interface StatlockerItemLifecycleEvidenceV1 {
  heroId: number;
  itemId: number;
  generalWpa: number;
  averagePurchaseTimeS: number;
  sampleSize?: number;
}

@Injectable()
export class StatlockerItemLifecycleRepositoryV1Service {
  async loadCurrentPatchForHero(heroId: number): Promise<readonly StatlockerItemLifecycleEvidenceV1[]>;
}
```

Schedule the verified lifecycle dataset per hero alongside hero-scoped refresh work. Use a deterministic scope such as `hero:${heroId}` and the same current-patch snapshot identity rules used by the other Statlocker datasets.

Do not derive lifecycle values from `PRO_BUILD_ANALYSIS`; this repository represents the separate hero Item Meta Model layer.

- [ ] Add a refresh test proving each due hero receives a lifecycle dataset target in addition to the existing leaderboard/profile work.
- [ ] Run the focused refresh test and confirm it fails because `WPA_FILTERED_ITEMS` is not currently scheduled.
- [ ] Add the per-hero target and preserve current refresh rate-limits/backoff behavior.
- [ ] Add repository tests that read a persisted normalized lifecycle snapshot and return deterministic item evidence for one hero/current patch.
- [ ] Implement the repository using `StatlockerSnapshotStoreService` or the existing snapshot persistence pattern; do not create a parallel persistence mechanism.
- [ ] Register the repository in `StatlockerAdaptiveModule`.
- [ ] Rerun refresh, normalizer, and repository tests.
- [ ] Commit with message `feat: ingest Statlocker item lifecycle evidence`.

---

## Task 8: Add full-team matchup sell protection with calibration-gated configuration

**Files:**
- Add: `apps/api/src/statlocker-adaptive/full-build-matchup-protection-v1.service.ts`
- Add: `apps/api/test/full-build-matchup-protection-v1.spec.ts`
- Modify: `apps/api/src/statlocker-adaptive/statlocker-build-v2.config.ts`
- Reference: `apps/api/src/statlocker-adaptive/statlocker-vs-hero-wpa-repository-v1.service.ts`
- Reference: `apps/api/src/statlocker-adaptive/threat-weighted-matchup-v1.service.ts`

**Interfaces:**

Use a discriminated config so production cannot accidentally enable guessed thresholds:

```ts
export type SellMatchupProtectionV1Config =
  | {
      enabled: false;
      shrinkK: number;
    }
  | {
      enabled: true;
      shrinkK: number;
      minTeamWpaPct: number;
      minConfidence: number;
    };
```

Initial checked-in state for this task:

```ts
sellMatchupProtection: {
  enabled: false,
  shrinkK: 500,
}
```

`500` reuses the existing exact-enemy sample prior; it is not a new WPA threshold.

Service API:

```ts
export interface FullBuildMatchupProtectionV1Input {
  ourHeroId: number;
  itemId: number;
  enemyHeroIds: readonly number[];
  rows: readonly StatlockerVsHeroWpaAggregateSourceV1[];
}

export interface FullBuildMatchupProtectionV1Result {
  teamWpaPct: number;
  confidence: number;
  coveredEnemyHeroIds: readonly number[];
  protected: boolean;
  reasonCodes: readonly string[];
}
```

For each available enemy matchup row:

```ts
weight = count / (count + shrinkK)
teamWpaPct = sum(wpaPct * weight) / sum(weight)
```

Aggregate confidence must be bounded in `[0, 1]` and reflect full-team evidence coverage plus the bounded row confidences. Use all unique supplied enemy IDs up to five; do not apply the ordinary scorer's three-matchup cap. A single strong enemy row cannot protect the item unless the configured team aggregate threshold is satisfied after aggregation.

With `enabled=false`, calculate diagnostics but always return `protected=false` plus `MATCHUP_PROTECTION_UNCALIBRATED`.

- [ ] Add tests proving all five enemy rows participate in aggregation.
- [ ] Add a test where one enemy has huge positive WPA but the other four make the team aggregate low; assert no protection.
- [ ] Add a test proving raw `count` cannot dominate without bound because weights asymptote to `1`.
- [ ] Add a disabled-config test proving diagnostics are returned but no item is protected before calibration.
- [ ] Run the focused test and confirm it fails before the service exists.
- [ ] Implement the pure aggregation/protection service and config union.
- [ ] Rerun the focused test.
- [ ] Commit with message `feat: add team matchup sell protection`.

---

## Task 9: Implement pure Pareto-first lifecycle sell ranking

**Files:**
- Add: `apps/api/src/statlocker-adaptive/full-build-sell-ranker-v1.service.ts`
- Add: `apps/api/test/full-build-sell-ranker-v1.spec.ts`

**Interfaces:**

```ts
export interface FullBuildSellCandidateV1 {
  itemId: number;
  generalWpa: number;
  averagePurchaseTimeS: number;
}

export interface RankedFullBuildSellCandidateV1 extends FullBuildSellCandidateV1 {
  paretoFront: number;
  timeSellPercentile: number;
  wpaSellPercentile: number;
  tieBreakScore: number;
}

@Injectable()
export class FullBuildSellRankerV1Service {
  rank(
    candidates: readonly FullBuildSellCandidateV1[],
    heroDistribution: readonly StatlockerItemLifecycleEvidenceV1[],
  ): readonly RankedFullBuildSellCandidateV1[];
}
```

Dominance rule:

```text
A.averagePurchaseTimeS <= B.averagePurchaseTimeS
AND A.generalWpa <= B.generalWpa
AND at least one comparison is strict
```

Produce a deterministic total order by iterative Pareto-front peeling:

1. Front `0` contains non-dominated most-sellable candidates.
2. Remove it and compute front `1`, then continue.
3. Inside each front, sort by `tieBreakScore DESC`, then `itemId ASC`.

Percentiles use the full verified hero Item Meta Model distribution, not only the currently held 12 items:

```ts
timeSellPercentile = percentileRankDescendingSellability(averagePurchaseTimeS, earlierIsHigher)
wpaSellPercentile = percentileRankDescendingSellability(generalWpa, lowerIsHigher)
tieBreakScore = 0.5 * timeSellPercentile + 0.5 * wpaSellPercentile
```

Equal empirical values must receive equal percentile values; item ID is only the final deterministic tie-break.

- [ ] Add a Pareto test where an earlier/lower-WPA item ranks ahead of a later/higher-WPA item regardless of percentile tie-break.
- [ ] Add a trade-off test where candidates are Pareto-incomparable and 50/50 percentiles determine their order.
- [ ] Add equality/determinism tests for duplicate coordinate values and item-ID final tie-break.
- [ ] Add a test proving percentiles are computed from the hero distribution rather than only held candidates.
- [ ] Run the focused test and confirm it fails before the ranker exists.
- [ ] Implement the pure ranker with no dependency on inventory capacity or matchup data.
- [ ] Rerun the focused test.
- [ ] Commit with message `feat: add Pareto lifecycle sell ranking`.

---

## Task 10: Build the 12/12 replacement decision service

**Files:**
- Add: `apps/api/src/statlocker-adaptive/full-build-replacement-v2.service.ts`
- Add: `apps/api/test/full-build-replacement-v2.spec.ts`
- Modify: `apps/api/src/statlocker-adaptive/statlocker-adaptive.module.ts`
- Use: `apps/api/src/statlocker-adaptive/full-build-transition-value-v2.service.ts`
- Use: `apps/api/src/statlocker-adaptive/full-build-matchup-protection-v1.service.ts`
- Use: `apps/api/src/statlocker-adaptive/full-build-sell-ranker-v1.service.ts`

**Interfaces:**

```ts
export interface FullBuildReplacementContextV2 {
  heroId: number;
  currentGameTimeS: number;
  enemyHeroIds: readonly number[];
  enemyThreats: readonly EnemyThreatWeightV1[];
  vsHeroRows: readonly StatlockerVsHeroWpaAggregateSourceV1[];
  lifecycleEvidence: readonly StatlockerItemLifecycleEvidenceV1[];
}

export interface FullBuildReplacementV2Input {
  archetype: BuildArchetypeV2;
  desiredFamily: DesiredFamilyStateV2;
  buyItemId: number;
  projectedInventoryItemIds: readonly number[];
  activeProgressionProtectedItemIds: ReadonlySet<number>;
  itemGraph: RecommendationItemGraph;
  rulesetId: string;
  context: FullBuildReplacementContextV2;
}

export type FullBuildReplacementV2Result =
  | {
      kind: 'REPLACE';
      sellItemId: number;
      reasonCodes: readonly string[];
    }
  | {
      kind: 'BLOCKED';
      reasonCodes: readonly string[];
    };
```

This service is called only at 12/12 for a BUY that requires a new slot; it does not decide when to run.

Decision order:

1. Start from held items.
2. Remove items in `activeProgressionProtectedItemIds`.
3. Remove target-family dependencies and mechanics-defined unsellable items if applicable.
4. Evaluate team matchup protection; remove only items with `protected=true`. Missing matchup rows do not protect and add diagnostics.
5. Require verified lifecycle evidence for each remaining candidate. If no candidate has verified lifecycle evidence, return `BLOCKED` with `ITEM_META_EVIDENCE_MISSING`.
6. Simulate each candidate's exact `REPLACE` inventory and evaluate `FullBuildTransitionValueV2Service`.
7. Incoming `REQUIRED` / selected CHOICE mandatory goals bypass the improvement threshold but not safety/protection.
8. Incoming `OPTIONAL` / `SITUATIONAL_MATCHUP_SELECTED` goals retain only sell pairs passing the existing replacement-improvement and confidence policy.
9. Pareto-rank the remaining sell candidates and return the first one.

Historical `REQUIRED` status of the item being sold is not permanent protection. Only active plan dependencies/protections matter.

- [ ] Add a test that calling the service with an early weak item and a later stronger item ranks the early weak item for sale when both are eligible.
- [ ] Add a test where the otherwise-best sell candidate is `MATCHUP_PROTECTED`; assert another candidate is selected.
- [ ] Add a test where a held component is required for a pending confirmed upgrade; assert it cannot be sold.
- [ ] Add OPTIONAL/SITUATIONAL tests where the incoming target fails replacement improvement and returns `BLOCKED` rather than forcing churn.
- [ ] Add a REQUIRED test proving it may replace a safe historical REQUIRED item even when the value threshold is not met.
- [ ] Add a no-lifecycle-evidence test that returns `ITEM_META_EVIDENCE_MISSING` rather than guessing.
- [ ] Run the focused test and confirm it fails before the service exists.
- [ ] Implement the decision pipeline in the exact order above.
- [ ] Register the service in `StatlockerAdaptiveModule`.
- [ ] Rerun the focused replacement, sell-ranker, matchup-protection, and transition-value tests.
- [ ] Commit with message `feat: add capacity driven full build replacement`.

---

## Task 11: Integrate lifecycle replacement into the family-first planner without proactive sells

**Files:**
- Modify: `apps/api/src/statlocker-adaptive/full-build-transaction-planner-v2.service.ts`
- Modify: `apps/api/src/statlocker-adaptive/family-first-full-build-resolver-v2.service.ts`
- Modify: `apps/api/src/statlocker-adaptive/statlocker-adaptive.module.ts`
- Test: `apps/api/test/full-build-transaction-planner-v2.spec.ts`
- Add or extend family-first resolver integration tests under `apps/api/test/`

**Interfaces:**

Extend planner input with replacement context:

```ts
export interface FullBuildTransactionPlannerV2Input {
  archetype: BuildArchetypeV2;
  desiredState: DesiredBuildStateV2;
  itemGraph: RecommendationItemGraph;
  rulesetId: string;
  capacity: number;
  currentInventoryItemIds: readonly number[];
  replacementContext?: FullBuildReplacementContextV2;
}
```

Inject `FullBuildReplacementV2Service` into `FullBuildTransactionPlannerV2Service`.

`FamilyFirstFullBuildResolverV2Service` loads:

- current patch `VS_HERO_WPA` rows, as it already does;
- verified current-patch hero lifecycle evidence from `StatlockerItemLifecycleRepositoryV1Service`;
- current game time and enemy lineup from the existing resolver input.

It passes these facts to the transaction planner without letting the planner query repositories directly.

Planner trigger must stay exact:

```ts
if (next.nextIndex === 0 && projectedInventory.length === input.capacity) {
  // new-slot family entry at full capacity: replacement may run
}
```

Do not call replacement for:

```text
projectedInventory.length < capacity
UPGRADE of an already-held progression component
```

Before each replacement decision, compute `activeProgressionProtectedItemIds` from all non-blocked pending confirmed paths whose held component is still needed for a future UPGRADE.

Blocked behavior:

- REQUIRED / CHOICE mandatory goal: mark degraded/HOLD with explicit reason and keep it observable.
- OPTIONAL / SITUATIONAL goal: skip/block that goal and continue processing later eligible goals.

- [ ] Add an interaction test with `11/12 + BUY`; spy/mock replacement service and assert it is never called.
- [ ] Add an interaction test with `12/12 + UPGRADE`; assert replacement service is never called and inventory stays 12.
- [ ] Add an interaction test with `12/12 + new family BUY`; assert replacement is invoked exactly once.
- [ ] Add a test with 12 initial/accumulated held items plus a 13th eligible goal; assert the action list exceeds 12 transactions while the simulator never exceeds 12 held items.
- [ ] Add a test where a component is bought by replacement at 12/12, other actions interleave, and the component later upgrades in place.
- [ ] Run the planner and family-first resolver tests and confirm the trigger tests fail on current `findSafeReplacement()` behavior.
- [ ] Replace `findSafeReplacement()` with the new replacement service only in the 12/12 new-slot branch.
- [ ] Wire lifecycle evidence into `FamilyFirstFullBuildResolverV2Service`.
- [ ] Keep the inventory simulator as the authoritative post-action invariant check.
- [ ] Rerun focused tests and verify every projected action keeps `heldItems.length <= 12`.
- [ ] Commit with message `feat: support long capacity aware build timelines`.

---

## Task 12: Calibrate protection, add captured end-to-end regression, and run full verification

**Files:**
- Add calibration test/report fixture under `apps/api/test/fixtures/statlocker-vs-hero-wpa/` using current real Statlocker snapshot data
- Modify after calibration only: `apps/api/src/statlocker-adaptive/statlocker-build-v2.config.ts`
- Test: `apps/api/test/statlocker-build-v2-real-data.e2e.spec.ts`
- Modify/add captured build fixture under `apps/api/test/fixtures/statlocker-build-v2/`
- Modify corresponding expected golden under `apps/api/test/fixtures/statlocker-build-v2/`
- Modify any directly affected snapshots only after reviewing the semantic diff

**Calibration gate:** Production `MATCHUP_PROTECTED` remains disabled until real current-patch `VS_HERO_WPA` rows are summarized and an absolute team-WPA threshold plus minimum confidence are selected from that distribution. The commit enabling protection must include the calibration fixture/test so the numbers are reviewable. Do not invent defaults to make a test pass.

**Real-data gate:** The real-data upgrade golden must use captured Statlocker same-profile progression evidence and verified mechanics/economy pricing. Do not inject a made-up `componentCreditRatio` into the Billy fixture. If the existing Billy capture cannot prove an executable upgrade, capture a different real Statlocker profile/hero fixture that can. Until such a fixture exists, keep production upgrade execution fail-closed and do not claim the end-to-end upgrade path is verified.

- [ ] Build a deterministic calibration helper/test over captured `VS_HERO_WPA` rows that outputs reviewable team-WPA/confidence distributions for representative held items and enemy teams.
- [ ] Select and encode `minTeamWpaPct` and `minConfidence` from that captured distribution, switch `sellMatchupProtection.enabled` to `true`, and document the fixture-derived values in the test name/assertions.
- [ ] Run `yarn workspace @deadlock-live-probe/api test -- test/full-build-matchup-protection-v1.spec.ts` and the calibration test.
- [ ] Capture or identify a real Statlocker build fixture with same-profile component-before-terminal evidence that passes the accepted edge rule and has verified executable mechanics/economy pricing.
- [ ] Update the real-data e2e expected output to contain at least one `BUY component ... UPGRADE terminal` sequence rather than a direct terminal BUY.
- [ ] Add a real/captured long-timeline case whose transaction count is greater than 12 while the inventory simulator's maximum held count is exactly 12.
- [ ] Add a captured 12/12 replacement case where lifecycle evidence selects an early/low-general-WPA item, and assert a high full-team matchup score protects an otherwise sellable item when the calibrated threshold is satisfied.
- [ ] Run the real-data e2e test and review every golden change for source-backed behavior rather than snapshot churn.
- [ ] Run all focused tests touched by Tasks 1-11.
- [ ] Run `yarn workspace @deadlock-live-probe/api test`.
- [ ] Run `yarn workspace @deadlock-live-probe/api build`.
- [ ] Run the repository-level lint/typecheck command if configured by the root package scripts.
- [ ] Inspect the final diff and confirm there is no dependency on our own player histories, no use of absent phase-WPA fields, no direct-buy fallback for confirmed broken upgrades, and no transaction-count cap at 12.
- [ ] Commit with message `test: verify Statlocker adaptive progression and replacement`.

---

## Final Acceptance Checklist

- [ ] Same-profile Statlocker evidence with at least 2 source profiles and at least 0.65 directional confidence creates progression; cross-profile synthesis does not.
- [ ] Lineage-specific timing can interleave other purchases between component BUY and terminal UPGRADE.
- [ ] Confirmed progression plus unavailable mechanics/pricing fails closed and never emits direct terminal BUY.
- [ ] Verified standalone direct purchase depends on the strict graph's shopable/enabled/cost contract.
- [ ] `upgradePricingPolicy` survives store normalization, hashing, persistence, and `resolveExact()`.
- [ ] Desired goals are not truncated to 12; CHOICE alternatives do not leak into later purchases; SITUATIONAL goals require matchup evidence.
- [ ] Full-build transaction lists may exceed 12 rows while inventory never exceeds 12 held items.
- [ ] Sell/replacement is never invoked below 12 held items and is never invoked for an in-place UPGRADE at 12/12.
- [ ] OPTIONAL/SITUATIONAL replacement has a separate value-improvement gate before sell ranking; REQUIRED goals still respect hard safety/protection constraints.
- [ ] The Item Meta Model source is proven against captured Statlocker values and uses actual average purchase time, not median relabeling.
- [ ] Full-team matchup protection uses all available enemy heroes, bounded sample weights, an absolute calibrated threshold, and a minimum confidence.
- [ ] A single strong enemy matchup cannot independently veto a sell when the team aggregate is low.
- [ ] Sell ranking is Pareto-first; 50/50 empirical percentile scoring is only the deterministic tie-break within a Pareto front.
- [ ] Missing lifecycle evidence never falls back to our own player history or synthetic lifecycle heuristics.
- [ ] Historical `REQUIRED` status is not permanent hold protection; active progression/build constraints are.
- [ ] Real captured end-to-end coverage proves at least one actual upgrade and one >12-step / max-12-held timeline before production completion is claimed.
