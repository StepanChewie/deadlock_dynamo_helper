# Threat-weighted WPA build design

Date: 2026-09-09
Branch: `design/threat-weighted-wpa-build-roadmap`
Base: `main` at `b49f326b8c32f3e249f64b3d16c7a37657ee2580`
Status: design only, no production implementation in this branch

## 1. Goal

Build one coherent, current Deadlock build for the local player, using the pro/consensus skeleton as the structural prior and Statlocker `VS_HERO_WPA` plus live enemy threat as the main adaptation signal for variable parts of the build.

The system must answer two different questions with two different evidence families:

- Skeleton / consensus: what build archetype and structure make sense for this hero?
- Matchup + live state: which version of that structure is best against these exact six enemies in this exact match?

The final product must return one actual current build and one next action. It must not expose the union of every possible branch, optional item, and situational item as if all of them belonged in the same build.

## 2. Conversation summary and decisions

The agreed target behavior is:

1. Select a coherent archetype / consensus skeleton.
2. Separate structural items into hard core, soft core, branch/choice, and flexible/situational roles.
3. Protect hard core unless an explicit future policy says otherwise.
4. Resolve `OR / CHOICE` primarily with matchup evidence against the current enemy draft, while preserving the structural meaning of the branch.
5. Discover situational and optional items from the wider legal item universe, not only from a small list predeclared by the skeleton.
6. Permit an item outside the skeleton when it is materially and statistically credibly better for the current matchup and does not destroy build coherence.
7. Score matchup evidence against all currently known enemy heroes, not only the three strongest historical matchup rows.
8. Weight each enemy's matchup contribution by that enemy player's current live threat.
9. Derive live threat from several signals, not KDA alone: souls/economic share, hero damage/combat output, kills and assists, deaths, and level. Missing live metrics must degrade to neutral weighting rather than inventing confidence.
10. Combine historical matchup value, sample confidence, live threat, skeleton compatibility, synergy, upgrade continuity, timing, economy, slots, and already committed investment.
11. Select based on whole-build utility, not by sorting individual items by raw WPA.
12. Add hysteresis so recommendations do not oscillate after every small live-state change.
13. Keep the Overwolf HUD simple. A selected matchup-driven item should directly say who it is for, for example `Counterspell - vs Billy, Dynamo`.
14. Add a separate simple diagnostic view focused on item decisions: what the baseline build had, what candidates were considered, what was rejected and why, and what was selected and why.

## 3. Current code truth on `main`

### 3.1 `VS_HERO_WPA` is already used, but only as a scoring signal

`apps/api/src/statlocker-adaptive/adaptive-evidence-scorer-v1.service.ts` already computes `exactEnemyFit` from `VS_HERO_WPA`.

Current behavior:

- filters slices by our hero and current enemy hero IDs;
- finds the candidate item in each matching slice;
- uses sample shrinkage `n / (n + k)`;
- normalizes `deltaWpa`;
- sorts by absolute confidence-adjusted matchup signal;
- keeps only `exactEnemyMaxMatchups`;
- current config uses `exactEnemyMaxMatchups = 3`, `shrinkK.exactEnemy = 500`, and `weights.exactEnemyFit = 0.9`.

So matchup evidence is not absent. The limitation is that it mostly re-ranks an item that some other part of the planner already decided to consider.

### 3.2 Current situational flow does not discover the best matchup items globally

`apps/api/src/statlocker-adaptive/strategy-first-situational-overlay-v1.service.ts` iterates only:

`window.candidateItemIdsByPurpose?.[purpose]`

That means the current flow is effectively:

`strategy supplies candidates -> WPA helps rank those candidates`

The target flow is:

`WPA + live threat discovers strong candidates -> strategy/economy/slots/timing decide whether they can enter this coherent build`

Explicit skeleton candidates should remain a useful prior, but they should not be the complete universe for situational discovery.

### 3.3 Branch choice is currently limited to declared branch options

`apps/api/src/statlocker-adaptive/strategy-first-build-planner-v1.service.ts` resolves branches from existing `optionGoalIds`. This is correct for normal branch choice, but there is no controlled escape path for an outside item that is dramatically better against the current draft.

The target design keeps branch semantics intact and adds a conservative wildcard deviation path rather than turning every item into an arbitrary branch option.

### 3.4 Statlocker raw matchup data is richer than the normalized model

The live production probe confirmed `/api/info/vs-hero-wpa-data` returns HTTP 200 using the exact same browser-context approach as the collector.

The raw matchup leaf currently contains at least:

- `mean_wpa`
- `count`
- `delta_wpa`

Example observed live for Abrams vs Billy:

```json
{
  "rank": "rank_8",
  "hero": "Abrams",
  "item": "Counterspell",
  "enemy": "Billy",
  "raw": {
    "mean_wpa": 0.015508,
    "count": 141,
    "delta_wpa": 0.012496
  }
}
```

`apps/api/src/statlocker-adaptive/statlocker-normalizer.service.ts` currently:

- loops through every `by_rank` bucket;
- discards the rank identity;
- ignores `mean_wpa`;
- skips `_baseline`;
- count-weights and merges `delta_wpa` across rank buckets.

This is enough for the current scorer, but it destroys information that may be useful later.

### 3.5 Live individual enemy performance data already exists upstream

`apps/api/src/deadlock-live/canonical-roster-state.ts` already writes these player metrics when observed:

- kills
- deaths
- assists
- hero damage
- object damage
- healing
- souls
- level

But `apps/api/src/statlocker-adaptive/adaptive-decision-state-v1.service.ts` currently exposes only a thin enemy representation plus team-level totals to the adaptive planner. Individual enemy combat/economic metrics are not carried into the matchup scorer.

### 3.6 Existing shared types already anticipated matchup targets and live threat

`packages/shared/src/adaptive-recommendation-v1.ts` already has `AdaptiveSituationalEnemyTargetV1` / `AdaptiveSituationalContextV1`, including enemy IDs, primary/secondary target role, confidence, optional `deltaWpa`, sample size, and an evidence kind that can include `LIVE_THREAT`.

`apps/api/src/statlocker-adaptive/adaptive-situational-context-v1.service.ts` can already merge matchup evidence with supplied live-threat metadata.

This should be extended and reused, not replaced by a parallel incompatible model.

### 3.7 Existing Overwolf presentation already has an `againstLabel`

`apps/overwolf-client/src/adaptive-recommendation-presentation.ts` already supports `againstLabel?: string` and can render target enemies from situational context.

Therefore the HUD requirement is not a brand-new UI primitive. The real work is to ensure the new planner consistently emits the correct target-enemy context for the selected item, and then render that existing label consistently on the actual active HUD surfaces.

## 4. What I previously missed, oversimplified, or still do not know

### 4.1 I initially described the Overwolf `vs Billy, Dynamo` label as new work

That was incomplete. The presentation layer already has `againstLabel`. The missing part is reliable backend decision context plus consistent rendering. The roadmap must reuse this instead of duplicating it.

### 4.2 I initially phrased broad matchup coverage too simply

The statement that an item mildly useful against four or five enemies is often better than an item extremely strong against one enemy is not sufficient. If the one enemy is currently the main threat, that one matchup may be the most important one in the game.

The correct model is threat-weighted matchup value, with bounded influence and confidence shrinkage.

### 4.3 I initially focused too much on scorer weights and not enough on candidate discovery

Increasing `exactEnemyFit` weight cannot solve the main limitation if the item never enters the candidate set. Candidate discovery and whole-build evaluation are first-class architecture concerns.

### 4.4 Exact `mean_wpa`, `delta_wpa`, and `_baseline` semantics are not yet proven

We observed the fields live, but have not established the exact Statlocker formula tying them together. Until verified, the new system must not add `mean_wpa` and `delta_wpa` as if they were independent signals. That risks double counting.

### 4.5 Rank-aware matchup behavior is unresolved

The raw endpoint has `by_rank`. The current normalizer merges rank buckets. We have not logged the complete rank-key set and the current live decision state does not have a reliable player-rank input for this purpose.

Initial implementation should preserve a safe aggregate path while retaining rank in the richer normalized evidence so rank-aware scoring can be added without another data migration.

### 4.6 Exact live threat formula is intentionally not fixed yet

Any previous example such as a `0.6..1.8` multiplier was illustrative, not an approved constant. The exact weights, transforms, clamps, and smoothing parameters must be config-driven and calibrated from traces.

### 4.7 The numeric threshold for a wildcard outside the skeleton is unresolved

The rule is agreed conceptually: only a materially stronger, statistically credible matchup item can escape the normal skeleton candidate set. The exact threshold must be explicit, configurable, covered by tests, and tuned in shadow mode.

### 4.8 Whole-build utility weights are unresolved

We know the components that belong in the utility function, but not their final calibrated numeric weights. The first implementation should make each component explicit and auditable rather than hiding policy inside one opaque score.

### 4.9 Hard-core semantics need to be made explicit

The current strategy model already has `hard`, goal types, and lifecycle values. That is close to the desired concept, but `hard core`, `soft core`, and `flexible` are not yet a single canonical rigidity contract. The roadmap should clarify this mapping instead of assuming every existing hard flag is equivalent to a permanently locked item.

### 4.10 Final diagnostic UI visuals are not approved

The functional requirement is clear: show item decision trace. The exact mockup/layout is not important yet and should remain replaceable.

## 5. Recommended architecture

Use a skeleton-constrained optimizer with a controlled WPA escape hatch.

Alternative A - skeleton-only re-ranking:

- safest structurally;
- easy to reason about;
- misses high-value matchup items outside the predeclared candidate set.

Alternative B - pure WPA item ranking:

- highly adaptive;
- easy to create incoherent builds, bad timings, duplicate purposes, broken upgrade chains, and churn.

Recommended hybrid:

- skeleton selects archetype and structural commitments;
- threat-weighted matchup evidence selects variable parts;
- full-universe discovery is allowed for situational/wildcard candidates;
- whole-build utility and transaction legality decide whether the deviation is actually worth it;
- hard-core and transaction invariants fail closed.

## 6. Target data flow

```text
LIVE MATCH STATE
  -> per-enemy observed stats
  -> EnemyThreatV1

STATLOCKER VS_HERO_WPA
  -> richer normalized matchup evidence
  -> per-enemy delta + sample confidence

CONSENSUS / STRATEGY
  -> archetype
  -> hard core
  -> soft core
  -> branch / OR groups
  -> situational windows

ALL THREE
  -> ThreatWeightedMatchupV1 for candidate items
  -> normal branch selection
  -> situational discovery from legal item universe
  -> controlled wildcard escape candidates
  -> whole-build utility evaluation
  -> hysteresis / commitment policy
  -> transaction-plan validation
  -> ONE recommended build + ONE next action
  -> decision trace

OVERWOLF HUD
  -> item + `vs Billy, Dynamo`

DESKTOP / DEBUG UI
  -> baseline item
  -> considered items
  -> rejected items + reasons
  -> selected item + reasons
```

## 7. Enemy threat model

Live threat answers only: `which enemy matters more right now?`

It must not directly say which item to buy.

Historical matchup evidence answers: `which item historically performs better against that hero?`

Conceptual inputs for each enemy player:

- economic share / souls relative to enemy team;
- combat output share, especially hero damage;
- kill pressure from kills and assists;
- deaths as a negative pressure signal;
- level / level advantage where meaningful;
- data completeness.

Expected output:

```ts
interface EnemyThreatScoreV1 {
  enemyHeroId: number;
  rawScore: number;
  normalizedScore: number;
  weight: number;
  confidence: number;
  components: readonly EnemyThreatComponentV1[];
}
```

Requirements:

- bounded weight so one fed enemy cannot produce an unbounded multiplier;
- deterministic output for the same snapshot;
- neutral fallback when individual live data is unavailable;
- smoothing/hysteresis before threat changes can force a plan switch;
- full component trace for diagnostics.

## 8. Threat-weighted matchup model

For each candidate item and each currently known enemy hero:

```text
sampleConfidence = shrink(count)
matchupSignal = normalized(deltaWpa)
weightedContribution = matchupSignal * sampleConfidence * enemyThreatWeight
```

The build-specific aggregate must use all observed enemies and return the individual contributions, not only a scalar.

The aggregate should reward useful draft coverage but keep strong negative matchups visible. It must not let a huge low-sample raw `delta_wpa` dominate simply because the raw number is large.

The first version should not consume `mean_wpa` until Statlocker semantics are verified. General item quality can continue to come from the existing base WPA dataset/skeleton evidence.

## 9. Build-role policy

### Hard core

- structural identity of the selected archetype;
- not removed by ordinary matchup adaptation;
- must remain valid in the final build and transaction plan.

### Soft core

- strong consensus prior;
- normally present;
- can lose to a materially stronger contextual alternative when the full-build utility improves enough.

### OR / CHOICE

- choose exactly the required number of branch options;
- compare declared options using threat-weighted matchup fit plus compatibility/economy/timing;
- do not show all options in the final current build;
- outside-skeleton wildcard can challenge the selected soft/choice path only through the stricter escape gate.

### Situational / optional

- candidate discovery may scan the legal item universe;
- explicit skeleton candidates receive a prior/boost, not exclusive access;
- candidate must pass statistical support, legality, slot, timing, investment, and whole-build coherence gates.

### Wildcard escape hatch

An outside item is accepted only when all of these are true:

- matchup uplift is positive and statistically credible;
- uplift over the normal plan exceeds a configured material threshold;
- it does not violate hard-core commitments;
- it is transaction-feasible;
- full-build utility improves after cost, slots, timing, investment, and churn are included.

## 10. Whole-build utility

The optimizer should rank coherent candidate plans, not only individual next-item scores.

Required explicit components:

- hard-core completion / violations;
- skeleton adherence prior;
- branch coherence;
- threat-weighted matchup coverage;
- base item quality;
- item-chain / synergy evidence;
- timing fit;
- slot/flex pressure;
- souls/economic opportunity cost;
- already-owned investment protection;
- transaction cost;
- churn / recent switch penalty.

Hard-core violations and illegal transaction states are constraints, not scores that can be compensated by enough WPA.

## 11. Stability policy

The same live game can produce noisy input. The system must not flip the build back and forth.

Required protections:

- plan fingerprint / stable identity;
- minimum utility improvement before switching;
- larger switching barrier after meaningful investment is already purchased;
- recent purchase / sell-rebuy protection;
- smoothed live-threat changes;
- deterministic tie breaking;
- reason codes explaining why a plan was retained or switched.

## 12. Decision trace contract

The backend should emit a compact canonical trace for each important item decision.

Conceptually:

```ts
interface AdaptiveBuildDecisionTraceV1 {
  stages: readonly AdaptiveBuildDecisionStageV1[];
  finalBuildItemIds: readonly number[];
  selectedNextItemId?: number;
}
```

A stage/item trace should be able to answer:

- What did the skeleton originally propose?
- What role was this item playing?
- Which alternatives were considered?
- Which enemy heroes contributed to each matchup score?
- What were sample confidence and threat weight?
- Why was a candidate rejected?
- Why was the winner selected?
- Did a wildcard escape the skeleton, and what threshold did it beat?

Use structured reason codes. Do not make the UI parse free-form explanation strings to reconstruct planner logic.

## 13. UI behavior

### In-game Overwolf HUD

Keep it minimal.

Example:

```text
Counterspell
vs Billy, Dynamo
```

Rules:

- show only matchup targets that actually materially contributed to selection;
- primary/high-threat target first;
- do not show six names just because six enemies exist;
- if recommendation is not matchup-driven, omit the label rather than inventing a target.

The existing `againstLabel` presentation should be reused.

### Desktop/debug item-decision view

Primary layout concept:

1. Baseline / what the skeleton had.
2. Considered candidates.
3. Selected item and rejected items with short reason codes.

Expandable details may expose:

- per-enemy `deltaWpa`;
- sample size / confidence;
- live threat weight;
- whole-build utility delta;
- economy/slot/timing rejection reason.

The purpose is debugging planner decisions, not making a visually dense analytics dashboard.

## 14. Failure behavior

Fail neutral or fail closed depending on evidence type:

- `VS_HERO_WPA` missing/stale: keep skeleton-driven plan; do not invent matchup uplift.
- live enemy metrics missing: use neutral threat weights, not zero threat.
- catalog/transaction legality missing: do not recommend an unverifiable transaction.
- hard-core contract violation: reject candidate plan.
- low sample matchup spike: confidence shrink prevents promotion.
- decision trace failure must not change the recommendation itself; observability is auxiliary.

## 15. Non-goals for first implementation

- Do not replace the strategy-first planner with the legacy planner.
- Do not let raw WPA directly choose every item.
- Do not add rank-aware behavior until reliable rank input and raw rank semantics are verified.
- Do not mix enemy-item counter logic into the first hero-matchup scoring formula. Existing enemy-item situational logic remains a separate signal/purpose.
- Do not train a new ML model before the deterministic threat-weighted policy is observable and evaluated.
- Do not redesign the entire Overwolf product UI.

## 16. Acceptance criteria

The design is implemented successfully when:

1. For a fixed skeleton and enemy draft, branch/choice selection is deterministic and uses all observed enemy matchup rows.
2. A fed/high-threat enemy meaningfully increases the importance of the item matchup against that hero, within bounded limits.
3. A huge `delta_wpa` with tiny sample size cannot dominate a well-supported matchup automatically.
4. Situational discovery can surface a legal item outside explicit skeleton candidates.
5. That outside item cannot enter the build unless it passes the stricter wildcard uplift and whole-build coherence gates.
6. Hard-core items are never silently removed by ordinary matchup adaptation.
7. The response contains one coherent current build, not a union of alternatives.
8. The next action remains transaction-feasible.
9. Plan churn is bounded by explicit hysteresis tests.
10. Overwolf can show `vs <enemy names>` from canonical backend context.
11. The diagnostics trace can show baseline, considered, rejected, and selected items with machine-readable reasons.
12. Missing matchup/live-threat evidence degrades safely to the skeleton-driven baseline.

## 17. Open parameters to calibrate, not guess

The following must begin as named config values with conservative defaults and be tuned from shadow-mode traces:

- threat component weights;
- threat min/max clamp;
- threat smoothing strength;
- matchup shrink constant;
- negative-matchup penalty behavior;
- wildcard minimum uplift;
- soft-core replacement threshold;
- branch switch threshold;
- plan switch threshold after investment;
- minimum target contribution required for the HUD `vs` label.

No production behavior should depend on magic constants hidden inside service code.
