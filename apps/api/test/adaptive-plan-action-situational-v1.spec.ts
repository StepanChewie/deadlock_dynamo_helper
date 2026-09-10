import {
  createRecommendationItemGraph,
  observedFact,
} from '@deadlock-live-probe/build-domain';
import { AdaptiveSituationalContextV1 } from '@deadlock-live-probe/shared';
import { buildAdaptivePlanActionsV1 } from '../src/statlocker-adaptive/adaptive-plan-action-v1';

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

function decision() {
  const itemGraph = createRecommendationItemGraph([item(1), item(2)]);
  return {
    state: {
      decisionId: 'decision-a',
      matchId: 'match-a',
      playerSlot: 0,
      gameTimeSec: 700,
      rulesetId: 'ruleset-a',
      heroId: 10,
      inventory: {
        initializedFromSnapshot: true,
        heldByItemId: new Map(),
        lifecycleCountByItemId: new Map(),
        nextInstanceSequence: 1,
      },
      economy: {
        spendableSouls: observedFact(5000, 'test'),
        shopOpportunity: observedFact('AVAILABLE', 'test'),
      },
    },
    itemGraph,
    catalogVersionId: 'catalog-a',
    catalogSha256: 'a'.repeat(64),
    rulesetId: 'ruleset-a',
    localSteamId: 'steam-a',
    enemyHeroIds: [20],
    enemyLiveStates: [],
    enemyHeroes: [{ heroId: 20, heroName: 'Enemy Twenty' }],
    slots: {
      baseSlots: 12,
      baseSlotsByType: { weapon: 4, vitality: 4, spirit: 4 },
      maxFlexSlots: 3,
      maxActiveItems: 4,
      unlockedFlexSlots: 3,
      usedSlots: 0,
      usedByType: { weapon: 0, vitality: 0, spirit: 0 },
      usedActiveItems: 0,
      usedFlexSlots: 0,
      provedFlexLowerBound: 0,
      freeBaseSlots: 12,
      freeBaseByType: { weapon: 4, vitality: 4, spirit: 4 },
      freeFlexSlots: 3,
      totalCapacity: 15,
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
    economyRulesEvidence: 'UNKNOWN',
    stateRevision: 'revision-a',
  } as any;
}

function situational(): AdaptiveSituationalContextV1 {
  return {
    purpose: 'CATCH',
    targetEnemies: [{
      enemyHeroId: 20,
      enemyHeroName: 'Enemy Twenty',
      role: 'PRIMARY',
      score: 0.4,
      confidence: 0.8,
      evidenceKinds: ['MATCHUP_STAT'],
      deltaWpa: 0.05,
      sampleSize: 2000,
    }],
    primaryTargetEnemyHeroId: 20,
    recommendationConfidence: 0.8,
    coreInterruption: { accepted: true, estimatedSoulsDelay: 500 },
    reasonCodes: ['SITUATIONAL_WINDOW'],
  };
}

describe('buildAdaptivePlanActionsV1 situational target scoping', () => {
  it('attaches context only to the exact final build target even when multiple actions are compiled', () => {
    const context = situational();
    const actions = buildAdaptivePlanActionsV1({
      stateRevision: 'revision-a',
      decision: decision(),
      nextAction: {
        actionKey: 'BUY_ITEM:1',
        type: 'BUY',
        itemId: 1,
        targetItemId: 1,
        reasonCodes: [],
      },
      recommendedBuild: [
        { itemId: 1, position: 1, status: 'NEXT', score: 1, confidence: 1, skeletonStrength: 1, contextualSupport: 0, reasonCodes: [] },
        { itemId: 2, position: 2, status: 'PLANNED', score: 1, confidence: 1, skeletonStrength: 1, contextualSupport: 0, reasonCodes: [] },
      ],
      situationalByTargetItemId: new Map([[2, context]]),
    });

    expect(actions).toHaveLength(2);
    expect(actions[0].targetItemId).toBe(1);
    expect(actions[0].situational).toBeUndefined();
    expect(actions[1].targetItemId).toBe(2);
    expect(actions[1].situational).toEqual(context);
  });
});
