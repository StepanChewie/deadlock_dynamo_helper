import {
  InventorySlotType,
  RecommendationCandidate,
  RecommendationItemGraph,
} from '@deadlock-live-probe/build-domain';
import type {
  BuildContractV1 as CompatibilityBuildContractV1,
} from './build-contract-v1';
import type {
  ConsensusBuildGroupV1,
  ConsensusSkeletonV1,
} from './statlocker-adaptive.types';

export type BuildStrategyPhaseV1 = 'EARLY' | 'MID' | 'LATE';

export type BuildGoalTypeV1 =
  | 'CORE'
  | 'POWER_SPIKE'
  | 'UPGRADE'
  | 'BRANCH'
  | 'INVESTMENT'
  | 'SITUATIONAL_RESERVATION'
  | 'TERMINAL';

export type BuildGoalRigidityV1 = 'HARD_CORE' | 'SOFT_CORE' | 'FLEX';

export type BuildItemLifecycleV1 =
  | 'PERMANENT_CORE'
  | 'UPGRADE_COMPONENT'
  | 'TEMPORARY_EARLY'
  | 'SITUATIONAL'
  | 'REPLACEMENT_TARGET';

export type BuildGoalStateV1 =
  | 'LOCKED'
  | 'READY'
  | 'ACTIVE'
  | 'SATISFIED'
  | 'SKIPPED'
  | 'WAIVED'
  | 'BLOCKED';

export type BuildStatusV1 =
  | 'IN_PROGRESS'
  | 'WAITING'
  | 'COMPLETE'
  | 'REPLAN_REQUIRED'
  | 'OUT_OF_DISTRIBUTION';

export type BuildStrategyCommitmentV1 = 'PROVISIONAL' | 'COMMITTED' | 'DIVERGED' | 'OOD';

export type BuildSituationalPurposeV1 =
  | 'ANTI_CC'
  | 'ANTI_BURST'
  | 'ANTI_HEAL'
  | 'ANTI_BULLET'
  | 'ANTI_SPIRIT'
  | 'SURVIVABILITY'
  | 'CATCH'
  | 'DAMAGE'
  | 'COUNTER_ENEMY_HEROES'
  | 'UTILITY';

export interface BuildStrategyGoalV1 {
  goalId: string;
  type: BuildGoalTypeV1;
  phase: BuildStrategyPhaseV1;
  targetItemIds: readonly number[];
  minSelect: number;
  maxSelect: number;
  prerequisiteGoalIds: readonly string[];
  hard: boolean;
  /** Optional only so persisted pre-rigidity V1 strategy payloads remain readable. */
  rigidity?: BuildGoalRigidityV1;
  lifecycleByItemId: Readonly<Record<number, BuildItemLifecycleV1>>;
  rationaleCodes: readonly string[];
}

export interface BuildStrategyBranchGroupV1 {
  branchGroupId: string;
  optionGoalIds: readonly string[];
  minSelect: number;
  maxSelect: number;
}

export interface BuildSituationalWindowV1 {
  windowId: string;
  afterGoalIds: readonly string[];
  beforeGoalIds: readonly string[];
  maxSlots: number;
  maxSouls: number;
  maxCoreDelaySouls: number;
  allowedPurposes: readonly BuildSituationalPurposeV1[];
  /**
   * Explicit strategy-owned candidate set. The planner never infers an item purpose from its name,
   * score or category. Omitted mappings keep the window reserved but not actionable.
   */
  candidateItemIdsByPurpose?: Readonly<Partial<Record<BuildSituationalPurposeV1, readonly number[]>>>;
}

export interface BuildInvestmentObjectiveV1 {
  objectiveId: string;
  type: InventorySlotType;
  hard: boolean;
  targetBreakpoint?: number;
  minimumValue?: number;
  activateAfterGoalIds: readonly string[];
  deactivateAfterGoalIds: readonly string[];
  reasonCodes: readonly string[];
}

export interface BuildInvestmentPolicyV1 {
  objectives: readonly BuildInvestmentObjectiveV1[];
  preferredWeights: Readonly<Record<InventorySlotType, number>>;
}

export interface BuildSlotPolicyV1 {
  reservedSituationalSlots: number;
  maxTemporarySlots: number;
}

export interface BuildTerminalPolicyV1 {
  requiredGoalIds: readonly string[];
  allowWaiveSoftGoals: boolean;
}

export interface BuildStrategySpecV1 {
  schemaVersion: 1;
  strategyId: string;
  heroId: number;
  rulesetId: string;
  sourcePatchId: string;
  support: number;
  stability: number;
  representativeTraceId: string;
  goals: readonly BuildStrategyGoalV1[];
  branchGroups: readonly BuildStrategyBranchGroupV1[];
  situationalWindows: readonly BuildSituationalWindowV1[];
  investmentPolicy: BuildInvestmentPolicyV1;
  slotPolicy: BuildSlotPolicyV1;
  terminalPolicy: BuildTerminalPolicyV1;
}

export interface BuildStrategyPosteriorV1 {
  strategyId: string;
  probability: number;
  conformance: number;
  evidenceCount: number;
}

export interface BuildStrategySelectionV1 {
  selectedStrategyId?: string;
  commitment: BuildStrategyCommitmentV1;
  posteriors: readonly BuildStrategyPosteriorV1[];
  reasonCodes: readonly string[];
}

export interface BuildSituationalDecisionV1 {
  windowId: string;
  purpose: BuildSituationalPurposeV1;
  targetItemId: number;
  enemyHeroIds: readonly number[];
  enemyItemIds: readonly number[];
  statisticalSupport: number;
  confidence: number;
  slotImpact: number;
  investmentImpact: number;
  coreInterruptionSouls: number;
  reasonCodes: readonly string[];
}

export interface BuildContractV1 {
  strategyId: string;
  status: BuildStatusV1;
  commitment: BuildStrategyCommitmentV1;
  currentGoalId?: string;
  goalStates: Readonly<Record<string, BuildGoalStateV1>>;
  selectedBranches: Readonly<Record<string, string>>;
  committedBranches: Readonly<Record<string, string>>;
  temporaryItemIds: readonly number[];
  reservedSituationalWindowIds: readonly string[];
  activeSituationalDecision?: BuildSituationalDecisionV1;
  remainingHardGoalIds: readonly string[];
  completionReasonCodes: readonly string[];
}

export interface BuildSlotPlanTransitionV1 {
  targetGoalId: string;
  targetItemId?: number;
  requirement: 'NONE' | 'UPGRADE' | 'SELL_TEMPORARY' | 'REPLACE' | 'FLEX_UNLOCK' | 'BLOCKED';
  sourceItemId?: number;
  requiredUnlockedFlexSlots?: number;
  reasonCodes: readonly string[];
}

export interface BuildSlotPlanV1 {
  currentUsedSlots: number;
  currentFlexUsed: number;
  unlockedFlexSlots?: number;
  reservedSituationalSlots: number;
  futureTransitions: readonly BuildSlotPlanTransitionV1[];
  feasible: boolean;
  reasonCodes: readonly string[];
}

export interface BuildInvestmentPlanObjectiveStateV1 {
  objectiveId: string;
  type: InventorySlotType;
  state: 'LOCKED' | 'ACTIVE' | 'SATISFIED' | 'WAIVED';
  currentValue: number;
  targetValue?: number;
  distance?: number;
  reasonCodes: readonly string[];
}

export interface BuildInvestmentPlanV1 {
  objectives: readonly BuildInvestmentPlanObjectiveStateV1[];
  activeObjectiveIds: readonly string[];
}

export interface AdaptiveStrategyPlanV1 {
  strategyId: string;
  buildStatus: BuildStatusV1;
  progress: {
    satisfiedHardGoals: number;
    totalHardGoals: number;
  };
  currentGoal?: {
    goalId: string;
    type: BuildGoalTypeV1;
    reasonCodes: readonly string[];
  };
  remainingGoalIds: readonly string[];
  /** Optional so persisted V1 plan payloads written before investment obligations remain readable. */
  remainingHardInvestmentObjectiveIds?: readonly string[];
  slotPlan: BuildSlotPlanV1;
  investmentPlan: BuildInvestmentPlanV1;
  situationalDecision?: BuildSituationalDecisionV1;
}

export function phaseOrderBuildStrategyV1(phase: BuildStrategyPhaseV1): number {
  if (phase === 'EARLY') return 0;
  if (phase === 'MID') return 1;
  return 2;
}

export function buildStrategyGoalMapV1(strategy: BuildStrategySpecV1): ReadonlyMap<string, BuildStrategyGoalV1> {
  return new Map(strategy.goals.map((goal) => [goal.goalId, goal]));
}

export function hardStrategyGoalIdsV1(strategy: BuildStrategySpecV1): readonly string[] {
  return strategy.goals.filter((goal) => goal.hard).map((goal) => goal.goalId);
}

export function buildGoalRigidityV1(goal: BuildStrategyGoalV1): BuildGoalRigidityV1 {
  if (goal.rigidity === 'HARD_CORE' || goal.rigidity === 'SOFT_CORE' || goal.rigidity === 'FLEX') {
    return goal.rigidity;
  }
  if (goal.type === 'BRANCH' || goal.type === 'SITUATIONAL_RESERVATION') return 'FLEX';
  return goal.hard ? 'HARD_CORE' : 'SOFT_CORE';
}

export function targetItemIdsForGoalV1(goal: BuildStrategyGoalV1): readonly number[] {
  return [...new Set(goal.targetItemIds)].sort((a, b) => a - b);
}

/** Compatibility adapter for offline/legacy planner tests; production loads published specs. */
export function compileStructuredConsensusStrategyV1(input: {
  skeleton: ConsensusSkeletonV1;
  itemGraph: RecommendationItemGraph;
  rulesetId: string;
  situationalWindows?: readonly { windowId: string; targetItemIds: readonly number[] }[];
}): BuildStrategySpecV1 {
  const groups = input.skeleton.groups.filter((group) => group.type !== 'OPTIONAL');
  const goals = groups.map((group) => compatibilityGoal(group, input.itemGraph));
  const situationalGoals = (input.situationalWindows ?? []).map((window) => ({
    goalId: `situational:${window.windowId}`,
    type: 'SITUATIONAL_RESERVATION' as const,
    phase: 'MID' as const,
    targetItemIds: stableKnownItems(window.targetItemIds, input.itemGraph),
    minSelect: 0,
    maxSelect: 1,
    prerequisiteGoalIds: [],
    hard: false,
    rigidity: 'FLEX' as const,
    lifecycleByItemId: Object.fromEntries(window.targetItemIds.map((itemId) => [itemId, 'SITUATIONAL' as const])),
    rationaleCodes: ['EXPLICIT_SITUATIONAL_WINDOW'],
  }));
  return {
    schemaVersion: 1,
    strategyId: `structured:${input.skeleton.heroId}:${input.rulesetId}`,
    heroId: input.skeleton.heroId,
    rulesetId: input.rulesetId,
    sourcePatchId: 'COMPATIBILITY_ONLY',
    support: input.skeleton.profileCount,
    stability: 0,
    representativeTraceId: 'COMPATIBILITY_ONLY',
    goals: [...goals, ...situationalGoals],
    branchGroups: groups.filter((group) => group.type === 'CHOICE').map((group) => ({
      branchGroupId: group.groupId,
      optionGoalIds: [group.groupId],
      minSelect: group.minSelect,
      maxSelect: group.maxSelect,
    })),
    situationalWindows: [],
    investmentPolicy: { objectives: [], preferredWeights: { weapon: 1, vitality: 1, spirit: 1 } },
    slotPolicy: { reservedSituationalSlots: situationalGoals.length > 0 ? 1 : 0, maxTemporarySlots: 0 },
    terminalPolicy: { requiredGoalIds: goals.filter((goal) => goal.hard).map((goal) => goal.goalId), allowWaiveSoftGoals: true },
  };
}

export function resolveActiveBuildStrategyGoalsV1(
  strategy: BuildStrategySpecV1,
  contract: CompatibilityBuildContractV1,
): readonly BuildStrategyGoalV1[] {
  if (contract.status === 'OUT_OF_DISTRIBUTION' || contract.status === 'REPLAN_REQUIRED') return [];
  const active = new Set<string>();
  if (contract.currentGoalId) active.add(contract.currentGoalId);
  for (const window of contract.situationalWindowStates) {
    if (window.state === 'OPEN') active.add(`situational:${window.windowId}`);
  }
  return strategy.goals.filter((goal) => active.has(goal.goalId));
}

export function filterRecommendationCandidatesForActiveGoalsV1(
  candidates: readonly RecommendationCandidate[],
  activeGoals: readonly BuildStrategyGoalV1[],
  itemGraph: RecommendationItemGraph,
  options: {
    capacityExitItemIds?: ReadonlySet<number>;
    protectedGoals?: readonly BuildStrategyGoalV1[];
  } = {},
): readonly RecommendationCandidate[] {
  const targets = new Set<number>();
  for (const goal of activeGoals) {
    for (const itemId of goal.targetItemIds) {
      targets.add(itemId);
      for (const componentId of itemGraph.getTransitiveComponentIds(itemId)) targets.add(componentId);
    }
  }

  const protectedHardCoreItemIds = new Set<number>();
  for (const goal of options.protectedGoals ?? activeGoals) {
    if (buildGoalRigidityV1(goal) !== 'HARD_CORE') continue;
    for (const itemId of goal.targetItemIds) {
      protectedHardCoreItemIds.add(itemId);
      for (const componentId of itemGraph.getTransitiveComponentIds(itemId)) {
        protectedHardCoreItemIds.add(componentId);
      }
    }
  }

  return candidates.filter((candidate) => {
    if (candidate.action.type === 'BUY_ITEM' || candidate.action.type === 'UPGRADE_ITEM') return targets.has(candidate.action.itemId);
    if (candidate.action.type === 'REPLACE_ITEM') {
      return targets.has(candidate.action.buyItemId) && !protectedHardCoreItemIds.has(candidate.action.sellItemId);
    }
    if (candidate.action.type === 'WAIT_SAVE') return candidate.action.targetItemId === undefined || targets.has(candidate.action.targetItemId);
    return (options.capacityExitItemIds?.has(candidate.action.itemId) ?? false) &&
      !protectedHardCoreItemIds.has(candidate.action.itemId);
  });
}

function compatibilityGoal(group: ConsensusBuildGroupV1, graph: RecommendationItemGraph): BuildStrategyGoalV1 {
  const targetItemIds = stableKnownItems(group.candidates.map((candidate) => candidate.itemId), graph);
  const type: BuildGoalTypeV1 = group.type === 'CHOICE'
    ? 'BRANCH'
    : targetItemIds.every((itemId) => graph.getDirectComponentIds(itemId).length > 0) ? 'UPGRADE' : 'CORE';
  return {
    goalId: group.groupId,
    type,
    phase: group.phase,
    targetItemIds,
    minSelect: group.minSelect,
    maxSelect: group.maxSelect,
    prerequisiteGoalIds: [],
    hard: true,
    rigidity: group.type === 'CHOICE' ? 'FLEX' : 'HARD_CORE',
    lifecycleByItemId: Object.fromEntries(targetItemIds.map((itemId) => [itemId, 'PERMANENT_CORE' as const])),
    rationaleCodes: ['STRUCTURED_CONSENSUS_COMPATIBILITY'],
  };
}

function stableKnownItems(itemIds: readonly number[], graph: RecommendationItemGraph): number[] {
  return [...new Set(itemIds)].filter((itemId) => graph.getItem(itemId) !== undefined).sort((a, b) => a - b);
}
