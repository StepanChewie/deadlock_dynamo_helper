import { Injectable } from '@nestjs/common';
import { RecommendationItemGraph } from '@deadlock-live-probe/build-domain';
import {
  BuildContractV1,
  BuildGoalStateV1,
  BuildStrategyGoalV1,
  BuildStrategySpecV1,
  BuildStrategyCommitmentV1,
  phaseOrderBuildStrategyV1,
} from './build-strategy-v1';

export interface ResolveBuildContractV1Input {
  strategy: BuildStrategySpecV1;
  itemGraph: RecommendationItemGraph;
  ownedItemIds: readonly number[];
  selectedBranches?: Readonly<Record<string, string>>;
  committedBranches?: Readonly<Record<string, string>>;
  commitment?: BuildStrategyCommitmentV1;
  waivedGoalIds?: readonly string[];
  blockedGoalIds?: readonly string[];
  immediateMode?: 'TRANSACTION' | 'HOLD' | 'WAIT';
}

@Injectable()
export class BuildContractV1Service {
  resolve(input: ResolveBuildContractV1Input): BuildContractV1 {
    const owned = new Set(input.ownedItemIds);
    const selectedBranches = normalizeBranchState(input.strategy, input.selectedBranches ?? {});
    const committedBranches = normalizeBranchState(input.strategy, input.committedBranches ?? {});
    const waived = new Set(input.waivedGoalIds ?? []);
    const blocked = new Set(input.blockedGoalIds ?? []);
    const skippedByBranch = losingBranchGoalIds(input.strategy, selectedBranches, committedBranches);
    const goalStates: Record<string, BuildGoalStateV1> = {};

    for (const goal of input.strategy.goals) {
      if (skippedByBranch.has(goal.goalId)) {
        goalStates[goal.goalId] = 'SKIPPED';
      } else if (waived.has(goal.goalId) && !goal.hard) {
        goalStates[goal.goalId] = 'WAIVED';
      } else if (goalSatisfied(goal, owned, input.itemGraph)) {
        goalStates[goal.goalId] = 'SATISFIED';
      } else if (blocked.has(goal.goalId)) {
        goalStates[goal.goalId] = 'BLOCKED';
      } else {
        goalStates[goal.goalId] = 'LOCKED';
      }
    }

    let changed = true;
    while (changed) {
      changed = false;
      for (const goal of input.strategy.goals) {
        if (goalStates[goal.goalId] !== 'LOCKED') continue;
        const prerequisitesResolved = goal.prerequisiteGoalIds.every((goalId) =>
          goalStates[goalId] === 'SATISFIED' || goalStates[goalId] === 'SKIPPED' || goalStates[goalId] === 'WAIVED',
        );
        if (prerequisitesResolved) {
          goalStates[goal.goalId] = 'READY';
          changed = true;
        }
      }
    }

    // Hard goals take strict priority over soft/optional goals. When all hard goals
    // are completed, the contract advances into remaining soft core progression goals
    // instead of prematurely marking the build complete.
    const orderedHardReady = input.strategy.goals
      .filter((goal) => goal.hard && goalStates[goal.goalId] === 'READY')
      .filter((goal) => !goalExcludedByUnselectedBranch(input.strategy, goal.goalId, selectedBranches))
      .sort((a, b) =>
        phaseOrderBuildStrategyV1(a.phase) - phaseOrderBuildStrategyV1(b.phase) ||
        input.strategy.goals.indexOf(a) - input.strategy.goals.indexOf(b),
      );
    const orderedSoftReady = input.strategy.goals
      .filter((goal) => !goal.hard && goalStates[goal.goalId] === 'READY')
      .filter((goal) => !goalExcludedByUnselectedBranch(input.strategy, goal.goalId, selectedBranches))
      .filter((goal) => !goal.targetItemIds.every((id) => input.itemGraph.isTargetSatisfied(id, owned)))
      .sort((a, b) =>
        phaseOrderBuildStrategyV1(a.phase) - phaseOrderBuildStrategyV1(b.phase) ||
        input.strategy.goals.indexOf(a) - input.strategy.goals.indexOf(b),
      );
    const active = orderedHardReady[0] ?? orderedSoftReady[0];
    if (active) goalStates[active.goalId] = 'ACTIVE';

    const effectiveHardGoals = input.strategy.goals.filter((goal) =>
      goal.hard && !skippedByBranch.has(goal.goalId) && !goalExcludedByUnselectedBranch(input.strategy, goal.goalId, selectedBranches),
    );
    const terminalRequired = new Set(input.strategy.terminalPolicy.requiredGoalIds);
    const remainingHardGoalIds = effectiveHardGoals
      .filter((goal) => !isResolved(goalStates[goal.goalId]))
      .map((goal) => goal.goalId);
    const terminalRemaining = [...terminalRequired].filter((goalId) => !isResolved(goalStates[goalId]));
    const mandatoryRemaining = [...new Set([...remainingHardGoalIds, ...terminalRemaining])];
    const unresolvedBlockedHard = mandatoryRemaining.some((goalId) => goalStates[goalId] === 'BLOCKED');

    let status: BuildContractV1['status'];
    if ((input.commitment ?? 'PROVISIONAL') === 'OOD') status = 'OUT_OF_DISTRIBUTION';
    else if (unresolvedBlockedHard && !active) status = 'REPLAN_REQUIRED';
    else if (mandatoryRemaining.length === 0 && !active) status = 'COMPLETE';
    else if (input.immediateMode === 'HOLD' || input.immediateMode === 'WAIT') status = 'WAITING';
    else status = 'IN_PROGRESS';

    const temporaryItemIds = input.strategy.goals
      .flatMap((goal) => goal.targetItemIds
        .filter((itemId) => goal.lifecycleByItemId[itemId] === 'TEMPORARY_EARLY' && owned.has(itemId)))
      .filter((itemId, index, all) => all.indexOf(itemId) === index)
      .sort((a, b) => a - b);
    const reservedSituationalWindowIds = input.strategy.situationalWindows
      .filter((window) => situationalWindowOpen(window.afterGoalIds, window.beforeGoalIds, goalStates))
      .map((window) => window.windowId)
      .sort();

    return {
      strategyId: input.strategy.strategyId,
      status,
      commitment: input.commitment ?? (Object.keys(committedBranches).length > 0 ? 'COMMITTED' : 'PROVISIONAL'),
      currentGoalId: active?.goalId,
      goalStates,
      selectedBranches,
      committedBranches,
      temporaryItemIds,
      reservedSituationalWindowIds,
      remainingHardGoalIds: mandatoryRemaining,
      completionReasonCodes: completionReasonCodes(status, mandatoryRemaining, unresolvedBlockedHard),
    };
  }
}

function goalSatisfied(
  goal: BuildStrategyGoalV1,
  owned: ReadonlySet<number>,
  graph: RecommendationItemGraph,
): boolean {
  if (goal.minSelect === 0) return false;
  const satisfiedCount = goal.targetItemIds.filter((itemId) => graph.isTargetSatisfied(itemId, owned)).length;
  return satisfiedCount >= goal.minSelect;
}

function normalizeBranchState(
  strategy: BuildStrategySpecV1,
  supplied: Readonly<Record<string, string>>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const group of strategy.branchGroups) {
    const selected = supplied[group.branchGroupId];
    if (selected && group.optionGoalIds.includes(selected)) result[group.branchGroupId] = selected;
  }
  return result;
}

function losingBranchGoalIds(
  strategy: BuildStrategySpecV1,
  selected: Readonly<Record<string, string>>,
  committed: Readonly<Record<string, string>>,
): ReadonlySet<string> {
  const result = new Set<string>();
  for (const group of strategy.branchGroups) {
    const winner = committed[group.branchGroupId] ?? selected[group.branchGroupId];
    if (!winner || group.maxSelect > 1) continue;
    for (const goalId of group.optionGoalIds) if (goalId !== winner) result.add(goalId);
  }
  return result;
}

function goalExcludedByUnselectedBranch(
  strategy: BuildStrategySpecV1,
  goalId: string,
  selected: Readonly<Record<string, string>>,
): boolean {
  for (const group of strategy.branchGroups) {
    if (!group.optionGoalIds.includes(goalId)) continue;
    const winner = selected[group.branchGroupId];
    if (!winner) return true;
    return group.maxSelect === 1 && winner !== goalId;
  }
  return false;
}

function isResolved(state: BuildGoalStateV1 | undefined): boolean {
  return state === 'SATISFIED' || state === 'SKIPPED' || state === 'WAIVED';
}

function situationalWindowOpen(
  afterGoalIds: readonly string[],
  beforeGoalIds: readonly string[],
  states: Readonly<Record<string, BuildGoalStateV1>>,
): boolean {
  const afterSatisfied = afterGoalIds.every((goalId) => isResolved(states[goalId]));
  const beforeStillOpen = beforeGoalIds.every((goalId) => !isResolved(states[goalId]));
  return afterSatisfied && beforeStillOpen;
}

function completionReasonCodes(
  status: BuildContractV1['status'],
  remaining: readonly string[],
  blocked: boolean,
): string[] {
  if (status === 'COMPLETE') return ['ALL_MANDATORY_STRATEGY_OBLIGATIONS_RESOLVED'];
  if (status === 'OUT_OF_DISTRIBUTION') return ['STRATEGY_OUT_OF_DISTRIBUTION'];
  if (status === 'REPLAN_REQUIRED') return ['MANDATORY_GOAL_BLOCKED', ...remaining.map((goalId) => `REMAINING:${goalId}`)];
  return [blocked ? 'MANDATORY_GOAL_BLOCKED' : 'MANDATORY_GOALS_REMAIN', ...remaining.map((goalId) => `REMAINING:${goalId}`)];
}
