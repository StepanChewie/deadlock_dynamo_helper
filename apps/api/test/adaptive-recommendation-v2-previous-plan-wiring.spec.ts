import { createRecommendationItemGraph } from '@deadlock-live-probe/build-domain';
import { AdaptiveRecommendationV2Service } from '../src/statlocker-adaptive/adaptive-recommendation-v2.service';
import { BuildDebugTraceStoreV2Service } from '../src/statlocker-adaptive/build-debug-trace-store-v2.service';

const MATCH_ID = 'match-previous-plan-wiring';
const HERO_ID = 72;
const RULESET_ID = 'ruleset-a';
const CATALOG_SHA = 'a'.repeat(64);
const ENEMY_HERO_IDS = [6, 10, 13, 27, 31, 35];

function plan(revision: string) {
  return {
    planRevision: revision,
    matchId: MATCH_ID,
    heroId: HERO_ID,
    archetypeId: 'archetype:a',
    stateRevision: 'state-1',
    steps: [],
    desiredState: {
      families: [],
      selectedChoiceFamilyIdsByGroup: {},
      reasonCodes: [],
    },
    degradedReasons: [],
    mechanicalValidation: { valid: true, reasonCodes: [] },
    semanticValidation: { valid: true, reasonCodes: [], finalFamilyStates: [] },
    validation: { valid: true, reasonCodes: [] },
  } as any;
}

function harness() {
  const itemGraph = createRecommendationItemGraph([]);
  const decision = {
    state: {
      decisionId: 'decision-1',
      matchId: MATCH_ID,
      playerSlot: 0,
      gameTimeSec: 600,
      rulesetId: RULESET_ID,
      heroId: HERO_ID,
      inventory: {
        initializedFromSnapshot: true,
        heldByItemId: new Map(),
        lifecycleCountByItemId: new Map(),
        nextInstanceSequence: 1,
      },
      economy: {
        spendableSouls: { evidence: 'OBSERVED', value: 50_000 },
        shopOpportunity: { evidence: 'UNKNOWN', reason: 'test' },
      },
    },
    itemGraph,
    catalogVersionId: 'catalog-a',
    catalogSha256: CATALOG_SHA,
    rulesetId: RULESET_ID,
    localSteamId: 'steam-local',
    allyHeroIds: [],
    enemyHeroIds: ENEMY_HERO_IDS,
    enemyHeroes: ENEMY_HERO_IDS.map((heroId) => ({ heroId })),
    enemyLiveStates: ENEMY_HERO_IDS.map((heroId) => ({ steamId: `enemy-${heroId}`, heroId })),
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
    stateRevision: 'state-1',
  } as any;

  const selection = {
    archetypeId: 'archetype:a',
    mode: 'VS_HERO_WPA',
    scores: [{
      archetypeId: 'archetype:a',
      score: 1,
      confidence: 1,
      coverage: 1,
    }],
    degradedReasons: [],
  };
  const lock = {
    matchId: MATCH_ID,
    heroId: HERO_ID,
    snapshotId: 'snapshot-a',
    archetypeId: 'archetype:a',
    enemyHeroIds: ENEMY_HERO_IDS,
    selection,
    lockedAt: new Date('2026-09-11T08:00:00.000Z'),
    lockedGameTimeS: 300,
    degradedReasons: [],
  };
  const snapshot = {
    snapshotId: 'snapshot-a',
    heroId: HERO_ID,
    rulesetVersion: RULESET_ID,
    catalogSha256: CATALOG_SHA,
    statlockerPatchId: 'patch-a',
    generatedAt: '2026-09-11T08:00:00.000Z',
    sourceProfileAccountIds: Array.from({ length: 10 }, (_, index) => `profile-${index}`),
    archetypes: [{ archetypeId: 'archetype:a' }],
  } as any;
  const unavailable = (dataset: string) => ({
    dataset,
    scopeKey: `test:${dataset}`,
    freshness: 'UNAVAILABLE',
    confidence: 0,
  });
  const evidenceBundle = {
    heroId: HERO_ID,
    rulesetVersion: RULESET_ID,
    catalogSha256: CATALOG_SHA,
    statlockerPatchId: 'patch-a',
    usable: true,
    snapshotIds: [],
    degradedReasons: [],
    families: [],
    byDataset: {
      WPA_PATCH_DATA: unavailable('WPA_PATCH_DATA'),
      VS_HERO_WPA: unavailable('VS_HERO_WPA'),
      T4_CHAINS: unavailable('T4_CHAINS'),
      CONSENSUS_SKELETON: unavailable('CONSENSUS_SKELETON'),
      WPA_FILTERED_ITEMS: unavailable('WPA_FILTERED_ITEMS'),
    },
  };

  const resolver = {
    resolve: jest
      .fn()
      .mockReturnValueOnce(plan('plan-1'))
      .mockReturnValueOnce(plan('plan-2')),
  };
  const traceStore = new BuildDebugTraceStoreV2Service();
  const service = new AdaptiveRecommendationV2Service(
    { build: jest.fn(async () => decision) } as any,
    { getLocalEvidence: jest.fn(() => evidenceBundle) } as any,
    { getById: jest.fn(async () => snapshot) } as any,
    { findActive: jest.fn(async () => []) } as any,
    {} as any,
    { get: jest.fn(async () => lock) } as any,
    { scoreEnemies: jest.fn(() => []) } as any,
    { discover: jest.fn(() => []) } as any,
    resolver as any,
    traceStore,
  );

  return { service, resolver, traceStore };
}

describe('AdaptiveRecommendationV2Service previous-plan wiring', () => {
  it('passes the previously stored final plan into the resolver before the second resolution', async () => {
    const h = harness();

    await h.service.recommend({ matchId: MATCH_ID, localSteamId: 'steam-local' });
    const previousPlan = h.traceStore.get(MATCH_ID)?.finalPlan;
    expect(previousPlan).toBeDefined();

    await h.service.recommend({ matchId: MATCH_ID, localSteamId: 'steam-local' });

    expect(h.resolver.resolve).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ previousPlan }),
    );
  });
});
