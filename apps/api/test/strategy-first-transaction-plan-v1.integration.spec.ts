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

const catalogSha256 = 'f'.repeat(64);
const items: RecommendationItemDefinition[] = [1, 2, 3, 4, 5].map((itemId) => ({
  itemId,
  name: `Item ${itemId}`,
  slotType: 'weapon',
  active: false,
  availableRulesetIds: ['r1'],
  directPurchaseCost: itemId === 5 ? 1200 : 500,
  upgradeRecipes: [],
  sellTransition: itemId === 4 ? { soulsRefund: 250, returnedItemIds: [] } : undefined,
  maxCopies: 1,
}));
const graph = createRecommendationItemGraph(items);

function decision(owned: readonly number[], unlockedFlexSlots = 0, maxFlexSlots = 4): AdaptiveDecisionStateV1 {
  const held = buildInventoryInstancesForRecommendation(owned, graph);
  const slotRules = {
    baseSlots: 12,
    baseSlotsByType: { weapon: 4, vitality: 4, spirit: 4 } as const,
    maxFlexSlots,
    maxActiveItems: 4,
  };
  return {
    state: {
      decisionId: `d:${owned.join(',')}`, matchId: 'm', playerSlot: 0, gameTimeSec: 1200, rulesetId: 'r1', heroId: 1,
      inventory: { initializedFromSnapshot: true, heldByItemId: held, lifecycleCountByItemId: new Map(), nextInstanceSequence: held.size + 1 },
      economy: { spendableSouls: observedFact(5000, 'test'), shopOpportunity: observedFact('AVAILABLE', 'test') },
    },
    itemGraph: graph, catalogVersionId: 'c', catalogSha256, rulesetId: 'r1', localSteamId: 'p',
    allyHeroIds: [], enemyHeroIds: [], enemyLiveStates: [], allyItemIds: [], enemyItemIds: [],
    slots: deriveAdaptiveSlotStateV1(owned, graph, slotRules, { unlockedFlexSlots, evidence: 'OBSERVED' }),
    investment: unknownAdaptiveInvestmentStateV1(), economyRulesEvidence: 'UNKNOWN', stateRevision: 'revision',
  };
}

function goal(
  goalId: string,
  itemId: number,
  hard = true,
  lifecycle: 'PERMANENT_CORE' | 'TEMPORARY_EARLY' | 'REPLACEMENT_TARGET' = 'PERMANENT_CORE',
) {
  return {
    goalId, type: 'CORE' as const, phase: 'LATE' as const, targetItemIds: [itemId], minSelect: hard ? 1 : 0, maxSelect: 1,
    prerequisiteGoalIds: [], hard, lifecycleByItemId: { [itemId]: lifecycle }, rationaleCodes: ['CORE'],
  };
}

function strategy(temporary = true): BuildStrategySpecV1 {
  const goals = [
    goal('g1', 1), goal('g2', 2), goal('g3', 3),
    temporary ? goal('temp', 4, false, 'TEMPORARY_EARLY') : goal('g4', 4),
    goal('target', 5, true, 'REPLACEMENT_TARGET'),
  ];
  return {
    schemaVersion: 1, strategyId: temporary ? 'replace-strategy' : 'blocked-strategy', heroId: 1, rulesetId: 'r1', sourcePatchId: 'p',
    support: 1, stability: 1, representativeTraceId: 'trace', goals, branchGroups: [], situationalWindows: [],
    investmentPolicy: { objectives: [], preferredWeights: { weapon: 1, vitality: 0, spirit: 0 } },
    slotPolicy: { reservedSituationalSlots: 0, maxTemporarySlots: 1 },
    terminalPolicy: { requiredGoalIds: goals.filter((entry) => entry.hard).map((entry) => entry.goalId), allowWaiveSoftGoals: true },
  };
}

const scorer = {
  scoreItem(itemId: number) {
    return { itemId, score: itemId === 5 ? 1 : 0.5, confidence: 0.9, completeness: 1, components: [], version: 'adaptive-evidence-scorer-v1' as const };
  },
} as any;
const evidence = {
  heroId: 1, rulesetVersion: 'r1', catalogSha256, statlockerPatchId: 'p', usable: true,
  snapshotIds: [], degradedReasons: [], families: [], byDataset: {},
} as any;

describe('strategy-first transaction plan integration', () => {
  const planner = new StrategyFirstBuildPlannerV1Service(scorer);
  const transaction = new StrategyFirstTransactionPlanV1Service();

  it('turns a full-slot temporary exit into one atomic SELL_AND_BUY source-of-truth step', () => {
    const d = decision([1, 2, 3, 4], 0, 4);
    const planned = planner.plan({ decision: d, evidence, strategies: [strategy(true)] });
    expect(planned.nextAction.type).toBe('SELL');

    const result = transaction.apply({ result: planned, decision: d });
    expect(result.planSession.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: { type: 'SELL_AND_BUY', sellItemId: 4, buyItemId: 5 } }),
    ]));
    expect(result.nextAction).toMatchObject({ type: 'REPLACE', sellItemId: 4, buyItemId: 5, targetItemId: 5 });
    expect(result.recommendedBuild.find((row) => row.itemId === 5)?.status).toBe('NEXT');
  });

  it('keeps the semantic build path and metadata while transaction state owns the current NEXT marker', () => {
    const d = decision([]);
    const planned = planner.plan({ decision: d, evidence, strategies: [strategy(true)] });
    expect(planned.recommendedBuild.filter((row) => row.status === 'PLANNED').length).toBeGreaterThan(0);

    const result = transaction.apply({ result: planned, decision: d });
    expect(result.recommendedBuild.map((row) => row.itemId)).toEqual(planned.recommendedBuild.map((row) => row.itemId));

    for (const semanticRow of planned.recommendedBuild) {
      const servedRow = result.recommendedBuild.find((row) => row.itemId === semanticRow.itemId);
      expect(servedRow).toBeDefined();
      expect(servedRow).toMatchObject({
        itemId: semanticRow.itemId,
        position: semanticRow.position,
        score: semanticRow.score,
        confidence: semanticRow.confidence,
        skeletonStrength: semanticRow.skeletonStrength,
        contextualSupport: semanticRow.contextualSupport,
      });
      expect(servedRow?.reasonCodes).toEqual(semanticRow.reasonCodes);
    }

    const transactionTarget = result.nextAction.type === 'BUY' || result.nextAction.type === 'UPGRADE' || result.nextAction.type === 'REPLACE'
      ? result.nextAction.targetItemId
      : undefined;
    expect(result.recommendedBuild.filter((row) => row.status === 'NEXT').map((row) => row.itemId)).toEqual(
      transactionTarget === undefined ? [] : [transactionTarget],
    );
  });

  it('never serves a naked slot-release SELL as NEXT', () => {
    const d = decision([1, 2, 3, 4], 0, 4);
    const planned = planner.plan({ decision: d, evidence, strategies: [strategy(true)] });
    const result = transaction.apply({ result: planned, decision: d });
    expect(result.nextAction.type).not.toBe('SELL');
    expect(result.planSession.steps.some((step) => step.kind === 'TRANSACTION' && step.action?.type === 'SELL_AND_BUY')).toBe(true);
  });

  it('waits on an explicit flex barrier when future capacity is known but not yet unlocked', () => {
    const d = decision([1, 2, 3, 4], 0, 4);
    const planned = planner.plan({ decision: d, evidence, strategies: [strategy(false)] });
    expect(planned.recommendedBuild.find((row) => row.itemId === 5)?.status).toBe('NEXT');

    const result = transaction.apply({ result: planned, decision: d });
    expect(result.planSession.state).toBe('WAITING');
    expect(result.nextAction).toMatchObject({ type: 'HOLD', targetItemId: 5 });
    expect(result.recommendedBuild.find((row) => row.itemId === 5)?.status).toBe('NEXT');
    expect(result.planSession.steps[0].barrier).toMatchObject({ type: 'WAIT_FOR_FLEX', requiredUnlockedFlexSlots: 1 });
  });

  it('fails closed when the target has no replacement, upgrade, or possible flex path', () => {
    const d = decision([1, 2, 3, 4], 0, 0);
    const planned = planner.plan({ decision: d, evidence, strategies: [strategy(false)] });
    const result = transaction.apply({ result: planned, decision: d });
    expect(result.planSession.state).toBe('REPLAN_REQUIRED');
    expect(result.contract.status).toBe('REPLAN_REQUIRED');
    expect(result.nextAction.type).toBe('HOLD');
    expect(result.recommendedBuild.every((row) => row.status === 'OWNED')).toBe(true);
  });

  it('keeps semantic future targets when transaction compilation fails closed', () => {
    const d = decision([1, 2, 3, 4], 0, 0);
    const planned = planner.plan({ decision: d, evidence, strategies: [strategy(false)] });
    const semanticResult = {
      ...planned,
      recommendedBuild: [
        ...planned.recommendedBuild.filter((row) => row.itemId !== 5),
        {
          itemId: 5,
          position: planned.recommendedBuild.length + 1,
          status: 'PLANNED' as const,
          score: 1,
          confidence: 0.9,
          skeletonStrength: 0.7,
          contextualSupport: 0.8,
          reasonCodes: ['STRATEGIC_FUTURE_TARGET'],
        },
      ],
    };

    const result = transaction.apply({ result: semanticResult, decision: d });
    expect(result.planSession.state).toBe('REPLAN_REQUIRED');
    expect(result.nextAction.type).toBe('HOLD');
    expect(result.recommendedBuild.find((row) => row.itemId === 5)).toMatchObject({
      status: 'PLANNED',
      score: 1,
      confidence: 0.9,
      skeletonStrength: 0.7,
      contextualSupport: 0.8,
      reasonCodes: ['STRATEGIC_FUTURE_TARGET'],
    });
  });

  it('preserves the plan session and completes the replacement step after the player executes it', () => {
    const before = decision([1, 2, 3, 4], 0, 4);
    const firstPlanned = planner.plan({ decision: before, evidence, strategies: [strategy(true)] });
    const first = transaction.apply({ result: firstPlanned, decision: before });

    const after = decision([1, 2, 3, 5], 0, 4);
    const secondPlanned = planner.plan({ decision: after, evidence, strategies: [strategy(true)] });
    const second = transaction.apply({ result: secondPlanned, decision: after, previousPlanSession: first.planSession });

    expect(second.planSession.planSessionId).toBe(first.planSession.planSessionId);
    expect(second.planSession.steps.find((step) => step.action?.type === 'SELL_AND_BUY')?.state).toBe('COMPLETED');
  });
});
