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

const catalogSha256 = 'b'.repeat(64);
const items: RecommendationItemDefinition[] = [101, 102, 103, 104, 202, 105, 106, 107, 108, 109, 110, 111, 112].map((itemId) => ({
  itemId,
  name: `Item ${itemId}`,
  slotType: itemId === 202 || itemId <= 104 ? 'weapon' : itemId >= 109 ? 'spirit' : 'vitality',
  active: false,
  availableRulesetIds: ['r1'],
  directPurchaseCost: 800,
  upgradeRecipes: [],
  sellTransition: itemId === 101 ? { soulsRefund: 400, returnedItemIds: [] } : undefined,
  maxCopies: 1,
}));
const graph = createRecommendationItemGraph(items);

function decision(ownedItemIds: readonly number[], maxFlexSlots = 4): AdaptiveDecisionStateV1 {
  const held = buildInventoryInstancesForRecommendation(ownedItemIds, graph);
  const slotRules = {
    baseSlots: 12,
    baseSlotsByType: { weapon: 4, vitality: 4, spirit: 4 } as const,
    maxFlexSlots,
    maxActiveItems: 4,
  };
  return {
    state: {
      decisionId: 'slot-regression',
      matchId: 'match',
      playerSlot: 0,
      gameTimeSec: 1800,
      rulesetId: 'r1',
      heroId: 1,
      inventory: {
        initializedFromSnapshot: true,
        heldByItemId: held,
        lifecycleCountByItemId: new Map(ownedItemIds.map((itemId) => [itemId, 1])),
        nextInstanceSequence: held.size + 1,
      },
      economy: {
        spendableSouls: observedFact(5000, 'test'),
        shopOpportunity: observedFact('AVAILABLE', 'test'),
      },
    },
    itemGraph: graph,
    catalogVersionId: 'catalog',
    catalogSha256,
    rulesetId: 'r1',
    localSteamId: 'player',
    allyHeroIds: [],
    enemyHeroIds: [],
    enemyLiveStates: [],
    allyItemIds: [],
    enemyItemIds: [],
    slots: deriveAdaptiveSlotStateV1(ownedItemIds, graph, slotRules, {
      unlockedFlexSlots: 0,
      evidence: 'OBSERVED',
    }),
    investment: unknownAdaptiveInvestmentStateV1(),
    economyRulesEvidence: 'UNKNOWN',
    stateRevision: 'revision',
  };
}

function strategy(withTemporaryExit: boolean): BuildStrategySpecV1 {
  const goals: BuildStrategySpecV1['goals'] = [
    {
      goalId: 'owned-102', type: 'CORE', phase: 'EARLY', targetItemIds: [102], minSelect: 1, maxSelect: 1,
      prerequisiteGoalIds: [], hard: true, lifecycleByItemId: { 102: 'PERMANENT_CORE' }, rationaleCodes: ['CORE'],
    },
    {
      goalId: 'owned-103', type: 'CORE', phase: 'EARLY', targetItemIds: [103], minSelect: 1, maxSelect: 1,
      prerequisiteGoalIds: [], hard: true, lifecycleByItemId: { 103: 'PERMANENT_CORE' }, rationaleCodes: ['CORE'],
    },
    {
      goalId: 'owned-104', type: 'CORE', phase: 'EARLY', targetItemIds: [104], minSelect: 1, maxSelect: 1,
      prerequisiteGoalIds: [], hard: true, lifecycleByItemId: { 104: 'PERMANENT_CORE' }, rationaleCodes: ['CORE'],
    },
    ...[105, 106, 107, 108, 109, 110, 111, 112].map((itemId) => ({
      goalId: `owned-${itemId}`,
      type: 'CORE' as const,
      phase: 'EARLY' as const,
      targetItemIds: [itemId],
      minSelect: 1,
      maxSelect: 1,
      prerequisiteGoalIds: [],
      hard: true,
      lifecycleByItemId: { [itemId]: 'PERMANENT_CORE' as const },
      rationaleCodes: ['CORE'],
    })),
    ...(withTemporaryExit ? [{
      goalId: 'temporary-101', type: 'CORE' as const, phase: 'EARLY' as const, targetItemIds: [101], minSelect: 0, maxSelect: 1,
      prerequisiteGoalIds: [], hard: false, lifecycleByItemId: { 101: 'TEMPORARY_EARLY' as const }, rationaleCodes: ['TEMPORARY'],
    }] : [{
      goalId: 'owned-101', type: 'CORE' as const, phase: 'EARLY' as const, targetItemIds: [101], minSelect: 1, maxSelect: 1,
      prerequisiteGoalIds: [], hard: true, lifecycleByItemId: { 101: 'PERMANENT_CORE' as const }, rationaleCodes: ['CORE'],
    }]),
    {
      goalId: 'target-202', type: 'CORE', phase: 'LATE', targetItemIds: [202], minSelect: 1, maxSelect: 1,
      prerequisiteGoalIds: [], hard: true, lifecycleByItemId: { 202: 'REPLACEMENT_TARGET' }, rationaleCodes: ['LATE_CORE'],
    },
  ];
  return {
    schemaVersion: 1,
    strategyId: withTemporaryExit ? 'strategy-replace' : 'strategy-blocked',
    heroId: 1,
    rulesetId: 'r1',
    sourcePatchId: 'p',
    support: 1,
    stability: 1,
    representativeTraceId: 'trace',
    goals,
    branchGroups: [],
    situationalWindows: [],
    investmentPolicy: { objectives: [], preferredWeights: { weapon: 1, vitality: 0, spirit: 0 } },
    slotPolicy: { reservedSituationalSlots: 0, maxTemporarySlots: 1 },
    terminalPolicy: { requiredGoalIds: goals.filter((goal) => goal.hard).map((goal) => goal.goalId), allowWaiveSoftGoals: true },
  };
}

const fakeScorer = {
  scoreItem(itemId: number) {
    return { itemId, score: itemId === 202 ? 1 : 0.5, confidence: 0.8, completeness: 1, components: [], version: 'adaptive-evidence-scorer-v1' as const };
  },
} as any;
const emptyEvidence = {
  heroId: 1, rulesetVersion: 'r1', catalogSha256, statlockerPatchId: 'p', usable: true,
  snapshotIds: [], degradedReasons: [], families: [], byDataset: {},
} as any;

describe('transaction-first full-slot regression', () => {
  const planner = new StrategyFirstBuildPlannerV1Service(fakeScorer);
  const transactionPlan = new StrategyFirstTransactionPlanV1Service();
  const fullInventory = [101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112];

  it('represents a legal full-slot replacement as one SELL_AND_BUY plan step', () => {
    const d = decision(fullInventory);
    const raw = planner.plan({ decision: d, evidence: emptyEvidence, strategies: [strategy(true)] });
    const result = transactionPlan.apply({ result: raw, decision: d });

    expect(result.planSession.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'TRANSACTION',
        action: { type: 'SELL_AND_BUY', sellItemId: 101, buyItemId: 202 },
      }),
    ]));
    expect(result.nextAction).toMatchObject({ type: 'REPLACE', sellItemId: 101, buyItemId: 202 });
  });

  it('fails closed when a full inventory has no legal replacement, upgrade, or possible flex exit path', () => {
    const d = decision(fullInventory, 0);
    const raw = planner.plan({ decision: d, evidence: emptyEvidence, strategies: [strategy(false)] });
    const result = transactionPlan.apply({ result: raw, decision: d });

    expect(result.planSession.state).toBe('REPLAN_REQUIRED');
    expect(result.nextAction.type).toBe('HOLD');
    expect(result.planSession.steps.some((step) =>
      step.kind === 'TRANSACTION' && step.action && step.action.buyItemId === 202,
    )).toBe(false);
    expect(result.recommendedBuild.every((row) => row.status === 'OWNED')).toBe(true);
  });
});
