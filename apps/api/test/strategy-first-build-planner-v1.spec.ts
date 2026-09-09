import {
  RecommendationItemDefinition,
  buildInventoryInstancesForRecommendation,
  createRecommendationItemGraph,
  observedFact,
} from '@deadlock-live-probe/build-domain';
import { AdaptiveDecisionStateV1 } from '../src/statlocker-adaptive/adaptive-decision-state-v1.service';
import {
  deriveAdaptiveInvestmentStateV1,
  deriveAdaptiveSlotStateV1,
  unknownAdaptiveInvestmentStateV1,
} from '../src/statlocker-adaptive/adaptive-economy-v1';
import { StrategyFirstBuildPlannerV1Service } from '../src/statlocker-adaptive/strategy-first-build-planner-v1.service';
import { BuildStrategySpecV1 } from '../src/statlocker-adaptive/build-strategy-v1';

const catalogSha256 = 'a'.repeat(64);
const items: RecommendationItemDefinition[] = [1, 2, 3, 4, 5, 6].map((itemId) => ({
  itemId, name: `Item ${itemId}`, slotType: itemId === 3 ? 'vitality' : 'weapon', active: false,
  availableRulesetIds: ['r1'], directPurchaseCost: itemId === 2 ? 1600 : 800, upgradeRecipes: [],
  sellTransition: { soulsRefund: 400, returnedItemIds: [] }, maxCopies: 1,
}));
const graph = createRecommendationItemGraph(items);
const slotRules = { baseSlots: 12, baseSlotsByType: { weapon: 4, vitality: 4, spirit: 4 } as const, maxFlexSlots: 4, maxActiveItems: 4 };
const economyRules = {
  rulesetId: 'r1',
  catalogSha256,
  ...slotRules,
  investmentBreakpoints: {
    weapon: [800, 2400, 3200],
    vitality: [800, 1600, 3200],
    spirit: [800, 1600, 3200],
  },
};

function decision(ownedItemIds: readonly number[], souls: number, unlockedFlexSlots = 0): AdaptiveDecisionStateV1 {
  const held = buildInventoryInstancesForRecommendation(ownedItemIds, graph);
  return {
    state: {
      decisionId: 'd', matchId: 'm', playerSlot: 0, gameTimeSec: 300, rulesetId: 'r1', heroId: 1,
      inventory: { initializedFromSnapshot: true, heldByItemId: held, lifecycleCountByItemId: new Map(ownedItemIds.map((id) => [id, 1])), nextInstanceSequence: held.size + 1 },
      economy: { spendableSouls: observedFact(souls, 'test'), shopOpportunity: observedFact('AVAILABLE', 'test') },
    },
    itemGraph: graph, catalogVersionId: 'c', catalogSha256, rulesetId: 'r1', localSteamId: 'p',
    allyHeroIds: [], enemyHeroIds: [9], allyItemIds: [], enemyItemIds: [],
    slots: deriveAdaptiveSlotStateV1(ownedItemIds, graph, slotRules, { unlockedFlexSlots, evidence: 'OBSERVED' }),
    investment: unknownAdaptiveInvestmentStateV1(), economyRulesEvidence: 'UNKNOWN', stateRevision: 'revision-test',
  };
}

function decisionWithEconomy(ownedItemIds: readonly number[], souls: number): AdaptiveDecisionStateV1 {
  return {
    ...decision(ownedItemIds, souls),
    investment: deriveAdaptiveInvestmentStateV1(ownedItemIds, graph, economyRules),
    economyRules,
    economyRulesEvidence: 'RECONSTRUCTED',
  };
}

function strategy(goals: BuildStrategySpecV1['goals'], branchGroups: BuildStrategySpecV1['branchGroups'] = []): BuildStrategySpecV1 {
  return {
    schemaVersion: 1, strategyId: 's', heroId: 1, rulesetId: 'r1', sourcePatchId: 'p', support: 1, stability: 1,
    representativeTraceId: 't', goals, branchGroups, situationalWindows: [],
    investmentPolicy: { objectives: [], preferredWeights: { weapon: 1, vitality: 0, spirit: 0 } },
    slotPolicy: { reservedSituationalSlots: 0, maxTemporarySlots: 1 },
    terminalPolicy: { requiredGoalIds: goals.filter((goal) => goal.hard && !branchGroups.some((group) => group.optionGoalIds.includes(goal.goalId))).map((goal) => goal.goalId), allowWaiveSoftGoals: true },
  };
}

function goal(id: string, itemId: number, prerequisiteGoalIds: readonly string[] = [], lifecycle: 'PERMANENT_CORE' | 'TEMPORARY_EARLY' = 'PERMANENT_CORE') {
  return {
    goalId: id, type: 'CORE' as const, phase: 'EARLY' as const, targetItemIds: [itemId], minSelect: 1, maxSelect: 1,
    prerequisiteGoalIds, hard: lifecycle !== 'TEMPORARY_EARLY', lifecycleByItemId: { [itemId]: lifecycle }, rationaleCodes: ['CORE'],
  };
}

function optionalGoal(id: string, itemId: number) {
  return {
    goalId: id, type: 'CORE' as const, phase: 'MID' as const, targetItemIds: [itemId], minSelect: 0, maxSelect: 1,
    prerequisiteGoalIds: ['core'], hard: false, lifecycleByItemId: { [itemId]: 'SITUATIONAL' as const }, rationaleCodes: ['OPTIONAL'],
  };
}

const fakeScorer = {
  scoreItem(itemId: number) {
    const score = itemId === 3 ? 0.9 : itemId === 2 ? 0.7 : 0.5;
    return { itemId, score, confidence: 0.8, completeness: 1, components: [], version: 'adaptive-evidence-scorer-v1' as const };
  },
} as any;

const emptyEvidence = {
  heroId: 1, rulesetVersion: 'r1', catalogSha256, statlockerPatchId: 'p', usable: true,
  snapshotIds: [], degradedReasons: [], families: [], byDataset: {
    WPA_PATCH_DATA: { dataset: 'WPA_PATCH_DATA', scopeKey: 'global', freshness: 'UNAVAILABLE', confidence: 0 },
    VS_HERO_WPA: { dataset: 'VS_HERO_WPA', scopeKey: 'global', freshness: 'UNAVAILABLE', confidence: 0 },
    T4_CHAINS: { dataset: 'T4_CHAINS', scopeKey: 'global', freshness: 'UNAVAILABLE', confidence: 0 },
    CONSENSUS_SKELETON: { dataset: 'CONSENSUS_SKELETON', scopeKey: 'hero:1', freshness: 'UNAVAILABLE', confidence: 0 },
    WPA_FILTERED_ITEMS: { dataset: 'WPA_FILTERED_ITEMS', scopeKey: 'hero:1', freshness: 'UNAVAILABLE', confidence: 0 },
  },
} as any;

describe('strategy-first build planner v1', () => {
  const planner = new StrategyFirstBuildPlannerV1Service(fakeScorer);

  it('chooses the first legal transaction that advances the selected coherent strategy', () => {
    const spec = strategy([goal('g1', 1), goal('g2', 2, ['g1'])]);
    const result = planner.plan({ decision: decision([], 5000), evidence: emptyEvidence, strategies: [spec] });
    expect(result.nextAction).toMatchObject({ type: 'BUY', itemId: 1, targetItemId: 1 });
    expect(result.strategyPlan.buildStatus).toBe('IN_PROGRESS');
    expect(result.strategyPlan.currentGoal?.goalId).toBe('g1');
  });

  it('returns WAIT while keeping the build incomplete when the current core transaction is unaffordable', () => {
    const spec = strategy([goal('g1', 2)]);
    const result = planner.plan({ decision: decision([], 500), evidence: emptyEvidence, strategies: [spec] });
    expect(result.nextAction).toMatchObject({ type: 'WAIT', targetItemId: 2 });
    expect(result.recommendedBuild.find((item) => item.status === 'NEXT')?.itemId).toBe(2);
    expect(result.strategyPlan.buildStatus).toBe('WAITING');
    expect(result.strategyPlan.remainingGoalIds).toContain('g1');
  });

  it('plans a temporary sell before a full-slot core purchase and keeps the core as semantic NEXT', () => {
    const temp = goal('temp', 4, [], 'TEMPORARY_EARLY');
    const spec = strategy([goal('g1', 1), goal('g2', 2), goal('g6', 6), temp, goal('target', 5)]);
    const result = planner.plan({ decision: decision([1, 2, 4, 6], 5000), evidence: emptyEvidence, strategies: [spec] });
    expect(result.nextAction).toMatchObject({ type: 'SELL', itemId: 4, sellItemId: 4, targetItemId: 5 });
    expect(result.recommendedBuild.find((item) => item.status === 'NEXT')?.itemId).toBe(5);
  });

  it('chooses one branch using contextual scoring instead of putting both branch items into the plan', () => {
    const branchA = { ...goal('branch-a', 2), type: 'BRANCH' as const };
    const branchB = { ...goal('branch-b', 3), type: 'BRANCH' as const };
    const spec = strategy([goal('core', 1), branchA, branchB], [{ branchGroupId: 'branch', optionGoalIds: ['branch-a', 'branch-b'], minSelect: 1, maxSelect: 1 }]);
    const result = planner.plan({ decision: decision([1], 5000), evidence: emptyEvidence, strategies: [spec] });
    const plannedIds = result.recommendedBuild.filter((entry) => entry.status !== 'OWNED').map((entry) => entry.itemId);
    expect(plannedIds).toContain(3);
    expect(plannedIds).not.toContain(2);
  });

  it('keeps the previous uncommitted branch when challenger improvement is below the 0.08 plan-switch threshold', () => {
    const branchA = { ...goal('branch-a', 2), type: 'BRANCH' as const };
    const branchB = { ...goal('branch-b', 3), type: 'BRANCH' as const };
    const spec = strategy([goal('core', 1), branchA, branchB], [{ branchGroupId: 'branch', optionGoalIds: ['branch-a', 'branch-b'], minSelect: 1, maxSelect: 1 }]);
    const nearTieScorer = {
      scoreItem(itemId: number) {
        const score = itemId === 2 ? 0.70 : itemId === 3 ? 0.75 : 0.5;
        return { itemId, score, confidence: 0.8, completeness: 1, components: [], version: 'adaptive-evidence-scorer-v1' as const };
      },
    } as any;
    const nearTiePlanner = new StrategyFirstBuildPlannerV1Service(nearTieScorer);
    const result = nearTiePlanner.plan({
      decision: decision([1], 5000),
      evidence: emptyEvidence,
      strategies: [spec],
      previousContract: {
        strategyId: 's',
        status: 'IN_PROGRESS',
        commitment: 'PROVISIONAL',
        currentGoalId: 'branch-a',
        goalStates: { core: 'SATISFIED', 'branch-a': 'ACTIVE', 'branch-b': 'READY' },
        selectedBranches: { branch: 'branch-a' },
        committedBranches: {},
        temporaryItemIds: [],
        reservedSituationalWindowIds: [],
        remainingHardGoalIds: [],
        completionReasonCodes: [],
      },
    });

    expect(result.contract.selectedBranches.branch).toBe('branch-a');
    expect(result.recommendedBuild.some((item) => item.itemId === 2)).toBe(true);
    expect(result.recommendedBuild.some((item) => item.itemId === 3)).toBe(false);
  });

  it('prioritizes a hard investment objective over a higher-scored optional item', () => {
    const base = strategy([goal('core', 1), optionalGoal('weapon-investment', 2), optionalGoal('minor-vitality', 3)]);
    const spec: BuildStrategySpecV1 = {
      ...base,
      investmentPolicy: {
        ...base.investmentPolicy,
        objectives: [{
          objectiveId: 'weapon-2400',
          type: 'weapon',
          hard: true,
          minimumValue: 2400,
          activateAfterGoalIds: ['core'],
          deactivateAfterGoalIds: [],
          reasonCodes: ['ARCHETYPE_INVESTMENT_MILESTONE'],
        }],
      },
    };

    const result = planner.plan({
      decision: decisionWithEconomy([1], 5000),
      evidence: emptyEvidence,
      strategies: [spec],
    });

    expect(result.nextAction).toMatchObject({ type: 'BUY', itemId: 2, targetItemId: 2 });
    expect(result.nextAction.itemId).not.toBe(3);
    expect(result.strategyPlan.remainingHardInvestmentObjectiveIds).toContain('weapon-2400');
  });

  it('shows optional strategy goals as planned progression rows without making them executable', () => {
    const spec = strategy([goal('core', 1), optionalGoal('optional-1', 2), optionalGoal('optional-2', 3)]);
    const result = planner.plan({ decision: decision([], 5000), evidence: emptyEvidence, strategies: [spec] });

    expect(result.nextAction).toMatchObject({ type: 'BUY', targetItemId: 1 });
    const optionalRows = result.recommendedBuild.filter((item) =>
      item.reasonCodes.includes('OPTIONAL_PROGRESSION'),
    );
    expect(optionalRows.map((item) => item.itemId).sort()).toEqual([2, 3]);
    for (const row of optionalRows) {
      expect(row.status).toBe('PLANNED');
    }
    expect(result.recommendedBuild.find((item) => item.status === 'NEXT')?.itemId).toBe(1);
    expect(result.strategyPlan.buildStatus).toBe('IN_PROGRESS');
  });
});
