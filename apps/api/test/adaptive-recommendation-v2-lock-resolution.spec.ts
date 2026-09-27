import {
  createRecommendationItemGraph,
  observedFact,
  unknownFact,
} from '@dynamo-lab/build-domain';
import { AdaptiveRecommendationV2Service } from '../src/statlocker-adaptive/adaptive-recommendation-v2.service';
import { BuildArchetypeSnapshotV2 } from '../src/statlocker-adaptive/build-archetype-v2';
import { BuildDebugTraceStoreV2Service } from '../src/statlocker-adaptive/build-debug-trace-store-v2.service';

const HERO_ID = 72;
const MATCH_ID = 'match-locked';
const RULESET_ID = 'ruleset-a';
const PATCH_ID = 'patch-a';
const CATALOG_SHA = 'a'.repeat(64);
const LOCKED_ARCHETYPE_ID = 'archetype:locked';
const LOCKED_SNAPSHOT_ID = 'snapshot:locked';
const FULL_ENEMY_ROSTER = [6, 10, 13, 27, 31, 35];

const lockedSnapshot: BuildArchetypeSnapshotV2 = {
  snapshotId: LOCKED_SNAPSHOT_ID,
  heroId: HERO_ID,
  rulesetVersion: RULESET_ID,
  catalogSha256: CATALOG_SHA,
  statlockerPatchId: PATCH_ID,
  generatedAt: '2026-09-10T18:00:00.000Z',
  sourceProfileAccountIds: Array.from({ length: 10 }, (_, index) => `profile-${index + 1}`),
  archetypes: [{
    archetypeId: LOCKED_ARCHETYPE_ID,
    heroId: HERO_ID,
    rulesetVersion: RULESET_ID,
    catalogSha256: CATALOG_SHA,
    statlockerPatchId: PATCH_ID,
    sourceProfileAccountIds: Array.from({ length: 10 }, (_, index) => `profile-${index + 1}`),
    items: [],
    groups: [],
    orderEdges: [],
    relationships: [],
    quality: { support: 0.7, coherence: 0.9, separation: 0.5, sourceProfileCount: 10 },
  }],
};

const lockedSelection = {
  archetypeId: LOCKED_ARCHETYPE_ID,
  mode: 'VS_HERO_WPA' as const,
  scores: [{ archetypeId: LOCKED_ARCHETYPE_ID, score: 0.08, confidence: 0.9, coverage: 1 }],
  degradedReasons: [] as string[],
};

function existingLock() {
  return {
    matchId: MATCH_ID,
    heroId: HERO_ID,
    snapshotId: LOCKED_SNAPSHOT_ID,
    archetypeId: LOCKED_ARCHETYPE_ID,
    enemyHeroIds: [...FULL_ENEMY_ROSTER],
    selection: lockedSelection,
    degradedReasons: [] as string[],
    lockedAt: new Date('2026-09-10T18:05:00.000Z'),
    lockedGameTimeS: 120,
  };
}

function decision(enemyHeroIds: readonly number[]) {
  return {
    state: {
      decisionId: 'decision-locked',
      matchId: MATCH_ID,
      playerSlot: 0,
      gameTimeSec: 900,
      rulesetId: RULESET_ID,
      heroId: HERO_ID,
      inventory: {
        initializedFromSnapshot: true,
        heldByItemId: new Map(),
        lifecycleCountByItemId: new Map(),
        nextInstanceSequence: 1,
      },
      economy: {
        spendableSouls: observedFact(10_000, 'test'),
        shopOpportunity: unknownFact('test'),
      },
    },
    itemGraph: createRecommendationItemGraph([]),
    catalogVersionId: 'catalog-a',
    catalogSha256: CATALOG_SHA,
    rulesetId: RULESET_ID,
    localSteamId: 'steam-local',
    allyHeroIds: [],
    enemyHeroIds: [...enemyHeroIds],
    enemyHeroes: enemyHeroIds.map((heroId) => ({ heroId })),
    enemyLiveStates: enemyHeroIds.map((heroId) => ({ steamId: `enemy-${heroId}`, heroId })),
    allyItemIds: [],
    enemyItemIds: [],
    slots: {
      baseSlots: 0,
      baseSlotsByType: { weapon: 0, vitality: 0, spirit: 0 },
      maxFlexSlots: 12,
      maxActiveItems: 4,
      unlockedFlexSlots: 12,
      usedSlots: 0,
      usedSlotsByType: { weapon: 0, vitality: 0, spirit: 0 },
      usedByType: { weapon: 0, vitality: 0, spirit: 0 },
      overflowByType: { weapon: 0, vitality: 0, spirit: 0 },
      usedFlexSlots: 0,
      provedFlexLowerBound: 12,
      freeBaseSlots: 0,
      freeBaseSlotsByType: { weapon: 0, vitality: 0, spirit: 0 },
      freeBaseByType: { weapon: 0, vitality: 0, spirit: 0 },
      freeFlexSlots: 12,
      totalCapacity: 12,
      activeItemsUsed: 0,
      usedActiveItems: 0,
      freeActiveItemSlots: 4,
      mechanicsEvidence: 'RECONSTRUCTED',
      flexEvidence: 'OBSERVED',
      evidence: 'OBSERVED',
    },
    investment: {
      tracks: {
        weapon: { type: 'weapon', currentValue: 0 },
        vitality: { type: 'vitality', currentValue: 0 },
        spirit: { type: 'spirit', currentValue: 0 },
      },
      evidence: 'RECONSTRUCTED',
    },
    economyRulesEvidence: 'RECONSTRUCTED',
    stateRevision: `state-${enemyHeroIds.length}`,
  };
}

function evidenceBundle() {
  const unavailable = (dataset: string) => ({
    dataset,
    scopeKey: `test:${dataset}`,
    freshness: 'UNAVAILABLE',
    confidence: 0,
  });
  return {
    heroId: HERO_ID,
    rulesetVersion: RULESET_ID,
    catalogSha256: CATALOG_SHA,
    statlockerPatchId: PATCH_ID,
    usable: true,
    snapshotIds: [],
    degradedReasons: ['WPA_PATCH_DATA:UNAVAILABLE', 'T4_CHAINS:UNAVAILABLE'],
    families: [],
    byDataset: {
      WPA_PATCH_DATA: unavailable('WPA_PATCH_DATA'),
      VS_HERO_WPA: unavailable('VS_HERO_WPA'),
      T4_CHAINS: unavailable('T4_CHAINS'),
      CONSENSUS_SKELETON: unavailable('CONSENSUS_SKELETON'),
      WPA_FILTERED_ITEMS: unavailable('WPA_FILTERED_ITEMS'),
    },
  };
}

function harness(options: {
  enemyHeroIds: readonly number[];
  lock: ReturnType<typeof existingLock> | null;
}) {
  const decisionState = { build: jest.fn(async () => decision(options.enemyHeroIds)) };
  const evidence = {
    resolveLocalPatchId: jest.fn(() => PATCH_ID),
    getLocalEvidence: jest.fn(() => evidenceBundle()),
  };
  const snapshotStore = {
    getById: jest.fn(async () => lockedSnapshot),
    getActiveWithPatch: jest.fn(async () => ({
      snapshot: lockedSnapshot,
      statlockerPatchId: PATCH_ID,
    })),
  };
  const wpaRepository = { findActive: jest.fn(async () => []) };
  const selector = { select: jest.fn(() => { throw new Error('selector must not rerun'); }) };
  const session = {
    get: jest.fn(async () => options.lock),
    getOrLock: jest.fn(async () => { throw new Error('lock creation must not happen here'); }),
  };
  const enemyThreat = { scoreEnemies: jest.fn(() => []) };
  const discovery = { discover: jest.fn(() => []) };
  const resolver = {
    resolve: jest.fn(() => ({
      planRevision: 'plan-locked',
      matchId: MATCH_ID,
      heroId: HERO_ID,
      archetypeId: LOCKED_ARCHETYPE_ID,
      stateRevision: `state-${options.enemyHeroIds.length}`,
      steps: [],
      degradedReasons: [],
      validation: { valid: true, reasonCodes: [] },
    })),
  };
  const traceStore = new BuildDebugTraceStoreV2Service();
  const service = new AdaptiveRecommendationV2Service(
    decisionState as any,
    evidence as any,
    snapshotStore as any,
    wpaRepository as any,
    selector as any,
    session as any,
    enemyThreat as any,
    discovery as any,
    resolver as any,
    traceStore,
  );
  return { service, session };
}

describe('AdaptiveRecommendationV2Service lock resolution', () => {
  it('returns the existing lock and its enemy roster when the session already has one', async () => {
    const lock = existingLock();
    const h = harness({ enemyHeroIds: FULL_ENEMY_ROSTER, lock });

    const resolution = await h.service.resolveLockContext({
      matchId: MATCH_ID,
      localSteamId: 'steam-local',
    });

    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    expect(resolution.context.lock).toBe(lock);
    expect(resolution.context.enemyHeroIds).toEqual([...FULL_ENEMY_ROSTER]);
    expect(h.session.getOrLock).not.toHaveBeenCalled();
  });

  it('reports blockers instead of a context when the lock cannot be produced', async () => {
    const h = harness({ enemyHeroIds: FULL_ENEMY_ROSTER.slice(0, 5), lock: null });

    const resolution = await h.service.resolveLockContext({
      matchId: MATCH_ID,
      localSteamId: 'steam-local',
    });

    expect(resolution.ok).toBe(false);
    if (resolution.ok) return;
    expect(resolution.blockers.length).toBeGreaterThan(0);
    expect(resolution.blockers).toContain('ENEMY_ROSTER_INCOMPLETE');
  });
});
