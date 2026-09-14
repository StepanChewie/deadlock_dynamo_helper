# Statlocker Build Strategy V2 Design

> **Historical design record.** At the time of writing this documented the referenced work; parts have since been implemented, refined by the ADRs, or superseded. It is kept for provenance, not as current instructions. Current architecture: `docs/architecture.md`; decisions: `docs/decisions/`.

Date: 2026-09-10
Status: Approved design
Scope: Production recommendation architecture, production browser debugger, and captured-data end-to-end validation

## 1. Problem

The current production pipeline can produce semantically incomplete builds even when upstream Statlocker data is much richer. The Billy incident produced only seven unique recommended items. The root cause is the V1 compilation model: variable-length and variable-order build data is aligned by ordinal transaction position, support is diluted across positions, valid milestones are discarded, survivors can be duplicated across positions or branch/soft goals, and the downstream planner then renders only the few unique items that survived compilation.

V2 removes positional build compilation from the production path. It derives semantic build archetypes directly from Statlocker profile build analyses, selects one archetype once at match start, locks it for that match, and continuously resolves the best full lifetime build inside that archetype from live context.

A full build is an inventory-evolution plan, not a fixed final inventory. It may be longer than simultaneous inventory capacity and may contain BUY, UPGRADE, SELL, and REPLACE transitions.

## 2. Hard constraints

- Build evidence comes from Statlocker only.
- Do not use Deadlock API for build sourcing.
- Do not depend on unavailable historical match IDs.
- Do not use raw historical match trajectories as the authoritative build source.
- Current live match state is allowed only for runtime adaptation.
- Use exactly the top 10 Statlocker player profiles for a hero when 10 valid profiles are available.
- Publish multiple archetypes only when those profiles show strong, coherent structural separation; otherwise publish one consensus archetype.
- Wait for the full enemy roster before choosing an archetype.
- Choose one archetype once and keep it immutable until the match ends.
- At archetype-selection time, do not use KDA, souls, damage, level, or other live-performance signals. The match-dependent selector uses VS_HERO_WPA against the full enemy roster.
- After lock, live signals may change item order, CHOICE decisions, situational additions, SELL/REPLACE decisions, and the projected full plan, but not the archetype.
- No V1 shadow requirement. Validate V2 offline, then cut over directly.
- Broken V1 positional strategy is never a production fallback.

## 3. Statlocker authority model

### 3.1 Base structure

The sole authoritative source for base build structure is PRO_BUILD_ANALYSIS for the top 10 accounts discovered from HERO_LEADERBOARD.

The normalized profile blueprint already contains the semantic fields V2 needs:

- itemId
- purchaseRate
- medianBuyTimeS
- frequencyTier: CORE, FREQUENT, SOMETIMES, FLEX
- phase: EARLY, MID, LATE
- relationships
- optional explicitGroup: REQUIRED, CHOICE, OPTIONAL with minSelect/maxSelect

PRO_BUILD_ANALYSIS is an aggregate blueprint, not a per-match transaction or sale trace. V2 must not infer historical SELL sequences from data that does not contain them.

### 3.2 Other Statlocker evidence

- HERO_LEADERBOARD: top-10 account discovery and rank provenance.
- PRO_BUILD_ANALYSIS: base build structure.
- VS_HERO_WPA: initial archetype matchup selection and live exact-enemy adaptation.
- WPA_PATCH_DATA: global item strength, timing, phase, and game-state evidence.
- T4_CHAINS: synergy and combination evidence.
- WPA_FILTERED_ITEMS: optional candidate discovery only if V2 adds a guaranteed refresh/ingestion path for it.
- CONSENSUS_SKELETON: internal derived evidence only, never an external source of truth.

## 4. End-to-end production flow

```text
STATLOCKER
   +-- HERO_LEADERBOARD(heroId)
   |      -> top 10 accounts
   +-- PRO_BUILD_ANALYSIS(accountId, heroId) x 10
   |      -> semantic profile blueprints
   |      -> BuildArchetypeMinerV2
   |      -> 1..N BuildArchetypeV2
   |      -> BuildArchetypeQualityGateV2
   |      -> published valid snapshot
   +-- VS_HERO_WPA
   +-- WPA_PATCH_DATA
   +-- T4_CHAINS

MATCH START
   heroId + full enemy roster
      -> BuildArchetypeSelectorV2 using VS_HERO_WPA only
      -> LockedArchetypeSessionV2

LIVE MATCH
   locked archetype
   + current inventory/economy/slots/time
   + enemy live threat
   + Statlocker WPA/T4/global evidence
      -> FullBuildResolverV2
      -> forward inventory simulation
      -> ResolvedFullBuildPlanV2
      -> API/Overwolf consumer
      -> production browser debugger
```

## 5. Archetype mining

### 5.1 Semantic profile clustering

Treat each PRO_BUILD_ANALYSIS as one coherent build blueprint. Compare complete profiles by semantic features such as:

- item-family composition
- frequency-tier distribution
- explicit group structure
- relationship graph
- phase profile
- median timing profile

Never align `profileA[position]` with `profileB[position]` and assume the same ordinal position means the same milestone.

### 5.2 Archetype split policy

A separate archetype is accepted only when:

- more than one top profile supports it
- profiles inside it are materially similar
- it is materially separated from another accepted cluster
- the separation represents build structure rather than one situational item or a small order variation

Exact numeric thresholds are policy configuration and must be calibrated against captured real Statlocker snapshots. A lone outlier must not become its own archetype. With weak separation, output one consensus archetype.

### 5.3 Semantic deduplication

Each semantic item or upgrade family appears once per archetype. Different purchase positions or repeated relationships must not create duplicate independent goals.

Per-item evidence includes profile coverage, purchase rate, frequency-tier votes, phase, median timing/spread, relationships, explicit group membership, and structural priority.

Upgrade-family canonicalization may reuse the existing item graph and component/upgrade mechanics. Historical trajectory objects are not the source of archetype semantics.

### 5.4 Groups

Represent build semantics directly as REQUIRED, CHOICE, and OPTIONAL groups.

Explicit Statlocker groups have higher authority than inferred groups. A CHOICE A/B with minSelect=1 and maxSelect=1 means "choose one of A or B" and must never become two sequential goals.

Inferred CHOICE is allowed only when evidence shows real alternatives rather than normal co-occurrence.

### 5.5 Ordering

Ordering is a partial-order graph, not an ordinal list. Timing and profile agreement create edges such as `A -> D` or `C -> F`.

If B and C regularly swap order across profiles, V2 weakens or omits the B/C edge instead of deleting B or C.

## 6. Quality gate and snapshot publication

A valid TypeScript object is not enough. Every candidate archetype snapshot must pass semantic quality checks:

- Statlocker provenance is correct
- hero/patch/catalog are compatible
- enough valid top profiles are present
- no duplicate semantic families
- no conflicting group membership
- REQUIRED/CHOICE groups have valid candidates and bounds
- ordering graph is acyclic
- progression is meaningful
- item IDs and upgrade paths are valid
- transitions are mechanically executable under the current catalog
- cluster support and coherence clear calibrated quality gates
- near-zero-coherence archetypes cannot publish

Publication is atomic. Build and validate a new snapshot off to the side. On PASS, replace the active snapshot. On FAIL, keep the previous valid compatible snapshot. A transient Statlocker refresh failure must never replace a working strategy with empty or broken data.

## 7. Initial archetype selection and lock

### 7.1 Normal selection

Wait for the full enemy roster. Score every already-valid published archetype using VS_HERO_WPA against that roster.

Offline support/coherence decides whether an archetype is valid enough to exist, but does not act as a hidden popularity bonus during normal matchup selection.

The matchup aggregation must not reward an archetype simply for containing more items. CORE/REQUIRED structure carries more semantic importance than FLEX/OPTIONAL structure, and CHOICE groups are evaluated as alternatives rather than summing every candidate as if all were purchased.

VS_HERO_WPA uses sample-count confidence/shrinkage so tiny samples cannot dominate.

### 7.2 WPA unavailable at lock time

If VS_HERO_WPA is fully unavailable when the full enemy roster arrives, immediately lock the best offline default archetype. Do not wait for WPA and do not return no build.

Record an explicit degradation reason such as `ARCHETYPE_SELECTION_WPA_UNAVAILABLE`.

If WPA becomes available later, the locked archetype remains unchanged.

### 7.3 Immutable match lock

The selected archetypeId is immutable for the match. Later KDA, souls, damage, level, inventory, game-state, or WPA changes may only change the resolved plan inside that archetype.

## 8. Runtime live resolver

### 8.1 Enemy threat

Reuse the existing enemy-threat concept. Live threat is derived from current signals including souls, hero damage, kills + assists, level, and deaths, normalized against the enemy team and converted to a bounded multiplier.

Threat is not part of initial archetype selection. It becomes relevant only after lock.

### 8.2 Explainable item utility

V2 runtime scoring is organized into four explicit layers:

```text
ITEM UTILITY
= STRUCTURE
+ MATCHUP
+ PROGRESSION
- TRANSITION COST
```

STRUCTURE includes locked-archetype membership, REQUIRED/CORE/FREQUENT/CHOICE/OPTIONAL/FLEX prior, explicit group authority, relationships, and T4 coherence.

MATCHUP includes VS_HERO_WPA against each enemy, sample-size confidence, and current enemy threat weighting. Global Statlocker evidence may refine this layer when available.

PROGRESSION includes phase, preferred timing, partial-order predecessors, future upgrade usefulness, and already-satisfied item families.

TRANSITION COST includes effective souls cost, SELL/REPLACE requirement, utility lost by the sold item, broken future upgrade paths, plan-switch/churn penalties, recent-purchase protection, and slot/economy friction.

All layers and subcomponents must be inspectable in structured debug traces.

### 8.3 Sample confidence

Keep the existing shrinkage concept, such as `count / (count + K)`, or a calibrated equivalent. K values and related thresholds are centralized policy configuration, not hidden constants scattered through services.

### 8.4 Outside-archetype candidates

Keep the useful V1 behavior that can discover a strong matchup item outside the base strategy, but remove the dependency on V1 `situationalWindows`.

An outside-archetype candidate may enter only when it is independently Statlocker-backed for the hero and clears matchup coverage, confidence, statistical support, and improvement thresholds. Replacement-driven entry uses a higher threshold.

Outside items are situational additions inside the locked archetype, not new archetypes and not silent rewrites of the base strategy.

### 8.5 CORE/REQUIRED replacement

CORE and REQUIRED are strong priors, not absolute locks. They may be replaced only when an alternative transition has materially higher utility and sufficient evidence confidence.

Policy ordering must remain:

```text
future choice switch < ordinary sell/replacement < core replacement
```

## 9. Full lifetime build planning

### 9.1 Plan semantics

The output is a projected sequence of strategic inventory transitions from the current state through meaningful late-game progression.

Supported actions:

- BUY
- UPGRADE
- SELL
- REPLACE

A REPLACE explicitly pairs sellItemId and buyItemId so UI can show `SELL X -> BUY Y`.

### 9.2 Inventory simulation

Simulate inventory after every transition and repeatedly search for the best next legal transition. Plan length may exceed current simultaneous capacity.

The invariant is not `plan.length <= capacity`. The invariant is that projected held inventory is legal after every step.

### 9.3 Replacement scoring

When a target needs a slot, compare complete transitions such as `SELL A -> BUY M`, `SELL B -> BUY M`, and `SELL C -> BUY M`.

Score the resulting inventory state. The sold-item loss includes structural importance, matchup value, future upgrade need, relationship/chain value, committed investment, recent-purchase protection, and churn/rebuy risk.

Do not choose a sell source simply because it is cheapest or first legal.

### 9.4 UPGRADE is not SELL

Recipe/component consumption is UPGRADE semantics. Only deliberate replacement outside recipe consumption is displayed as SELL/REPLACE.

### 9.5 Hysteresis

Future plans may change with live state, but not on statistical noise. The next resolution receives the previous plan/revision and applies plan-switch margins, recent-purchase protection, stronger stability for near-term committed steps, and the highest threshold for CORE replacement.

The trace must show when a proposed change is accepted or suppressed and why.

## 10. Degraded evidence behavior

Missing evidence removes score components, not the build.

- VS_HERO_WPA unavailable after lock: continue from locked structure/progression/inventory/mechanics and available global evidence; expose degradation.
- T4_CHAINS unavailable: omit chain contribution and continue.
- failed new PRO_BUILD_ANALYSIS refresh: keep the previous valid snapshot.
- no matchup rows: do not claim matchup adaptation occurred.

Never fall back to the broken V1 positional strategy.

## 11. Structured decision trace

The recommendation pipeline emits a structured `BuildDecisionTraceV2`. The debugger must not parse free-form application logs.

Trace stages include:

- SOURCE
- ARCHETYPE_MINING
- ARCHETYPE_QUALITY_GATE
- ARCHETYPE_SELECTION
- LIVE_CONTEXT
- CANDIDATE_DISCOVERY
- CHOICE_RESOLUTION
- ITEM_SCORING
- PLAN_SEARCH
- REPLACEMENT_SEARCH
- FINAL_PLAN

Each stage exposes applicable input summaries, candidates, accepted/rejected decisions, reason codes, score decomposition, confidence/coverage/sample counts, and output passed forward.

Example:

```text
CHOICE A OR B OR C
A rejected: MATCHUP_SCORE_BELOW_SELECTED
B selected
C rejected: LOW_CONFIDENCE
```

The trace must make it obvious whether a failure happened in mining, quality gating, archetype selection, CHOICE resolution, candidate discovery, plan search, replacement search, inventory simulation, or presentation.

## 12. Production browser build debugger

### 12.1 Scope

A normal browser-based debugger is mandatory in production and independent of Overwolf. V1 of this debugger is read-only and cannot force archetypes, mutate scores, or alter planner decisions.

### 12.2 Authentication

Use a simple password gate for the first production version. The credential is supplied only through production environment configuration as `BUILD_DEBUG_PASSWORD` and is not committed to source control. Deployment sets it to the operator-approved initial value.

A minimal login endpoint verifies the password server-side and issues a short-lived HttpOnly, Secure, SameSite=Strict debug session cookie. Debug data endpoints and realtime streaming require the session.

Account-based auth is explicitly out of scope for this V2 delivery.

### 12.3 Realtime storage

Maintain a bounded in-memory debug store keyed by matchId. Keep the current complete trace plus a small bounded tail of recent revisions. No permanent history of every recommendation request is required. Data may disappear on process restart or after match expiry.

Use server-sent events for one-way realtime updates.

Conceptual endpoints:

```text
POST /debug/build-v2/login
GET  /debug/build-v2/matches
GET  /debug/build-v2/matches/:matchId
GET  /debug/build-v2/matches/:matchId/stream
```

### 12.4 Required UI

After choosing an active matchId, the page must show:

- Statlocker source status and top-10 profile summary
- all mined archetypes
- rejected archetype clusters and rejection reasons
- quality-gate results
- full enemy roster used for initial selection
- per-archetype VS_HERO_WPA selection score
- selected and locked archetype
- current live enemy-threat breakdown
- current inventory and slots
- CHOICE/OR groups with accepted/rejected candidates
- outside-archetype discovery candidates
- score decomposition: STRUCTURE + MATCHUP + PROGRESSION - TRANSITION
- replacement candidates and selected sell source
- plan-change/hysteresis decisions
- current full lifetime build
- degraded/missing evidence flags
- inventory-simulation validity

Use expandable details so the page stays readable while preserving complete diagnostics.

## 13. WPA observability regression

Production previously had VS_HERO_WPA rows in storage while recommendation decisions reported `VS_HERO_WPA:UNAVAILABLE` and observed zero WPA queries. V2 must include an integration regression that exercises the real repository/evidence path and proves:

- a query occurs
- the correct hero/enemy/item rows are read
- count reaches shrinkage/confidence logic
- deltaWpa reaches matchup scoring
- telemetry/debug trace records query activity

The debugger must make this visible for a live match.

## 14. Real captured-data E2E

### 14.1 Fixture extraction

Build at least one deterministic E2E fixture from real rows already present in the project's Statlocker/database storage. During implementation, extract the minimal required data for a chosen hero/scenario:

- top-10 PRO_BUILD_ANALYSIS payloads
- leaderboard provenance needed to prove top-10 selection
- relevant VS_HERO_WPA rows
- relevant WPA_PATCH_DATA rows
- relevant T4_CHAINS rows
- catalog/mechanics data required to simulate the build
- one representative live-state snapshot or short sequence

After extraction, store the fixture deterministically in the test suite. CI must not depend on current production DB contents or live Statlocker responses on every run.

### 14.2 E2E path

The test executes the real V2 path:

```text
real captured Statlocker fixture
 -> top-10 load
 -> archetype mining
 -> semantic dedup/groups/partial order
 -> quality gate
 -> publish
 -> full enemy roster
 -> VS_HERO_WPA archetype selection
 -> lock
 -> live threat
 -> CHOICE resolution
 -> outside-archetype discovery
 -> full inventory simulation
 -> BUY/UPGRADE/REPLACE plan
 -> API response
 -> structured debug trace
 -> coherent full lifetime build
```

### 14.3 Assertions

The E2E must assert more than HTTP 200 or `build.length > 7`:

- real top-10 profiles were consumed
- at least one valid archetype was produced
- multiple archetypes, when present, are selected by VS_HERO_WPA and then locked
- semantic duplicates are absent
- CHOICE remains CHOICE rather than duplicate sequential goals
- order graph is acyclic
- full plan is non-empty and meaningfully progresses through the archetype
- plan may exceed inventory capacity
- held inventory remains legal after every projected step
- UPGRADE is not mislabeled SELL
- REPLACE identifies both sell and buy items
- outside-archetype adaptation obeys evidence thresholds
- missing optional evidence cannot erase the base build
- major debug trace stages are present
- the final output is a normal coherent full build rather than the previous seven-item artifact

### 14.4 Required human-visible output

When this E2E is implemented and run, the implementation session must separately show the actual result in chat, including:

```text
Hero: <real hero>
Source profiles: 10
Archetypes found: <N>
Archetype summaries: ...
Selected archetype: ...
VS_HERO_WPA selection evidence: ...
Important CHOICE decisions: ...
Outside-archetype decisions: ...

FULL BUILD:
1. BUY ...
2. BUY ...
3. UPGRADE ...
...
N. REPLACE ... -> ...

Inventory simulation: PASS/FAIL
Full progression validation: PASS/FAIL
```

If the resulting build is obviously semantically poor, implementation is not considered successful just because types, HTTP contracts, and mechanics tests pass.

## 15. Regression suite

### 15.1 Billy root-cause regression

Use captured Billy evidence from the known production failure. Also keep a minimal synthetic companion case:

```text
Profile A: A B C D
Profile B: A C B D
```

Expected behavior:

- A, B, C, D remain represented
- B and C are not duplicated
- no unsupported hard B->C or C->B edge appears
- D remains reachable despite order variation

This tests the root cause rather than a magic build-length threshold.

### 15.2 Miner tests

- same build with minor order differences -> one archetype
- same build with one situational variation -> one archetype with CHOICE/FLEX variation
- two coherent structurally distinct families -> two archetypes
- nine coherent profiles plus one outlier -> no one-profile archetype

### 15.3 Selector/lock tests

- full enemy roster + VS_HERO_WPA selects archetype
- KDA/souls/damage/level are absent from selector input
- WPA unavailable at selection -> offline default lock
- later WPA availability does not switch archetype
- later extreme live threat does not switch archetype

### 15.4 Runtime adaptation tests

- threat-weighted CHOICE can change before purchase
- weak evidence cannot force sale of an already-purchased item
- strong evidence may replace CORE when the higher threshold is crossed
- outside-archetype Statlocker-backed candidate may enter with sufficient evidence
- tiny-sample large WPA cannot bypass confidence thresholds

### 15.5 Full-plan mechanics tests

- lifetime plan longer than inventory capacity
- legal projected inventory after every transition
- explicit REPLACE under slot pressure
- whole-inventory replacement scoring, not cheapest-sale selection
- correct UPGRADE recipe semantics
- recent-purchase/churn protection
- anti-jitter hysteresis

### 15.6 Degraded-mode tests

- VS_HERO_WPA unavailable
- T4_CHAINS unavailable
- partial Statlocker evidence
- failed refresh retains previous valid snapshot
- no V1 fallback

## 16. V1 migration policy

Remove from the production recommendation path:

- ordinal trajectory archetype mining
- positional strategy compilation
- BuildStrategySpecV1 goals as primary semantic build authority
- ordinal branch goals
- V1 strategy contract as runtime authority
- situationalWindows as permission for matchup discovery
- semantic full-build truncation to inventory capacity

Preserve or adapt only semantics that remain valid:

- item graph, recipes, upgrade families
- BUY/UPGRADE/REPLACE mechanics
- WPA sample shrinkage
- enemy threat weighting
- T4 chain evidence
- outside-skeleton matchup discovery concept
- plan-switch/sell/core-replacement threshold ordering
- recent-purchase/churn protection
- legality and slot validation

Reuse code only when its semantics match V2. Do not preserve V1 abstractions merely to reduce diff size.

## 17. Deployment

No V1 shadow comparison is required. Before direct production cutover, V2 must pass captured Statlocker fixtures, Billy regression, miner/group/order tests, quality-gate tests, selector/lock tests, WPA repository integration, runtime adaptation, outside-archetype tests, full lifetime plan tests, SELL/REPLACE/UPGRADE mechanics, anti-jitter, degraded-mode tests, browser-debugger API/UI tests, API contract tests, and the real captured-data E2E.

After deploy, verify production telemetry and the browser debugger, not only HTTP status:

- valid archetype snapshot loaded
- archetype locked for active matches
- full plan populated
- WPA query count nonzero where evidence should exist
- no semantic truncation to held-item capacity
- no inventory invariant violations
- no V1 fallback
- current production decision is explainable by matchId

## 18. Definition of Done

V2 is complete only when:

1. Base structure comes only from top-10 Statlocker PRO_BUILD_ANALYSIS.
2. No ordinal-position strategy compiler remains on the production recommendation path.
3. Profile order variation cannot silently delete semantic items.
4. Multiple archetypes require real profile-level structural separation.
5. Full enemy roster selects one archetype using VS_HERO_WPA only.
6. The selected archetype is immutable for the match.
7. Initial WPA failure locks a valid offline default immediately.
8. Live threat changes decisions only inside the locked archetype.
9. Outside-archetype Statlocker-backed situational candidates are supported.
10. Runtime score is explainable as STRUCTURE + MATCHUP + PROGRESSION - TRANSITION.
11. Full lifetime plans may exceed simultaneous inventory capacity.
12. Projected inventory stays mechanically legal after every step.
13. SELL/REPLACE is based on resulting inventory utility, not sale price alone.
14. CORE/REQUIRED replacement requires materially stronger evidence.
15. Hysteresis prevents score-noise oscillation.
16. Missing WPA/T4 degrades adaptation without deleting the base build.
17. Production never falls back to broken V1 positional strategy.
18. A password-protected read-only browser debugger is available in production by matchId and updates in realtime.
19. The debugger exposes all major accept/reject decisions and scoring stages needed to locate failures.
20. A deterministic E2E fixture extracted from real project Statlocker/database rows executes the full pipeline and ends with a coherent full build.
21. The actual E2E build and important decisions are shown separately to the user in chat after implementation and test execution.
22. The Billy regression proves the original seven-item positional-support-collapse failure class is removed.
