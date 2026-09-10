import { Injectable } from '@nestjs/common';
import {
  RecommendationCandidate,
  RecommendationDecisionState,
  RecommendationFeasibilityReason,
  generateRecommendationCandidates,
  projectRecommendationCandidateState,
  reconstructedFact,
} from '@deadlock-live-probe/build-domain';
import {
  AdaptivePlanBarrierV1,
  AdaptivePlanStepBlockReasonV1,
  AdaptivePlanStepV1,
  AdaptivePlannedTransactionV1,
} from '@deadlock-live-probe/shared';
import { AdaptiveDecisionStateV1 } from './adaptive-decision-state-v1.service';
import {
  AdaptiveSlotStateV1,
  candidateGeneratorRulesFromSlotStateV1,
  deriveAdaptiveSlotStateV1,
} from './adaptive-economy-v1';
import { BuildContractV1Service } from './build-contract-v1.service';
import { BuildSlotPlannerV1Service } from './build-slot-planner-v1.service';
import {
  BuildContractV1,
  BuildSlotPlanTransitionV1,
  BuildSlotPlanV1,
  BuildStrategyGoalV1,
  BuildStrategySpecV1,
  phaseOrderBuildStrategyV1,
} from './build-strategy-v1';
import {
  planProjectionFromDecisionStateV1,
  transactionPlanStepIdV1,
} from './transaction-plan-step-v1';

export interface CompileTransactionPlanV1Input {
  strategy: BuildStrategySpecV1;
  contract: BuildContractV1;
  slotPlan: BuildSlotPlanV1;
  decision: AdaptiveDecisionStateV1;
  selectedCandidates: readonly RecommendationCandidate[];
  recentPurchasedItemIds?: readonly number[];
}

export interface CompileTransactionPlanV1Result {
  steps: readonly AdaptivePlanStepV1[];
  reachable: boolean;
  reasonCodes: readonly string[];
}

interface CompileGoalResultV1 {
  steps: readonly AdaptivePlanStepV1[];
  state: RecommendationDecisionState;
  slots: AdaptiveSlotStateV1;
  reachable: boolean;
  reasonCodes: readonly string[];
}

@Injectable()
export class TransactionPlanCompilerV1Service {
  private readonly contracts = new BuildContractV1Service();
  private readonly slotPlanner = new BuildSlotPlannerV1Service();

  compile(input: CompileTransactionPlanV1Input): CompileTransactionPlanV1Result {
    const steps: AdaptivePlanStepV1[] = [];
    const reasonCodes: string[] = [];
    const compiledGoalIds = new Set<string>();
    let state = input.decision.state;
    let slots = input.decision.slots;
    let contract = input.contract;

    const selectedPrelude = this.selectedPreludeCandidate(input, state, contract);
    if (selectedPrelude) {
      const goalId = selectedPreludeGoalId(input, selectedPrelude);
      const compiledPrelude = this.compileExactCandidate({
        input,
        candidate: selectedPrelude,
        goalId,
        state,
        slots,
        contract,
        previousStepId: undefined,
        reasonCodes: ['SELECTED_IMMEDIATE_TRANSACTION'],
      });
      if (!compiledPrelude) {
        return {
          steps,
          reachable: false,
          reasonCodes: ['SELECTED_IMMEDIATE_TRANSACTION_NOT_REPLAYABLE'],
        };
      }
      steps.push(compiledPrelude.step);
      state = compiledPrelude.state;
      slots = compiledPrelude.slots;
      compiledGoalIds.add(goalId);
      reasonCodes.push('SELECTED_IMMEDIATE_TRANSACTION_COMPILED');
    }

    const maxIterations = Math.max(
      1,
      input.strategy.goals.length * Math.max(1, input.decision.itemGraph.getAllItems().length),
    );
    let guard = 0;
    while (guard < maxIterations) {
      guard += 1;
      contract = this.contracts.resolve({
        strategy: input.strategy,
        itemGraph: input.decision.itemGraph,
        ownedItemIds: heldIds(state),
        selectedBranches: contract.selectedBranches,
        committedBranches: contract.committedBranches,
        commitment: contract.commitment,
      });
      if (contract.status === 'COMPLETE') break;
      if (contract.status === 'OUT_OF_DISTRIBUTION') {
        reasonCodes.push('STRATEGY_OUT_OF_DISTRIBUTION');
      }

      const goal = nextGoal(input.strategy, contract, input.decision.itemGraph, heldIds(state), compiledGoalIds);
      if (!goal) {
        break;
      }
      const targetItemId = goal.targetItemIds.find((itemId) =>
        !input.decision.itemGraph.isTargetSatisfied(itemId, state.inventory.heldByItemId.keys()),
      );
      if (targetItemId === undefined) {
        compiledGoalIds.add(goal.goalId);
        continue;
      }

      const transition = this.slotPlanner.transitionForTarget(
        {
          strategy: input.strategy,
          contract,
          itemGraph: input.decision.itemGraph,
          ownedItemIds: heldIds(state),
          slots,
        },
        goal.goalId,
        targetItemId,
      );

      const previousStepId = steps.length > 0 ? steps[steps.length - 1].stepId : undefined;
      const compiled = this.compileGoal({
        input,
        goal,
        targetItemId,
        transition,
        state,
        slots,
        contract,
        previousStepId,
      });
      if (!compiled.reachable) {
        // If the planner already compiled valid, reachable steps for earlier goals,
        // a future goal with incomplete transaction mechanics (e.g. unverified upgrade
        // recipe pricing) should truncate future projection rather than invalidating
        // the executable next action.
        if (steps.length > 0) {
          reasonCodes.push(...compiled.reasonCodes);
          break;
        }
        steps.push(...compiled.steps);
        reasonCodes.push(...compiled.reasonCodes);
        return { steps, reachable: false, reasonCodes: unique(reasonCodes) };
      }
      steps.push(...compiled.steps);
      reasonCodes.push(...compiled.reasonCodes);
      state = compiled.state;
      slots = compiled.slots;
      if (goalSatisfied(goal, input.decision.itemGraph, heldIds(state))) {
        compiledGoalIds.add(goal.goalId);
      }
    }

    const finalContract = this.contracts.resolve({
      strategy: input.strategy,
      itemGraph: input.decision.itemGraph,
      ownedItemIds: heldIds(state),
      selectedBranches: contract.selectedBranches,
      committedBranches: contract.committedBranches,
      commitment: contract.commitment,
    });
    const terminalGoalIds = new Set(input.strategy.terminalPolicy.requiredGoalIds);
    const selectedBranchGoals = new Set(Object.values(finalContract.selectedBranches));
    const branchGoalIds = new Set(
      input.strategy.branchGroups.flatMap((group) => group.optionGoalIds),
    );
    const uncompiledHardGoals = input.strategy.goals.filter((goal) =>
      goal.hard &&
      (!branchGoalIds.has(goal.goalId) || selectedBranchGoals.has(goal.goalId)) &&
      !compiledGoalIds.has(goal.goalId) &&
      !goalSatisfied(goal, input.decision.itemGraph, heldIds(state)),
    );
    const unsatisfiedTerminalGoals = input.strategy.goals.filter((goal) =>
      goal.hard &&
      terminalGoalIds.has(goal.goalId) &&
      (!branchGoalIds.has(goal.goalId) || selectedBranchGoals.has(goal.goalId)) &&
      !goalSatisfied(goal, input.decision.itemGraph, heldIds(state)),
    );
    const unresolved = finalContract.status !== 'COMPLETE' && (uncompiledHardGoals.length > 0 || unsatisfiedTerminalGoals.length > 0);
    return {
      steps,
      reachable: !unresolved,
      reasonCodes: unique([
        ...reasonCodes,
        ...(unresolved ? ['MANDATORY_GOALS_REMAIN_WITHOUT_COMPILED_PATH'] : ['TRANSACTION_PATH_REACHABLE']),
      ]),
    };
  }

  private selectedPreludeCandidate(
    input: CompileTransactionPlanV1Input,
    state: RecommendationDecisionState,
    contract: BuildContractV1,
  ): RecommendationCandidate | undefined {
    const selected = input.selectedCandidates.find((candidate) =>
      candidate.feasible &&
      candidate.recommendationEligible &&
      candidate.action.type !== 'SELL_ITEM' &&
      candidate.action.type !== 'WAIT_SAVE' &&
      transactionForCandidate(candidate) !== undefined,
    );
    if (!selected) return undefined;
    const targetItemId = candidateTargetItemId(selected);
    if (targetItemId === undefined) return undefined;
    const currentGoal = input.strategy.goals.find((goal) => goal.goalId === contract.currentGoalId);
    if (currentGoal?.targetItemIds.some((itemId) =>
      itemId === targetItemId || input.decision.itemGraph.isComponentAncestor(targetItemId, itemId),
    )) {
      return undefined;
    }
    const regenerated = this.candidates(state, input.decision.slots, input)
      .find((candidate) => candidate.actionId === selected.actionId);
    return regenerated?.feasible && regenerated.recommendationEligible ? regenerated : undefined;
  }

  private compileGoal(args: {
    input: CompileTransactionPlanV1Input;
    goal: BuildStrategyGoalV1;
    targetItemId: number;
    transition: BuildSlotPlanTransitionV1 | undefined;
    state: RecommendationDecisionState;
    slots: AdaptiveSlotStateV1;
    contract: BuildContractV1;
    previousStepId?: string;
  }): CompileGoalResultV1 {
    let state = args.state;
    let slots = args.slots;
    const steps: AdaptivePlanStepV1[] = [];
    const reasons = [`STRATEGY_GOAL:${args.goal.goalId}`, ...(args.transition?.reasonCodes ?? [])];
    let previousStepId = args.previousStepId;

    if (args.transition?.requirement === 'BLOCKED') {
      return {
        steps,
        state,
        slots,
        reachable: false,
        reasonCodes: unique([...reasons, 'NO_SLOT_EXIT_PATH']),
      };
    }

    if (args.transition?.requirement === 'FLEX_UNLOCK') {
      const required = args.transition.requiredUnlockedFlexSlots;
      if (required === undefined || required > slots.maxFlexSlots) {
        return {
          steps,
          state,
          slots,
          reachable: false,
          reasonCodes: unique([...reasons, 'FLEX_SLOT_UNAVAILABLE']),
        };
      }
      const currentFlex = slots.unlockedFlexSlots ?? slots.provedFlexLowerBound ?? 0;
      if (slots.unlockedFlexSlots === undefined || currentFlex < required) {
        const barrier = this.barrierStep(
          args.input.strategy.strategyId,
          args.goal.goalId,
          {
            type: 'WAIT_FOR_FLEX',
            targetItemId: args.targetItemId,
            requiredUnlockedFlexSlots: required,
          },
          'INSUFFICIENT_FLEX',
          state,
          slots,
          args.input,
          previousStepId,
          reasons,
        );
        steps.push(barrier);
        previousStepId = barrier.stepId;
        slots = deriveAdaptiveSlotStateV1(
          heldIds(state),
          args.input.decision.itemGraph,
          {
            baseSlots: slots.baseSlots,
            baseSlotsByType: slots.baseSlotsByType,
            maxFlexSlots: slots.maxFlexSlots,
            maxActiveItems: slots.maxActiveItems,
            evidence: slots.mechanicsEvidence,
          },
          { unlockedFlexSlots: required, evidence: 'RECONSTRUCTED' },
        );
      }
    }

    let candidates = this.candidates(state, slots, args.input);
    let preferred = this.preferredCandidate(
      args.input,
      candidates,
      args.goal,
      args.targetItemId,
      args.transition,
      args.contract,
      state,
    );

    const nonDeferable = preferred?.reasons.some((reason) => NON_DEFERABLE_REASONS.has(reason));
    if (preferred && !preferred.feasible && nonDeferable) {
      return {
        steps,
        state,
        slots,
        reachable: false,
        reasonCodes: unique([...reasons, ...preferred.reasons]),
      };
    }

    if (!preferred || !preferred.feasible) {
      const diagnostic = preferred ?? this.bestDiagnosticCandidate(
        candidates,
        args.targetItemId,
        args.transition,
        args.input,
        args.goal.goalId,
        args.contract,
        state,
      );
      if (!diagnostic) {
        return { steps, state, slots, reachable: false, reasonCodes: unique([...reasons, 'NO_TRANSACTION_CANDIDATE']) };
      }
      if (diagnostic.reasons.some((reason) => NON_DEFERABLE_REASONS.has(reason))) {
        return { steps, state, slots, reachable: false, reasonCodes: unique([...reasons, ...diagnostic.reasons]) };
      }
      const waitTargetItemId = candidateTargetItemId(diagnostic) ?? args.targetItemId;

      if (
        (diagnostic.reasons.includes('FLEX_SLOT_CAPACITY_UNKNOWN') || diagnostic.reasons.includes('SLOT_LIMIT_EXCEEDED')) &&
        (slots.unlockedFlexSlots === undefined || slots.unlockedFlexSlots < slots.maxFlexSlots)
      ) {
        const requiredFlex = Math.min(
          slots.maxFlexSlots,
          Math.max((slots.unlockedFlexSlots ?? slots.provedFlexLowerBound ?? 0) + 1, 1),
        );
        const barrier = this.barrierStep(
          args.input.strategy.strategyId,
          args.goal.goalId,
          {
            type: 'WAIT_FOR_FLEX',
            targetItemId: waitTargetItemId,
            requiredUnlockedFlexSlots: requiredFlex,
          },
          'INSUFFICIENT_FLEX',
          state,
          slots,
          args.input,
          previousStepId,
          reasons,
        );
        steps.push(barrier);
        previousStepId = barrier.stepId;
        slots = deriveAdaptiveSlotStateV1(
          heldIds(state),
          args.input.decision.itemGraph,
          {
            baseSlots: slots.baseSlots,
            baseSlotsByType: slots.baseSlotsByType,
            maxFlexSlots: slots.maxFlexSlots,
            maxActiveItems: slots.maxActiveItems,
            evidence: slots.mechanicsEvidence,
          },
          { unlockedFlexSlots: requiredFlex, evidence: 'RECONSTRUCTED' },
        );
      }

      if (diagnostic.reasons.includes('SHOP_UNAVAILABLE') || diagnostic.reasons.includes('SHOP_OPPORTUNITY_UNKNOWN')) {
        const barrier = this.barrierStep(
          args.input.strategy.strategyId,
          args.goal.goalId,
          { type: 'WAIT_FOR_SHOP', targetItemId: waitTargetItemId },
          'SHOP_UNAVAILABLE',
          state,
          slots,
          args.input,
          previousStepId,
          reasons,
        );
        steps.push(barrier);
        previousStepId = barrier.stepId;
        state = withShopAvailable(state);
      }

      if (diagnostic.reasons.includes('UNAFFORDABLE') || diagnostic.reasons.includes('SPENDABLE_SOULS_UNKNOWN')) {
        const requiredSouls = Math.max(0, diagnostic.effectiveCostSouls);
        const barrier = this.barrierStep(
          args.input.strategy.strategyId,
          args.goal.goalId,
          { type: 'WAIT_FOR_GOLD', targetItemId: waitTargetItemId, requiredSouls },
          diagnostic.reasons.includes('UNAFFORDABLE') ? 'INSUFFICIENT_GOLD' : 'UNKNOWN_AFFORDABILITY',
          state,
          slots,
          args.input,
          previousStepId,
          reasons,
        );
        steps.push(barrier);
        previousStepId = barrier.stepId;
        state = withSpendableSouls(state, requiredSouls);
      }

      candidates = this.candidates(state, slots, args.input);
      preferred = this.preferredCandidate(
        args.input,
        candidates,
        args.goal,
        args.targetItemId,
        args.transition,
        args.contract,
        state,
      );
    }

    if (!preferred || !preferred.feasible) {
      return {
        steps,
        state,
        slots,
        reachable: false,
        reasonCodes: unique([...reasons, ...(preferred?.reasons ?? ['TRANSACTION_STILL_INFEASIBLE_AFTER_BARRIER'])]),
      };
    }

    const compiled = this.compileExactCandidate({
      input: args.input,
      candidate: preferred,
      goalId: args.goal.goalId,
      state,
      slots,
      contract: args.contract,
      previousStepId,
      reasonCodes: reasons,
    });
    if (!compiled) {
      return { steps, state, slots, reachable: false, reasonCodes: unique([...reasons, 'USER_FACING_TRANSACTION_NOT_AVAILABLE']) };
    }
    steps.push(compiled.step);
    return {
      steps,
      state: compiled.state,
      slots: compiled.slots,
      reachable: true,
      reasonCodes: unique(reasons),
    };
  }

  private compileExactCandidate(args: {
    input: CompileTransactionPlanV1Input;
    candidate: RecommendationCandidate;
    goalId: string;
    state: RecommendationDecisionState;
    slots: AdaptiveSlotStateV1;
    contract: BuildContractV1;
    previousStepId?: string;
    reasonCodes: readonly string[];
  }): { step: AdaptivePlanStepV1; state: RecommendationDecisionState; slots: AdaptiveSlotStateV1 } | undefined {
    const regenerated = this.candidates(args.state, args.slots, args.input)
      .find((candidate) => candidate.actionId === args.candidate.actionId);
    if (!regenerated?.feasible || !regenerated.recommendationEligible) return undefined;
    if (!candidateAllowed(regenerated, args.input, args.goalId, args.contract, args.state)) return undefined;
    const action = transactionForCandidate(regenerated);
    if (!action) return undefined;

    const before = planProjectionFromDecisionStateV1(
      args.state,
      args.input.decision.itemGraph,
      candidateGeneratorRulesFromSlotStateV1(args.slots),
    );
    const nextState = projectRecommendationCandidateState(args.state, regenerated, args.input.decision.itemGraph);
    const nextSlots = deriveAdaptiveSlotStateV1(
      heldIds(nextState),
      args.input.decision.itemGraph,
      {
        baseSlots: args.slots.baseSlots,
        baseSlotsByType: args.slots.baseSlotsByType,
        maxFlexSlots: args.slots.maxFlexSlots,
        maxActiveItems: args.slots.maxActiveItems,
        evidence: args.slots.mechanicsEvidence,
      },
      { unlockedFlexSlots: args.slots.unlockedFlexSlots, evidence: args.slots.evidence ?? args.slots.flexEvidence },
    );
    const after = planProjectionFromDecisionStateV1(
      nextState,
      args.input.decision.itemGraph,
      candidateGeneratorRulesFromSlotStateV1(nextSlots),
    );
    const stepId = transactionPlanStepIdV1({
      strategyId: args.input.strategy.strategyId,
      goalId: args.goalId,
      kind: 'TRANSACTION',
      type: action.type,
      targetItemId: action.buyItemId,
      sellItemId: action.type === 'SELL_AND_BUY' ? action.sellItemId : undefined,
      consumedItemIds: action.type === 'UPGRADE' ? action.consumedItemIds : undefined,
      branchId: branchIdForGoal(args.input.strategy, args.goalId),
    });
    return {
      step: {
        stepId,
        goalId: args.goalId,
        kind: 'TRANSACTION',
        state: args.previousStepId ? 'LOCKED' : 'READY',
        action,
        prerequisiteStepIds: args.previousStepId ? [args.previousStepId] : [],
        blockingReasons: [],
        projectedBefore: before,
        projectedAfter: after,
        reasonCodes: unique([...args.reasonCodes, `CANDIDATE:${regenerated.actionId}`]),
      },
      state: nextState,
      slots: nextSlots,
    };
  }

  private candidates(
    state: RecommendationDecisionState,
    slots: AdaptiveSlotStateV1,
    input: CompileTransactionPlanV1Input,
  ): readonly RecommendationCandidate[] {
    return generateRecommendationCandidates({
      state,
      itemGraph: input.decision.itemGraph,
      rules: candidateGeneratorRulesFromSlotStateV1(slots, {
        allowSellOnlyActions: true,
        generateTargetedWaitActions: true,
      }),
    });
  }

  private preferredCandidate(
    input: CompileTransactionPlanV1Input,
    candidates: readonly RecommendationCandidate[],
    goal: BuildStrategyGoalV1,
    targetItemId: number,
    transition: BuildSlotPlanTransitionV1 | undefined,
    contract: BuildContractV1,
    state: RecommendationDecisionState,
  ): RecommendationCandidate | undefined {
    const selected = input.selectedCandidates.find((candidate) =>
      candidateAdvancesTarget(candidate, targetItemId, input.decision.itemGraph) &&
      candidateMatchesTransition(candidate, transition),
    );
    if (selected && candidateAllowed(selected, input, goal.goalId, contract, state)) {
      const regenerated = candidates.find((candidate) => candidate.actionId === selected.actionId);
      // The immediate selection is authoritative only in the state it was chosen from; once a
      // projected step invalidates it, the goal must continue from the remaining legal pool.
      if (regenerated?.feasible) return regenerated;
    }

    return candidates
      .filter((candidate) => candidateAdvancesTarget(candidate, targetItemId, input.decision.itemGraph))
      .filter((candidate) => candidateMatchesTransition(candidate, transition))
      .filter((candidate) => candidateAllowed(candidate, input, goal.goalId, contract, state))
      .sort((a, b) =>
        candidateSourceMatchPreference(a, b, transition) ||
        candidateFeasibilityPreference(a) - candidateFeasibilityPreference(b) ||
        candidateExactTargetPreference(a, targetItemId) - candidateExactTargetPreference(b, targetItemId) ||
        candidatePreference(a) - candidatePreference(b) ||
        a.actionId.localeCompare(b.actionId),
      )[0];
  }

  private bestDiagnosticCandidate(
    candidates: readonly RecommendationCandidate[],
    targetItemId: number,
    transition: BuildSlotPlanTransitionV1 | undefined,
    input: CompileTransactionPlanV1Input,
    goalId: string,
    contract: BuildContractV1,
    state: RecommendationDecisionState,
  ): RecommendationCandidate | undefined {
    const allowed = candidates.filter((candidate) => candidateAllowed(candidate, input, goalId, contract, state));
    const pool = allowed.length > 0 ? allowed : candidates;
    return pool
      .filter((candidate) => candidateAdvancesTarget(candidate, targetItemId, input.decision.itemGraph))
      .filter((candidate) => candidateMatchesTransition(candidate, transition))
      .sort((a, b) =>
        candidateSourceMatchPreference(a, b, transition) ||
        candidateFeasibilityPreference(a) - candidateFeasibilityPreference(b) ||
        candidateExactTargetPreference(a, targetItemId) - candidateExactTargetPreference(b, targetItemId) ||
        a.reasons.filter((reason) => reason !== 'FEASIBLE').length - b.reasons.filter((reason) => reason !== 'FEASIBLE').length ||
        candidatePreference(a) - candidatePreference(b) ||
        a.actionId.localeCompare(b.actionId),
      )[0];
  }

  private barrierStep(
    strategyId: string,
    goalId: string,
    barrier: AdaptivePlanBarrierV1,
    blockingReason: AdaptivePlanStepBlockReasonV1,
    state: RecommendationDecisionState,
    slots: AdaptiveSlotStateV1,
    input: CompileTransactionPlanV1Input,
    previousStepId: string | undefined,
    reasonCodes: readonly string[],
  ): AdaptivePlanStepV1 {
    const targetItemId = 'targetItemId' in barrier ? barrier.targetItemId : undefined;
    const stepId = transactionPlanStepIdV1({
      strategyId,
      goalId,
      kind: 'BARRIER',
      type: barrier.type,
      targetItemId,
      branchId: branchIdForGoal(input.strategy, goalId),
    });
    return {
      stepId,
      goalId,
      kind: 'BARRIER',
      state: 'BLOCKED',
      barrier,
      prerequisiteStepIds: previousStepId ? [previousStepId] : [],
      blockingReasons: [blockingReason],
      projectedBefore: planProjectionFromDecisionStateV1(
        state,
        input.decision.itemGraph,
        candidateGeneratorRulesFromSlotStateV1(slots),
      ),
      reasonCodes: unique([...reasonCodes, barrier.type]),
    };
  }
}

const NON_DEFERABLE_REASONS = new Set<RecommendationFeasibilityReason>([
  'ITEM_UNAVAILABLE_IN_RULESET',
  'MISSING_UPGRADE_COMPONENT',
  'SELL_TRANSITION_UNKNOWN',
  'SELL_RETURN_ITEM_UNKNOWN',
  'DIRECT_PURCHASE_NOT_SUPPORTED',
  'ITEM_NOT_OWNED',
]);

function nextGoal(
  strategy: BuildStrategySpecV1,
  contract: BuildContractV1,
  graph: AdaptiveDecisionStateV1['itemGraph'],
  ownedItemIds: readonly number[],
  compiledGoalIds?: ReadonlySet<string>,
): BuildStrategyGoalV1 | undefined {
  const selectedBranchGoals = new Set(Object.values(contract.selectedBranches));
  const candidates = strategy.goals
    .filter((goal) => {
      if (compiledGoalIds?.has(goal.goalId)) return false;
      const state = contract.goalStates[goal.goalId];
      if (state === 'SATISFIED' || state === 'SKIPPED' || state === 'WAIVED') return false;
      if (goal.type === 'BRANCH' && !selectedBranchGoals.has(goal.goalId)) return false;
      if (!goal.hard && contract.currentGoalId !== goal.goalId) return false;
      return !goalSatisfied(goal, graph, ownedItemIds);
    })
    .sort((a, b) => {
      if (a.goalId === contract.currentGoalId) return -1;
      if (b.goalId === contract.currentGoalId) return 1;
      return phaseOrderBuildStrategyV1(a.phase) - phaseOrderBuildStrategyV1(b.phase) ||
        strategy.goals.indexOf(a) - strategy.goals.indexOf(b);
    });
  return candidates[0];
}

function selectedPreludeGoalId(
  input: CompileTransactionPlanV1Input,
  candidate: RecommendationCandidate,
): string {
  const targetItemId = candidateTargetItemId(candidate);
  if (
    targetItemId !== undefined &&
    input.contract.activeSituationalDecision?.targetItemId === targetItemId
  ) {
    return `situational:${input.contract.activeSituationalDecision.windowId}`;
  }
  return `strategic-transaction:${targetItemId ?? candidate.actionId}`;
}

function candidateAllowed(
  candidate: RecommendationCandidate,
  input: CompileTransactionPlanV1Input,
  currentGoalId: string,
  contract: BuildContractV1,
  state: RecommendationDecisionState,
): boolean {
  if (!candidate.recommendationEligible) return false;
  if (candidate.action.type !== 'REPLACE_ITEM') {
    return candidate.action.type !== 'SELL_ITEM' && candidate.action.type !== 'WAIT_SAVE';
  }
  const { buyItemId, sellItemId } = candidate.action;
  if (input.recentPurchasedItemIds?.includes(sellItemId)) return false;
  if (input.decision.itemGraph.isComponentAncestor(sellItemId, buyItemId)) return false;
  const afterSell = heldIds(state).filter((itemId) => itemId !== sellItemId);
  const terminalGoalIds = new Set(input.strategy.terminalPolicy.requiredGoalIds);

  for (const hardGoal of input.strategy.goals.filter((entry) =>
    entry.hard && terminalGoalIds.has(entry.goalId) && contract.goalStates[entry.goalId] === 'SATISFIED' && entry.goalId !== currentGoalId,
  )) {
    const satisfied = hardGoal.targetItemIds.filter((itemId) =>
      input.decision.itemGraph.isTargetSatisfied(itemId, afterSell),
    ).length;
    if (satisfied < hardGoal.minSelect) {
      if (hardGoal.targetItemIds.some((itemId) => input.decision.itemGraph.isTargetSatisfied(itemId, [buyItemId]))) continue;
      return false;
    }
  }
  for (const committedGoalId of Object.values(contract.committedBranches)) {
    if (committedGoalId === currentGoalId) continue;
    const committedGoal = input.strategy.goals.find((entry) => entry.goalId === committedGoalId);
    if (!committedGoal) continue;
    const satisfied = committedGoal.targetItemIds.filter((itemId) =>
      input.decision.itemGraph.isTargetSatisfied(itemId, afterSell),
    ).length;
    if (satisfied < Math.max(1, committedGoal.minSelect)) return false;
  }
  return true;
}

function candidateAdvancesTarget(
  candidate: RecommendationCandidate,
  targetItemId: number,
  graph: AdaptiveDecisionStateV1['itemGraph'],
): boolean {
  if (candidate.reasons.includes('ITEM_ALREADY_OWNED') || candidate.reasons.includes('MAX_COPIES_REACHED')) {
    return false;
  }
  const candidateTarget = candidateTargetItemId(candidate);
  return candidateTarget !== undefined &&
    (candidateTarget === targetItemId || graph.isComponentAncestor(candidateTarget, targetItemId));
}

function candidateExactTargetPreference(candidate: RecommendationCandidate, targetItemId: number): number {
  return candidateTargetItemId(candidate) === targetItemId ? 0 : 1;
}

function goalSatisfied(
  goal: BuildStrategyGoalV1,
  graph: AdaptiveDecisionStateV1['itemGraph'],
  ownedItemIds: readonly number[],
): boolean {
  const satisfied = goal.targetItemIds.filter((itemId) => graph.isTargetSatisfied(itemId, ownedItemIds)).length;
  return satisfied >= Math.max(0, goal.minSelect);
}

function candidateMatchesTransition(
  candidate: RecommendationCandidate,
  transition: BuildSlotPlanTransitionV1 | undefined,
): boolean {
  if (!transition || transition.requirement === 'NONE' || transition.requirement === 'FLEX_UNLOCK') {
    return candidate.action.type === 'BUY_ITEM' || candidate.action.type === 'UPGRADE_ITEM';
  }
  if (transition.requirement === 'UPGRADE') {
    return candidate.action.type === 'UPGRADE_ITEM';
  }
  if (transition.requirement === 'SELL_TEMPORARY' || transition.requirement === 'REPLACE') {
    return candidate.action.type === 'REPLACE_ITEM';
  }
  return false;
}

function candidateSourceMatchPreference(
  a: RecommendationCandidate,
  b: RecommendationCandidate,
  transition: BuildSlotPlanTransitionV1 | undefined,
): number {
  if (transition?.sourceItemId === undefined) return 0;
  const aMatch = a.action.type === 'REPLACE_ITEM' && a.action.sellItemId === transition.sourceItemId ? 1 : 0;
  const bMatch = b.action.type === 'REPLACE_ITEM' && b.action.sellItemId === transition.sourceItemId ? 1 : 0;
  return bMatch - aMatch;
}

function candidatePreference(candidate: RecommendationCandidate): number {
  if (candidate.action.type === 'UPGRADE_ITEM') return 0;
  if (candidate.action.type === 'REPLACE_ITEM') return 1;
  if (candidate.action.type === 'BUY_ITEM') return 2;
  return 10;
}

function candidateFeasibilityPreference(candidate: RecommendationCandidate): number {
  if (candidate.feasible) return 0;
  return candidate.reasons.some((reason) => NON_DEFERABLE_REASONS.has(reason)) ? 2 : 1;
}

function candidateTargetItemId(candidate: RecommendationCandidate): number | undefined {
  const action = candidate.action;
  if (action.type === 'BUY_ITEM' || action.type === 'UPGRADE_ITEM') return action.itemId;
  if (action.type === 'REPLACE_ITEM') return action.buyItemId;
  if (action.type === 'WAIT_SAVE') return action.targetItemId;
  return undefined;
}

function transactionForCandidate(candidate: RecommendationCandidate): AdaptivePlannedTransactionV1 | undefined {
  const action = candidate.action;
  if (action.type === 'BUY_ITEM') return { type: 'BUY', buyItemId: action.itemId };
  if (action.type === 'UPGRADE_ITEM') {
    return {
      type: 'UPGRADE',
      buyItemId: action.itemId,
      consumedItemIds: [...action.consumedItemIds].sort((a, b) => a - b),
      recipeId: action.recipeId,
    };
  }
  if (action.type === 'REPLACE_ITEM') {
    return { type: 'SELL_AND_BUY', sellItemId: action.sellItemId, buyItemId: action.buyItemId };
  }
  return undefined;
}

function withSpendableSouls(state: RecommendationDecisionState, requiredSouls: number): RecommendationDecisionState {
  return {
    ...state,
    economy: {
      ...state.economy,
      spendableSouls: reconstructedFact(requiredSouls, 'transaction-plan:wait-for-gold'),
    },
  };
}

function withShopAvailable(state: RecommendationDecisionState): RecommendationDecisionState {
  return {
    ...state,
    economy: {
      ...state.economy,
      shopOpportunity: reconstructedFact('AVAILABLE', 'transaction-plan:wait-for-shop'),
    },
  };
}

function heldIds(state: RecommendationDecisionState): number[] {
  return [...state.inventory.heldByItemId.keys()].sort((a, b) => a - b);
}

function branchIdForGoal(strategy: BuildStrategySpecV1, goalId: string): string | undefined {
  return strategy.branchGroups.find((group) => group.optionGoalIds.includes(goalId))?.branchGroupId;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}
