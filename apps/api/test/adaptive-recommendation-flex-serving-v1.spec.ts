import {
  createRecommendationItemGraph,
  observedFact,
} from '@deadlock-live-probe/build-domain';
import { AdaptiveRecommendationV1Service } from '../src/statlocker-adaptive/adaptive-recommendation-v1.service';

const catalogSha256 = 'a'.repeat(64);

function graph() {
  return createRecommendationItemGraph(Array.from({ length: 10 }, (_, index) => {
    const itemId = index + 1;
    const slotType = itemId <= 3 ? 'weapon' : itemId <= 6 ? 'vitality' : itemId <= 9 ? 'spirit' : 'weapon';
    return {
      itemId,
      name: `Item ${itemId}`,
      slotType: slotType as any,
      active: false,
      availableRulesetIds: ['ruleset-a'],
      directPurchaseCost: 500,
      upgradeRecipes: [],
      sellTransition: { soulsRefund: 250, returnedItemIds: [] },
      maxCopies: 1,
    };
  }));
}

function inventory() {
  const ids = Array.from({ length: 9 }, (_, index) => index + 1);
  return {
    initializedFromSnapshot: true,
    heldByItemId: new Map(ids.map((itemId) => [itemId, {
      itemId,
      instanceId: `item-${itemId}`,
      lifecycle: 1,
      acquiredBy: 'RECONCILE' as const,
      acquiredAtMs: 0,
    }])),
    lifecycleCountByItemId: new Map(ids.map((itemId) => [itemId, 1])),
    nextInstanceSequence: 10,
  };
}

function decision(revision: string, unlockedFlexSlots = 1) {
  return {
    state: {
      decisionId: `adaptive:${revision}`,
      matchId: 'match-flex',
      playerSlot: 0,
      gameTimeSec: 900,
      rulesetId: 'ruleset-a',
      heroId: 10,
      inventory: inventory(),
      economy: {
        spendableSouls: observedFact(1000, 'test'),
        shopOpportunity: observedFact('AVAILABLE', 'test'),
      },
    },
    itemGraph: graph(),
    catalogVersionId: 'catalog-a',
    catalogSha256,
    rulesetId: 'ruleset-a',
    localSteamId: 'steam-a',
    enemyHeroIds: [20],
    enemyLiveStates: [],
    slots: {
      baseSlots: 9,
      baseSlotsByType: { weapon: 3, vitality: 3, spirit: 3 },
      maxActiveItems: 4,
      maxFlexSlots: 3,
      unlockedFlexSlots,
      usedSlots: 9,
      usedFlexSlots: 0,
      usedSlotsByType: { weapon: 3, vitality: 3, spirit: 3 },
      overflowByType: { weapon: 0, vitality: 0, spirit: 0 },
      provedFlexLowerBound: 0,
      freeBaseSlots: 0,
      freeFlexSlots: unlockedFlexSlots,
      totalCapacity: 9 + unlockedFlexSlots,
      flexCapacityEvidence: 'OBSERVED',
      evidence: 'OBSERVED',
    },
    economyRules: {
      rulesetId: 'ruleset-a',
      catalogSha256,
      baseSlots: 9,
      baseSlotsByType: { weapon: 3, vitality: 3, spirit: 3 },
      maxActiveItems: 4,
      maxFlexSlots: 3,
      investmentBreakpoints: { weapon: [], vitality: [], spirit: [] },
    },
    investment: {
      tracks: {
        weapon: { type: 'weapon', currentValue: 0 },
        vitality: { type: 'vitality', currentValue: 0 },
        spirit: { type: 'spirit', currentValue: 0 },
      },
      evidence: 'UNKNOWN',
    },
    ourTeamSouls: 100000,
    enemyTeamSouls: 100000,
    stateRevision: revision,
  } as any;
}

function evidence() {
  const unavailable = (dataset: string, scopeKey: string) => ({ dataset, scopeKey, freshness: 'UNAVAILABLE', confidence: 0 });
  const fresh = {
    dataset: 'WPA_PATCH_DATA',
    scopeKey: 'patch:15-1',
    snapshotId: 'snapshot-wpa',
    contentSha256: 'b'.repeat(64),
    fetchedAt: '2026-09-01T12:00:00.000Z',
    freshness: 'FRESH',
    confidence: 1,
    payload: { patchId: '15-1', items: [] },
  };
  return {
    heroId: 10,
    rulesetVersion: 'ruleset-a',
    catalogSha256,
    statlockerPatchId: '15-1',
    usable: true,
    snapshotIds: ['snapshot-wpa'],
    degradedReasons: [],
    families: [fresh],
    byDataset: {
      WPA_PATCH_DATA: fresh,
      VS_HERO_WPA: unavailable('VS_HERO_WPA', 'global'),
      T4_CHAINS: unavailable('T4_CHAINS', 'global'),
      CONSENSUS_SKELETON: unavailable('CONSENSUS_SKELETON', 'hero:10:consensus'),
      WPA_FILTERED_ITEMS: unavailable('WPA_FILTERED_ITEMS', 'hero:10'),
    },
  } as any;
}

function plannerResult() {
  return {
    gameState: 'EVEN',
    nextAction: {
      actionKey: 'BUY_ITEM:10',
      type: 'BUY',
      itemId: 10,
      targetItemId: 10,
      reasonCodes: ['FEASIBLE'],
    },
    recommendedBuild: [{
      itemId: 10,
      position: 1,
      status: 'NEXT',
      score: 0.9,
      confidence: 0.8,
      skeletonStrength: 0.8,
      contextualSupport: 0.1,
      reasonCodes: ['BUILD_REQUIRED'],
    }],
    changes: [],
    rankedImmediateCandidates: [{
      action: {
        actionKey: 'BUY_ITEM:10',
        type: 'BUY',
        itemId: 10,
        targetItemId: 10,
        reasonCodes: ['FEASIBLE'],
      },
      score: 0.9,
      confidence: 0.8,
      components: [],
      reasonCodes: ['FEASIBLE'],
    }],
    totalScore: 0.9,
    confidence: 0.8,
    plannerVersion: 'adaptive-build-planner-v1',
  } as any;
}

describe('AdaptiveRecommendationV1Service flex-aware fresh legality', () => {
  it('honors an observed unlocked flex slot during the final legality recheck', async () => {
    const initial = decision('revision-a');
    const fresh = decision('revision-b');
    const stateService = {
      build: jest.fn().mockResolvedValueOnce(initial).mockResolvedValueOnce(fresh),
    };
    const evidenceService = {
      resolveLocalPatchId: jest.fn(() => '15-1'),
      getLocalEvidence: jest.fn(() => evidence()),
    };
    const planner = { version: 'adaptive-build-planner-v1', plan: jest.fn(() => plannerResult()) };
    const replay = {
      getPreviousPlan: jest.fn().mockResolvedValue(undefined),
      toReplayInput: jest.fn(() => ({ snapshotIds: ['snapshot-wpa'] })),
      persist: jest.fn().mockResolvedValue(undefined),
    };
    const service = new AdaptiveRecommendationV1Service(
      stateService as any,
      evidenceService as any,
      planner as any,
      replay as any,
    );

    const result = await service.recommend({ matchId: 'match-flex', localSteamId: 'steam-a' });

    expect(result.nextAction).toMatchObject({ type: 'BUY', targetItemId: 10 });
    expect(result.nextTargetItemId).toBe(10);
    expect(result.recommendedBuild.find((item) => item.status === 'NEXT')?.itemId).toBe(10);
  });

  it('does not publish a planned BUY after fresh state shows the flex slot is locked', async () => {
    const initial = decision('revision-a', 1);
    const fresh = decision('revision-b', 0);
    const stateService = {
      build: jest.fn().mockResolvedValueOnce(initial).mockResolvedValueOnce(fresh),
    };
    const evidenceService = {
      resolveLocalPatchId: jest.fn(() => '15-1'),
      getLocalEvidence: jest.fn(() => evidence()),
    };
    const planner = { version: 'adaptive-build-planner-v1', plan: jest.fn(() => plannerResult()) };
    const replay = {
      getPreviousPlan: jest.fn().mockResolvedValue(undefined),
      toReplayInput: jest.fn(() => ({ snapshotIds: ['snapshot-wpa'] })),
      persist: jest.fn().mockResolvedValue(undefined),
    };
    const service = new AdaptiveRecommendationV1Service(
      stateService as any,
      evidenceService as any,
      planner as any,
      replay as any,
    );

    const result = await service.recommend({ matchId: 'match-flex', localSteamId: 'steam-a' });

    expect(result.nextAction).toMatchObject({ type: 'WAIT', targetItemId: 10 });
    expect(result.nextAction.reasonCodes).toContain('NO_FRESH_LEGAL_TRANSACTION');
  });
});
