# Statlocker Build Strategy V2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the broken ordinal V1 strategy pipeline with a Statlocker-first semantic archetype system that locks one archetype per match, resolves a complete live lifetime build with BUY/UPGRADE/REPLACE transitions, exposes a production browser debugger, and proves the result with a deterministic real-data E2E fixture.

**Architecture:** The top 10 Statlocker `PRO_BUILD_ANALYSIS` profiles for each hero are normalized into semantic profile blueprints and clustered into one or more coherent archetypes without ordinal purchase alignment. A full enemy roster selects one published archetype using `VS_HERO_WPA` only and persists that immutable match lock; the live resolver then combines locked-archetype structure, threat-weighted matchup evidence, progression, mechanics, and transition cost to produce a full lifetime inventory-evolution plan. Every decision stage emits a structured trace into a bounded in-memory store consumed by a password-protected read-only browser debugger over HTTP/SSE.

**Tech Stack:** TypeScript 5.9, NestJS 11, TypeORM/PostgreSQL, Jest/ts-jest, existing `@deadlock-live-probe/build-domain` item graph, existing Statlocker snapshot/WPA storage, plain browser HTML/CSS/JavaScript served by NestJS.

**Spec:** `docs/superpowers/specs/2026-09-10-statlocker-build-strategy-v2-design.md`

## Global Constraints

- Build structure is derived only from Statlocker `PRO_BUILD_ANALYSIS` for the top 10 Statlocker hero profiles discovered through `HERO_LEADERBOARD` when 10 valid profiles are available.
- Do not use Deadlock API, historical match-ID discovery, or raw historical match trajectories as authoritative build structure.
- Current live match state is allowed only for runtime adaptation after archetype selection.
- Archetype mining is semantic and profile-level; ordinal purchase-position alignment is forbidden.
- Publish multiple archetypes only for strong coherent structural separation; weak separation yields one consensus archetype.
- Wait for the full enemy roster before normal archetype selection.
- Normal match-dependent archetype selection uses `VS_HERO_WPA` only; KDA, souls, hero damage, level, and other live-performance signals do not enter the selector.
- If `VS_HERO_WPA` is unavailable at selection time, immediately lock the best already-valid offline archetype.
- The selected archetype is immutable for the match, including across API calls and process restarts.
- After lock, live threat may alter choices, ordering, situational additions, and future replacements but never the archetype ID.
- Runtime item utility is explainable as `STRUCTURE + MATCHUP + PROGRESSION - TRANSITION`.
- Outside-archetype items are allowed only when independently Statlocker-backed with sufficient evidence.
- Full build means a lifetime inventory-evolution plan; its number of steps may exceed simultaneous inventory capacity.
- `UPGRADE` recipe consumption is not `SELL`; deliberate replacement is represented explicitly as `REPLACE { sellItemId, buyItemId }`.
- Every projected inventory after every plan step must be mechanically legal.
- `CORE`/`REQUIRED` are strong priors, not absolute locks; replacing them requires materially stronger evidence than an ordinary plan change.
- Missing optional WPA/T4 evidence degrades scoring but must not erase the base build.
- The broken V1 positional strategy path is not a fallback and must not remain reachable from the production recommendation route after cutover.
- No V1 shadow deployment is required; validate offline, then cut over directly.
- Production debugger is read-only, available in a normal browser, and protected by `BUILD_DEBUG_PASSWORD`; deployment initially sets that secret to the user-selected value outside source control. `.env.example` contains only a non-secret example value.
- Debugger state is realtime diagnostic state: retain the current trace plus a small bounded revision tail in memory; do not persist every request.
- The deterministic E2E fixture is extracted once from real project Statlocker/database rows and then checked in; CI must not query production DB or live Statlocker.
- When the real-data E2E is implemented and run, its actual full build and important decisions must be shown separately to the user in chat before claiming completion.
- Follow project style: TypeScript, English code comments and Swagger descriptions, regular hyphen characters, and no `| null` in function return types.

---

## File Structure

Keep V2 implementation beside the existing Statlocker adaptive code so it can reuse existing collectors, normalized evidence, item graph mechanics, and NestJS module wiring without a repository-wide relocation.

**Create in `apps/api/src/statlocker-adaptive/`:**

- `build-archetype-v2.ts` - V2 domain contracts for profiles, archetypes, groups, order edges, quality, and snapshots.
- `statlocker-build-profile-v2.ts` - converts normalized `PRO_BUILD_ANALYSIS` payloads into deterministic semantic profile blueprints.
- `build-archetype-similarity-v2.ts` - pure profile similarity/distance functions; no clustering policy.
- `build-archetype-miner-v2.service.ts` - deterministic profile clustering and one-vs-many archetype discovery.
- `build-archetype-compiler-v2.service.ts` - merges each accepted profile cluster into semantic items, groups, relationships, and partial-order edges.
- `build-archetype-quality-gate-v2.service.ts` - rejects incoherent, duplicate, cyclic, incomplete, or mechanically invalid archetypes.
- `build-archetype-snapshot-store-v2.service.ts` - persistent active archetype snapshot store with atomic publication.
- `build-archetype-refresh-v2.service.ts` - reads the current top-10 Statlocker snapshots and mines/publishes V2 archetypes.
- `build-archetype-selector-v2.service.ts` - scores already-valid archetypes against the full enemy roster using `VS_HERO_WPA` only.
- `build-archetype-session-v2.service.ts` - persistent first-write-wins match archetype lock.
- `build-item-utility-v2.service.ts` - explainable STRUCTURE/MATCHUP/PROGRESSION/TRANSITION scoring.
- `matchup-candidate-discovery-v2.service.ts` - Statlocker-backed candidate discovery outside the locked archetype without V1 situational windows.
- `full-build-plan-v2.ts` - lifetime plan, transition, projected-inventory, and validation contracts.
- `full-build-inventory-simulator-v2.ts` - pure inventory transition simulator and invariants.
- `full-build-hysteresis-v2.service.ts` - previous-plan stability and switch/replacement thresholds.
- `full-build-resolver-v2.service.ts` - forward plan search, choice resolution, replacement search, and full lifetime planning.
- `build-decision-trace-v2.ts` - structured explainability contracts and reason codes.
- `build-debug-trace-store-v2.service.ts` - bounded in-memory match trace revisions plus observable update stream.
- `adaptive-recommendation-v2.service.ts` - V2 production orchestration.
- `adaptive-recommendation-v2.controller.ts` - V2 HTTP recommendation/status route used during contract migration.
- `statlocker-build-v2.config.ts` - centralized V2 policy and calibration parameters.

**Create database files:**

- `apps/api/src/deadlock-live/entities/build-archetype-snapshot-v2.entity.ts` - persistent published archetype snapshots.
- `apps/api/src/deadlock-live/entities/build-archetype-match-lock-v2.entity.ts` - immutable per-match lock.
- `apps/api/src/database/migrations/1789056000000-create-build-archetype-v2-runtime.ts` - both V2 runtime tables and indexes.

**Create production debugger files in `apps/api/src/build-debug-v2/`:**

- `build-debug-v2.module.ts` - debugger module wiring.
- `build-debug-auth-v2.service.ts` - password validation and signed short-lived session token/cookie.
- `build-debug-auth-v2.guard.ts` - protects debugger data and stream routes.
- `build-debug-v2.controller.ts` - login, UI, active-match, snapshot, and SSE endpoints.
- `build-debug-v2.ui.ts` - browser HTML/CSS shell.
- `build-debug-v2.client.ts` - browser client for login, match selection, snapshot rendering, and SSE updates.

**Create shared/API contract:**

- `packages/shared/src/adaptive-recommendation-v2.ts` - public V2 full-build response contracts.
- Modify `packages/shared/src/index.ts` - export V2 contracts.

**Create tests in `apps/api/test/`:**

- `statlocker-build-profile-v2.spec.ts`
- `build-archetype-miner-v2.spec.ts`
- `build-archetype-compiler-v2.spec.ts`
- `build-archetype-quality-gate-v2.spec.ts`
- `build-archetype-snapshot-store-v2.spec.ts`
- `build-archetype-selector-v2.spec.ts`
- `build-archetype-session-v2.spec.ts`
- `statlocker-vs-hero-wpa-v2.integration.spec.ts`
- `build-item-utility-v2.spec.ts`
- `matchup-candidate-discovery-v2.spec.ts`
- `full-build-inventory-simulator-v2.spec.ts`
- `full-build-resolver-v2.spec.ts`
- `full-build-hysteresis-v2.spec.ts`
- `build-debug-trace-store-v2.spec.ts`
- `adaptive-recommendation-v2.e2e.spec.ts`
- `build-debug-v2.e2e.spec.ts`
- `statlocker-build-v2-real-data.e2e.spec.ts`

**Create deterministic fixture tooling/data:**

- `apps/api/src/scripts/capture-statlocker-build-v2-fixture.ts` - one-off DB extractor using existing TypeORM entities.
- `apps/api/test/fixtures/statlocker-build-v2/billy-real.fixture.json` - frozen real Statlocker/WPA/catalog/live-state input.
- `apps/api/test/fixtures/statlocker-build-v2/billy-real.expected.json` - reviewed expected selected archetype and full-build output.

**Modify existing integration/wiring:**

- `apps/api/src/statlocker-adaptive/statlocker-refresh.service.ts` - trigger V2 archetype refresh only after the required top-10 inputs are available.
- `apps/api/src/statlocker-adaptive/statlocker-adaptive.module.ts` - register V2 entities/services/controller and remove V1 runtime authority at final cutover.
- `apps/api/src/statlocker-adaptive/statlocker-vs-hero-wpa-repository-v1.service.ts` - only if the integration regression exposes a real query/wiring defect; preserve its storage contract if correct.
- `apps/api/src/app.module.ts` - register `BuildDebugV2Module`.
- `.env.example` - document `BUILD_DEBUG_PASSWORD` and optional session TTL/trace-retention settings without committing the production password.
- `apps/overwolf-client/src/adaptive-recommendation-client.ts` - switch production client to V2 endpoint/contract.
- `apps/overwolf-client/src/adaptive-recommendation-client.spec.ts` - V2 transport assertions.
- `apps/overwolf-client/src/adaptive-recommendation-full-build-client.integration.spec.ts` - lifetime build presentation contract.
- `apps/overwolf-client/src/adaptive-recommendation-full-build-path.spec.ts` - preserve full path including replacements instead of a held-slot-capped item list.

---

### Task 1: Define V2 semantic build contracts and deterministic profile normalization

**Files:**
- Create: `apps/api/src/statlocker-adaptive/build-archetype-v2.ts`
- Create: `apps/api/src/statlocker-adaptive/statlocker-build-profile-v2.ts`
- Create: `apps/api/test/statlocker-build-profile-v2.spec.ts`

**Interfaces:**
- Consumes: `StatlockerProBuildAnalysisV1`, `StatlockerProBuildItemV1` from `statlocker-adaptive.types.ts`; `RecommendationItemGraph` for family canonicalization.
- Produces: `StatlockerBuildProfileV2`, `BuildArchetypeV2`, `BuildArchetypeGroupV2`, `BuildOrderEdgeV2`, `BuildArchetypeSnapshotV2`, `toStatlockerBuildProfileV2()`.

- [ ] **Step 1: Write the failing normalization test**

```ts
it('normalizes one Statlocker build analysis without inventing ordinal milestones', () => {
  const profile = toStatlockerBuildProfileV2({
    accountId: '100',
    heroId: 72,
    items: [
      item(11, { purchaseRate: 0.9, medianBuyTimeS: 420, frequencyTier: 'CORE', phase: 'EARLY' }),
      item(22, { purchaseRate: 0.7, medianBuyTimeS: 780, frequencyTier: 'FREQUENT', phase: 'MID' }),
    ],
  }, graph);

  expect(profile.heroId).toBe(72);
  expect(profile.items.map((entry) => entry.itemId)).toEqual([11, 22]);
  expect(profile.items[0]).toMatchObject({ itemId: 11, purchaseRate: 0.9, phase: 'EARLY' });
  expect(Object.keys(profile)).not.toContain('transactions');
  expect(Object.keys(profile)).not.toContain('orderedItemIds');
});
```

- [ ] **Step 2: Run the test and verify the V2 contracts do not exist yet**

Run: `yarn workspace @deadlock-live-probe/api test --runTestsByPath test/statlocker-build-profile-v2.spec.ts`

Expected: FAIL because `statlocker-build-profile-v2` / V2 contracts are not defined.

- [ ] **Step 3: Add the semantic contracts**

Define these stable shapes in `build-archetype-v2.ts`:

```ts
export type BuildArchetypeRoleV2 = 'CORE' | 'FREQUENT' | 'SITUATIONAL' | 'FLEX';
export type BuildArchetypeGroupTypeV2 = 'REQUIRED' | 'CHOICE' | 'OPTIONAL';
export type BuildPhaseV2 = 'EARLY' | 'MID' | 'LATE';

export interface StatlockerBuildProfileItemV2 {
  itemId: number;
  familyId: number;
  purchaseRate: number;
  medianBuyTimeS: number;
  frequencyTier: 'CORE' | 'FREQUENT' | 'SOMETIMES' | 'FLEX';
  phase: BuildPhaseV2;
  relationships: readonly { itemId: number; strength: number }[];
  explicitGroup?: {
    type: BuildArchetypeGroupTypeV2;
    groupKey: string;
    minSelect: number;
    maxSelect: number;
  };
}

export interface StatlockerBuildProfileV2 {
  accountId: string;
  heroId: number;
  leaderboardRank?: number;
  items: readonly StatlockerBuildProfileItemV2[];
}

export interface BuildArchetypeItemV2 {
  itemId: number;
  familyId: number;
  role: BuildArchetypeRoleV2;
  sourceProfileCount: number;
  profileCoverage: number;
  purchaseRate: number;
  timing: { medianBuyTimeS: number; spreadS: number; phase: BuildPhaseV2 };
  structuralPriority: number;
}

export interface BuildArchetypeGroupV2 {
  groupId: string;
  type: BuildArchetypeGroupTypeV2;
  candidateItemIds: readonly number[];
  minSelect: number;
  maxSelect: number;
  source: 'STATLOCKER_EXPLICIT' | 'INFERRED_CONSENSUS';
  confidence: number;
}

export interface BuildOrderEdgeV2 {
  beforeItemId: number;
  afterItemId: number;
  confidence: number;
  sourceProfileCount: number;
  strength: 'HARD' | 'SOFT';
}
```

Also define `BuildArchetypeV2` and `BuildArchetypeSnapshotV2` with hero/patch/catalog/source profile IDs/support/confidence/items/groups/orderEdges/relationships/quality fields from the approved spec.

- [ ] **Step 4: Implement deterministic profile conversion**

`toStatlockerBuildProfileV2(analysis, graph, leaderboardRank?)` must deduplicate identical item IDs, canonicalize `familyId` through the existing item graph upgrade/component family semantics, preserve Statlocker semantic fields, sort relationships and items deterministically, and throw on hero mismatch/empty input rather than inventing data.

- [ ] **Step 5: Run the focused test**

Run: `yarn workspace @deadlock-live-probe/api test --runTestsByPath test/statlocker-build-profile-v2.spec.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/statlocker-adaptive/build-archetype-v2.ts apps/api/src/statlocker-adaptive/statlocker-build-profile-v2.ts apps/api/test/statlocker-build-profile-v2.spec.ts
git commit -m "feat(strategy-v2): add semantic Statlocker build profiles"
```

---

### Task 2: Implement semantic profile similarity and archetype mining

**Files:**
- Create: `apps/api/src/statlocker-adaptive/build-archetype-similarity-v2.ts`
- Create: `apps/api/src/statlocker-adaptive/build-archetype-miner-v2.service.ts`
- Create: `apps/api/src/statlocker-adaptive/statlocker-build-v2.config.ts`
- Create: `apps/api/test/build-archetype-miner-v2.spec.ts`

**Interfaces:**
- Consumes: `readonly StatlockerBuildProfileV2[]`.
- Produces: `BuildArchetypeClusterV2[]` with `clusterId`, `profileAccountIds`, `support`, `internalSimilarity`, `separation`, plus rejection diagnostics.

- [ ] **Step 1: Write failing tests for the four mandatory clustering behaviors**

Test fixtures must cover:

```ts
it('keeps order-only variation in one archetype', () => {
  const clusters = miner.mine([profile('1', [A, B, C, D]), profile('2', [A, C, B, D]), profile('3', [A, B, D, C])]);
  expect(clusters.accepted).toHaveLength(1);
});

it('keeps one situational alternative inside one archetype', () => {
  const clusters = miner.mine([
    profile('1', [A, B, C, D, E]), profile('2', [A, B, C, D, F]),
    profile('3', [A, B, C, D, E]), profile('4', [A, B, C, D, F]),
  ]);
  expect(clusters.accepted).toHaveLength(1);
});

it('separates two structurally distinct coherent build families', () => {
  const clusters = miner.mine([
    profile('1', [A, B, C, D]), profile('2', [A, B, C, D]), profile('3', [A, B, C, D]),
    profile('4', [A, X, Y, Z]), profile('5', [A, X, Y, Z]), profile('6', [A, X, Y, Z]),
  ]);
  expect(clusters.accepted).toHaveLength(2);
});

it('does not publish a one-profile outlier archetype', () => {
  const clusters = miner.mine([...nineCoherentProfiles(), profile('outlier', [X, Y, Z])]);
  expect(clusters.accepted.some((entry) => entry.profileAccountIds.length === 1)).toBe(false);
});
```

- [ ] **Step 2: Run the miner test and verify failure**

Run: `yarn workspace @deadlock-live-probe/api test --runTestsByPath test/build-archetype-miner-v2.spec.ts`

Expected: FAIL because the V2 miner is absent.

- [ ] **Step 3: Implement pure semantic similarity**

Use a deterministic weighted combination of normalized features, with weights centralized in `STATLOCKER_BUILD_V2_CONFIG`. Composition must dominate; timing/order is only a secondary similarity signal. The similarity function must not read item array index.

```ts
export interface BuildProfileSimilarityV2 {
  composition: number;
  tierAgreement: number;
  groupAgreement: number;
  relationshipAgreement: number;
  phaseAgreement: number;
  timingAgreement: number;
  total: number;
}

export function compareBuildProfilesV2(
  left: StatlockerBuildProfileV2,
  right: StatlockerBuildProfileV2,
): BuildProfileSimilarityV2;
```

Composition should use family-aware weighted Jaccard; timing compares medians for shared semantic items/families, never ordinal positions.

- [ ] **Step 4: Implement deterministic small-N clustering**

Because the sample is exactly top-10 and archetype count should remain small, avoid opaque general-purpose ML. Build the pairwise similarity matrix, seed clusters from the most separated coherent profile groups, merge profiles into the best compatible cluster, and reject splits that do not satisfy configured minimum cluster size/internal similarity/separation. If no split passes, return one consensus cluster containing all valid profiles.

All rejected split candidates must include reason codes such as `CLUSTER_TOO_SMALL`, `INSUFFICIENT_INTERNAL_SIMILARITY`, `INSUFFICIENT_SEPARATION`, or `ORDER_ONLY_VARIATION` for debugger use.

- [ ] **Step 5: Run the focused miner suite**

Run: `yarn workspace @deadlock-live-probe/api test --runTestsByPath test/build-archetype-miner-v2.spec.ts`

Expected: PASS for one-consensus, two-archetype, order-variation, and outlier cases.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/statlocker-adaptive/build-archetype-similarity-v2.ts apps/api/src/statlocker-adaptive/build-archetype-miner-v2.service.ts apps/api/src/statlocker-adaptive/statlocker-build-v2.config.ts apps/api/test/build-archetype-miner-v2.spec.ts
git commit -m "feat(strategy-v2): mine semantic Statlocker archetypes"
```

---

### Task 3: Compile profile clusters into semantic archetypes and close the seven-item failure class

**Files:**
- Create: `apps/api/src/statlocker-adaptive/build-archetype-compiler-v2.service.ts`
- Create: `apps/api/test/build-archetype-compiler-v2.spec.ts`

**Interfaces:**
- Consumes: one `BuildArchetypeClusterV2`, its `StatlockerBuildProfileV2[]`, patch/ruleset/catalog identity.
- Produces: one deterministic `BuildArchetypeV2` plus compiler diagnostics.

- [ ] **Step 1: Write the Billy-class semantic regression first**

```ts
it('retains semantic milestones when B and C swap purchase order', () => {
  const archetype = compiler.compile(inputFromProfiles([
    profile('p1', [itemAt(A, 300), itemAt(B, 500), itemAt(C, 700), itemAt(D, 1000)]),
    profile('p2', [itemAt(A, 320), itemAt(C, 510), itemAt(B, 690), itemAt(D, 1020)]),
  ]));

  expect(new Set(archetype.items.map((entry) => entry.itemId))).toEqual(new Set([A, B, C, D]));
  expect(archetype.items.filter((entry) => entry.itemId === B)).toHaveLength(1);
  expect(archetype.items.filter((entry) => entry.itemId === C)).toHaveLength(1);
  expect(hasHardEdge(archetype, B, C)).toBe(false);
  expect(hasHardEdge(archetype, C, B)).toBe(false);
});
```

Add a second test proving duplicate appearances of the same semantic family across profile evidence produce one archetype item/family, not duplicate goals.

- [ ] **Step 2: Run the compiler regression and verify failure**

Run: `yarn workspace @deadlock-live-probe/api test --runTestsByPath test/build-archetype-compiler-v2.spec.ts`

Expected: FAIL because the compiler does not exist.

- [ ] **Step 3: Implement semantic item aggregation**

Aggregate by canonical family/item identity. Compute source profile count, coverage, purchase-rate aggregate, tier votes, timing median/spread, phase distribution, and structural priority. Do not drop an item merely because its timing order varies across profiles.

- [ ] **Step 4: Implement groups**

First merge consistent Statlocker `explicitGroup` declarations by `groupKey`, validate candidate/min/max agreement, and mark them `STATLOCKER_EXPLICIT`. Then infer only clearly substitutable alternatives from low co-occurrence + similar phase/timing + shared structural neighborhood. Never infer a CHOICE solely because items appeared at the same approximate ordinal position.

- [ ] **Step 5: Implement the partial-order graph**

For each semantic pair shared by enough profiles, measure temporal precedence. Emit an edge only when one item precedes the other with configured confidence. Mixed B/C ordering omits or softens the edge while retaining both items. Break no cycles silently; the quality gate in Task 4 rejects cyclic results.

- [ ] **Step 6: Run the compiler suite**

Run: `yarn workspace @deadlock-live-probe/api test --runTestsByPath test/build-archetype-compiler-v2.spec.ts`

Expected: PASS, including the order-swap regression.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/statlocker-adaptive/build-archetype-compiler-v2.service.ts apps/api/test/build-archetype-compiler-v2.spec.ts
git commit -m "feat(strategy-v2): compile semantic archetype graphs"
```

---

### Task 4: Add semantic quality gate and persistent atomic archetype publication

**Files:**
- Create: `apps/api/src/statlocker-adaptive/build-archetype-quality-gate-v2.service.ts`
- Create: `apps/api/src/deadlock-live/entities/build-archetype-snapshot-v2.entity.ts`
- Create: `apps/api/src/statlocker-adaptive/build-archetype-snapshot-store-v2.service.ts`
- Create: `apps/api/src/database/migrations/1789056000000-create-build-archetype-v2-runtime.ts`
- Create: `apps/api/test/build-archetype-quality-gate-v2.spec.ts`
- Create: `apps/api/test/build-archetype-snapshot-store-v2.spec.ts`
- Modify: `apps/api/src/statlocker-adaptive/statlocker-adaptive.module.ts`

**Interfaces:**
- `BuildArchetypeQualityGateV2Service.evaluate(snapshot): BuildArchetypeQualityGateResultV2`.
- `BuildArchetypeSnapshotStoreV2Service.publishValidated(snapshot, quality): Promise<BuildArchetypeSnapshotV2Entity>`.
- `BuildArchetypeSnapshotStoreV2Service.getActive(identity): Promise<BuildArchetypeSnapshotV2>`.

- [ ] **Step 1: Write failing gate tests**

Cover duplicate semantic family, conflicting group membership, invalid min/max, unknown item ID, cyclic order graph, empty/meaningless progression, unsupported one-profile archetype, and a valid multi-profile archetype.

```ts
expect(gate.evaluate(cyclicSnapshot).accepted).toBe(false);
expect(gate.evaluate(cyclicSnapshot).reasonCodes).toContain('ORDER_GRAPH_CYCLE');
expect(gate.evaluate(validSnapshot).accepted).toBe(true);
```

- [ ] **Step 2: Run and verify failure**

Run: `yarn workspace @deadlock-live-probe/api test --runTestsByPath test/build-archetype-quality-gate-v2.spec.ts`

Expected: FAIL because the gate is absent.

- [ ] **Step 3: Implement the gate with explicit reason codes**

No gate failure may be silently repaired during publication. The result must contain `accepted`, `reasonCodes`, per-archetype checks, and mechanics/graph details suitable for the debugger.

- [ ] **Step 4: Write the failing atomic-store test**

The test must prove that publishing a valid snapshot activates it, while attempting to publish an invalid replacement leaves the previous valid snapshot active.

- [ ] **Step 5: Create the V2 persistence entity and migration**

Use a JSONB payload for immutable V2 snapshot contents, plus indexed identity fields: `snapshotId`, `heroId`, `rulesetVersion`, `catalogSha256`, `statlockerPatchId`, `publishedAt`, `isActive`, `sourceProfileCount`, `payload`, `quality`. The same migration also creates the match-lock table used in Task 6 so schema rollout is one atomic migration.

- [ ] **Step 6: Implement transactionally atomic publication**

`publishValidated` must reject `quality.accepted === false` before a transaction. For accepted input, transactionally deactivate the previous compatible hero snapshot and insert/activate the new immutable snapshot. `getActive` must never return a rejected/inactive row.

- [ ] **Step 7: Run gate/store tests**

Run: `yarn workspace @deadlock-live-probe/api test --runTestsByPath test/build-archetype-quality-gate-v2.spec.ts test/build-archetype-snapshot-store-v2.spec.ts`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/statlocker-adaptive/build-archetype-quality-gate-v2.service.ts apps/api/src/deadlock-live/entities/build-archetype-snapshot-v2.entity.ts apps/api/src/statlocker-adaptive/build-archetype-snapshot-store-v2.service.ts apps/api/src/database/migrations/1789056000000-create-build-archetype-v2-runtime.ts apps/api/test/build-archetype-quality-gate-v2.spec.ts apps/api/test/build-archetype-snapshot-store-v2.spec.ts apps/api/src/statlocker-adaptive/statlocker-adaptive.module.ts
git commit -m "feat(strategy-v2): gate and publish archetype snapshots"
```

---

### Task 5: Build top-10 Statlocker archetype refresh pipeline

**Files:**
- Create: `apps/api/src/statlocker-adaptive/build-archetype-refresh-v2.service.ts`
- Create: `apps/api/test/build-archetype-refresh-v2.spec.ts`
- Modify: `apps/api/src/statlocker-adaptive/statlocker-refresh.service.ts`
- Modify: `apps/api/src/statlocker-adaptive/statlocker-adaptive.module.ts`

**Interfaces:**
- Consumes active `HERO_LEADERBOARD` and `PRO_BUILD_ANALYSIS` snapshots from `StatlockerSnapshotStoreService`.
- Produces `refreshHero(heroId, identity): Promise<BuildArchetypeRefreshResultV2>` and publishes only gate-approved V2 snapshots.

- [ ] **Step 1: Write a failing top-10 provenance test**

Fixture a leaderboard with more than 10 profiles and build-analysis snapshots for them. Assert the V2 refresh consumes exactly the first ten ranked valid profiles, preserves account/rank provenance, and ignores profile 11+ for archetype structure.

- [ ] **Step 2: Run and verify failure**

Run: `yarn workspace @deadlock-live-probe/api test --runTestsByPath test/build-archetype-refresh-v2.spec.ts`

Expected: FAIL because the V2 refresh service is absent.

- [ ] **Step 3: Implement V2 refresh composition**

`BuildArchetypeRefreshV2Service` should orchestrate only existing normalized snapshots: leaderboard -> top-10 account IDs -> matching pro build analyses -> semantic profiles -> miner -> compiler -> quality gate -> store. It must not call Deadlock API, historical trajectory services, or discover historical match IDs.

- [ ] **Step 4: Wire it after successful hero Statlocker refresh**

In `StatlockerRefreshService`, call the V2 refresh only after the required leaderboard/build-analysis snapshots for that hero are present. Failure must be reported in refresh diagnostics while preserving the previously active V2 archetype snapshot.

- [ ] **Step 5: Run focused refresh tests**

Run: `yarn workspace @deadlock-live-probe/api test --runTestsByPath test/build-archetype-refresh-v2.spec.ts`

Expected: PASS and prior-active snapshot retained on bad new input.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/statlocker-adaptive/build-archetype-refresh-v2.service.ts apps/api/test/build-archetype-refresh-v2.spec.ts apps/api/src/statlocker-adaptive/statlocker-refresh.service.ts apps/api/src/statlocker-adaptive/statlocker-adaptive.module.ts
git commit -m "feat(strategy-v2): refresh archetypes from Statlocker top ten"
```

---

### Task 6: Select archetype with start-of-match WPA and persist an immutable match lock

**Files:**
- Create: `apps/api/src/deadlock-live/entities/build-archetype-match-lock-v2.entity.ts`
- Create: `apps/api/src/statlocker-adaptive/build-archetype-selector-v2.service.ts`
- Create: `apps/api/src/statlocker-adaptive/build-archetype-session-v2.service.ts`
- Create: `apps/api/test/build-archetype-selector-v2.spec.ts`
- Create: `apps/api/test/build-archetype-session-v2.spec.ts`
- Modify: `apps/api/src/statlocker-adaptive/statlocker-adaptive.module.ts`

**Interfaces:**

```ts
export interface SelectBuildArchetypeV2Input {
  heroId: number;
  enemyHeroIds: readonly number[];
  snapshot: BuildArchetypeSnapshotV2;
  vsHeroRows: readonly StatlockerVsHeroWpaAggregateSourceV1[];
}

export interface BuildArchetypeSelectionV2 {
  archetypeId: string;
  mode: 'VS_HERO_WPA' | 'OFFLINE_DEFAULT';
  scores: readonly { archetypeId: string; score: number; confidence: number; coverage: number }[];
  degradedReasons: readonly string[];
}
```

`BuildArchetypeSessionV2Service.getOrLock(matchId, input): Promise<BuildArchetypeMatchLockV2Entity>` is first-write-wins.

- [ ] **Step 1: Write selector tests proving the contract excludes live-performance signals**

Construct two already-valid archetypes and WPA rows. Assert the higher normalized archetype matchup score wins. The selector input type must contain no KDA, souls, damage, level, or current threat fields.

- [ ] **Step 2: Add the WPA-unavailable fallback test**

With no WPA rows, assert selection mode is `OFFLINE_DEFAULT`, a valid default archetype is returned immediately, and degradation includes `ARCHETYPE_SELECTION_WPA_UNAVAILABLE`.

- [ ] **Step 3: Run selector tests and verify failure**

Run: `yarn workspace @deadlock-live-probe/api test --runTestsByPath test/build-archetype-selector-v2.spec.ts`

Expected: FAIL before selector implementation.

- [ ] **Step 4: Implement length-neutral archetype WPA aggregation**

Score semantic structure rather than summing every item. Normalize item contributions by structural weight mass; REQUIRED/CORE have more weight than OPTIONAL/FLEX; CHOICE groups contribute the best admissible choice potential rather than the sum of all alternatives. Apply sample-size shrinkage to each `VS_HERO_WPA` item/enemy contribution.

- [ ] **Step 5: Write persistent lock tests**

Assert first call creates the lock, second call with radically different WPA returns the same row/archetype, and recreating the service over the same repository returns the persisted lock after simulated process restart.

- [ ] **Step 6: Implement first-write-wins match lock**

Use `matchId` as the database uniqueness boundary. On concurrent insert conflict, read and return the existing row; never update its `archetypeId`. Persist enemy roster at lock, snapshot ID, selection details, degradation reasons, and lock timestamp/game-time when available.

- [ ] **Step 7: Run selector/session tests**

Run: `yarn workspace @deadlock-live-probe/api test --runTestsByPath test/build-archetype-selector-v2.spec.ts test/build-archetype-session-v2.spec.ts`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/deadlock-live/entities/build-archetype-match-lock-v2.entity.ts apps/api/src/statlocker-adaptive/build-archetype-selector-v2.service.ts apps/api/src/statlocker-adaptive/build-archetype-session-v2.service.ts apps/api/test/build-archetype-selector-v2.spec.ts apps/api/test/build-archetype-session-v2.spec.ts apps/api/src/statlocker-adaptive/statlocker-adaptive.module.ts
git commit -m "feat(strategy-v2): lock one WPA-selected archetype per match"
```

---

### Task 7: Prove and repair the real VS_HERO_WPA repository/evidence path

**Files:**
- Create: `apps/api/test/statlocker-vs-hero-wpa-v2.integration.spec.ts`
- Modify only if the test demonstrates a defect: `apps/api/src/statlocker-adaptive/statlocker-vs-hero-wpa-repository-v1.service.ts`
- Modify only if the test demonstrates a defect: `apps/api/src/statlocker-adaptive/statlocker-evidence.service.ts`
- Modify: `apps/api/src/statlocker-adaptive/adaptive-recommendation-observability-v1.service.ts` or replace the specific counter with V2 observability in Task 12.

**Interfaces:**
- The real repository query must return rows keyed by our hero, enemy hero, item, patch/ruleset/catalog identity and expose real query activity to diagnostics.

- [ ] **Step 1: Write an integration regression using actual TypeORM entities**

Insert several `StatlockerVsHeroWpaRowV1Entity` rows for hero 72 with known enemy/item/count/delta WPA values. Exercise the same repository method V2 selector/resolver will call, not a mocked array.

```ts
expect(rows).toEqual(expect.arrayContaining([
  expect.objectContaining({ heroId: 72, enemyHeroId: enemyA, itemId: itemX, count: 800 }),
]));
expect(queryStats.wpaQueryCount).toBeGreaterThan(0);
```

Then feed those returned rows to the matchup scorer and assert `count` affects confidence and `deltaWpa` affects score.

- [ ] **Step 2: Run the integration regression**

Run: `yarn workspace @deadlock-live-probe/api test --runTestsByPath test/statlocker-vs-hero-wpa-v2.integration.spec.ts`

Expected: If current wiring reproduces the production bug, FAIL with missing rows/zero query count. If it already passes on current main, preserve the implementation and keep the regression test as proof instead of making speculative changes.

- [ ] **Step 3: If failing, trace and minimally repair the real query identity/wiring**

Fix the demonstrated mismatch only - patch/ruleset/catalog/scope identity, repository filtering, or evidence-service call omission. Do not add a fallback that fabricates WPA or reads unrelated snapshots.

- [ ] **Step 4: Re-run the integration regression**

Run: `yarn workspace @deadlock-live-probe/api test --runTestsByPath test/statlocker-vs-hero-wpa-v2.integration.spec.ts`

Expected: PASS with nonzero query count and scorer-visible WPA evidence.

- [ ] **Step 5: Commit**

```bash
git add apps/api/test/statlocker-vs-hero-wpa-v2.integration.spec.ts apps/api/src/statlocker-adaptive/statlocker-vs-hero-wpa-repository-v1.service.ts apps/api/src/statlocker-adaptive/statlocker-evidence.service.ts apps/api/src/statlocker-adaptive/adaptive-recommendation-observability-v1.service.ts
git commit -m "test(strategy-v2): lock real VS_HERO_WPA serving path"
```

If no production code needed changes, stage only the integration test and any diagnostics changes actually made.

---

### Task 8: Implement explainable V2 item utility with live enemy threat

**Files:**
- Create: `apps/api/src/statlocker-adaptive/build-item-utility-v2.service.ts`
- Create: `apps/api/test/build-item-utility-v2.spec.ts`
- Modify: `apps/api/src/statlocker-adaptive/statlocker-build-v2.config.ts`

**Interfaces:**

```ts
export interface BuildItemUtilityV2 {
  itemId: number;
  total: number;
  confidence: number;
  layers: {
    structure: BuildScoreLayerV2;
    matchup: BuildScoreLayerV2;
    progression: BuildScoreLayerV2;
    transition: BuildScoreLayerV2;
  };
  reasonCodes: readonly string[];
}
```

Consumes locked archetype, current/projected inventory, `EnemyThreatV1Service` output, `VS_HERO_WPA`, `WPA_PATCH_DATA`, T4 chains, and transition metadata.

- [ ] **Step 1: Write failing layer-decomposition tests**

Assert a normal archetype CORE item receives structural prior, a high-confidence WPA advantage against a high-threat enemy increases matchup value, tiny-sample WPA is strongly shrunk, and transition cost lowers total without hiding its decomposition.

- [ ] **Step 2: Run and verify failure**

Run: `yarn workspace @deadlock-live-probe/api test --runTestsByPath test/build-item-utility-v2.spec.ts`

Expected: FAIL before V2 scorer exists.

- [ ] **Step 3: Implement the four explicit score layers**

Reuse proven pure concepts from `EnemyThreatV1Service`, `ThreatWeightedMatchupV1Service`, T4 chain evidence, and shrinkage, but do not preserve the V1 monolithic component contract. Return every raw/normalized/confidence contribution needed for trace rendering.

- [ ] **Step 4: Add degraded-evidence tests**

Assert missing WPA yields matchup confidence 0 and a valid structure/progression score; missing T4 removes chain contribution without throwing or returning no build candidate.

- [ ] **Step 5: Run focused tests**

Run: `yarn workspace @deadlock-live-probe/api test --runTestsByPath test/build-item-utility-v2.spec.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/statlocker-adaptive/build-item-utility-v2.service.ts apps/api/test/build-item-utility-v2.spec.ts apps/api/src/statlocker-adaptive/statlocker-build-v2.config.ts
git commit -m "feat(strategy-v2): add explainable live item utility"
```

---

### Task 9: Generalize outside-archetype matchup candidate discovery

**Files:**
- Create: `apps/api/src/statlocker-adaptive/matchup-candidate-discovery-v2.service.ts`
- Create: `apps/api/test/matchup-candidate-discovery-v2.spec.ts`

**Interfaces:**
- Consumes all mechanically legal candidates, locked archetype membership, Statlocker hero evidence, and V2 item utility.
- Produces accepted/rejected `BuildCandidateDecisionV2[]` with reason codes and required-improvement metadata.

- [ ] **Step 1: Write the failing discovery tests**

Cover: strong high-sample Statlocker-backed item outside archetype is accepted; huge WPA with tiny sample is rejected; item with no independent Statlocker hero evidence is rejected; replacement candidate requires the higher replacement threshold.

- [ ] **Step 2: Run and verify failure**

Run: `yarn workspace @deadlock-live-probe/api test --runTestsByPath test/matchup-candidate-discovery-v2.spec.ts`

Expected: FAIL before V2 discovery exists.

- [ ] **Step 3: Implement discovery without `situationalWindows`**

Scan mechanically legal item targets not already satisfied by the locked archetype path. Require Statlocker-backed candidate evidence, matchup coverage, matchup confidence, statistical support, and improvement over coherent continuation. Do not import or inspect V1 `BuildSituationalWindowV1`.

- [ ] **Step 4: Run focused tests**

Run: `yarn workspace @deadlock-live-probe/api test --runTestsByPath test/matchup-candidate-discovery-v2.spec.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/statlocker-adaptive/matchup-candidate-discovery-v2.service.ts apps/api/test/matchup-candidate-discovery-v2.spec.ts
git commit -m "feat(strategy-v2): discover Statlocker matchup items outside archetype"
```

---

### Task 10: Implement lifetime plan contracts and pure inventory simulation

**Files:**
- Create: `apps/api/src/statlocker-adaptive/full-build-plan-v2.ts`
- Create: `apps/api/src/statlocker-adaptive/full-build-inventory-simulator-v2.ts`
- Create: `apps/api/test/full-build-inventory-simulator-v2.spec.ts`

**Interfaces:**

```ts
export type FullBuildActionV2 = 'BUY' | 'UPGRADE' | 'REPLACE';

export interface FullBuildStepV2 {
  sequence: number;
  action: FullBuildActionV2;
  buyItemId: number;
  sellItemId?: number;
  consumedItemIds: readonly number[];
  inventoryBefore: readonly number[];
  inventoryAfter: readonly number[];
  reasonCodes: readonly string[];
}

export interface ResolvedFullBuildPlanV2 {
  planRevision: string;
  matchId: string;
  heroId: number;
  archetypeId: string;
  stateRevision: string;
  steps: readonly FullBuildStepV2[];
  degradedReasons: readonly string[];
  validation: { valid: boolean; reasonCodes: readonly string[] };
}
```

A deliberate sale+purchase is represented by `REPLACE` with both IDs; recipe consumption is `UPGRADE` with `consumedItemIds`.

- [ ] **Step 1: Write failing simulator invariants**

Build a capacity-12 scenario with more than 12 strategic transitions. Assert `steps.length > 12` is allowed while every `inventoryAfter.length <= capacity`; assert a replacement removes exactly the sold item and adds the bought item; assert upgrade consumption does not emit a sell.

- [ ] **Step 2: Run and verify failure**

Run: `yarn workspace @deadlock-live-probe/api test --runTestsByPath test/full-build-inventory-simulator-v2.spec.ts`

Expected: FAIL because simulator/contracts are absent.

- [ ] **Step 3: Implement pure transition application and validation**

`applyFullBuildStepV2(state, step, graph, slotRules)` returns the next projected inventory or a typed validation error. It must use the existing catalog/item graph to validate target existence, upgrade recipe/component consumption, duplicate satisfaction, and slot capacity after the transition.

- [ ] **Step 4: Add an explicit anti-truncation regression**

Assert no helper in this module slices plan rows to capacity. The plan may contain 15 transitions while projected held inventory never exceeds 12.

- [ ] **Step 5: Run focused tests**

Run: `yarn workspace @deadlock-live-probe/api test --runTestsByPath test/full-build-inventory-simulator-v2.spec.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/statlocker-adaptive/full-build-plan-v2.ts apps/api/src/statlocker-adaptive/full-build-inventory-simulator-v2.ts apps/api/test/full-build-inventory-simulator-v2.spec.ts
git commit -m "feat(strategy-v2): add lifetime inventory simulation"
```

---

### Task 11: Implement full-build search, CHOICE resolution, whole-inventory replacement, and hysteresis

**Files:**
- Create: `apps/api/src/statlocker-adaptive/full-build-resolver-v2.service.ts`
- Create: `apps/api/src/statlocker-adaptive/full-build-hysteresis-v2.service.ts`
- Create: `apps/api/test/full-build-resolver-v2.spec.ts`
- Create: `apps/api/test/full-build-hysteresis-v2.spec.ts`
- Modify: `apps/api/src/statlocker-adaptive/statlocker-build-v2.config.ts`

**Interfaces:**
- `FullBuildResolverV2Service.resolve(input): ResolvedFullBuildPlanV2`.
- `FullBuildHysteresisV2Service.choose(previous, candidate, context): BuildPlanSwitchDecisionV2`.

- [ ] **Step 1: Write failing resolver tests for normal progression and CHOICE**

Use a locked archetype with `A`, `B`, then `D OR E`, then `F`. Make E win by high-confidence live matchup utility and assert the full plan continues beyond E rather than returning only a next item.

- [ ] **Step 2: Add failing whole-inventory replacement test**

With a full inventory and desired `M`, provide transition utilities where `SELL C -> BUY M` beats selling A/B/D. Assert the emitted step is exactly `REPLACE { sellItemId: C, buyItemId: M }`; the cheapest item must not win merely because it is cheapest.

- [ ] **Step 3: Add failing CORE replacement threshold test**

Assert a small improvement does not replace CORE, while a materially larger high-confidence improvement can replace CORE. Keep threshold ordering centralized: future choice switch < ordinary replacement < core replacement.

- [ ] **Step 4: Run and verify failure**

Run: `yarn workspace @deadlock-live-probe/api test --runTestsByPath test/full-build-resolver-v2.spec.ts`

Expected: FAIL before resolver exists.

- [ ] **Step 5: Implement bounded deterministic forward search**

Generate the next legal semantic candidates from unmet archetype groups/order constraints plus accepted outside-archetype candidates. Score candidate transitions, simulate resulting inventory, and continue until no meaningful progression remains or a configured safety step bound is hit. The safety bound limits runaway search, not normal output to inventory capacity.

- [ ] **Step 6: Implement replacement search over resulting inventory utility**

For a target requiring a slot, generate one candidate transition per legal sell source and score each complete resulting state. Include sold-item structural/matchup/upgrade/relationship loss, sunk investment, churn, and recent-purchase protection.

- [ ] **Step 7: Write and run hysteresis tests**

```ts
expect(hysteresis.choose(previousPlan, tinyImprovement, context).action).toBe('KEEP_PREVIOUS');
expect(hysteresis.choose(previousPlan, materialImprovement, context).action).toBe('SWITCH_TO_CANDIDATE');
```

Also assert near-term committed steps receive more protection than distant future steps.

Run: `yarn workspace @deadlock-live-probe/api test --runTestsByPath test/full-build-hysteresis-v2.spec.ts`

Expected: PASS after implementation.

- [ ] **Step 8: Run resolver + simulator suites together**

Run: `yarn workspace @deadlock-live-probe/api test --runTestsByPath test/full-build-resolver-v2.spec.ts test/full-build-hysteresis-v2.spec.ts test/full-build-inventory-simulator-v2.spec.ts`

Expected: PASS with lifetime plan longer than capacity where fixture requires replacements.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/statlocker-adaptive/full-build-resolver-v2.service.ts apps/api/src/statlocker-adaptive/full-build-hysteresis-v2.service.ts apps/api/test/full-build-resolver-v2.spec.ts apps/api/test/full-build-hysteresis-v2.spec.ts apps/api/src/statlocker-adaptive/statlocker-build-v2.config.ts
git commit -m "feat(strategy-v2): resolve full adaptive lifetime builds"
```

---

### Task 12: Add structured decision traces and bounded realtime trace storage

**Files:**
- Create: `apps/api/src/statlocker-adaptive/build-decision-trace-v2.ts`
- Create: `apps/api/src/statlocker-adaptive/build-debug-trace-store-v2.service.ts`
- Create: `apps/api/test/build-debug-trace-store-v2.spec.ts`
- Modify: `apps/api/src/statlocker-adaptive/build-archetype-refresh-v2.service.ts`
- Modify: `apps/api/src/statlocker-adaptive/build-archetype-selector-v2.service.ts`
- Modify: `apps/api/src/statlocker-adaptive/full-build-resolver-v2.service.ts`

**Interfaces:**

```ts
export type BuildDecisionTraceStageV2 =
  | 'SOURCE'
  | 'ARCHETYPE_MINING'
  | 'ARCHETYPE_QUALITY_GATE'
  | 'ARCHETYPE_SELECTION'
  | 'LIVE_CONTEXT'
  | 'CANDIDATE_DISCOVERY'
  | 'CHOICE_RESOLUTION'
  | 'ITEM_SCORING'
  | 'PLAN_SEARCH'
  | 'REPLACEMENT_SEARCH'
  | 'FINAL_PLAN';

export interface BuildDecisionTraceV2 {
  matchId: string;
  revision: number;
  stateRevision: string;
  generatedAt: string;
  stages: readonly BuildDecisionTraceStageEntryV2[];
  finalPlan?: ResolvedFullBuildPlanV2;
}
```

Trace store:

```ts
put(trace: BuildDecisionTraceV2): void;
get(matchId: string): BuildDecisionTraceV2 | undefined;
listActive(): readonly BuildDebugMatchSummaryV2[];
revisions(matchId: string): readonly BuildDecisionTraceV2[];
observe(matchId: string): Observable<BuildDecisionTraceV2>;
```

- [ ] **Step 1: Write failing trace-store tests**

Assert current trace is returned, revisions are monotonic, only configured tail size is retained, match expiry removes stale traces, and observers receive the new revision.

- [ ] **Step 2: Run and verify failure**

Run: `yarn workspace @deadlock-live-probe/api test --runTestsByPath test/build-debug-trace-store-v2.spec.ts`

Expected: FAIL before trace contracts/store exist.

- [ ] **Step 3: Implement immutable structured trace entries**

Use typed stage payloads for mining candidates/rejections, gate results, archetype WPA scores, live threat, CHOICE candidates, outside candidates, item layer scores, plan search branches, replacement candidates, hysteresis decision, and final validation. Keep raw payloads bounded: store summaries and only the candidate/evidence rows actually used by the decision.

- [ ] **Step 4: Implement bounded in-memory store with RxJS stream**

Keep current trace plus a small configured revision tail per match; no database persistence. Include inactivity expiry. Never log or expose the debugger password/session token inside the trace.

- [ ] **Step 5: Instrument mining, selector, and resolver at their real decision points**

Do not reconstruct the trace after the fact from the final plan. Each service contributes accepted/rejected candidates and reason codes while the decision is actually being made.

- [ ] **Step 6: Run focused trace tests plus resolver regression**

Run: `yarn workspace @deadlock-live-probe/api test --runTestsByPath test/build-debug-trace-store-v2.spec.ts test/full-build-resolver-v2.spec.ts`

Expected: PASS and resolver test can assert trace includes `CHOICE_RESOLUTION`, `REPLACEMENT_SEARCH`, and `FINAL_PLAN` when applicable.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/statlocker-adaptive/build-decision-trace-v2.ts apps/api/src/statlocker-adaptive/build-debug-trace-store-v2.service.ts apps/api/test/build-debug-trace-store-v2.spec.ts apps/api/src/statlocker-adaptive/build-archetype-refresh-v2.service.ts apps/api/src/statlocker-adaptive/build-archetype-selector-v2.service.ts apps/api/src/statlocker-adaptive/full-build-resolver-v2.service.ts
git commit -m "feat(strategy-v2): expose structured build decision traces"
```

---

### Task 13: Add the V2 recommendation API and shared full-build contract

**Files:**
- Create: `packages/shared/src/adaptive-recommendation-v2.ts`
- Modify: `packages/shared/src/index.ts`
- Create: `apps/api/src/statlocker-adaptive/adaptive-recommendation-v2.service.ts`
- Create: `apps/api/src/statlocker-adaptive/adaptive-recommendation-v2.controller.ts`
- Create: `apps/api/test/adaptive-recommendation-v2.e2e.spec.ts`
- Modify: `apps/api/src/statlocker-adaptive/statlocker-adaptive.module.ts`

**Interfaces:**
- `POST /deadlock/adaptive/v2/recommend` accepts match ID/local Steam ID in the same request shape required by current client state lookup.
- Response includes readiness/blockers, immutable archetype lock summary, next immediate action, complete `fullBuild.steps`, score/degradation metadata, and `planRevision`.

- [ ] **Step 1: Add shared V2 API types**

Expose `AdaptiveRecommendationResultV2`, `AdaptiveFullBuildStepV2`, lock summary, and evidence/degradation summary from `@deadlock-live-probe/shared`. Keep V2 response semantically explicit instead of overloading the V1 `recommendedBuild` held-item row list.

- [ ] **Step 2: Write failing API E2E around a mocked live state + real V2 services**

Assert the endpoint waits when live state/full roster is not ready; once ready, it obtains/creates the match lock, resolves a non-empty full plan, returns the same lock on later requests, and exposes lifetime steps without slot-cap truncation.

- [ ] **Step 3: Run and verify failure**

Run: `yarn workspace @deadlock-live-probe/api test --runTestsByPath test/adaptive-recommendation-v2.e2e.spec.ts`

Expected: FAIL before controller/service registration.

- [ ] **Step 4: Implement orchestration**

Sequence: load current live decision state -> require full enemy roster for first lock -> load active compatible V2 archetype snapshot -> query WPA -> get-or-create immutable lock -> build live threat/evidence -> resolve full plan with previous plan for hysteresis -> publish complete trace -> map to shared V2 response.

If optional WPA/T4 is missing, return a degraded but populated plan. If no valid V2 archetype snapshot exists, return a clear not-ready/blocker state; do not invoke V1 strategy fallback.

- [ ] **Step 5: Run API E2E and shared build**

Run: `yarn workspace @deadlock-live-probe/api test --runTestsByPath test/adaptive-recommendation-v2.e2e.spec.ts && yarn workspace @deadlock-live-probe/shared build`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/adaptive-recommendation-v2.ts packages/shared/src/index.ts apps/api/src/statlocker-adaptive/adaptive-recommendation-v2.service.ts apps/api/src/statlocker-adaptive/adaptive-recommendation-v2.controller.ts apps/api/test/adaptive-recommendation-v2.e2e.spec.ts apps/api/src/statlocker-adaptive/statlocker-adaptive.module.ts
git commit -m "feat(strategy-v2): serve complete adaptive full builds"
```

---

### Task 14: Add password-protected production debugger API and SSE

**Files:**
- Create: `apps/api/src/build-debug-v2/build-debug-auth-v2.service.ts`
- Create: `apps/api/src/build-debug-v2/build-debug-auth-v2.guard.ts`
- Create: `apps/api/src/build-debug-v2/build-debug-v2.controller.ts`
- Create: `apps/api/src/build-debug-v2/build-debug-v2.module.ts`
- Create: `apps/api/test/build-debug-v2.e2e.spec.ts`
- Modify: `apps/api/src/app.module.ts`
- Modify: `.env.example`

**Interfaces:**
- `POST /debug/build-v2/login`
- `POST /debug/build-v2/logout`
- `GET /debug/build-v2/matches`
- `GET /debug/build-v2/matches/:matchId`
- `GET /debug/build-v2/matches/:matchId/stream`

- [ ] **Step 1: Write failing auth/data-route E2E tests**

Assert unauthenticated match/stream access is 401; wrong password is 401; correct `BUILD_DEBUG_PASSWORD` produces an HttpOnly session cookie; authenticated request lists current trace matches; logout invalidates the session.

- [ ] **Step 2: Run and verify failure**

Run: `yarn workspace @deadlock-live-probe/api test --runTestsByPath test/build-debug-v2.e2e.spec.ts`

Expected: FAIL before debugger module exists.

- [ ] **Step 3: Implement password/session service without adding a dependency**

Use Node `crypto` to compare password input with `process.env.BUILD_DEBUG_PASSWORD` using timing-safe comparison and to sign an opaque short-lived session value with a process secret derived from a separate `BUILD_DEBUG_SESSION_SECRET`. Require both env variables in production; tests inject deterministic secrets. Cookie flags: `HttpOnly`, `Secure` in production, `SameSite=Strict`, bounded `Max-Age`, path `/debug/build-v2`.

- [ ] **Step 4: Implement read-only match/snapshot/SSE endpoints**

Use NestJS `@Sse()` and `BuildDebugTraceStoreV2Service.observe(matchId)`. The debugger controller must have no mutation endpoint for planner choices, archetype lock, scores, or candidates.

- [ ] **Step 5: Add non-secret env examples**

Append:

```dotenv
BUILD_DEBUG_PASSWORD=replace-with-debug-password
BUILD_DEBUG_SESSION_SECRET=replace-with-random-secret
BUILD_DEBUG_SESSION_TTL_SEC=3600
BUILD_DEBUG_TRACE_TAIL=5
BUILD_DEBUG_TRACE_IDLE_TTL_SEC=1800
```

Production deployment supplies the user-selected password outside git.

- [ ] **Step 6: Run debugger E2E**

Run: `yarn workspace @deadlock-live-probe/api test --runTestsByPath test/build-debug-v2.e2e.spec.ts`

Expected: PASS, including SSE delivery of a later trace revision.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/build-debug-v2 apps/api/test/build-debug-v2.e2e.spec.ts apps/api/src/app.module.ts .env.example
git commit -m "feat(debug): add protected realtime build debugger API"
```

---

### Task 15: Build the normal-browser production debugger UI

**Files:**
- Create: `apps/api/src/build-debug-v2/build-debug-v2.ui.ts`
- Create: `apps/api/src/build-debug-v2/build-debug-v2.client.ts`
- Modify: `apps/api/src/build-debug-v2/build-debug-v2.controller.ts`
- Modify: `apps/api/test/build-debug-v2.e2e.spec.ts`

**Interfaces:**
- `GET /debug/build-v2` serves HTML.
- `GET /debug/build-v2/client.js` serves browser JavaScript.
- UI consumes only the read-only JSON/SSE routes from Task 14.

- [ ] **Step 1: Extend the E2E with failing UI shell assertions**

Assert the HTML is `text/html`, JS is `application/javascript`, both are `no-store`, and the HTML contains a login form, active match selector, stage navigation, current full build panel, and trace revision indicator.

- [ ] **Step 2: Run and verify failure**

Run: `yarn workspace @deadlock-live-probe/api test --runTestsByPath test/build-debug-v2.e2e.spec.ts`

Expected: FAIL until UI routes/assets are served.

- [ ] **Step 3: Implement a self-contained browser UI following the existing Statlocker probe serving pattern**

Do not introduce a new frontend framework. Render expandable sections for source/top-10 profiles, mined/rejected archetypes, quality gate, WPA selection/lock, live threat, CHOICE/OR candidates, outside-archetype discovery, item score decomposition, plan search, replacement search, hysteresis, degraded evidence, final plan, and inventory validation.

The browser must visibly distinguish `SELECTED`, `REJECTED`, and `SUPPRESSED_BY_HYSTERESIS`, and show reason codes and score components instead of only the final list.

- [ ] **Step 4: Implement realtime match selection/client behavior**

After login, load `/matches`; selecting a match loads its current snapshot and opens `EventSource` for that match. On a revision event, replace the visible snapshot with the newest trace while keeping expanded section state where possible. Reconnect SSE with bounded backoff; never send the password after the login POST.

- [ ] **Step 5: Add a fixture-render contract test**

Feed a trace containing two archetypes, an `A OR B` choice, one rejected outside candidate, one selected replacement, and a full plan. Assert the serialized browser payload contains all of those sections and reason codes.

- [ ] **Step 6: Run debugger E2E**

Run: `yarn workspace @deadlock-live-probe/api test --runTestsByPath test/build-debug-v2.e2e.spec.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/build-debug-v2/build-debug-v2.ui.ts apps/api/src/build-debug-v2/build-debug-v2.client.ts apps/api/src/build-debug-v2/build-debug-v2.controller.ts apps/api/test/build-debug-v2.e2e.spec.ts
git commit -m "feat(debug): render realtime build decision pipeline in browser"
```

---

### Task 16: Capture a deterministic Billy fixture from real database Statlocker rows

**Files:**
- Create: `apps/api/src/scripts/capture-statlocker-build-v2-fixture.ts`
- Modify: `apps/api/package.json`
- Create from script output: `apps/api/test/fixtures/statlocker-build-v2/billy-real.fixture.json`

**Interfaces:**
- CLI: `yarn workspace @deadlock-live-probe/api build:v2:capture-fixture --heroId 72 --matchId 676255623445218601 --out test/fixtures/statlocker-build-v2/billy-real.fixture.json`
- Reads existing TypeORM entities only; writes a minimized deterministic JSON fixture.

- [ ] **Step 1: Add the capture script command**

Add to API scripts:

```json
"build:v2:capture-fixture": "ts-node src/scripts/capture-statlocker-build-v2-fixture.ts"
```

- [ ] **Step 2: Implement deterministic extraction**

Read the current compatible `HERO_LEADERBOARD` snapshot for hero 72, resolve its first 10 valid ranked profiles, read those 10 `PRO_BUILD_ANALYSIS` snapshots, relevant `WPA_PATCH_DATA` and `T4_CHAINS`, and relational `StatlockerVsHeroWpaRowV1Entity` rows for hero 72/enemy heroes used by the chosen real match. Include catalog items/recipes/version and enough current-match/live-state data to reconstruct the test decision. Sort every array and remove unrelated rows so the fixture remains reviewable.

The script must fail with an explicit message if it cannot prove top-10 provenance or cannot obtain a full enemy roster for the requested real scenario; it must not silently substitute Deadlock API data.

- [ ] **Step 3: Run the capture against the developer/production-copy database**

Run with the repository's normal database environment configured:

```bash
yarn workspace @deadlock-live-probe/api build:v2:capture-fixture --heroId 72 --matchId 676255623445218601 --out test/fixtures/statlocker-build-v2/billy-real.fixture.json
```

Expected: writes one deterministic JSON fixture with exactly 10 source pro profiles when the stored data is sufficient. If the known Billy match no longer has enough retained live roster data, rerun the same command with another stored Billy match ID that has a full roster; keep hero 72 and document that match ID inside fixture metadata.

- [ ] **Step 4: Validate the fixture is self-contained and free of secrets**

Run:

```bash
yarn workspace @deadlock-live-probe/api build
node -e "const f=require('./apps/api/test/fixtures/statlocker-build-v2/billy-real.fixture.json'); if(f.proBuildAnalyses.length!==10) process.exit(1); console.log(f.heroId, f.proBuildAnalyses.length, f.vsHeroWpaRows.length)"
```

Expected: prints hero 72, profile count 10, and a nonzero WPA row count; fixture contains no DB password, auth token, cookie, or environment secret.

- [ ] **Step 5: Commit the extractor and frozen input fixture**

```bash
git add apps/api/src/scripts/capture-statlocker-build-v2-fixture.ts apps/api/package.json apps/api/test/fixtures/statlocker-build-v2/billy-real.fixture.json
git commit -m "test(strategy-v2): capture real Billy Statlocker fixture"
```

---

### Task 17: Run the real-data full-pipeline E2E and lock a reviewed human-readable full build

**Files:**
- Create: `apps/api/test/statlocker-build-v2-real-data.e2e.spec.ts`
- Create after first reviewed run: `apps/api/test/fixtures/statlocker-build-v2/billy-real.expected.json`

**Interfaces:**
- Consumes frozen fixture from Task 16.
- Executes semantic profiles -> mining -> compile -> gate -> publish -> WPA selection -> persistent lock -> live threat -> candidate discovery -> full resolver -> inventory simulation -> API mapping -> trace.
- Prints one stable human-readable report between markers `BUILD_V2_E2E_REPORT_START` / `BUILD_V2_E2E_REPORT_END`.

- [ ] **Step 1: Write the failing E2E with semantic assertions before creating the golden output**

Assert:

```ts
expect(result.sourceProfileCount).toBe(10);
expect(result.archetypes.length).toBeGreaterThanOrEqual(1);
expect(result.lock.archetypeId).toBeTruthy();
expect(new Set(result.fullBuild.steps.map(stepSemanticKey)).size).toBe(result.fullBuild.steps.length);
expect(result.fullBuild.validation.valid).toBe(true);
expect(result.trace.stages.map((entry) => entry.stage)).toEqual(expect.arrayContaining([
  'SOURCE', 'ARCHETYPE_MINING', 'ARCHETYPE_QUALITY_GATE', 'ARCHETYPE_SELECTION',
  'LIVE_CONTEXT', 'CANDIDATE_DISCOVERY', 'ITEM_SCORING', 'PLAN_SEARCH', 'FINAL_PLAN',
]));
```

For any REPLACE step assert both `sellItemId` and `buyItemId`; for UPGRADE assert recipe consumption semantics; simulate every `inventoryAfter` and assert capacity/mechanics validity. Do not assert a magic `> 7` as the primary correctness condition.

- [ ] **Step 2: Run the real-data E2E and inspect the first actual build**

Run:

```bash
yarn workspace @deadlock-live-probe/api test --runTestsByPath test/statlocker-build-v2-real-data.e2e.spec.ts
```

Expected: the test reaches the V2 full plan and prints the complete report. If it fails because the produced build is semantically incomplete, fix the responsible V2 stage and its focused unit test; do not weaken assertions or declare the E2E successful.

- [ ] **Step 3: Human-review the printed build before freezing expected output**

The report must show:

```text
Hero: Billy (72)
Source profiles: 10
Archetypes found: <actual count>
Archetype summaries: <actual semantic items/groups>
Selected archetype: <actual id>
Selection evidence: <actual VS_HERO_WPA score/coverage/confidence>
Important CHOICE decisions: <actual decisions or none>
Outside-archetype decisions: <actual decisions or none>
FULL BUILD:
<every actual BUY/UPGRADE/REPLACE step in order>
Inventory simulation: PASS
Full progression validation: PASS
```

Copy this exact factual report into the implementation-session chat for the user. The user explicitly requested to see the actual resulting build separately; this is a release gate, not optional documentation.

- [ ] **Step 4: Freeze reviewed expectations**

Create `billy-real.expected.json` containing the reviewed selected archetype semantic identity, ordered strategic action keys, expected group selections, and final validation result. The golden file must be derived from the reviewed fixture run, not auto-regenerated during ordinary CI.

- [ ] **Step 5: Add exact golden comparison and rerun**

Test the deterministic result against `billy-real.expected.json` in addition to semantic invariants.

Run: `yarn workspace @deadlock-live-probe/api test --runTestsByPath test/statlocker-build-v2-real-data.e2e.spec.ts`

Expected: PASS and the printed full build matches the reviewed golden file.

- [ ] **Step 6: Commit**

```bash
git add apps/api/test/statlocker-build-v2-real-data.e2e.spec.ts apps/api/test/fixtures/statlocker-build-v2/billy-real.expected.json
git commit -m "test(strategy-v2): prove full build on real Statlocker data"
```

---

### Task 18: Cut the production client over to V2 and remove V1 runtime fallback authority

**Files:**
- Modify: `apps/overwolf-client/src/adaptive-recommendation-client.ts`
- Modify: `apps/overwolf-client/src/adaptive-recommendation-client.spec.ts`
- Modify: `apps/overwolf-client/src/adaptive-recommendation-full-build-client.integration.spec.ts`
- Modify: `apps/overwolf-client/src/adaptive-recommendation-full-build-path.spec.ts`
- Modify: `apps/api/src/statlocker-adaptive/statlocker-adaptive.module.ts`
- Modify: `apps/api/src/statlocker-adaptive/adaptive-recommendation-v1.controller.ts` only to retire/redirect the old public route in a deliberate way after the client is switched; do not route V2 failures back into V1 planning.
- Modify or delete runtime registrations as necessary for: `build-archetype-miner-v1.service.ts`, `build-strategy-compiler-v1.service.ts`, `build-strategy-mining-pipeline-v1.service.ts`, `build-strategy-selector-v1.service.ts`, `build-strategy-session-v1.service.ts`, `build-contract-v1.service.ts`, `strategy-first-build-planner-v1.service.ts`, `strategy-first-situational-overlay-v1.service.ts`, `consensus-strategy-fallback-v1.service.ts`.

**Interfaces:**
- Overwolf production recommendation fetch uses `/deadlock/adaptive/v2/recommend` and renders the complete V2 lifetime plan.
- No production serving provider may call V1 strategy compilation/planning as fallback.

- [ ] **Step 1: Update client tests first**

Assert V2 endpoint, V2 response parsing, preserved ordered BUY/UPGRADE/REPLACE steps, and explicit sell/buy display data. Add a regression where 15 plan steps are returned with capacity 12 and all 15 remain available to presentation.

- [ ] **Step 2: Run client tests and verify failure**

Run: `yarn workspace @deadlock-live-probe/overwolf-client test`

Expected: FAIL until the client uses V2.

- [ ] **Step 3: Switch the Overwolf client to V2 contract**

Map V2 full-build steps directly to the existing build UI model without collapsing future REPLACE transitions into a capacity-sized held list. Preserve the actual next immediate transaction separately from the full future plan.

- [ ] **Step 4: Remove V1 runtime authority from NestJS serving wiring**

Keep old files only if still needed by historical tests/tools during migration, but remove their providers from the production recommendation path. The V2 service must have no injected `ConsensusStrategyFallbackV1Service`, `BuildStrategyCompilerV1Service`, or strategy-first V1 planner fallback.

- [ ] **Step 5: Add a static wiring regression**

Add an API test that instantiates the production recommendation module and asserts the V2 endpoint resolves through `AdaptiveRecommendationV2Service`; separately assert no fallback reason code/service can produce a V1 plan from a V2 failure.

- [ ] **Step 6: Run API + client contract tests**

Run:

```bash
yarn workspace @deadlock-live-probe/api test --runTestsByPath test/adaptive-recommendation-v2.e2e.spec.ts test/statlocker-build-v2-real-data.e2e.spec.ts
yarn workspace @deadlock-live-probe/overwolf-client test
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/overwolf-client/src apps/api/src/statlocker-adaptive apps/api/test
git commit -m "feat(strategy-v2): cut production recommendation path to V2"
```

---

### Task 19: Final regression, build, migration, and production-readiness verification

**Files:**
- Modify only if verification exposes a defect in scoped V2 work.
- Review: `docs/superpowers/specs/2026-09-10-statlocker-build-strategy-v2-design.md`
- Review: this implementation plan.

**Interfaces:**
- Release gate is the complete test/build/migration/debugger/E2E behavior, not a new code interface.

- [ ] **Step 1: Run the complete API suite**

Run: `yarn workspace @deadlock-live-probe/api test`

Expected: PASS.

- [ ] **Step 2: Run the complete Overwolf client suite**

Run: `yarn workspace @deadlock-live-probe/overwolf-client test`

Expected: PASS.

- [ ] **Step 3: Build all workspaces**

Run: `yarn build`

Expected: PASS with no TypeScript/Nest build errors.

- [ ] **Step 4: Validate database migration state in a disposable database**

Run the repository migration command against a disposable/test database:

```bash
yarn workspace @deadlock-live-probe/api migration:run
```

Expected: V2 archetype snapshot and match-lock tables are created. Then rerun migration status and verify no pending V2 migration remains.

- [ ] **Step 5: Re-run the two root-cause release gates explicitly**

Run:

```bash
yarn workspace @deadlock-live-probe/api test --runTestsByPath test/build-archetype-compiler-v2.spec.ts test/statlocker-vs-hero-wpa-v2.integration.spec.ts test/statlocker-build-v2-real-data.e2e.spec.ts
```

Expected: PASS; order variation retains semantic items, real WPA rows are queried/scored, and real Billy data produces the reviewed full build.

- [ ] **Step 6: Smoke-test the debugger in production-like mode**

Start API with non-secret local test values for `BUILD_DEBUG_PASSWORD` and `BUILD_DEBUG_SESSION_SECRET`, open `/debug/build-v2`, authenticate, select the active E2E/smoke match, and verify the UI displays: top-10 source, all accepted/rejected archetypes, initial WPA selection, immutable lock, live threat, CHOICE decisions, outside candidates, score layers, replacement search, final lifetime plan, and PASS inventory validation. Verify an unauthenticated private browser request to `/debug/build-v2/matches` returns 401.

- [ ] **Step 7: Verify production environment requirements before deployment**

Production configuration must set `BUILD_DEBUG_PASSWORD` to the user-selected password and set an independent random `BUILD_DEBUG_SESSION_SECRET`. Do not print either value in CI logs. Confirm DB migrations run through the existing deployment path before the new API process serves requests.

- [ ] **Step 8: Inspect runtime observability after direct cutover**

For at least one real active match with a full roster, verify: active V2 archetype snapshot exists; one immutable match lock exists; full plan is populated; WPA query activity is nonzero when rows exist; no plan-length-to-slot-cap truncation occurs; no inventory invariant violation occurs; no V1 fallback is invoked; browser debugger explains the current result by match ID.

- [ ] **Step 9: Present the actual real-data E2E build to the user**

Paste the report emitted in Task 17 into chat as a dedicated result, including hero, 10 source profiles, archetype summaries, selected archetype/WPA evidence, important CHOICE and outside-archetype decisions, every full-build step, `Inventory simulation: PASS`, and `Full progression validation: PASS`. If the build is visibly semantically poor, reopen the responsible task instead of claiming completion.

- [ ] **Step 10: Commit any verification-only fixes, then record final clean state**

If scoped defects were fixed, commit each fix with its focused regression. Finish with:

```bash
git status --short
```

Expected: empty output.

---

## Plan Self-Review Results

- **Spec coverage:** All approved spec areas map to explicit tasks: Statlocker-only top-10 source (Tasks 1/5/16), semantic mining (2/3), quality/atomic publish (4), WPA-only initial selection + persistent lock (6), real WPA serving regression (7), live threat/scoring (8), outside-archetype discovery (9), lifetime mechanics (10/11), hysteresis (11), explainability (12), V2 API (13), production browser auth/SSE/UI (14/15), real DB fixture + human-visible E2E (16/17), direct cutover/no V1 fallback (18), and release verification (19).
- **Placeholder scan:** The plan contains no implementation placeholders. Empirical archetype/scoring thresholds are centralized configuration and are intentionally validated against captured real data rather than embedded as unexplained constants in individual services.
- **Type consistency:** `BuildArchetypeV2` flows from compiler -> quality gate -> snapshot store -> selector -> persisted match lock -> resolver; `ResolvedFullBuildPlanV2` flows from resolver -> trace -> API/shared contract -> browser/Overwolf; the trace store is the single source for debugger snapshot/SSE.
- **Scope:** The debugger and E2E depend directly on V2 trace/runtime contracts, so they remain in the same implementation plan rather than becoming independent projects. Each task is independently reviewable and testable.
