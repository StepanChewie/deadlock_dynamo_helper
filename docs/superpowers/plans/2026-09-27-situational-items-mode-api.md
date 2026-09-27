# Situational Items Mode — API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `POST /deadlock/adaptive/v2/situational`, which returns up to five non-core items ranked purely by how well they perform against the enemy heroes in this match, each with the two or three enemies it is best against.

**Architecture:** A pure selection service ranks candidates from the whole item graph using the existing `ThreatWeightedMatchupV1Service` and the existing `outsideMatchupDiscovery` gate. A thin Nest service resolves the archetype lock — shared with the existing mode, so "core" and the enemy roster cannot disagree — then delegates to the selection. A separate controller owns the new route, so the file serving the reviewed Overwolf client is never edited.

**Tech Stack:** TypeScript, NestJS, Jest, TypeORM (read-only here), Yarn workspaces.

**Spec:** `docs/superpowers/specs/2026-09-27-situational-items-mode-design.md`

## Global Constraints

- **`POST /deadlock/adaptive/v2/recommend` must not change** — request, response or behaviour. It is currently under Overwolf review. Task 2 is the only task that touches its code, and it must be behaviour-preserving.
- **No new threshold constants.** The gate is `STATLOCKER_BUILD_V2_CONFIG.outsideMatchupDiscovery` (`minCoverage: 0.30`, `minConfidence: 0.35`, `minNormalizedSupport: 0`).
- **The API sends item ids and hero ids only.** Names, icons and artwork are resolved client-side, exactly as the existing response does.
- **No new npm dependencies.**
- **Tests live in `apps/api/test/*.spec.ts`** (`testRegex = test/.*\.spec\.ts$`), not colocated. Unit tests construct services directly with hand-built fixtures — no Nest `TestingModule`, and no mocks for pure services. This matches `apps/api/test/threat-weighted-matchup-v1.spec.ts`.
- **Commands:** `yarn workspace @dynamo-lab/api test`; typecheck with `cd apps/api && npx tsc --noEmit -p tsconfig.json`.
- **Mutation-test every new guard** before calling it done: break the condition, confirm the intended test goes red, restore from an explicit backup (**not** `git checkout` — uncommitted work would be lost), then compare `sha256`.
- **`Edit` writes CRLF** — after any edit run `sed -i 's/\r$//' <file>`.

---

## File Structure

**Create:**

- `packages/shared/src/adaptive-situational-v2.ts` — the response types. A separate file, so the frozen v2 recommendation types are not touched.
- `apps/api/src/statlocker-adaptive/situational-items-selection-v2.service.ts` — the ranking. Pure: inputs in, ranked list out, no I/O, no state.
- `apps/api/src/statlocker-adaptive/adaptive-archetype-lock-v2.service.ts` — the extracted lock resolution, shared by both modes.
- `apps/api/src/statlocker-adaptive/adaptive-situational-v2.service.ts` — resolves the lock, calls the selection, assembles the response.
- `apps/api/src/statlocker-adaptive/adaptive-situational-v2.controller.ts` — the new route.
- Tests: `situational-items-selection-v2.spec.ts`, `adaptive-archetype-lock-v2.spec.ts`, `adaptive-situational-v2.spec.ts`, `adaptive-situational-v2.controller.spec.ts`.

**Modify:**

- `packages/shared/src/index.ts` — export the new types.
- `apps/api/src/statlocker-adaptive/adaptive-recommendation-v2.service.ts` — delegate the lock step to the extracted service. Behaviour-preserving.
- `apps/api/src/statlocker-adaptive/statlocker-adaptive.module.ts` — register the new providers and controller.

---

### Task 1: The selection service

The heart of the feature, and the only part needing no I/O — so it is built and pinned first, with nothing else in flight.

**Files:**
- Create: `apps/api/src/statlocker-adaptive/situational-items-selection-v2.service.ts`
- Test: `apps/api/test/situational-items-selection-v2.spec.ts`

**Interfaces:**
- Consumes: `ThreatWeightedMatchupV1Service.scoreItem()` (`threat-weighted-matchup-v1.service.ts:45`), `RecommendationItemGraph.getAllItems()` (`packages/deadlock-build-domain/src/recommendation-item-graph.ts:13`), `BuildArchetypeV2.items[].role`, `STATLOCKER_BUILD_V2_CONFIG.outsideMatchupDiscovery`.
- Produces:
  - `SITUATIONAL_ITEM_LIMIT_V2 = 5`, `SITUATIONAL_AGAINST_LIMIT_V2 = 3`
  - `interface SituationalSelectionInputV2 { heroId, rulesetId, archetype, itemGraph, ownedItemIds, enemyHeroIds, enemyThreats, vsHeroRows }`
  - `interface SituationalCandidateV2 { itemId, score, confidence, coverage, against: readonly SituationalTargetV2[] }`
  - `interface SituationalTargetV2 { enemyHeroId, deltaWpa, count }`
  - `class SituationalItemsSelectionV2Service { select(input): readonly SituationalCandidateV2[] }`

**Naming note:** the field is `rulesetId`, not `rulesetVersion`. `RecommendationItemDefinition.availableRulesetIds` is populated from `catalog.rulesetId` (`packages/deadlock-build-domain/src/recommendation-ruleset-catalog.ts:231`) and compared against a `rulesetId` (`recommendation-candidate-generator.ts:362`). Getting this wrong filters out every item and produces an empty list with no error.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/test/situational-items-selection-v2.spec.ts`:

```ts
import { createRecommendationItemGraph } from '@dynamo-lab/build-domain';
import { BuildArchetypeV2 } from '../src/statlocker-adaptive/build-archetype-v2';
import {
  SituationalItemsSelectionV2Service,
  SituationalSelectionInputV2,
  SITUATIONAL_AGAINST_LIMIT_V2,
  SITUATIONAL_ITEM_LIMIT_V2,
} from '../src/statlocker-adaptive/situational-items-selection-v2.service';
import { ThreatWeightedMatchupV1Service } from '../src/statlocker-adaptive/threat-weighted-matchup-v1.service';

const HERO_ID = 13;
const RULESET_ID = 'ruleset-test';

function itemDefinition(itemId: number) {
  return {
    itemId,
    name: `Item ${itemId}`,
    slotType: 'weapon' as const,
    active: true,
    availableRulesetIds: [RULESET_ID],
    upgradeRecipes: [],
  };
}

// Only `items[].itemId` and `items[].role` are read, so the rest of the
// archetype is cast away rather than fabricated.
function archetypeWithRoles(roles: Readonly<Record<number, string>>): BuildArchetypeV2 {
  return {
    items: Object.entries(roles).map(([itemId, role]) => ({
      itemId: Number(itemId),
      familyId: 1,
      role,
    })),
  } as unknown as BuildArchetypeV2;
}

// count drives sampleConfidence and deltaWpa drives the score. 0.15 is the
// normalisation scale inside ThreatWeightedMatchupV1Service, so a delta of 0.15
// with a large count saturates the score at 1.
function row(itemId: number, enemyHeroId: number, deltaWpa: number, count = 100) {
  return { heroId: HERO_ID, enemyHeroId, itemId, count, deltaWpa };
}

function enemyThreats(heroIds: readonly number[]) {
  return heroIds.map((heroId) => ({ heroId, threatMultiplier: 1 }));
}

function select(overrides: Partial<SituationalSelectionInputV2> = {}) {
  const service = new SituationalItemsSelectionV2Service(new ThreatWeightedMatchupV1Service());
  return service.select({
    heroId: HERO_ID,
    rulesetId: RULESET_ID,
    archetype: archetypeWithRoles({}),
    itemGraph: createRecommendationItemGraph([
      itemDefinition(101),
      itemDefinition(102),
      itemDefinition(103),
    ]),
    ownedItemIds: [],
    enemyHeroIds: [7, 8],
    enemyThreats: enemyThreats([7, 8]),
    vsHeroRows: [],
    ...overrides,
  });
}

describe('SituationalItemsSelectionV2Service', () => {
  it('excludes items the archetype carries with the CORE role', () => {
    const result = select({
      archetype: archetypeWithRoles({ 101: 'CORE' }),
      vsHeroRows: [row(101, 7, 0.10), row(102, 7, 0.05)],
    });

    expect(result.map((entry) => entry.itemId)).toEqual([102]);
  });

  it('keeps non-core archetype roles in the pool', () => {
    const result = select({
      archetype: archetypeWithRoles({ 101: 'SITUATIONAL', 102: 'FLEX' }),
      vsHeroRows: [row(101, 7, 0.10), row(102, 7, 0.05)],
    });

    expect(result.map((entry) => entry.itemId)).toEqual([101, 102]);
  });

  it('excludes items the player already owns', () => {
    const result = select({
      ownedItemIds: [101],
      vsHeroRows: [row(101, 7, 0.10), row(102, 7, 0.05)],
    });

    expect(result.map((entry) => entry.itemId)).toEqual([102]);
  });

  it('excludes items that are not available in this ruleset', () => {
    const result = select({
      itemGraph: createRecommendationItemGraph([
        { ...itemDefinition(101), availableRulesetIds: ['some-other-ruleset'] },
        itemDefinition(102),
      ]),
      vsHeroRows: [row(101, 7, 0.10), row(102, 7, 0.05)],
    });

    expect(result.map((entry) => entry.itemId)).toEqual([102]);
  });

  it('ranks by normalised matchup score', () => {
    const result = select({
      vsHeroRows: [row(101, 7, 0.02), row(102, 7, 0.10)],
    });

    expect(result.map((entry) => entry.itemId)).toEqual([102, 101]);
  });

  it('rejects an item whose score is not positive', () => {
    const result = select({
      vsHeroRows: [row(101, 7, -0.10)],
    });

    expect(result).toEqual([]);
  });

  it('rejects an item with no evidence against any enemy hero', () => {
    const result = select({
      vsHeroRows: [row(101, 999, 0.10)],
    });

    expect(result).toEqual([]);
  });

  it('reports only the enemies the item helps against, strongest first', () => {
    const result = select({
      enemyHeroIds: [7, 8, 9],
      enemyThreats: enemyThreats([7, 8, 9]),
      vsHeroRows: [row(101, 7, 0.02), row(101, 8, 0.10), row(101, 9, -0.10)],
    });

    expect(result[0].against.map((target) => target.enemyHeroId)).toEqual([8, 7]);
    expect(result[0].against[0].count).toBe(100);
  });

  it('caps the reported enemies', () => {
    const enemyHeroIds = [7, 8, 9, 10];
    const result = select({
      enemyHeroIds,
      enemyThreats: enemyThreats(enemyHeroIds),
      vsHeroRows: enemyHeroIds.map((heroId, index) => row(101, heroId, 0.02 * (index + 1))),
    });

    expect(result[0].against).toHaveLength(SITUATIONAL_AGAINST_LIMIT_V2);
  });

  it('caps the returned items', () => {
    const itemIds = [101, 102, 103, 104, 105, 106, 107];
    const result = select({
      itemGraph: createRecommendationItemGraph(itemIds.map(itemDefinition)),
      vsHeroRows: itemIds.map((itemId, index) => row(itemId, 7, 0.01 * (index + 1))),
    });

    expect(result).toHaveLength(SITUATIONAL_ITEM_LIMIT_V2);
  });

  it('breaks ties deterministically by item id', () => {
    const result = select({
      vsHeroRows: [row(103, 7, 0.10), row(101, 7, 0.10), row(102, 7, 0.10)],
    });

    expect(result.map((entry) => entry.itemId)).toEqual([101, 102, 103]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `yarn workspace @dynamo-lab/api test --testPathPatterns=situational-items-selection-v2`
Expected: FAIL — `Cannot find module '../src/statlocker-adaptive/situational-items-selection-v2.service'`.

- [ ] **Step 3: Write the implementation**

Create `apps/api/src/statlocker-adaptive/situational-items-selection-v2.service.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { RecommendationItemGraph } from '@dynamo-lab/build-domain';
import { BuildArchetypeV2 } from './build-archetype-v2';
import { STATLOCKER_BUILD_V2_CONFIG } from './statlocker-build-v2.config';
import { StatlockerVsHeroWpaAggregateSourceV1 } from './statlocker-vs-hero-wpa-repository-v1.service';
import {
  EnemyThreatWeightV1,
  ThreatWeightedMatchupV1Service,
} from './threat-weighted-matchup-v1.service';

export const SITUATIONAL_ITEM_LIMIT_V2 = 5;
export const SITUATIONAL_AGAINST_LIMIT_V2 = 3;

export interface SituationalSelectionInputV2 {
  heroId: number;
  rulesetId: string;
  archetype: BuildArchetypeV2;
  itemGraph: RecommendationItemGraph;
  ownedItemIds: readonly number[];
  enemyHeroIds: readonly number[];
  enemyThreats: readonly EnemyThreatWeightV1[];
  vsHeroRows: readonly StatlockerVsHeroWpaAggregateSourceV1[];
}

export interface SituationalTargetV2 {
  enemyHeroId: number;
  deltaWpa: number;
  count: number;
}

export interface SituationalCandidateV2 {
  itemId: number;
  score: number;
  confidence: number;
  coverage: number;
  against: readonly SituationalTargetV2[];
}

/**
 * Ranks the items that are best against *this* enemy team.
 *
 * Deliberately not `BuildItemUtilityV2Service`. Its `structure` layer rewards an
 * item for being core, and this list exists to exclude core items; its
 * `transition` layer measures replacing something in a prescribed build, and
 * this mode has no prescribed build. `baseWpa` is excluded for the reason the
 * mode exists at all: an item has to earn its place by being good against these
 * enemies, not by being generally strong on the hero.
 *
 * The gate is the one the existing outside-candidate discovery already applies,
 * reused from config rather than re-derived. `minNormalizedSupport` being 0 is
 * what enforces "must help against them".
 */
@Injectable()
export class SituationalItemsSelectionV2Service {
  constructor(private readonly matchup: ThreatWeightedMatchupV1Service) {}

  select(input: SituationalSelectionInputV2): readonly SituationalCandidateV2[] {
    const config = STATLOCKER_BUILD_V2_CONFIG.outsideMatchupDiscovery;
    const coreItemIds = new Set(
      input.archetype.items
        .filter((item) => item.role === 'CORE')
        .map((item) => item.itemId),
    );
    const owned = new Set(input.ownedItemIds);

    const scored: { candidate: SituationalCandidateV2 }[] = [];

    for (const item of input.itemGraph.getAllItems()) {
      if (!item.active) continue;
      if (!item.availableRulesetIds.includes(input.rulesetId)) continue;
      if (owned.has(item.itemId)) continue;
      if (coreItemIds.has(item.itemId)) continue;

      const score = this.matchup.scoreItem({
        ourHeroId: input.heroId,
        itemId: item.itemId,
        enemyHeroIds: input.enemyHeroIds,
        rows: input.vsHeroRows,
        enemyThreats: input.enemyThreats,
      });
      if (score.coverage < config.minCoverage) continue;
      if (score.confidence < config.minConfidence) continue;
      if (score.normalized <= config.minNormalizedSupport) continue;

      scored.push({
        candidate: {
          itemId: item.itemId,
          score: score.normalized,
          confidence: score.confidence,
          coverage: score.coverage,
          against: againstFor(score.contributions),
        },
      });
    }

    return scored
      .sort((a, b) =>
        b.candidate.score - a.candidate.score ||
        b.candidate.confidence - a.candidate.confidence ||
        b.candidate.coverage - a.candidate.coverage ||
        a.candidate.itemId - b.candidate.itemId)
      .slice(0, SITUATIONAL_ITEM_LIMIT_V2)
      .map((entry) => entry.candidate);
  }
}

function againstFor(
  contributions: readonly {
    enemyHeroId: number;
    rawDeltaWpa: number;
    count: number;
    weightedContribution: number;
  }[],
): readonly SituationalTargetV2[] {
  return contributions
    .filter((entry) => entry.weightedContribution > 0)
    .slice()
    .sort((a, b) =>
      b.weightedContribution - a.weightedContribution || a.enemyHeroId - b.enemyHeroId)
    .slice(0, SITUATIONAL_AGAINST_LIMIT_V2)
    .map((entry) => ({
      enemyHeroId: entry.enemyHeroId,
      deltaWpa: entry.rawDeltaWpa,
      count: entry.count,
    }));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `yarn workspace @dynamo-lab/api test --testPathPatterns=situational-items-selection-v2`
Expected: PASS, 11 tests.

- [ ] **Step 5: Typecheck**

Run: `cd apps/api && npx tsc --noEmit -p tsconfig.json`
Expected: no output.

- [ ] **Step 6: Mutation-test the new guards**

Back up the file first. Make each change separately, run the suite, and restore between them:

1. Delete `if (coreItemIds.has(item.itemId)) continue;` → `excludes items the archetype carries with the CORE role` must fail.
2. Change `if (score.normalized <= config.minNormalizedSupport) continue;` to `if (false) continue;` → `rejects an item whose score is not positive` must fail.
3. Change `availableRulesetIds.includes(input.rulesetId)` to `availableRulesetIds.length >= 0` → `excludes items that are not available in this ruleset` must fail.

Restore from the backup after each and confirm `sha256sum` matches.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/statlocker-adaptive/situational-items-selection-v2.service.ts apps/api/test/situational-items-selection-v2.spec.ts
git commit -m "feat(api): rank situational items by matchup against the enemy team"
```

---

### Task 2: Extract the archetype lock resolution

Both modes must resolve the same lock for the same match, or "core" and the enemy roster could disagree between them. This is the only task touching code the existing mode depends on, so it is done alone and proven behaviour-preserving before anything uses it.

**Files:**
- Create: `apps/api/src/statlocker-adaptive/adaptive-archetype-lock-v2.service.ts`
- Modify: `apps/api/src/statlocker-adaptive/adaptive-recommendation-v2.service.ts` — the first four statements of `recommend()` (`:92-98`), the interface at `:60-68`, and the `reuseLock` (`:221`) / `createLock` (`:255`) methods move out
- Test: `apps/api/test/adaptive-archetype-lock-v2.spec.ts`

**Interfaces:**
- Consumes: `AdaptiveDecisionStateV1Service.build()`, `BuildArchetypeSessionV2Service.get()`, plus whichever of `StatlockerEvidenceService`, `BuildArchetypeSnapshotStoreV2Service`, `StatlockerVsHeroWpaRepositoryV1Service`, `BuildArchetypeSelectorV2Service` the two moved methods actually use.
- Produces:
  - `interface AdaptiveArchetypeLockContextV2 { lock, snapshot, selection, enemyHeroIds, evidence, vsHeroRows, trace }`
  - `type AdaptiveLockResolutionV2 = { ok: true; decision: AdaptiveDecisionStateV1; context: AdaptiveArchetypeLockContextV2 } | { ok: false; decision: AdaptiveDecisionStateV1; blockers: readonly string[] }`
  - `class AdaptiveArchetypeLockV2Service { resolve(request: AdaptiveRecommendationRequestV2): Promise<AdaptiveLockResolutionV2> }`

- [ ] **Step 1: Move the code**

1. Create `adaptive-archetype-lock-v2.service.ts`.
2. Move `AdaptiveRecommendationLockContextV2` (`adaptive-recommendation-v2.service.ts:60-68`) into it, renamed `AdaptiveArchetypeLockContextV2`, and export it.
3. Move `reuseLock` (`:221`) and `createLock` (`:255`) in **verbatim** as private methods. Their bodies must not change — if a line has to change, that is a signal the move is wrong.
4. Build the new constructor from exactly the dependencies those two moved methods reference. Keep the order they appear in the existing constructor, filtered to what is actually used. Do not add dependencies the moved code does not touch.
5. Move or export `validateRequest` (module-level, `:654`) so the new service can call it.
6. Add the public method, reproducing lines 93-98 exactly:

```ts
async resolve(request: AdaptiveRecommendationRequestV2): Promise<AdaptiveLockResolutionV2> {
  validateRequest(request);
  const decision = await this.decisionState.build(request.matchId, request.localSteamId);
  const existingLock = await this.session.get(request.matchId, decision.localSteamId);
  const context = existingLock
    ? await this.reuseLock(decision, existingLock)
    : await this.createLock(decision, request.matchId);
  if ('ready' in context) {
    return { ok: false, decision, blockers: context.blockers };
  }
  return { ok: true, decision, context };
}
```

The `'ready' in context` check is how the existing code tells the not-ready result apart from a real context; keep the mechanism, do not invent a new one.

- [ ] **Step 2: Point the existing service at it**

In `adaptive-recommendation-v2.service.ts`, replace `:92-98` with:

```ts
const resolution = await this.lockResolver.resolve(request);
if (!resolution.ok) {
  return notReadyRecommendation(resolution.decision, resolution.blockers);
}
const { decision, context } = resolution;
const { lock, snapshot, selection, enemyHeroIds, evidence, vsHeroRows, trace } = context;
```

Add `private readonly lockResolver: AdaptiveArchetypeLockV2Service` **at the end of the constructor parameter list**, after `lifecycleRepository`, so the positional constructions in existing tests keep working. Do not reorder anything else.

- [ ] **Step 3: Run the existing suites — this is the proof**

Run: `yarn workspace @dynamo-lab/api test --testPathPatterns="adaptive-recommendation-v2"`
Expected: PASS with **no edits to any existing test**. If a test needed editing, the refactor changed behaviour — fix the refactor, not the test.

Then run the whole suite:

Run: `yarn workspace @dynamo-lab/api test`
Expected: everything that passed before still passes.

- [ ] **Step 4: Write a focused test for the new seam**

Create `apps/api/test/adaptive-archetype-lock-v2.spec.ts`. The constructor order is whatever Step 1 produced, so write the stubs positionally to match it — read the constructor first. The three assertions:

```ts
import { AdaptiveArchetypeLockV2Service } from '../src/statlocker-adaptive/adaptive-archetype-lock-v2.service';

const request = { matchId: 'match-1', localSteamId: 'steam-1' };

it('returns the existing lock and its enemy roster when the session already has one', async () => {
  const lock = { matchId: 'match-1', archetypeId: 'archetype-1', enemyHeroIds: [7, 8, 9, 10, 11, 12] };
  const service = new AdaptiveArchetypeLockV2Service(
    decisionStateStub(),
    // ...the remaining stubs, in the order the constructor declares them
  );

  const resolution = await service.resolve(request);

  expect(resolution.ok).toBe(true);
  if (!resolution.ok) return;
  expect(resolution.context.lock).toBe(lock);
  expect(resolution.context.enemyHeroIds).toEqual([7, 8, 9, 10, 11, 12]);
});

it('reports blockers instead of a context when the lock cannot be produced', async () => {
  // Make the stubs return whatever makes reuseLock/createLock take their
  // not-ready branch — read those two methods to see which input does it.
  const resolution = await service.resolve(request);

  expect(resolution.ok).toBe(false);
  if (resolution.ok) return;
  expect(resolution.blockers.length).toBeGreaterThan(0);
});
```

Write `decisionStateStub()` to return `{ build: jest.fn(async () => ({ state: { heroId: 13 }, localSteamId: 'steam-1', stateRevision: 'rev-1' })) }`, cast `as never` the way `adaptive-recommendation-v2.spec.ts` does. Fill in the remaining stubs so the happy path reaches a context.

- [ ] **Step 5: Run it, typecheck, commit**

Run: `yarn workspace @dynamo-lab/api test --testPathPatterns=adaptive-archetype-lock-v2`
Expected: PASS.

```bash
cd apps/api && npx tsc --noEmit -p tsconfig.json && cd ../..
git add apps/api/src/statlocker-adaptive/adaptive-archetype-lock-v2.service.ts \
        apps/api/src/statlocker-adaptive/adaptive-recommendation-v2.service.ts \
        apps/api/test/adaptive-archetype-lock-v2.spec.ts
git commit -m "refactor(api): share the archetype lock resolution between recommendation modes"
```

---

### Task 3: The situational service and the response types

**Files:**
- Create: `packages/shared/src/adaptive-situational-v2.ts`
- Create: `apps/api/src/statlocker-adaptive/adaptive-situational-v2.service.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `apps/api/test/adaptive-situational-v2.spec.ts`

**Interfaces:**
- Consumes: `AdaptiveArchetypeLockV2Service.resolve()` (Task 2), `SituationalItemsSelectionV2Service.select()` (Task 1), `EnemyThreatV1Service.scoreEnemies()`.
- Produces:
  - `AdaptiveSituationalResultV2`, `AdaptiveSituationalItemV2`, `AdaptiveSituationalTargetV2` in `@dynamo-lab/shared`
  - `class AdaptiveSituationalV2Service { recommend(request: AdaptiveRecommendationRequestV2): Promise<AdaptiveSituationalResultV2> }`

- [ ] **Step 1: Write the response types**

Create `packages/shared/src/adaptive-situational-v2.ts`:

```ts
import { AdaptiveArchetypeLockSummaryV2 } from './adaptive-recommendation-v2';

export interface AdaptiveSituationalTargetV2 {
  enemyHeroId: number;
  deltaWpa: number;
  count: number;
}

export interface AdaptiveSituationalItemV2 {
  itemId: number;
  score: number;
  confidence: number;
  coverage: number;
  against: readonly AdaptiveSituationalTargetV2[];
}

export interface AdaptiveSituationalResultV2 {
  /** Discriminator: the client narrows on this instead of guessing from shape. */
  mode: 'situational';
  ready: boolean;
  blockers: readonly string[];
  decisionId: string;
  stateRevision: string;
  heroId?: number;
  lock?: AdaptiveArchetypeLockSummaryV2;
  situationalItems: readonly AdaptiveSituationalItemV2[];
  degradedReasons: readonly string[];
}
```

Export it from `packages/shared/src/index.ts` next to the existing adaptive exports, then rebuild the shared package:

Run: `yarn workspace @dynamo-lab/shared build`
Expected: success.

- [ ] **Step 2: Write the failing tests**

Create `apps/api/test/adaptive-situational-v2.spec.ts`. Construct the service directly with object-literal stubs cast `as never`, matching `adaptive-recommendation-v2.spec.ts:81`.

```ts
import {
  AdaptiveSituationalV2Service,
} from '../src/statlocker-adaptive/adaptive-situational-v2.service';

const REQUEST = { matchId: 'match-1', localSteamId: 'steam-1' };

function contextWith(selectionMode: 'VS_HERO_WPA' | 'OFFLINE_DEFAULT') {
  return {
    lock: {
      matchId: 'match-1',
      archetypeId: 'archetype-1',
      enemyHeroIds: [7, 8, 9, 10, 11, 12],
      selectionMode,
      snapshotId: 'snapshot-1',
      lockedAt: '2026-09-27T10:00:00.000Z',
    },
    snapshot: {
      archetypes: [{ archetypeId: 'archetype-1', items: [{ itemId: 101, familyId: 1, role: 'CORE' }] }],
    },
    selection: { selectionMode },
    enemyHeroIds: [7, 8, 9, 10, 11, 12],
    evidence: {},
    vsHeroRows: [],
    trace: { record: jest.fn() },
  };
}

function build(overrides: {
  ok?: boolean;
  context?: unknown;
  selection?: readonly unknown[];
} = {}) {
  const lockResolver = {
    resolve: jest.fn(async () => (overrides.ok === false
      ? { ok: false, decision: decisionStub(), blockers: ['ENEMY_ROSTER_INCOMPLETE'] }
      : { ok: true, decision: decisionStub(), context: overrides.context ?? contextWith('VS_HERO_WPA') })),
  };
  const selection = { select: jest.fn(() => overrides.selection ?? []) };
  const enemyThreat = { scoreEnemies: jest.fn(() => []) };
  return new AdaptiveSituationalV2Service(
    lockResolver as never,
    selection as never,
    enemyThreat as never,
  );
}

function decisionStub() {
  return {
    state: { heroId: 13, inventory: { heldByItemId: new Map([[201, {}]]) } },
    itemGraph: { getAllItems: () => [] },
    rulesetId: 'ruleset-1',
    stateRevision: 'rev-1',
  };
}

describe('AdaptiveSituationalV2Service', () => {
  it('returns the selection as situational items and marks the mode', async () => {
    const service = build({
      selection: [{ itemId: 101, score: 0.5, confidence: 0.6, coverage: 1, against: [{ enemyHeroId: 7, deltaWpa: 0.1, count: 100 }] }],
    });

    const result = await service.recommend(REQUEST);

    expect(result.mode).toBe('situational');
    expect(result.ready).toBe(true);
    expect(result.situationalItems).toEqual([
      { itemId: 101, score: 0.5, confidence: 0.6, coverage: 1, against: [{ enemyHeroId: 7, deltaWpa: 0.1, count: 100 }] },
    ]);
    expect(result.stateRevision).toBe('rev-1');
  });

  it('is not ready when the lock resolved to the offline default', async () => {
    const service = build({ context: contextWith('OFFLINE_DEFAULT') });

    const result = await service.recommend(REQUEST);

    expect(result.ready).toBe(false);
    expect(result.blockers).toContain('SITUATIONAL_EVIDENCE_UNAVAILABLE');
    expect(result.situationalItems).toEqual([]);
  });

  it('is not ready, not ready-with-an-empty-list, when nothing passes the gate', async () => {
    const service = build({ selection: [] });

    const result = await service.recommend(REQUEST);

    expect(result.ready).toBe(false);
    expect(result.blockers).toContain('SITUATIONAL_EVIDENCE_UNAVAILABLE');
  });

  it('passes the lock blockers through when the lock cannot be resolved', async () => {
    const service = build({ ok: false });

    const result = await service.recommend(REQUEST);

    expect(result.ready).toBe(false);
    expect(result.blockers).toEqual(['ENEMY_ROSTER_INCOMPLETE']);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `yarn workspace @dynamo-lab/api test --testPathPatterns=adaptive-situational-v2`
Expected: FAIL — module not found.

- [ ] **Step 4: Write the service**

`adaptive-situational-v2.service.ts` — constructor takes `AdaptiveArchetypeLockV2Service`, `SituationalItemsSelectionV2Service`, `EnemyThreatV1Service`. `recommend()`:

1. `const resolution = await this.lockResolver.resolve(request)`. If `!resolution.ok`, return not-ready carrying `resolution.blockers`.
2. If `resolution.context.lock.selectionMode === 'OFFLINE_DEFAULT'`, return not-ready with blocker `SITUATIONAL_EVIDENCE_UNAVAILABLE` — the entire feature is matchup evidence.
3. Find the archetype in `context.snapshot.archetypes` by `lock.archetypeId`. Missing → not-ready with `LOCKED_ARCHETYPE_V2_UNAVAILABLE`, matching the existing mode's wording.
4. Build `enemyThreats` with `this.enemyThreat.scoreEnemies(...)` exactly as `adaptive-recommendation-v2.service.ts:106-113` does, so threat weights are identical between modes.
5. Call `this.selection.select({ heroId: decision.state.heroId, rulesetId: decision.rulesetId, archetype, itemGraph: decision.itemGraph, ownedItemIds: [...decision.state.inventory.heldByItemId.keys()], enemyHeroIds, enemyThreats, vsHeroRows })`.
6. Empty selection → not-ready with `SITUATIONAL_EVIDENCE_UNAVAILABLE`.
7. Otherwise ready: `mode: 'situational'`, `decisionId`/`stateRevision` from the decision, `lock` built with the same `lockSummary()` shape the existing service produces (`adaptive-recommendation-v2.service.ts:558`), `degradedReasons` from the lock.

The `rulesetId` field name is verified: `AdaptiveDecisionStateV1` declares `rulesetId` (`adaptive-decision-state-v1.service.ts:55`), and that is the identifier `availableRulesetIds` is keyed on.

- [ ] **Step 5: Run to verify pass, then typecheck**

Run: `yarn workspace @dynamo-lab/api test --testPathPatterns=adaptive-situational-v2`
Expected: PASS, 4 tests.

Run: `cd apps/api && npx tsc --noEmit -p tsconfig.json`
Expected: no output.

- [ ] **Step 6: Mutation-test the degraded guard**

Comment out the `OFFLINE_DEFAULT` check and confirm `is not ready when the lock resolved to the offline default` fails. Restore and compare `sha256`.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/adaptive-situational-v2.ts packages/shared/src/index.ts \
        apps/api/src/statlocker-adaptive/adaptive-situational-v2.service.ts \
        apps/api/test/adaptive-situational-v2.spec.ts
git commit -m "feat(api): add the situational recommendation service"
```

---

### Task 4: The route

**Files:**
- Create: `apps/api/src/statlocker-adaptive/adaptive-situational-v2.controller.ts`
- Modify: `apps/api/src/statlocker-adaptive/statlocker-adaptive.module.ts`
- Test: `apps/api/test/adaptive-situational-v2.controller.spec.ts`

**Interfaces:**
- Consumes: `AdaptiveSituationalV2Service.recommend()` (Task 3).
- Produces: `POST /deadlock/adaptive/v2/situational`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/adaptive-situational-v2.controller.spec.ts`, mirroring `adaptive-recommendation-v2.controller.spec.ts`:

```ts
import { BadRequestException } from '@nestjs/common';
import { AdaptiveSituationalV2Controller } from '../src/statlocker-adaptive/adaptive-situational-v2.controller';

function controllerWith(recommend = jest.fn(async () => readyResult())) {
  return {
    controller: new AdaptiveSituationalV2Controller(
      { recommend } as never,
      { getAvailability: jest.fn(() => ({ recommendationsEnabled: true })) } as never,
    ),
    recommend,
  };
}

function readyResult() {
  return {
    mode: 'situational' as const,
    ready: true,
    blockers: [],
    decisionId: 'decision-1',
    stateRevision: 'rev-1',
    situationalItems: [],
    degradedReasons: [],
  };
}

describe('AdaptiveSituationalV2Controller', () => {
  it('rejects a missing matchId', async () => {
    const { controller } = controllerWith();
    await expect(controller.recommend({} as never)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a blank localSteamId', async () => {
    const { controller } = controllerWith();
    await expect(
      controller.recommend({ matchId: 'match-1', localSteamId: '  ' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('trims the values it passes on', async () => {
    const { controller, recommend } = controllerWith();
    await controller.recommend({ matchId: '  match-1  ', localSteamId: ' steam-1 ' });

    expect(recommend).toHaveBeenCalledWith({ matchId: 'match-1', localSteamId: 'steam-1' });
  });

  it('fails closed while recommendations are disabled', async () => {
    const { controller, recommend } = controllerWith();
    (controller as unknown as { availability: { getAvailability: jest.Mock } }).availability = {
      getAvailability: jest.fn(() => ({ recommendationsEnabled: false, maintenanceMessage: 'down' })),
    };

    const result = await controller.recommend({ matchId: 'match-1' });

    expect(recommend).not.toHaveBeenCalled();
    expect(result.ready).toBe(false);
    expect(result.blockers).toContain('RECOMMENDATIONS_DISABLED');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `yarn workspace @dynamo-lab/api test --testPathPatterns=adaptive-situational-v2.controller`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the controller**

`@Controller('deadlock/adaptive/v2')` with `@Post('situational')`, `@UseGuards(RateLimitGuard)` and `@RateLimit({ limit: 240, windowMs: 60_000 })` — the same budget as the existing route, because it is the same client on the same cadence.

Constructor takes `AdaptiveSituationalV2Service` and `AdaptiveAvailabilityV1Service`. Copy the validation block from `adaptive-recommendation-v2.controller.ts:30-42` verbatim, and the kill-switch check from `:44-47`:

```ts
function disabledSituational(
  matchId: string,
  maintenanceMessage?: string,
): AdaptiveSituationalResultV2 {
  const blockers = ['RECOMMENDATIONS_DISABLED'];
  return {
    mode: 'situational',
    ready: false,
    blockers,
    decisionId: `disabled:${matchId}`,
    stateRevision: `disabled:${matchId}`,
    situationalItems: [],
    degradedReasons: maintenanceMessage ? [...blockers, maintenanceMessage] : blockers,
  };
}
```

Catch `AdaptiveLiveStateNotReadyError` exactly as the existing controller does (`:55-61`) and return a not-ready situational result with `['LIVE_STATE_NOT_READY', error.blocker]`.

- [ ] **Step 4: Register in the module**

In `statlocker-adaptive.module.ts`: add `AdaptiveArchetypeLockV2Service`, `SituationalItemsSelectionV2Service`, `AdaptiveSituationalV2Service` to `providers`, and `AdaptiveSituationalV2Controller` to `controllers`. `ThreatWeightedMatchupV1Service` and `AdaptiveAvailabilityV1Service` are already provided — confirm rather than adding duplicates.

- [ ] **Step 5: Run to verify pass**

Run: `yarn workspace @dynamo-lab/api test --testPathPatterns=adaptive-situational-v2`
Expected: PASS, including the controller tests.

- [ ] **Step 6: Prove the frozen contract is untouched**

Run: `yarn workspace @dynamo-lab/api test`
Expected: the whole suite passes, including `adaptive-recommendation-v2.e2e.spec.ts` and `adaptive-recommendation-v2.controller.spec.ts`, with **no edits to either**.

This is the assertion that protects the build under Overwolf review. If either file needed a change, the new route changed the existing one — fix the cause, not the test.

- [ ] **Step 7: Typecheck, then commit**

```bash
cd apps/api && npx tsc --noEmit -p tsconfig.json && cd ../..
git add apps/api/src/statlocker-adaptive/adaptive-situational-v2.controller.ts \
        apps/api/src/statlocker-adaptive/statlocker-adaptive.module.ts \
        apps/api/test/adaptive-situational-v2.controller.spec.ts
git commit -m "feat(api): expose POST /deadlock/adaptive/v2/situational"
```

---

## Self-Review

**Spec coverage:**

| Spec requirement | Task |
|---|---|
| New endpoint `POST /deadlock/adaptive/v2/situational` | 4 |
| Response types, `mode` discriminator | 3 |
| Pool = whole catalog minus core minus owned | 1 |
| Tier-1 components allowed — no tier filter written | 1 |
| Ranked by pure `scoreItem().normalized` | 1 |
| No `baseWpa`, no `structure`/`progression`/`transition` | 1 |
| Gate = `outsideMatchupDiscovery` config, no new constants | 1 |
| Up to five items | 1 |
| Top 2–3 enemies with magnitudes, positive only | 1 |
| Shared lock, one `AdaptiveDecisionStateV1Service` | 2 |
| Degraded: incomplete roster, `OFFLINE_DEFAULT`, empty selection | 3 |
| Existing `/v2/recommend` unchanged | 2 (behaviour-preserving), 4 (proven) |
| Mutation-tested guards | 1, 3 |
| Client work | **Not in this plan** — separate plan, per the spec's subsystem split |

**Deliberate gaps, stated rather than hidden:**

- **`reasonCodes` on the item are not implemented.** `ThreatWeightedMatchupScoreV1` carries none, and inventing codes with no consumer is noise. Add them when something reads them.
- **Task 2's new test cannot be written before the move.** The constructor's exact shape is whatever the move produces, so Step 4 tells the implementer to read the constructor and match it positionally. The real proof of Task 2 is Step 3 — the existing lock-lifecycle and recommendation suites passing with no edits.
- **No e2e test against a real snapshot.** The unit tests pin the logic; whether the gate admits real items in practice is only answerable against production data, and that is a manual check after deploy, not a test in this plan.

**Type consistency:** `SituationalCandidateV2` maps one-to-one onto `AdaptiveSituationalItemV2` and `SituationalTargetV2` onto `AdaptiveSituationalTargetV2`, so Task 3's mapping is a rename, not a reshape. `rulesetId` is used consistently in Task 1's input, Task 1's implementation and Task 3's call site.
