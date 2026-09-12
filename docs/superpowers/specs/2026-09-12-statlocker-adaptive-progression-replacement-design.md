# Statlocker Adaptive progression and replacement design

Date: 2026-09-12
Status: approved in chat, pending written-spec review
Scope: Statlocker Adaptive build compilation, upgrade execution, long build timelines, 12-slot replacement, Statlocker hero-item WPA evidence, matchup protection, and economy-rule persistence.

## 1. Problem statement

The current Adaptive pipeline can represent upgrade transactions, but production data can collapse an observed upgrade family into a direct terminal purchase. It also treats capacity as a limit on selected desired families, which prevents a build timeline from naturally continuing past 12 purchase goals even though the inventory limit is only 12 simultaneously held items.

The target behavior is:

- Statlocker remains the source of truth for what belongs in an archetype and what progression is actually observed.
- Verified game mechanics only validate whether an observed progression can be executed.
- An observed upgrade such as `Quicksilver Reload -> Mercurial Magnum` must remain an upgrade when Statlocker evidence confirms it.
- A confirmed upgrade must never silently fall back to direct `BUY terminal` when the upgrade mechanics are unavailable or unverified.
- Full build timelines may contain more than 12 transaction rows.
- Held inventory must never exceed 12 items.
- Replacement logic is capacity-driven and runs only when all 12 slots are already occupied and the next planned action requires a new slot.
- Replacement candidates are ranked from Statlocker hero-item usefulness and purchase-time evidence, with matchup-specific protection based on the full enemy team.
- No training or sell-policy learning may use our own players, our own match histories, or local historical build trajectories.

## 2. Source-of-truth boundaries

The system has three independent evidence layers plus mechanics validation.

### 2.1 Build and progression evidence

`PRO_BUILD_ANALYSIS` determines:

- which items and families belong to the selected Statlocker archetype;
- which family progressions are actually observed;
- observed purchase timing and ordering;
- family requirements and build grouping semantics.

Statlocker build evidence is the only source allowed to introduce an intermediate component into a progression. Catalog ancestry alone must never invent a component purchase.

### 2.2 General hero-item lifecycle evidence

The Statlocker Item Meta Model for the current hero supplies the evidence used to rank sell candidates:

- `itemId`;
- general hero-item WPA;
- average purchase time;
- sample/confidence metadata when provided by Statlocker;
- hero and patch identity.

This evidence does not select the build, add items to an archetype, or initiate a sell. It is consulted only after replacement has already become necessary because inventory is full.

The existing `WPA_FILTERED_ITEMS` collector/normalizer support may be used only after a fixture or integration check proves that its raw payload corresponds to the hero-item Item Meta Model values needed by this design. Until that equivalence is proven, no code may assume the endpoint is the source behind the UI graph.

### 2.3 Matchup evidence

`VS_HERO_WPA` determines whether a held item is unusually valuable against the current enemy lineup and therefore protected from selling.

SELL protection uses all available enemy heroes, up to the full enemy team of five. This is distinct from any existing scoring path that intentionally limits exact-enemy matchups to fewer entries.

### 2.4 Mechanics evidence

The catalog and economy rules answer only whether a Statlocker-backed action is mechanically executable:

- component ancestry;
- legal upgrade recipe;
- one-slot consume/add semantics;
- verified upgrade price;
- verified direct-purchase legality;
- sellability if such a mechanic constraint exists.

Mechanics may validate a Statlocker progression but may not invent one.

## 3. Observed progression edges

The archetype compiler must materialize explicit observed progression edges rather than relying only on ordered `progressionNodes`.

Conceptual shape:

```ts
interface ObservedProgressionEdgeV2 {
  fromItemId: number;
  toItemId: number;
  sourceProfiles: number;
  orderedProfiles: number;
  orderConfidence: number;
  componentMedianBuyTimeS: number;
  targetMedianBuyTimeS: number;
  evidence: 'STATLOCKER_SAME_PROFILE';
}
```

An edge is confirmed only when all of the following hold:

- source and target are present in the same Statlocker profile/build;
- source is observed before target, respecting the existing timing tolerance;
- `sourceProfiles >= STATLOCKER_BUILD_V2_CONFIG.minOrderSourceProfiles`, currently `2`;
- `orderConfidence >= STATLOCKER_BUILD_V2_CONFIG.softOrderConfidence`, currently `0.65`;
- the timing comparison uses `orderTimingToleranceS`, currently `45` seconds.

Cross-profile synthesis is forbidden. An item observed only in profile A and a terminal observed only in profile B do not form a progression edge.

### 3.1 Lineage-specific timing

For a confirmed edge, component and terminal timing must be calculated from the same-profile observations that confirmed the edge. Generic family timing from unrelated profiles must not be used to force upgrade steps together.

This allows natural interleaving, for example:

```text
BUY Quicksilver Reload
BUY another item
BUY another item
UPGRADE Mercurial Magnum
```

instead of forcing the upgrade immediately after the component purchase.

### 3.2 Multi-level progressions

Each adjacent upgrade edge in a longer chain must independently satisfy the same same-profile evidence rule and mechanics validation. The executable path is composed only from accepted adjacent edges.

## 4. Mechanics validation and fail-closed upgrade semantics

For every confirmed Statlocker edge:

```text
confirmed Statlocker edge
-> catalog lineage exists
-> executable one-slot recipe exists
-> verified upgrade pricing exists
-> executable progression edge
```

If Statlocker confirms a progression but mechanics cannot execute it, the system must fail closed.

It must not silently replace:

```text
BUY component
...
UPGRADE terminal
```

with:

```text
BUY terminal
```

### 4.1 Failure policy by requirement

For a confirmed chain with unavailable mechanics:

- `OPTIONAL` or `SITUATIONAL`: exclude that family from the executable goal set and backfill with the next eligible family if one exists.
- `REQUIRED`: enter a degraded/HOLD state with an explicit reason. Do not direct-buy the terminal as a substitute.

Recommended reason codes include:

- `CONFIRMED_PROGRESSION_RECIPE_UNAVAILABLE`;
- `UPGRADE_PRICING_UNVERIFIED`;
- `DIRECT_PURCHASE_UNVERIFIED`;
- `CAPACITY_BLOCKED_NO_SAFE_REPLACEMENT`;
- `ITEM_META_EVIDENCE_MISSING`.

A generic lineage error may still exist, but it must not hide the actual failure category.

## 5. Economy-rule persistence bug

`RecommendationEconomyRulesV1` already supports `upgradePricingPolicy`, but the current store normalization drops it before persistence and resolution. This must be corrected so the policy survives the complete round trip:

```text
creation
-> validation
-> normalization
-> persistence
-> hashing
-> resolveExact
```

The full policy must remain stable, including:

- `mode`;
- `componentCreditRatio`;
- `evidence`;
- `source`.

`componentCreditRatio` must never be guessed or hardcoded for this feature. It is valid only when supplied by a verified mechanics/economy source. If no verified source exists, the corresponding upgrade remains non-executable and the fail-closed behavior in this spec applies.

## 6. Direct-purchase legality

The current assumption `directPurchaseCost !== undefined => direct purchasable` is insufficient for upgrade-only items.

The recommendation catalog must carry an explicit verified direct-purchase legality fact or equivalent tri-state semantics:

```text
direct purchase = allowed | forbidden | unknown
```

A raw item cost alone is not proof that the terminal can be bought directly.

When a Statlocker progression does not meet the 0.65 confirmation threshold, the compiler must not invent the component chain. The terminal may remain a standalone target only when direct-purchase legality is explicitly verified as allowed. If legality is forbidden or unknown, that standalone direct-buy path is unavailable.

## 7. Capacity semantics

The core invariant is:

```text
MAX_HELD_ITEMS = 12
```

This means maximum simultaneously held inventory, not maximum build steps, maximum family count across the whole match, or maximum transaction count.

There must be no invariant equivalent to:

```text
fullBuild.steps.length <= 12
```

A valid full build may have 13, 14, 20, or more transaction rows while never holding more than 12 items at once.

After every simulated action:

```text
heldItems.length <= 12
```

Action occupancy semantics:

- `BUY`: requires a free slot, inventory count increases by one.
- `UPGRADE`: consumes the held component and adds the target in the same slot, inventory count is unchanged.
- `REPLACE`: removes one held item and buys one target, inventory count is unchanged.

## 8. Desired state becomes an ordered goal timeline

`DesiredBuildStateV2` must stop meaning "the final best set capped to `totalCapacity`".

It should represent ordered, executable build goals across the match. The selected goal timeline may contain more than 12 goals.

Capacity must not truncate goal selection.

### 8.1 Goal classes

The timeline preserves explicit semantics:

- `REQUIRED`;
- selected `CHOICE` families only;
- `OPTIONAL`;
- matchup-selected `SITUATIONAL`.

The archetype is a union of evidence from similar Statlocker profiles, so removing the capacity slice must not turn all archetype families into mandatory purchases.

### 8.2 CHOICE

Only the families selected by the group `minSelect` semantics become goals. Alternative CHOICE families remain alternatives and are not automatically purchased later simply because a slot became available.

### 8.3 OPTIONAL

An OPTIONAL family may remain as a deferred goal after the initial 12 held slots have been filled. Once inventory is full, purchasing it additionally requires the replacement-improvement gate described below.

If that gate fails, the deferred OPTIONAL goal is skipped rather than forcing a sell.

### 8.4 SITUATIONAL

A SITUATIONAL family becomes a purchase goal only when current matchup evidence and confidence justify it. At 12/12 it must additionally pass the replacement-improvement gate.

### 8.5 REQUIRED

A late REQUIRED goal must be attempted even at 12/12. The planner searches for a safe replacement. If none exists, the result is degraded/HOLD with `CAPACITY_BLOCKED_NO_SAFE_REPLACEMENT` or a more specific reason.

## 9. Replacement trigger

Replacement is capacity-driven, not value-driven.

The sell/replacement algorithm runs only when both conditions are true:

```text
heldItems.length === 12
AND
next planned action requires a new slot
```

Examples:

```text
11/12 + BUY
-> BUY
```

```text
12/12 + UPGRADE held component
-> UPGRADE
-> no sell ranking
```

```text
12/12 + BUY new item
-> run replacement pipeline
```

Low general WPA, early purchase time, or any other value signal must never proactively initiate a sell while fewer than 12 slots are occupied.

## 10. Replacement gate vs sell ranking

Two questions must remain separate:

1. Should the incoming item be bought strongly enough to justify replacing something?
2. If yes, which held item should be sold?

The existing concepts around `replacementMinImprovement` and `coreReplacementMinImprovement` should be reused or adapted for question 1 rather than embedding that decision in the sell score.

General hero-item WPA alone must not introduce an out-of-archetype purchase.

The order is:

```text
Statlocker archetype eligibility
-> requirement/group semantics
-> timing/progression eligibility
-> if 12/12: replacement-improvement gate
-> if gate passes: sell-candidate selection
```

## 11. Sell-candidate protection

At 12/12 with an incoming new-slot BUY, start from held items and remove protected candidates before any ranking.

Protection includes:

- active progression components required by a future confirmed upgrade;
- dependencies of the target family currently being executed;
- mechanics-defined unsellable items if such a rule exists;
- `MATCHUP_PROTECTED` items;
- any other active build constraint that would make the pending executable plan invalid.

A family being historically `REQUIRED` is not by itself permanent protection. `REQUIRED` means the purchase/build obligation mattered, not that the item can never be sold in late game. Protection applies to active constraints, not to every item that once satisfied a required family.

If no safe candidate remains:

- REQUIRED target: degraded/HOLD;
- OPTIONAL target: skip;
- SITUATIONAL target: skip.

Protected items are never sold merely so the planner can finish a build.

## 12. Team matchup protection

For every held item, aggregate `VS_HERO_WPA` across all available enemy heroes, up to five.

Use confidence/sample-aware bounded weights. The existing shrinkage family is appropriate:

```text
confidence = sample / (sample + k)
```

with the existing exact-enemy prior as the baseline unless calibration shows a reason to version a replacement-specific prior.

The team aggregate is confidence-weighted and bounded, so one enormous sample cannot dominate the other enemy matchups by raw count alone.

An item becomes `MATCHUP_PROTECTED` only when both hold:

```text
teamMatchupWpa >= absoluteProtectionThreshold
AND
teamMatchupConfidence >= minimumConfidence
```

Do not protect an item just because it is good against one enemy hero.

The protection threshold is absolute, not "top N held items". If every held item is bad in the current matchup, none should be protected simply because one is least bad.

The numeric threshold and confidence minimum must be calibrated from the distribution of real Statlocker `VS_HERO_WPA` snapshots and checked into versioned configuration before this protection is enabled in production. There is no guessed default.

## 13. Pareto-first sell ranking

Only non-protected candidates reach this stage.

Each candidate uses two Statlocker Item Meta Model coordinates:

```text
X = average purchase time
Y = general hero-item WPA
```

Earlier purchases and lower WPA are better candidates for selling.

### 13.1 Pareto dominance

Candidate A dominates candidate B as a sell candidate when:

```text
A.purchaseTime <= B.purchaseTime
AND
A.generalWpa <= B.generalWpa
AND
at least one comparison is strict
```

If one candidate is both earlier and no more useful than another, the dominated candidate must not outrank it for retention.

### 13.2 Tie-break for Pareto-incomparable candidates

When candidates trade off purchase time and WPA, normalize both coordinates into empirical percentiles from the relevant Statlocker hero-item distribution.

Define:

```text
timeSellPercentile:
  1.0 = among the earliest purchases
  0.0 = among the latest purchases

wpaSellPercentile:
  1.0 = among the weakest general WPA
  0.0 = among the strongest general WPA
```

Tie-break score:

```text
sellTieBreak =
  0.50 * timeSellPercentile
  +
  0.50 * wpaSellPercentile
```

Higher score means a stronger sell candidate.

The 50/50 score is only a tie-break among Pareto-incomparable candidates. It is not the primary ranking model.

No learned weights are introduced in this design.

## 14. Missing-data policy

The design is fail-closed where a missing fact could produce an unsafe or invented action.

- Missing Item Meta Model evidence at the moment replacement is required: do not invent lifecycle values; no evidence-based sell ranking is available.
- Missing `VS_HERO_WPA`: the item does not receive matchup protection, but the absence must be observable in reason/debug data.
- Missing verified upgrade pricing: confirmed upgrade is non-executable; do not direct-buy the terminal as fallback.
- Missing direct-purchase legality: do not assume direct purchase from raw cost.
- Missing same-profile progression support: do not materialize the component chain.

If the candidate lifecycle dataset cannot be verified as the actual hero-item Item Meta Model source, replacement ranking remains disabled rather than switching to our own player history or synthetic lifecycle heuristics.

## 15. Explicitly forbidden data sources

This feature must not learn or infer SELL/replacement policy from:

- our own users;
- a specific player's personal match history;
- local `MatchPlayer` historical item trajectories;
- `historical-build-trajectory-source-v2` or equivalent local behavioral traces;
- inferred sell times from our own collected matches.

The only allowed policy evidence is Statlocker aggregate data plus verified game mechanics/catalog data.

Optional parser fields such as `earlyWpa`, `midWpa`, `lateWpa`, `laneWpa`, and `postLaneWpa` are not part of this design because they are not present in the current real snapshots inspected for this project.

## 16. Planner responsibilities

The planner should execute already-selected goals rather than decide what Statlocker recommends.

Responsibilities are separated as follows:

```text
Compiler
-> what Statlocker observed and how items are related

Desired-goal resolver
-> which REQUIRED / CHOICE / OPTIONAL / SITUATIONAL goals are eligible
-> ordered timeline

Mechanics validator
-> which actions are executable

Replacement evaluator
-> whether a full-inventory incoming target justifies replacement

Sell selector
-> which safe held item is the best replacement candidate

Transaction planner
-> emit BUY / UPGRADE / REPLACE while preserving inventory invariants
```

The sell-ranking logic should be a focused, independently testable component rather than being embedded in a large planner loop.

## 17. Expected transaction behavior

A valid timeline may look like:

```text
1  BUY item A
2  BUY Quicksilver Reload
3  BUY item B
...
12 BUY item K
13 UPGRADE Mercurial Magnum
14 REPLACE Opening Rounds -> Armor Piercing
```

At every point:

```text
held inventory <= 12
```

The `UPGRADE` at 12/12 does not run sell ranking because it preserves slot occupancy.

The `REPLACE` runs only because the incoming late goal needs a new slot while inventory is already 12/12.

## 18. Ingestion changes

The hero refresh path must schedule the verified hero-item Item Meta Model dataset once its source equivalence has been proven.

The stored snapshot must be patch- and hero-scoped and support deterministic replay. At minimum it must preserve the fields used by sell ranking and enough source metadata to diagnose missing or stale evidence.

`VS_HERO_WPA` remains independently collected and is consumed by the team matchup protection calculation.

## 19. Observability

Debug output should expose enough provenance to explain every upgrade and replacement decision.

For a confirmed progression, expose:

- from/to item IDs;
- same-profile support count;
- ordered support count;
- order confidence;
- lineage-specific timing;
- mechanics validation result;
- recipe ID when executable;
- pricing-policy evidence/source.

For a replacement, expose:

- why replacement was triggered (`12/12 + new-slot BUY`);
- incoming target and replacement-improvement result;
- protected held items and protection reasons;
- team matchup WPA/confidence for held items;
- general WPA and average purchase time;
- Pareto relation/frontier;
- percentile values and tie-break score when used;
- final sell candidate;
- reason code if no safe candidate exists.

This is required for validating the policy against Statlocker UI data and for debugging future regressions.

## 20. Test strategy

Implementation must follow TDD. Regression coverage must include the production data path, not only synthetic graph tests.

### 20.1 Economy-rule round trip

Publish rules containing `upgradePricingPolicy`, persist them, resolve them, and assert complete equality of mode, component credit ratio, evidence, and source.

### 20.2 Same-profile progression

Positive case:

- at least two profiles contain both component and terminal;
- component is earlier within tolerance rules;
- order confidence is at least 0.65;
- mechanics are executable.

Expected transaction order includes `BUY component` followed later by `UPGRADE terminal`, with unrelated purchases allowed between them.

Negative cases:

- component only in profile A and terminal only in profile B -> rejected;
- same-profile confidence below 0.65 -> rejected;
- confirmed edge but recipe unavailable -> no direct-buy fallback;
- verified direct-purchase legality absent -> no direct-buy inference from cost.

### 20.3 Capacity and transaction count

A scenario must produce more than 12 transaction rows while proving that simulated held inventory never exceeds 12.

Also assert:

- 11/12 + BUY -> no sell selector invocation;
- 12/12 + held-component UPGRADE -> no sell selector invocation;
- 12/12 + new-slot BUY -> sell selector invoked.

### 20.4 Sell ranking

Pareto case:

```text
A: earlier purchase, lower WPA
B: later purchase, higher WPA
=> A ranks as stronger sell candidate
```

Pareto-incomparable case:

- normalize both coordinates into percentiles;
- apply 50/50 tie-break;
- deterministic result.

Matchup protection case:

- one strong matchup but weak team aggregate -> not protected;
- strong confidence-weighted aggregate across the team -> protected and absent from sell candidates.

### 20.5 Replacement end-to-end

With 12 held items and a late incoming goal:

- an early/low-WPA item is the best general sell candidate;
- another early item has strong full-team matchup WPA and is protected;
- expected result sells the unprotected weak item and buys the incoming target;
- inventory remains 12.

### 20.6 Real-data golden

At least one real Statlocker fixture must produce:

```text
BUY component
...
UPGRADE terminal
```

rather than an all-BUY golden.

At least one real or representative fixture must produce `fullBuild.steps.length > 12` while `maxHeldItems === 12`.

## 21. Production enablement gates

The feature is not considered production-ready until all of the following are true:

- hero-item Item Meta Model source equivalence is verified from raw Statlocker payloads;
- upgrade pricing policy has a verified source and survives persistence/resolution;
- direct-purchase legality is explicit rather than inferred from cost;
- team matchup protection thresholds are calibrated from real Statlocker snapshot distributions and checked into versioned config;
- real-data golden tests cover an actual upgrade transaction;
- a >12-step build passes inventory simulation with maximum 12 held items;
- no own-player/local-history data is used by the replacement policy.

## 22. Success criteria

The implementation is successful when:

1. `Quicksilver Reload -> Mercurial Magnum` style progression appears only with qualifying Statlocker same-profile evidence.
2. A confirmed upgrade never silently collapses to a direct terminal BUY.
3. Full build timelines may contain more than 12 rows.
4. Simultaneously held inventory never exceeds 12.
5. SELL/replacement logic never runs before all 12 slots are occupied.
6. At 12/12, a held-component UPGRADE does not cause a SELL.
7. At 12/12 with a new-slot BUY, the system first applies safety/protection filtering, then Pareto ranking, then the 50/50 percentile tie-break only when needed.
8. High confidence-weighted `VS_HERO_WPA` across the full enemy lineup can protect an otherwise weak general item from sale.
9. Build and progression selection remain Statlocker-first; mechanics only validate execution.
10. No own-player data or local match trajectories participate in training or replacement ranking.
