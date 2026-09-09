# Threat-weighted WPA build implementation roadmap

> Implementation plan for the approved hybrid architecture. This document is intentionally detailed and test-first. The branch containing this roadmap changes documentation only.

**Goal:** evolve the current strategy-first adaptive planner so it returns one coherent build whose structure comes from consensus/skeleton evidence while branch, optional, situational, and exceptional wildcard choices adapt to the exact enemy draft using Statlocker `VS_HERO_WPA` weighted by live enemy threat.

**Architecture:** preserve the existing strategy-first facade, strategy contract, item graph, transaction planner, and fail-closed invariants. Add explicit layers for durable WPA ingest/querying, live enemy threat, threat-weighted full-draft matchup aggregation/candidate discovery, exact 12-slot inventory optimization, whole-build utility, stable plan switching, and auditable presentation/debug traces.

**Tech stack:** NestJS/TypeScript API, TypeORM/Postgres, Jest, shared TypeScript contracts, Overwolf TypeScript/webpack client, existing Statlocker browser collector, existing build-domain recommendation graph.

## Approved product requirements

1. Skeleton/consensus defines the build archetype and structural core. It is a strong prior, not an absolute final item list.
2. Hard core is structurally protected. Soft core may move only when a materially better contextual plan exists.
3. OR/CHOICE selects one branch for the current game, primarily using current-draft matchup evidence plus compatibility/economy/timing.
4. Situational/optional discovery may consider legal items outside the skeleton when `VS_HERO_WPA` provides a strong, statistically credible advantage.
5. A wildcard outside the skeleton is allowed only when the whole resulting build is materially better after all costs and constraints.
6. Matchup evaluation uses all observed enemy heroes, not only the current top-3 exact matchups.
7. Historical `VS_HERO_WPA` is weighted by live enemy threat. Live stats answer "who matters most right now"; WPA answers "what historically works against that hero".
8. Enemy threat uses multiple signals, not KDA alone: souls, hero damage, kills/assists, deaths, level, and data completeness.
9. Low sample counts are shrink-adjusted before they can influence branch, wildcard, or replacement decisions.
10. The planner evaluates the utility of the complete resulting build, not only standalone item scores.
11. Inventory has exactly **12 total item slots**. All 12 slots are fully flexible/category-agnostic for capacity purposes. Weapon/Vitality/Spirit remain item/build attributes, not separate capacity buckets.
12. The planner must never project more than 12 held items.
13. At 12/12, adding a non-compressing item requires evaluating a concrete sell+buy replacement path.
14. Sell decisions are whole-build decisions. Do not simply sell the cheapest item. Hard core and protected upgrade components are not ordinary sell candidates.
15. Overwolf must present replacement as an explicit user transaction, for example `Sell Extra - Buy Opening Rounds`, with matchup context such as `vs Billy, Dynamo` when causal.
16. Debug UI must show what the skeleton had, what was considered, what was rejected, what won, and the numerical policy/math behind the decision.
17. Final serving output is always one current coherent build plus one executable next action.
18. Plan changes use hysteresis so small/noisy context changes do not churn recommendations.
19. `VS_HERO_WPA` is fetched on a daily cadence, with a full immutable **RAW Statlocker response** stored before normalization.
20. The RAW snapshot is then normalized into relational rows for production querying. Scoring/debug paths read relational rows, not the large JSON snapshot.
21. The large `VS_HERO_WPA` dataset is not kept as an application-wide in-memory payload. Postgres is the source of truth; add a small hot cache only later if profiling proves it necessary.
22. Historical RAW snapshots are retained for audit/replay/re-normalization. Relational WPA storage is the active query representation.

## Initial V1 policy numbers

These are intentional starting values for shadow evaluation, not sacred constants. They must be named/configurable and visible in debug output.

| Policy | Initial value |
| --- | ---: |
| Total inventory capacity | `12` |
| Enemy threat - souls weight | `0.35` |
| Enemy threat - hero damage weight | `0.30` |
| Enemy threat - kills + assists weight | `0.20` |
| Enemy threat - level weight | `0.10` |
| Enemy threat - deaths penalty weight | `0.05` |
| Enemy threat multiplier clamp | `0.75 .. 1.50` |
| Exact matchup shrink K | `500` |
| Normal plan switch minimum gain | `0.08` |
| Sell + buy minimum net gain | `0.20` |
| Soft-core replacement minimum net gain | `0.25` |
| Outside-skeleton wildcard + replacement minimum net gain | `0.30` |
| Minimum matchup confidence for sell-driven adaptation | `0.40` |
| Recent purchase sell protection | `120 sec` |
| Sold-item rebuy penalty window | `180 sec` |

The existing values for plan switching, sell thresholds, core replacement, recent purchase protection, recent sell/rebuy penalty, and exact-enemy shrink should be reused where they already match these values. New threat weights/clamps are V1 defaults and must be tuned from traces/shadow data.

## Implementation principles

1. TDD for every behavior change: write failing focused test, run it, implement minimum behavior, run focused test, then run affected suite.
2. Do not revive the legacy planner. Final integration goes through `strategy-first-adaptive-planner-facade-v1.service.ts`.
3. Hard constraints are never compensated by high WPA. Catalog legality, hard-core contract, transaction feasibility, and exact 12-slot inventory correctness stay fail closed.
4. Keep every threshold/weight named/configurable and emit the effective policy version/values into the debug trace.
5. Keep decision math auditable. Every serious selected/rejected candidate must be explainable from structured components and reason codes.
6. Preserve a neutral fallback path: when matchup/threat evidence is unavailable, behavior collapses toward the existing skeleton-driven plan.
7. Raw Statlocker storage and derived/query storage are separate responsibilities.
8. Publishing a new daily WPA dataset is atomic from the scorer's point of view. A failed parse/import must leave the previous active relational dataset usable.
9. Do not use an in-memory copy of the full `VS_HERO_WPA` response as source of truth.
10. Roll out behind a policy/version flag and shadow evaluation before replacing the current production decision path.

---

# Milestone 0 - Lock down evidence, mechanics, and regression fixtures

## Task 0.1 - Add a real `VS_HERO_WPA` raw fixture

**Create:**
- `apps/api/test/fixtures/statlocker-vs-hero-wpa-v1.json`

**Modify:**
- current Statlocker normalizer/ingest tests.

**Fixture requirements:**
- at least two rank buckets;
- our hero with at least three items;
- at least three enemy heroes;
- `_baseline` entry;
- `mean_wpa`, `count`, `delta_wpa` leaves;
- one very large delta with tiny sample;
- one moderate delta with strong sample;
- one negative matchup.

**RED:** document current behavior, including rank aggregation and the fact that `mean_wpa` is currently ignored by scoring.

## Task 0.2 - Verify Statlocker field semantics

Investigate and document the exact relationship between `mean_wpa`, `delta_wpa`, and `_baseline`.

**Create:**
- `docs/statlocker-vs-hero-wpa-semantics.md`

Every field must be marked VERIFIED, INFERRED, or UNKNOWN.

**Gate:** until semantics are VERIFIED, `mean_wpa` can be persisted and displayed in debug but cannot become an independent utility bonus that may double count `delta_wpa`/base WPA.

## Task 0.3 - Remove threshold ambiguity

Make one config source authoritative for situational/replace/switch thresholds before adding new policy layers.

**Modify:**
- `apps/api/src/statlocker-adaptive/statlocker-adaptive.config.ts`
- `apps/api/src/statlocker-adaptive/build-situational-resolver-v1.service.ts`
- `apps/api/src/statlocker-adaptive/strategy-first-situational-overlay-v1.service.ts`

**RED:** resolver/planner must receive the configured value rather than silently falling back to unrelated hardcoded defaults.

## Task 0.4 - Lock inventory truth: 12 fully flexible slots

The current canonical economy model uses category base-slot buckets plus additional flex capacity. That does not match the approved capacity model and must be treated as an early blocker.

**Modify:**
- `apps/api/src/statlocker-adaptive/adaptive-economy-v1.ts`
- build-domain capacity/recommendation slot rules where required
- `apps/api/src/statlocker-adaptive/build-slot-planner-v1.service.ts`
- transaction projection/validator helpers that reason about capacity.

**Required semantics:**
- exact maximum held item count: `12`;
- all 12 positions are capacity-flexible;
- no `4 weapon + 4 vitality + 4 spirit + N flex` capacity model;
- item category still exists for build balance/investment/strategy;
- active-item mechanics remain a separate rule if Deadlock imposes an independent active-item limit;
- upgrade recipes that consume components may free/compress slots naturally;
- every projected state enforces `heldItemCount <= 12`.

**RED cases:**
1. 11 held items + legal buy -> 12 and feasible;
2. 12 held items + plain buy -> infeasible without exit/compression;
3. 12 held items + valid component-consuming upgrade -> feasible if final held count <= 12;
4. projected 13-item inventory is rejected in every planner/transaction path;
5. item category does not block a purchase solely because four items of the same category already exist.

---

# Milestone 1 - Daily RAW WPA ingest and relational query storage

## Task 1.1 - Persist the immutable RAW Statlocker response

Current evidence snapshots store normalized payloads. Add a dedicated RAW snapshot representation for `VS_HERO_WPA` rather than changing the meaning of every existing evidence snapshot.

**Create:**
- `apps/api/src/deadlock-live/entities/statlocker-vs-hero-wpa-raw-snapshot-v1.entity.ts`
- migration for `statlocker_vs_hero_wpa_raw_snapshots_v1`.

**Fields:**
- snapshotId/content hash;
- fetchedAt;
- source path/status;
- Statlocker patch ID;
- rulesetVersion;
- catalogSha256;
- collector version;
- raw JSONB payload exactly as received from Statlocker;
- ingest status/metadata sufficient to identify whether relational publication succeeded.

**Required behavior:**
- save RAW before normalization/import;
- immutable by content identity;
- never mutate RAW to match a newer normalizer schema;
- retain old RAW snapshots so a future normalizer can rebuild derived rows without re-fetching Statlocker.

## Task 1.2 - Create relational `VS_HERO_WPA` rows

**Create:**
- `apps/api/src/deadlock-live/entities/statlocker-vs-hero-wpa-row-v1.entity.ts`
- migration for `statlocker_vs_hero_wpa_rows_v1`;
- `apps/api/src/statlocker-adaptive/statlocker-vs-hero-wpa-repository-v1.service.ts`.

**Row shape:**
```text
snapshotId
statlockerPatchId
rulesetVersion
catalogSha256
rankBucket
heroId
enemyHeroId
itemId
count
deltaWpa
meanWpa?   // retained, not necessarily scored
```

`_baseline` must not be represented as a fake enemy hero row. Keep it in RAW until its semantics justify a separate derived structure.

**Indexes:**
- active identity + `heroId` + `enemyHeroId`;
- active identity + `heroId` + `itemId`;
- active identity + `heroId` + enemy set access path as supported by Postgres index design;
- uniqueness for one source rank/hero/enemy/item per published dataset.

**Primary runtime query:**
```text
ourHeroId
+ current patch/ruleset/catalog
+ enemyHeroIds[]
=> rows grouped by item and enemy
```

## Task 1.3 - Preserve rank rows and derive aggregate at query/scoring boundary

Do not irreversibly collapse rank buckets during ingest.

**RED cases:**
1. `rank_8` and `rank_9` for the same hero/enemy/item persist independently;
2. all-rank aggregate can still reproduce the current count-weighted `deltaWpa` behavior;
3. missing/non-numeric leaves are rejected/ignored deterministically;
4. `mean_wpa` is retained when valid;
5. future rank-specific policy does not require re-fetching old RAW snapshots.

For V1 recommendation policy, use the agreed all-rank aggregate unless a later verified rank policy is explicitly enabled.

## Task 1.4 - Publish relational rows atomically

A new daily fetch must not make production scoring unavailable if normalization/import fails.

**Desired flow:**
```text
fetch RAW
 -> save immutable RAW snapshot
 -> parse/validate rows into staging/in-transaction representation
 -> validate minimum dataset integrity
 -> atomically publish new active relational dataset
 -> previous active dataset becomes superseded
```

**Fail-closed rule:** if parsing/import/validation fails, keep the previous successfully published relational dataset active and mark the new RAW snapshot import as failed.

Do not delete the old active rowset before the replacement dataset has been validated.

## Task 1.5 - Change `VS_HERO_WPA` refresh cadence to daily

**Modify:**
- `apps/api/src/statlocker-adaptive/statlocker-refresh.service.ts`
- config/tests.

**Policy:** `VS_HERO_WPA` fetch interval starts at 24 hours. Do not force unrelated global datasets such as patch metadata/T4 chains onto the same cadence if they need a different refresh policy.

**RED:** repeated scheduler ticks within 24 hours do not re-fetch `VS_HERO_WPA`; forced/admin refresh can still bypass TTL where existing operational semantics allow it.

## Task 1.6 - Remove large in-memory `VS_HERO_WPA` serving path

The scorer/discovery/debug path must query the relational repository. The existing snapshot store may continue caching other small evidence families, but the full `VS_HERO_WPA` payload is not loaded/served through an application-wide active map.

**Modify:**
- `apps/api/src/statlocker-adaptive/statlocker-evidence.service.ts`
- `apps/api/src/statlocker-adaptive/statlocker-snapshot-store.service.ts` only as required to stop `VS_HERO_WPA` from depending on the active-map payload;
- scorer/discovery call sites.

**Acceptance:** restarting the API does not require hydrating the full WPA dataset into memory before recommendations can query it.

**Performance gate:** start with indexed Postgres queries. Add an LRU/hot cache only if profiling demonstrates a real bottleneck, and never make cache state authoritative.

---

# Milestone 2 - Carry individual live enemy state into adaptive planning

## Task 2.1 - Add a typed enemy live-state contract

**Modify:**
- `apps/api/src/statlocker-adaptive/adaptive-decision-state-v1.service.ts`

**Fields:**
- player/hero identity;
- level;
- souls;
- kills;
- deaths;
- assists;
- heroDamage.

Missing observations remain unknown/undefined, not fake zeros.

## Task 2.2 - Populate enemy live state from canonical roster

**RED cases:**
1. observed enemy K/D/A/souls/level/heroDamage are copied;
2. allies/local player are excluded;
3. missing metrics remain missing;
4. deterministic enemy ordering.

---

# Milestone 3 - Deterministic Enemy Threat V1

## Task 3.1 - Create pure threat scorer

**Create:**
- `apps/api/src/statlocker-adaptive/enemy-threat-v1.service.ts`
- `apps/api/test/enemy-threat-v1.spec.ts`.

**Initial formula components:**
- souls/economic share: weight `0.35`;
- hero-damage share: `0.30`;
- kill pressure from kills + assists/team activity: `0.20`;
- level position: `0.10`;
- deaths negative pressure: `0.05`.

Normalize component inputs relative to the enemy team where possible rather than relying on absolute raw numbers.

Output:
- raw component values;
- normalized threat score;
- bounded multiplier clamped to `0.75 .. 1.50`;
- completeness/confidence;
- reason codes.

**RED cases:**
1. fed/high-output enemy outranks far-behind enemy;
2. KDA alone cannot dominate contradictory souls/damage;
3. all individual stats missing -> neutral weight `1.0`;
4. absurd single metric cannot break clamp;
5. no NaN/Infinity;
6. deterministic results.

## Task 3.2 - Add bounded smoothing

Keep smoothing separate from the pure scorer.

**Create:**
- `apps/api/src/statlocker-adaptive/enemy-threat-history-v1.service.ts`.

Use a configured bounded EMA or equivalent after snapshot math is correct. This is small per-match state and is allowed in memory because it is ephemeral live-game state, unlike the global WPA dataset.

---

# Milestone 4 - Threat-weighted matchup aggregation across all enemies

## Task 4.1 - Query relational WPA evidence

The aggregation service requests only the current hero/current enemy set from `StatlockerVsHeroWpaRepositoryV1Service`.

No whole-dataset JSON traversal in scorer code.

## Task 4.2 - Add pure full-draft matchup aggregation

**Create:**
- `apps/api/src/statlocker-adaptive/threat-weighted-matchup-v1.service.ts`
- `apps/api/test/threat-weighted-matchup-v1.spec.ts`.

For each enemy with evidence:
```text
effectiveDelta = deltaWpa * sampleConfidence
sampleConfidence = n / (n + 500)
contribution = normalized(effectiveDelta) * enemyThreatWeight
```

The exact normalization remains compatible with the scorer's existing bounded score domain.

Aggregate across all observed enemies. Do not select only the three biggest absolute contributions for the final draft score.

Trace each enemy contribution with:
- enemy hero;
- raw delta WPA;
- count;
- shrink confidence;
- threat multiplier;
- weighted contribution.

**RED cases:**
1. broad moderate value can beat a one-matchup spike;
2. strong matchup into the highest live threat can legitimately beat broad weak coverage;
3. negative matchup into the main threat materially hurts a candidate;
4. low-sample spike is shrunk;
5. no live threat -> neutral weights;
6. all six rows appear when available.

## Task 4.3 - Add auditable draft matchup score component

Version/add `draftMatchupFit`; do not double count legacy `exactEnemyFit` and the new aggregate in final active utility.

---

# Milestone 5 - Explicit hard core / soft core / flex semantics

## Task 5.1 - Canonicalize goal rigidity

Add an explicit rigidity concept such as:
```ts
type BuildGoalRigidityV1 = 'HARD_CORE' | 'SOFT_CORE' | 'FLEX';
```

Hard core defines strategy identity. Soft core is a strong default. Flex contains optional/situational freedom.

## Task 5.2 - Enforce hard core as a constraint

A high WPA/wildcard score cannot silently remove a required hard-core commitment.

---

# Milestone 6 - Resolve OR / CHOICE using current-draft evidence

Normal branch resolution considers only declared branch alternatives and selects exactly the required K choices.

Score each branch from:
- threat-weighted draft matchup;
- skeleton prior;
- chain/synergy;
- timing;
- economy;
- current investment.

Committed/owned branch replacement needs a larger improvement than an uncommitted choice.

Wildcard items do not mutate branch definitions; they enter through the separate discovery path.

---

# Milestone 7 - WPA-driven situational discovery and wildcard escape

## Task 7.1 - Discover from the full legal recommendation universe

**Create:**
- `matchup-candidate-discovery-v1.service.ts` + tests.

Candidate source must come from legal recommendation candidates/item graph rules, not an unfiltered catalog scan.

Gates:
- legal/recommendation-eligible;
- supported matchup aggregate;
- minimum confidence/coverage;
- phase/timing plausible;
- compatible with hard-core contract;
- transaction path known;
- final 12-slot feasibility;
- no already-satisfied target.

Skeleton-listed situational items get a prior but are not the only candidates.

## Task 7.2 - Wildcard threshold

Initial whole-build improvement threshold:
- normal outside-skeleton wildcard: materially above normal branch changes;
- wildcard that requires sell+buy at 12/12: `>= 0.30` net improvement;
- hard core is not an ordinary replacement candidate.

Use minimum matchup confidence `0.40` for sell-driven matchup adaptations.

---

# Milestone 8 - Whole-build utility and 12/12 replacement optimization

## Task 8.1 - Create whole-build utility service

**Create:**
- `apps/api/src/statlocker-adaptive/build-utility-v1.service.ts`
- tests.

Components:
- skeleton adherence;
- hard/soft-core state;
- branch coherence;
- threat-weighted matchup value;
- chain/synergy;
- timing;
- slot state;
- economic opportunity cost;
- owned investment continuity;
- transaction friction;
- churn penalty.

Hard constraints are checked before utility. Invalid inventory/branch/core/transaction states are rejected, not merely penalized.

## Task 8.2 - Make free-slot buy and full-inventory replacement first-class alternatives

Planner search must distinguish:

```text
held < 12:
  BUY / UPGRADE / other legal transactions

held == 12:
  slot-compressing UPGRADE if legal
  OR explicit SELL_AND_BUY candidate
```

For every serious target item at 12/12, evaluate legal sell sources and score the complete after-state:

```text
currentUtility = U(current 12-item build)

candidateBuild = currentBuild - sellItem + buyItem
candidateUtility = U(candidateBuild)

netGain =
  candidateUtility
  - currentUtility
  - transactionFriction
  - churnPenalty
  - investmentLossPenalty
```

Accept only if `netGain` clears the threshold for the type of replacement.

Initial thresholds:
- ordinary sell+buy: `0.20`;
- replacing soft core: `0.25`;
- outside-skeleton wildcard + sell: `0.30`.

## Task 8.3 - Rank sell candidates by marginal build value, not price alone

Exclude/protect before ranking:
- required hard core;
- ready component needed for pending hard goal;
- recent purchase within `120 sec` unless a later explicit emergency policy is added;
- any item whose removal makes the projected transaction/build invalid.

Then compare legal removal candidates by resulting whole-build utility. Temporary/flex/obsolete early items may naturally become good sell sources, but no fixed "always sell cheapest" rule.

Use authoritative sell/refund mechanics when computing economic loss. If sell economics are unknown for the current ruleset, a sell recommendation requiring that unknown value must fail closed rather than invent a refund percentage.

## Task 8.4 - Inventory invariants

**Required tests:**
1. 11/12 + attractive item -> ordinary buy;
2. 12/12 + attractive item -> sell+buy or reject, never 13 items;
3. 12/12 -> hard core not sold;
4. 12/12 -> protected recent purchase not sold;
5. 12/12 -> weak flex may be sold for materially stronger matchup item;
6. `netGain=0.19`, threshold `0.20` -> reject;
7. `netGain=0.21`, threshold `0.20` -> accept;
8. every intermediate/final projected inventory obeys capacity mechanics.

---

# Milestone 9 - Plan hysteresis and transaction authority

## Task 9.1 - Add plan switch policy

Initial thresholds:
- normal plan switch `0.08`;
- sell+buy `0.20`;
- soft-core replace `0.25`;
- wildcard replacement `0.30`;
- recent purchase protection `120 sec`;
- sold-item rebuy penalty `180 sec`.

Threat changes alone do not replace the plan unless the resulting whole-build challenger crosses the appropriate net improvement threshold.

## Task 9.2 - Keep transaction plan/session authoritative

Reuse existing `REPLACE_ITEM`/`SELL_AND_BUY` semantics instead of adding a competing transaction model.

Displayed current build and executable next action must refer to the same selected plan.

---

# Milestone 10 - Canonical decision trace and policy snapshot

## Task 10.1 - Shared structured trace

Trace stages:
- skeleton baseline;
- branch choices;
- matchup discovery;
- whole-build validation;
- sell-source evaluation when relevant;
- final selection.

For each serious item/plan candidate expose:
- source: skeleton/branch/explicit situational/discovered/wildcard;
- selected/rejected;
- primary rejection reasons;
- matchup contribution details;
- build utility before/after;
- utility component deltas;
- threshold applied.

Do not send entire RAW Statlocker snapshots in recommendation responses.

## Task 10.2 - Include effective policy snapshot

Debug trace must expose the exact values used for the decision:
- policy version;
- 12-slot capacity;
- threat component weights;
- threat clamp;
- shrink K;
- plan/sell/soft-core/wildcard thresholds;
- matchup confidence threshold;
- protection/rebuy windows.

This is required so a developer can distinguish "bad data" from "bad coefficient" without reading source code.

## Task 10.3 - Replacement trace details

For a 12/12 decision expose at least:
```text
inventory: 12/12
sellItem
buyItem
utilityBefore
utilityAfter
rawImprovement
matchupGain
skeletonDelta
synergyDelta
timingDelta
economicLoss
transactionPenalty
churnPenalty
netImprovement
requiredThreshold
ACCEPT / REJECT
reasonCodes
```

Bound rejected candidate count for payload size, but always retain the selected candidate and closest/decision-critical alternatives.

---

# Milestone 11 - Simple item-centric debug UI

The debug screen focuses on items and decision history, not generic system stages.

**Required primary sections:**
1. `Было` - baseline skeleton/current build.
2. `Рассматривали` - serious alternatives.
3. `Выбрали` - final item/build change.
4. `Откинули` - meaningful rejected alternatives and one primary reason each.

**Expandable numeric details:**
- per-enemy WPA delta/count/confidence;
- live threat weight;
- threat-weighted contribution;
- full-build utility before/after;
- skeleton/synergy/timing/economy/slot/transaction/churn components;
- replacement sell source comparisons;
- applied threshold;
- policy snapshot with every configured number listed above.

**Acceptance:** when the recommendation looks wrong, the UI makes it possible to identify whether the problem is data ingest, matchup math, live threat, candidate discovery, slot/sell choice, whole-build utility, or threshold policy.

---

# Milestone 12 - In-game Overwolf item reason and explicit sell+buy action

Reuse existing matchup target/`againstLabel` plumbing where possible.

For a matchup-driven item:
```text
Counterspell
vs Billy, Dynamo
```

Material/high-threat causal targets appear first; negligible/negative targets are omitted.

For a replacement at full inventory, the user-facing instruction is explicit:
```text
Sell Extra - Buy Opening Rounds
vs Billy, Dynamo
```

Do not make the user infer a two-step transaction from an abstract `Replace` label.

**Presentation tests:**
1. normal buy renders `Buy X`;
2. replace renders both sell and buy item names;
3. two material matchup targets render in stable order;
4. no matchup cause -> no `vs` label;
5. duplicate targets are deduped;
6. unknown item names fail gracefully without hiding transaction type.

---

# Milestone 13 - End-to-end scenarios

Create a fixture-driven strategy-first suite covering at least:

### A - Normal skeleton wins
Neutral matchup/live context leaves coherent skeleton plan unchanged.

### B - OR branch changes by draft
One declared alternative has materially stronger supported full-draft matchup value.

### C - Fed primary enemy changes item priority
Historical matchup values are the same, but live threat makes one enemy materially more important.

### D - Tiny-sample spike rejected
Huge raw delta, tiny count, insufficient shrunk confidence.

### E - Strong wildcard accepted
Outside-skeleton legal item materially improves complete build.

### F - Hard core protected
No amount of ordinary WPA can silently remove required hard core.

### G - 11/12 ordinary buy
One slot free, candidate wins, no sell instruction.

### H - 12/12 replacement accepted
Full inventory, legal low-marginal-value item sold, stronger item bought, final count remains 12.

### I - 12/12 replacement below threshold rejected
Attractive item exists but net gain is below `0.20`/applicable threshold.

### J - Recent purchase protected
Potential sell source was bought inside 120 sec and is not selected.

### K - Unknown sell economics
Planner refuses to invent refund economics and fails closed for sell-driven recommendation.

### L - Stale/missing WPA
Fall back toward skeleton rather than invent matchup certainty.

### M - Missing live stats
Use neutral threat weights while preserving historical matchup scoring.

### N - No churn
Close time-series snapshots do not repeatedly flip plans.

### O - RAW ingest failure
New RAW snapshot is saved/marked failed, previous relational dataset remains active and recommendations continue.

### P - Daily refresh
Normal scheduler does not fetch the large WPA endpoint multiple times inside the 24h TTL.

### Q - API response consistency
One coherent build + one executable next action + bounded trace + no >12 inventory projection.

---

# Milestone 14 - Shadow mode, calibration, and rollout

## Task 14.1 - Policy/version flag

Suggested states:
- `CURRENT`;
- `THREAT_WEIGHTED_SHADOW`;
- `THREAT_WEIGHTED_ACTIVE`.

## Task 14.2 - Shadow telemetry

Capture bounded metrics:
- current/challenger plan fingerprints;
- next-item difference;
- branch difference;
- wildcard activation;
- replacement activation;
- sell source chosen;
- matchup confidence/coverage;
- primary enemy threats;
- utility/net improvement;
- threshold applied;
- whether switch would occur;
- reason codes.

Do not log full RAW WPA payloads in normal decision telemetry.

## Task 14.3 - Calibration review

Inspect:
- branch switch rate;
- wildcard discovery/acceptance;
- 12/12 replacement rate;
- rejected replacement distribution around thresholds;
- plan churn per match/minute;
- hard-core violation attempts/accepted violations (accepted must be zero);
- low-confidence rate;
- evidence coverage;
- stale evidence fallback rate;
- WPA DB query latency;
- daily import duration/row counts/failures;
- disagreement with current production plan.

Tune from evidence:
- threat weights/clamp;
- smoothing;
- wildcard uplift;
- sell/soft-core thresholds;
- branch/invested-plan switch thresholds;
- material HUD target threshold.

## Task 14.4 - Active rollout gate

Require:
- focused + full tests green;
- builds green;
- zero accepted hard-core invariant violations;
- zero >12 projected inventory violations;
- acceptable churn;
- stable daily WPA ingest/query latency;
- manual review of representative debug traces, including wrong-looking cases.

---

# Recommended implementation order and merge boundaries

1. Verified RAW fixture + Statlocker field semantics + threshold cleanup.
2. Canonical exact-12 fully-flex inventory mechanics and invariants.
3. RAW daily snapshot storage + relational WPA schema/repository + atomic publication.
4. Switch `VS_HERO_WPA` scoring/query paths away from large in-memory payloads.
5. Enemy live-state contract + pure threat scorer.
6. Threat smoothing.
7. Threat-weighted all-enemy matchup aggregate.
8. Explicit hard/soft/flex rigidity.
9. OR/CHOICE contextual selection.
10. Full-universe situational discovery + wildcard gate.
11. Whole-build utility + 12/12 sell-source optimization.
12. Plan-switch hysteresis + transaction integration.
13. Shared decision trace + policy snapshot.
14. Debug item-decision UI.
15. Overwolf `vs Billy, Dynamo` + `Sell X - Buy Y` presentation.
16. End-to-end scenarios.
17. Shadow telemetry, calibration, active rollout.

Each boundary must keep the current production fallback viable. Do not land a half-connected scorer that changes user-visible recommendations before transaction/inventory invariants and decision traces can explain it.

# Verification commands before merge

Run from repository root:

```bash
yarn workspace @deadlock-live-probe/shared test
yarn workspace @deadlock-live-probe/api test
yarn workspace @deadlock-live-probe/api build
yarn workspace @deadlock-live-probe/overwolf-client test
yarn workspace @deadlock-live-probe/overwolf-client build:bundle
```

Then, if runtime/CI cost is acceptable:
```bash
yarn test
yarn build
```

# Definition of done

The feature is done only when all of the following are true:

- The system starts from a coherent strategy/skeleton rather than a global WPA item sort.
- Hard core is structurally protected.
- OR/CHOICE produces one selected branch using current-draft evidence.
- Situational discovery can find strong legal items outside the skeleton's explicit candidate list.
- Wildcards require a clearly stronger and well-supported whole-build result.
- Matchup utility considers all observed enemies and weights them by bounded live threat.
- Live threat uses multiple observed metrics, not raw KDA alone.
- Low sample sizes reduce confidence strongly.
- `VS_HERO_WPA` is fetched daily, RAW response is retained immutably, and queryable relational rows are atomically published.
- Recommendation scoring does not depend on loading the entire WPA dataset into process memory.
- Raw rank rows remain available for future rank policy while V1 can reproduce all-rank aggregation.
- Inventory capacity is exactly 12 fully flexible slots and no projection exceeds 12 held items.
- At 12/12, any non-compressing new item is evaluated through a concrete sell+buy path or rejected.
- Sell source is chosen from whole-build marginal value under hard-core/protection/economic constraints, not by cheapest-price heuristic.
- Full build, not only next item, is scored for coherence/economy/slots/timing/investment.
- Plan changes have explicit hysteresis and do not oscillate.
- One coherent current build and one executable next action are returned.
- Overwolf shows compact matchup context such as `vs Billy, Dynamo` when causal.
- Overwolf shows explicit replacement instruction such as `Sell Extra - Buy Opening Rounds`.
- Debug UI shows baseline, considered, rejected, selected, replacement math, and the exact policy numbers used.
- Every significant choice can be reconstructed from structured trace components/reason codes.
- Missing/stale evidence safely falls back instead of hallucinating certainty.
- New policy passes shadow evaluation before becoming the production default.
