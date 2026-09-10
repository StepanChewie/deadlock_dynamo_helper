import { createRecommendationItemGraph } from '@deadlock-live-probe/build-domain';
import { AdaptiveSituationalContextV1Service } from '../src/statlocker-adaptive/adaptive-situational-context-v1.service';
import { resolveSituationalPlanV1 } from '../src/statlocker-adaptive/adaptive-situational-planner-v1';

function item(itemId: number) {
  return {
    itemId,
    name: `Item ${itemId}`,
    slotType: 'weapon' as const,
    active: false,
    availableRulesetIds: ['ruleset-a'],
    directPurchaseCost: 500,
    upgradeRecipes: [],
    sellTransition: { soulsRefund: 250, returnedItemIds: [] as number[] },
    maxCopies: 1,
  };
}

describe('resolveSituationalPlanV1', () => {
  it('opens only a supported optional window that beats CONTINUE_CORE and enriches current enemy names', () => {
    const itemGraph = createRecommendationItemGraph([item(1), item(2)]);
    const scorer = {
      scoreItem: jest.fn((itemId: number) => ({
        itemId,
        score: itemId === 2 ? 1 : 0.1,
        confidence: 0.9,
        completeness: 1,
        components: [],
        version: 'adaptive-evidence-scorer-v1',
      })),
    } as any;
    const evidence: any = {
      heroId: 10,
      rulesetVersion: 'ruleset-a',
      catalogSha256: 'a'.repeat(64),
      statlockerPatchId: '15-1',
      usable: true,
      snapshotIds: ['vs'],
      degradedReasons: [],
      families: [],
      byDataset: {
        VS_HERO_WPA: {
          dataset: 'VS_HERO_WPA',
          scopeKey: 'global',
          snapshotId: 'vs',
          freshness: 'FRESH',
          confidence: 1,
          payload: {
            slices: [{
              heroId: 10,
              enemyHeroId: 20,
              items: [{ itemId: 2, deltaWpa: 0.5, count: 5000 }],
            }],
          },
        },
      },
    };
    evidence.families = [evidence.byDataset.VS_HERO_WPA];
    const decision: any = {
      state: {
        decisionId: 'decision-a',
        matchId: 'match-a',
        playerSlot: 0,
        gameTimeSec: 700,
        rulesetId: 'ruleset-a',
        heroId: 10,
        inventory: { initializedFromSnapshot: true, heldByItemId: new Map(), lifecycleCountByItemId: new Map(), nextInstanceSequence: 1 },
        economy: {},
      },
      itemGraph,
      rulesetId: 'ruleset-a',
      catalogSha256: 'a'.repeat(64),
      enemyHeroIds: [20],
      enemyLiveStates: [],
      enemyHeroes: [{ heroId: 20, heroName: 'Enemy Twenty' }],
      ourTeamSouls: 100000,
      enemyTeamSouls: 100000,
    };
    const corePlan: any = {
      nextTargetItemId: 1,
      nextAction: { actionKey: 'BUY_ITEM:1', type: 'BUY', itemId: 1, targetItemId: 1, reasonCodes: [] },
      recommendedBuild: [{ itemId: 1, position: 1, status: 'NEXT', score: 0.1, confidence: 0.9, skeletonStrength: 1, contextualSupport: 0, reasonCodes: [] }],
    };

    const result = resolveSituationalPlanV1({
      decision,
      evidence,
      corePlan,
      scorer,
      evaluator: new AdaptiveSituationalContextV1Service(),
      windows: [{
        heroId: 10,
        rulesetId: 'ruleset-a',
        catalogSha256: 'a'.repeat(64),
        windowId: 'catch-window',
        purpose: 'CATCH',
        targetItemIds: [2],
        maxItems: 1,
        maxSoulsDelay: 1600,
        reservedSlots: 1,
      }],
      optionalTargetItemIds: new Set([2]),
    });

    expect(result.windowStates).toEqual([{ windowId: 'catch-window', state: 'OPEN', targetItemIds: [2], reasonCodes: ['SITUATIONAL_ACCEPTED'] }]);
    expect(result.contextByTargetItemId.get(2)?.targetEnemies[0].enemyHeroName).toBe('Enemy Twenty');
    expect(result.contextByTargetItemId.get(2)?.purpose).toBe('CATCH');
  });
});
