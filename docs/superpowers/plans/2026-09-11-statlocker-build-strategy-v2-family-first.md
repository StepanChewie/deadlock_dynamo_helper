# Statlocker Build Strategy V2 Family-First Completion Implementation Plan

> **Implemented.** The described progression/replacement model is in the code and recorded as ADR-005 and ADR-006. Kept as the design record.

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to execute this plan task-by-task. Use TDD for every behavior change and `superpowers:verification-before-completion` before completion claims.

**Goal:** Correct V2 lifetime-build semantics so Statlocker upgrade families produce coherent final-state goals and legal BUY/UPGRADE/REPLACE trajectories, rerun and human-review the frozen Billy full-pipeline E2E, then finish the original V2 Overwolf cutover and production release gates.

**Architecture:** Keep the already-built V2 source collection, profile mining, immutable archetype lock, WPA integration, persistent snapshot/lock storage, trace/debugger, frozen Billy fixture, and V2 API infrastructure. Replace flat item goals with family-first archetypes; select a desired family/terminal state before generating transactions; recompute family satisfaction from projected inventory; plan one-slot Deadlock upgrades as atomic ancestor-to-descendant transitions; and validate mechanics plus semantics. Only after the corrected Billy report is approved do we freeze the golden, cut Overwolf to V2, remove V1 serving fallback authority, and run the original final release gate.

**Tech Stack:** TypeScript 5.9, NestJS 11, Jest/ts-jest, TypeORM/PostgreSQL, existing `@deadlock-live-probe/build-domain` item graph, existing Statlocker snapshot/WPA storage, existing V2 trace/debugger, existing Overwolf client.

**Primary design:** `docs/superpowers/specs/2026-09-11-statlocker-build-strategy-v2-family-first-design.md`

**Original roadmap being resumed:** `docs/superpowers/plans/2026-09-10-statlocker-build-strategy-v2.md`

## Global constraints

- Strategic build evidence is Statlocker-only. Request/live state supplies runtime context, never build evidence.
- Keep the frozen Billy inputs at `apps/api/test/fixtures/statlocker-build-v2/billy-real.fixture.json` and `apps/api/test/fixtures/statlocker-build-v2/billy-real.request.json` unchanged unless a separate source-integrity defect is proven.
- Catalog/item graph is mechanics authority only: family ancestry, legal recipes, direct purchase, ruleset availability, max copies, and capacity.
- A catalog-only descendant with no Statlocker strategic evidence cannot become a default or optional strategic terminal.
- Keep three concepts separate:
  - raw Statlocker frequency: `CORE | FREQUENT | SOMETIMES | FLEX`
  - family requirement: `REQUIRED | CHOICE | OPTIONAL | SITUATIONAL`
  - progression role: `ENTRY | INTERMEDIATE | DEFAULT_TERMINAL | OPTIONAL_TERMINAL`
- `frequencyTier === CORE` alone never means an independent final-slot requirement.
- One upgrade lineage is one final-slot family even when multiple tiers are common in Statlocker.
- Deadlock progression for this planner is one-slot lineage progression: `UPGRADE C -> D` atomically consumes C and obtains D; `12/12 -> 12/12`.
- Do not introduce multi-held-component strategic progression such as `C + X -> D` in the family planner.
- Family satisfaction derives from the current projected inventory, not historical ownership.
- REQUIRED family satisfaction cannot regress inside one generated lifetime plan.
- `BUY X -> REPLACE X -> Y` inside one generated lifetime plan is semantically invalid unless X disappears because a legal UPGRADE consumed it. Do not invent temporary-item semantics from aggregate Statlocker data.
- Missing optional WPA/T4 evidence degrades adaptation but cannot delete the Statlocker-backed base build.
- Never reintroduce V1 positional strategy as V2 fallback.
- Never freeze `billy-real.expected.json` until the actual corrected Billy report has been shown to and explicitly approved by the user.
- Follow project style: TypeScript, English code comments and Swagger descriptions, regular hyphen characters, and no `| null` in function return types.

---

## Task 1: Replace flat archetype item goals with family-first contracts and compilation

**Files**

- Modify: `apps/api/src/statlocker-adaptive/build-archetype-v2.ts`
- Modify: `apps/api/src/statlocker-adaptive/build-archetype-compiler-v2.service.ts`
- Modify: `apps/api/src/statlocker-adaptive/statlocker-build-profile-v2.ts`
- Modify: `apps/api/src/statlocker-adaptive/statlocker-build-v2.config.ts`
- Modify: `apps/api/test/build-archetype-compiler-v2.spec.ts`
- Modify: `apps/api/test/statlocker-build-profile-v2.spec.ts`

### Step 1.1 - RED: one upgrade lineage compiles to one semantic family

Add a catalog graph `A -> B -> C` and two Statlocker profiles where A/B/C have different raw frequency tiers. Assert one family and three observed progression nodes, not three final goals:

```ts
expect(archetype.families).toHaveLength(1);
expect(archetype.families[0].progressionNodes.map((node) => node.itemId)).toEqual([A, B, C]);
expect(archetype.families[0].progressionNodes.map((node) => node.progressionRole)).toEqual([
  'ENTRY',
  'INTERMEDIATE',
  'DEFAULT_TERMINAL',
]);
```

### Step 1.2 - RED: rare observed descendant is optional, catalog-only descendant is not strategic

Use catalog `A -> B -> C -> D`.

Case A: D has small but real Statlocker usage. Assert:

```ts
expect(family.terminalCandidates).toEqual(expect.arrayContaining([
  expect.objectContaining({ itemId: C, kind: 'DEFAULT_TERMINAL' }),
  expect.objectContaining({ itemId: D, kind: 'OPTIONAL_TERMINAL' }),
]));
```

Case B: D is absent from every Statlocker profile. Assert:

```ts
expect(family.terminalCandidates.some((entry) => entry.itemId === D)).toBe(false);
```

### Step 1.3 - Verify RED

```bash
yarn workspace @deadlock-live-probe/api test --runTestsByPath test/statlocker-build-profile-v2.spec.ts test/build-archetype-compiler-v2.spec.ts
```

Expected: FAIL because current `BuildArchetypeV2` exposes representative `items[]` goals and no progression/terminal contracts.

### Step 1.4 - Implement family-first domain contracts

Add in `build-archetype-v2.ts`:

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

Change `BuildArchetypeV2` so `families` is the strategic semantic authority. Family-level order edges/relationships reference `familyId`, not representative item IDs. Do not keep flat `items[]` as a second goal authority.

### Step 1.5 - Implement deterministic terminal classification

For each existing canonical `familyId`:

1. retain every Statlocker-observed item node in that family;
2. use the item graph only to order observed ancestors/descendants;
3. on each observed lineage branch, choose the deepest observed node whose aggregate raw tier is `CORE` or `FREQUENT` as `DEFAULT_TERMINAL`;
4. deeper Statlocker-observed `SOMETIMES`/`FLEX` descendants become `OPTIONAL_TERMINAL`;
5. if an observed family has no `CORE/FREQUENT` node, its deepest observed node is the default for that family;
6. never synthesize an unobserved catalog node as a terminal.

Initial non-explicit family requirement inference is intentionally conservative and deterministic:

```ts
const inferredRequired =
  family.profileCoverage === 1 &&
  family.aggregateFrequencyTier === 'CORE' &&
  !choiceFamilyIds.has(family.familyId);
```

Explicit Statlocker grouping overrides inference:

- explicit REQUIRED -> `REQUIRED`
- explicit OPTIONAL -> never inferred REQUIRED
- explicit CHOICE -> represented by a family-level CHOICE group

For non-explicit non-required families:

- aggregate `FREQUENT` -> `OPTIONAL`
- aggregate `SOMETIMES` or `FLEX` -> `SITUATIONAL`

Do not loosen the 100% inferred REQUIRED rule until frozen real-data evidence demonstrates a concrete false negative and a focused regression justifies calibration.

### Step 1.6 - GREEN

Run the Step 1.3 command. Expected: PASS.

### Step 1.7 - Commit

```bash
git add apps/api/src/statlocker-adaptive/build-archetype-v2.ts apps/api/src/statlocker-adaptive/build-archetype-compiler-v2.service.ts apps/api/src/statlocker-adaptive/statlocker-build-profile-v2.ts apps/api/src/statlocker-adaptive/statlocker-build-v2.config.ts apps/api/test/build-archetype-compiler-v2.spec.ts apps/api/test/statlocker-build-profile-v2.spec.ts
git commit -m "refactor(strategy-v2): compile family-first archetypes"
```

---

## Task 2: Make archetype quality gating and initial VS_HERO_WPA selection family-aware

**Files**

- Modify: `apps/api/src/statlocker-adaptive/build-archetype-quality-gate-v2.service.ts`
- Modify: `apps/api/src/statlocker-adaptive/build-archetype-selector-v2.service.ts`
- Modify: `apps/api/src/statlocker-adaptive/statlocker-build-v2.config.ts`
- Modify: `apps/api/test/build-archetype-quality-gate-v2.spec.ts`
- Modify: `apps/api/test/build-archetype-selector-v2.spec.ts`

### Step 2.1 - RED: impossible final contract is rejected before planner

Create an archetype with 12 REQUIRED families plus one CHOICE group with `minSelect=1` and capacity 12. Assert:

```ts
expect(result.accepted).toBe(false);
expect(result.reasonCodes).toContain('TERMINAL_CAPACITY_CONFLICT');
```

Add a passing companion with 8 REQUIRED families and two CHOICE groups each `minSelect=1`.

### Step 2.2 - RED: family/terminal validity

Assert rejection for:

- duplicate family IDs;
- family with no default terminal;
- terminal item unknown to item graph;
- terminal not present in that family's Statlocker-observed nodes;
- invalid CHOICE min/max;
- CHOICE referencing a non-existent family.

### Step 2.3 - RED: one family is one WPA scoring unit

Construct two otherwise equivalent archetypes. One has three observed tiers in one family; the other has one terminal node in one family. Give equal terminal matchup evidence. Assert the first gets no bonus merely from having more tiers.

For CHOICE, assert only `minSelect` chosen alternatives contribute to the archetype score, not all candidates summed together.

### Step 2.4 - Verify RED

```bash
yarn workspace @deadlock-live-probe/api test --runTestsByPath test/build-archetype-quality-gate-v2.spec.ts test/build-archetype-selector-v2.spec.ts
```

Expected: FAIL against current flat-item gate/selector behavior.

### Step 2.5 - Implement family quality gate

Add centralized config:

```ts
archetypePublication: {
  heldItemCapacity: 12,
}
```

Add gate reasons:

```ts
'TERMINAL_CAPACITY_CONFLICT'
'FAMILY_DEFAULT_TERMINAL_MISSING'
'FAMILY_TERMINAL_UNKNOWN_ITEM'
'FAMILY_TERMINAL_NOT_OBSERVED'
```

Compute:

```ts
minimumRequiredOccupancy =
  requiredFamilyCount +
  sum(choiceGroups.map((group) => group.minSelect));
```

Reject when occupancy > 12. Unused slots are valid and remain available to optional/situational runtime choices.

### Step 2.6 - Implement family-aware initial archetype selector

Normal match lock still uses full enemy roster + VS_HERO_WPA only.

- non-CHOICE family: score its default terminal as one family unit;
- CHOICE: rank candidate families by default-terminal WPA and contribute only the number required by `minSelect`;
- OPTIONAL_TERMINAL descendants do not add initial archetype score merely because they exist; optional promotion is a runtime desired-state decision.

### Step 2.7 - GREEN

Run Step 2.4. Expected: PASS.

### Step 2.8 - Commit

```bash
git add apps/api/src/statlocker-adaptive/build-archetype-quality-gate-v2.service.ts apps/api/src/statlocker-adaptive/build-archetype-selector-v2.service.ts apps/api/src/statlocker-adaptive/statlocker-build-v2.config.ts apps/api/test/build-archetype-quality-gate-v2.spec.ts apps/api/test/build-archetype-selector-v2.spec.ts
git commit -m "feat(strategy-v2): gate and select family archetypes"
```

---

## Task 3: Add desired-build-state selection, CHOICE resolution, and optional-terminal WPA promotion

**Files**

- Create: `apps/api/src/statlocker-adaptive/build-desired-state-v2.service.ts`
- Create: `apps/api/test/build-desired-state-v2.spec.ts`
- Modify: `apps/api/src/statlocker-adaptive/build-item-utility-v2.service.ts`
- Modify: `apps/api/src/statlocker-adaptive/statlocker-build-v2.config.ts`

### Step 3.1 - RED: default terminal remains default on weak evidence

For one REQUIRED family with C default and D optional, provide low/noisy incremental D evidence and assert C stays selected.

### Step 3.2 - RED: strong Statlocker WPA promotes optional terminal

With the same family, give D strong sufficiently confident exact-enemy WPA and assert:

```ts
expect(result.families[0]).toMatchObject({
  selectedTerminalItemId: D,
  selectedTerminalKind: 'OPTIONAL_TERMINAL',
});
expect(result.families[0].reasonCodes).toContain('OPTIONAL_TERMINAL_WPA_SELECTED');
```

### Step 3.3 - RED: CHOICE selects only the required alternatives

Create `CHOICE(X, Y)` with `minSelect=1,maxSelect=1`. Give Y stronger exact-enemy value. Assert only Y enters desired state.

### Step 3.4 - RED: OPTIONAL/SITUATIONAL fill only remaining capacity

Create:

- 8 REQUIRED families;
- one CHOICE group requiring one family;
- four OPTIONAL/SITUATIONAL families.

Capacity = 12. Assert desired state always includes the 9 mandatory slots and selects at most 3 optional/situational families. Give one candidate utility below the existing buy-improvement floor and assert the planner may intentionally leave a slot unused rather than add negative/noisy value.

### Step 3.5 - Verify RED

```bash
yarn workspace @deadlock-live-probe/api test --runTestsByPath test/build-desired-state-v2.spec.ts
```

Expected: FAIL because desired-state service does not exist.

### Step 3.6 - Add desired-state contracts and policy

Define:

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

Initialize optional-terminal promotion policy from existing V2 scales:

```ts
optionalTerminal: {
  minImprovement: 0.08,
  minConfidence: 0.35,
}
```

These values reuse the existing V2 plan-switch and matchup-confidence scales; if frozen Billy evidence exposes a bad calibration, change them only with a focused regression.

### Step 3.7 - Implement desired state in this order

1. include all REQUIRED families at their default terminal;
2. resolve each CHOICE group according to `minSelect/maxSelect` using current Statlocker/WPA utility;
3. evaluate OPTIONAL_TERMINAL promotion only within already-selected families and only against that family's default terminal;
4. rank OPTIONAL/SITUATIONAL families for remaining capacity using Statlocker-backed utility;
5. add only candidates that clear existing buy/improvement/confidence policy;
6. include accepted outside-archetype candidates later through Task 6, never by catalog discovery.

This service returns goals only. It must not generate BUY/UPGRADE/REPLACE actions.

### Step 3.8 - GREEN

Run Step 3.5. Expected: PASS.

### Step 3.9 - Commit

```bash
git add apps/api/src/statlocker-adaptive/build-desired-state-v2.service.ts apps/api/test/build-desired-state-v2.spec.ts apps/api/src/statlocker-adaptive/build-item-utility-v2.service.ts apps/api/src/statlocker-adaptive/statlocker-build-v2.config.ts
git commit -m "feat(strategy-v2): select desired family terminals"
```

---

## Task 4: Replace sticky completion with current family satisfaction and semantic validation

**Files**

- Create: `apps/api/src/statlocker-adaptive/build-family-satisfaction-v2.ts`
- Create: `apps/api/src/statlocker-adaptive/full-build-semantic-validator-v2.service.ts`
- Create: `apps/api/test/build-family-satisfaction-v2.spec.ts`
- Create: `apps/api/test/full-build-semantic-validator-v2.spec.ts`
- Modify: `apps/api/src/statlocker-adaptive/full-build-plan-v2.ts`

### Step 4.1 - RED: current-inventory family status

For `A -> B -> C -> D`, assert:

- B held -> `IN_PROGRESS`
- C held -> `DEFAULT_TERMINAL_SATISFIED`
- D held -> `OPTIONAL_TERMINAL_SATISFIED`
- none held -> `UNSATISFIED`

### Step 4.2 - RED: no sticky completion

Start with REQUIRED X satisfied by C. Apply a REPLACE that removes C for another family's Y. Assert final X is UNSATISFIED and validation contains `REQUIRED_FAMILY_REGRESSION`.

### Step 4.3 - RED: anti-churn

Validate:

```text
BUY X
REPLACE X -> Y
```

Assert:

```ts
expect(validation.valid).toBe(false);
expect(validation.reasonCodes).toContain('IMMEDIATE_BUY_REPLACE_CHURN');
```

Control case:

```text
BUY A
UPGRADE A -> B
```

must be valid and must not count as churn.

### Step 4.4 - Verify RED

```bash
yarn workspace @deadlock-live-probe/api test --runTestsByPath test/build-family-satisfaction-v2.spec.ts test/full-build-semantic-validator-v2.spec.ts
```

Expected: FAIL because the pure satisfaction evaluator and semantic validator do not exist.

### Step 4.5 - Implement pure current satisfaction

Add:

```ts
export type BuildFamilySatisfactionStatusV2 =
  | 'UNSATISFIED'
  | 'IN_PROGRESS'
  | 'DEFAULT_TERMINAL_SATISFIED'
  | 'OPTIONAL_TERMINAL_SATISFIED';
```

`evaluateBuildFamilySatisfactionV2()` receives only archetype, current inventory, and graph. Historical ownership is not an input.

### Step 4.6 - Implement semantic validator

Add reasons:

```ts
'REQUIRED_FAMILY_UNSATISFIED'
'CHOICE_BOUNDS_UNSATISFIED'
'REQUIRED_FAMILY_REGRESSION'
'IMMEDIATE_BUY_REPLACE_CHURN'
'POINTLESS_PURCHASE_CHURN'
'UNSUPPORTED_STRATEGIC_TERMINAL'
```

Rules:

- final projected inventory satisfies every desired REQUIRED family;
- final CHOICE selections satisfy min/max;
- REQUIRED satisfied-family count cannot decrease at any step;
- a purchased item may disappear only if a legal UPGRADE consumes it in this first implementation;
- every selected terminal is a Statlocker-observed terminal candidate of its family.

### Step 4.7 - Extend `ResolvedFullBuildPlanV2`

Keep combined `validation` for existing consumers, and add explicit layers:

```ts
export interface ResolvedFullBuildPlanV2 {
  planRevision: string;
  matchId: string;
  heroId: number;
  archetypeId: string;
  stateRevision: string;
  steps: readonly FullBuildStepV2[];
  desiredState: DesiredBuildStateV2;
  degradedReasons: readonly string[];
  mechanicalValidation: FullBuildValidationV2;
  semanticValidation: FullBuildSemanticValidationV2;
  validation: FullBuildValidationV2;
}
```

Combined `validation.valid` is true only when both layers are valid.

### Step 4.8 - GREEN

Run Step 4.4. Expected: PASS.

### Step 4.9 - Commit

```bash
git add apps/api/src/statlocker-adaptive/build-family-satisfaction-v2.ts apps/api/src/statlocker-adaptive/full-build-semantic-validator-v2.service.ts apps/api/test/build-family-satisfaction-v2.spec.ts apps/api/test/full-build-semantic-validator-v2.spec.ts apps/api/src/statlocker-adaptive/full-build-plan-v2.ts
git commit -m "feat(strategy-v2): validate current family satisfaction"
```

---

## Task 5: Implement family-aware transaction planning and one-slot Deadlock upgrades

**Files**

- Create: `apps/api/src/statlocker-adaptive/full-build-transaction-planner-v2.service.ts`
- Create: `apps/api/test/full-build-transaction-planner-v2.spec.ts`
- Modify only if mechanics regression proves necessary: `apps/api/src/statlocker-adaptive/full-build-inventory-simulator-v2.ts`
- Modify: `apps/api/test/full-build-inventory-simulator-v2.spec.ts`
- Modify: `apps/api/src/statlocker-adaptive/full-build-resolver-v2.service.ts`
- Modify: `apps/api/test/full-build-resolver-v2.spec.ts`
- Modify: `apps/api/test/full-build-resolver-v2-lifetime.spec.ts`
- Modify: `apps/api/test/full-build-resolver-v2-replacement.spec.ts`
- Modify: `apps/api/test/full-build-lifetime-ranked-fallback-v2.spec.ts`
- Replace/delete old semantic regression: `apps/api/test/full-build-lifetime-mandatory-core-v2.spec.ts`

### Step 5.1 - RED: 12/12 executable upgrade remains 12/12

Capacity = 12. Inventory has 12 items including C. `C -> D` is a legal observed lineage and desired terminal is D. Assert first step:

```ts
expect(plan.steps[0]).toMatchObject({
  action: 'UPGRADE',
  buyItemId: D,
});
expect(plan.steps[0].consumedItemIds).toEqual([C]);
expect(plan.steps[0].inventoryBefore).toHaveLength(12);
expect(plan.steps[0].inventoryAfter).toHaveLength(12);
```

Assert no REPLACE and no `LIFETIME_PROGRESS_BLOCKED` solely due to full inventory.

### Step 5.2 - RED: full lineage uses BUY once then UPGRADE

From empty inventory and desired D on `A -> B -> C -> D`:

```ts
expect(plan.steps.map((step) => [step.action, step.buyItemId])).toEqual([
  ['BUY', A],
  ['UPGRADE', B],
  ['UPGRADE', C],
  ['UPGRADE', D],
]);
```

When desired terminal is C, assert plan stops at C.

### Step 5.3 - RED: optional family cannot destroy REQUIRED state

At full capacity, make OPTIONAL Z attractive but make the only possible slot source the terminal of satisfied REQUIRED X. Assert no accepted replacement and trace reason includes `REQUIRED_FAMILY_REGRESSION`.

### Step 5.4 - Verify RED

```bash
yarn workspace @deadlock-live-probe/api test --runTestsByPath test/full-build-transaction-planner-v2.spec.ts test/full-build-inventory-simulator-v2.spec.ts test/full-build-resolver-v2.spec.ts test/full-build-resolver-v2-lifetime.spec.ts test/full-build-resolver-v2-replacement.spec.ts test/full-build-lifetime-ranked-fallback-v2.spec.ts
```

Expected: FAIL because current resolver uses flat one-target planning, sticky `completedSemanticItemIds`, and mandatory-core replacement override.

### Step 5.5 - Implement observed lineage path search

Within one selected family:

- find currently held family node, if any;
- find shortest legal path through Statlocker-observed progression nodes to `selectedTerminalItemId`;
- direct next descendant must have a legal graph recipe that consumes the currently held ancestor;
- emit `UPGRADE` with that recipe;
- do not check for an empty slot before an executable one-slot UPGRADE;
- reject path if the next strategic node is not Statlocker-observed or mechanics are not legal.

### Step 5.6 - Implement BUY entry and cross-family REPLACE

If selected family has no held ancestor:

- BUY earliest Statlocker-observed purchasable entry when capacity is available;
- when capacity is full, enumerate legal cross-family REPLACE candidates;
- mechanically simulate candidate state;
- recompute semantic family satisfaction;
- hard-reject candidate if REQUIRED count decreases or CHOICE bounds break;
- only then compare resulting whole-build utility and transition cost.

Remove from `full-build-resolver-v2.service.ts`:

- `mandatoryCore`
- `MANDATORY_CORE_PROGRESSION_REPLACEMENT`
- marginal-gain threshold override whose sole purpose is touching every raw CORE item.

### Step 5.7 - Refactor resolver into orchestration facade

`FullBuildResolverV2Service` should:

1. resolve `DesiredBuildStateV2` once per plan revision;
2. call family-aware transaction planner;
3. run existing mechanical simulator;
4. run semantic validator;
5. combine validation and degraded reasons;
6. apply existing plan hysteresis without allowing hysteresis to override semantic hard rejections.

Keep the old transition-evaluation overload only if an actual remaining call site requires it. Otherwise remove dead compatibility rather than preserving two planner semantics.

### Step 5.8 - Replace the old mandatory-core regression

Delete `apps/api/test/full-build-lifetime-mandatory-core-v2.spec.ts` after adding equivalent mechanics coverage elsewhere. Its replacement regression must assert a satisfied REQUIRED family is not sacrificed merely to touch another raw CORE item.

### Step 5.9 - GREEN

Run Step 5.4. Expected: PASS.

### Step 5.10 - Commit

```bash
git add apps/api/src/statlocker-adaptive/full-build-transaction-planner-v2.service.ts apps/api/src/statlocker-adaptive/full-build-resolver-v2.service.ts apps/api/src/statlocker-adaptive/full-build-inventory-simulator-v2.ts apps/api/test/full-build-transaction-planner-v2.spec.ts apps/api/test/full-build-inventory-simulator-v2.spec.ts apps/api/test/full-build-resolver-v2.spec.ts apps/api/test/full-build-resolver-v2-lifetime.spec.ts apps/api/test/full-build-resolver-v2-replacement.spec.ts apps/api/test/full-build-lifetime-ranked-fallback-v2.spec.ts apps/api/test/full-build-lifetime-mandatory-core-v2.spec.ts
git commit -m "refactor(strategy-v2): plan family-aware lifetime transactions"
```

---

## Task 6: Integrate outside candidates, hysteresis, trace, and runtime orchestration

**Files**

- Modify: `apps/api/src/statlocker-adaptive/adaptive-recommendation-v2.service.ts`
- Modify: `apps/api/src/statlocker-adaptive/full-build-hysteresis-v2.service.ts`
- Modify: `apps/api/src/statlocker-adaptive/matchup-candidate-discovery-v2.service.ts`
- Modify: `apps/api/src/statlocker-adaptive/build-decision-trace-v2.ts`
- Modify: `apps/api/src/statlocker-adaptive/build-debug-trace-store-v2.service.ts` only if typed trace storage shape requires it
- Modify: `apps/api/test/adaptive-recommendation-v2.e2e.spec.ts`
- Modify: `apps/api/test/full-build-hysteresis-v2.spec.ts`
- Modify: `apps/api/test/matchup-candidate-discovery-v2.spec.ts`

### Step 6.1 - RED: runtime response contains desired state + semantic validation

Extend `adaptive-recommendation-v2.e2e.spec.ts`:

```ts
expect(result.fullBuild?.desiredState).toBeDefined();
expect(result.fullBuild?.semanticValidation.valid).toBe(true);
expect(result.nextAction.type).toBe(result.fullBuild?.steps[0].action);
```

Issue a second request for the same match. Assert lock/archetype ID is unchanged while a material live/WPA change may alter optional terminal or CHOICE decision inside that archetype.

### Step 6.2 - RED: previous-plan hysteresis is actually wired

Store previous full plan in `BuildDebugTraceStoreV2Service`, then recompute with tiny improvement. Assert near-term plan is held. Recompute with improvement above policy and assert switch is accepted.

### Step 6.3 - RED: outside candidate cannot break required families

Provide a Statlocker-backed outside candidate with strong WPA but no free optional slot except by breaking a REQUIRED family. Assert it is not selected.

### Step 6.4 - Verify RED

```bash
yarn workspace @deadlock-live-probe/api test --runTestsByPath test/adaptive-recommendation-v2.e2e.spec.ts test/full-build-hysteresis-v2.spec.ts test/matchup-candidate-discovery-v2.spec.ts
```

Expected: FAIL until desired-state/semantic fields and previous-plan wiring are propagated.

### Step 6.5 - Integrate outside candidates as situational desired-state competitors

Keep existing Statlocker provenance/coverage/confidence gates. Outside candidates compete only for OPTIONAL/SITUATIONAL capacity. They cannot reduce REQUIRED satisfaction or mutate the immutable archetype ID.

### Step 6.6 - Wire previous plan into hysteresis

Read existing trace/plan before resolving the new plan:

```ts
const previousPlan = this.traceStore.get(matchId)?.finalPlan;
```

Pass previous plan/revision through resolver/hysteresis. Near-term committed actions retain stronger protection than distant future changes. Semantic invalidity remains a hard reject, not a score penalty.

### Step 6.7 - Add typed trace stages

Extend stage union with:

```ts
'DESIRED_STATE'
'SEMANTIC_VALIDATION'
```

`DESIRED_STATE` exposes:

- family requirement;
- selected CHOICE families;
- selected terminal and kind;
- optional-terminal WPA promote/reject evidence;
- score/confidence/reason codes.

`PLAN_SEARCH` and `REPLACEMENT_SEARCH` expose family-regression rejection. `SEMANTIC_VALIDATION` exposes final family states and validation reason codes.

### Step 6.8 - GREEN

Run Step 6.4. Expected: PASS.

### Step 6.9 - Commit

```bash
git add apps/api/src/statlocker-adaptive/adaptive-recommendation-v2.service.ts apps/api/src/statlocker-adaptive/full-build-hysteresis-v2.service.ts apps/api/src/statlocker-adaptive/matchup-candidate-discovery-v2.service.ts apps/api/src/statlocker-adaptive/build-decision-trace-v2.ts apps/api/src/statlocker-adaptive/build-debug-trace-store-v2.service.ts apps/api/test/adaptive-recommendation-v2.e2e.spec.ts apps/api/test/full-build-hysteresis-v2.spec.ts apps/api/test/matchup-candidate-discovery-v2.spec.ts
git commit -m "feat(strategy-v2): integrate desired-state runtime planning"
```

---

## Task 7: Propagate family semantics through shared V2 API and production debugger

**Files**

- Modify: `packages/shared/src/adaptive-recommendation-v2.ts`
- Modify: `packages/shared/src/index.ts`
- Modify: `apps/api/src/statlocker-adaptive/adaptive-recommendation-v2.service.ts`
- Modify: `apps/api/src/build-debug-v2/build-debug-v2.client.ts`
- Modify: `apps/api/src/build-debug-v2/build-debug-v2.ui.ts`
- Modify: `apps/api/test/adaptive-recommendation-v2.e2e.spec.ts`
- Modify: `apps/api/test/build-debug-v2.e2e.spec.ts`

### Step 7.1 - RED: shared/API contract exposes both semantic and mechanical truth

Assert `fullBuild` contains:

```ts
expect(result.fullBuild).toMatchObject({
  desiredState: expect.any(Object),
  mechanicalValidation: { valid: true },
  semanticValidation: { valid: true },
  validation: { valid: true },
});
```

Every desired family row must expose family ID, requirement/group context, selected terminal item ID/kind, score/confidence, and reason codes.

### Step 7.2 - RED: debugger UI exposes family decisions

Extend debugger E2E to require visible/renderable labels/sections for:

```text
Family progression
REQUIRED / CHOICE / OPTIONAL / SITUATIONAL
Default terminal
Optional terminal WPA decision
Desired build state
Semantic validation
Anti-churn / family-regression rejection
```

### Step 7.3 - Verify RED

```bash
yarn workspace @deadlock-live-probe/api test --runTestsByPath test/adaptive-recommendation-v2.e2e.spec.ts test/build-debug-v2.e2e.spec.ts
yarn workspace @deadlock-live-probe/shared build
```

Expected: FAIL until shared contracts and debugger rendering are updated.

### Step 7.4 - Extend shared V2 types

Extend `AdaptiveFullBuildPlanV2` with JSON-safe desired-state and semantic-validation summaries while preserving existing ordered `steps`, `degradedReasons`, and combined `validation`.

Do not make Overwolf reconstruct family state from reason strings.

### Step 7.5 - Map API and debugger

Map family IDs/requirements/terminal decisions and both validation layers in `AdaptiveRecommendationV2Service`. Update debugger to consume typed trace/API fields directly.

### Step 7.6 - GREEN

Run Step 7.3. Expected: PASS.

### Step 7.7 - Commit

```bash
git add packages/shared/src/adaptive-recommendation-v2.ts packages/shared/src/index.ts apps/api/src/statlocker-adaptive/adaptive-recommendation-v2.service.ts apps/api/src/build-debug-v2/build-debug-v2.client.ts apps/api/src/build-debug-v2/build-debug-v2.ui.ts apps/api/test/adaptive-recommendation-v2.e2e.spec.ts apps/api/test/build-debug-v2.e2e.spec.ts
git commit -m "feat(strategy-v2): expose family-first build diagnostics"
```

---

## Task 8: Reopen original Task 17 and prove the corrected pipeline on frozen Billy data

**Files**

- Modify: `apps/api/test/statlocker-build-v2-real-data.e2e.spec.ts`
- Read-only input: `apps/api/test/fixtures/statlocker-build-v2/billy-real.fixture.json`
- Read-only request: `apps/api/test/fixtures/statlocker-build-v2/billy-real.request.json`
- Do not create yet: `apps/api/test/fixtures/statlocker-build-v2/billy-real.expected.json`

### Step 8.1 - Replace obsolete CORE-history assertions

Assert at minimum:

```ts
expect(fixture.proBuildAnalyses).toHaveLength(10);
expect(fixture.request.enemyHeroIds).toHaveLength(6);
expect(result.fullBuild?.mechanicalValidation.valid).toBe(true);
expect(result.fullBuild?.semanticValidation.valid).toBe(true);
expect(result.fullBuild?.validation.valid).toBe(true);
expect(result.nextAction.type).toBe(result.fullBuild?.steps[0].action);
```

Additionally assert:

- build evidence/provenance remains Statlocker-only;
- all strategic terminal candidates are Statlocker-observed;
- minimum required occupancy <= request capacity;
- every REQUIRED family is final-satisfied;
- every CHOICE group satisfies min/max;
- no `REQUIRED_FAMILY_REGRESSION`;
- no `IMMEDIATE_BUY_REPLACE_CHURN` or `POINTLESS_PURCHASE_CHURN`;
- every UPGRADE consumes its held ancestor atomically;
- every projected inventory length <= 12;
- every REPLACE has sell/buy IDs;
- immutable lock is reused on second request;
- trace includes original required stages plus `DESIRED_STATE` and `SEMANTIC_VALIDATION`.

Delete any assertion whose only meaning is "every raw CORE item appeared at least once somewhere in the trajectory".

### Step 8.2 - Expand stable human-readable report

Between existing markers print:

```text
BUILD_V2_E2E_REPORT_START
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
BUILD_V2_E2E_REPORT_END
```

The actual values come from the test run; do not hardcode a desired Billy answer before execution.

### Step 8.3 - Run real Billy E2E

```bash
yarn workspace @deadlock-live-probe/api test --runTestsByPath test/statlocker-build-v2-real-data.e2e.spec.ts
```

Expected: complete family-first plan and report. If a focused invariant fails or the build is strategically poor, stop and repair the responsible earlier task with a focused RED test. Do not weaken the E2E.

### Step 8.4 - Hard human gate

Present the exact report to the user including selected archetype/families, WPA evidence, every transaction, final inventory, mechanical validation, and semantic validation.

**STOP. Do not create `billy-real.expected.json` and do not start production cutover until the user explicitly approves that actual report.**

### Step 8.5 - After approval, commit corrected E2E behavior

```bash
git add apps/api/test/statlocker-build-v2-real-data.e2e.spec.ts
git commit -m "test(strategy-v2): validate family-first Billy build"
```

---

## Task 9: Freeze the approved Billy golden and resume original Task 18 production cutover

**Files**

- Create: `apps/api/test/fixtures/statlocker-build-v2/billy-real.expected.json`
- Modify: `apps/api/test/statlocker-build-v2-real-data.e2e.spec.ts`
- Modify: `apps/overwolf-client/src/adaptive-recommendation-client.ts`
- Modify: `apps/overwolf-client/src/adaptive-recommendation-client.spec.ts`
- Modify: `apps/overwolf-client/src/adaptive-recommendation-full-build-client.integration.spec.ts`
- Modify: `apps/overwolf-client/src/adaptive-recommendation-full-build-path.spec.ts`
- Modify: `apps/api/src/statlocker-adaptive/statlocker-adaptive.module.ts`
- Modify/retire from serving path as required:
  - `apps/api/src/statlocker-adaptive/adaptive-recommendation-v1.controller.ts`
  - `apps/api/src/statlocker-adaptive/adaptive-recommendation-v1.service.ts`
  - `apps/api/src/statlocker-adaptive/adaptive-planner-serving-router-v1.service.ts`
  - `apps/api/src/statlocker-adaptive/build-archetype-miner-v1.service.ts`
  - `apps/api/src/statlocker-adaptive/build-contract-v1.service.ts`
  - `apps/api/src/statlocker-adaptive/build-strategy-compiler-v1.service.ts`
  - `apps/api/src/statlocker-adaptive/build-strategy-mining-pipeline-v1.service.ts`
  - `apps/api/src/statlocker-adaptive/build-strategy-selector-v1.service.ts`
  - `apps/api/src/statlocker-adaptive/build-strategy-session-v1.service.ts`
  - `apps/api/src/statlocker-adaptive/consensus-strategy-fallback-v1.service.ts`
  - `apps/api/src/statlocker-adaptive/strategy-first-adaptive-planner-facade-v1.service.ts`
  - `apps/api/src/statlocker-adaptive/strategy-first-build-planner-v1.service.ts`
  - `apps/api/src/statlocker-adaptive/strategy-first-situational-overlay-v1.service.ts`
- Create: `apps/api/test/adaptive-recommendation-v2-production-wiring.spec.ts`

### Step 9.1 - Freeze only the exact approved Billy semantics

Create `billy-real.expected.json` by copying deterministic facts from the user-approved Task 8 report. Store:

- selected archetype ID;
- ordered desired family IDs and selected terminal item IDs/kinds;
- selected CHOICE family IDs per group;
- ordered action semantic keys (`BUY:item`, `UPGRADE:item:recipe`, `REPLACE:sell->buy`);
- final required/choice satisfaction summary;
- mechanical validation = true;
- semantic validation = true.

Do not invent values and do not auto-generate the golden during ordinary CI. The exact values must be the ones already approved by the user in Task 8.

### Step 9.2 - Add deterministic golden comparison

Run:

```bash
yarn workspace @deadlock-live-probe/api test --runTestsByPath test/statlocker-build-v2-real-data.e2e.spec.ts
```

Expected: PASS and emitted report matches the approved golden.

### Step 9.3 - RED: Overwolf must use V2 and preserve full lifetime path

Update client tests first. Assert:

- request/result types are V2;
- URL is `/deadlock/adaptive/v2/recommend`;
- ordered BUY/UPGRADE/REPLACE steps are preserved;
- REPLACE preserves both `sellItemId` and `buyItemId`;
- a 15-step plan remains 15 steps even when simultaneous capacity is 12;
- `nextAction` remains separate from full future plan.

Run:

```bash
yarn workspace @deadlock-live-probe/overwolf-client test
```

Expected: FAIL because current client imports V1 and calls `/deadlock/adaptive/v1/recommend`.

### Step 9.4 - Switch Overwolf client to V2

In `adaptive-recommendation-client.ts` use:

```ts
AdaptiveRecommendationRequestV2
AdaptiveRecommendationResultV2
```

and:

```ts
`${this.apiBaseUrl}/deadlock/adaptive/v2/recommend`
```

Keep debounce/retry/cancellation semantics unchanged. Presentation consumes `fullBuild.steps` as the full lifetime trajectory and `nextAction` as immediate action. Never truncate the trajectory to held-item capacity.

### Step 9.5 - RED: production serving wiring has no V1 fallback authority

Create `adaptive-recommendation-v2-production-wiring.spec.ts` that instantiates production module wiring and asserts:

- `AdaptiveRecommendationV2Controller` resolves through `AdaptiveRecommendationV2Service`;
- a V2 not-ready/error path does not invoke `ConsensusStrategyFallbackV1Service`, `BuildStrategyCompilerV1Service`, or `StrategyFirstBuildPlannerV1Service`;
- no V1 plan/result is mapped into the V2 response.

### Step 9.6 - Remove V1 serving authority

Update `statlocker-adaptive.module.ts` and V1 route/service registration so production recommendation serving does not call V1 planner/compiler/fallback services. Old files may remain for historical tests/tools, but they are not production fallback.

The V1 controller may be retired or kept only as an explicitly legacy endpoint; Overwolf production path must not call it and V2 failures must not route into it.

### Step 9.7 - Verify cutover

```bash
yarn workspace @deadlock-live-probe/api test --runTestsByPath test/adaptive-recommendation-v2.e2e.spec.ts test/adaptive-recommendation-v2-production-wiring.spec.ts test/statlocker-build-v2-real-data.e2e.spec.ts
yarn workspace @deadlock-live-probe/overwolf-client test
```

Expected: PASS.

### Step 9.8 - Commit

```bash
git add apps/api/test/fixtures/statlocker-build-v2/billy-real.expected.json apps/api/test/statlocker-build-v2-real-data.e2e.spec.ts apps/api/test/adaptive-recommendation-v2-production-wiring.spec.ts apps/overwolf-client/src apps/api/src/statlocker-adaptive/statlocker-adaptive.module.ts apps/api/src/statlocker-adaptive/adaptive-recommendation-v1.controller.ts apps/api/src/statlocker-adaptive/adaptive-recommendation-v1.service.ts apps/api/src/statlocker-adaptive/adaptive-planner-serving-router-v1.service.ts
git commit -m "feat(strategy-v2): approve Billy build and cut client to V2"
```

If additional V1 registration files were changed in Step 9.6, add those exact changed paths to the commit as well; do not stage unrelated V1 code.

---

## Task 10: Finish original Task 19 production-readiness verification

**Files**

- Modify only when verification exposes a scoped defect.
- Review: `docs/superpowers/specs/2026-09-11-statlocker-build-strategy-v2-family-first-design.md`
- Review: `docs/superpowers/plans/2026-09-11-statlocker-build-strategy-v2-family-first.md`

### Step 10.1 - Focused family/planner release gate

```bash
yarn workspace @deadlock-live-probe/api test --runTestsByPath test/build-archetype-compiler-v2.spec.ts test/build-archetype-quality-gate-v2.spec.ts test/build-archetype-selector-v2.spec.ts test/build-desired-state-v2.spec.ts test/build-family-satisfaction-v2.spec.ts test/full-build-transaction-planner-v2.spec.ts test/full-build-semantic-validator-v2.spec.ts test/full-build-inventory-simulator-v2.spec.ts test/full-build-resolver-v2.spec.ts test/statlocker-vs-hero-wpa-v2.integration.spec.ts test/statlocker-build-v2-real-data.e2e.spec.ts
```

Expected: PASS.

### Step 10.2 - Complete API suite

```bash
yarn workspace @deadlock-live-probe/api test
```

Expected: PASS.

### Step 10.3 - Complete Overwolf suite

```bash
yarn workspace @deadlock-live-probe/overwolf-client test
```

Expected: PASS.

### Step 10.4 - Build all workspaces

```bash
yarn build
```

Expected: PASS.

### Step 10.5 - Validate migrations on disposable/test DB

```bash
yarn workspace @deadlock-live-probe/api migration:run
yarn workspace @deadlock-live-probe/api migration:show
```

Expected: V2 snapshot/match-lock migration is applied and no required V2 migration remains pending. Add a new migration only if family-first changes require concrete DB schema columns rather than the existing serialized snapshot payload.

### Step 10.6 - Production-like debugger smoke test

Start API with non-secret local values for `BUILD_DEBUG_PASSWORD` and `BUILD_DEBUG_SESSION_SECRET`. In browser:

1. open `/debug/build-v2`;
2. authenticate;
3. select a trace/match;
4. verify family progression, requirement classification, terminal decisions, optional-terminal WPA promote/reject, desired state, transaction branches, final plan, mechanical validation, and semantic validation are visible;
5. in an unauthenticated/private context request `/debug/build-v2/matches` and verify HTTP 401.

### Step 10.7 - Verify no V1 production fallback

Run `adaptive-recommendation-v2-production-wiring.spec.ts` plus a V2 not-ready/error case. Confirm no V1 compiler/planner/fallback service is invoked and no V1 plan appears in V2 response/trace.

### Step 10.8 - Inspect one production-like recommendation end-to-end

Verify:

```text
valid V2 archetype snapshot
immutable match lock
VS_HERO_WPA query activity nonzero when rows exist
family-first desired state present
full lifetime plan not truncated to capacity
12/12 executable upgrades legal
no immediate buy-replace churn
mechanical validation PASS
semantic validation PASS
no V1 fallback
```

### Step 10.9 - Show final approved Billy report again

Paste the exact current report with every BUY/UPGRADE/REPLACE step and final inventory. If it differs from approved golden or is visibly poor, reopen the responsible task instead of claiming completion.

### Step 10.10 - Verification-only fixes and clean state

For each scoped defect found during Tasks 10.1-10.8:

1. add a focused RED regression;
2. implement only the root-cause fix;
3. rerun focused test and affected release gate;
4. commit separately.

Finish with:

```bash
git status --short
```

Expected: empty output.

---

## Plan self-review

- **Old roadmap preserved:** already-built V2 source/mining/lock/WPA/persistence/trace/debugger/API/fixture work is reused. Old Task 17 is explicitly reopened. Old Task 18 is resumed only after Billy approval. Old Task 19 remains the final release gate.
- **No placeholder golden:** the plan never invents Billy IDs/actions. Golden values are copied only after the actual report has been approved.
- **Exact migration commands:** `migration:run` and `migration:show` are the scripts defined by `apps/api/package.json`.
- **Exact cutover scope:** the plan names the current V1 controller/service/router and the known V1 strategy authorities that must lose production serving authority, while allowing untouched historical files to remain for tests/tools.
- **Source boundary:** every strategic terminal requires Statlocker evidence; catalog mechanics cannot create strategy.
- **Family semantics:** raw frequency, final requirement, and progression role are separate. One upgrade lineage consumes one final slot.
- **Upgrade mechanics:** full inventory does not block atomic one-slot `UPGRADE C -> D`.
- **No sticky completion:** semantic truth comes from current projected inventory.
- **No churn:** immediate buy-replace and required-family regression are both hard semantic failures.
- **Human gate:** Billy golden and Overwolf cutover are blocked until explicit user approval of the real corrected build report.
