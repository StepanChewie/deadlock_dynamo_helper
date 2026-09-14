# Statlocker Adaptive Progression and Replacement Implementation Plan

> **Implemented.** The described progression/replacement model is in the code and recorded as ADR-005 and ADR-006. Kept as the design record.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Statlocker Adaptive preserve Statlocker-confirmed upgrade progressions, allow full-build timelines longer than 12 transactions while never holding more than 12 items, and perform sell/replacement only at 12/12 capacity using verified Statlocker lifecycle and full-team matchup evidence.

**Architecture:** Keep build evidence, mechanics validation, incoming-target replacement gating, sell protection, and sell ranking as separate layers. The archetype compiler emits same-profile observed progression edges. The desired-state resolver emits an ordered goal timeline without using 12 as a lifetime goal cap. The transaction planner executes those goals, invokes replacement only for a new-slot BUY at 12/12, and delegates replacement decisions to focused services. Statlocker Item Meta Model evidence ranks eligible sell candidates, while `VS_HERO_WPA` can hard-protect items against the current enemy team. Missing or unverified mechanics/evidence fails closed instead of inventing a direct purchase or sell policy.

**Tech Stack:** TypeScript, NestJS, TypeORM, Jest, Yarn 1 workspaces, `@deadlock-live-probe/build-domain`.

**Spec:** `docs/superpowers/specs/2026-09-12-statlocker-adaptive-progression-replacement-design.md`

## Global Constraints

- Statlocker aggregate evidence plus verified game mechanics/catalog data are the only allowed policy sources.
- Do not train or infer sell behavior from our own users, local match history, `MatchPlayer` trajectories, or `historical-build-trajectory-source-v2`.
- `MAX_HELD_ITEMS = 12` is an inventory invariant, not a build-step or lifetime family-count limit.
- The replacement algorithm must never run before inventory is full. Its trigger is exactly `heldItems.length === 12 && nextActionRequiresNewSlot`.
- `12/12 + UPGRADE` must not invoke sell logic because the component is consumed in place.
- A Statlocker-confirmed progression must never silently collapse to a direct terminal BUY when mechanics or upgrade pricing are unavailable.
- Never synthesize a component progression from catalog ancestry alone.
- Never treat raw item `cost` as proof of direct-shop legality. Use the strict graph contract, where graph `directPurchaseCost` exists only for verified shopable, enabled items with known cost.
- Do not use optional `earlyWpa`, `midWpa`, `lateWpa`, `laneWpa`, or `postLaneWpa` fields for this feature; they are not present in the real snapshots inspected for this project.
- Do not relabel median purchase time as average purchase time. The Item Meta Model source must expose and verify the actual average-purchase-time coordinate used by the Statlocker graph before lifecycle ranking is enabled.
- Matchup sell protection stays disabled until absolute WPA and minimum-confidence thresholds are calibrated from real `VS_HERO_WPA` snapshot distributions and committed as versioned configuration.
- Every implementation task follows red-green-refactor: add the failing test first, run it and confirm the expected failure, make the smallest implementation, rerun the focused test, then run affected tests before committing.
- Do not add `| null` to TypeScript return signatures.
- Keep code comments in English.

## File Responsibility Map

- `apps/api/src/statlocker-adaptive/build-archetype-v2.ts` - persisted archetype contracts, including explicit observed progression edges.
- `apps/api/src/statlocker-adaptive/build-archetype-compiler-v2.service.ts` - compiles same-profile Statlocker progression evidence and lineage-specific timing.
- `apps/api/src/statlocker-adaptive/build-desired-state-v2.service.ts` - selects REQUIRED/CHOICE/OPTIONAL/SITUATIONAL goals; does not enforce lifetime inventory capacity.
- `apps/api/src/statlocker-adaptive/full-build-transaction-planner-v2.service.ts` - orders and executes BUY/UPGRADE/REPLACE actions while enforcing inventory capacity.
- `apps/api/src/statlocker-adaptive/full-build-transition-value-v2.service.ts` - reusable whole-inventory value delta used by the replacement gate.
- `apps/api/src/statlocker-adaptive/full-build-matchup-protection-v1.service.ts` - full-team `VS_HERO_WPA` sell veto.
- `apps/api/src/statlocker-adaptive/full-build-sell-ranker-v1.service.ts` - pure Pareto + percentile lifecycle ranking.
- `apps/api/src/statlocker-adaptive/full-build-replacement-v2.service.ts` - 12/12 replacement decision pipeline.
- `apps/api/src/statlocker-adaptive/statlocker-item-lifecycle-repository-v1.service.ts` - reads verified current-patch hero Item Meta Model evidence.
- `apps/api/src/statlocker-adaptive/statlocker-refresh.service.ts` - schedules hero lifecycle collection.
- `apps/api/src/statlocker-adaptive/statlocker-normalizer.service.ts` - parses only verified raw Item Meta Model fields.
- `apps/api/src/statlocker-adaptive/recommendation-economy-rules-store-v1.service.ts` - preserves verified upgrade-pricing policy through persistence.
- `packages/deadlock-build-domain/src/recommendation-ruleset-catalog.ts` - strict mechanics catalog and verified direct-purchase/upgrade executability.

---

## Task 1: Preserve verified upgrade-pricing policy and lock down direct-purchase semantics

**Files:**
- Modify: `apps/api/src/statlocker-adaptive/recommendation-economy-rules-store-v1.service.ts`
- Test: `apps/api/test/recommendation-economy-rules-store-v1.spec.ts`
- Test: `packages/deadlock-build-domain/test/recommendation-ruleset-catalog.spec.ts`
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

`normalizeRules()` must preserve and clone `upgradePricingPolicy` and `source`. `validateRules()` must reject a supplied malformed policy using the same constraints already enforced by `parseUpgradePricingPolicy()` in `adaptive-economy-v1.ts`: mode `TARGET_COST_MINUS_VERIFIED_COMPONENT_CREDIT`, finite `componentCreditRatio` in `[0, 1]`, evidence `OBSERVED | RECONSTRUCTED`, and a non-empty source after normalization.

Do not add a default `componentCreditRatio` to `createCanonicalEconomyRulesV1`. Missing verified policy remains missing.

The strict graph direct-purchase contract remains:

```text
item available in ruleset
AND shopable.value === true
AND disabled.value === false
AND directPurchaseCost evidence is known
=> graph item.directPurchaseCost exists
```

No second direct-purchase tri-state is added unless the focused strict-catalog test disproves this existing contract.

- [ ] Add a store round-trip test that publishes rules with `upgradePricingPolicy` and `source`, inspects the persisted payload, resolves it with `resolveExact()`, and asserts `mode`, `componentCreditRatio`, `evidence`, and `source` survive unchanged.
- [ ] Run `yarn workspace @deadlock-live-probe/api test -- test/recommendation-economy-rules-store-v1.spec.ts` and confirm the new test fails because current normalization drops policy/source.
- [ ] Extend `validateRules()` and `normalizeRules()` to preserve the validated policy/source without inventing missing values.
- [ ] Rerun the focused API test and confirm it passes.
- [ ] Add strict-catalog coverage proving raw cost plus `shopable=false` or `disabled=true` does not produce graph `directPurchaseCost`, while a verified shopable/enabled item with known cost does.
- [ ] Run `yarn workspace @deadlock-live-probe/build-domain test -- test/recommendation-ruleset-catalog.spec.ts` and confirm the contract passes without introducing another direct-purchase model.
- [ ] Run `yarn workspace @deadlock-live-probe/build-domain build` and the focused economy-store test once more.
- [ ] Commit with message `fix: preserve verified upgrade pricing rules`.

---

## Task 2: Compile explicit same-profile progression edges with lineage-specific timing

**Files:**
- Modify: `apps/api/src/statlocker-adaptive/build-archetype-v2.ts`
- Modify: `apps/api/src/statlocker-adaptive/build-archetype-compiler-v2.service.ts`
- Test: `apps/api/test/build-archetype-compiler-v2.spec.ts`

**Interfaces:**

Add:

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

and on `BuildArchetypeFamilyV2`:

```ts
progressionEdges?: readonly BuildObservedProgressionEdgeV2[];
```

The optional field preserves persisted/replay compatibility; newly compiled V2 archetypes always emit it.

For every catalog ancestry pair where both exact item IDs are already observed inside the same family, inspect only profiles containing both IDs. Reuse the existing directional timing rule:

```ts
from.medianBuyTimeS + STATLOCKER_BUILD_V2_CONFIG.orderTimingToleranceS < to.medianBuyTimeS
```

Observations within the 45-second tolerance are non-directional and do not enter the confidence denominator. Define:

```ts
sourceProfileCount = fromBeforeToCount + toBeforeFromCount;
orderedProfileCount = fromBeforeToCount;
orderConfidence = orderedProfileCount / sourceProfileCount;
```

Accept `from -> to` only when:

```ts
sourceProfileCount >= STATLOCKER_BUILD_V2_CONFIG.minOrderSourceProfiles
&& orderConfidence >= STATLOCKER_BUILD_V2_CONFIG.softOrderConfidence
```

The timing medians/spreads stored on the accepted edge are calculated only from the profiles counted in `fromBeforeToCount`, not from generic node observations or opposite-direction profiles.

- [ ] Add a compiler test with at least two same profiles containing component then terminal; assert a `STATLOCKER_SAME_PROFILE` edge, exact counts/confidence, and lineage-specific timing.
- [ ] Add a cross-profile test where component is only in profile A and terminal only in profile B; assert no edge.
- [ ] Add a same-profile test below `0.65` directional confidence; assert no edge.
- [ ] Add a 45-second tolerance test; assert non-directional observations do not create support or inflate the denominator.
- [ ] Run `yarn workspace @deadlock-live-probe/api test -- test/build-archetype-compiler-v2.spec.ts` and confirm the new assertions fail because explicit edges do not exist yet.
- [ ] Implement a focused `compileProgressionEdges()` helper called by `compileFamily()`. Use the item graph only to validate ancestry candidates already present in Statlocker evidence; never add catalog-only nodes.
- [ ] Keep `progressionNodes` for family membership and terminal semantics, but stop treating their global timing order as proof of an upgrade edge.
- [ ] Rerun the focused compiler tests and confirm they pass.
- [ ] Commit with message `feat: compile observed progression edges`.

---

## Task 3: Make progression execution edge-driven and fail closed

**Files:**
- Modify: `apps/api/src/statlocker-adaptive/full-build-transaction-planner-v2.service.ts`
- Test: `apps/api/test/full-build-transaction-planner-v2.spec.ts`
- Modify only if reason-code typing requires it: `apps/api/src/statlocker-adaptive/full-build-plan-v2.ts`

**Interfaces:**

Replace graph-inferred "observed" paths with paths composed from `family.progressionEdges` and validated against strict mechanics.

```ts
interface ConfirmedProgressionPathV2 {
  heldItemId?: number;
  path: readonly number[];
  timingByItemId: ReadonlyMap<number, number>;
}

function findConfirmedProgressionPath(
  family: BuildArchetypeFamilyV2,
  terminalItemId: number,
  inventoryItemIds: readonly number[],
  itemGraph: RecommendationItemGraph,
  rulesetId: string,
): ConfirmedProgressionPathV2 | undefined
```

A transition in a confirmed path is executable only when:

```text
accepted same-profile edge exists
AND executableOneSlotRecipe(target, component, current inventory, graph, rulesetId) exists
```

For weak/unconfirmed lineage, a terminal may be a standalone family entry only when a renamed `verifiedDirectPurchasable()` helper sees strict-graph `directPurchaseCost`. The planner must not inspect raw catalog `cost`/shop flags itself.

A confirmed edge with no executable strict recipe blocks that progression. Emit `CONFIRMED_PROGRESSION_RECIPE_UNAVAILABLE`. Add a more specific pricing reason only when the caller/catalog already provides enough evidence to distinguish pricing absence; do not infer a cause from an empty executable-recipe list.

- [ ] Add a test where `progressionNodes` imply ancestry but `progressionEdges` is empty; assert the component is not invented.
- [ ] Add a test where no edge is confirmed but terminal strict direct purchase is legal; assert standalone `BUY terminal`.
- [ ] Add a test with a confirmed edge but no executable recipe; assert no direct terminal BUY and reason `CONFIRMED_PROGRESSION_RECIPE_UNAVAILABLE`.
- [ ] Convert the existing interleaving test to explicit edge timing and assert `BUY component`, another family BUY, then `UPGRADE terminal`.
- [ ] Run `yarn workspace @deadlock-live-probe/api test -- test/full-build-transaction-planner-v2.spec.ts` and confirm the new tests fail on current graph-inferred path logic.
- [ ] Implement edge-driven path finding and make `comparePendingProgressions()` use `timingByItemId` from accepted edges for chain steps.
- [ ] Preserve the existing one-slot UPGRADE behavior at 12/12.
- [ ] Rerun the planner test file and confirm all old and new cases pass.
- [ ] Commit with message `fix: fail closed on unverified build progression`.

---

## Task 4: Convert desired state from a 12-family final set into an ordered eligible goal timeline

**Files:**
- Modify: `apps/api/src/statlocker-adaptive/build-desired-state-v2.service.ts`
- Test: `apps/api/test/build-desired-state-v2.spec.ts`
- Modify caller: `apps/api/src/statlocker-adaptive/family-first-full-build-resolver-v2.service.ts`

**Interfaces:**

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

Remove `totalCapacity` from `ResolveDesiredBuildStateV2Input`; capacity belongs to transaction execution, not lifetime goal selection.

Selection rules:

- REQUIRED: always include.
- CHOICE: include only existing `minSelect` winners for each CHOICE group; non-selected alternatives never reappear later.
- OPTIONAL: include as eligible timeline goals.
- SITUATIONAL: include only when `confidence >= outsideMatchupDiscovery.minConfidence` and `score >= outsideMatchupDiscovery.minNormalizedSupport`. Do not add another guessed SITUATIONAL threshold; the later replacement gate handles whether a full inventory should churn for it.

Keep returned goals deterministic in archetype family order; actual transaction interleaving still happens from progression timing in the planner.

- [ ] Add a desired-state test with more than 12 eligible REQUIRED/OPTIONAL families and assert more than 12 goals are returned.
- [ ] Add a CHOICE test proving only `minSelect` winners become goals even without a capacity slice.
- [ ] Add SITUATIONAL tests for insufficient evidence (excluded) and sufficient configured confidence/support (included as `SITUATIONAL_MATCHUP_SELECTED`).
- [ ] Run `yarn workspace @deadlock-live-probe/api test -- test/build-desired-state-v2.spec.ts` and confirm the >12 case fails on current capacity truncation.
- [ ] Remove the mandatory-capacity throw and optional capacity slice, remove `totalCapacity` from the input, and add `goalKind`.
- [ ] Update `FamilyFirstFullBuildResolverV2Service` to stop passing `totalCapacity` to desired-state resolution.
- [ ] Rerun `test/build-desired-state-v2.spec.ts` and the TypeScript build to catch all input callers.
- [ ] Commit with message `refactor: model full build as ordered goals`.

---

## Task 5: Extract reusable whole-inventory transition value for the replacement gate

**Files:**
- Add: `apps/api/src/statlocker-adaptive/full-build-transition-value-v2.service.ts`
- Add: `apps/api/test/full-build-transition-value-v2.spec.ts`
- Modify: `apps/api/src/statlocker-adaptive/full-build-resolver-v2.service.ts`
- Modify: `apps/api/src/statlocker-adaptive/statlocker-adaptive.module.ts`
- Reference: `apps/api/src/statlocker-adaptive/build-item-utility-v2.service.ts`

**Interfaces:**

Extract the current `scoreInventory()` semantics instead of creating a second utility model.

```ts
export interface FullBuildTransitionValueV2Input {
  heroId: number;
  archetype: BuildArchetypeV2;
  itemGraph: RecommendationItemGraph;
  gameTimeSec: number;
  currentInventoryItemIds: readonly number[];
  resultingInventoryItemIds: readonly number[];
  targetItemId: number;
  enemyHeroIds: readonly number[];
  enemyThreats: readonly EnemyThreatScoreV1[];
  vsHeroRows: readonly StatlockerVsHeroWpaAggregateSourceV1[];
  wpaPatchData?: StatlockerWpaPatchDataV1;
  t4Chains?: StatlockerT4ChainsV1;
  transition?: Partial<BuildTransitionCostV2>;
}

export interface FullBuildTransitionValueV2Result {
  currentState: FullBuildInventoryUtilityV2;
  resultingState: FullBuildInventoryUtilityV2;
  marginalGain: number;
  confidence: number;
}
```

`marginalGain` must use the exact existing meaning:

```ts
resultingState.total - currentState.total
```

Do not rename this to "normalized improvement"; the existing resolver thresholds are applied to this whole-inventory utility delta.

Also expose one policy helper used by both generic and family-first replacement:

```ts
function replacementImprovementThreshold(
  soldRole: BuildArchetypeRoleV2 | undefined,
): number
```

It returns `coreReplacementMinImprovement` for CORE, otherwise `replacementMinImprovement`. Keep the existing role lookup semantics based on archetype item/component/upgrade relationships.

- [ ] Add a focused test that reproduces current `FullBuildResolverV2Service` current/resulting inventory totals, marginal gain, and confidence for a known REPLACE case.
- [ ] Add threshold tests for CORE and non-CORE sold items.
- [ ] Run `yarn workspace @deadlock-live-probe/api test -- test/full-build-transition-value-v2.spec.ts` and confirm failure before the service exists.
- [ ] Move the current inventory-scoring loop from `FullBuildResolverV2Service` into `FullBuildTransitionValueV2Service` using `BuildItemUtilityV2Service.scoreItem()` with the same `gameTimeSec`, enemy, `vsHeroRows`, `wpaPatchData`, `t4Chains`, and transition-cost inputs.
- [ ] Refactor `FullBuildResolverV2Service.evaluateCandidate()` to consume the extracted service without changing accepted/rejected outcomes.
- [ ] Register the service in `StatlockerAdaptiveModule`.
- [ ] Run the new focused test plus the existing full-build resolver tests and confirm no behavior drift.
- [ ] Commit with message `refactor: extract full build transition value`.

---

## Task 6: Prove the Statlocker Item Meta Model source before enabling lifecycle ranking

**Files:**
- Add fixture: `apps/api/test/fixtures/statlocker-item-meta-model/billy.raw.json`
- Add fixture: `apps/api/test/fixtures/statlocker-item-meta-model/billy.expected.json`
- Modify: `apps/api/src/statlocker-adaptive/statlocker-adaptive.types.ts`
- Modify: `apps/api/src/statlocker-adaptive/statlocker-normalizer.service.ts`
- Add test: `apps/api/test/statlocker-item-meta-model-normalizer.spec.ts`

**Hard gate:** Do not start Tasks 7-12 until this task proves that the aggregate payload used for lifecycle ingestion corresponds to the Statlocker hero Item Meta Model values required by the spec. The proof compares several item IDs against the same hero and patch shown in the Statlocker Item Meta Model table/graph. If `/api/info/wpa-filtered-items?hero_id=6` does not expose both the graph's general WPA and actual average purchase time, stop at this gate and identify the correct Statlocker aggregate endpoint. Do not substitute median purchase time, our own history, or synthetic values.

**Interface after the raw keys are verified:**

```ts
export interface StatlockerHeroItemLifecycleV1 {
  heroId: number;
  itemId: number;
  generalWpa: number;
  averagePurchaseTimeS: number;
  sampleSize?: number;
}
```

This interface is distinct from existing optional phase-WPA parser fields.

- [ ] Capture the raw `/api/info/wpa-filtered-items?hero_id=6` response for the exact Billy/patch view being manually verified and save it with no credentials/user data.
- [ ] Record at least five matching `itemId`, general WPA, and average purchase-time values from the Statlocker Item Meta Model table/page in `billy.expected.json`.
- [ ] Add `statlocker-item-meta-model-normalizer.spec.ts` asserting those exact expected values can be obtained from the raw fixture.
- [ ] Run `yarn workspace @deadlock-live-probe/api test -- test/statlocker-item-meta-model-normalizer.spec.ts`. If the payload cannot produce actual average purchase time and general WPA, stop the implementation at this hard gate.
- [ ] After equivalence is proven, add `StatlockerHeroItemLifecycleV1` and parse the exact verified raw keys in `StatlockerNormalizerService`.
- [ ] Add a regression assertion that lifecycle normalization does not read `earlyWpa`, `midWpa`, `lateWpa`, `laneWpa`, or `postLaneWpa`.
- [ ] Rerun the focused normalizer test and confirm the captured contract passes.
- [ ] Commit with message `test: verify Statlocker item lifecycle source`.

---

## Task 7: Schedule and persist verified per-hero lifecycle evidence

**Files:**
- Modify: `apps/api/src/statlocker-adaptive/statlocker-refresh.service.ts`
- Modify if Task 6 proves the current collector endpoint: `apps/api/src/statlocker-adaptive/statlocker-browser-collector.service.ts`
- Modify: `apps/api/src/statlocker-adaptive/statlocker-normalizer.service.ts`
- Add: `apps/api/src/statlocker-adaptive/statlocker-item-lifecycle-repository-v1.service.ts`
- Modify: `apps/api/src/statlocker-adaptive/statlocker-adaptive.module.ts`
- Add test: `apps/api/test/statlocker-item-lifecycle-refresh.spec.ts`
- Add test: `apps/api/test/statlocker-item-lifecycle-repository-v1.spec.ts`
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
  async loadCurrentPatchForHero(
    heroId: number,
  ): Promise<readonly StatlockerItemLifecycleEvidenceV1[]>;
}
```

Schedule the verified lifecycle dataset once per due hero with deterministic hero scope, using the same current-patch snapshot identity/backoff patterns as existing Statlocker datasets. Do not derive these values from `PRO_BUILD_ANALYSIS`.

- [ ] Add `statlocker-item-lifecycle-refresh.spec.ts` proving a due hero receives one lifecycle collection target and that existing global/profile targets are unchanged.
- [ ] Run that focused test and confirm it fails because `WPA_FILTERED_ITEMS` is not currently scheduled per hero.
- [ ] Add the hero-scoped target using the endpoint/dataset proven in Task 6 and preserve current refresh rate limiting/backoff.
- [ ] Add repository tests that persist a normalized lifecycle snapshot and read deterministic current-patch evidence for one hero.
- [ ] Implement the repository on top of `StatlockerSnapshotStoreService`; do not create parallel storage.
- [ ] Register the repository in `StatlockerAdaptiveModule`.
- [ ] Run both new test files plus the Task 6 normalizer test.
- [ ] Commit with message `feat: ingest Statlocker item lifecycle evidence`.

---

## Task 8: Add full-team matchup sell protection with calibration-gated configuration

**Files:**
- Add: `apps/api/src/statlocker-adaptive/full-build-matchup-protection-v1.service.ts`
- Add: `apps/api/test/full-build-matchup-protection-v1.spec.ts`
- Modify: `apps/api/src/statlocker-adaptive/statlocker-build-v2.config.ts`
- Reference: `apps/api/src/statlocker-adaptive/statlocker-vs-hero-wpa-repository-v1.service.ts`

**Interfaces:**

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

Initial checked-in state:

```ts
sellMatchupProtection: {
  enabled: false,
  shrinkK: 500,
}
```

`500` reuses the existing exact-enemy sample prior; it is not a guessed protection threshold.

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

Use unique enemy IDs, maximum five. For each available row:

```ts
rowWeight = count / (count + shrinkK);
teamWpaPct = sum(wpaPct * rowWeight) / sum(rowWeight);
coverage = coveredEnemyHeroIds.length / requestedEnemyHeroIds.length;
meanEvidenceStrength = sum(rowWeight) / coveredEnemyHeroIds.length;
confidence = coverage * meanEvidenceStrength;
```

If there are no requested enemies or no covered rows, return zero confidence and no protection. This confidence is bounded `[0, 1]`; raw sample counts never become unbounded weights.

With `enabled=false`, calculate diagnostics but always return `protected=false` and `MATCHUP_PROTECTION_UNCALIBRATED`.

- [ ] Add a test proving all five available enemy rows participate; no three-matchup cap applies.
- [ ] Add a test where one enemy has huge positive WPA but four others pull the weighted team aggregate below threshold; assert no protection when using an enabled test config.
- [ ] Add a test proving counts 10,000 and 1,000,000 have weights that both remain below/equal to 1 and cannot differ by raw-count scale.
- [ ] Add a missing-coverage test for the exact confidence formula above.
- [ ] Add a disabled-config test proving diagnostics are returned but `protected=false` before calibration.
- [ ] Run `yarn workspace @deadlock-live-probe/api test -- test/full-build-matchup-protection-v1.spec.ts` and confirm failure before the service exists.
- [ ] Implement the pure aggregation/protection service and discriminated config.
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

Dominance:

```text
A.averagePurchaseTimeS <= B.averagePurchaseTimeS
AND A.generalWpa <= B.generalWpa
AND at least one comparison is strict
```

Build a deterministic total order by iterative Pareto-front peeling. Front `0` contains the non-dominated most-sellable candidates. Remove it, compute front `1`, and continue. Lower front number always ranks first.

Percentiles use the full verified hero distribution, not only held candidates. For either coordinate, lower raw values are more sellable. Sort the full coordinate vector ascending. For candidate value `v`, compute the tie-aware zero-based midrank of all equal values. Then:

```ts
sellPercentile = values.length <= 1
  ? 0.5
  : 1 - midrank / (values.length - 1);
```

Thus the earliest/lowest-WPA observation is 1, the latest/highest-WPA is 0, and equal raw values receive equal percentiles.

```ts
tieBreakScore = 0.5 * timeSellPercentile + 0.5 * wpaSellPercentile;
```

Inside one Pareto front, sort `tieBreakScore DESC`, then `itemId ASC`.

- [ ] Add a dominance test where an earlier/lower-WPA item ranks ahead of a later/higher-WPA item regardless of tie-break.
- [ ] Add a trade-off test where two candidates are Pareto-incomparable and 50/50 percentiles decide order.
- [ ] Add duplicate-value tests proving equal raw coordinates receive equal percentiles and item ID is the final deterministic tie-break.
- [ ] Add a test proving percentiles use the full hero distribution rather than the held subset.
- [ ] Run `yarn workspace @deadlock-live-probe/api test -- test/full-build-sell-ranker-v1.spec.ts` and confirm failure before the ranker exists.
- [ ] Implement the pure ranker with no inventory-capacity, matchup, or repository dependency.
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
  gameTimeSec: number;
  enemyHeroIds: readonly number[];
  enemyThreats: readonly EnemyThreatScoreV1[];
  vsHeroRows: readonly StatlockerVsHeroWpaAggregateSourceV1[];
  wpaPatchData?: StatlockerWpaPatchDataV1;
  t4Chains?: StatlockerT4ChainsV1;
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

This service is called only for a new-slot BUY after the planner has established 12/12. It never decides when replacement begins.

Decision order:

1. Start from held items.
2. Remove `activeProgressionProtectedItemIds`.
3. Remove held items that are dependencies of the target progression currently being executed.
4. Apply mechanics sellability only if a verified catalog sellability fact exists. The current catalog has no separate sellability fact, so do not invent one and do not add a filter until such evidence exists.
5. Evaluate team matchup protection. Remove only candidates with `protected=true`. Missing rows do not protect; retain diagnostics.
6. Join remaining candidates to verified lifecycle evidence. If no candidate has lifecycle evidence, return `BLOCKED` with `ITEM_META_EVIDENCE_MISSING`.
7. For every surviving sell item, simulate the exact REPLACE result and call `FullBuildTransitionValueV2Service`.
8. REQUIRED and selected CHOICE mandatory incoming goals bypass the marginal-gain threshold, but never bypass active-progression or matchup protection.
9. OPTIONAL/SITUATIONAL incoming goals retain only candidate pairs whose marginal gain is at least `replacementImprovementThreshold(soldRole)`. Require resulting transition confidence at least `outsideMatchupDiscovery.replacementMinConfidence`.
10. Pareto-rank the surviving sell candidates using the full hero lifecycle distribution and return the first.

Historical REQUIRED status of the held item is not permanent protection.

- [ ] Add a test where two eligible held items exist and lifecycle ranking chooses the earlier/lower-WPA one.
- [ ] Add a test where that candidate is `MATCHUP_PROTECTED`; assert the next safe candidate is selected.
- [ ] Add a test where a held component is needed by another pending confirmed upgrade; assert it cannot be sold.
- [ ] Add OPTIONAL and SITUATIONAL tests where no candidate pair clears replacement gain/confidence; assert `BLOCKED` instead of forced churn.
- [ ] Add a REQUIRED test proving a safe historical REQUIRED held item may be sold even when its pair does not clear the optional gain threshold.
- [ ] Add a no-lifecycle-evidence test returning `ITEM_META_EVIDENCE_MISSING`.
- [ ] Run `yarn workspace @deadlock-live-probe/api test -- test/full-build-replacement-v2.spec.ts` and confirm failure before the service exists.
- [ ] Implement the decision pipeline in the exact order above and register the service in `StatlockerAdaptiveModule`.
- [ ] Run replacement, transition-value, matchup-protection, and sell-ranker focused tests.
- [ ] Commit with message `feat: add capacity driven full build replacement`.

---

## Task 11: Integrate lifecycle replacement into the family-first planner without proactive sells

**Files:**
- Modify: `apps/api/src/statlocker-adaptive/full-build-transaction-planner-v2.service.ts`
- Modify: `apps/api/src/statlocker-adaptive/family-first-full-build-resolver-v2.service.ts`
- Modify: `apps/api/src/statlocker-adaptive/statlocker-adaptive.module.ts`
- Test: `apps/api/test/full-build-transaction-planner-v2.spec.ts`
- Add integration test: `apps/api/test/family-first-full-build-resolver-v2.spec.ts`

**Interfaces:**

Extend planner input:

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

`FamilyFirstFullBuildResolverV2Service` loads current-patch `VS_HERO_WPA` as today plus verified current-patch lifecycle evidence from `StatlockerItemLifecycleRepositoryV1Service`, then passes all facts to the planner. The planner must not query repositories.

Exact trigger:

```ts
if (
  next.nextIndex === 0
  && projectedInventory.length === input.capacity
) {
  // New family-entry BUY at full capacity: replacement may run.
}
```

Never invoke replacement when `projectedInventory.length < capacity` or for an UPGRADE of an already-held component.

Before a replacement call, derive `activeProgressionProtectedItemIds` from every non-blocked pending path whose currently held node is required for a future accepted edge/UPGRADE.

Blocked policy:

- REQUIRED/CHOICE_SELECTED incoming goal: leave it unexecuted, add degraded/HOLD reason such as `CAPACITY_BLOCKED_NO_SAFE_REPLACEMENT`, and continue only where later actions are independent.
- OPTIONAL/SITUATIONAL_MATCHUP_SELECTED: skip/block that goal and continue later independent goals.

- [ ] Add a planner interaction test for `11/12 + BUY`; spy/mock replacement and assert zero calls.
- [ ] Add a planner interaction test for `12/12 + UPGRADE`; assert zero replacement calls and inventory remains 12.
- [ ] Add a planner interaction test for `12/12 + new family BUY`; assert exactly one replacement call.
- [ ] Add a planner test with a 13th eligible goal; assert transaction count can exceed 12 and simulate every prefix to prove held count never exceeds 12.
- [ ] Add a planner test where at 12/12 a component is introduced via REPLACE, unrelated transactions interleave, then that component upgrades in place without another sell.
- [ ] Add `family-first-full-build-resolver-v2.spec.ts` proving resolver lifecycle evidence is passed into the planner and repository access remains outside the planner.
- [ ] Run both focused test files and confirm current `findSafeReplacement()` behavior fails the trigger/delegation assertions.
- [ ] Replace `findSafeReplacement()` with the new replacement service only in the exact full-capacity family-entry branch.
- [ ] Wire lifecycle evidence through `FamilyFirstFullBuildResolverV2Service`.
- [ ] Rerun both focused test files and verify inventory prefix invariants.
- [ ] Commit with message `feat: support long capacity aware build timelines`.

---

## Task 12: Calibrate protection, add captured end-to-end regressions, and run full verification

**Files:**
- Add fixture: `apps/api/test/fixtures/statlocker-vs-hero-wpa/sell-protection-calibration.json`
- Add test: `apps/api/test/full-build-matchup-protection-calibration.spec.ts`
- Modify after calibration only: `apps/api/src/statlocker-adaptive/statlocker-build-v2.config.ts`
- Test: `apps/api/test/statlocker-build-v2-real-data.e2e.spec.ts`
- Modify/add captured fixture: `apps/api/test/fixtures/statlocker-build-v2/billy-real.fixture.json` only if it genuinely contains the required evidence; otherwise add a new real captured fixture under the same directory with an explicit hero/profile name.
- Modify/add matching expected golden under `apps/api/test/fixtures/statlocker-build-v2/`.

**Calibration gate:** Production `MATCHUP_PROTECTED` remains disabled until current-patch captured `VS_HERO_WPA` rows produce a reviewable distribution and an absolute `minTeamWpaPct` plus `minConfidence` are selected from that distribution. The commit enabling protection must contain the calibration fixture and assertions. Do not invent defaults to make tests pass.

**Real-data gate:** A real-data upgrade golden must use captured same-profile component-before-terminal Statlocker evidence plus verified executable mechanics/economy pricing. Do not inject a made-up `componentCreditRatio` into Billy or another fixture. If no current capture proves both sides, keep production progression fail-closed and do not claim end-to-end upgrade verification complete.

- [ ] Add `sell-protection-calibration.json` from current real Statlocker aggregate rows with no user-specific data.
- [ ] Add `full-build-matchup-protection-calibration.spec.ts` that computes deterministic team WPA/confidence distributions for representative items/lineups and asserts the selected absolute threshold/min-confidence against the captured distribution.
- [ ] After reviewing that distribution, encode `minTeamWpaPct` and `minConfidence`, set `sellMatchupProtection.enabled=true`, and run both matchup-protection test files.
- [ ] Identify/capture a real Statlocker build fixture with same-profile component-before-terminal support meeting `>=2` profiles and `>=0.65` confidence plus verified executable upgrade pricing.
- [ ] Update/add the real-data expected output to contain at least one `BUY component ... UPGRADE terminal` sequence and explicitly assert there is no direct terminal BUY fallback.
- [ ] Add a captured long-timeline case with more than 12 transactions and assert the inventory simulator maximum held count is exactly 12.
- [ ] Add a captured 12/12 replacement case where lifecycle evidence selects an early/low-WPA item while a high calibrated full-team matchup score protects another otherwise-sellable item.
- [ ] Run every focused test introduced or modified by Tasks 1-11.
- [ ] Run `yarn workspace @deadlock-live-probe/api test`.
- [ ] Run `yarn workspace @deadlock-live-probe/api build`.
- [ ] Run `yarn workspace @deadlock-live-probe/build-domain test`.
- [ ] Run `yarn lint` from the repository root.
- [ ] Inspect the final diff and confirm there is no own-player-history dependency, no use of absent phase-WPA fields, no confirmed-upgrade direct-BUY fallback, no proactive sell below 12/12, and no transaction-count cap at 12.
- [ ] Commit with message `test: verify Statlocker adaptive progression and replacement`.

---

## Final Acceptance Checklist

- [ ] Same-profile Statlocker evidence with at least 2 directional source profiles and at least 0.65 confidence creates progression; cross-profile synthesis does not.
- [ ] Lineage-specific timing can interleave other purchases between component BUY and terminal UPGRADE.
- [ ] Confirmed progression plus unavailable mechanics/pricing fails closed and never emits direct terminal BUY.
- [ ] Verified standalone direct purchase depends on the strict graph's shopable/enabled/cost contract.
- [ ] `upgradePricingPolicy` survives validation, normalization, hashing, persistence, and `resolveExact()`.
- [ ] Desired goals are not truncated to 12; CHOICE alternatives do not leak into later purchases; SITUATIONAL goals require configured matchup evidence.
- [ ] Full-build transaction lists may exceed 12 rows while inventory never exceeds 12 held items.
- [ ] Sell/replacement is never invoked below 12 held items and never invoked for an in-place UPGRADE at 12/12.
- [ ] OPTIONAL/SITUATIONAL replacement has a separate whole-inventory marginal-gain/confidence gate before sell ranking; REQUIRED/CHOICE mandatory goals still respect hard protections.
- [ ] The lifecycle source is proven against captured Statlocker values and uses actual average purchase time, not median relabeling.
- [ ] Full-team matchup protection uses all available enemy heroes up to five, bounded sample weights, an absolute calibrated threshold, and minimum confidence.
- [ ] A single strong enemy matchup cannot independently veto a sell when the team aggregate is low.
- [ ] Sell ranking is Pareto-first; 50/50 empirical percentile scoring is only the deterministic tie-break inside one Pareto front.
- [ ] Missing lifecycle evidence never falls back to our own player history or synthetic lifecycle heuristics.
- [ ] Historical REQUIRED status is not permanent hold protection; active progression/build constraints are.
- [ ] Real captured end-to-end coverage proves at least one actual upgrade and one >12-step/max-12-held timeline before production completion is claimed.
