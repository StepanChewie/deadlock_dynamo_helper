import {
  buildInventoryInstancesForRecommendation,
  createRecommendationItemGraph,
  observedFact,
} from '@deadlock-live-probe/build-domain';
import { buildAdaptivePlanActionsV1 } from '../src/statlocker-adaptive/adaptive-plan-action-v1';

function decision() {
  const graph = createRecommendationItemGraph([
    {
      itemId: 1,
      name: 'Temporary Slot Item',
      slotType: 'weapon',
      active: false,
      availableRulesetIds: ['ruleset-a'],
      directPurchaseCost: 500,
      upgradeRecipes: [],
      sellTransition: { soulsRefund: 250, returnedItemIds: [] },
      maxCopies: 1,
    },
    {
      itemId: 2,
      name: 'Core Target',
      slotType: 'weapon',
      active: false,
      availableRulesetIds: ['ruleset-a'],
      directPurchaseCost: 1000,
      upgradeRecipes: [],
      sellTransition: { soulsRefund: 500, returnedItemIds: [] },
      maxCopies: 1,
    },
  ]);
  const heldByItemId = buildInventoryInstancesForRecommendation([1], graph);
  return {
    state: {
      decisionId: 'decision-1',
      matchId: 'match-1',
      playerSlot: 0,
      gameTimeSec: 500,
      rulesetId: 'ruleset-a',
      heroId: 10,
      inventory: {
        initializedFromSnapshot: true,
        heldByItemId,
        lifecycleCountByItemId: new Map([[1, 1]]),
        nextInstanceSequence: 2,
      },
      economy: {
        spendableSouls: observedFact(2000, 'test'),
        shopOpportunity: observedFact('AVAILABLE' as const, 'test'),
      },
    },
    itemGraph: graph,
    catalogVersionId: 'catalog-a',
    catalogSha256: 'a'.repeat(64),
    rulesetId: 'ruleset-a',
    localSteamId: 'steam-1',
    enemyHeroIds: [],
    enemyLiveStates: [],
    enemyHeroes: [],
    slots: {
      baseSlots: 1,
      baseSlotsByType: { weapon: 1, vitality: 0, spirit: 0 },
      maxFlexSlots: 0,
      maxActiveItems: 1,
      unlockedFlexSlots: 0,
      usedSlots: 1,
      usedByType: { weapon: 1, vitality: 0, spirit: 0 },
      usedSlotsByType: { weapon: 1, vitality: 0, spirit: 0 },
      overflowByType: { weapon: 0, vitality: 0, spirit: 0 },
      usedActiveItems: 0,
      activeItemsUsed: 0,
      usedFlexSlots: 0,
      provedFlexLowerBound: 0,
      freeBaseSlots: 0,
      freeBaseByType: { weapon: 0, vitality: 0, spirit: 0 },
      freeBaseSlotsByType: { weapon: 0, vitality: 0, spirit: 0 },
      freeActiveItemSlots: 1,
      freeFlexSlots: 0,
      totalCapacity: 1,
      mechanicsEvidence: 'RECONSTRUCTED' as const,
      flexEvidence: 'OBSERVED' as const,
      evidence: 'OBSERVED' as const,
    },
    investment: {
      evidence: 'UNKNOWN' as const,
      tracks: {
        weapon: { type: 'weapon' as const, currentValue: 0 },
        vitality: { type: 'vitality' as const, currentValue: 0 },
        spirit: { type: 'spirit' as const, currentValue: 0 },
      },
    },
    economyRulesEvidence: 'RECONSTRUCTED' as const,
    stateRevision: 'revision-1',
  };
}

describe('adaptive semantic preparatory transactions', () => {
  it('keeps a legal sell-before-buy capacity exit instead of collapsing it into a blocked target purchase', () => {
    const plan = buildAdaptivePlanActionsV1({
      stateRevision: 'revision-1',
      decision: decision(),
      nextAction: {
        actionKey: 'SELL_ITEM:1',
        type: 'SELL',
        itemId: 1,
        sellItemId: 1,
        targetItemId: 2,
        reasonCodes: ['CAPACITY_EXIT'],
      },
      recommendedBuild: [{
        itemId: 2,
        position: 1,
        status: 'NEXT',
        score: 1,
        confidence: 1,
        skeletonStrength: 1,
        contextualSupport: 1,
        reasonCodes: ['CORE_TARGET'],
      }],
    });

    expect(plan.map((entry) => [entry.status, entry.action.type, entry.targetItemId])).toEqual([
      ['READY', 'SELL', 2],
      ['READY', 'BUY', 2],
    ]);
    expect(plan[0].sourceItemIds).toEqual([1]);
    expect(plan[1].requirements).not.toContainEqual({ type: 'SELL_ITEM', itemId: 1 });
  });
});
