import {
  AdaptiveRecommendationStrategyV1,
  AdaptiveRecommendationResultV1,
} from '@deadlock-live-probe/shared';
import { buildInventoryInstancesForRecommendation, createRecommendationItemGraph, observedFact } from '@deadlock-live-probe/build-domain';
import { deriveAdaptiveSlotStateV1, unknownAdaptiveInvestmentStateV1 } from '../src/statlocker-adaptive/adaptive-economy-v1';
import { BuildStrategyRegistryV1Service } from '../src/statlocker-adaptive/build-strategy-registry-v1.service';
import { StrategyFirstAdaptivePlannerFacadeV1Service } from '../src/statlocker-adaptive/strategy-first-adaptive-planner-facade-v1.service';
import {
  toAdaptiveRecommendationStrategyV1,
} from '../src/statlocker-adaptive/strategy-first-legacy-planner-adapter-v1.service';

const graph = createRecommendationItemGraph([
  {
    itemId: 1,
    name: 'Core',
    slotType: 'weapon',
    active: false,
    availableRulesetIds: ['r1'],
    directPurchaseCost: 800,
    upgradeRecipes: [],
    sellTransition: { soulsRefund: 400, returnedItemIds: [] },
  },
]);

const slots = deriveAdaptiveSlotStateV1(
  [],
  graph,
  {
    baseSlots: 12,
    baseSlotsByType: { weapon: 4, vitality: 4, spirit: 4 },
    maxFlexSlots: 4,
    maxActiveItems: 4,
  },
  { unlockedFlexSlots: 0, evidence: 'OBSERVED' },
);

const decision: any = {
  state: {
    decisionId: 'd',
    matchId: 'm',
    playerSlot: 0,
    gameTimeSec: 420,
    rulesetId: 'r1',
    heroId: 1,
    inventory: {
      initializedFromSnapshot: true,
      heldByItemId: buildInventoryInstancesForRecommendation([], graph),
      lifecycleCountByItemId: new Map(),
      nextInstanceSequence: 1,
    },
    economy: {
      spendableSouls: observedFact(2_000, 'test'),
      shopOpportunity: observedFact('AVAILABLE', 'test'),
    },
  },
  itemGraph: graph,
  catalogVersionId: 'catalog',
  catalogSha256: 'a'.repeat(64),
  rulesetId: 'r1',
  localSteamId: 'player',
  allyHeroIds: [],
  enemyHeroIds: [],
  enemyLiveStates: [],
  allyItemIds: [],
  enemyItemIds: [],
  slots,
  investment: unknownAdaptiveInvestmentStateV1(),
  economyRulesEvidence: 'UNKNOWN',
  stateRevision: 'revision-test',
};

const skeleton: any = {
  heroId: 1,
  profileCount: 10,
  groups: [{
    groupId: 'required',
    phase: 'EARLY',
    type: 'REQUIRED',
    minSelect: 1,
    maxSelect: 1,
    confidence: 0.9,
    inferred: false,
    candidates: [{
      itemId: 1,
      strength: 0.9,
      coverage: 0.9,
      purchaseRate: 0.9,
      medianBuyTimeS: 100,
      timingSpreadS: 10,
      sourceProfileCount: 9,
      frequencyTier: 'CORE',
      rushEvidence: false,
    }],
  }],
};

const evidence: any = {
  heroId: 1,
  rulesetVersion: 'r1',
  catalogSha256: 'a'.repeat(64),
  statlockerPatchId: 'patch',
  usable: true,
  snapshotIds: [],
  degradedReasons: [],
  families: [],
  byDataset: {
    CONSENSUS_SKELETON: { dataset: 'CONSENSUS_SKELETON', freshness: 'FRESH', confidence: 1, payload: skeleton },
  },
};

const previousStrategy: AdaptiveRecommendationStrategyV1 = {
  strategyId: 'sticky-strategy',
  commitment: 'COMMITTED',
  selectedAtGameTimeSec: 180,
  posterior: 0.91,
  reasonCodes: ['DISTINCTIVE_PREFIX_COMMITMENT'],
  selectedBranches: { boots: 'boots-a' },
  committedBranches: { boots: 'boots-a' },
  buildStatus: 'IN_PROGRESS',
  progress: { satisfiedHardGoals: 1, totalHardGoals: 3 },
  remainingGoalIds: ['g2', 'g3'],
  slotPlan: {
    currentUsedSlots: 1,
    currentFlexUsed: 0,
    reservedSituationalSlots: 0,
    feasible: true,
    reasonCodes: [],
  },
  investmentObjectives: [],
};

function previousResult(): Pick<
  AdaptiveRecommendationResultV1,
  'recommendedBuild' | 'totalScore' | 'nextAction' | 'confidence' | 'strategy'
> {
  return {
    recommendedBuild: [],
    totalScore: 1,
    nextAction: { actionKey: 'HOLD', type: 'HOLD', reasonCodes: [] },
    confidence: 0.8,
    strategy: previousStrategy,
  };
}

describe('strategy-first runtime continuity v1', () => {
  it('rehydrates sticky strategy session and branch contract from the previous recommendation', () => {
    let captured: any;
    const planner = {
      plan(input: any) {
        captured = input;
        const selected = input.strategies[0];
        return {
          gameState: 'UNKNOWN',
          strategy: selected,
          strategySelection: { selectedStrategyId: selected.strategyId, commitment: 'COMMITTED', posteriors: [], reasonCodes: [] },
          strategySession: {
            strategyId: 'sticky-strategy',
            commitment: 'COMMITTED',
            selectedAtGameTimeSec: 180,
            posterior: 0.91,
            replanReasons: ['DISTINCTIVE_PREFIX_COMMITMENT'],
          },
          contract: {
            strategyId: selected.strategyId,
            status: 'WAITING',
            commitment: 'COMMITTED',
            goalStates: {},
            selectedBranches: { boots: 'boots-a' },
            committedBranches: { boots: 'boots-a' },
            temporaryItemIds: [],
            reservedSituationalWindowIds: [],
            remainingHardGoalIds: ['required'],
            completionReasonCodes: ['MANDATORY_GOALS_REMAIN'],
          },
          strategyPlan: {
            strategyId: selected.strategyId,
            buildStatus: 'WAITING',
            progress: { satisfiedHardGoals: 0, totalHardGoals: 1 },
            remainingGoalIds: ['required'],
            remainingHardInvestmentObjectiveIds: [],
            slotPlan: {
              currentUsedSlots: 0,
              currentFlexUsed: 0,
              unlockedFlexSlots: 0,
              reservedSituationalSlots: 0,
              futureTransitions: [],
              feasible: true,
              reasonCodes: [],
            },
            investmentPlan: { objectives: [], activeObjectiveIds: [] },
          },
          nextAction: { actionKey: 'HOLD', type: 'HOLD', reasonCodes: ['TEST_FIXTURE'] },
          recommendedBuild: [],
          changes: [],
          rankedImmediateCandidates: [],
          totalScore: 0,
          confidence: 0,
          plannerVersion: 'strategy-first-build-planner-v1',
        };
      },
    } as any;
    const registry = new BuildStrategyRegistryV1Service();
    (registry as any).getStrategies = jest.fn(() => [{ ...previousStrategy, goals: [], branchGroups: [] }]);
    const facade = new StrategyFirstAdaptivePlannerFacadeV1Service(
      planner,
      registry,
      undefined,
      undefined,
      { apply: ({ result }: any) => ({ ...result, planSession: { planSessionId: 'test', strategyId: 'sticky-strategy', revision: 1, createdAtGameTimeSec: 0, updatedAtGameTimeSec: 0, state: 'ACTIVE', steps: [], reasonCodes: [] }, transactionPlanValidation: { valid: true, violations: [] } }) } as any,
    );

    facade.plan({
      decision,
      evidence,
      previousResult: previousResult(),
      recentPurchasedItemIds: [1],
      recentSoldItemIds: [],
    });

    expect(captured.previousSession).toEqual({
      strategyId: 'sticky-strategy',
      commitment: 'COMMITTED',
      selectedAtGameTimeSec: 180,
      posterior: 0.91,
      replanReasons: ['DISTINCTIVE_PREFIX_COMMITMENT'],
    });
    expect(captured.previousContract).toMatchObject({
      strategyId: 'sticky-strategy',
      selectedBranches: { boots: 'boots-a' },
      committedBranches: { boots: 'boots-a' },
    });
    expect(captured.previousRecommendedBuild).toBeUndefined();
    expect(captured.recentPurchasedItemIds).toEqual([1]);
  });

  it('projects strategy selection and contract state into the public API contract', () => {
    const strategy = toAdaptiveRecommendationStrategyV1({
      strategy: { strategyId: 's1' },
      strategySession: {
        strategyId: 's1',
        commitment: 'COMMITTED',
        selectedAtGameTimeSec: 120,
        posterior: 0.88,
        replanReasons: ['STICKY_COMMITTED_STRATEGY'],
      },
      contract: {
        selectedBranches: { branch: 'a' },
        committedBranches: { branch: 'a' },
      },
      strategyPlan: {
        buildStatus: 'WAITING',
        progress: { satisfiedHardGoals: 2, totalHardGoals: 4 },
        currentGoal: { goalId: 'g3', type: 'UPGRADE', reasonCodes: ['CURRENT_GOAL'] },
        remainingGoalIds: ['g3', 'g4'],
        slotPlan: {
          currentUsedSlots: 8,
          currentFlexUsed: 1,
          unlockedFlexSlots: 2,
          reservedSituationalSlots: 1,
          feasible: true,
          reasonCodes: ['SLOT_PLAN_FEASIBLE'],
          futureTransitions: [],
        },
        investmentPlan: {
          activeObjectiveIds: ['weapon-3200'],
          objectives: [{
            objectiveId: 'weapon-3200',
            type: 'weapon',
            state: 'ACTIVE',
            currentValue: 2400,
            targetValue: 3200,
            distance: 800,
            reasonCodes: ['INVESTMENT_OBJECTIVE_ACTIVE'],
          }],
        },
      },
    } as any);

    expect(strategy).toMatchObject({
      strategyId: 's1',
      commitment: 'COMMITTED',
      selectedAtGameTimeSec: 120,
      posterior: 0.88,
      selectedBranches: { branch: 'a' },
      committedBranches: { branch: 'a' },
      buildStatus: 'WAITING',
      currentGoal: { goalId: 'g3', type: 'UPGRADE' },
      remainingHardInvestmentObjectiveIds: [],
    });
    expect(strategy.investmentObjectives[0]).toMatchObject({ targetValue: 3200, distance: 800 });
  });
});
