import {
  buildInventoryInstancesForRecommendation,
  createRecommendationItemGraph,
  generateRecommendationCandidates,
  observedFact,
  RecommendationCandidateGeneratorRules,
  RecommendationDecisionState,
  RecommendationItemDefinition,
} from '../src';

function item(itemId: number, slotType: RecommendationItemDefinition['slotType']): RecommendationItemDefinition {
  return {
    itemId,
    name: `Item ${itemId}`,
    slotType,
    active: false,
    availableRulesetIds: ['ruleset-current'],
    directPurchaseCost: 800,
    upgradeRecipes: [],
    sellTransition: { soulsRefund: 400, returnedItemIds: [] },
    maxCopies: 1,
  };
}

const definitions: RecommendationItemDefinition[] = [
  ...Array.from({ length: 13 }, (_, index) => item(index + 1, 'weapon')),
  item(20, 'vitality'),
  item(30, 'spirit'),
];

const graph = createRecommendationItemGraph(definitions);

function state(held: readonly number[]): RecommendationDecisionState {
  return {
    decisionId: 'flex-slot-test',
    matchId: 'match',
    playerSlot: 0,
    gameTimeSec: 100,
    rulesetId: 'ruleset-current',
    heroId: 1,
    inventory: {
      initializedFromSnapshot: true,
      heldByItemId: buildInventoryInstancesForRecommendation(held, graph),
      lifecycleCountByItemId: new Map(held.map((itemId) => [itemId, 1])),
      nextInstanceSequence: held.length + 1,
    },
    economy: {
      spendableSouls: observedFact(10_000, 'test'),
      shopOpportunity: observedFact('AVAILABLE', 'test'),
    },
  };
}

function rules(): RecommendationCandidateGeneratorRules {
  return {
    baseSlots: 0,
    baseSlotsByType: { weapon: 0, vitality: 0, spirit: 0 },
    maxFlexSlots: 12,
    unlockedFlexSlots: 12,
    flexCapacityEvidence: 'RECONSTRUCTED',
    maxActiveItems: 4,
    activeCapacityEvidence: 'RECONSTRUCTED',
    allowSellOnlyActions: true,
    generateTargetedWaitActions: true,
  };
}

describe('fully flexible recommendation slot rules', () => {
  it('allows twelve items of the same category', () => {
    const candidates = generateRecommendationCandidates({
      state: state([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]),
      itemGraph: graph,
      rules: rules(),
    });

    expect(candidates.find((candidate) => candidate.actionId === 'BUY_ITEM:12')?.feasible).toBe(true);
  });

  it('rejects a thirteenth held item regardless of category', () => {
    const candidates = generateRecommendationCandidates({
      state: state([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]),
      itemGraph: graph,
      rules: rules(),
    });

    const thirteenth = candidates.find((candidate) => candidate.actionId === 'BUY_ITEM:13');
    expect(thirteenth?.feasible).toBe(false);
    expect(thirteenth?.reasons).toContain('SLOT_LIMIT_EXCEEDED');
  });

  it('allows sell-and-buy replacement while inventory is twelve of twelve', () => {
    const candidates = generateRecommendationCandidates({
      state: state([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]),
      itemGraph: graph,
      rules: rules(),
    });

    const replacement = candidates.find((candidate) => candidate.actionId === 'REPLACE_ITEM:1->13');
    expect(replacement?.feasible).toBe(true);
    expect(replacement?.resultingItemIds).toHaveLength(12);
  });

  it('does not reserve capacity by weapon vitality or spirit category', () => {
    const candidates = generateRecommendationCandidates({
      state: state([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 20]),
      itemGraph: graph,
      rules: rules(),
    });

    expect(candidates.find((candidate) => candidate.actionId === 'BUY_ITEM:30')?.feasible).toBe(true);
  });
});
