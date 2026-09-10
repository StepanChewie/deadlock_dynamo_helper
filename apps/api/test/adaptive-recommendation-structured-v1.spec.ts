import {
  createRecommendationItemGraph,
  observedFact,
} from '@deadlock-live-probe/build-domain';
import { AdaptiveRecommendationObservabilityV1Service } from '../src/statlocker-adaptive/adaptive-recommendation-observability-v1.service';
import { AdaptiveRecommendationV1Service } from '../src/statlocker-adaptive/adaptive-recommendation-v1.service';

const catalogSha256 = 'a'.repeat(64);

function itemGraph(cost1: number, cost2: number) {
  return createRecommendationItemGraph([
    {
      itemId: 1,
      name: 'Item 1',
      slotType: 'weapon' as const,
      active: false,
      availableRulesetIds: ['ruleset-a'],
      directPurchaseCost: cost1,
      upgradeRecipes: [],
      sellTransition: { soulsRefund: Math.floor(cost1 / 2), returnedItemIds: [] },
      maxCopies: 1,
    },
    {
      itemId: 2,
      name: 'Item 2',
      slotType: 'weapon' as const,
      active: false,
      availableRulesetIds: ['ruleset-a'],
      directPurchaseCost: cost2,
      upgradeRecipes: [],
      sellTransition: { soulsRefund: Math.floor(cost2 / 2), returnedItemIds: [] },
      maxCopies: 1,
    },
    {
      itemId: 3,
      name: 'Item 3',
      slotType: 'weapon' as const,
      active: false,
      availableRulesetIds: ['ruleset-a'],
      directPurchaseCost: 500,
      upgradeRecipes: [],
      sellTransition: { soulsRefund: 250, returnedItemIds: [] },
      maxCopies: 1,
    },
    {
      itemId: 4,
      name: 'Item 4',
      slotType: 'weapon' as const,
      active: false,
      availableRulesetIds: ['ruleset-a'],
      upgradeRecipes: [{
        recipeId: 'upgrade-4',
        consumedItemIds: [1],
        soulsCost: 500,
      }],
      sellTransition: { soulsRefund: 250, returnedItemIds: [] },
      maxCopies: 1,
    },
  ]);
}

function decision(
  revision: string,
  graph = itemGraph(500, 500),
  ownedItemIds: readonly number[] = [],
) {
  return {
    state: {
      decisionId: `adaptive:${revision}`,
      matchId: 'match-a',
      playerSlot: 0,
      gameTimeSec: 700,
      rulesetId: 'ruleset-a',
      heroId: 10,
      inventory: {
        initializedFromSnapshot: true,
        heldByItemId: new Map(ownedItemIds.map((itemId) => [itemId, {
          itemId,
          instanceId: `item-${itemId}`,
          lifecycle: 1,
          acquiredBy: 'RECONCILE' as const,
          acquiredAtMs: 0,
        }])),
        lifecycleCountByItemId: new Map(ownedItemIds.map((itemId) => [itemId, 1])),
        nextInstanceSequence: ownedItemIds.length + 1,
      },
      economy: {
        spendableSouls: observedFact(1000, 'test'),
        shopOpportunity: observedFact('AVAILABLE', 'test'),
      },
    },
    itemGraph: graph,
    catalogVersionId: 'catalog-a',
    catalogSha256,
    rulesetId: 'ruleset-a',
    localSteamId: 'steam-a',
    enemyHeroIds: [20],
    enemyLiveStates: [],
    ourTeamSouls: 100000,
    enemyTeamSouls: 100000,
    stateRevision: revision,
  } as any;
}

function evidence() {
  const unavailable = (dataset: string, scopeKey: string) => ({
    dataset,
    scopeKey,
    freshness: 'UNAVAILABLE',
    confidence: 0,
  });
  const fresh = {
    dataset: 'WPA_PATCH_DATA',
    scopeKey: 'patch:15-1',
    snapshotId: 'snapshot-wpa',
    contentSha256: 'b'.repeat(64),
    fetchedAt: '2026-08-31T12:00:00.000Z',
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

function plan() {
  const plannedItem = {
    itemId: 1,
    position: 1,
    status: 'NEXT' as const,
    score: 0.9,
    confidence: 0.8,
    skeletonStrength: 0.8,
    contextualSupport: 0.1,
    reasonCodes: ['SKELETON_CORE'],
  };
  return {
    gameState: 'EVEN',
    nextAction: {
      actionKey: 'BUY_ITEM:1',
      type: 'BUY',
      itemId: 1,
      targetItemId: 1,
      reasonCodes: ['FEASIBLE'],
    },
    recommendedBuild: [plannedItem],
    changes: [],
    rankedImmediateCandidates: [
      {
        action: {
          actionKey: 'BUY_ITEM:1',
          type: 'BUY',
          itemId: 1,
          targetItemId: 1,
          reasonCodes: ['FEASIBLE'],
        },
        score: 0.9,
        confidence: 0.8,
        components: [],
        reasonCodes: ['FEASIBLE'],
      },
      {
        action: {
          actionKey: 'BUY_ITEM:2',
          type: 'BUY',
          itemId: 2,
          targetItemId: 2,
          reasonCodes: ['FEASIBLE'],
        },
        score: 0.8,
        confidence: 0.8,
        components: [],
        reasonCodes: ['FEASIBLE'],
      },
      {
        action: {
          actionKey: 'WAIT_SAVE:1',
          type: 'WAIT',
          targetItemId: 1,
          reasonCodes: ['FEASIBLE'],
        },
        score: 0.1,
        confidence: 0.5,
        components: [],
        reasonCodes: ['FEASIBLE'],
      },
    ],
    totalScore: 0.9,
    confidence: 0.8,
    plannerVersion: 'adaptive-build-planner-v1',
  } as any;
}

describe('AdaptiveRecommendationV1Service structured serving invariants', () => {
  it('never replaces the fresh NEXT target with a feasible transaction for another item', async () => {
    const initial = decision('revision-a', itemGraph(500, 500));
    const fresh = decision('revision-b', itemGraph(2000, 500));
    const stateService = {
      build: jest.fn().mockResolvedValueOnce(initial).mockResolvedValueOnce(fresh),
    };
    const evidenceService = {
      resolveLocalPatchId: jest.fn(() => '15-1'),
      getLocalEvidence: jest.fn(() => evidence()),
    };
    const planner = {
      version: 'adaptive-build-planner-v1',
      plan: jest.fn(() => plan()),
    };
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

    const result = await service.recommend({ matchId: 'match-a', localSteamId: 'steam-a' });

    const next = result.recommendedBuild.find((item) => item.status === 'NEXT');
    expect(next?.itemId).toBe(1);
    expect(result.nextTargetItemId).toBe(1);
    expect(result.nextAction.targetItemId).toBe(1);
    expect(result.nextAction.type).toBe('WAIT');
  });

  it('rebases a preparatory component SELL onto the fresh semantic NEXT target', async () => {
    const initial = decision('revision-a', itemGraph(500, 500), [1]);
    const fresh = decision('revision-b', itemGraph(500, 500), [1, 2]);
    const stateService = {
      build: jest.fn().mockResolvedValueOnce(initial).mockResolvedValueOnce(fresh),
    };
    const evidenceService = {
      resolveLocalPatchId: jest.fn(() => '15-1'),
      getLocalEvidence: jest.fn(() => evidence()),
    };
    const planner = {
      version: 'adaptive-build-planner-v1',
      plan: jest.fn(() => ({
        ...plan(),
        nextAction: {
          actionKey: 'SELL_ITEM:1',
          type: 'SELL',
          itemId: 1,
          sellItemId: 1,
          targetItemId: 2,
          reasonCodes: ['PREPARE_NEXT'],
        },
        recommendedBuild: [
          { ...plan().recommendedBuild[0], itemId: 2, status: 'NEXT' },
          { ...plan().recommendedBuild[0], itemId: 3, position: 2, status: 'PLANNED' },
        ],
        rankedImmediateCandidates: [{
          ...plan().rankedImmediateCandidates[0],
          action: {
            actionKey: 'SELL_ITEM:1',
            type: 'SELL',
            itemId: 1,
            sellItemId: 1,
            targetItemId: 2,
            reasonCodes: ['PREPARE_NEXT'],
          },
        }],
      })),
    };
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

    const result = await service.recommend({ matchId: 'match-a', localSteamId: 'steam-a' });

    expect(result.recommendedBuild.find((item) => item.status === 'NEXT')?.itemId).toBe(3);
    expect(result.nextAction).toMatchObject({ type: 'WAIT', targetItemId: 3 });
    expect(result.nextTargetItemId).toBe(3);
  });

  it('does not publish a preparatory SELL when fresh state has no semantic NEXT target', async () => {
    const initial = decision('revision-a', itemGraph(500, 500), [1]);
    const fresh = decision('revision-b', itemGraph(500, 500), [1, 2]);
    const stateService = {
      build: jest.fn().mockResolvedValueOnce(initial).mockResolvedValueOnce(fresh),
    };
    const evidenceService = {
      resolveLocalPatchId: jest.fn(() => '15-1'),
      getLocalEvidence: jest.fn(() => evidence()),
    };
    const planner = {
      version: 'adaptive-build-planner-v1',
      plan: jest.fn(() => ({
        ...plan(),
        nextAction: {
          actionKey: 'SELL_ITEM:1',
          type: 'SELL',
          itemId: 1,
          sellItemId: 1,
          targetItemId: 2,
          reasonCodes: ['PREPARE_NEXT'],
        },
        recommendedBuild: [{ ...plan().recommendedBuild[0], itemId: 2, status: 'NEXT' }],
        rankedImmediateCandidates: [{
          ...plan().rankedImmediateCandidates[0],
          action: {
            actionKey: 'SELL_ITEM:1',
            type: 'SELL',
            itemId: 1,
            sellItemId: 1,
            targetItemId: 2,
            reasonCodes: ['PREPARE_NEXT'],
          },
        }],
      })),
    };
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

    const result = await service.recommend({ matchId: 'match-a', localSteamId: 'steam-a' });

    expect(result.recommendedBuild.some((item) => item.status === 'NEXT')).toBe(false);
    expect(result.nextAction).toMatchObject({ type: 'WAIT' });
    expect(result.nextAction.targetItemId).toBeUndefined();
    expect(result.nextTargetItemId).toBeUndefined();
  });

  it('does not publish a legal BUY sibling when it disagrees with the semantic NEXT', async () => {
    const initial = decision('revision-a');
    const fresh = decision('revision-b');
    const stateService = {
      build: jest.fn().mockResolvedValueOnce(initial).mockResolvedValueOnce(fresh),
    };
    const evidenceService = {
      resolveLocalPatchId: jest.fn(() => '15-1'),
      getLocalEvidence: jest.fn(() => evidence()),
    };
    const planner = {
      version: 'adaptive-build-planner-v1',
      plan: jest.fn(() => ({
        ...plan(),
        nextAction: {
          actionKey: 'BUY_ITEM:2',
          type: 'BUY',
          itemId: 2,
          targetItemId: 2,
          reasonCodes: ['FEASIBLE'],
        },
      })),
    };
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

    const result = await service.recommend({ matchId: 'match-a', localSteamId: 'steam-a' });

    expect(result.recommendedBuild.find((item) => item.status === 'NEXT')?.itemId).toBe(1);
    expect(result.nextAction).toMatchObject({ type: 'WAIT', targetItemId: 1 });
  });

  it('treats partial decision fakes without slots or investment as non-crashing test doubles', async () => {
    const initial = decision('revision-a');
    const fresh = decision('revision-b');
    const stateService = {
      build: jest.fn().mockResolvedValueOnce(initial).mockResolvedValueOnce(fresh),
    };
    const evidenceService = {
      resolveLocalPatchId: jest.fn(() => '15-1'),
      getLocalEvidence: jest.fn(() => evidence()),
    };
    const planner = {
      version: 'adaptive-build-planner-v1',
      plan: jest.fn(() => plan()),
    };
    const replay = {
      getPreviousPlan: jest.fn().mockResolvedValue(undefined),
      toReplayInput: jest.fn(() => ({ snapshotIds: ['snapshot-wpa'] })),
      persist: jest.fn().mockResolvedValue(undefined),
    };
    const observability = new AdaptiveRecommendationObservabilityV1Service();
    const service = new AdaptiveRecommendationV1Service(
      stateService as any,
      evidenceService as any,
      planner as any,
      replay as any,
      observability,
    );

    await expect(service.recommend({ matchId: 'match-a', localSteamId: 'steam-a' })).resolves.toHaveProperty('nextAction');
    expect(observability.getStatus().counters.flexCapacityUnknownCount).toBe(0);
    expect(observability.getStatus().counters.investmentRulesUnknownCount).toBe(0);
  });
});
