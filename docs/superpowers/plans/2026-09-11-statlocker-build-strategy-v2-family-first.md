# Statlocker Build Strategy V2 Family-First Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Correct the V2 lifetime-build semantics so Statlocker upgrade families produce coherent final-state goals and BUY/UPGRADE/REPLACE trajectories, rerun and human-review the frozen Billy full-pipeline E2E, then finish the original V2 production cutover and release gates.

**Architecture:** Keep the already-built V2 sourcing, mining, immutable archetype lock, WPA, trace/debugger, fixture, and API infrastructure. Replace flat item goals with family-first archetypes, select a desired terminal state before generating transactions, recompute family satisfaction from projected inventory, and validate both mechanics and semantics. After the corrected Billy result is approved, resume the original Task 18 Overwolf cutover/V1 retirement and Task 19 production-readiness verification.

**Tech Stack:** TypeScript 5.9, NestJS 11, Jest/ts-jest, TypeORM/PostgreSQL, existing `@deadlock-live-probe/build-domain` item graph, existing Statlocker snapshot/WPA storage, existing V2 trace/debugger, existing Overwolf client.

**Spec:** `docs/superpowers/specs/2026-09-11-statlocker-build-strategy-v2-family-first-design.md`

## Global Constraints

- Strategic build evidence is Statlocker-only. The live request supplies runtime context, not build evidence.
- Continue using the frozen Billy fixture/request already checked into `apps/api/test/fixtures/statlocker-build-v2/`.
- The catalog/item graph is mechanics authority only: upgrade ancestry, recipes, direct-purchase legality, ruleset legality, max copies, and capacity.
- A catalog-only descendant with no Statlocker strategic evidence cannot become a strategic terminal.
- Keep raw Statlocker frequency (`CORE/FREQUENT/SOMETIMES/FLEX`), family requirement (`REQUIRED/CHOICE/OPTIONAL/SITUATIONAL`), and progression role (`ENTRY/INTERMEDIATE/DEFAULT_TERMINAL/OPTIONAL_TERMINAL`) separate.
- `frequencyTier === CORE` alone never means an independent final slot requirement.
- A semantic upgrade family is one final-slot concept even when several tiers are common in Statlocker.
- For normal Deadlock lineage progression, `UPGRADE C -> D` atomically consumes C and obtains D; 12/12 stays 12/12.
- Do not implement multi-held-component strategic progression such as `C + X -> D` for this V2 family planner.
- Family satisfaction is derived from current projected inventory, never sticky historical ownership.
- REQUIRED family satisfaction cannot regress inside one generated lifetime plan.
- `BUY X -> REPLACE X -> Y` inside one generated plan is invalid unless X is consumed by a legal upgrade; the first family-first version does not invent temporary-item semantics.
- Missing optional WPA/T4 evidence degrades adaptation but must not erase the Statlocker-backed base build.
- Do not reintroduce V1 positional planning as fallback.
- Do not freeze `billy-real.expected.json` until the corrected actual report is shown to and approved by the user.
- Follow project style: TypeScript, English code comments and Swagger descriptions, regular hyphen characters, no `| null` in function return types.

---

## File Structure

### Domain/compiler responsibilities

**Modify:**
- `apps/api/src/statlocker-adaptive/build-archetype-v2.ts` - family-first domain contracts.
- `apps/api/src/statlocker-adaptive/build-archetype-compiler-v2.service.ts` - compile observed item lineages into families, terminals, family groups, and family order/relationships.
- `apps/api/src/statlocker-adaptive/statlocker-build-profile-v2.ts` - keep deterministic family canonicalization and raw Statlocker evidence.
- `apps/api/src/statlocker-adaptive/statlocker-build-v2.config.ts` - centralized family/terminal/optional-upgrade policy.

### Validation/selection responsibilities

**Create:**
- `apps/api/src/statlocker-adaptive/build-family-satisfaction-v2.ts` - pure current-inventory family satisfaction.
- `apps/api/src/statlocker-adaptive/build-desired-state-v2.service.ts` - CHOICE/default/optional terminal selection and desired final family state.
- `apps/api/src/statlocker-adaptive/full-build-semantic-validator-v2.service.ts` - family regression, final satisfaction, choice bounds, and anti-churn validation.
- `apps/api/src/statlocker-adaptive/full-build-transaction-planner-v2.service.ts` - family-aware BUY/UPGRADE/REPLACE transaction planning.

**Modify:**
- `apps/api/src/statlocker-adaptive/build-archetype-quality-gate-v2.service.ts` - family/terminal validation and `TERMINAL_CAPACITY_CONFLICT`.
- `apps/api/src/statlocker-adaptive/build-archetype-selector-v2.service.ts` - score family/default-terminal units and family CHOICE alternatives instead of flat items.
- `apps/api/src/statlocker-adaptive/build-item-utility-v2.service.ts` - preserve item utility as the terminal/transition scorer; add no catalog-derived strategic priors.
- `apps/api/src/statlocker-adaptive/full-build-resolver-v2.service.ts` - become orchestration facade over desired-state selection, transaction planner, simulator, semantic validator, and hysteresis.
- `apps/api/src/statlocker-adaptive/full-build-plan-v2.ts` - expose semantic validation/desired-state summaries needed by trace/API.
- `apps/api/src/statlocker-adaptive/full-build-inventory-simulator-v2.ts` - keep mechanics authority; add regression for 12/12 one-slot upgrades if needed, not new strategic policy.

### Runtime/trace/API responsibilities

**Modify:**
- `apps/api/src/statlocker-adaptive/adaptive-recommendation-v2.service.ts`
- `apps/api/src/statlocker-adaptive/build-decision-trace-v2.ts`
- `apps/api/src/statlocker-adaptive/build-debug-trace-store-v2.service.ts` only if the typed trace shape requires storage changes.
- `apps/api/src/build-debug-v2/build-debug-v2.client.ts`
- `apps/api/src/build-debug-v2/build-debug-v2.ui.ts`
- `packages/shared/src/adaptive-recommendation-v2.ts`

### Tests

**Create:**
- `apps/api/test/build-family-satisfaction-v2.spec.ts`
- `apps/api/test/build-desired-state-v2.spec.ts`
- `apps/api/test/full-build-semantic-validator-v2.spec.ts`
- `apps/api/test/full-build-transaction-planner-v2.spec.ts`

**Modify/replace:**
- `apps/api/test/build-archetype-compiler-v2.spec.ts`
- `apps/api/test/build-archetype-quality-gate-v2.spec.ts`
- `apps/api/test/build-archetype-selector-v2.spec.ts`
- `apps/api/test/full-build-inventory-simulator-v2.spec.ts`
- `apps/api/test/full-build-resolver-v2.spec.ts`
- `apps/api/test/full-build-resolver-v2-lifetime.spec.ts`
- `apps/api/test/full-build-resolver-v2-replacement.spec.ts`
- `apps/api/test/full-build-lifetime-ranked-fallback-v2.spec.ts`
- Replace the old semantic expectation in `apps/api/test/full-build-lifetime-mandatory-core-v2.spec.ts`; rename/delete that file when the replacement regressions cover its mechanics.
- `apps/api/test/adaptive-recommendation-v2.e2e.spec.ts`
- `apps/api/test/build-debug-v2.e2e.spec.ts`
- `apps/api/test/statlocker-build-v2-real-data.e2e.spec.ts`

### Original roadmap continuation

**Modify after corrected Billy approval:**
- `apps/overwolf-client/src/adaptive-recommendation-client.ts`
- `apps/overwolf-client/src/adaptive-recommendation-client.spec.ts`
- `apps/overwolf-client/src/adaptive-recommendation-full-build-client.integration.spec.ts`
- `apps/overwolf-client/src/adaptive-recommendation-full-build-path.spec.ts`
- `apps/api/src/statlocker-adaptive/statlocker-adaptive.module.ts`
- V1 production-serving registration/controller files only as required to remove V1 runtime fallback authority.

---

### Task 1: Replace flat archetype items with family-first semantic contracts and compilation

**Files:**
- Modify: `apps/api/src/statlocker-adaptive/build-archetype-v2.ts`
- Modify: `apps/api/src/statlocker-adaptive/build-archetype-compiler-v2.service.ts`
- Modify: `apps/api/src/statlocker-adaptive/statlocker-build-profile-v2.ts`
- Modify: `apps/api/test/build-archetype-compiler-v2.spec.ts`
- Modify: `apps/api/test/statlocker-build-profile-v2.spec.ts`

**Interfaces:**
- Consumes: existing `StatlockerBuildProfileV2`, `RecommendationItemGraph`, cluster identity/quality.
- Produces: `BuildArchetypeFamilyV2`, `BuildProgressionNodeV2`, `BuildTerminalCandidateV2`, family-level `BuildArchetypeGroupV2`, and family-level order/relationship contracts inside `BuildArchetypeV2`.

- [ ] **Step 1: Write the failing compiler regression that collapses one upgrade lineage into one family**

Add a graph with `A -> B -> C` and profiles where A/B/C have different raw tiers. Assert one family, all three observed nodes, and one final-slot family concept:

```ts
const compiled = compiler.compile(inputForProfiles([
  profile('p1', [
    profileItem(A, { frequencyTier: 'CORE', medianBuyTimeS: 300 }),
    profileItem(B, { frequencyTier: 'CORE', medianBuyTimeS: 700 }),
    profileItem(C, { frequencyTier: 'FREQUENT', medianBuyTimeS: 1200 }),
  ]),
  profile('p2', [
    profileItem(A, { frequencyTier: 'CORE', medianBuyTimeS: 320 }),
    profileItem(B, { frequencyTier: 'CORE', medianBuyTimeS: 720 }),
    profileItem(C, { frequencyTier: 'FREQUENT', medianBuyTimeS: 1180 }),
  ]),
]));

expect(compiled.families).toHaveLength(1);
expect(compiled.families[0].progressionNodes.map((node) => node.itemId)).toEqual([A, B, C]);
expect(compiled.families[0].progressionNodes.map((node) => node.progressionRole)).toEqual([
  'ENTRY', 'INTERMEDIATE', 'DEFAULT_TERMINAL',
]);
```

- [ ] **Step 2: Write the failing rare-descendant and catalog-only-descendant regressions**

Use `A -> B -> C -> D`. In the first case D is present with raw `SOMETIMES`/`FLEX` evidence and C is the deepest observed `CORE/FREQUENT` node; assert C default and D optional. In the second case omit D from every Statlocker profile; assert D does not appear in `terminalCandidates`.

```ts
expect(family.terminalCandidates).toEqual(expect.arrayContaining([
  expect.objectContaining({ itemId: C, kind: 'DEFAULT_TERMINAL' }),
  expect.objectContaining({ itemId: D, kind: 'OPTIONAL_TERMINAL' }),
]));
expect(catalogOnlyFamily.terminalCandidates.some((entry) => entry.itemId === D)).toBe(false);
```

- [ ] **Step 3: Run the compiler/profile tests and verify RED**

Run:

```bash
yarn workspace @deadlock-live-probe/api test --runTestsByPath test/statlocker-build-profile-v2.spec.ts test/build-archetype-compiler-v2.spec.ts
```

Expected: FAIL because current `BuildArchetypeV2` exposes one representative `items[]` row per family and has no progression/terminal contracts.

- [ ] **Step 4: Add the family-first domain contracts**

Define these stable semantics in `build-archetype-v2.ts`:

```ts
export type BuildFamilyRequirementV2 = 'REQUIRED' | 'OPTIONAL' | 'SITUATIONAL';
export type BuildProgressionRoleV2 =
  | 'ENTRY'
  | 'INTERMEDIATE'
  | 'DEFAULT_TERMINAL'
  | 'OPTIONAL_TERMINAL';

export interface BuildProgressionNodeV2 {
  itemId: number;
  rawFrequencyTier: StatlockerFrequencyTierV1;
  progressionRole: BuildProgressionRoleV2;
  sourceProfileCount: number;
  profileCoverage: number;
  purchaseRate: number;
  timing: {
    medianBuyTimeS: number;
    spreadS: number;
    phase: BuildPhaseV2;
  };
}

export interface BuildTerminalCandidateV2 {
  itemId: number;
  kind: 'DEFAULT_TERMINAL' | 'OPTIONAL_TERMINAL';
  sourceProfileCount: number;
  profileCoverage: number;
  purchaseRate: number;
  rawFrequencyTier: StatlockerFrequencyTierV1;
}

export interface BuildArchetypeFamilyV2 {
  familyId: number;
  requirement: BuildFamilyRequirementV2;
  aggregateFrequencyTier: StatlockerFrequencyTierV1;
  sourceProfileCount: number;
  profileCoverage: number;
  purchaseRate: number;
  structuralPriority: number;
  progressionNodes: readonly BuildProgressionNodeV2[];
  terminalCandidates: readonly BuildTerminalCandidateV2[];
}

export interface BuildArchetypeGroupV2 {
  groupId: string;
  type: 'CHOICE';
  candidateFamilyIds: readonly number[];
  minSelect: number;
  maxSelect: number;
  source: 'STATLOCKER_EXPLICIT' | 'INFERRED_CONSENSUS';
  confidence: number;
}
```

Change `BuildArchetypeV2` to expose `families` as the strategic semantic authority. Order edges and relationships must reference family IDs rather than representative item IDs. Remove flat `items[]` from decision authority rather than maintaining two competing goal models.

- [ ] **Step 5: Implement deterministic family compilation**

For each canonical `familyId`, retain every observed Statlocker item node. Order mechanically related nodes by graph ancestry and deterministic item ID tie-breaks. For a linear observed branch, mark the deepest observed node whose aggregate raw tier is `CORE` or `FREQUENT` as `DEFAULT_TERMINAL`; mark deeper observed `SOMETIMES`/`FLEX` descendants as `OPTIONAL_TERMINAL`. If a branch has no `CORE/FREQUENT` node, use its deepest observed node as the default only for that observed family; do not synthesize an unobserved catalog node.

Infer non-explicit family requirement conservatively:

```ts
const required = family.profileCoverage === 1 &&
  family.aggregateFrequencyTier === 'CORE' &&
  !choiceFamilyIds.has(family.familyId);
```

Map remaining `FREQUENT` families to `OPTIONAL` and `SOMETIMES/FLEX` families to `SITUATIONAL`, unless explicit Statlocker grouping gives stronger semantics. Explicit CHOICE becomes a family-level CHOICE group; explicit REQUIRED makes the family REQUIRED; explicit OPTIONAL prevents inferred REQUIRED.

- [ ] **Step 6: Run focused compiler/profile tests**

Run the same command as Step 3.

Expected: PASS with one family for A/B/C, D retained only when Statlocker-backed, and no catalog-only terminal promotion.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/statlocker-adaptive/build-archetype-v2.ts apps/api/src/statlocker-adaptive/build-archetype-compiler-v2.service.ts apps/api/src/statlocker-adaptive/statlocker-build-profile-v2.ts apps/api/test/build-archetype-compiler-v2.spec.ts apps/api/test/statlocker-build-profile-v2.spec.ts
git commit -m "refactor(strategy-v2): compile family-first archetypes"
```

---

### Task 2: Make archetype quality and initial WPA selection family-aware

**Files:**
- Modify: `apps/api/src/statlocker-adaptive/build-archetype-quality-gate-v2.service.ts`
- Modify: `apps/api/src/statlocker-adaptive/build-archetype-selector-v2.service.ts`
- Modify: `apps/api/src/statlocker-adaptive/statlocker-build-v2.config.ts`
- Modify: `apps/api/test/build-archetype-quality-gate-v2.spec.ts`
- Modify: `apps/api/test/build-archetype-selector-v2.spec.ts`

**Interfaces:**
- Consumes: family-first `BuildArchetypeV2` from Task 1 and existing `RecommendationItemGraph`/VS_HERO_WPA rows.
- Produces: publication gate that rejects impossible family contracts and selector scores based on default family semantics rather than flat item count.

- [ ] **Step 1: Write a failing terminal-capacity gate test**

Build an archetype with 12 REQUIRED families plus one CHOICE group with `minSelect=1` and capacity policy 12. Assert rejection:

```ts
expect(result.accepted).toBe(false);
expect(result.reasonCodes).toContain('TERMINAL_CAPACITY_CONFLICT');
```

Add a companion case with 8 REQUIRED families plus two CHOICE groups each `minSelect=1`; assert acceptance when all other quality rules pass.

- [ ] **Step 2: Write failing family/terminal validity tests**

Assert the gate rejects a family with no Statlocker-backed default terminal, a terminal item unknown to the graph, duplicate family IDs, invalid CHOICE bounds, and a CHOICE family not present in `archetype.families`.

- [ ] **Step 3: Write a failing selector regression proving one family is one scoring unit**

Use two archetypes where one contains three upgrade tiers in one family and the other contains one terminal item. Give identical terminal WPA. Assert the first archetype gets no hidden score bonus from having three observed progression nodes.

For CHOICE, give two alternatives and assert the group is evaluated as `minSelect` alternatives, not summed as if all are bought.

- [ ] **Step 4: Run focused gate/selector tests and verify RED**

```bash
yarn workspace @deadlock-live-probe/api test --runTestsByPath test/build-archetype-quality-gate-v2.spec.ts test/build-archetype-selector-v2.spec.ts
```

Expected: FAIL because the current gate/selector iterate flat `items` and groups of item IDs.

- [ ] **Step 5: Add publication capacity policy and quality reason codes**

Add an explicit 12-slot publication capacity in centralized config:

```ts
archetypePublication: {
  heldItemCapacity: 12,
}
```

Add reason codes at minimum:

```ts
'TERMINAL_CAPACITY_CONFLICT'
'FAMILY_DEFAULT_TERMINAL_MISSING'
'FAMILY_TERMINAL_UNKNOWN_ITEM'
'FAMILY_TERMINAL_NOT_OBSERVED'
```

Compute minimum required occupancy as REQUIRED family count plus `sum(group.minSelect)` for CHOICE groups. Reject before publication when it exceeds 12.

- [ ] **Step 6: Update selector scoring to family/default-terminal units**

For each non-CHOICE family, score its default terminal candidates as one weighted family unit. For CHOICE groups, rank candidate families by their default-terminal matchup score and aggregate only the required number of selections. Do not include OPTIONAL_TERMINAL descendants in initial archetype selection merely because they exist; optional-terminal promotion belongs to runtime desired-state selection.

- [ ] **Step 7: Run focused tests**

Run the Step 4 command.

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/statlocker-adaptive/build-archetype-quality-gate-v2.service.ts apps/api/src/statlocker-adaptive/build-archetype-selector-v2.service.ts apps/api/src/statlocker-adaptive/statlocker-build-v2.config.ts apps/api/test/build-archetype-quality-gate-v2.spec.ts apps/api/test/build-archetype-selector-v2.spec.ts
git commit -m "feat(strategy-v2): gate and select family archetypes"
```

---

### Task 3: Add desired-build-state selection with CHOICE and optional-terminal WPA promotion

**Files:**
- Create: `apps/api/src/statlocker-adaptive/build-desired-state-v2.service.ts`
- Create: `apps/api/test/build-desired-state-v2.spec.ts`
- Modify: `apps/api/src/statlocker-adaptive/statlocker-build-v2.config.ts`
- Modify: `apps/api/src/statlocker-adaptive/build-item-utility-v2.service.ts` only where a reusable incremental terminal score is needed.

**Interfaces:**
- Consumes: locked `BuildArchetypeV2`, current inventory/time, enemy roster/threat, VS_HERO_WPA, WPA patch data, T4 chains.
- Produces:

```ts
export interface DesiredFamilyStateV2 {
  familyId: number;
  requirement: BuildFamilyRequirementV2 | 'CHOICE';
  selectedTerminalItemId: number;
  selectedTerminalKind: 'DEFAULT_TERMINAL' | 'OPTIONAL_TERMINAL';
  groupId?: string;
  score: number;
  confidence: number;
  reasonCodes: readonly string[];
}

export interface DesiredBuildStateV2 {
  families: readonly DesiredFamilyStateV2[];
  selectedChoiceFamilyIdsByGroup: Readonly<Record<string, readonly number[]>>;
  reasonCodes: readonly string[];
}
```

- [ ] **Step 1: Write failing default-vs-optional terminal tests**

For one REQUIRED family with C default and D optional, assert low/noisy incremental D evidence keeps C:

```ts
expect(result.families[0]).toMatchObject({
  selectedTerminalItemId: C,
  selectedTerminalKind: 'DEFAULT_TERMINAL',
});
```

Then supply strong sufficiently confident D WPA and assert D is selected with `OPTIONAL_TERMINAL_WPA_SELECTED`.

- [ ] **Step 2: Write failing CHOICE test**

Create one `CHOICE` group with family X and family Y, `minSelect=1,maxSelect=1`, give Y stronger exact-enemy WPA, and assert only Y enters the desired state.

- [ ] **Step 3: Run desired-state tests and verify RED**

```bash
yarn workspace @deadlock-live-probe/api test --runTestsByPath test/build-desired-state-v2.spec.ts
```

Expected: FAIL because desired-state service does not exist.

- [ ] **Step 4: Add centralized optional-terminal promotion policy**

Initialize promotion policy from already-approved V2 thresholds rather than inventing a looser path:

```ts
optionalTerminal: {
  minImprovement: 0.08,
  minConfidence: 0.35,
}
```

`0.08` matches the existing V2 plan-switch improvement scale and `0.35` matches existing V2 matchup-confidence policy. Keep these fields centralized so the frozen Billy fixture can expose whether later calibration is justified.

- [ ] **Step 5: Implement desired-state selection**

Select REQUIRED families first. Resolve each CHOICE group by terminal utility/WPA and `minSelect/maxSelect`. For each selected family, start from its best default terminal. Compare Statlocker-backed optional terminals only against that family's selected default terminal; promote only when incremental utility meets both thresholds. Never consider a catalog-only terminal.

The service returns goals only; it must not emit BUY/UPGRADE/REPLACE actions.

- [ ] **Step 6: Run tests**

Run the Step 3 command.

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/statlocker-adaptive/build-desired-state-v2.service.ts apps/api/test/build-desired-state-v2.spec.ts apps/api/src/statlocker-adaptive/statlocker-build-v2.config.ts apps/api/src/statlocker-adaptive/build-item-utility-v2.service.ts
git commit -m "feat(strategy-v2): select desired family terminals"
```

---

### Task 4: Replace sticky completion with current family satisfaction and semantic validation

**Files:**
- Create: `apps/api/src/statlocker-adaptive/build-family-satisfaction-v2.ts`
- Create: `apps/api/src/statlocker-adaptive/full-build-semantic-validator-v2.service.ts`
- Create: `apps/api/test/build-family-satisfaction-v2.spec.ts`
- Create: `apps/api/test/full-build-semantic-validator-v2.spec.ts`
- Modify: `apps/api/src/statlocker-adaptive/full-build-plan-v2.ts`

**Interfaces:**
- Produces pure evaluation:

```ts
export type BuildFamilySatisfactionStatusV2 =
  | 'UNSATISFIED'
  | 'IN_PROGRESS'
  | 'DEFAULT_TERMINAL_SATISFIED'
  | 'OPTIONAL_TERMINAL_SATISFIED';

export interface BuildFamilySatisfactionV2 {
  familyId: number;
  status: BuildFamilySatisfactionStatusV2;
  heldItemIds: readonly number[];
  satisfyingTerminalItemId?: number;
}

export function evaluateBuildFamilySatisfactionV2(
  archetype: BuildArchetypeV2,
  inventoryItemIds: readonly number[],
  graph: RecommendationItemGraph,
): readonly BuildFamilySatisfactionV2[];
```

- Produces semantic validator:

```ts
validate(input: {
  archetype: BuildArchetypeV2;
  desiredState: DesiredBuildStateV2;
  initialInventoryItemIds: readonly number[];
  steps: readonly FullBuildStepV2[];
  finalInventoryItemIds: readonly number[];
  itemGraph: RecommendationItemGraph;
}): FullBuildSemanticValidationV2;
```

- [ ] **Step 1: Write failing satisfaction state tests**

For `A -> B -> C -> D`, assert B=`IN_PROGRESS`, C=`DEFAULT_TERMINAL_SATISFIED`, D=`OPTIONAL_TERMINAL_SATISFIED`, and inventory without any family node=`UNSATISFIED`.

- [ ] **Step 2: Write failing no-sticky-completion regression**

Start with REQUIRED family X satisfied by C. Provide a trajectory that `REPLACE`s C with another family's Y. Assert final X is UNSATISFIED and semantic validation fails with `REQUIRED_FAMILY_REGRESSION`.

- [ ] **Step 3: Write failing anti-churn regression**

Validate:

```text
BUY X
REPLACE X -> Y
```

inside one plan and assert:

```ts
expect(validation.valid).toBe(false);
expect(validation.reasonCodes).toContain('IMMEDIATE_BUY_REPLACE_CHURN');
```

Also prove `BUY A -> UPGRADE A -> B` is valid and not churn.

- [ ] **Step 4: Run focused tests and verify RED**

```bash
yarn workspace @deadlock-live-probe/api test --runTestsByPath test/build-family-satisfaction-v2.spec.ts test/full-build-semantic-validator-v2.spec.ts
```

Expected: FAIL because these components do not exist.

- [ ] **Step 5: Implement current-inventory satisfaction**

Determine held family nodes from the current inventory. A held optional terminal satisfies the family at the highest state; a held default terminal satisfies default; an ancestor/intermediate yields IN_PROGRESS. Historical ownership is not an input.

- [ ] **Step 6: Implement semantic validation**

Add reason codes at minimum:

```ts
'REQUIRED_FAMILY_UNSATISFIED'
'CHOICE_BOUNDS_UNSATISFIED'
'REQUIRED_FAMILY_REGRESSION'
'IMMEDIATE_BUY_REPLACE_CHURN'
'POINTLESS_PURCHASE_CHURN'
'UNSUPPORTED_STRATEGIC_TERMINAL'
```

Track satisfaction after every `FullBuildStepV2`. REQUIRED satisfied-family count may not decrease. CHOICE groups must remain within their contract. A purchase that later disappears without being consumed by an upgrade is invalid in this first family-first version.

- [ ] **Step 7: Extend full-build plan validation shape**

Keep combined `validation.valid/reasonCodes` for existing consumers, and add explicit mechanical/semantic detail:

```ts
export interface ResolvedFullBuildPlanV2 {
  // existing identity fields
  steps: readonly FullBuildStepV2[];
  desiredState: DesiredBuildStateV2;
  mechanicalValidation: FullBuildValidationV2;
  semanticValidation: FullBuildSemanticValidationV2;
  validation: FullBuildValidationV2;
  degradedReasons: readonly string[];
}
```

Combined validation is valid only when both mechanical and semantic validation are valid.

- [ ] **Step 8: Run focused tests**

Run the Step 4 command.

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/statlocker-adaptive/build-family-satisfaction-v2.ts apps/api/src/statlocker-adaptive/full-build-semantic-validator-v2.service.ts apps/api/test/build-family-satisfaction-v2.spec.ts apps/api/test/full-build-semantic-validator-v2.spec.ts apps/api/src/statlocker-adaptive/full-build-plan-v2.ts
git commit -m "feat(strategy-v2): validate current family satisfaction"
```

---

### Task 5: Implement family-aware transaction planning and real one-slot upgrades

**Files:**
- Create: `apps/api/src/statlocker-adaptive/full-build-transaction-planner-v2.service.ts`
- Create: `apps/api/test/full-build-transaction-planner-v2.spec.ts`
- Modify: `apps/api/src/statlocker-adaptive/full-build-inventory-simulator-v2.ts` only if a mechanics defect is exposed.
- Modify: `apps/api/test/full-build-inventory-simulator-v2.spec.ts`
- Modify: `apps/api/src/statlocker-adaptive/full-build-resolver-v2.service.ts`
- Modify: `apps/api/test/full-build-resolver-v2.spec.ts`
- Modify: `apps/api/test/full-build-resolver-v2-lifetime.spec.ts`
- Modify: `apps/api/test/full-build-resolver-v2-replacement.spec.ts`
- Modify: `apps/api/test/full-build-lifetime-ranked-fallback-v2.spec.ts`
- Delete or replace: `apps/api/test/full-build-lifetime-mandatory-core-v2.spec.ts`

**Interfaces:**
- Consumes: current inventory, desired build state, family archetype, item graph, capacity, item utility, transition policy.
- Produces: ordered `FullBuildTransitionIntentV2[]`; `FullBuildResolverV2Service.resolve()` remains the public facade and returns `ResolvedFullBuildPlanV2`.

- [ ] **Step 1: Write the failing full-inventory upgrade regression**

Build capacity 12 with 12 held items including C, legal observed `C -> D`, and desired terminal D. Assert the planner emits exactly one UPGRADE and keeps 12 held items:

```ts
expect(plan.steps[0]).toMatchObject({ action: 'UPGRADE', buyItemId: D });
expect(plan.steps[0].consumedItemIds).toEqual([C]);
expect(plan.steps[0].inventoryBefore).toHaveLength(12);
expect(plan.steps[0].inventoryAfter).toHaveLength(12);
expect(plan.steps[0].action).not.toBe('REPLACE');
```

- [ ] **Step 2: Write the failing complete lineage regression**

From empty inventory with desired D on `A -> B -> C -> D`, assert action semantics:

```ts
expect(plan.steps.map((step) => [step.action, step.buyItemId])).toEqual([
  ['BUY', A],
  ['UPGRADE', B],
  ['UPGRADE', C],
  ['UPGRADE', D],
]);
```

And when desired terminal is C, assert the sequence stops at C.

- [ ] **Step 3: Write the failing replacement regression against required-family regression**

With full inventory, REQUIRED family X satisfied and OPTIONAL target Z attractive, make the only free-slot path sell X. Assert no replacement is emitted and the branch is rejected with `REQUIRED_FAMILY_REGRESSION`/`NO_ACCEPTED_REPLACEMENT` trace evidence.

- [ ] **Step 4: Run planner/resolver/simulator tests and verify RED**

```bash
yarn workspace @deadlock-live-probe/api test --runTestsByPath test/full-build-transaction-planner-v2.spec.ts test/full-build-inventory-simulator-v2.spec.ts test/full-build-resolver-v2.spec.ts test/full-build-resolver-v2-lifetime.spec.ts test/full-build-resolver-v2-replacement.spec.ts test/full-build-lifetime-ranked-fallback-v2.spec.ts
```

Expected: FAIL because the current lifetime resolver selects one flat semantic target at a time and uses sticky `completedSemanticItemIds`/mandatory-core replacement override.

- [ ] **Step 5: Implement deterministic next-upgrade path selection**

Within a family, find the shortest legal observed-node path from the held ancestor to `selectedTerminalItemId`. The next transaction is the direct child upgrade whose recipe consumes the currently held ancestor. Reject a family path if its next strategic node is not Statlocker-observed or no legal recipe exists.

Normal upgrade policy is atomic and one-slot:

```ts
if (ownedAncestor && nextUpgrade) {
  return {
    action: 'UPGRADE',
    buyItemId: nextUpgrade.itemId,
    recipeId: nextUpgrade.recipeId,
    reasonCodes: ['FAMILY_PROGRESSION', 'RECIPE_UPGRADE_PREFERRED'],
  };
}
```

No empty-slot check is performed for this executable upgrade.

- [ ] **Step 6: Implement goal-first BUY/REPLACE planning**

For an unsatisfied desired family with no held ancestor, buy the earliest Statlocker-observed purchasable path entry when capacity is available. At full capacity, enumerate deliberate cross-family REPLACE candidates. Simulate resulting state and hard-reject any candidate that reduces REQUIRED satisfaction or violates CHOICE bounds before comparing utility.

Remove `mandatoryCore` and `MANDATORY_CORE_PROGRESSION_REPLACEMENT`; no target may bypass utility/semantic constraints merely because its raw tier is CORE.

- [ ] **Step 7: Make `FullBuildResolverV2Service` an orchestration facade**

Inject/use `BuildDesiredStateV2Service`, `FullBuildTransactionPlannerV2Service`, the existing simulator, and `FullBuildSemanticValidatorV2Service`. Resolve desired state once per plan revision, generate transactions toward it, mechanically simulate them, semantically validate the trajectory, and return combined validation.

Preserve the public overloaded transition-evaluation API only if existing production call sites still use it; otherwise remove the unused overload and keep one lifetime-plan contract. Do not preserve flat-goal state for compatibility.

- [ ] **Step 8: Replace the mandatory-core regression**

Delete or rename `full-build-lifetime-mandatory-core-v2.spec.ts`. Its replacement must assert that a low-utility replacement cannot sacrifice a satisfied REQUIRED family merely to touch another raw CORE item.

- [ ] **Step 9: Run focused tests**

Run the Step 4 command.

Expected: PASS, including `12/12 -> UPGRADE -> 12/12`, complete lineage progression, no sticky completion, and no mandatory-core churn.

- [ ] **Step 10: Commit**

```bash
git add apps/api/src/statlocker-adaptive/full-build-transaction-planner-v2.service.ts apps/api/src/statlocker-adaptive/full-build-resolver-v2.service.ts apps/api/src/statlocker-adaptive/full-build-inventory-simulator-v2.ts apps/api/test/full-build-transaction-planner-v2.spec.ts apps/api/test/full-build-inventory-simulator-v2.spec.ts apps/api/test/full-build-resolver-v2.spec.ts apps/api/test/full-build-resolver-v2-lifetime.spec.ts apps/api/test/full-build-resolver-v2-replacement.spec.ts apps/api/test/full-build-lifetime-ranked-fallback-v2.spec.ts apps/api/test/full-build-lifetime-mandatory-core-v2.spec.ts
git commit -m "refactor(strategy-v2): plan family-aware lifetime transactions"
```

---

### Task 6: Integrate hysteresis, outside candidates, trace, and runtime orchestration with desired state

**Files:**
- Modify: `apps/api/src/statlocker-adaptive/adaptive-recommendation-v2.service.ts`
- Modify: `apps/api/src/statlocker-adaptive/full-build-hysteresis-v2.service.ts`
- Modify: `apps/api/src/statlocker-adaptive/matchup-candidate-discovery-v2.service.ts`
- Modify: `apps/api/src/statlocker-adaptive/build-decision-trace-v2.ts`
- Modify: `apps/api/test/full-build-hysteresis-v2.spec.ts`
- Modify: `apps/api/test/matchup-candidate-discovery-v2.spec.ts`
- Modify: `apps/api/test/adaptive-recommendation-v2.e2e.spec.ts`

**Interfaces:**
- Consumes: locked family archetype, existing outside candidates, previous trace/plan revision.
- Produces: one desired-state-backed plan per request plus typed trace evidence explaining terminal/choice/transaction decisions.

- [ ] **Step 1: Write failing runtime integration tests**

Extend `adaptive-recommendation-v2.e2e.spec.ts` to assert:

```ts
expect(result.fullBuild?.desiredState).toBeDefined();
expect(result.fullBuild?.semanticValidation.valid).toBe(true);
expect(result.nextAction.type).toBe(result.fullBuild?.steps[0].action);
```

Add a second request for the same match and assert the immutable archetype lock remains unchanged while a material live/WPA change may alter an optional terminal/CHOICE decision without changing `archetypeId`.

- [ ] **Step 2: Add a failing previous-plan hysteresis wiring test**

Put a previous full plan in `BuildDebugTraceStoreV2Service`, issue a new recommendation with a tiny desired-state improvement, and assert the near-term plan remains stable. With a material improvement above policy, assert a new plan revision is accepted.

- [ ] **Step 3: Run focused runtime tests and verify RED**

```bash
yarn workspace @deadlock-live-probe/api test --runTestsByPath test/adaptive-recommendation-v2.e2e.spec.ts test/full-build-hysteresis-v2.spec.ts test/matchup-candidate-discovery-v2.spec.ts
```

Expected: FAIL until desired state/semantic validation and previous-plan wiring are propagated.

- [ ] **Step 4: Preserve outside-archetype policy as situational desired-state candidates**

Keep existing Statlocker provenance/confidence gates. An accepted outside candidate may compete only for OPTIONAL/SITUATIONAL capacity and may never reduce REQUIRED satisfaction. Do not turn it into a new archetype or a catalog-derived family.

- [ ] **Step 5: Wire previous plan into hysteresis**

Read `this.traceStore.get(matchId)?.finalPlan` before planning and pass the previous plan/revision into the resolver/hysteresis path. Near-term committed actions retain stronger protection than distant future changes; required-family regression is still a hard semantic rejection, not a hysteresis score.

- [ ] **Step 6: Extend trace contracts**

Add typed visibility for family semantics. Either add dedicated stages or typed payload sections; use dedicated stages for deterministic E2E/debugger visibility:

```ts
| 'DESIRED_STATE'
| 'SEMANTIC_VALIDATION'
```

`DESIRED_STATE` must expose selected CHOICE families, default/optional terminal decisions, score/confidence, and reason codes. `PLAN_SEARCH`/`REPLACEMENT_SEARCH` must expose family-regression rejections. `SEMANTIC_VALIDATION` must expose final family statuses and semantic reason codes.

- [ ] **Step 7: Run focused tests**

Run the Step 3 command.

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/statlocker-adaptive/adaptive-recommendation-v2.service.ts apps/api/src/statlocker-adaptive/full-build-hysteresis-v2.service.ts apps/api/src/statlocker-adaptive/matchup-candidate-discovery-v2.service.ts apps/api/src/statlocker-adaptive/build-decision-trace-v2.ts apps/api/test/adaptive-recommendation-v2.e2e.spec.ts apps/api/test/full-build-hysteresis-v2.spec.ts apps/api/test/matchup-candidate-discovery-v2.spec.ts
git commit -m "feat(strategy-v2): integrate desired-state runtime planning"
```

---

### Task 7: Propagate family semantics through shared API and production debugger

**Files:**
- Modify: `packages/shared/src/adaptive-recommendation-v2.ts`
- Modify: `packages/shared/src/index.ts` only if new exported types require it.
- Modify: `apps/api/src/statlocker-adaptive/adaptive-recommendation-v2.service.ts`
- Modify: `apps/api/src/build-debug-v2/build-debug-v2.client.ts`
- Modify: `apps/api/src/build-debug-v2/build-debug-v2.ui.ts`
- Modify: `apps/api/test/adaptive-recommendation-v2.e2e.spec.ts`
- Modify: `apps/api/test/build-debug-v2.e2e.spec.ts`

**Interfaces:**
- Produces shared read-only summaries for desired family state and semantic validation while preserving ordered `fullBuild.steps` and `nextAction`.

- [ ] **Step 1: Write failing shared/API assertions**

Extend API E2E to assert `fullBuild` includes:

```ts
expect(result.fullBuild).toMatchObject({
  desiredState: expect.any(Object),
  mechanicalValidation: { valid: true },
  semanticValidation: { valid: true },
  validation: { valid: true },
});
```

Assert every desired terminal has family ID, selected terminal item ID/kind, requirement/group context, and reason codes.

- [ ] **Step 2: Write failing debugger UI assertions**

Require the served UI/client to contain/render sections for:

```text
Family progression
REQUIRED / CHOICE / OPTIONAL / SITUATIONAL
Default terminal
Optional terminal WPA decision
Desired build state
Semantic validation
Anti-churn / family-regression rejection
```

- [ ] **Step 3: Run focused API/debugger tests and verify RED**

```bash
yarn workspace @deadlock-live-probe/api test --runTestsByPath test/adaptive-recommendation-v2.e2e.spec.ts test/build-debug-v2.e2e.spec.ts
yarn workspace @deadlock-live-probe/shared build
```

Expected: FAIL until shared contracts and debugger rendering are updated.

- [ ] **Step 4: Extend shared V2 contracts**

Add explicit JSON-safe versions of `DesiredBuildStateV2`, desired family rows, and semantic validation summary to `AdaptiveFullBuildPlanV2`. Keep existing ordered step contract unchanged so downstream presentation can migrate without reconstructing planner state.

- [ ] **Step 5: Map API output and debugger trace**

Map family IDs/requirements/terminal decisions and both validation layers from the resolver result. Update debugger rendering to read typed trace/API fields, not parse free-form reason strings.

- [ ] **Step 6: Run focused tests/build**

Run the Step 3 commands.

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/adaptive-recommendation-v2.ts packages/shared/src/index.ts apps/api/src/statlocker-adaptive/adaptive-recommendation-v2.service.ts apps/api/src/build-debug-v2/build-debug-v2.client.ts apps/api/src/build-debug-v2/build-debug-v2.ui.ts apps/api/test/adaptive-recommendation-v2.e2e.spec.ts apps/api/test/build-debug-v2.e2e.spec.ts
git commit -m "feat(strategy-v2): expose family-first build diagnostics"
```

---

### Task 8: Reopen old Task 17 and prove the corrected pipeline on frozen Billy data

**Files:**
- Modify: `apps/api/test/statlocker-build-v2-real-data.e2e.spec.ts`
- Read-only input: `apps/api/test/fixtures/statlocker-build-v2/billy-real.fixture.json`
- Read-only request: `apps/api/test/fixtures/statlocker-build-v2/billy-real.request.json`
- Do not create/finalize: `apps/api/test/fixtures/statlocker-build-v2/billy-real.expected.json` until the human-review step is approved.

**Interfaces:**
- Executes the complete existing real-data path plus family-first compilation, desired-state selection, transaction planning, mechanical simulation, and semantic validation.
- Prints stable report markers `BUILD_V2_E2E_REPORT_START` / `BUILD_V2_E2E_REPORT_END`.

- [ ] **Step 1: Replace obsolete CORE-history assertions with family-final-state assertions**

The E2E must assert at minimum:

```ts
expect(fixture.proBuildAnalyses).toHaveLength(10);
expect(fixture.request.enemyHeroIds).toHaveLength(6);
expect(result.fullBuild?.mechanicalValidation.valid).toBe(true);
expect(result.fullBuild?.semanticValidation.valid).toBe(true);
expect(result.fullBuild?.validation.valid).toBe(true);
expect(result.nextAction.type).toBe(result.fullBuild?.steps[0].action);
```

Additionally assert:

- all strategic terminals are Statlocker-backed
- minimum required occupancy <= request capacity
- every REQUIRED family is satisfied in final inventory
- every CHOICE group satisfies min/max
- no `REQUIRED_FAMILY_REGRESSION`
- no `IMMEDIATE_BUY_REPLACE_CHURN`/`POINTLESS_PURCHASE_CHURN`
- every UPGRADE consumes its held ancestor and does not exceed capacity
- inventory never exceeds 12 for the Billy request
- immutable lock is reused on the second request
- trace contains existing required stages plus `DESIRED_STATE` and `SEMANTIC_VALIDATION`

Delete any assertion whose meaning is only "every raw CORE item appeared at least once somewhere in trajectory".

- [ ] **Step 2: Expand the human-readable report**

Print:

```text
Hero: Billy (72)
Source profiles: 10
Archetypes found: ...
FAMILY SEMANTICS:
  familyId / requirement / observed progression / default terminal / optional terminals
Selected archetype: ...
Selection evidence: VS_HERO_WPA score/confidence/coverage
DESIRED BUILD STATE:
  selected CHOICE families
  selected terminal per active family
  optional-terminal promote/reject reasons
FULL BUILD:
  every BUY/UPGRADE/REPLACE step
FINAL INVENTORY:
  every held item
FAMILY SATISFACTION:
  every REQUIRED/CHOICE result
Inventory simulation: PASS|FAIL
Semantic validation: PASS|FAIL
Degraded reasons: ...
```

- [ ] **Step 3: Run the real Billy E2E and gather the actual report**

Run:

```bash
yarn workspace @deadlock-live-probe/api test --runTestsByPath test/statlocker-build-v2-real-data.e2e.spec.ts
```

Expected: the test reaches the complete family-first plan. If a focused invariant fails or the printed build is strategically poor, stop and fix the responsible earlier task with a focused RED test; do not weaken this E2E.

- [ ] **Step 4: Present the exact actual Billy report to the user and stop for approval**

This is a hard human gate. Show the selected archetype/families, WPA evidence, every transaction, final inventory, and both validation results. Do not create the golden file in the same step.

- [ ] **Step 5: After explicit approval, commit the corrected E2E assertions/reporting**

```bash
git add apps/api/test/statlocker-build-v2-real-data.e2e.spec.ts
git commit -m "test(strategy-v2): validate family-first Billy build"
```

Expected: no Billy golden has been frozen yet unless the user explicitly approved the printed output.

---

### Task 9: Freeze the human-approved Billy golden and resume original Task 18 production cutover

**Files:**
- Create: `apps/api/test/fixtures/statlocker-build-v2/billy-real.expected.json`
- Modify: `apps/api/test/statlocker-build-v2-real-data.e2e.spec.ts`
- Modify: `apps/overwolf-client/src/adaptive-recommendation-client.ts`
- Modify: `apps/overwolf-client/src/adaptive-recommendation-client.spec.ts`
- Modify: `apps/overwolf-client/src/adaptive-recommendation-full-build-client.integration.spec.ts`
- Modify: `apps/overwolf-client/src/adaptive-recommendation-full-build-path.spec.ts`
- Modify: `apps/api/src/statlocker-adaptive/statlocker-adaptive.module.ts`
- Modify V1 serving/controller registrations only as required to remove runtime fallback authority.

**Interfaces:**
- Billy golden stores approved deterministic semantic identity/action expectations.
- Overwolf production client consumes `AdaptiveRecommendationRequestV2/AdaptiveRecommendationResultV2` from `/deadlock/adaptive/v2/recommend`.

- [ ] **Step 1: Freeze only stable approved Billy semantics**

Write `billy-real.expected.json` with:

```json
{
  "archetypeId": "<approved deterministic id>",
  "desiredFamilies": [],
  "orderedActionKeys": [],
  "finalFamilySatisfaction": [],
  "mechanicalValidationValid": true,
  "semanticValidationValid": true
}
```

Populate the arrays/ID from the approved Step 8 report exactly; do not auto-regenerate this fixture in ordinary CI.

- [ ] **Step 2: Add exact deterministic golden comparison and rerun Billy**

Run:

```bash
yarn workspace @deadlock-live-probe/api test --runTestsByPath test/statlocker-build-v2-real-data.e2e.spec.ts
```

Expected: PASS and report matches the approved golden.

- [ ] **Step 3: Update Overwolf client tests first**

Change imports/request/result expectations to V2. Assert URL `/deadlock/adaptive/v2/recommend`, preserve all ordered BUY/UPGRADE/REPLACE steps, preserve explicit `sellItemId` on REPLACE, and preserve a plan with 15 transitions even when simultaneous capacity is 12.

- [ ] **Step 4: Run Overwolf tests and verify RED**

```bash
yarn workspace @deadlock-live-probe/overwolf-client test
```

Expected: FAIL because the current client still imports V1 types and calls `/deadlock/adaptive/v1/recommend`.

- [ ] **Step 5: Switch `AdaptiveRecommendationClient` to V2**

Use:

```ts
AdaptiveRecommendationRequestV2
AdaptiveRecommendationResultV2
```

and fetch:

```ts
`${this.apiBaseUrl}/deadlock/adaptive/v2/recommend`
```

Keep debounce/retry/cancellation behavior unchanged. Downstream presentation must consume `fullBuild.steps` as the full lifetime path and `nextAction` as the immediate transaction; never slice the lifetime path to current capacity.

- [ ] **Step 6: Remove V1 runtime fallback authority from production wiring**

Ensure the production recommendation route resolves through `AdaptiveRecommendationV2Service`. Remove V1 planner/compiler/fallback providers from the serving path. Old files may remain only for historical tests/tools. Add or update a static wiring regression proving a V2 failure cannot invoke V1 strategy planning.

- [ ] **Step 7: Run API + client release-contract tests**

```bash
yarn workspace @deadlock-live-probe/api test --runTestsByPath test/adaptive-recommendation-v2.e2e.spec.ts test/statlocker-build-v2-real-data.e2e.spec.ts
yarn workspace @deadlock-live-probe/overwolf-client test
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/api/test/fixtures/statlocker-build-v2/billy-real.expected.json apps/api/test/statlocker-build-v2-real-data.e2e.spec.ts apps/overwolf-client/src apps/api/src/statlocker-adaptive/statlocker-adaptive.module.ts apps/api/test
git commit -m "feat(strategy-v2): approve Billy build and cut client to V2"
```

---

### Task 10: Finish original Task 19 production-readiness verification

**Files:**
- Modify only if verification exposes a scoped defect.
- Review: `docs/superpowers/specs/2026-09-11-statlocker-build-strategy-v2-family-first-design.md`
- Review: this plan.

**Interfaces:**
- Release gate only; no new production interface.

- [ ] **Step 1: Run all focused family/planner regressions**

```bash
yarn workspace @deadlock-live-probe/api test --runTestsByPath test/build-archetype-compiler-v2.spec.ts test/build-archetype-quality-gate-v2.spec.ts test/build-desired-state-v2.spec.ts test/build-family-satisfaction-v2.spec.ts test/full-build-transaction-planner-v2.spec.ts test/full-build-semantic-validator-v2.spec.ts test/full-build-inventory-simulator-v2.spec.ts test/full-build-resolver-v2.spec.ts test/statlocker-vs-hero-wpa-v2.integration.spec.ts test/statlocker-build-v2-real-data.e2e.spec.ts
```

Expected: PASS.

- [ ] **Step 2: Run the complete API suite**

```bash
yarn workspace @deadlock-live-probe/api test
```

Expected: PASS.

- [ ] **Step 3: Run the complete Overwolf suite**

```bash
yarn workspace @deadlock-live-probe/overwolf-client test
```

Expected: PASS.

- [ ] **Step 4: Build all workspaces**

```bash
yarn build
```

Expected: PASS with no TypeScript/Nest/client build errors.

- [ ] **Step 5: Validate migrations against a disposable/test database**

```bash
yarn workspace @deadlock-live-probe/api migration:run
```

Then run the repository migration status command used by the project and verify no V2 migration remains pending. Expected: existing archetype snapshot/match-lock schema remains valid; add a migration only if the family-first persistence shape is stored in concrete DB columns rather than the existing serialized snapshot payload.

- [ ] **Step 6: Smoke-test debugger in production-like mode**

Start API with non-secret local test values for `BUILD_DEBUG_PASSWORD` and `BUILD_DEBUG_SESSION_SECRET`. Open `/debug/build-v2`, authenticate, load a trace, and verify family progression, requirements, terminal decisions, WPA promotion/rejection, desired state, transaction branches, final plan, mechanical validation, and semantic validation are visible. Verify unauthenticated `/debug/build-v2/matches` returns 401.

- [ ] **Step 7: Verify no V1 production fallback**

Run the static wiring regression plus a V2 not-ready/error case. Confirm no V1 compiler/planner/fallback service is invoked and no V1 plan appears in the response/trace.

- [ ] **Step 8: Inspect one production-like recommendation end to end**

Confirm:

```text
valid V2 snapshot
immutable match lock
nonzero WPA query activity when rows exist
family-first desired state
full lifetime plan not truncated to capacity
12/12 upgrades remain legal
no immediate buy-replace churn
mechanical validation PASS
semantic validation PASS
no V1 fallback
```

- [ ] **Step 9: Show the final approved Billy report to the user again**

Paste the exact Task 8/9 report including every BUY/UPGRADE/REPLACE step and final inventory. If it differs from the approved golden or is visibly poor, reopen the responsible task instead of claiming completion.

- [ ] **Step 10: Commit verification-only fixes individually, then verify a clean tree**

For each scoped defect found during Steps 1-8, add a focused regression and commit that fix separately. Finish with:

```bash
git status --short
```

Expected: empty output.

---

## Plan Self-Review Results

- **Spec coverage:** Sections 3-7 map to Tasks 1-3; current satisfaction/upgrade/planner/anti-churn/validation map to Tasks 4-5; runtime/trace/debugger map to Tasks 6-7; resumed Billy Task 17 maps to Task 8 plus the golden gate in Task 9; resumed old Task 18 maps to Task 9; resumed old Task 19 maps to Task 10.
- **Roadmap preservation:** Existing V2 sourcing, mining, lock, WPA, fixture, trace/debugger, API, and persistence responsibilities are reused rather than rebuilt. The frozen Billy fixture remains canonical. Overwolf cutover and final release verification remain after Billy approval exactly as required by the original roadmap.
- **Superseded semantics:** The plan explicitly removes flat CORE lifetime completion, sticky `completedSemanticItemIds`, mandatory-core utility override, catalog-only strategic terminal promotion, and the false notion that 12/12 blocks one-slot upgrades.
- **Type consistency:** `BuildArchetypeV2.families` flows compiler -> quality gate -> selector -> lock snapshot -> desired-state selector -> transaction planner -> semantic validator -> trace/API/debugger. `DesiredBuildStateV2` is created before transactions and is carried into `ResolvedFullBuildPlanV2`; semantic/mechanical validation are separately exposed and combined at the existing `validation` field.
- **Human gate:** Billy golden creation and production cutover are explicitly blocked until the user approves the actual corrected report.
