import { Injectable } from '@nestjs/common';
import { RecommendationItemGraph } from '@deadlock-live-probe/build-domain';
import { BuildGoalRigidityV1, BuildStrategySpecV1 } from './build-strategy-v1';

export type BuildStrategyValidationErrorCodeV1 =
  | 'SCHEMA_VERSION_UNSUPPORTED'
  | 'STRATEGY_ID_EMPTY'
  | 'HERO_ID_INVALID'
  | 'RULESET_ID_EMPTY'
  | 'SUPPORT_OUT_OF_RANGE'
  | 'STABILITY_OUT_OF_RANGE'
  | 'DUPLICATE_GOAL_ID'
  | 'GOAL_RIGIDITY_INVALID'
  | 'UNKNOWN_PREREQUISITE_GOAL'
  | 'PREREQUISITE_CYCLE'
  | 'INVALID_SELECTION_BOUNDS'
  | 'UNKNOWN_ITEM'
  | 'ITEM_UNAVAILABLE_IN_RULESET'
  | 'DUPLICATE_BRANCH_GROUP_ID'
  | 'BRANCH_UNKNOWN_GOAL'
  | 'BRANCH_SELECTION_BOUNDS_INVALID'
  | 'DUPLICATE_SITUATIONAL_WINDOW_ID'
  | 'SITUATIONAL_WINDOW_BOUNDS_INVALID'
  | 'SITUATIONAL_UNKNOWN_GOAL'
  | 'SITUATIONAL_PURPOSES_INVALID'
  | 'SITUATIONAL_CANDIDATE_INVALID'
  | 'TERMINAL_UNKNOWN_GOAL'
  | 'TERMINAL_GOAL_NOT_HARD'
  | 'INVESTMENT_OBJECTIVE_INVALID'
  | 'DUPLICATE_INVESTMENT_OBJECTIVE_ID'
  | 'INVESTMENT_WEIGHTS_INVALID'
  | 'HARD_INVESTMENT_ACTIVATION_NOT_GUARANTEED'
  | 'SLOT_POLICY_INVALID'
  | 'GOALS_EMPTY';

export interface BuildStrategyValidationErrorV1 {
  code: BuildStrategyValidationErrorCodeV1;
  message: string;
  goalId?: string;
  branchGroupId?: string;
  windowId?: string;
  itemId?: number;
  objectiveId?: string;
}

export interface BuildStrategyValidationResultV1 {
  valid: boolean;
  errors: readonly BuildStrategyValidationErrorV1[];
}

@Injectable()
export class BuildStrategyValidatorV1Service {
  validate(strategy: BuildStrategySpecV1, graph: RecommendationItemGraph): BuildStrategyValidationResultV1 {
    const errors: BuildStrategyValidationErrorV1[] = [];

    if (strategy.schemaVersion !== 1) {
      errors.push({ code: 'SCHEMA_VERSION_UNSUPPORTED', message: `Unsupported schemaVersion ${strategy.schemaVersion}` });
    }
    if (strategy.strategyId.trim() === '') {
      errors.push({ code: 'STRATEGY_ID_EMPTY', message: 'strategyId must be non-empty' });
    }
    if (!Number.isInteger(strategy.heroId) || strategy.heroId <= 0) {
      errors.push({ code: 'HERO_ID_INVALID', message: 'heroId must be a positive integer' });
    }
    if (strategy.rulesetId.trim() === '') {
      errors.push({ code: 'RULESET_ID_EMPTY', message: 'rulesetId must be non-empty' });
    }
    if (!inProbabilityRange(strategy.support)) {
      errors.push({ code: 'SUPPORT_OUT_OF_RANGE', message: 'support must be in [0, 1]' });
    }
    if (!inProbabilityRange(strategy.stability)) {
      errors.push({ code: 'STABILITY_OUT_OF_RANGE', message: 'stability must be in [0, 1]' });
    }

    if (!Array.isArray(strategy.goals) || strategy.goals.length === 0) {
      errors.push({ code: 'GOALS_EMPTY', message: 'Strategy must declare at least one goal' });
    }
    const goalIds = new Set<string>();
    for (const goal of strategy.goals ?? []) {
      if (goalIds.has(goal.goalId)) {
        errors.push({ code: 'DUPLICATE_GOAL_ID', goalId: goal.goalId, message: `Duplicate goal ${goal.goalId}` });
      }
      goalIds.add(goal.goalId);
      const rigidity = (goal as { rigidity?: unknown }).rigidity;
      if (rigidity !== undefined && (!isKnownRigidity(rigidity) || rigidityConflicts(goal.type, goal.hard, rigidity))) {
        errors.push({
          code: 'GOAL_RIGIDITY_INVALID',
          goalId: goal.goalId,
          message: `Goal ${goal.goalId} has invalid rigidity semantics`,
        });
      }
      if (!Number.isInteger(goal.minSelect) || !Number.isInteger(goal.maxSelect) ||
        goal.minSelect < 0 || goal.maxSelect < 1 || goal.minSelect > goal.maxSelect ||
        goal.maxSelect > goal.targetItemIds.length) {
        errors.push({
          code: 'INVALID_SELECTION_BOUNDS',
          goalId: goal.goalId,
          message: `Invalid selection bounds ${goal.minSelect}/${goal.maxSelect}`,
        });
      }
      const targetIds = new Set<number>();
      for (const itemId of goal.targetItemIds) {
        if (targetIds.has(itemId)) {
          errors.push({
            code: 'INVALID_SELECTION_BOUNDS',
            goalId: goal.goalId,
            itemId,
            message: `Goal ${goal.goalId} contains duplicate item ${itemId}`,
          });
        }
        targetIds.add(itemId);
        validateItem(errors, graph, strategy.rulesetId, itemId, { goalId: goal.goalId });
        if (goal.lifecycleByItemId[itemId] === undefined) {
          errors.push({
            code: 'INVALID_SELECTION_BOUNDS',
            goalId: goal.goalId,
            itemId,
            message: `Goal ${goal.goalId} is missing lifecycle semantics for item ${itemId}`,
          });
        }
      }
    }

    for (const goal of strategy.goals) {
      for (const prerequisiteId of goal.prerequisiteGoalIds) {
        if (!goalIds.has(prerequisiteId)) {
          errors.push({
            code: 'UNKNOWN_PREREQUISITE_GOAL',
            goalId: goal.goalId,
            message: `Goal ${goal.goalId} references unknown prerequisite ${prerequisiteId}`,
          });
        }
      }
    }
    if (hasGoalCycle(strategy)) {
      errors.push({ code: 'PREREQUISITE_CYCLE', message: 'Goal prerequisite graph contains a cycle' });
    }

    const branchIds = new Set<string>();
    const branchGoalIds = new Set<string>();
    for (const branch of strategy.branchGroups) {
      if (branchIds.has(branch.branchGroupId)) {
        errors.push({
          code: 'DUPLICATE_BRANCH_GROUP_ID',
          branchGroupId: branch.branchGroupId,
          message: `Duplicate branch group ${branch.branchGroupId}`,
        });
      }
      branchIds.add(branch.branchGroupId);
      const uniqueOptions = new Set(branch.optionGoalIds);
      if (uniqueOptions.size !== branch.optionGoalIds.length) {
        errors.push({
          code: 'BRANCH_SELECTION_BOUNDS_INVALID',
          branchGroupId: branch.branchGroupId,
          message: `Branch group ${branch.branchGroupId} contains duplicate options`,
        });
      }
      for (const goalId of branch.optionGoalIds) {
        branchGoalIds.add(goalId);
        if (!goalIds.has(goalId)) {
          errors.push({
            code: 'BRANCH_UNKNOWN_GOAL',
            branchGroupId: branch.branchGroupId,
            goalId,
            message: `Branch group ${branch.branchGroupId} references unknown goal ${goalId}`,
          });
        }
      }
      if (!Number.isInteger(branch.minSelect) || !Number.isInteger(branch.maxSelect) ||
        branch.minSelect < 1 || branch.maxSelect < branch.minSelect || branch.maxSelect > uniqueOptions.size) {
        errors.push({
          code: 'BRANCH_SELECTION_BOUNDS_INVALID',
          branchGroupId: branch.branchGroupId,
          message: `Invalid branch bounds ${branch.minSelect}/${branch.maxSelect}`,
        });
      }
    }

    const windowIds = new Set<string>();
    for (const window of strategy.situationalWindows) {
      if (windowIds.has(window.windowId)) {
        errors.push({
          code: 'DUPLICATE_SITUATIONAL_WINDOW_ID',
          windowId: window.windowId,
          message: `Duplicate situational window ${window.windowId}`,
        });
      }
      windowIds.add(window.windowId);
      if (!Number.isInteger(window.maxSlots) || window.maxSlots < 0 ||
        !Number.isFinite(window.maxSouls) || window.maxSouls < 0 ||
        !Number.isFinite(window.maxCoreDelaySouls) || window.maxCoreDelaySouls < 0) {
        errors.push({
          code: 'SITUATIONAL_WINDOW_BOUNDS_INVALID',
          windowId: window.windowId,
          message: `Invalid bounds for situational window ${window.windowId}`,
        });
      }
      if (window.allowedPurposes.length === 0 || new Set(window.allowedPurposes).size !== window.allowedPurposes.length) {
        errors.push({
          code: 'SITUATIONAL_PURPOSES_INVALID',
          windowId: window.windowId,
          message: `Situational window ${window.windowId} must contain unique allowed purposes`,
        });
      }
      for (const goalId of [...window.afterGoalIds, ...window.beforeGoalIds]) {
        if (!goalIds.has(goalId)) {
          errors.push({
            code: 'SITUATIONAL_UNKNOWN_GOAL',
            windowId: window.windowId,
            goalId,
            message: `Situational window ${window.windowId} references unknown goal ${goalId}`,
          });
        }
      }
      for (const [purpose, candidateIds] of Object.entries(window.candidateItemIdsByPurpose ?? {})) {
        if (!window.allowedPurposes.includes(purpose as any)) {
          errors.push({
            code: 'SITUATIONAL_CANDIDATE_INVALID',
            windowId: window.windowId,
            message: `Situational window ${window.windowId} maps disallowed purpose ${purpose}`,
          });
        }
        const uniqueCandidateIds = new Set(candidateIds ?? []);
        if (uniqueCandidateIds.size !== (candidateIds ?? []).length) {
          errors.push({
            code: 'SITUATIONAL_CANDIDATE_INVALID',
            windowId: window.windowId,
            message: `Situational window ${window.windowId} contains duplicate candidates for ${purpose}`,
          });
        }
        for (const itemId of uniqueCandidateIds) {
          validateItem(errors, graph, strategy.rulesetId, itemId, { windowId: window.windowId });
        }
      }
    }

    const goalById = new Map(strategy.goals.map((goal) => [goal.goalId, goal]));
    for (const goalId of strategy.terminalPolicy.requiredGoalIds) {
      const goal = goalById.get(goalId);
      if (!goal) {
        errors.push({ code: 'TERMINAL_UNKNOWN_GOAL', goalId, message: `Terminal policy references unknown goal ${goalId}` });
      } else if (!goal.hard) {
        errors.push({ code: 'TERMINAL_GOAL_NOT_HARD', goalId, message: `Terminal required goal ${goalId} must be hard` });
      } else if (goal.rigidity !== undefined && goal.rigidity !== 'HARD_CORE') {
        errors.push({
          code: 'GOAL_RIGIDITY_INVALID',
          goalId,
          message: `Terminal required goal ${goalId} must be HARD_CORE when rigidity is explicit`,
        });
      }
    }

    const objectiveIds = new Set<string>();
    for (const objective of strategy.investmentPolicy.objectives) {
      if (!objective.objectiveId || objectiveIds.has(objective.objectiveId)) {
        errors.push({
          code: 'DUPLICATE_INVESTMENT_OBJECTIVE_ID',
          objectiveId: objective.objectiveId,
          message: `Investment objective ID must be non-empty and unique: ${objective.objectiveId}`,
        });
      }
      objectiveIds.add(objective.objectiveId);
      const target = objective.targetBreakpoint ?? objective.minimumValue;
      if (objective.hard && target === undefined) {
        errors.push({
          code: 'INVESTMENT_OBJECTIVE_INVALID',
          objectiveId: objective.objectiveId,
          message: `Hard investment objective ${objective.objectiveId} requires a target`,
        });
      }
      if (target !== undefined && (!Number.isFinite(target) || target <= 0)) {
        errors.push({
          code: 'INVESTMENT_OBJECTIVE_INVALID',
          objectiveId: objective.objectiveId,
          message: `Investment objective ${objective.objectiveId} has invalid target`,
        });
      }
      if (objective.targetBreakpoint !== undefined && objective.minimumValue !== undefined) {
        errors.push({
          code: 'INVESTMENT_OBJECTIVE_INVALID',
          objectiveId: objective.objectiveId,
          message: `Investment objective ${objective.objectiveId} must use one target semantic`,
        });
      }
      for (const goalId of [...objective.activateAfterGoalIds, ...objective.deactivateAfterGoalIds]) {
        if (!goalIds.has(goalId)) {
          errors.push({
            code: 'INVESTMENT_OBJECTIVE_INVALID',
            objectiveId: objective.objectiveId,
            goalId,
            message: `Investment objective ${objective.objectiveId} references unknown goal ${goalId}`,
          });
        }
      }
      if (objective.hard) {
        for (const goalId of objective.activateAfterGoalIds) {
          const activationGoal = goalById.get(goalId);
          if (!activationGoal?.hard || branchGoalIds.has(goalId)) {
            errors.push({
              code: 'HARD_INVESTMENT_ACTIVATION_NOT_GUARANTEED',
              objectiveId: objective.objectiveId,
              goalId,
              message: `Hard investment objective ${objective.objectiveId} depends on non-guaranteed goal ${goalId}`,
            });
          }
        }
      }
    }

    const weights = strategy.investmentPolicy.preferredWeights;
    const weightValues = [weights.weapon, weights.vitality, weights.spirit];
    if (weightValues.some((value) => !Number.isFinite(value) || value < 0) ||
      weightValues.reduce((sum, value) => sum + value, 0) <= 0) {
      errors.push({
        code: 'INVESTMENT_WEIGHTS_INVALID',
        message: 'Investment preferred weights must be finite, non-negative, and have positive total mass',
      });
    }

    if (!Number.isInteger(strategy.slotPolicy.reservedSituationalSlots) || strategy.slotPolicy.reservedSituationalSlots < 0 ||
      !Number.isInteger(strategy.slotPolicy.maxTemporarySlots) || strategy.slotPolicy.maxTemporarySlots < 0) {
      errors.push({ code: 'SLOT_POLICY_INVALID', message: 'Slot policy values must be non-negative integers' });
    }

    const stableErrors = errors.sort((a, b) =>
      a.code.localeCompare(b.code) ||
      (a.objectiveId ?? '').localeCompare(b.objectiveId ?? '') ||
      (a.goalId ?? '').localeCompare(b.goalId ?? '') ||
      (a.branchGroupId ?? '').localeCompare(b.branchGroupId ?? '') ||
      (a.windowId ?? '').localeCompare(b.windowId ?? '') ||
      (a.itemId ?? 0) - (b.itemId ?? 0),
    );
    return { valid: stableErrors.length === 0, errors: stableErrors };
  }
}

function validateItem(
  errors: BuildStrategyValidationErrorV1[],
  graph: RecommendationItemGraph,
  rulesetId: string,
  itemId: number,
  context: Pick<BuildStrategyValidationErrorV1, 'goalId' | 'windowId'>,
): void {
  const item = graph.getItem(itemId);
  if (!item) {
    errors.push({ ...context, code: 'UNKNOWN_ITEM', itemId, message: `Unknown item ${itemId}` });
    return;
  }
  if (!item.availableRulesetIds.includes(rulesetId)) {
    errors.push({
      ...context,
      code: 'ITEM_UNAVAILABLE_IN_RULESET',
      itemId,
      message: `Item ${itemId} is unavailable in ruleset ${rulesetId}`,
    });
  }
}

function inProbabilityRange(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function isKnownRigidity(value: unknown): value is BuildGoalRigidityV1 {
  return value === 'HARD_CORE' || value === 'SOFT_CORE' || value === 'FLEX';
}

function rigidityConflicts(type: BuildStrategySpecV1['goals'][number]['type'], hard: boolean, rigidity: BuildGoalRigidityV1): boolean {
  if (rigidity === 'HARD_CORE') return !hard;
  if (rigidity === 'SOFT_CORE') return hard;
  if (type === 'BRANCH' || type === 'SITUATIONAL_RESERVATION') return false;
  return false;
}

function hasGoalCycle(strategy: BuildStrategySpecV1): boolean {
  const dependencies = new Map(strategy.goals.map((goal) => [goal.goalId, goal.prerequisiteGoalIds]));
  const visited = new Set<string>();
  const visiting = new Set<string>();

  const visit = (goalId: string): boolean => {
    if (visiting.has(goalId)) return true;
    if (visited.has(goalId)) return false;
    visiting.add(goalId);
    for (const dependency of dependencies.get(goalId) ?? []) {
      if (!dependencies.has(dependency)) continue;
      if (visit(dependency)) return true;
    }
    visiting.delete(goalId);
    visited.add(goalId);
    return false;
  };

  return strategy.goals.some((goal) => visit(goal.goalId));
}
