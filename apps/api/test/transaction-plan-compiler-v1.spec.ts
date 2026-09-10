import {
  RecommendationItemDefinition,
  buildInventoryInstancesForRecommendation,
  createRecommendationItemGraph,
  generateRecommendationCandidates,
  observedFact,
  unknownFact,
} from '@deadlock-live-probe/build-domain';
import { AdaptiveDecisionStateV1 } from '../src/statlocker-adaptive/adaptive-decision-state-v1.service';
import { candidateGeneratorRulesFromSlotStateV1, deriveAdaptiveSlotStateV1, unknownAdaptiveInvestmentStateV1 } from '../src/statlocker-adaptive/adaptive-economy-v1';
import { BuildContractV1, BuildSlotPlanV1, BuildStrategySpecV1 } from '../src/statlocker-adaptive/build-strategy-v1';
import { TransactionPlanCompilerV1Service } from '../src/statlocker-adaptive/transaction-plan-compiler-v1.service';

const catalogSha256 = 'c'.repeat(64);
const items: RecommendationItemDefinition[] = [
  {
    itemId: 101, name: 'Component', slotType: 'weapon', active: false, availableRulesetIds: ['r1'],
    directPurchaseCost: 500, upgradeRecipes: [], sellTransition: { soulsRefund: 250, returnedItemIds: [] }, maxCopies: 1,
  },
  {
    itemId: 202, name: 'Target', slotType: 'weapon', active: false, availableRulesetIds: ['r1'],
    directPurchaseCost: 1200,
    upgradeRecipes: [{ recipeId: 'upgrade-202', consumedItemIds: [101], soulsCost: 700 }],
    sellTransition: { soulsRefund: 600, returnedItemIds: [] }, maxCopies: 1,
  },
  ...[102, 103, 104, 105].map((itemId): RecommendationItemDefinition => ({
    itemId, name: `Core ${itemId}`, slotType: 'weapon', active: false, availableRulesetIds: ['r1'],
    directPurchaseCost: 500, upgradeRecipes: [],
    sellTransition: itemId === 102 ? { soulsRefund: 250, returnedItemIds: [] } : undefined,
    maxCopies: 1,
  })),
];
const graph = createRecommendationItemGraph(items);
const slotRules = { baseSlots: 12, baseSlotsByType: { weapon: 4, vitality: 4, spirit: 4 } as const, maxFlexSlots: 4, maxActiveItems: 4 };

function decision(
  ownedItemIds: readonly number[],
  souls: number | undefined,
  unlockedFlexSlots: number | 'UNKNOWN' = 0,
  shop: 'AVAILABLE' | 'UNAVAILABLE' = 'AVAILABLE',
): AdaptiveDecisionStateV1 {
  const held = buildInventoryInstancesForRecommendation(ownedItemIds, graph);
  const evidence = unlockedFlexSlots === 'UNKNOWN' ? 'UNKNOWN' as const : 'OBSERVED' as const;
  return {
    state: {
      decisionId: 'd', matchId: 'm', playerSlot: 0, gameTimeSec: 1000, rulesetId: 'r1', heroId: 1,
      inventory: {
        initializedFromSnapshot: true,
        heldByItemId: held,
        lifecycleCountByItemId: new Map(ownedItemIds.map((itemId) => [itemId, 1])),
        nextInstanceSequence: held.size + 1,
      },
      economy: {
        spendableSouls: souls === undefined ? unknownFact('test') : observedFact(souls, 'test'),
        shopOpportunity: observedFact(shop, 'test'),
      },
    },
    itemGraph: graph,
    catalogVersionId: 'catalog', catalogSha256, rulesetId: 'r1', localSteamId: 'p',
    allyHeroIds: [], enemyHeroIds: [], enemyLiveStates: [], allyItemIds: [], enemyItemIds: [],
    slots: deriveAdaptiveSlotStateV1(ownedItemIds, graph, slotRules, {
      unlockedFlexSlots: unlockedFlexSlots === 'UNKNOWN' ? undefined : unlockedFlexSlots,
      evidence,
    }),
    investment: unknownAdaptiveInvestmentStateV1(), economyRulesEvidence: 'UNKNOWN', stateRevision: 'revision',
  };
}

function strategy(
  lifecycle: 'PERMANENT_CORE' | 'REPLACEMENT_TARGET' = 'PERMANENT_CORE',
  includeTemporarySource = true,
): BuildStrategySpecV1 {
  return {
    schemaVersion: 1, strategyId: 's', heroId: 1, rulesetId: 'r1', sourcePatchId: 'p', support: 1, stability: 1,
    representativeTraceId: 'trace',
    goals: [
      ...(includeTemporarySource ? [{
        goalId: 'temporary-source', type: 'CORE' as const, phase: 'EARLY' as const,
        targetItemIds: [102], minSelect: 0, maxSelect: 1, prerequisiteGoalIds: [], hard: false,
        lifecycleByItemId: { 102: 'TEMPORARY_EARLY' as const }, rationaleCodes: ['TEMPORARY'],
      }] : []),
      {
        goalId: 'target', type: 'CORE', phase: 'LATE', targetItemIds: [202], minSelect: 1, maxSelect: 1,
        prerequisiteGoalIds: [], hard: true, lifecycleByItemId: { 202: lifecycle }, rationaleCodes: ['CORE'],
      },
    ],
    branchGroups: [], situationalWindows: [],
    investmentPolicy: { objectives: [], preferredWeights: { weapon: 1, vitality: 0, spirit: 0 } },
    slotPolicy: { reservedSituationalSlots: 0, maxTemporarySlots: 1 },
    terminalPolicy: { requiredGoalIds: ['target'], allowWaiveSoftGoals: true },
  };
}

function contract(temporaryItemIds: readonly number[] = []): BuildContractV1 {
  return {
    strategyId: 's', status: 'IN_PROGRESS', commitment: 'COMMITTED', currentGoalId: 'target',
    goalStates: { target: 'ACTIVE' }, selectedBranches: {}, committedBranches: {}, temporaryItemIds,
    reservedSituationalWindowIds: [], remainingHardGoalIds: ['target'], completionReasonCodes: [],
  };
}

function slotPlan(requirement: BuildSlotPlanV1['futureTransitions'][number]['requirement'], sourceItemId?: number, requiredUnlockedFlexSlots?: number): BuildSlotPlanV1 {
  return {
    currentUsedSlots: 4, currentFlexUsed: 0, unlockedFlexSlots: 0, reservedSituationalSlots: 0, feasible: requirement !== 'BLOCKED',
    reasonCodes: [],
    futureTransitions: [{
      targetGoalId: 'target', targetItemId: 202, requirement, sourceItemId, requiredUnlockedFlexSlots, reasonCodes: [],
    }],
  };
}

function candidatesFor(value: AdaptiveDecisionStateV1) {
  return generateRecommendationCandidates({
    state: value.state,
    itemGraph: graph,
    rules: candidateGeneratorRulesFromSlotStateV1(value.slots),
  });
}

describe('transaction plan compiler v1', () => {
  const compiler = new TransactionPlanCompilerV1Service();

  it('maps BUY_ITEM to BUY', () => {
    const d = decision([], 5000);
    const buy = candidatesFor(d).find((candidate) => candidate.action.type === 'BUY_ITEM' && candidate.action.itemId === 202)!;
    const result = compiler.compile({ strategy: strategy(), contract: contract(), slotPlan: slotPlan('NONE'), decision: d, selectedCandidates: [buy] });
    expect(result.reachable).toBe(true);
    expect(result.steps[0]).toMatchObject({ kind: 'TRANSACTION', action: { type: 'BUY', buyItemId: 202 } });
  });

  it('maps UPGRADE_ITEM to UPGRADE with consumed components', () => {
    const d = decision([101], 5000);
    const upgrade = candidatesFor(d).find((candidate) => candidate.action.type === 'UPGRADE_ITEM' && candidate.action.itemId === 202)!;
    const result = compiler.compile({ strategy: strategy(), contract: contract(), slotPlan: slotPlan('UPGRADE', 101), decision: d, selectedCandidates: [upgrade] });
    expect(result.steps[0]).toMatchObject({
      kind: 'TRANSACTION',
      action: { type: 'UPGRADE', buyItemId: 202, consumedItemIds: [101], recipeId: 'upgrade-202' },
    });
  });

  it('maps REPLACE_ITEM to one SELL_AND_BUY step and preserves both ids', () => {
    const d = decision([102, 103, 104, 105], 5000);
    const replace = candidatesFor(d).find((candidate) =>
      candidate.action.type === 'REPLACE_ITEM' && candidate.action.sellItemId === 102 && candidate.action.buyItemId === 202,
    )!;
    const result = compiler.compile({ strategy: strategy('REPLACEMENT_TARGET'), contract: contract([102]), slotPlan: slotPlan('SELL_TEMPORARY', 102), decision: d, selectedCandidates: [replace] });
    expect(result.steps[0]).toMatchObject({
      kind: 'TRANSACTION',
      action: { type: 'SELL_AND_BUY', sellItemId: 102, buyItemId: 202 },
    });
  });

  it('ignores a selected naked SELL_ITEM and compiles the slot exit as SELL_AND_BUY instead', () => {
    const d = decision([102, 103, 104, 105], 5000);
    const sell = candidatesFor(d).find((candidate) => candidate.action.type === 'SELL_ITEM' && candidate.action.itemId === 102)!;
    const result = compiler.compile({ strategy: strategy(), contract: contract([102]), slotPlan: slotPlan('SELL_TEMPORARY', 102), decision: d, selectedCandidates: [sell] });
    expect(result.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'TRANSACTION',
        action: { type: 'SELL_AND_BUY', sellItemId: 102, buyItemId: 202 },
      }),
    ]));
    expect(result.steps.some((step) => step.reasonCodes.some((code) => code.includes('SELL_ITEM:102')))).toBe(false);
  });

  it('creates WAIT_FOR_GOLD and a locked transaction when exact funds are insufficient', () => {
    // Souls stay below the component price too, so no ancestor transaction is executable yet
    // and the only reachable path is the barrier followed by the direct purchase.
    const d = decision([], 300);
    const result = compiler.compile({ strategy: strategy(), contract: contract(), slotPlan: slotPlan('NONE'), decision: d, selectedCandidates: [] });
    expect(result.reachable).toBe(true);
    expect(result.steps[0]).toMatchObject({ kind: 'BARRIER', barrier: { type: 'WAIT_FOR_GOLD', targetItemId: 202, requiredSouls: 1200 } });
    expect(result.steps[1]).toMatchObject({ kind: 'TRANSACTION', action: { type: 'BUY', buyItemId: 202 } });
  });

  it('buys the affordable upgrade component now and defers the rest behind WAIT_FOR_GOLD', () => {
    const d = decision([], 500);
    const result = compiler.compile({ strategy: strategy(), contract: contract(), slotPlan: slotPlan('NONE'), decision: d, selectedCandidates: [] });
    expect(result.reachable).toBe(true);
    expect(result.steps[0]).toMatchObject({ kind: 'TRANSACTION', action: { type: 'BUY', buyItemId: 101 } });
    expect(result.steps[1]).toMatchObject({ kind: 'BARRIER', barrier: { type: 'WAIT_FOR_GOLD', targetItemId: 202, requiredSouls: 700 } });
    expect(result.steps[2]).toMatchObject({ kind: 'TRANSACTION', action: { type: 'UPGRADE', buyItemId: 202, consumedItemIds: [101], recipeId: 'upgrade-202' } });
  });

  it('uses post-refund required souls for an unaffordable replacement', () => {
    // The component is priced so high that replacing the temporary item with it stays
    // unaffordable after the refund, forcing the direct replacement barrier math.
    const expensiveComponent: RecommendationItemDefinition = {
      ...items[0],
      directPurchaseCost: 1000,
    };
    const expensiveGraph = createRecommendationItemGraph([expensiveComponent, ...items.slice(1)]);
    const ownedItemIds = [102, 103, 104, 105];
    const held = buildInventoryInstancesForRecommendation(ownedItemIds, expensiveGraph);
    const expensiveDecision: AdaptiveDecisionStateV1 = {
      ...decision(ownedItemIds, 500),
      itemGraph: expensiveGraph,
      state: {
        ...decision(ownedItemIds, 500).state,
        inventory: {
          ...decision(ownedItemIds, 500).state.inventory,
          heldByItemId: held,
          nextInstanceSequence: held.size + 1,
        },
      },
      slots: deriveAdaptiveSlotStateV1(ownedItemIds, expensiveGraph, slotRules, {
        unlockedFlexSlots: 0,
        evidence: 'OBSERVED',
      }),
    };
    const result = compiler.compile({ strategy: strategy('REPLACEMENT_TARGET'), contract: contract([102]), slotPlan: slotPlan('SELL_TEMPORARY', 102), decision: expensiveDecision, selectedCandidates: [] });
    expect(result.reachable).toBe(true);
    expect(result.steps[0]).toMatchObject({ kind: 'BARRIER', barrier: { type: 'WAIT_FOR_GOLD', targetItemId: 202, requiredSouls: 950 } });
    expect(result.steps[1]).toMatchObject({ kind: 'TRANSACTION', action: { type: 'SELL_AND_BUY', sellItemId: 102, buyItemId: 202 } });
  });

  it('creates WAIT_FOR_SHOP only when shop unavailability is known', () => {
    const d = decision([], 5000, 0, 'UNAVAILABLE');
    const result = compiler.compile({ strategy: strategy(), contract: contract(), slotPlan: slotPlan('NONE'), decision: d, selectedCandidates: [] });
    expect(result.steps[0]).toMatchObject({ kind: 'BARRIER', barrier: { type: 'WAIT_FOR_SHOP', targetItemId: 202 } });
  });

  it('creates WAIT_FOR_FLEX for a known future flex threshold', () => {
    const d = decision([102, 103, 104, 105], 5000, 0);
    const result = compiler.compile({ strategy: strategy('PERMANENT_CORE', false), contract: contract(), slotPlan: slotPlan('FLEX_UNLOCK', undefined, 1), decision: d, selectedCandidates: [] });
    expect(result.steps[0]).toMatchObject({ kind: 'BARRIER', barrier: { type: 'WAIT_FOR_FLEX', targetItemId: 202, requiredUnlockedFlexSlots: 1 } });
  });

  it('creates WAIT_FOR_GOLD barrier for unknown wallet, and creates WAIT_FOR_FLEX barrier for flex unlocks', () => {
    const unknownWallet = decision([], undefined, 0);
    const walletResult = compiler.compile({ strategy: strategy(), contract: contract(), slotPlan: slotPlan('NONE'), decision: unknownWallet, selectedCandidates: [] });
    expect(walletResult.reachable).toBe(true);
    expect(walletResult.steps[0]).toMatchObject({ kind: 'BARRIER', barrier: { type: 'WAIT_FOR_GOLD', targetItemId: 202 } });

    const unknownFlex = decision([102, 103, 104, 105], 5000, 'UNKNOWN');
    const flexResult = compiler.compile({
      strategy: strategy('PERMANENT_CORE', false), contract: contract(),
      slotPlan: { ...slotPlan('FLEX_UNLOCK', undefined, 1), unlockedFlexSlots: undefined },
      decision: unknownFlex, selectedCandidates: [],
    });
    expect(flexResult.reachable).toBe(true);
    expect(flexResult.steps.some((step) => step.barrier?.type === 'WAIT_FOR_FLEX')).toBe(true);
  });
});
