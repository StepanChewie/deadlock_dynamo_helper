# Statlocker Build Strategy V2 - Family-First Lifetime Build Design

Date: 2026-09-11
Status: Approved design pending written-spec review
Scope: Correct the semantic/full-build portion of Statlocker Build Strategy V2, reconcile the unfinished Billy roadmap, and preserve all still-valid V2 production requirements.

## 1. Relationship to the existing V2 design and roadmap

This document is a continuation of:

- `docs/superpowers/specs/2026-09-10-statlocker-build-strategy-v2-design.md`
- `docs/superpowers/plans/2026-09-10-statlocker-build-strategy-v2.md`

It does not create a parallel recommendation architecture.

The original V2 direction remains correct in these areas:

- build evidence is Statlocker-only
- top-10 `HERO_LEADERBOARD` -> `PRO_BUILD_ANALYSIS` sourcing
- profile-level semantic archetype mining instead of ordinal purchase-position alignment
- multiple archetypes only for coherent structural separation
- full enemy roster required for normal selection
- initial archetype selection by `VS_HERO_WPA`
- immutable per-match archetype lock
- runtime live adaptation only inside the lock
- Statlocker-backed outside-archetype candidates
- catalog/item graph used only for mechanics, legality, recipes, and family relationships
- persistent archetype snapshots and match locks
- structured decision trace
- password-protected read-only production debugger
- deterministic real Billy fixture
- no V1 positional fallback after production cutover

The original V2 model was incomplete in one critical area: it treated high-frequency archetype items as independent lifetime semantic goals and used sticky historical completion. Human review of the real Billy E2E exposed that this can generate mechanically legal but strategically meaningless churn, for example buying one item only to immediately replace it with another item merely to mark multiple `CORE` goals as completed.

This document replaces the old flat-item lifetime-goal semantics with family-first final-state semantics and a goal-first transaction planner.

## 2. Roadmap reconciliation

The old implementation roadmap remains authoritative except where explicitly superseded below.

### 2.1 Work that remains valid

Tasks 1-15 established the V2 infrastructure and remain useful: profile normalization, mining, compiler, quality gate, snapshot publication, WPA selector, immutable lock, utility scoring, outside candidates, mechanics simulator, trace/debugger, V2 API, and browser debugger.

These components may need contract updates and new regressions because the family-first model changes the semantic shape passed through compiler, scorer, trace, and resolver, but their product responsibilities remain valid.

Task 16 remains valid and is complete in principle: the branch contains the frozen real Billy request/fixture and deterministic capture tooling. The fixture remains the release-quality evidence source for the resumed E2E work.

### 2.2 Work reopened by human review

Task 17 is not complete.

The real Billy E2E reached the full V2 pipeline, but the produced lifetime build failed semantic human review. Therefore:

- no `billy-real.expected.json` may be frozen from the current output
- the current mandatory-core completion behavior is not an acceptance criterion
- the current test concept of "every CORE was satisfied at least once somewhere in the trajectory" is invalid
- Task 17 must be rerun only after the family-first compiler, desired-state selection, transaction planning, and semantic validation described here are implemented

The existing real-data fixture remains the input. The expected output must be frozen only after the new real build is printed and human-reviewed.

### 2.3 Work still pending from the old roadmap

Task 18 remains pending: production Overwolf client cutover to the V2 lifetime plan and removal of V1 runtime fallback authority must happen only after the corrected Billy Task 17 passes human review.

Task 19 remains pending: full regression, build, migration, debugger smoke test, production-readiness verification, and final real-build presentation remain the final release gate.

### 2.4 Combined continuation order

The implementation plan produced after this spec is reviewed must use this order:

1. Replace flat item-goal semantics with family-first archetype semantics.
2. Add default/optional terminal selection backed only by Statlocker evidence.
3. Add family requirement inference and terminal-capacity quality gating.
4. Replace sticky completion with current family satisfaction.
5. Add desired-build-state selection before transaction generation.
6. Replace one-target greedy lifetime planning with family-aware transaction planning.
7. Add semantic/anti-churn validators and focused regressions.
8. Rerun the frozen Billy full-pipeline E2E and human-review the actual build.
9. Freeze the Billy golden only after approval.
10. Resume old Task 18 production cutover.
11. Finish old Task 19 release verification.

## 3. Source authority

### 3.1 Strategic evidence

All strategic build evidence must come from Statlocker.

Allowed strategic sources:

- `HERO_LEADERBOARD`
- `PRO_BUILD_ANALYSIS`
- `VS_HERO_WPA`
- `WPA_PATCH_DATA`
- `T4_CHAINS`
- other already-approved Statlocker-derived evidence when the V2 ingestion path guarantees its provenance

The request supplies only live runtime context such as hero, enemies, inventory, souls, time, capacity, and live threat inputs. It does not provide build evidence.

### 3.2 Mechanics authority

The local/static catalog and `RecommendationItemGraph` may be used to answer only mechanical questions:

- which item upgrades from which ancestor
- whether an upgrade path is legal
- which recipe is executable
- direct-purchase legality
- ruleset availability
- capacity/max-copy legality

The catalog must never create a strategic target by itself.

If catalog says `C -> D` but Statlocker evidence for the selected hero/archetype contains no strategic evidence for D, D cannot become either a default or optional strategic terminal merely because it exists in the catalog.

## 4. Three independent semantic dimensions

The corrected model must never overload one label with three meanings.

### 4.1 Frequency

Raw empirical Statlocker usage remains:

```text
CORE | FREQUENT | SOMETIMES | FLEX
```

Frequency describes observed usage. It does not directly mean final-slot requirement.

### 4.2 Family requirement

Final-build structural requirement is separate:

```text
REQUIRED | CHOICE | OPTIONAL | SITUATIONAL
```

This applies to a semantic family or a choice over families, not to every observed item row.

### 4.3 Progression role

Position inside one upgrade family is separate:

```text
ENTRY | INTERMEDIATE | DEFAULT_TERMINAL | OPTIONAL_TERMINAL
```

One item can therefore be empirically `CORE`, be an `INTERMEDIATE` progression node, and belong to a `REQUIRED` family without being required to remain in the final inventory.

## 5. Family-first archetype model

### 5.1 Family identity

All catalog-related ancestors/descendants that represent the same upgrade lineage are one semantic family. Existing graph family canonicalization may be reused.

A family is one final-slot concept even if multiple tiers of that family are common in Statlocker data.

For example:

```text
A -> B -> C -> D
```

is one family, not four independent lifetime goals.

### 5.2 Family contract

The design target is conceptually equivalent to:

```ts
interface BuildArchetypeFamilyV2 {
  familyId: number;
  frequencyEvidence: BuildFamilyFrequencyEvidenceV2;
  requirement: BuildFamilyRequirementV2;
  progressionNodes: readonly BuildProgressionNodeV2[];
  terminalCandidates: readonly BuildTerminalCandidateV2[];
}
```

Exact TypeScript naming may follow existing repository conventions, but the semantic separation is mandatory.

### 5.3 Progression nodes

Each Statlocker-backed observed item in a family retains its own evidence:

- itemId
- source profile count
- profile coverage
- purchase rate
- median buy time/spread
- phase
- raw frequency tier
- relationships/groups where applicable

The compiler may use the catalog graph to order mechanically related observed nodes, but it may not manufacture unobserved strategic nodes.

## 6. Default and optional terminals

### 6.1 Default terminal

The default terminal is the normal stopping point for a family according to Statlocker evidence.

It is selected from Statlocker-backed descendants using evidence such as:

- cross-profile coverage
- purchase rate
- timing/phase progression
- consistency with observed ancestors/descendants
- relevant Statlocker T4 chain evidence when available

The exact numeric thresholds must be calibrated against real frozen Statlocker fixtures and centralized configuration. They must not be invented ad hoc inside individual services.

### 6.2 Rare descendant remains optional

A mechanically later descendant with real but low Statlocker usage must not be discarded.

Example:

```text
Catalog: A -> B -> C -> D

Statlocker cluster:
Player 1: A 98%, B 92%, C 80%, D 5%
Player 2: A 94%, B 89%, C 76%, D 8%
```

Correct semantics:

```text
A = ENTRY
B = INTERMEDIATE
C = DEFAULT_TERMINAL
D = OPTIONAL_TERMINAL
```

The family is already satisfied at C. D is an optional further upgrade candidate whose runtime value must be evaluated.

### 6.3 Optional-terminal runtime promotion

An optional terminal may replace the default terminal in the desired build only when Statlocker runtime evidence justifies the incremental upgrade.

Conceptually:

```text
incremental value of D over C
= matchup/WPA benefit
+ global Statlocker strength/timing evidence
+ chain/progression evidence
- transition/opportunity cost
```

Promotion requires sufficient confidence and a material improvement threshold. Tiny/noisy WPA differences must not trigger the optional upgrade.

If the threshold is not met, the desired terminal remains C.

### 6.4 Catalog-only descendant

If D has no strategic Statlocker evidence for the selected hero/archetype, it is not a strategic terminal candidate even if catalog says `C -> D`.

## 7. REQUIRED, CHOICE, OPTIONAL, and capacity

### 7.1 REQUIRED is family-level

`frequencyTier === CORE` is not sufficient to make an item an independent final requirement.

The compiler first collapses upgrade lineages into families. Requirement classification happens after family construction.

### 7.2 Explicit Statlocker groups

Explicit `REQUIRED`, `CHOICE`, and `OPTIONAL` group evidence has highest authority when internally consistent.

An explicit `CHOICE` with `minSelect=1` and `maxSelect=1` represents one final slot selected from alternatives, not multiple sequential mandatory goals.

### 7.3 Inferred requirements

Without explicit grouping, family requirements may be inferred conservatively from cross-profile consensus.

The compiler must prefer insufficient commitment over invented certainty:

- strong shared consensus may produce `REQUIRED`
- strong mutually exclusive alternative evidence may produce `CHOICE`
- weaker evidence remains `OPTIONAL` or `SITUATIONAL`

A raw `CORE` frequency vote alone must never force `REQUIRED`.

### 7.4 Conservative fallback

When evidence is insufficient to prove `REQUIRED` or `CHOICE`, keep the family optional/situational. It is better to publish eight well-supported required families than fourteen false mandatory item goals.

### 7.5 Terminal-capacity quality gate

Before publication compute minimum simultaneous required occupancy:

```text
required family count
+ sum(choiceGroup.minSelect)
```

It must satisfy:

```text
minimumRequiredOccupancy <= supported held-item capacity
```

If not, reject the archetype before it reaches the planner with a reason such as:

```text
TERMINAL_CAPACITY_CONFLICT
```

The planner must never be asked to solve an impossible final-state contract.

Unused capacity is allowed and is intentionally available for optional/situational matchup adaptation.

## 8. Desired build state precedes transaction planning

The runtime must first decide what it wants to end up with, then determine how to get there.

### 8.1 Desired family state

For every active required/selected family, desired-state selection determines:

- selected terminal item
- whether it is the default or optional terminal
- requirement/group membership
- selection reason codes
- Statlocker evidence supporting the choice

CHOICE resolution happens at this semantic layer. Only the selected branch enters the desired final state.

### 8.2 Separation of responsibilities

Semantic selection answers:

```text
What should the resulting build contain?
```

Transaction planning answers:

```text
What legal BUY / UPGRADE / REPLACE sequence reaches that state from the current inventory?
```

The transaction planner must not independently redefine strategic goals.

## 9. Current family satisfaction, not sticky completion

The lifetime planner must remove `completedSemanticItemIds` as the authoritative semantic truth.

Family satisfaction is recomputed from the current projected inventory after every transition.

Conceptually:

```text
UNSATISFIED
IN_PROGRESS
DEFAULT_TERMINAL_SATISFIED
OPTIONAL_TERMINAL_SATISFIED
```

Example for `A -> B -> C -> D`:

- B held -> `IN_PROGRESS`
- C held -> `DEFAULT_TERMINAL_SATISFIED`
- D held -> `OPTIONAL_TERMINAL_SATISFIED`
- family terminal sold with no satisfying descendant remaining -> `UNSATISFIED`

Historical ownership may be retained for diagnostics, but it must not satisfy final semantic requirements.

## 10. Deadlock upgrade mechanics

### 10.1 Atomic one-slot progression

For this design, Deadlock upgrade lineage is modeled as one owned ancestor upgraded atomically into its descendant:

```text
A -> B -> C -> D
```

The actions are:

```text
BUY A
UPGRADE A -> B
UPGRADE B -> C
UPGRADE C -> D
```

The owned ancestor is consumed and the descendant is obtained in the same atomic `UPGRADE` transition.

There is no strategic planning model where two independent held upgrade components are combined into a third result, such as `C + X -> D`, for this V2 progression design.

### 10.2 Capacity behavior

A normal upgrade consumes one occupied family slot and produces one occupied family slot:

```text
12/12 -> UPGRADE C -> D -> 12/12
```

Therefore a full inventory must never block an executable upgrade inside an existing family merely because there is no empty slot.

Capacity affects adding a new independent family via `BUY`, not one-slot lineage progression via `UPGRADE`.

### 10.3 Upgrade continuity

If the desired terminal is D and the inventory contains an ancestor on the legal Statlocker-backed path, the planner should continue that family progression rather than sell the ancestor and repurchase unrelated goals.

If B is held in `B -> C -> D` and D is desired, the natural plan is:

```text
UPGRADE B -> C
UPGRADE C -> D
```

subject to economy/timing policy and legal mechanics.

## 11. Transaction planner

### 11.1 Goal-first planning

The current one-target/one-action greedy loop is replaced by family-aware planning against the desired build state.

The planner may use bounded deterministic forward/branch search, but it evaluates meaningful transaction sequences and their resulting family satisfaction rather than marking individual item IDs complete one at a time.

### 11.2 BUY

A direct `BUY` adds a new independent family/progression entry and therefore requires capacity.

When capacity is full, adding a new independent family requires a justified `REPLACE` of an existing held item/family.

### 11.3 UPGRADE

When the desired state advances an already-held family ancestor, use a legal `UPGRADE` transition. Full inventory is not a reason to reject it.

An upgrade must not be represented as `SELL ancestor -> BUY descendant` when a legal upgrade path exists.

### 11.4 REPLACE

`REPLACE` is for deliberate cross-family inventory change, not recipe consumption.

Evaluate replacement at the resulting-build-state level. A branch is not good merely because the incoming item scores higher than the sold item locally.

The resulting state must preserve required family constraints or replace them with a semantically equivalent valid choice state.

### 11.5 Remove mandatory-core utility override

The current rule allowing an uncompleted `CORE` target to override the normal replacement marginal-gain threshold exists to force sticky historical completion and must be removed/replaced.

There is no valid policy where an arbitrary remaining `CORE` item may force a low-utility replacement merely so that every CORE item is owned once.

## 12. Monotonic required-family progress

Inside one generated lifetime plan, required-family satisfaction must not regress.

If family X is required and currently terminal-satisfied, a branch that sells X's terminal and leaves X unsatisfied is invalid unless the transition atomically produces another valid satisfying state for the same requirement/choice contract.

Reason code:

```text
REQUIRED_FAMILY_REGRESSION
```

Upgrading within the same family is not regression:

```text
DEFAULT_TERMINAL_SATISFIED -> OPTIONAL_TERMINAL_SATISFIED
```

Likewise, a valid switch inside one CHOICE group may be allowed when the group remains satisfied and the complete resulting state clears the configured switch threshold.

An optional/situational family may never displace a required family if the result reduces required satisfaction.

## 13. Anti-churn semantics

### 13.1 Immediate churn

Within one generated lifetime plan, this is invalid unless the item was consumed by a legal upgrade:

```text
BUY X
REPLACE X -> Y
```

Reason:

```text
IMMEDIATE_BUY_REPLACE_CHURN
```

### 13.2 Pointless lifetime churn

A purchased item must either:

- remain part of the projected build state, or
- be consumed by progression within its upgrade family

The first family-first implementation does not invent unsupported "temporary purpose" semantics from aggregate Statlocker data.

A later runtime request may legitimately replan because live match state changed materially. That is a new plan revision and is distinct from pointless churn inside one generated lifetime trajectory.

### 13.3 Defense in depth

The planner should structurally avoid churn, and a separate semantic plan validator must reject churn if it somehow appears.

## 14. Validation

The final lifetime plan must pass both mechanical and semantic validation.

### 14.1 Mechanical validation

Reuse the item graph/inventory simulator for:

- known/available items
- legal direct purchase
- legal upgrade path/recipe
- ancestor consumption
- max copies
- capacity after every action
- explicit sell/buy IDs for replacement

### 14.2 Semantic validation

Add family-aware validation for:

- every REQUIRED family satisfied in final projected inventory
- every CHOICE group satisfies min/max bounds
- no required-family regression through the plan
- no immediate buy-replace churn
- no unsupported strategic terminal without Statlocker evidence
- selected optional terminals meet runtime-selection policy
- final minimum required occupancy contract is respected

A mechanically legal plan may still be semantically invalid.

## 15. Focused TDD regressions

Implementation must begin with failing focused tests that cover at least these behaviors.

### 15.1 Family compiler collapses upgrade lineage

Given `A -> B -> C` with multiple Statlocker frequency tiers, compile one family, not three independent final goals.

### 15.2 Rare descendant remains optional terminal

Given `A -> B -> C -> D` where C has strong normal usage and D has small but real Statlocker usage, compile C as default terminal and D as optional terminal.

### 15.3 Catalog-only descendant cannot become strategic

Given catalog `C -> D` but no Statlocker strategic evidence for D, do not publish D as a strategic terminal candidate.

### 15.4 Full-inventory upgrade

Given capacity 12, inventory length 12, C held, legal `C -> D`, and D selected as desired terminal, emit `UPGRADE C -> D`; inventory remains 12 before and after. Do not emit `REPLACE` and do not report lifetime progress blocked.

### 15.5 Complete upgrade chain

Given an empty inventory and desired terminal D on `A -> B -> C -> D`, produce:

```text
BUY A
UPGRADE A -> B
UPGRADE B -> C
UPGRADE C -> D
```

not independent BUY actions for every tier.

### 15.6 Default terminal stops progression

For the same family, if C is selected as desired terminal, stop at C and do not force D.

### 15.7 WPA may promote optional terminal

Low/noisy incremental evidence keeps C. Strong sufficiently confident Statlocker WPA evidence may promote D.

### 15.8 No sticky completion

If required family X is satisfied and a proposed replacement would leave X unsatisfied, reject it with `REQUIRED_FAMILY_REGRESSION` even if another required family becomes satisfied.

### 15.9 Immediate churn validator

A trajectory containing `BUY X -> REPLACE X -> Y` without upgrade consumption is semantically invalid with `IMMEDIATE_BUY_REPLACE_CHURN`.

### 15.10 Choice occupancy

A `CHOICE` group with two candidate families and `minSelect=1,maxSelect=1` consumes one minimum required final slot, not two.

### 15.11 Impossible archetype rejected before planner

If required families plus minimum choice occupancy exceed capacity, reject publication with `TERMINAL_CAPACITY_CONFLICT`.

### 15.12 Optional cannot destroy required state

At full capacity, an optional high-WPA family is rejected if the only way to add it makes a required family unsatisfied.

## 16. Billy real-data E2E - resumed Task 17

The frozen Billy fixture remains the canonical full-pipeline release fixture.

The E2E still executes:

```text
frozen request/live context
-> 10 Statlocker pro profiles
-> profile normalization
-> archetype mining
-> family-first compilation
-> quality gate/publication
-> VS_HERO_WPA archetype selection
-> immutable lock
-> live threat/candidate discovery
-> desired build state
-> transaction planner
-> mechanical simulator
-> semantic validator
-> API mapping
-> structured trace
```

### 16.1 E2E invariants

The real-data test must assert:

- exactly 10 Statlocker source analyses when fixture provides them
- build evidence source is Statlocker-only
- six request enemy hero IDs are preserved for the Billy fixture
- selected archetype lock is deterministic and reused immutably
- all strategic terminal candidates have Statlocker evidence
- minimum required occupancy does not exceed capacity
- all REQUIRED families are satisfied in final projected inventory
- all CHOICE min/max bounds are satisfied
- no required-family regression
- no immediate buy-replace churn
- every UPGRADE follows catalog mechanics and consumes its owned ancestor atomically
- executable one-slot upgrades work at full inventory
- projected inventory never exceeds capacity
- every REPLACE has explicit sell/buy IDs
- `nextAction` matches the first full-build step
- required trace stages are present

Do not require an arbitrary number of upgrades. If the actual frozen Statlocker-backed desired state contains a progression whose selected terminal is above a required ancestor, the E2E must then observe the corresponding UPGRADE semantics.

### 16.2 Human review remains a release gate

The test must print a stable report between:

```text
BUILD_V2_E2E_REPORT_START
BUILD_V2_E2E_REPORT_END
```

The report must show:

- source/profile provenance
- accepted archetypes and family semantics
- selected archetype and WPA selection evidence
- required/choice/optional families
- default vs optional terminal decisions and reasons
- full BUY/UPGRADE/REPLACE trajectory
- final inventory
- family satisfaction summary
- degraded evidence reasons
- inventory validation result
- semantic validation result

The actual report must be shown to the user separately and reviewed. If it is strategically poor, reopen the responsible focused stage. Do not weaken the E2E and do not freeze a golden merely because CI is green.

### 16.3 Golden output

Create/finalize `billy-real.expected.json` only after the corrected report is approved.

The golden should lock stable semantic identity/action expectations that are appropriate for deterministic fixture behavior without encoding invalid "every CORE was touched once" history semantics.

## 17. Trace/debugger updates

Preserve the existing trace/debugger architecture, but expose the new semantics clearly.

At minimum, trace/debugger data must make visible:

- family compilation and observed progression nodes
- requirement classification evidence
- default and optional terminal evidence
- terminal-capacity gate
- desired terminal selected per family
- optional-terminal WPA promotion/rejection
- family satisfaction before/after actions
- transaction branches
- required-family regression rejection
- anti-churn rejection
- final mechanical and semantic validation

Existing stage names may be reused where they remain meaningful. Add typed payload fields/reason codes rather than reconstructing family semantics from free-form strings.

## 18. Production cutover - resumed old Task 18

Only after the corrected Billy Task 17 is approved:

- switch Overwolf production recommendation consumption to the V2 lifetime contract
- preserve the full ordered BUY/UPGRADE/REPLACE trajectory instead of truncating to held capacity
- keep immediate `nextAction` separately available
- remove V1 positional strategy runtime fallback authority from the production recommendation path
- retain old files only when needed for historical tooling/tests, not as serving fallback

Add client regressions for upgrade presentation and a lifetime plan whose step count is greater than simultaneous held capacity.

## 19. Final release gate - resumed old Task 19

Run and verify:

- focused family/compiler/planner/validator tests
- complete API suite
- complete Overwolf client suite after cutover
- workspace build
- migration state in disposable/test DB
- WPA repository integration
- corrected Billy full-pipeline E2E
- production-like debugger auth/UI/SSE smoke test
- static no-V1-fallback wiring regression

Before completion, show the final actual Billy build/report to the user again.

A green CI run is necessary but not sufficient. Human semantic review of the real Statlocker-only build remains mandatory.

## 20. Superseded old semantics

The implementation plan must explicitly remove or rewrite tests/code that encode any of these assumptions:

- every `CORE` item is an independent mandatory lifetime goal
- touching a `CORE` once is enough even if it is sold immediately
- `completedSemanticItemIds` permanently satisfies final goals
- mandatory CORE may bypass replacement utility merely to complete historical coverage
- upgrade-family ancestors/descendants are independent final goals
- a full inventory blocks a normal one-slot upgrade
- catalog existence alone can promote a strategic descendant

The focused `full-build-lifetime-mandatory-core-v2.spec.ts` expectation that forces a low-utility replacement merely to complete another CORE is specifically incompatible with this design and must be replaced by family-regression/final-satisfaction tests.

## 21. Definition of Done

The combined V2 roadmap is complete only when all original still-valid V2 requirements plus these corrected semantics hold:

1. Strategic build evidence is Statlocker-only.
2. Top-10 Statlocker profile sourcing/provenance remains deterministic.
3. Archetypes are semantic/profile-level rather than ordinal.
4. Upgrade lineages compile into families, not independent lifetime goals.
5. Raw frequency, family requirement, and progression role are separate concepts.
6. REQUIRED applies to family-level final-state requirements.
7. Explicit CHOICE remains one bounded alternative group.
8. Inferred REQUIRED/CHOICE is conservative when evidence is weak.
9. Minimum required final occupancy cannot exceed capacity.
10. Every family has a Statlocker-backed default terminal where evidence supports one.
11. Rare but real Statlocker descendants may remain optional terminals.
12. Optional terminal promotion is runtime Statlocker/WPA driven and confidence-gated.
13. Catalog-only descendants never become strategic targets.
14. Family satisfaction is derived from current projected inventory, not sticky historical ownership.
15. Required-family satisfaction does not regress inside one lifetime plan.
16. A normal upgrade consumes its owned ancestor atomically and keeps one family slot occupied before/after.
17. Full inventory does not block an executable one-slot upgrade.
18. Desired build state is selected before transaction generation.
19. Planner produces coherent BUY/UPGRADE/REPLACE progression toward selected family terminals.
20. Planner and semantic validator reject immediate pointless buy-replace churn.
21. Optional/situational additions cannot break required final state.
22. Mechanical simulation and semantic validation both pass.
23. Frozen Billy E2E passes the corrected invariants.
24. The corrected actual Billy build is human-reviewed before golden freeze.
25. Overwolf is cut over only after the corrected Billy release gate.
26. Production V2 has no V1 positional fallback authority.
27. Debugger exposes the family/terminal/transaction reasoning needed to explain the real decision.
28. Final API/client/build/migration/debugger release verification passes.
