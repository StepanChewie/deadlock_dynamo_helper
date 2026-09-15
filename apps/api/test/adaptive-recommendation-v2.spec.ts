import { createRecommendationItemGraph } from '@dynamo-lab/build-domain';
import { AdaptiveRecommendationV2Service } from '../src/statlocker-adaptive/adaptive-recommendation-v2.service';
import { BuildIterationCaptureV1 } from '../src/statlocker-adaptive/build-iteration-capture-v1';

const MATCH_ID = 'match-1';
const HERO_ID = 45;
const RULESET_ID = 'ruleset-1';
const CATALOG_SHA = 'a'.repeat(64);
const PATCH_ID = 'patch-1';
const ARCHETYPE_ID = 'archetype:x';
const SNAPSHOT_ID = 'snapshot-1';
const ENEMY_HERO_IDS = [6, 10, 13, 27, 31, 35];

function lockedDecision() {
  return {
    state: {
      decisionId: 'd-1',
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
        spendableSouls: { evidence: 'OBSERVED', value: 0 },
        shopOpportunity: { evidence: 'UNKNOWN', reason: 'test' },
      },
    },
    itemGraph: createRecommendationItemGraph([]),
    catalogVersionId: 'catalog-1',
    catalogSha256: CATALOG_SHA,
    rulesetId: RULESET_ID,
    localSteamId: 'steam-222',
    allyHeroIds: [],
    enemyHeroIds: [...ENEMY_HERO_IDS],
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
      provedFlexLowerBound: 12,
      totalCapacity: 12,
      mechanicsEvidence: 'RECONSTRUCTED',
      flexEvidence: 'OBSERVED',
      evidence: 'OBSERVED',
    },
    stateRevision: 'rev-1',
  };
}

function existingLock() {
  return {
    matchId: MATCH_ID,
    steamId: 'steam-222',
    heroId: HERO_ID,
    snapshotId: SNAPSHOT_ID,
    archetypeId: ARCHETYPE_ID,
    enemyHeroIds: [...ENEMY_HERO_IDS],
    selection: {
      archetypeId: ARCHETYPE_ID,
      mode: 'VS_HERO_WPA',
      scores: [{ archetypeId: ARCHETYPE_ID, score: 1, confidence: 1, coverage: 1 }],
      degradedReasons: [],
    },
    degradedReasons: [],
    lockedAt: new Date('2026-09-14T00:00:00.000Z'),
    lockedGameTimeSec: 300,
  };
}

function lockedPlayerHarness() {
  const sessionGet = jest.fn().mockResolvedValue(existingLock());
  const traceStoreGet = jest.fn().mockReturnValue(undefined);
  const snapshot = {
    snapshotId: SNAPSHOT_ID,
    heroId: HERO_ID,
    rulesetVersion: RULESET_ID,
    catalogSha256: CATALOG_SHA,
    statlockerPatchId: PATCH_ID,
    sourceProfileAccountIds: Array.from({ length: 10 }, (_, index) => `profile-${index}`),
    archetypes: [{ archetypeId: ARCHETYPE_ID }],
  };
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
    statlockerPatchId: PATCH_ID,
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
  const service = new AdaptiveRecommendationV2Service(
    { build: jest.fn().mockResolvedValue(lockedDecision()) } as any,
    { getLocalEvidence: jest.fn(() => evidenceBundle), resolveLocalPatchId: jest.fn() } as any,
    { getById: jest.fn(async () => snapshot) } as any,
    { findActive: jest.fn(async () => []) } as any,
    {} as any,
    { get: sessionGet } as any,
    { scoreEnemies: jest.fn(() => []) } as any,
    { discover: jest.fn(() => []) } as any,
    {
      resolve: jest.fn(() => ({
        planRevision: 'plan-1',
        steps: [],
        degradedReasons: [],
        validation: { valid: true, reasonCodes: [] },
      })),
    } as any,
    { get: traceStoreGet, put: jest.fn() } as any,
  );
  return { service, sessionGet, traceStoreGet };
}

describe('AdaptiveRecommendationV2Service player scoping', () => {
  it('reads the lock and the previous plan for the resolved player, not the request body', async () => {
    const { service, sessionGet, traceStoreGet } = lockedPlayerHarness();

    await service.recommend({ matchId: MATCH_ID, localSteamId: 'steam-111' });

    expect(sessionGet).toHaveBeenCalledWith(MATCH_ID, 'steam-222');
    expect(traceStoreGet).toHaveBeenCalledWith(MATCH_ID, 'steam-222');
  });

  it('fills the build iteration capture on the ready path', async () => {
    const { service } = lockedPlayerHarness();
    const capture = new BuildIterationCaptureV1();

    const result = await service.recommend({ matchId: MATCH_ID, localSteamId: 'steam-111' }, capture);

    expect(result.ready).toBe(true);
    expect(capture.steamId).toBe('steam-222');
    expect(capture.heroId).toBe(HERO_ID);
    expect(capture.gameTimeSec).toBe(600);
    expect(capture.capacity).toBe(12);
    expect(capture.inventoryItemIds).toEqual([]);
    expect(capture.spendableSouls).toBe(0);
    expect(capture.enemyHeroIds).toEqual([...ENEMY_HERO_IDS]);
    expect(capture.enemyThreats).toEqual([]);
    expect(capture.archetype).toEqual({
      archetypeId: ARCHETYPE_ID,
      snapshotId: SNAPSHOT_ID,
      scores: [{ archetypeId: ARCHETYPE_ID, score: 1, confidence: 1 }],
    });
    expect(capture.evidence?.families.map((family) => family.dataset)).toEqual([
      'PRO_BUILD_ANALYSIS',
      'VS_HERO_WPA',
      'WPA_PATCH_DATA',
      'T4_CHAINS',
    ]);
    expect(Array.isArray(capture.stages)).toBe(true);
  });
});
