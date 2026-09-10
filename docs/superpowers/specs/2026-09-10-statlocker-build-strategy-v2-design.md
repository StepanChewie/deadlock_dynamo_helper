# Statlocker Build Strategy V2 Design

Date: 2026-09-10
Status: Approved design
Scope: Production recommendation architecture, browser debug UI, and captured-data end-to-end validation

## 1. Problem statement

The current production strategy pipeline can produce semantically incomplete builds even when the upstream Statlocker data contains much richer information. The observed Billy production failure produced only seven unique recommended items. The failure was not caused by a seven-item UI limit or inventory capacity. The root problem is the V1 strategy compilation model: variable-length and variable-order build trajectories are aligned by ordinal transaction position, per-position support becomes diluted, valid milestones are discarded, survivors can be duplicated across positions or branch/soft goals, and the planner then faithfully renders only the small set of unique items that survived compilation.

V2 replaces positional trajectory compilation with a Statlocker-first semantic model. The system will derive one or more coherent build archetypes from the top 10 Statlocker player build analyses for a hero, choose one archetype once at the beginning of a match using only VS_HERO_WPA against the full enemy roster, lock that archetype for the rest of the match, and continuously resolve the best full lifetime build inside that locked archetype using live matchup context.

The full build is not a fixed final inventory. It is an ordered inventory-evolution plan that may be longer than simultaneous inventory capacity and may include BUY, UPGRADE, SELL, and REPLACE transitions.

## 2. Non-goals and hard constraints

V2 must obey the following source and behavior constraints:

- Build evidence comes from Statlocker only.
- Do not use Deadlock API for build sourcing.
- Do not depend on historical match IDs that the system does not already have.
- Do not use raw historical match trajectories as the authoritative source for build structure.
- Current live match state is allowed for runtime adaptation because it is current match context, not historical build sourcing.
- Exactly 10 top Statlocker player profiles per hero are used for the base archetype evidence when 10 valid profiles are available.
- Multiple archetypes are allowed only when the top-10 profile set shows strong, coherent separation. Weak separation produces one consensus archetype.
- Archetype selection happens once after the full enemy roster is known.
- Once selected, the archetype is immutable for the remainder of the match.
- At archetype-selection time, KDA, souls, damage, level, and other live-performance signals are not used because all players begin from an effectively equal baseline. The match-dependent selector uses VS_HERO_WPA against the full enemy roster.
- After archetype lock, live threat signals may change item choices, item order, situational additions, future SELL decisions, and future REPLACE decisions, but never the locked archetype.
- No shadow deployment against the broken V1 strategy path is required. V2 is validated offline and then directly cut over.
- Broken V1 strategy must not be a production fallback.

## 3. Authoritative data sources

### 3.1 Base build structure

The sole authoritative source for base build structure is Statlocker PRO_BUILD_ANALYSIS for the top 10 hero profiles discovered from Statlocker HERO_LEADERBOARD.

The build-analysis contract already exposes the semantic fields needed by V2:

- itemId
- purchaseRate
- medianBuyTimeS
- frequencyTier: CORE, FREQUENT, SOMETIMES, FLEX
- phase: EARLY, MID, LATE
- relationships
- optional explicitGroup: REQUIRED, CHOICE, OPTIONAL with minSelect/maxSelect

PRO_BUILD_ANALYSIS is an aggregated build blueprint. It is not a per-match transaction or sale trace. V2 must not pretend it contains historical SELL lifecycle information.

### 3.2 Matchup and global evidence

Statlocker datasets have distinct authority:

- HERO_LEADERBOARD: discovers the top 10 account IDs for a hero.
- PRO_BUILD_ANALYSIS: authoritative base build structure.
- VS_HERO_WPA: item-vs-specific-enemy matchup adaptation and initial archetype selection.
- WPA_PATCH_DATA: global item strength, game-state, phase, and timing evidence.
- T4_CHAINS: item-chain and synergy evidence.
- WPA_FILTERED_ITEMS: optional Statlocker-backed candidate discovery if V2 explicitly adds guaranteed ingestion. It must never be assumed available unless the refresh path actually loads it.
- CONSENSUS_SKELETON: an internal derived dataset only, not an external source of truth.

### 3.3 Live match context

The current live decision state may provide:

- our hero and inventory
- enemy hero IDs
- enemy KDA
- enemy souls
- enemy hero damage
- enemy level
- ally/enemy observed items
- team souls/economy
- game time and phase
- current inventory capacity and slot state

These signals are used only after archetype lock to weight runtime item utility and transition decisions.

## 4. High-level architecture

The production flow is:

```text
STATLOCKER
   |
   +-- HERO_LEADERBOARD(heroId)
   |      |
   |      v
   |   TOP 10 profiles
   |      |
   |      v
   +-- PRO_BUILD_ANALYSIS(accountId, heroId) x 10
   |      |
   |      v
   |   semantic profile blueprints
   |      |
   |      v
   |   BuildArchetypeMinerV2
   |      |
   |      v
   |   1..N BuildArchetypeV2
   |      |
   |      v
   |   BuildArchetypeQualityGateV2
   |      |
   |      v
   |   published valid archetype snapshot
   |
   +-- VS_HERO_WPA
   +-- WPA_PATCH_DATA
   +-- T4_CHAINS

MATCH START
   |
   +-- heroId
   +-- full enemy roster
          |
          v
   BuildArchetypeSelectorV2
   using VS_HERO_WPA only
          |
          v
   LockedArchetypeSessionV2
          |
          v

LIVE MATCH
   |
   +-- locked archetype
   +-- current inventory
   +-- game time / economy / slots
   +-- enemy threat from live state
   +-- VS_HERO_WPA / WPA_PATCH_DATA / T4_CHAINS
          |
          v
   FullBuildResolverV2
          |
          v
   lifetime inventory simulation
          |
          v
   ResolvedFullBuildPlanV2
          |
          +-- API / Overwolf consumer
          +-- production browser debugger
```

## 5. Build archetype mining

### 5.1 Profile-level semantic clustering

Each PRO_BUILD_ANALYSIS is treated as one coherent profile blueprint. Profiles are compared semantically, not by purchase ordinal index.

Similarity features may include:

- item-family composition
- frequency-tier distribution
- explicit group structure
- relationship graph
- phase profile
- median timing profile

V2 must never align `profileA[position]` with `profileB[position]` and infer that they represent the same milestone.

### 5.2 Archetype split rules

A separate archetype exists only when the data shows meaningful, internally coherent separation.

A split must satisfy all of these conceptual requirements:

- more than one top profile supports the cluster
- profiles inside the cluster are materially similar to one another
- the cluster is materially different from another accepted cluster
- the difference concerns build structure, not only one situational item or a small order variation

Exact numeric thresholds are configuration values that must be calibrated against captured real Statlocker snapshots. They are not hardcoded into this design without evidence.

With 10 profiles, the miner should strongly prefer a small number of archetypes. A lone unusual profile must not become its own archetype.

If separation is weak, the correct output is one consensus archetype.

### 5.3 Semantic item representation

Each semantic item or upgrade family appears once in an archetype. Repeated presence in different profile positions must not create duplicate independent goals.

The archetype records evidence such as:

- profile coverage
- weighted purchase rate
- frequency-tier votes
- median buy time and timing spread
- phase
- relationships
- explicit group membership
- structural priority

Upgrade-family canonicalization uses the existing item graph/component-upgrade mechanics, but historical planner trajectories are not used as the archetype source.

### 5.4 Groups

V2 represents semantic groups directly:

- REQUIRED
- CHOICE
- OPTIONAL

Explicit Statlocker groups have greater authority than inferred groups.

A CHOICE group with A/B and minSelect=1, maxSelect=1 means "choose one of A or B". It must never be compiled into two sequential goals.

Inferred CHOICE groups are allowed only with sufficient evidence that candidates are alternatives rather than normal co-occurring items.

### 5.5 Ordering

Ordering is a partial-order graph, not an ordinal purchase list.

Evidence can create edges such as:

```text
A -> D
B -> D
C -> F
D -> G
```

If B and C frequently swap order across profiles, V2 must weaken or omit the B/C ordering edge rather than delete either item.

Timing is evidence for preferred ordering and phase, not a fixed transaction index.

## 6. Archetype quality gate and publishing

Schema validity is not sufficient. A candidate archetype snapshot must pass semantic quality checks before publication.

Required checks include:

- expected Statlocker provenance
- expected hero/patch/catalog compatibility
- sufficient number of valid source profiles
- no duplicate semantic items/families
- no conflicting group membership
- all REQUIRED and CHOICE groups have valid candidates
- valid minSelect/maxSelect bounds
- acyclic ordering graph
- meaningful build progression
- valid item IDs and upgrade paths
- mechanically executable transitions under the current catalog
- sufficient cluster coherence
- sufficient support for every published archetype
- no near-zero-coherence archetype publication

Refresh publication is atomic:

```text
last valid snapshot
      |
      +-- build new snapshot
              |
              +-- PASS -> atomically replace active snapshot
              |
              +-- FAIL -> retain previous valid compatible snapshot
```

A transient Statlocker refresh failure must not replace a valid production strategy with an empty or broken one.

## 7. Archetype selection and lock

### 7.1 Selection timing

The selector waits until the full enemy roster is available.

At that moment, all already-published valid archetypes are eligible. Offline support/coherence has already decided whether an archetype is valid enough to exist. It is not used as a hidden popularity bonus during normal matchup selection.

### 7.2 Match-dependent signal

The only match-dependent selection signal is VS_HERO_WPA against the complete enemy roster.

Each archetype receives a matchup-fitness score derived from the relevant items and groups inside that archetype. Scoring must avoid rewarding an archetype merely because it has more items.

CORE/REQUIRED structure has higher semantic importance than FLEX/OPTIONAL items when aggregating archetype matchup fitness. For CHOICE groups, the selector may evaluate the best admissible choice potential rather than summing every alternative as if all would be purchased.

VS_HERO_WPA contributions must use sample-count confidence/shrinkage so small samples cannot dominate selection.

### 7.3 WPA unavailable at selection time

If VS_HERO_WPA is fully unavailable when the full enemy roster becomes available, the system immediately locks the best offline default archetype instead of waiting.

The offline default is chosen from already-valid archetypes by offline quality/support rules.

The match records a degradation reason such as `ARCHETYPE_SELECTION_WPA_UNAVAILABLE`.

If WPA later becomes available, the archetype remains locked and is not reconsidered.

### 7.4 Immutable lock

The selected archetype ID is immutable for the match.

Later changes in KDA, souls, damage, level, inventory, WPA, or game state may change the resolved full build but must never switch the match to a different archetype.

## 8. Runtime live resolver

### 8.1 Responsibilities

The runtime resolver answers:

"Given the locked archetype, current inventory, current Statlocker evidence, and current live matchup, what is the best full path from the current state through meaningful late-game progression?"

It does not re-mine or switch archetypes.

### 8.2 Enemy threat

Reuse the existing enemy-threat concept. Threat is derived from live signals such as:

- souls
- hero damage
- kills + assists
- level
- deaths

Threat is normalized relative to the enemy team and converted to a bounded multiplier.

At match start, these signals do not participate in archetype selection. During live resolution they weight matchup relevance.

### 8.3 Item utility model

V2 replaces the hard-to-debug monolithic V1 score with four explicit layers:

```text
ITEM UTILITY
= STRUCTURE
+ MATCHUP
+ PROGRESSION
- TRANSITION COST
```

STRUCTURE includes:

- locked-archetype membership
- REQUIRED / CORE / FREQUENT / CHOICE / OPTIONAL / FLEX prior
- explicit group authority
- relationship and T4 coherence with owned/planned items

MATCHUP includes:

- VS_HERO_WPA against each enemy hero
- sample-size confidence/shrinkage
- current enemy threat multiplier
- optional Statlocker global context when available

PROGRESSION includes:

- current phase
- preferred timing
- ordering predecessors
- future upgrade usefulness
- whether the current inventory already satisfies the semantic family

TRANSITION COST includes:

- effective souls cost
- need for SELL/REPLACE
- utility lost by the sold item
- future upgrade path disruption
- plan-change penalty
- recent-purchase protection
- recent sell/rebuy penalty
- slot/economy friction

All score layers and subcomponents must be inspectable through structured debug traces.

### 8.4 WPA confidence

VS_HERO_WPA must not be trusted equally at all sample sizes. Use shrinkage such as the existing `count / (count + K)` concept or a calibrated equivalent.

The exact calibrated K values are policy configuration, not hidden constants spread across services.

### 8.5 Outside-archetype situational discovery

The current V1 system already has the useful concept of discovering a strong matchup item outside the strategy skeleton. V2 keeps that capability but removes its dependency on V1 `situationalWindows`.

A candidate outside the locked archetype may enter the full plan only when:

- it is independently Statlocker-backed for the hero
- matchup coverage is sufficient
- matchup confidence is sufficient
- statistical support is sufficient
- its improvement over the coherent archetype continuation clears a higher situational threshold

An outside-archetype item is treated as SITUATIONAL/FLEX-like evidence, not as a new archetype or a silent rewrite of the base structure.

If entering the item requires replacement, a higher confidence/improvement threshold applies.

### 8.6 CORE and REQUIRED behavior

CORE and REQUIRED are strong structural priors, not absolute locks.

The resolver may replace a CORE/REQUIRED item only when the alternative transition has a substantially larger utility advantage and sufficient evidence confidence.

Threshold ordering should preserve this intent:

```text
future choice switch < ordinary sell/replacement < core replacement
```

Exact values are calibrated policy configuration.

## 9. Full lifetime build planning

### 9.1 Full build semantics

A full build is a projected sequence of strategic inventory transitions from the current state, not a list capped by simultaneous held-item capacity.

Supported transitions are:

- BUY
- UPGRADE
- SELL
- REPLACE

A strategic REPLACE pairs the sold item and replacement target explicitly so the UI can present `SELL X -> BUY Y` as one understandable transition.

### 9.2 Inventory simulation

The planner simulates future inventory after every transition and repeatedly searches for the best next legal transition until meaningful archetype progression is exhausted.

Plan length may exceed inventory capacity.

For example, with capacity 12, this is valid:

```text
1. BUY A
...
12. BUY L
13. REPLACE C -> M
14. REPLACE D -> N
15. UPGRADE F -> O
```

The invariant is not `plan.length <= capacity`. The invariant is that the projected held inventory remains legal after every simulated step.

### 9.3 SELL and REPLACE selection

When a desired next item needs a slot, the resolver compares complete transition outcomes:

```text
SELL A -> BUY M
SELL B -> BUY M
SELL C -> BUY M
...
```

It scores the resulting inventory state, not only the target item and not only the sale price.

The sold-item loss includes:

- structural importance
- matchup value
- future upgrade need
- relationship/chain value
- investment already committed
- recent-purchase protection
- churn/rebuy risk

The best whole-build transition wins.

### 9.4 UPGRADE is not SELL

Recipe/component consumption is represented as UPGRADE, not as SELL.

Only deliberate slot/economy replacement of an item outside the recipe-consumption semantics is shown as SELL or REPLACE.

### 9.5 Replanning and hysteresis

The full future plan may change as the live state changes, but it must not oscillate on score noise.

The next calculation receives the previous plan/revision and applies hysteresis:

- small score differences retain the previous future decision
- recent purchases receive additional protection
- committed near-term steps receive greater stability than distant future steps
- CORE replacement requires the largest margin
- material matchup changes may still change the plan immediately when the improvement is large enough

The browser UI and logs must expose whether a proposed plan change was accepted or suppressed and why.

## 10. Degraded evidence behavior

V2 must degrade by removing unavailable score components, not by removing the build.

Examples:

- VS_HERO_WPA unavailable after lock: continue with locked archetype, structure, progression, inventory, global evidence, and mechanics; mark matchup degradation.
- T4_CHAINS unavailable: chain score is unavailable; continue planning.
- new PRO_BUILD_ANALYSIS refresh invalid: keep the previous valid snapshot.
- matchup query returns no rows: do not pretend matchup adaptation occurred.

The production path must never fall back to the broken V1 positional strategy.

## 11. Structured explainability trace

### 11.1 Purpose

The recommendation pipeline must expose structured decision traces so a developer can determine exactly where candidates, groups, archetypes, and plan steps were accepted, rejected, or truncated.

The debug UI must not parse free-form application logs. The recommendation engine emits a structured `BuildDecisionTraceV2` as part of its debug instrumentation.

### 11.2 Trace stages

A trace revision should expose stages such as:

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

Each stage should expose, when applicable:

- relevant input summary
- candidates considered
- accepted candidates
- rejected candidates
- reason codes
- score decomposition
- confidence/coverage/sample counts
- output passed to the next stage

Example CHOICE trace:

```text
CHOICE: A OR B OR C
A rejected: MATCHUP_SCORE_BELOW_SELECTED
B selected
C rejected: LOW_CONFIDENCE
```

Example replacement trace:

```text
Need slot for M
SELL A -> M: -0.13, rejected CORE_LOSS
SELL C -> M: +0.31, selected
SELL X -> M: +0.22
```

The trace must make it obvious if a future production bug occurs at mining, selection, choice resolution, candidate discovery, plan search, inventory simulation, or presentation.

## 12. Production browser build debugger

### 12.1 Availability

A normal browser-based debug UI is mandatory in production. It is independent of Overwolf.

The first version is read-only. It must not contain controls that force archetype choice, override scores, or mutate the production planner. Its purpose is to inspect the real system, not create a second behavior path.

### 12.2 Authentication

The production debugger is protected by a simple password gate.

Initial production password: `12345`.

The password must be supplied through environment configuration, for example `BUILD_DEBUG_PASSWORD=12345`, and must not be hardcoded into source control.

A minimal login endpoint verifies the password server-side and issues a short-lived HttpOnly, Secure, SameSite=Strict debug session cookie. Debug data endpoints and the realtime stream require that session. The UI remains read-only.

This is intentionally lightweight for V2. Stronger account-based auth is out of scope for this implementation.

### 12.3 Match selection

The debugger shows currently active debug-visible match IDs. The developer selects one `matchId` and sees the current trace.

No permanent per-request history is required.

### 12.4 Realtime model

Maintain a bounded in-memory debug store keyed by matchId.

For each active match retain:

- the current complete trace revision
- a small bounded tail of recent revisions sufficient to show current changes

The store is diagnostic state, not analytics storage. It may be cleared on process restart or after the match expires.

Use server-sent events for realtime browser updates because the flow is one-way from backend to debugger.

Conceptual endpoints:

```text
POST /debug/build-v2/login
GET  /debug/build-v2/matches
GET  /debug/build-v2/matches/:matchId
GET  /debug/build-v2/matches/:matchId/stream
```

### 12.5 Required UI sections

For the selected match, the UI must render at least:

- Statlocker source status and top-10 profile summary
- all mined archetypes
- rejected archetype clusters and rejection reasons
- quality-gate results
- enemy roster used for initial selection
- per-archetype VS_HERO_WPA selection score
- selected and locked archetype
- current live threat breakdown
- current inventory and slot state
- CHOICE/OR groups with accepted/rejected candidates
- outside-archetype discovery candidates
- item score decomposition using STRUCTURE + MATCHUP + PROGRESSION - TRANSITION
- replacement search candidates and selected sell source
- plan-change/hysteresis decisions
- current full lifetime build
- degraded/missing evidence flags
- final inventory-simulation validity

The UI should expose expandable details instead of flattening every raw object into a single unreadable page.

## 13. Observability

Production telemetry must make the following answerable without guessing:

- Which archetype was locked and why?
- Which archetypes were rejected before lock and why?
- Which VS_HERO_WPA rows contributed?
- What sample counts and confidence values were used?
- Which enemy is considered most threatening and why?
- Why did one CHOICE candidate beat another?
- Why did an outside-archetype item enter or fail to enter the plan?
- Why was a specific item selected for SELL/REPLACE?
- Why did the plan change or remain stable after a new live update?
- Which Statlocker datasets were unavailable?
- Did the runtime actually query WPA evidence?

The production regression that previously showed DB WPA rows but `VS_HERO_WPA:UNAVAILABLE` and zero WPA query count must be covered by integration tests that exercise the actual repository and evidence path.

## 14. End-to-end captured-data test

### 14.1 Fixture source

Create at least one deterministic real-data E2E fixture from rows already present in the project database/Statlocker snapshot storage.

The implementation workflow will extract the minimal required real data for a chosen hero/scenario, including as applicable:

- top-10 PRO_BUILD_ANALYSIS payloads
- HERO_LEADERBOARD identity/rank information needed to prove top-10 provenance
- relevant VS_HERO_WPA rows
- relevant WPA_PATCH_DATA rows
- relevant T4_CHAINS rows
- catalog/mechanics data needed to execute the build
- one representative live-state snapshot or sequence

The test fixture is then checked into the test suite or stored as deterministic test data. CI must not depend on live production DB contents or live Statlocker responses during every test run.

### 14.2 Full pipeline coverage

The E2E test must execute the real V2 path:

```text
captured real Statlocker fixture
        -> top-10 load
        -> archetype mining
        -> semantic dedup/group/order compilation
        -> quality gate
        -> archetype publication
        -> full enemy roster
        -> VS_HERO_WPA archetype selection
        -> archetype lock
        -> live threat calculation
        -> choice resolution
        -> outside-archetype discovery
        -> full inventory simulation
        -> BUY / UPGRADE / REPLACE generation
        -> API response
        -> structured debug trace
        -> coherent full lifetime build
```

### 14.3 Final assertions

The E2E test must not merely assert HTTP 200 or `build.length > 7`.

It must assert semantic correctness and invariants:

- real top-10 source profiles were consumed
- at least one valid archetype was produced
- if multiple archetypes are produced, one is selected using VS_HERO_WPA and locked
- duplicate semantic items/families are absent
- CHOICE semantics remain choices rather than duplicated sequential goals
- ordering is a valid DAG
- the final plan is non-empty and meaningfully progresses through the archetype
- plan length is allowed to exceed inventory capacity
- projected held inventory stays legal after every step
- UPGRADE does not masquerade as SELL
- REPLACE identifies both sellItemId and buyItemId
- outside-archetype adaptation obeys confidence/coverage thresholds
- missing optional evidence does not erase the base build
- debug trace contains the major decision stages
- final response contains a normal human-readable full build rather than the previous seven-item artifact

### 14.4 Required human-visible test output

When the E2E test is implemented and run, the implementation session must separately present the actual resulting build to the user in chat.

The report must include at least:

```text
Hero: <name/id>
Source profiles: 10
Archetypes found: <N>

Archetype summaries...

Selected archetype: <id/name>
Selection evidence: VS_HERO_WPA summary

Important CHOICE decisions:
...

Outside-archetype decisions:
...

FULL BUILD:
1. BUY ...
2. BUY ...
3. UPGRADE ...
...
N. REPLACE ... -> ...

Inventory simulation: PASS/FAIL
Full progression validation: PASS/FAIL
```

If the produced build is obviously semantically poor, the implementation must not be declared successful merely because types, HTTP contracts, or mechanical invariants pass.

## 15. Regression suite

### 15.1 Billy root-cause regression

Use captured Billy evidence from the known production failure to prove that order variability no longer deletes semantic milestones.

A synthetic companion test should explicitly cover:

```text
Profile A: A B C D
Profile B: A C B D
```

Expected V2 behavior:

- A, B, C, D all remain represented
- B and C are not duplicated
- no artificial hard B->C or C->B ordering is invented without evidence
- D remains reachable after both ordering variants

The test must assert the semantic cause, not a magic minimum build length.

### 15.2 Miner tests

Cover:

- same build with minor ordering differences -> one archetype
- same build with one situational alternative -> one archetype with choice/flex variation
- two structurally distinct coherent build families -> two archetypes
- one outlier profile among nine coherent profiles -> no one-profile archetype

### 15.3 Selector and lock tests

Cover:

- selection based on full enemy roster plus VS_HERO_WPA
- KDA/souls/damage/level are absent from the selector contract
- WPA unavailable at selection -> offline default lock
- later WPA availability does not switch archetype
- later extreme live threat changes do not switch archetype

### 15.4 Live adaptation tests

Cover:

- threat-weighted CHOICE change before purchase
- already-purchased item protected from weak replacement evidence
- strong evidence can replace a CORE item when configured threshold is exceeded
- outside-archetype situational item can enter with sufficient Statlocker evidence
- tiny-sample large WPA does not bypass confidence thresholds

### 15.5 Full-plan and mechanics tests

Cover:

- lifetime plan longer than inventory capacity
- legal held inventory after every projected transition
- explicit REPLACE when slots are full
- whole-inventory replacement scoring rather than cheapest-item sale
- UPGRADE recipe semantics
- recent purchase/churn protection
- anti-jitter plan hysteresis

### 15.6 Degraded-mode tests

Cover:

- VS_HERO_WPA unavailable
- T4_CHAINS unavailable
- partial Statlocker evidence
- failed new archetype refresh retains previous valid snapshot
- no runtime fallback to V1

### 15.7 WPA repository integration regression

Exercise the real repository/evidence path with stored rows and assert that:

- query occurs
- correct hero/enemy/item rows are read
- count reaches shrinkage
- deltaWpa reaches matchup scoring
- debug/telemetry records nonzero query activity

This specifically prevents recurrence of the production state where rows existed but runtime matchup adaptation reported unavailable evidence.

## 16. V1 migration policy

Remove from the production recommendation path:

- ordinal trajectory archetype mining
- positional strategy compilation
- BuildStrategySpecV1 goals as the primary semantic build model
- branch goals generated from ordinal purchase positions
- V1 strategy contract as the runtime build authority
- situationalWindows as permission for matchup discovery
- semantic full-build truncation to inventory capacity

Preserve and adapt useful concepts:

- item graph / recipes / upgrade families
- BUY / UPGRADE / REPLACE mechanics
- WPA sample shrinkage
- enemy threat weighting
- T4 chain evidence
- outside-skeleton matchup discovery concept
- plan-switch, sell, core-replacement threshold ordering
- recent purchase and churn protection
- legality and slot validation

The V2 implementation may reuse code only when the reused code's semantics match this design. It must not preserve V1 abstractions merely to reduce diff size.

## 17. Deployment

No shadow comparison with V1 is required.

Before direct cutover, V2 must pass:

- captured Statlocker archetype fixtures
- Billy semantic regression
- miner/group/order tests
- quality-gate tests
- selector/lock tests
- real WPA repository integration regression
- live adaptation tests
- outside-archetype tests
- full lifetime plan tests
- SELL/REPLACE/UPGRADE mechanics tests
- anti-jitter tests
- degraded-mode tests
- browser-debugger API/UI tests
- API contract tests
- real captured-data E2E with coherent final build

After deployment, validate production telemetry rather than HTTP status alone:

- valid archetype snapshot loaded
- archetype locked for active matches
- full plan populated
- WPA query count nonzero where evidence should exist
- no semantic truncation to held-item capacity
- no inventory invariant violations
- no V1 fallback
- browser debugger can explain the current production decision by matchId

## 18. Definition of Done

V2 is complete only when all of the following are true:

1. Build structure is derived only from top-10 Statlocker PRO_BUILD_ANALYSIS evidence.
2. No ordinal-position strategy compiler remains on the production recommendation path.
3. Profile order variation cannot silently delete semantic items.
4. Multiple archetypes are published only with strong profile-level structural separation.
5. A full enemy roster selects one archetype using VS_HERO_WPA only.
6. The selected archetype is immutable for the match.
7. If WPA is unavailable during initial selection, a valid offline default archetype is locked immediately.
8. Live threat changes item decisions inside the locked archetype without changing the archetype.
9. Outside-archetype Statlocker-backed situational candidates are supported.
10. Runtime scoring is explainable as STRUCTURE + MATCHUP + PROGRESSION - TRANSITION.
11. Full lifetime plans may exceed simultaneous inventory capacity.
12. Inventory remains mechanically legal after every projected step.
13. SELL/REPLACE is based on whole resulting inventory utility, not simple sale price.
14. CORE/REQUIRED replacement requires materially stronger evidence than ordinary plan changes.
15. Plan hysteresis prevents score-noise oscillation.
16. Missing optional WPA/T4 evidence degrades adaptation without deleting the base build.
17. Production never falls back to broken V1 positional strategy.
18. A password-protected read-only browser debugger is available in production by matchId and updates in realtime.
19. The debugger exposes every major accept/reject decision and score decomposition needed to identify where a plan went wrong.
20. A deterministic E2E fixture extracted from real project Statlocker/database rows runs the full V2 pipeline and ends with a coherent full build.
21. The actual E2E output build is shown separately to the user in chat when the test is implemented and run.
22. The captured Billy regression proves the original seven-item failure class cannot recur through positional-support collapse.

## 19. Security note for the initial debugger

The initial debugger password is intentionally simple because the requested first production version is an internal diagnostic tool. The source code must still avoid hardcoding the credential. Production configuration sets `BUILD_DEBUG_PASSWORD=12345`.

The debugger remains read-only, uses a server-validated session, and exposes no planner mutation controls. A later migration to normal project authentication may replace this password gate without changing the trace or debugger data contracts.
