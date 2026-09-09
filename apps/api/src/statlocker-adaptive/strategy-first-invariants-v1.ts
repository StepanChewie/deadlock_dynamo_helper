import {
  generateRecommendationCandidates,
} from '@deadlock-live-probe/build-domain';
import {
  AdaptivePlanSessionV1,
  AdaptiveRecommendationStrategyV1,
} from '@deadlock-live-probe/shared';
import { AdaptiveDecisionStateV1 } from './adaptive-decision-state-v1.service';
import { candidateGeneratorRulesFromSlotStateV1 } from './adaptive-economy-v1';
import { StrategyFirstBuildPlannerV1Result } from './strategy-first-build-planner-v1.service';

export type StrategyFirstInvariantViolationCodeV1 =
  | 'ILLEGAL_NEXT_ACTION'
  | 'SLOT_STATE_INVALID'
  | 'UNREACHABLE_PLAN'
  | 'REDUNDANT_ANCESTOR_IN_PLAN'
  | 'FALSE_BUILD_COMPLETE'
  | 'MANDATORY_GOAL_LOST'
  | 'BRANCH_CONTRADICTION'
  | 'UNEXPECTED_COMMITTED_STRATEGY_SWITCH'
  | 'CORE_WITHOUT_EXIT_SLOT'
  | 'UNEXPLAINED_SITUATIONAL'
  | 'NEXT_ACTION_BUILD_MISMATCH';

export interface StrategyFirstInvariantViolationV1 {
  code: StrategyFirstInvariantViolationCodeV1;
  itemId?: number;
  goalId?: string;
  branchGroupId?: string;
  reasonCodes: readonly string[];
}

export interface StrategyFirstInvariantCheckV1 {
  valid: boolean;
  violations: readonly StrategyFirstInvariantViolationV1[];
}

export interface EvaluateStrategyFirstInvariantsV1Input {
  decision: AdaptiveDecisionStateV1;
  result: Pick<
    StrategyFirstBuildPlannerV1Result,
    'strategy' | 'strategySession' | 'contract' | 'strategyPlan' | 'nextAction' | 'recommendedBuild'
  > & {
    planSession?: AdaptivePlanSessionV1;
  };
  previousStrategy?: Pick<AdaptiveRecommendationStrategyV1, 'strategyId' | 'commitment'>;
}

export interface StrategyFirstInvariantSummaryV1 {
  evaluatedDecisions: number;
  illegalActionRate: number;
  slotViolationRate: number;
  unreachablePlanRate: number;
  redundantAncestorRate: number;
  falseBuildCompleteRate: number;
  mandatoryGoalLostRate: number;
  branchContradictionRate: number;
  archetypeUnexpectedSwitchRate: number;
  coreWithoutExitSlotRate: number;
  unexplainedSituationalRate: number;
  nextActionBuildMismatchRate: number;
}

export function evaluateStrategyFirstInvariantsV1(
  input: EvaluateStrategyFirstInvariantsV1Input,
): StrategyFirstInvariantCheckV1 {
  const violations: StrategyFirstInvariantViolationV1[] = [];
  const ownedItemIds = [...input.decision.state.inventory.heldByItemId.keys()].sort((a, b) => a - b);

  if (isTransactional(input.result.nextAction.type)) {
    const legal = generateRecommendationCandidates({
      state: input.decision.state,
      itemGraph: input.decision.itemGraph,
      rules: candidateGeneratorRulesFromSlotStateV1(input.decision.slots, {
        allowSellOnlyActions: true,
        generateTargetedWaitActions: true,
      }),
    }).some((candidate) =>
      candidate.actionId === input.result.nextAction.actionKey &&
      candidate.feasible &&
      candidate.recommendationEligible,
    );
    if (!legal) {
      violations.push({
        code: 'ILLEGAL_NEXT_ACTION',
        itemId: input.result.nextAction.targetItemId,
        reasonCodes: ['NEXT_ACTION_NOT_IN_CANONICAL_LEGAL_SET'],
      });
    }
  }

  const slots = input.decision.slots;
  const physicalSlotViolation =
    slots.usedFlexSlots > slots.maxFlexSlots ||
    (slots.unlockedFlexSlots !== undefined && slots.usedFlexSlots > slots.unlockedFlexSlots) ||
    slots.activeItemsUsed > slots.maxActiveItems;
  if (physicalSlotViolation) {
    violations.push({ code: 'SLOT_STATE_INVALID', reasonCodes: ['CURRENT_INVENTORY_EXCEEDS_VERIFIED_SLOT_CAPACITY'] });
  }

  if (!input.result.strategyPlan.slotPlan.feasible) {
    violations.push({ code: 'UNREACHABLE_PLAN', reasonCodes: ['STRATEGY_SLOT_PLAN_UNREACHABLE'] });
    if (isTransactional(input.result.nextAction.type)) {
      violations.push({
        code: 'CORE_WITHOUT_EXIT_SLOT',
        itemId: input.result.nextAction.targetItemId,
        reasonCodes: ['TRANSACTION_SELECTED_WITHOUT_FUTURE_SLOT_PATH'],
      });
    }
  }

  for (const row of input.result.recommendedBuild) {
    if (row.status === 'OWNED') continue;
    if (input.decision.itemGraph.isTargetSatisfied(row.itemId, ownedItemIds)) {
      violations.push({
        code: 'REDUNDANT_ANCESTOR_IN_PLAN',
        itemId: row.itemId,
        reasonCodes: ['ACTIONABLE_PLAN_ROW_ALREADY_SATISFIED'],
      });
    }
  }

  const complete = input.result.contract.status === 'COMPLETE' || input.result.strategyPlan.buildStatus === 'COMPLETE';
  if (complete) {
    const hardInvestmentStates = new Map(
      input.result.strategyPlan.investmentPlan.objectives.map((objective) => [objective.objectiveId, objective.state]),
    );
    const hardInvestmentRemaining = input.result.strategy.investmentPolicy.objectives
      .filter((objective) => objective.hard)
      .filter((objective) => {
        const state = hardInvestmentStates.get(objective.objectiveId);
        return state !== 'SATISFIED' && state !== 'WAIVED';
      });
    if (
      input.result.contract.remainingHardGoalIds.length > 0 ||
      input.result.strategyPlan.remainingGoalIds.length > 0 ||
      hardInvestmentRemaining.length > 0 ||
      (input.result.strategyPlan.remainingHardInvestmentObjectiveIds?.length ?? 0) > 0
    ) {
      violations.push({
        code: 'FALSE_BUILD_COMPLETE',
        reasonCodes: ['COMPLETE_WITH_MANDATORY_OBLIGATIONS_REMAINING'],
      });
    }
  }

  for (const goal of input.result.strategy.goals) {
    if (!goal.hard || goal.minSelect <= 0 || input.result.contract.goalStates[goal.goalId] !== 'SATISFIED') continue;
    const satisfiedCount = goal.targetItemIds.filter((itemId) =>
      input.decision.itemGraph.isTargetSatisfied(itemId, ownedItemIds),
    ).length;
    if (satisfiedCount < goal.minSelect) {
      violations.push({
        code: 'MANDATORY_GOAL_LOST',
        goalId: goal.goalId,
        reasonCodes: ['SATISFIED_HARD_GOAL_NOT_SATISFIED_BY_CURRENT_INVENTORY'],
      });
    }
  }

  const plannedActionableItemIds = new Set(
    input.result.recommendedBuild.filter((row) => row.status !== 'OWNED').map((row) => row.itemId),
  );
  const goalById = new Map(input.result.strategy.goals.map((goal) => [goal.goalId, goal]));
  for (const branch of input.result.strategy.branchGroups) {
    const committedGoalId = input.result.contract.committedBranches[branch.branchGroupId];
    if (!committedGoalId || branch.maxSelect !== 1) continue;
    for (const losingGoalId of branch.optionGoalIds) {
      if (losingGoalId === committedGoalId) continue;
      const losingGoal = goalById.get(losingGoalId);
      if (!losingGoal) continue;
      const conflictingItemId = losingGoal.targetItemIds.find((itemId) => plannedActionableItemIds.has(itemId));
      if (conflictingItemId !== undefined) {
        violations.push({
          code: 'BRANCH_CONTRADICTION',
          itemId: conflictingItemId,
          goalId: losingGoalId,
          branchGroupId: branch.branchGroupId,
          reasonCodes: ['LOSING_COMMITTED_BRANCH_PRESENT_IN_ACTIONABLE_PLAN'],
        });
      }
    }
  }

  const situational = input.result.contract.activeSituationalDecision;
  if (situational) {
    const window = input.result.strategy.situationalWindows.find((entry) => entry.windowId === situational.windowId);
    const declaredItems = window?.candidateItemIdsByPurpose?.[situational.purpose] ?? [];
    const declaredByStrategy = declaredItems.includes(situational.targetItemId);
    const discoveredOutsideSkeleton =
      situational.purpose === 'COUNTER_ENEMY_HEROES' &&
      window?.allowedPurposes.includes('COUNTER_ENEMY_HEROES') === true &&
      situational.reasonCodes.includes('MATCHUP_DISCOVERY_OUTSIDE_SKELETON') &&
      situational.reasonCodes.includes('SITUATIONAL_PURPOSE:COUNTER_ENEMY_HEROES') &&
      situational.reasonCodes.includes('SITUATIONAL_WINDOW_ACTIVE');
    const explained =
      !!window &&
      (declaredByStrategy || discoveredOutsideSkeleton) &&
      input.result.nextAction.targetItemId === situational.targetItemId &&
      situational.reasonCodes.includes('SITUATIONAL_OVERRIDE_BEATS_CONTINUE_CORE');
    if (!explained) {
      violations.push({
        code: 'UNEXPLAINED_SITUATIONAL',
        itemId: situational.targetItemId,
        reasonCodes: ['SITUATIONAL_DECISION_MISSING_STRATEGY_OWNED_TRIGGER'],
      });
    }
  }

  const previous = input.previousStrategy;
  if (previous?.commitment === 'COMMITTED' && previous.strategyId !== input.result.strategySession.strategyId) {
    const explicitCommittedSwitch = input.result.strategySession.replanReasons.includes('COMMITTED_STRATEGY_SWITCH');
    const explicitOodRebase = input.result.strategySession.commitment === 'OOD' &&
      input.result.strategySession.replanReasons.includes('OOD_NEAREST_STRATEGY_REBASE');
    if (!explicitCommittedSwitch && !explicitOodRebase) {
      violations.push({
        code: 'UNEXPECTED_COMMITTED_STRATEGY_SWITCH',
        reasonCodes: ['COMMITTED_STRATEGY_CHANGED_WITHOUT_SWITCH_GATE'],
      });
    }
  }

  const mismatch = nextActionBuildMismatch(input.result);
  if (mismatch) violations.push(mismatch);

  return {
    valid: violations.length === 0,
    violations: violations.sort((a, b) =>
      a.code.localeCompare(b.code) ||
      (a.goalId ?? '').localeCompare(b.goalId ?? '') ||
      (a.branchGroupId ?? '').localeCompare(b.branchGroupId ?? '') ||
      (a.itemId ?? 0) - (b.itemId ?? 0),
    ),
  };
}

export function summarizeStrategyFirstInvariantChecksV1(
  checks: readonly StrategyFirstInvariantCheckV1[],
): StrategyFirstInvariantSummaryV1 {
  const count = checks.length;
  const rate = (code: StrategyFirstInvariantViolationCodeV1): number => {
    if (count === 0) return 0;
    return checks.filter((check) => check.violations.some((violation) => violation.code === code)).length / count;
  };
  return {
    evaluatedDecisions: count,
    illegalActionRate: rate('ILLEGAL_NEXT_ACTION'),
    slotViolationRate: rate('SLOT_STATE_INVALID'),
    unreachablePlanRate: rate('UNREACHABLE_PLAN'),
    redundantAncestorRate: rate('REDUNDANT_ANCESTOR_IN_PLAN'),
    falseBuildCompleteRate: rate('FALSE_BUILD_COMPLETE'),
    mandatoryGoalLostRate: rate('MANDATORY_GOAL_LOST'),
    branchContradictionRate: rate('BRANCH_CONTRADICTION'),
    archetypeUnexpectedSwitchRate: rate('UNEXPECTED_COMMITTED_STRATEGY_SWITCH'),
    coreWithoutExitSlotRate: rate('CORE_WITHOUT_EXIT_SLOT'),
    unexplainedSituationalRate: rate('UNEXPLAINED_SITUATIONAL'),
    nextActionBuildMismatchRate: rate('NEXT_ACTION_BUILD_MISMATCH'),
  };
}

function nextActionBuildMismatch(
  result: EvaluateStrategyFirstInvariantsV1Input['result'],
): StrategyFirstInvariantViolationV1 | undefined {
  const planSession = result.planSession;
  const nextItemId = [...result.recommendedBuild]
    .sort((a, b) => a.position - b.position || a.itemId - b.itemId)
    .find((row) => row.status === 'NEXT')?.itemId;
  const targetItemId = result.nextAction.targetItemId;

  if (planSession?.state === 'WAITING') {
    const barrier = planSession.steps.find((step) => step.kind === 'BARRIER' && step.state === 'BLOCKED');
    const barrierTargetItemId = barrier?.barrier && 'targetItemId' in barrier.barrier
      ? barrier.barrier.targetItemId
      : undefined;
    if (
      (result.nextAction.type === 'HOLD' || result.nextAction.type === 'WAIT') &&
      planSession.nextStepId === undefined &&
      nextItemId === undefined &&
      targetItemId === barrierTargetItemId
    ) {
      return undefined;
    }
  }

  if (result.contract.status === 'REPLAN_REQUIRED' || result.contract.status === 'OUT_OF_DISTRIBUTION') return undefined;
  if (result.contract.status === 'COMPLETE') {
    return nextItemId === undefined && targetItemId === undefined
      ? undefined
      : {
          code: 'NEXT_ACTION_BUILD_MISMATCH',
          itemId: targetItemId ?? nextItemId,
          reasonCodes: ['COMPLETE_BUILD_HAS_ACTIONABLE_TARGET'],
        };
  }
  if (isTransactional(result.nextAction.type)) {
    if (targetItemId === undefined || nextItemId !== targetItemId) {
      return {
        code: 'NEXT_ACTION_BUILD_MISMATCH',
        itemId: targetItemId ?? nextItemId,
        reasonCodes: ['TRANSACTION_TARGET_DOES_NOT_MATCH_FIRST_NEXT_ROW'],
      };
    }
    return undefined;
  }
  if ((result.nextAction.type === 'WAIT' || result.nextAction.type === 'HOLD' || result.nextAction.type === 'CONTINUE_CORE') &&
    (targetItemId !== undefined || nextItemId !== undefined) && targetItemId !== nextItemId) {
    return {
      code: 'NEXT_ACTION_BUILD_MISMATCH',
      itemId: targetItemId ?? nextItemId,
      reasonCodes: ['NON_TRANSACTION_TARGET_DOES_NOT_MATCH_FIRST_NEXT_ROW'],
    };
  }
  return undefined;
}

function isTransactional(type: string): boolean {
  return type === 'BUY' || type === 'UPGRADE' || type === 'SELL' || type === 'REPLACE';
}
