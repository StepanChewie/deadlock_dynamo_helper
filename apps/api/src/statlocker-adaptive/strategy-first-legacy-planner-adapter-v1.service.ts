import { Injectable } from '@nestjs/common';
import {
  AdaptiveDecisionTraceV1,
  AdaptivePlanSessionV1,
  AdaptiveRecommendationStrategyV1,
} from '@deadlock-live-probe/shared';
import {
  AdaptiveBuildPlannerInputV1,
  AdaptiveBuildPlannerResultV1,
} from './adaptive-build-planner-v1.service';
import { AdaptiveDecisionTraceV1Service } from './adaptive-decision-trace-v1.service';
import { StrategyFirstAdaptivePlannerFacadeV1Service } from './strategy-first-adaptive-planner-facade-v1.service';
import { StrategyFirstBuildPlannerV1Result } from './strategy-first-build-planner-v1.service';
import { TransactionPlanValidationV1 } from './transaction-plan-validator-v1.service';

export type StrategyFirstLegacyPlannerResultV1 = AdaptiveBuildPlannerResultV1 & {
  strategy: AdaptiveRecommendationStrategyV1;
  planSession: AdaptivePlanSessionV1;
  transactionPlanValidation: TransactionPlanValidationV1;
  decisionTrace: AdaptiveDecisionTraceV1;
};

export type StrategyFirstFlatCompatPlannerResultV1 = AdaptiveBuildPlannerResultV1 & {
  strategy: AdaptiveRecommendationStrategyV1;
  decisionTrace: AdaptiveDecisionTraceV1;
};

/**
 * Compatibility adapter for existing recommendation/replay call sites while the external API
 * remains on AdaptiveRecommendationResultV1. Runtime semantics come from the strategy-first
 * transaction planner; the legacy planner version string is retained only so persisted V1 replay inputs stay readable.
 */
@Injectable()
export class StrategyFirstLegacyPlannerAdapterV1Service {
  readonly version = 'adaptive-build-planner-v1' as const;

  constructor(
    private readonly strategyPlanner: StrategyFirstAdaptivePlannerFacadeV1Service,
    private readonly decisionTrace: AdaptiveDecisionTraceV1Service,
  ) {}

  plan(input: AdaptiveBuildPlannerInputV1): StrategyFirstLegacyPlannerResultV1 {
    const result = this.strategyPlanner.plan(this.toFacadeInput(input));
    return {
      ...this.toPlannerResult(result),
      strategy: toAdaptiveRecommendationStrategyV1(result),
      planSession: result.planSession,
      transactionPlanValidation: result.transactionPlanValidation,
      decisionTrace: this.decisionTrace.build(input, result),
    };
  }

  planFlatCompat(input: AdaptiveBuildPlannerInputV1): StrategyFirstFlatCompatPlannerResultV1 {
    const result = this.strategyPlanner.planFlatCompat(this.toFacadeInput(input));
    return {
      ...this.toPlannerResult(result),
      strategy: toAdaptiveRecommendationStrategyV1(result),
      decisionTrace: this.decisionTrace.build(input, result),
    };
  }

  private toFacadeInput(input: AdaptiveBuildPlannerInputV1) {
    return {
      decision: input.decision,
      evidence: input.evidence,
      previousResult: input.previousResult as any,
      recentPurchasedItemIds: input.recentPurchasedItemIds,
      recentSoldItemIds: input.recentSoldItemIds,
    };
  }

  private toPlannerResult(result: StrategyFirstBuildPlannerV1Result): AdaptiveBuildPlannerResultV1 {
    return {
      gameState: result.gameState,
      nextAction: result.nextAction,
      recommendedBuild: result.recommendedBuild,
      changes: result.changes,
      rankedImmediateCandidates: result.rankedImmediateCandidates,
      totalScore: result.totalScore,
      confidence: result.confidence,
      buildContract: {
        strategyId: result.contract.strategyId,
        status: result.contract.status,
        currentGoalId: result.contract.currentGoalId,
        completedGoalIds: new Set(Object.entries(result.contract.goalStates)
          .filter(([, state]) => state === 'SATISFIED' || state === 'SKIPPED' || state === 'WAIVED')
          .map(([goalId]) => goalId)),
        remainingGoalIds: [...result.contract.remainingHardGoalIds],
        committedChoiceItemIdsByGroup: new Map(Object.entries(result.contract.committedBranches).map(
          ([groupId, goalId]) => [groupId, result.strategy.goals.find((goal) => goal.goalId === goalId)?.targetItemIds ?? []],
        )),
        temporaryItemIds: new Set(result.contract.temporaryItemIds),
        slotReservations: [],
        situationalWindowStates: result.contract.reservedSituationalWindowIds.map((windowId) => ({
          windowId,
          state: 'OPEN' as const,
          targetItemIds: [],
          reasonCodes: ['STRATEGY_WINDOW_RESERVED'],
        })),
        replanReasonCodes: [...result.contract.completionReasonCodes],
      },
      plannerVersion: this.version,
    };
  }
}

export function toAdaptiveRecommendationStrategyV1(
  result: Pick<
    StrategyFirstBuildPlannerV1Result,
    'strategy' | 'strategySession' | 'contract' | 'strategyPlan'
  >,
): AdaptiveRecommendationStrategyV1 {
  const session = result.strategySession;
  const plan = result.strategyPlan;
  const slotPlan = plan.slotPlan;
  const investmentPlan = plan.investmentPlan;
  const situational = plan.situationalDecision;
  return {
    strategyId: session.strategyId ?? result.strategy.strategyId,
    commitment: session.commitment,
    selectedAtGameTimeSec: session.selectedAtGameTimeSec,
    posterior: session.posterior,
    stability: result.strategy.stability,
    reasonCodes: [...(session.replanReasons ?? [])],
    selectedBranches: { ...(result.contract.selectedBranches ?? {}) },
    committedBranches: { ...(result.contract.committedBranches ?? {}) },
    buildStatus: plan.buildStatus,
    progress: { ...plan.progress },
    currentGoal: plan.currentGoal
      ? {
          goalId: plan.currentGoal.goalId,
          type: plan.currentGoal.type,
          reasonCodes: [...(plan.currentGoal.reasonCodes ?? [])],
        }
      : undefined,
    remainingGoalIds: [...(plan.remainingGoalIds ?? [])],
    remainingHardInvestmentObjectiveIds: [...(plan.remainingHardInvestmentObjectiveIds ?? [])],
    slotPlan: {
      currentUsedSlots: slotPlan.currentUsedSlots,
      currentFlexUsed: slotPlan.currentFlexUsed,
      unlockedFlexSlots: slotPlan.unlockedFlexSlots,
      reservedSituationalSlots: slotPlan.reservedSituationalSlots,
      feasible: slotPlan.feasible,
      reasonCodes: [...(slotPlan.reasonCodes ?? [])],
      futureTransitions: (slotPlan.futureTransitions ?? []).map((transition) => ({
        targetGoalId: transition.targetGoalId,
        targetItemId: transition.targetItemId,
        requirement: transition.requirement,
        sourceItemId: transition.sourceItemId,
        requiredUnlockedFlexSlots: transition.requiredUnlockedFlexSlots,
        reasonCodes: [...(transition.reasonCodes ?? [])],
      })),
    },
    investmentObjectives: (investmentPlan?.objectives ?? []).map((objective) => ({
      objectiveId: objective.objectiveId,
      type: objective.type,
      state: objective.state,
      currentValue: objective.currentValue,
      targetValue: objective.targetValue,
      distance: objective.distance,
      reasonCodes: [...(objective.reasonCodes ?? [])],
    })),
    situationalDecision: situational
      ? {
          windowId: situational.windowId,
          purpose: situational.purpose,
          targetItemId: situational.targetItemId,
          enemyHeroIds: [...(situational.enemyHeroIds ?? [])],
          enemyItemIds: [...(situational.enemyItemIds ?? [])],
          confidence: situational.confidence,
          reasonCodes: [...(situational.reasonCodes ?? [])],
          statisticalSupport: situational.statisticalSupport,
          slotImpact: situational.slotImpact,
          investmentImpact: situational.investmentImpact,
          coreInterruptionSouls: situational.coreInterruptionSouls,
        }
      : undefined,
  };
}
