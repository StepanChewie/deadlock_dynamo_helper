import {
  buildInventoryInstancesForRecommendation,
  createRecommendationItemGraph,
  generateRecommendationCandidates,
  observedFact,
} from '@deadlock-live-probe/build-domain';
import {
  deriveAdaptiveInvestmentStateV1,
  deriveAdaptiveSlotStateV1,
} from '../src/statlocker-adaptive/adaptive-economy-v1';
import {
  buildAdaptivePlanActionsV1,
  stablePlanActionId,
} from '../src/statlocker-adaptive/adaptive-plan-action-v1';

function item(
  itemId: number,
  options: { upgradeFrom?: number; cost?: number; slotType?: 'weapon' | 'vitality' | 'spirit' } = {},
) {
  return {
    itemId,
    name: `Item ${itemId}`,
    slotType: options.slotType ?? 'weapon',
    active: false,
    availableRulesetIds: ['ruleset-a'],
    ...(options.upgradeFrom === undefined ? { directPurchaseCost: options.cost ?? 500 } : {}),
    upgradeRecipes: options.upgradeFrom === undefined
      ? []
      : [{
          recipeId: `upgrade:${itemId}`,
          consumedItemIds: [options.upgradeFrom],
          soulsCost: options.cost ?? 500,
        }],
    sellTransition: { soulsRefund: 250, returnedItemIds: [] as number[] },
    maxCopies: 1,
  };
}

const slotRules = {
  baseSlotsByType: { weapon: 4, vitality: 4, spirit: 4 },
  maxFlexSlots: 3,
  maxActiveItems: 4,
  evidence: 'RECONSTRUCTED' as const,
};

function decision(
  graph: ReturnType<typeof createRecommendationItemGraph>,
  ownedItemIds: number[],
  options: { souls?: number; unlockedFlexSlots?: number; flexEvidence?: 'OBSERVED' | 'UNKNOWN' } = {},
) {
  const heldByItemId = buildInventoryInstancesForRecommendation(ownedItemIds, graph);
  const state: any = {
    decisionId: 'decision-a',
    matchId: 'match-a',
    playerSlot: 0,
    gameTimeSec: 600,
    rulesetId: 'ruleset-a',
    heroId: 10,
    inventory: {
      initializedFromSnapshot: true,
      heldByItemId,
      lifecycleCountByItemId: new Map<number, number>(ownedItemIds.map((itemId): [number, number] => [itemId, 1])),
      nextInstanceSequence: heldByItemId.size + 1,
    },
    economy: {
      spendableSouls: observedFact(options.souls ?? 5000, 'test'),
      shopOpportunity: observedFact('AVAILABLE', 'test'),
    },
  };
  const flexEvidence = options.flexEvidence ?? 'OBSERVED';
  const capacity = flexEvidence === 'UNKNOWN'
    ? { evidence: 'UNKNOWN' as const }
    : { unlockedFlexSlots: options.unlockedFlexSlots ?? 0, evidence: 'OBSERVED' as const };
  return {
    state,
    itemGraph: graph,
    catalogVersionId: 'catalog-a',
    catalogSha256: 'a'.repeat(64),
    rulesetId: 'ruleset-a',
    localSteamId: 'steam-a',
    enemyHeroIds: [],
    enemyLiveStates: [],
    enemyHeroes: [],
    slots: deriveAdaptiveSlotStateV1(ownedItemIds, graph, slotRules, capacity),
    investment: deriveAdaptiveInvestmentStateV1(ownedItemIds, graph, undefined),
    economyRulesEvidence: 'UNKNOWN' as const,
    stateRevision: 'revision-a',
  };
}

function planned(itemId: number, position = 0) {
  return {
    itemId,
    position,
    status: 'NEXT' as const,
    score: 1,
    confidence: 1,
    skeletonStrength: 1,
    contextualSupport: 0,
    reasonCodes: [] as string[],
  };
}

describe('buildAdaptivePlanActionsV1', () => {
  it('compiles the next executable step of a multi-step upgrade and keeps a stable semantic id', () => {
    const graph = createRecommendationItemGraph([
      item(1),
      item(2, { upgradeFrom: 1 }),
      item(3, { upgradeFrom: 2 }),
      item(4),
      item(5),
      item(6),
    ]);
    const current = decision(graph, [1, 4, 5, 6], { souls: 5000 });
    const input = {
      stateRevision: 'revision-a',
      decision: current,
      nextAction: { actionKey: 'HOLD:test', type: 'HOLD' as const, reasonCodes: ['PLAN'] },
      recommendedBuild: [planned(3)],
    };

    const first = buildAdaptivePlanActionsV1(input);
    const second = buildAdaptivePlanActionsV1(input);

    expect(first).toHaveLength(1);
    expect(first[0].status).toBe('READY');
    expect(first[0].action.type).toBe('UPGRADE');
    expect(first[0].action.itemId).toBe(2);
    expect(first[0].targetItemId).toBe(2);
    expect(first[0].sourceItemIds).toEqual([1]);
    expect(first[0].requirements).toContainEqual({ type: 'UPGRADE_COMPONENT', itemIds: [1] });
    expect(first[0].reasonCodes).toContain('MULTI_STEP_UPGRADE_PATH');
    expect(first[0].planActionId).toBe(stablePlanActionId('revision-a', 1, first[0].action.actionKey));
    expect(second[0].planActionId).toBe(first[0].planActionId);
  });

  it('renders soul and component barriers for an unaffordable upgrade without changing transaction semantics', () => {
    const graph = createRecommendationItemGraph([item(1), item(2, { upgradeFrom: 1, cost: 1000 })]);
    const current = decision(graph, [1], { souls: 100 });
    const actions = buildAdaptivePlanActionsV1({
      stateRevision: 'revision-b',
      decision: current,
      nextAction: { actionKey: 'WAIT:2', type: 'WAIT', targetItemId: 2, reasonCodes: ['UNAFFORDABLE'] },
      recommendedBuild: [planned(2)],
    });

    expect(actions).toHaveLength(1);
    expect(actions[0].status).toBe('BLOCKED');
    expect(actions[0].action.type).toBe('UPGRADE');
    expect(actions[0].requirements).toContainEqual({ type: 'UPGRADE_COMPONENT', itemIds: [1] });
    expect(actions[0].requirements).toContainEqual({
      type: 'SOULS',
      requiredSouls: 1000,
      currentSouls: 100,
      shortfallSouls: 900,
      evidence: 'OBSERVED',
    });
  });

  it('renders a flex barrier when an additional category slot cannot be proven unlocked', () => {
    const graph = createRecommendationItemGraph([item(1), item(2), item(3), item(4), item(7)]);
    const current = decision(graph, [1, 2, 3, 4], {
      souls: 5000,
      flexEvidence: 'UNKNOWN',
    });
    const actions = buildAdaptivePlanActionsV1({
      stateRevision: 'revision-c',
      decision: current,
      nextAction: { actionKey: 'WAIT:7', type: 'WAIT', targetItemId: 7, reasonCodes: ['FLEX_SLOT_CAPACITY_UNKNOWN'] },
      recommendedBuild: [planned(7)],
    });

    expect(actions).toHaveLength(1);
    expect(actions[0].status).toBe('BLOCKED');
    expect(actions[0].requirements).toContainEqual({
      type: 'FLEX_SLOT',
      requiredFlexSlots: 1,
      unlockedFlexSlots: undefined,
      evidence: 'UNKNOWN',
    });
  });

  it('keeps the required sell nested inside a replacement semantic action', () => {
    const graph = createRecommendationItemGraph([item(1), item(2), item(3), item(4), item(7, { cost: 1000 })]);
    const current = decision(graph, [1, 2, 3, 4], {
      souls: 1000,
      unlockedFlexSlots: 0,
    });
    const rules = {
      baseSlotsByType: current.slots.baseSlotsByType,
      maxFlexSlots: current.slots.maxFlexSlots,
      unlockedFlexSlots: current.slots.unlockedFlexSlots,
      flexCapacityEvidence: current.slots.flexEvidence,
      maxActiveItems: current.slots.maxActiveItems,
      activeCapacityEvidence: current.slots.mechanicsEvidence,
      allowSellOnlyActions: true,
      generateTargetedWaitActions: true,
    };
    const replacement = generateRecommendationCandidates({ state: current.state, itemGraph: graph, rules })
      .find((candidate) =>
        candidate.action.type === 'REPLACE_ITEM' &&
        candidate.action.sellItemId === 4 &&
        candidate.action.buyItemId === 7 &&
        candidate.feasible &&
        candidate.recommendationEligible,
      );
    expect(replacement).toBeDefined();

    const actions = buildAdaptivePlanActionsV1({
      stateRevision: 'revision-d',
      decision: current,
      nextAction: {
        actionKey: replacement!.actionId,
        type: 'REPLACE',
        sellItemId: 4,
        buyItemId: 7,
        targetItemId: 7,
        reasonCodes: ['SLOT_PRESSURE'],
      },
      recommendedBuild: [planned(7)],
    });

    expect(actions).toHaveLength(1);
    expect(actions[0].action.type).toBe('REPLACE');
    expect(actions[0].requirements).toContainEqual({ type: 'SELL_ITEM', itemId: 4 });
    expect(actions[0].sourceItemIds).toEqual([4]);
  });
});