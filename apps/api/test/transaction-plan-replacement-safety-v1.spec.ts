import {
  RecommendationItemDefinition,
  buildInventoryInstancesForRecommendation,
  createRecommendationItemGraph,
  observedFact,
} from '@deadlock-live-probe/build-domain';
import { AdaptiveDecisionStateV1 } from '../src/statlocker-adaptive/adaptive-decision-state-v1.service';
import { deriveAdaptiveSlotStateV1, unknownAdaptiveInvestmentStateV1 } from '../src/statlocker-adaptive/adaptive-economy-v1';
import { BuildContractV1, BuildStrategySpecV1 } from '../src/statlocker-adaptive/build-strategy-v1';
import { BuildSlotPlannerV1Service } from '../src/statlocker-adaptive/build-slot-planner-v1.service';
import { TransactionPlanCompilerV1Service } from '../src/statlocker-adaptive/transaction-plan-compiler-v1.service';

const slotRules = {
  baseSlots: 12,
  baseSlotsByType: { weapon: 4, vitality: 4, spirit: 4 } as const,
  maxFlexSlots: 0,
  maxActiveItems: 4,
};

function graph(withSellTransition: boolean) {
  const items: RecommendationItemDefinition[] = [
    {
      itemId: 1, name: 'Replaceable evidence', slotType: 'weapon', active: false, availableRulesetIds: ['r1'],
      directPurchaseCost: 500, upgradeRecipes: [],
      sellTransition: withSellTransition ? { soulsRefund: 250, returnedItemIds: [] } : undefined,
      maxCopies: 1,
    },
    ...[2, 3, 4].map((itemId): RecommendationItemDefinition => ({
      itemId, name: `Core ${itemId}`, slotType: 'weapon', active: false, availableRulesetIds: ['r1'],
      directPurchaseCost: 500, upgradeRecipes: [], sellTransition: { soulsRefund: 250, returnedItemIds: [] }, maxCopies: 1,
    })),
    {
      itemId: 9, name: 'Target', slotType: 'weapon', active: false, availableRulesetIds: ['r1'],
      directPurchaseCost: 1200, upgradeRecipes: [], maxCopies: 1,
    },
  ];
  return createRecommendationItemGraph(items);
}

function decision(itemGraph: ReturnType<typeof graph>): AdaptiveDecisionStateV1 {
  const owned = [1, 2, 3, 4];
  const held = buildInventoryInstancesForRecommendation(owned, itemGraph);
  return {
    state: {
      decisionId: 'd', matchId: 'm', playerSlot: 0, gameTimeSec: 1500, rulesetId: 'r1', heroId: 1,
      inventory: {
        initializedFromSnapshot: true,
        heldByItemId: held,
        lifecycleCountByItemId: new Map(owned.map((itemId) => [itemId, 1])),
        nextInstanceSequence: held.size + 1,
      },
      economy: {
        spendableSouls: observedFact(5000, 'test'),
        shopOpportunity: observedFact('AVAILABLE', 'test'),
      },
    },
    itemGraph,
    catalogVersionId: 'c', catalogSha256: '9'.repeat(64), rulesetId: 'r1', localSteamId: 'p',
    allyHeroIds: [], enemyHeroIds: [], enemyLiveStates: [], allyItemIds: [], enemyItemIds: [],
    slots: deriveAdaptiveSlotStateV1(owned, itemGraph, slotRules, { unlockedFlexSlots: 0, evidence: 'OBSERVED' }),
    investment: unknownAdaptiveInvestmentStateV1(), economyRulesEvidence: 'UNKNOWN', stateRevision: 'r',
  };
}

function goal(goalId: string, itemId: number, hard: boolean, type: 'CORE' | 'BRANCH' = 'CORE') {
  return {
    goalId,
    type,
    phase: 'MID' as const,
    targetItemIds: [itemId],
    minSelect: 1,
    maxSelect: 1,
    prerequisiteGoalIds: [],
    hard,
    lifecycleByItemId: { [itemId]: hard ? 'PERMANENT_CORE' as const : 'SITUATIONAL' as const },
    rationaleCodes: ['TEST'],
  };
}

function strategy(committedBranch = false): BuildStrategySpecV1 {
  const goals: BuildStrategySpecV1['goals'] = [
    goal('core-2', 2, true), goal('core-3', 3, true), goal('core-4', 4, true),
    goal('evidence-1', 1, false, committedBranch ? 'BRANCH' : 'CORE'),
    { ...goal('target-9', 9, true), phase: 'LATE' as const, lifecycleByItemId: { 9: 'REPLACEMENT_TARGET' as const } },
  ];
  return {
    schemaVersion: 1,
    strategyId: committedBranch ? 'committed-branch' : 'replacement-safety',
    heroId: 1,
    rulesetId: 'r1',
    sourcePatchId: 'p',
    support: 1,
    stability: 1,
    representativeTraceId: 't',
    goals,
    branchGroups: committedBranch
      ? [{ branchGroupId: 'choice', optionGoalIds: ['evidence-1'], minSelect: 1, maxSelect: 1 }]
      : [],
    situationalWindows: [],
    investmentPolicy: { objectives: [], preferredWeights: { weapon: 1, vitality: 0, spirit: 0 } },
    slotPolicy: { reservedSituationalSlots: 0, maxTemporarySlots: 0 },
    terminalPolicy: { requiredGoalIds: ['core-2', 'core-3', 'core-4', 'target-9'], allowWaiveSoftGoals: true },
  };
}

function contract(spec: BuildStrategySpecV1, committedBranch = false): BuildContractV1 {
  return {
    strategyId: spec.strategyId,
    status: 'IN_PROGRESS',
    commitment: 'COMMITTED',
    currentGoalId: 'target-9',
    goalStates: {
      'core-2': 'SATISFIED', 'core-3': 'SATISFIED', 'core-4': 'SATISFIED',
      'evidence-1': 'SATISFIED', 'target-9': 'ACTIVE',
    },
    selectedBranches: committedBranch ? { choice: 'evidence-1' } : {},
    committedBranches: committedBranch ? { choice: 'evidence-1' } : {},
    temporaryItemIds: [],
    reservedSituationalWindowIds: [],
    remainingHardGoalIds: ['target-9'],
    completionReasonCodes: [],
  };
}

function compile(input: {
  withSellTransition: boolean;
  committedBranch?: boolean;
  recentPurchasedItemIds?: readonly number[];
}) {
  const itemGraph = graph(input.withSellTransition);
  const d = decision(itemGraph);
  const spec = strategy(input.committedBranch ?? false);
  const buildContract = contract(spec, input.committedBranch ?? false);
  const slotPlan = new BuildSlotPlannerV1Service().plan({
    strategy: spec,
    contract: buildContract,
    itemGraph,
    ownedItemIds: [1, 2, 3, 4],
    slots: d.slots,
  });
  return new TransactionPlanCompilerV1Service().compile({
    strategy: spec,
    contract: buildContract,
    slotPlan,
    decision: d,
    selectedCandidates: [],
    recentPurchasedItemIds: input.recentPurchasedItemIds,
  });
}

describe('transaction plan replacement safety v1', () => {
  it('does not replace an item whose sell transition is unknown', () => {
    const result = compile({ withSellTransition: false });
    expect(result.reachable).toBe(false);
    expect(result.steps.some((step) => step.action?.type === 'SELL_AND_BUY')).toBe(false);
  });

  it('does not sell committed branch evidence for an unrelated target', () => {
    const result = compile({ withSellTransition: true, committedBranch: true });
    expect(result.reachable).toBe(false);
    expect(result.steps.some((step) =>
      step.action?.type === 'SELL_AND_BUY' && step.action.sellItemId === 1,
    )).toBe(false);
  });

  it('does not immediately churn a recently purchased replacement source', () => {
    const result = compile({ withSellTransition: true, recentPurchasedItemIds: [1] });
    expect(result.reachable).toBe(false);
    expect(result.steps.some((step) =>
      step.action?.type === 'SELL_AND_BUY' && step.action.sellItemId === 1,
    )).toBe(false);
  });
});
