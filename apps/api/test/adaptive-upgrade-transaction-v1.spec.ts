import {
  applyRecommendationCandidateTransitionV1,
  buildInventoryInstancesForRecommendation,
  createRecommendationItemGraph,
  generateRecommendationCandidates,
  observedFact,
} from '@deadlock-live-probe/build-domain';
import {
  deriveAdaptiveInvestmentStateV1,
  deriveAdaptiveSlotStateV1,
} from '../src/statlocker-adaptive/adaptive-economy-v1';
import { buildAdaptivePlanActionsV1 } from '../src/statlocker-adaptive/adaptive-plan-action-v1';

function item(itemId: number, name: string, upgradeFrom?: number) {
  return {
    itemId,
    name,
    slotType: 'weapon' as const,
    active: false,
    availableRulesetIds: ['ruleset-a'],
    ...(upgradeFrom === undefined ? { directPurchaseCost: 500 } : {}),
    upgradeRecipes: upgradeFrom === undefined
      ? []
      : [{ recipeId: `upgrade:${itemId}`, consumedItemIds: [upgradeFrom], soulsCost: 500 }],
    sellTransition: { soulsRefund: 250, returnedItemIds: [] as number[] },
    maxCopies: 1,
  };
}

const slotRules = {
  baseSlotsByType: { weapon: 4, vitality: 4, spirit: 4 },
  maxFlexSlots: 0,
  maxActiveItems: 4,
  evidence: 'RECONSTRUCTED' as const,
};

describe('adaptive upgrade transaction regression', () => {
  it('upgrades Close Quarters to Point Blank without selling an unrelated item, then continues to Escalating Resilience', () => {
    const graph = createRecommendationItemGraph([
      item(101, 'Close Quarters'),
      item(102, 'Point Blank', 101),
      item(103, 'Escalating Resilience', 102),
      item(104, 'Unrelated A'),
      item(105, 'Unrelated B'),
      item(106, 'Unrelated C'),
    ]);
    const ownedItemIds = [101, 104, 105, 106];
    const heldByItemId = buildInventoryInstancesForRecommendation(ownedItemIds, graph);
    const state: any = {
      decisionId: 'decision-regression',
      matchId: 'match-regression',
      playerSlot: 0,
      gameTimeSec: 900,
      rulesetId: 'ruleset-a',
      heroId: 10,
      inventory: {
        initializedFromSnapshot: true,
        heldByItemId,
        lifecycleCountByItemId: new Map<number, number>(ownedItemIds.map((itemId): [number, number] => [itemId, 1])),
        nextInstanceSequence: heldByItemId.size + 1,
      },
      economy: {
        spendableSouls: observedFact(5000, 'test'),
        shopOpportunity: observedFact('AVAILABLE', 'test'),
      },
    };
    const slots = deriveAdaptiveSlotStateV1(ownedItemIds, graph, slotRules, {
      unlockedFlexSlots: 0,
      evidence: 'OBSERVED',
    });
    const decision: any = {
      state,
      itemGraph: graph,
      catalogVersionId: 'catalog-a',
      catalogSha256: 'a'.repeat(64),
      rulesetId: 'ruleset-a',
      localSteamId: 'steam-a',
      enemyHeroIds: [],
      enemyLiveStates: [],
      enemyHeroes: [],
      slots,
      investment: deriveAdaptiveInvestmentStateV1(ownedItemIds, graph, undefined),
      economyRulesEvidence: 'UNKNOWN',
      stateRevision: 'revision-regression',
    };
    const rules = {
      baseSlotsByType: slots.baseSlotsByType,
      maxFlexSlots: slots.maxFlexSlots,
      unlockedFlexSlots: slots.unlockedFlexSlots,
      flexCapacityEvidence: slots.flexEvidence,
      maxActiveItems: slots.maxActiveItems,
      activeCapacityEvidence: slots.mechanicsEvidence,
      allowSellOnlyActions: true,
      generateTargetedWaitActions: true,
    };

    const plan = buildAdaptivePlanActionsV1({
      stateRevision: decision.stateRevision,
      decision,
      nextAction: {
        actionKey: 'REPLACE_ITEM:104:103',
        type: 'REPLACE',
        sellItemId: 104,
        buyItemId: 103,
        targetItemId: 103,
        reasonCodes: ['LEGACY_PLANNER_OUTPUT'],
      },
      recommendedBuild: [{
        itemId: 103,
        position: 0,
        status: 'NEXT',
        score: 1,
        confidence: 1,
        skeletonStrength: 1,
        contextualSupport: 0,
        reasonCodes: [],
      }],
    });

    expect(plan).toHaveLength(1);
    expect(plan[0].action.type).toBe('UPGRADE');
    expect(plan[0].action.itemId).toBe(102);
    expect(plan[0].sourceItemIds).toEqual([101]);
    expect(plan[0].action.type).not.toBe('REPLACE');

    const firstCandidates = generateRecommendationCandidates({ state, itemGraph: graph, rules });
    const pointBlankUpgrade = firstCandidates.find((candidate) =>
      candidate.action.type === 'UPGRADE_ITEM' && candidate.action.itemId === 102,
    );
    expect(pointBlankUpgrade?.feasible).toBe(true);
    expect(pointBlankUpgrade?.recommendationEligible).toBe(true);
    expect(firstCandidates.some((candidate) =>
      candidate.action.type === 'REPLACE_ITEM' &&
      candidate.action.buyItemId === 102 &&
      candidate.recommendationEligible,
    )).toBe(false);

    const firstTransition = applyRecommendationCandidateTransitionV1(state, pointBlankUpgrade!, graph);
    expect([...firstTransition.state.inventory.heldByItemId.keys()].sort((a, b) => a - b))
      .toEqual([102, 104, 105, 106]);
    expect(firstTransition.consumedItemIds).toEqual([101]);
    expect(firstTransition.removedItemIds).toEqual([101]);

    const secondCandidates = generateRecommendationCandidates({
      state: firstTransition.state,
      itemGraph: graph,
      rules,
    });
    const escalatingUpgrade = secondCandidates.find((candidate) =>
      candidate.action.type === 'UPGRADE_ITEM' && candidate.action.itemId === 103,
    );
    expect(escalatingUpgrade?.feasible).toBe(true);
    expect(escalatingUpgrade?.recommendationEligible).toBe(true);
    expect(secondCandidates.some((candidate) =>
      candidate.action.type === 'SELL_ITEM' && candidate.action.itemId === 101,
    )).toBe(false);
    expect(secondCandidates.some((candidate) =>
      candidate.action.type === 'REPLACE_ITEM' &&
      candidate.action.buyItemId === 103 &&
      candidate.recommendationEligible,
    )).toBe(false);
  });
});