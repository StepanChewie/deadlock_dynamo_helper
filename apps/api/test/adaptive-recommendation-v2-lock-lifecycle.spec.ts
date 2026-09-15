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

const existingLock = {
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

function harness(enemyHeroIds: readonly number[]) {
  const decisionState = { build: jest.fn(async () => decision(enemyHeroIds)) };
  const evidence = {
    resolveLocalPatchId: jest.fn(() => PATCH_ID),
    getLocalEvidence: jest.fn(() => evidenceBundle()),
  };
  const snapshotStore = {
    getActive: jest.fn(async () => {
      throw new Error('active snapshot rotated after lock');
    }),
    getById: jest.fn(async (snapshotId: string) => {
      if (snapshotId !== LOCKED_SNAPSHOT_ID) throw new Error(`unexpected snapshot ${snapshotId}`);
      return lockedSnapshot;
    }),
  };
  const wpaRepository = { findActive: jest.fn(async () => []) };
  const selector = { select: jest.fn(() => { throw new Error('selector must not rerun for existing lock'); }) };
  const session = {
    get: jest.fn(async () => existingLock),
    getOrLock: jest.fn(async () => { throw new Error('existing lock must not be rewritten'); }),
  };
  const enemyThreat = { scoreEnemies: jest.fn(() => []) };
  const discovery = { discover: jest.fn(() => []) };
  const resolver = {
    resolve: jest.fn(() => ({
      planRevision: 'plan-locked',
      matchId: MATCH_ID,
      heroId: HERO_ID,
      archetypeId: LOCKED_ARCHETYPE_ID,
      stateRevision: `state-${enemyHeroIds.length}`,
      steps: [],
      degradedReasons: ['MATCHUP_WPA_UNAVAILABLE', 'T4_CHAINS_UNAVAILABLE'],
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
  return { service, snapshotStore, selector, session, resolver };
}

describe('AdaptiveRecommendationV2Service locked-session lifecycle', () => {
  it('uses the persisted full roster after lock when the current live roster is temporarily incomplete', async () => {
    const h = harness(FULL_ENEMY_ROSTER.slice(0, 5));

    const result = await h.service.recommend({ matchId: MATCH_ID, localSteamId: 'steam-local' });

    expect(result.ready).toBe(true);
    expect(result.lock?.archetypeId).toBe(LOCKED_ARCHETYPE_ID);
    expect(result.lock?.enemyHeroIds).toEqual(FULL_ENEMY_ROSTER);
    expect(h.selector.select).not.toHaveBeenCalled();
    expect(h.session.getOrLock).not.toHaveBeenCalled();
  });

  it('loads the snapshot named by an existing lock instead of silently switching to the current active snapshot', async () => {
    const h = harness(FULL_ENEMY_ROSTER);

    const result = await h.service.recommend({ matchId: MATCH_ID, localSteamId: 'steam-local' });

    expect(result.ready).toBe(true);
    expect(result.lock?.snapshotId).toBe(LOCKED_SNAPSHOT_ID);
    expect(h.snapshotStore.getById).toHaveBeenCalledWith(LOCKED_SNAPSHOT_ID);
    expect(h.snapshotStore.getActive).not.toHaveBeenCalled();
    expect(h.selector.select).not.toHaveBeenCalled();
  });
});
