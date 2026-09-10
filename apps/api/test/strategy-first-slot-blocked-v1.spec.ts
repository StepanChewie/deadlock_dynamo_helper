import {
  buildInventoryInstancesForRecommendation,
  createRecommendationItemGraph,
  observedFact,
} from '@deadlock-live-probe/build-domain';
import { deriveAdaptiveSlotStateV1, unknownAdaptiveInvestmentStateV1 } from '../src/statlocker-adaptive/adaptive-economy-v1';
import { StrategyFirstBuildPlannerV1Service } from '../src/statlocker-adaptive/strategy-first-build-planner-v1.service';
import { BuildStrategySpecV1 } from '../src/statlocker-adaptive/build-strategy-v1';

const graph = createRecommendationItemGraph([1, 2, 3, 4, 5].map((itemId) => ({
  itemId,
  name: `Weapon ${itemId}`,
  slotType: 'weapon' as const,
  active: false,
  availableRulesetIds: ['r1'],
  directPurchaseCost: 800,
  upgradeRecipes: [],
  sellTransition: { soulsRefund: 400, returnedItemIds: [] },
})));

const owned = [1, 2, 3, 4];
const noFlexRules = {
  baseSlots: 12,
  baseSlotsByType: { weapon: 4, vitality: 4, spirit: 4 } as const,
  maxFlexSlots: 0,
  maxActiveItems: 4,
};
const held = buildInventoryInstancesForRecommendation(owned, graph);
const decision: any = {
  state: {
    decisionId: 'd', matchId: 'm', playerSlot: 0, gameTimeSec: 1000, rulesetId: 'r1', heroId: 1,
    inventory: { initializedFromSnapshot: true, heldByItemId: held, lifecycleCountByItemId: new Map(owned.map((id) => [id, 1])), nextInstanceSequence: 5 },
    economy: { spendableSouls: observedFact(10000, 'test'), shopOpportunity: observedFact('AVAILABLE', 'test') },
  },
  itemGraph: graph,
  catalogVersionId: 'c', catalogSha256: 'a'.repeat(64), rulesetId: 'r1', localSteamId: 'steam',
  allyHeroIds: [], enemyHeroIds: [], enemyLiveStates: [], allyItemIds: [], enemyItemIds: [],
  slots: deriveAdaptiveSlotStateV1(owned, graph, noFlexRules, { unlockedFlexSlots: 0, evidence: 'OBSERVED' }),
  investment: unknownAdaptiveInvestmentStateV1(), economyRulesEvidence: 'UNKNOWN', stateRevision: 'revision-test',
};

const goals = [1, 2, 3, 4].map((itemId) => ({
  goalId: `owned-${itemId}`, type: 'CORE' as const, phase: 'EARLY' as const,
  targetItemIds: [itemId], minSelect: 1, maxSelect: 1, prerequisiteGoalIds: [], hard: true,
  lifecycleByItemId: { [itemId]: 'PERMANENT_CORE' as const }, rationaleCodes: ['CORE'],
}));
const target = {
  goalId: 'target-5', type: 'CORE' as const, phase: 'MID' as const,
  targetItemIds: [5], minSelect: 1, maxSelect: 1, prerequisiteGoalIds: goals.map((goal) => goal.goalId), hard: true,
  lifecycleByItemId: { 5: 'PERMANENT_CORE' as const }, rationaleCodes: ['CORE'],
};
const strategy: BuildStrategySpecV1 = {
  schemaVersion: 1, strategyId: 'full-weapon', heroId: 1, rulesetId: 'r1', sourcePatchId: 'p', support: 1, stability: 1,
  representativeTraceId: 'trace', goals: [...goals, target], branchGroups: [], situationalWindows: [],
  investmentPolicy: { objectives: [], preferredWeights: { weapon: 1, vitality: 0, spirit: 0 } },
  slotPolicy: { reservedSituationalSlots: 0, maxTemporarySlots: 0 },
  terminalPolicy: { requiredGoalIds: [...goals.map((goal) => goal.goalId), target.goalId], allowWaiveSoftGoals: true },
};

const scorer = {
  scoreItem(itemId: number) {
    return { itemId, score: 1, confidence: 1, completeness: 1, components: [], version: 'adaptive-evidence-scorer-v1' as const };
  },
} as any;
const evidence: any = {
  heroId: 1, rulesetVersion: 'r1', catalogSha256: 'a'.repeat(64), statlockerPatchId: 'p', usable: true,
  snapshotIds: [], degradedReasons: [], families: [], byDataset: {},
};

describe('strategy-first blocked slot contract', () => {
  it('returns REPLAN_REQUIRED instead of recommending an impossible fifth weapon item', () => {
    const result = new StrategyFirstBuildPlannerV1Service(scorer).plan({ decision, evidence, strategies: [strategy] });

    expect(result.strategyPlan.slotPlan.feasible).toBe(false);
    expect(result.strategyPlan.buildStatus).toBe('REPLAN_REQUIRED');
    expect(result.contract.status).toBe('REPLAN_REQUIRED');
    expect(result.nextAction.type === 'BUY' && result.nextAction.targetItemId === 5).toBe(false);
    expect(result.recommendedBuild.find((entry) => entry.itemId === 5)?.status).not.toBe('NEXT');
  });
});
