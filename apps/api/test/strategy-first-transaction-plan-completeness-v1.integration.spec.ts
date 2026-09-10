import {
  RecommendationItemDefinition,
  buildInventoryInstancesForRecommendation,
  createRecommendationItemGraph,
  observedFact,
} from '@deadlock-live-probe/build-domain';
import { AdaptiveDecisionStateV1 } from '../src/statlocker-adaptive/adaptive-decision-state-v1.service';
import { deriveAdaptiveSlotStateV1, unknownAdaptiveInvestmentStateV1 } from '../src/statlocker-adaptive/adaptive-economy-v1';
import { StrategyFirstBuildPlannerV1Service } from '../src/statlocker-adaptive/strategy-first-build-planner-v1.service';
import { StrategyFirstTransactionPlanV1Service } from '../src/statlocker-adaptive/strategy-first-transaction-plan-v1.service';
import { BuildStrategySpecV1 } from '../src/statlocker-adaptive/build-strategy-v1';

const catalogSha256 = 'e'.repeat(64);
const items: RecommendationItemDefinition[] = [
  {
    itemId: 1,
    name: 'Starter',
    slotType: 'weapon',
    active: false,
    availableRulesetIds: ['r1'],
    directPurchaseCost: 500,
    upgradeRecipes: [],
    sellTransition: { soulsRefund: 250, returnedItemIds: [] },
    maxCopies: 1,
  },
  {
    itemId: 2,
    name: 'Intermediate',
    slotType: 'weapon',
    active: false,
    availableRulesetIds: ['r1'],
    upgradeRecipes: [{ recipeId: 'upgrade-2', consumedItemIds: [1], soulsCost: 500 }],
    sellTransition: { soulsRefund: 500, returnedItemIds: [1] },
    maxCopies: 1,
  },
  {
    itemId: 3,
    name: 'Final Upgrade',
    slotType: 'weapon',
    active: false,
    availableRulesetIds: ['r1'],
    upgradeRecipes: [{ recipeId: 'upgrade-3', consumedItemIds: [2], soulsCost: 1000 }],
    sellTransition: { soulsRefund: 1000, returnedItemIds: [2] },
    maxCopies: 1,
  },
  ...[4, 5].map((itemId): RecommendationItemDefinition => ({
    itemId,
    name: `Core ${itemId}`,
    slotType: 'vitality',
    active: false,
    availableRulesetIds: ['r1'],
    directPurchaseCost: 500,
    upgradeRecipes: [],
    sellTransition: { soulsRefund: 250, returnedItemIds: [] },
    maxCopies: 1,
  })),
];
const graph = createRecommendationItemGraph(items);

function decision(): AdaptiveDecisionStateV1 {
  const heldByItemId = buildInventoryInstancesForRecommendation([1], graph);
  const slotRules = {
    baseSlots: 12,
    baseSlotsByType: { weapon: 4, vitality: 4, spirit: 4 } as const,
    maxFlexSlots: 4,
    maxActiveItems: 4,
    evidence: 'RECONSTRUCTED' as const,
  };
  return {
    state: {
      decisionId: 'd', matchId: 'm', playerSlot: 0, gameTimeSec: 1200, rulesetId: 'r1', heroId: 1,
      inventory: { initializedFromSnapshot: true, heldByItemId, lifecycleCountByItemId: new Map([[1, 1]]), nextInstanceSequence: 2 },
      economy: { spendableSouls: observedFact(10000, 'test'), shopOpportunity: observedFact('AVAILABLE', 'test') },
    },
    itemGraph: graph,
    catalogVersionId: 'c',
    catalogSha256,
    rulesetId: 'r1',
    localSteamId: 'p',
    allyHeroIds: [], enemyHeroIds: [], enemyLiveStates: [], allyItemIds: [], enemyItemIds: [],
    slots: deriveAdaptiveSlotStateV1([1], graph, slotRules, { unlockedFlexSlots: 0, evidence: 'OBSERVED' }),
    investment: unknownAdaptiveInvestmentStateV1(),
    economyRulesEvidence: 'UNKNOWN',
    stateRevision: 'revision',
  };
}

function strategy(): BuildStrategySpecV1 {
  const upgradeGoal = {
    goalId: 'upgrade',
    type: 'CORE' as const,
    phase: 'MID' as const,
    targetItemIds: [3],
    minSelect: 1,
    maxSelect: 1,
    prerequisiteGoalIds: [],
    hard: true,
    lifecycleByItemId: { 3: 'PERMANENT_CORE' as const },
    rationaleCodes: ['UPGRADE_CHAIN'],
  };
  const multiGoal = {
    goalId: 'multi',
    type: 'CORE' as const,
    phase: 'LATE' as const,
    targetItemIds: [4, 5],
    minSelect: 2,
    maxSelect: 2,
    prerequisiteGoalIds: ['upgrade'],
    hard: true,
    lifecycleByItemId: { 4: 'PERMANENT_CORE' as const, 5: 'PERMANENT_CORE' as const },
    rationaleCodes: ['MULTI_SELECT_CORE'],
  };
  return {
    schemaVersion: 1,
    strategyId: 'complete-path',
    heroId: 1,
    rulesetId: 'r1',
    sourcePatchId: 'p',
    support: 1,
    stability: 1,
    representativeTraceId: 'trace',
    goals: [upgradeGoal, multiGoal],
    branchGroups: [],
    situationalWindows: [],
    investmentPolicy: { objectives: [], preferredWeights: { weapon: 1, vitality: 1, spirit: 0 } },
    slotPolicy: { reservedSituationalSlots: 0, maxTemporarySlots: 0 },
    terminalPolicy: { requiredGoalIds: ['upgrade', 'multi'], allowWaiveSoftGoals: true },
  };
}

const scorer = {
  scoreItem(itemId: number) {
    return { itemId, score: 1, confidence: 0.9, completeness: 1, components: [], version: 'adaptive-evidence-scorer-v1' as const };
  },
} as any;
const evidence = {
  heroId: 1, rulesetVersion: 'r1', catalogSha256, statlockerPatchId: 'p', usable: true,
  snapshotIds: [], degradedReasons: [], families: [], byDataset: {},
} as any;

describe('strategy-first transaction plan completeness', () => {
  it('compiles every legal transaction required by a multi-step upgrade and minSelect > 1 goal', () => {
    const d = decision();
    const planner = new StrategyFirstBuildPlannerV1Service(scorer);
    const planned = planner.plan({ decision: d, evidence, strategies: [strategy()] });
    expect(planned.nextAction).toMatchObject({ type: 'UPGRADE', targetItemId: 2 });

    const result = new StrategyFirstTransactionPlanV1Service().apply({ result: planned, decision: d });
    expect(result.planSession.state).not.toBe('REPLAN_REQUIRED');
    expect(result.transactionPlanValidation.valid).toBe(true);
    expect(result.planSession.steps
      .filter((step) => step.kind === 'TRANSACTION')
      .map((step) => step.action))
      .toEqual([
        { type: 'UPGRADE', buyItemId: 2, consumedItemIds: [1], recipeId: 'upgrade-2' },
        { type: 'UPGRADE', buyItemId: 3, consumedItemIds: [2], recipeId: 'upgrade-3' },
        { type: 'BUY', buyItemId: 4 },
        { type: 'BUY', buyItemId: 5 },
      ]);
    expect(result.recommendedBuild.filter((row) => row.itemId === 4 || row.itemId === 5)).toHaveLength(2);
  });
});
