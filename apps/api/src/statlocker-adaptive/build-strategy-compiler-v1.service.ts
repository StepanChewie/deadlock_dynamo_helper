import { Injectable } from '@nestjs/common';
import { RecommendationItemGraph } from '@deadlock-live-probe/build-domain';
import { BuildArchetypeV1 } from './build-archetype.types';
import {
  BuildInvestmentObjectiveV1,
  BuildItemLifecycleV1,
  BuildSituationalWindowV1,
  BuildStrategyBranchGroupV1,
  BuildStrategyGoalV1,
  BuildStrategyPhaseV1,
  BuildStrategySpecV1,
} from './build-strategy-v1';
import { PlannerInvestmentVectorV2, PlannerTrajectoryV2 } from './planner-trajectory-v2';

export interface BuildStrategyCompilerV1Input {
  archetype: BuildArchetypeV1;
  trajectories: readonly PlannerTrajectoryV2[];
  itemGraph: RecommendationItemGraph;
}

interface PositionCandidate {
  itemId: number;
  count: number;
  support: number;
  medianTimeSec: number;
  upgradeRate: number;
}

const MIN_BRANCH_SAMPLE_COUNT = 2;
const MAX_COMPILED_BRANCH_PATHS = 64;

@Injectable()
export class BuildStrategyCompilerV1Service {
  compile(input: BuildStrategyCompilerV1Input): BuildStrategySpecV1 {
    const members = input.trajectories
      .filter((trace) => input.archetype.memberTraceIds.includes(trace.traceId))
      .sort((a, b) => a.traceId.localeCompare(b.traceId));
    if (members.length === 0) throw new Error(`Archetype ${input.archetype.archetypeId} has no supplied member trajectories`);

    const maxPosition = Math.max(...members.map((trace) => trace.transactions.length));
    const goals: BuildStrategyGoalV1[] = [];
    const branchGroups: BuildStrategyBranchGroupV1[] = [];
    let priorMilestoneGoalIds: string[] = [];
    let compiledBranchPathCount = 1;

    for (let position = 0; position < maxPosition; position += 1) {
      const candidates = positionCandidates(members, position);
      if (candidates.length === 0) continue;
      const substantial = candidates.filter((entry) =>
        entry.count >= MIN_BRANCH_SAMPLE_COUNT && entry.support >= 0.20,
      );
      const branchCoverage = substantial.reduce((sum, entry) => sum + entry.support, 0);
      const branchSupported = substantial.length >= 2 && branchCoverage >= 0.75 && substantial[0].support < 0.70;
      const isBranch = branchSupported &&
        compiledBranchPathCount * substantial.length <= MAX_COMPILED_BRANCH_PATHS;

      if (isBranch) {
        const optionGoalIds: string[] = [];
        for (const candidate of substantial) {
          const goalId = stableGoalId(position, candidate.itemId, 'branch');
          goals.push(makeGoal(
            goalId,
            candidate,
            priorMilestoneGoalIds,
            input.itemGraph,
            true,
            'BRANCH',
          ));
          optionGoalIds.push(goalId);
        }
        branchGroups.push({
          branchGroupId: `branch:${position}:${substantial.map((entry) => entry.itemId).sort((a, b) => a - b).join(',')}`,
          optionGoalIds,
          minSelect: 1,
          maxSelect: 1,
        });
        compiledBranchPathCount *= substantial.length;
        priorMilestoneGoalIds = optionGoalIds;
        continue;
      }

      const winner = candidates[0];
      if (winner.support < 0.35) continue;
      const hard = winner.support >= 0.62;
      const goalId = stableGoalId(position, winner.itemId, hard ? 'core' : 'soft');
      goals.push(makeGoal(
        goalId,
        winner,
        priorMilestoneGoalIds,
        input.itemGraph,
        hard,
        undefined,
      ));
      if (hard) priorMilestoneGoalIds = [goalId];
    }

    markLifecycleFromObservedTransitions(goals, members, input.itemGraph);

    const terminalRequiredGoalIds = goals
      .filter((goal) => goal.hard && !branchGroups.some((branch) => branch.optionGoalIds.includes(goal.goalId)))
      .map((goal) => goal.goalId)
      .slice(-16);
    const representative = members.find((trace) => trace.traceId === input.archetype.representativeTraceId) ?? members[0];
    const investment = representative.archetypeFeaturePayload.finalInvestment;
    const preferredWeights = normalizedInvestmentWeights(investment);
    const investmentObjectives = inferSoftInvestmentObjectives(members, goals, terminalRequiredGoalIds);
    const situationalWindows = inferSituationalWindows(members, goals, input.itemGraph);

    return {
      schemaVersion: 1,
      strategyId: `strategy:${input.archetype.archetypeId}`,
      heroId: input.archetype.heroId,
      rulesetId: input.archetype.rulesetId,
      sourcePatchId: input.archetype.patchId,
      support: input.archetype.support,
      stability: input.archetype.stability,
      representativeTraceId: input.archetype.representativeTraceId,
      goals,
      branchGroups,
      situationalWindows,
      investmentPolicy: {
        objectives: investmentObjectives,
        preferredWeights,
      },
      slotPolicy: {
        reservedSituationalSlots: situationalWindows.length > 0 ? 1 : inferSituationalReservationCount(members),
        maxTemporarySlots: Math.max(0, countTemporaryGoals(goals)),
      },
      terminalPolicy: {
        requiredGoalIds: terminalRequiredGoalIds,
        allowWaiveSoftGoals: true,
      },
    };
  }
}

function positionCandidates(traces: readonly PlannerTrajectoryV2[], position: number): PositionCandidate[] {
  const entries = traces
    .map((trace) => trace.transactions[position])
    .filter((entry): entry is PlannerTrajectoryV2['transactions'][number] => entry !== undefined && entry.targetItemId !== undefined);
  const byItem = new Map<number, { times: number[]; upgradeCount: number }>();
  for (const entry of entries) {
    const itemId = entry.targetItemId!;
    const current = byItem.get(itemId) ?? { times: [], upgradeCount: 0 };
    current.times.push(entry.gameTimeSec);
    if (entry.actionType === 'UPGRADE') current.upgradeCount += 1;
    byItem.set(itemId, current);
  }
  return [...byItem.entries()]
    .map(([itemId, value]) => ({
      itemId,
      count: value.times.length,
      support: value.times.length / traces.length,
      medianTimeSec: median(value.times),
      upgradeRate: value.upgradeCount / Math.max(1, value.times.length),
    }))
    .sort((a, b) => b.support - a.support || a.medianTimeSec - b.medianTimeSec || a.itemId - b.itemId);
}

function makeGoal(
  goalId: string,
  candidate: PositionCandidate,
  prerequisiteGoalIds: readonly string[],
  graph: RecommendationItemGraph,
  hard: boolean,
  forcedType?: BuildStrategyGoalV1['type'],
): BuildStrategyGoalV1 {
  const item = graph.getItem(candidate.itemId);
  if (!item) throw new Error(`Strategy compiler cannot reference unknown item ${candidate.itemId}`);
  const type = forcedType ?? (candidate.upgradeRate >= 0.5 || item.upgradeRecipes.length > 0 ? 'UPGRADE' : 'CORE');
  const rigidity = type === 'BRANCH' ? 'FLEX' as const : hard ? 'HARD_CORE' as const : 'SOFT_CORE' as const;
  return {
    goalId,
    type,
    phase: phaseForTime(candidate.medianTimeSec),
    targetItemIds: [candidate.itemId],
    minSelect: hard ? 1 : 0,
    maxSelect: 1,
    prerequisiteGoalIds: [...prerequisiteGoalIds],
    hard,
    rigidity,
    lifecycleByItemId: { [candidate.itemId]: 'PERMANENT_CORE' },
    rationaleCodes: [hard ? 'ARCHETYPE_CORE_SUPPORT' : 'ARCHETYPE_SOFT_SUPPORT', `SUPPORT:${candidate.support.toFixed(3)}`],
  };
}

function markLifecycleFromObservedTransitions(
  goals: BuildStrategyGoalV1[],
  traces: readonly PlannerTrajectoryV2[],
  graph: RecommendationItemGraph,
): void {
  const soldItemIds = new Set<number>();
  for (const trace of traces) {
    for (const transaction of trace.transactions) {
      if ((transaction.actionType === 'SELL' || transaction.actionType === 'REPLACE') && transaction.sellItemId !== undefined) {
        soldItemIds.add(transaction.sellItemId);
      }
    }
  }
  const upgradeTargets = goals
    .filter((goal) => goal.type === 'UPGRADE')
    .flatMap((goal) => goal.targetItemIds);
  for (let index = 0; index < goals.length; index += 1) {
    const goal = goals[index];
    const lifecycleByItemId: Record<number, BuildItemLifecycleV1> = { ...goal.lifecycleByItemId };
    for (const itemId of goal.targetItemIds) {
      if (soldItemIds.has(itemId)) lifecycleByItemId[itemId] = 'TEMPORARY_EARLY';
      else if (upgradeTargets.some((target) => graph.isComponentAncestor(itemId, target))) lifecycleByItemId[itemId] = 'UPGRADE_COMPONENT';
    }
    goals[index] = { ...goal, lifecycleByItemId };
  }
}

function inferSoftInvestmentObjectives(
  traces: readonly PlannerTrajectoryV2[],
  goals: readonly BuildStrategyGoalV1[],
  terminalRequiredGoalIds: readonly string[],
): BuildInvestmentObjectiveV1[] {
  const types = ['weapon', 'vitality', 'spirit'] as const;
  const activationGoal = goals.find((goal) => goal.hard && goal.phase === 'EARLY')
    ?? goals.find((goal) => goal.hard);
  const deactivateGoal = terminalRequiredGoalIds[terminalRequiredGoalIds.length - 1];
  return types.flatMap((type) => {
    const values = traces
      .map((trace) => Math.max(0, trace.archetypeFeaturePayload.finalInvestment[type]))
      .filter((value) => Number.isFinite(value));
    const positiveSupport = values.filter((value) => value > 0).length / Math.max(1, traces.length);
    const target = median(values);
    if (target <= 0 || positiveSupport < 0.70 || relativeMedianDeviation(values, target) > 0.35) return [];
    return [{
      objectiveId: `investment:${type}:${Math.round(target)}`,
      type,
      hard: false,
      minimumValue: Math.max(1, Math.round(target)),
      activateAfterGoalIds: activationGoal ? [activationGoal.goalId] : [],
      deactivateAfterGoalIds: deactivateGoal ? [deactivateGoal] : [],
      reasonCodes: [
        'ARCHETYPE_INVESTMENT_MILESTONE',
        `SUPPORT:${positiveSupport.toFixed(3)}`,
      ],
    } satisfies BuildInvestmentObjectiveV1];
  });
}

function inferSituationalWindows(
  traces: readonly PlannerTrajectoryV2[],
  goals: readonly BuildStrategyGoalV1[],
  graph: RecommendationItemGraph,
): BuildSituationalWindowV1[] {
  if (traces.length < 3) return [];
  const finalSets = traces.map((trace) => new Set(trace.archetypeFeaturePayload.finalInventoryItemIds));
  const mandatoryItems = new Set(goals.filter((goal) => goal.hard).flatMap((goal) => goal.targetItemIds));
  const allFinalItems = new Set(finalSets.flatMap((set) => [...set]));
  const candidates = [...allFinalItems]
    .filter((itemId) => !mandatoryItems.has(itemId))
    .map((itemId) => ({
      itemId,
      frequency: finalSets.filter((set) => set.has(itemId)).length / finalSets.length,
    }))
    .filter((entry) => entry.frequency >= 0.15 && entry.frequency < 0.45)
    .filter((entry) => graph.getItem(entry.itemId) !== undefined)
    .sort((a, b) => b.frequency - a.frequency || a.itemId - b.itemId)
    .slice(0, 6);
  if (candidates.length === 0) return [];
  const afterGoal = goals.find((goal) => goal.hard && goal.phase === 'EARLY') ?? goals.find((goal) => goal.hard);
  const beforeGoal = [...goals].reverse().find((goal) => goal.hard);
  const maxCost = Math.max(...candidates.map((entry) => effectiveItemCost(entry.itemId, graph)), 0);
  return [{
    windowId: `situational:utility:${candidates.map((entry) => entry.itemId).join(',')}`,
    afterGoalIds: afterGoal ? [afterGoal.goalId] : [],
    beforeGoalIds: beforeGoal && beforeGoal.goalId !== afterGoal?.goalId ? [beforeGoal.goalId] : [],
    maxSlots: 1,
    maxSouls: maxCost,
    maxCoreDelaySouls: maxCost,
    allowedPurposes: ['UTILITY'],
    candidateItemIdsByPurpose: { UTILITY: candidates.map((entry) => entry.itemId) },
  }];
}

function normalizedInvestmentWeights(
  investment: PlannerInvestmentVectorV2,
): { weapon: number; vitality: number; spirit: number } {
  const values = {
    weapon: Math.max(0, investment.weapon),
    vitality: Math.max(0, investment.vitality),
    spirit: Math.max(0, investment.spirit),
  };
  const total = values.weapon + values.vitality + values.spirit;
  if (total <= 0) return { weapon: 1 / 3, vitality: 1 / 3, spirit: 1 / 3 };
  return {
    weapon: values.weapon / total,
    vitality: values.vitality / total,
    spirit: values.spirit / total,
  };
}

function effectiveItemCost(itemId: number, graph: RecommendationItemGraph): number {
  const item = graph.getItem(itemId);
  if (!item) return 0;
  const costs = [
    ...(Number.isFinite(item.directPurchaseCost) ? [Math.max(0, item.directPurchaseCost as number)] : []),
    ...item.upgradeRecipes.map((recipe) => Math.max(0, recipe.soulsCost)),
  ];
  return costs.length > 0 ? Math.min(...costs) : 0;
}

function inferSituationalReservationCount(traces: readonly PlannerTrajectoryV2[]): number {
  if (traces.length < 3) return 0;
  const finalSets = traces.map((trace) => new Set(trace.archetypeFeaturePayload.finalInventoryItemIds));
  const allItems = new Set(finalSets.flatMap((set) => [...set]));
  const lowFrequencyFinals = [...allItems].filter((itemId) => {
    const frequency = finalSets.filter((set) => set.has(itemId)).length / finalSets.length;
    return frequency >= 0.15 && frequency < 0.45;
  });
  return lowFrequencyFinals.length > 0 ? 1 : 0;
}

function countTemporaryGoals(goals: readonly BuildStrategyGoalV1[]): number {
  return goals.filter((goal) => Object.values(goal.lifecycleByItemId).includes('TEMPORARY_EARLY')).length;
}

function phaseForTime(timeSec: number): BuildStrategyPhaseV1 {
  if (timeSec < 600) return 'EARLY';
  if (timeSec < 1_500) return 'MID';
  return 'LATE';
}

function stableGoalId(position: number, itemId: number, kind: string): string {
  return `goal:${position}:${kind}:${itemId}`;
}

function relativeMedianDeviation(values: readonly number[], center: number): number {
  if (values.length === 0 || center <= 0) return 1;
  return median(values.map((value) => Math.abs(value - center))) / Math.max(1, center);
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}
