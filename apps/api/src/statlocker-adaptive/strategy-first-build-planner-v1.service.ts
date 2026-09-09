import { Injectable } from '@nestjs/common';
import {
  RecommendationCandidate,
  RecommendationDecisionState,
  RecommendationItemGraph,
  generateRecommendationCandidates,
  projectRecommendationCandidateState,
} from '@deadlock-live-probe/build-domain';
import {
  AdaptiveActionV1,
  AdaptiveBuildPlanChangeV1,
  AdaptivePlannedItemV1,
  AdaptiveScoredActionV1,
  AdaptiveScoreComponentV1,
} from '@deadlock-live-probe/shared';
import { AdaptiveDecisionStateV1 } from './adaptive-decision-state-v1.service';
import {
  AdaptiveInvestmentStateV1,
  AdaptiveSlotStateV1,
  candidateGeneratorRulesFromSlotStateV1,
  deriveAdaptiveInvestmentStateV1,
  deriveAdaptiveSlotStateV1,
  slotRulesFromEconomyRulesV1,
} from './adaptive-economy-v1';
import {
  AdaptiveEvidenceScorerV1Service,
  AdaptiveItemScoreContextV1,
  AdaptiveItemScoreV1,
} from './adaptive-evidence-scorer-v1.service';
import { classifyAdaptiveGameStateV1 } from './adaptive-game-state';
import { BuildContractV1Service } from './build-contract-v1.service';
import { BuildInvestmentPolicyV1Service } from './build-investment-policy-v1.service';
import { BuildSlotPlannerV1Service } from './build-slot-planner-v1.service';
import {
  AdaptiveStrategyPlanV1,
  BuildContractV1,
  BuildInvestmentObjectiveV1,
  BuildInvestmentPlanV1,
  BuildSlotPlanV1,
  BuildStrategyGoalV1,
  BuildStrategySpecV1,
  buildGoalRigidityV1,
} from './build-strategy-v1';
import { BuildStrategySelectionV1, BuildStrategySelectorV1Service } from './build-strategy-selector-v1.service';
import { BuildStrategySessionV1, BuildStrategySessionV1Service } from './build-strategy-session-v1.service';
import { StatlockerEvidenceBundleV1 } from './statlocker-evidence.service';
import { derivePlannerInvestmentDeltaV1 } from './adaptive-planner-transition-v1';
import { ADAPTIVE_POLICY_V1_CONFIG } from './statlocker-adaptive.config';
import {
  WholeBuildReplacementKindV1,
  WholeBuildUtilityContributionsV1,
  WholeBuildUtilityV1Service,
} from './whole-build-utility-v1.service';

export interface StrategyFirstBuildPlannerV1Input {
  decision: AdaptiveDecisionStateV1;
  evidence: StatlockerEvidenceBundleV1;
  strategies: readonly BuildStrategySpecV1[];
  purchaseHistory?: readonly { itemId: number; gameTimeSec: number }[];
  previousSession?: BuildStrategySessionV1;
  previousContract?: BuildContractV1;
  previousRecommendedBuild?: readonly AdaptivePlannedItemV1[];
  recentPurchasedItemIds?: readonly number[];
  recentSoldItemIds?: readonly number[];
  planningDepth?: number;
  beamWidth?: number;
}

export interface StrategyFirstBuildPlannerV1Result {
  gameState: 'AHEAD' | 'EVEN' | 'BEHIND' | 'UNKNOWN';
  strategy: BuildStrategySpecV1;
  strategySelection: BuildStrategySelectionV1;
  strategySession: BuildStrategySessionV1;
  contract: BuildContractV1;
  strategyPlan: AdaptiveStrategyPlanV1;
  nextAction: AdaptiveActionV1;
  recommendedBuild: readonly AdaptivePlannedItemV1[];
  changes: readonly AdaptiveBuildPlanChangeV1[];
  rankedImmediateCandidates: readonly AdaptiveScoredActionV1[];
  totalScore: number;
  confidence: number;
  plannerVersion: 'strategy-first-build-planner-v1';
}

interface StrategyNodeV1 {
  decisionState: RecommendationDecisionState;
  slots: AdaptiveSlotStateV1;
  investment: AdaptiveInvestmentStateV1;
  contract: BuildContractV1;
  actions: readonly ScoredStrategyCandidateV1[];
  utility: number;
}

interface ScoredStrategyCandidateV1 {
  candidate: RecommendationCandidate;
  score: number;
  confidence: number;
  components: readonly AdaptiveScoreComponentV1[];
  reasonCodes: readonly string[];
}

interface ContinuityAdjustmentV1 {
  score: number;
  reasonCodes: readonly string[];
}

@Injectable()
export class StrategyFirstBuildPlannerV1Service {
  readonly version = 'strategy-first-build-planner-v1' as const;
  private readonly selector = new BuildStrategySelectorV1Service();
  private readonly sessions = new BuildStrategySessionV1Service();
  private readonly contracts = new BuildContractV1Service();
  private readonly slots = new BuildSlotPlannerV1Service();
  private readonly investments = new BuildInvestmentPolicyV1Service();
  private readonly wholeBuildUtility = new WholeBuildUtilityV1Service();

  constructor(private readonly scorer: AdaptiveEvidenceScorerV1Service) {}

  plan(input: StrategyFirstBuildPlannerV1Input): StrategyFirstBuildPlannerV1Result {
    if (input.strategies.length === 0) throw new Error('Strategy-first planner requires at least one strategy');
    const ownedItemIds = heldIds(input.decision.state);
    const selection = this.selector.select({
      strategies: input.strategies,
      heroId: input.decision.state.heroId,
      rulesetId: input.decision.rulesetId,
      itemGraph: input.decision.itemGraph,
      ownedItemIds,
      purchaseHistory: input.purchaseHistory ?? ownedItemIds.map((itemId, index) => ({ itemId, gameTimeSec: index })),
      allyHeroIds: input.decision.allyHeroIds,
      enemyHeroIds: input.decision.enemyHeroIds,
    });
    const session = this.sessions.reconcile({
      previous: input.previousSession,
      selection,
      gameTimeSec: input.decision.state.gameTimeSec,
    });
    const strategy = input.strategies.find((candidate) => candidate.strategyId === session.strategyId)
      ?? input.strategies.find((candidate) => candidate.strategyId === selection.selectedStrategyId)
      ?? [...input.strategies].sort((a, b) => b.support - a.support || b.stability - a.stability || a.strategyId.localeCompare(b.strategyId))[0];
    const scorerContext = this.baseScorerContext(input, ownedItemIds, strategy.strategyId);
    const branchState = this.resolveBranches(strategy, input, scorerContext);
    const baseInitialContract = this.contracts.resolve({
      strategy,
      itemGraph: input.decision.itemGraph,
      ownedItemIds,
      selectedBranches: branchState.selected,
      committedBranches: branchState.committed,
      commitment: session.commitment,
    });
    const initialInvestmentPlan = this.investments.resolve({
      strategy,
      contract: baseInitialContract,
      investment: input.decision.investment,
    });
    const initialContract = applyHardInvestmentObligations(
      strategy,
      baseInitialContract,
      initialInvestmentPlan,
      input.decision.investment,
    );
    const initialNode: StrategyNodeV1 = {
      decisionState: input.decision.state,
      slots: input.decision.slots,
      investment: input.decision.investment,
      contract: initialContract,
      actions: [],
      utility: 0,
    };

    const immediate = this.evaluateNode(input, strategy, initialNode, branchState, scorerContext);
    const best = this.search(input, strategy, initialNode, branchState, scorerContext);
    const first = best.actions[0] ?? immediate[0];
    const transactionSelected = first?.candidate.action.type !== undefined && first.candidate.action.type !== 'WAIT_SAVE';
    const baseDisplayContract = this.contracts.resolve({
      strategy,
      itemGraph: input.decision.itemGraph,
      ownedItemIds,
      selectedBranches: branchState.selected,
      committedBranches: branchState.committed,
      commitment: session.commitment,
      immediateMode: transactionSelected ? 'TRANSACTION' : 'WAIT',
    });
    const displayInvestmentPlan = this.investments.resolve({
      strategy,
      contract: baseDisplayContract,
      investment: input.decision.investment,
    });
    const investmentAwareContract = applyHardInvestmentObligations(
      strategy,
      baseDisplayContract,
      displayInvestmentPlan,
      input.decision.investment,
      transactionSelected ? 'TRANSACTION' : 'WAIT',
    );
    const slotPlan = this.slots.plan({
      strategy,
      contract: investmentAwareContract,
      itemGraph: input.decision.itemGraph,
      ownedItemIds,
      slots: input.decision.slots,
    });
    const effectiveContract = slotPlan.feasible
      ? investmentAwareContract
      : {
          ...investmentAwareContract,
          status: 'REPLAN_REQUIRED' as const,
          completionReasonCodes: unique([
            ...investmentAwareContract.completionReasonCodes,
            'NO_SLOT_FEASIBLE_PATH',
          ]).sort(),
        };
    const semanticTargetItemId = semanticNextTargetItemId(
      strategy,
      effectiveContract,
      displayInvestmentPlan,
      input.decision,
      first?.candidate,
    );
    const canServeCandidate = slotPlan.feasible &&
      effectiveContract.status !== 'REPLAN_REQUIRED';
    const nextAction: AdaptiveActionV1 = canServeCandidate
      ? first
        ? adaptiveAction(first.candidate, first.reasonCodes, semanticTargetItemId)
        : fallbackAction(effectiveContract, semanticTargetItemId)
      : {
          actionKey: 'HOLD',
          type: 'HOLD',
          targetItemId: semanticTargetItemId,
          reasonCodes: effectiveContract.status === 'OUT_OF_DISTRIBUTION'
            ? ['OUT_OF_DISTRIBUTION', ...effectiveContract.completionReasonCodes]
            : ['REPLAN_REQUIRED', ...effectiveContract.completionReasonCodes],
        };
    const strategyPlan = makeStrategyPlan(strategy, effectiveContract, slotPlan, displayInvestmentPlan);
    const recommendedBuild = this.buildRecommendedBuild(
      strategy,
      effectiveContract,
      slotPlan,
      input,
      scorerContext,
      nextAction,
      canServeCandidate ? first?.candidate : undefined,
    );
    const rankedImmediateCandidates = canServeCandidate
      ? immediate.map((value) => toAdaptiveScoredAction(value, semanticTargetItemId))
      : [];

    return {
      gameState: classifyAdaptiveGameStateV1(input.decision.ourTeamSouls, input.decision.enemyTeamSouls, 0.08),
      strategy,
      strategySelection: selection,
      strategySession: session,
      contract: effectiveContract,
      strategyPlan,
      nextAction,
      recommendedBuild,
      changes: [],
      rankedImmediateCandidates,
      totalScore: canServeCandidate ? best.utility : 0,
      confidence: canServeCandidate ? first?.confidence ?? 0 : 0,
      plannerVersion: this.version,
    };
  }

  private resolveBranches(
    strategy: BuildStrategySpecV1,
    input: StrategyFirstBuildPlannerV1Input,
    scorerContext: AdaptiveItemScoreContextV1,
  ): { selected: Record<string, string>; committed: Record<string, string> } {
    const selected: Record<string, string> = { ...(input.previousContract?.selectedBranches ?? {}) };
    const committed: Record<string, string> = { ...(input.previousContract?.committedBranches ?? {}) };
    const owned = heldIds(input.decision.state);
    const goalById = new Map(strategy.goals.map((goal) => [goal.goalId, goal]));

    for (const branch of strategy.branchGroups) {
      if (committed[branch.branchGroupId]) {
        selected[branch.branchGroupId] = committed[branch.branchGroupId];
        continue;
      }
      const ownedOption = branch.optionGoalIds.find((goalId) => {
        const goal = goalById.get(goalId);
        return goal?.targetItemIds.some((itemId) => input.decision.itemGraph.isTargetSatisfied(itemId, owned));
      });
      if (ownedOption) {
        selected[branch.branchGroupId] = ownedOption;
        committed[branch.branchGroupId] = ownedOption;
        continue;
      }
      const best = branch.optionGoalIds
        .map((goalId) => ({ goalId, score: scoreGoal(goalById.get(goalId), this.scorer, scorerContext) }))
        .sort((a, b) => b.score - a.score || a.goalId.localeCompare(b.goalId))[0];
      if (best) selected[branch.branchGroupId] = best.goalId;
    }
    return { selected, committed };
  }

  private search(
    input: StrategyFirstBuildPlannerV1Input,
    strategy: BuildStrategySpecV1,
    initial: StrategyNodeV1,
    branches: { selected: Record<string, string>; committed: Record<string, string> },
    baseContext: AdaptiveItemScoreContextV1,
  ): StrategyNodeV1 {
    const depth = Math.max(1, Math.min(5, input.planningDepth ?? 3));
    const width = Math.max(1, Math.min(16, input.beamWidth ?? 8));
    let beam: StrategyNodeV1[] = [initial];
    let best = initial;
    for (let step = 0; step < depth; step += 1) {
      const next: StrategyNodeV1[] = [];
      for (const node of beam) {
        if (node.contract.status === 'COMPLETE' || node.contract.status === 'REPLAN_REQUIRED' || node.contract.status === 'OUT_OF_DISTRIBUTION') {
          if (node.utility > best.utility) best = node;
          continue;
        }
        const context: AdaptiveItemScoreContextV1 = {
          ...baseContext,
          ownedItemIds: heldIds(node.decisionState),
          plannedPrefixItemIds: node.actions
            .map((entry) => candidateTarget(entry.candidate))
            .filter((itemId): itemId is number => itemId !== undefined),
        };
        const candidates = this.evaluateNode(input, strategy, node, branches, context);
        for (const scored of candidates.slice(0, width)) {
          if (scored.candidate.action.type === 'WAIT_SAVE') {
            const waiting = {
              ...node,
              actions: [...node.actions, scored],
              utility: node.utility + scored.score * Math.pow(0.82, step),
            };
            if (waiting.utility > best.utility) best = waiting;
            continue;
          }
          const projectedDecision = projectRecommendationCandidateState(
            node.decisionState,
            scored.candidate,
            input.decision.itemGraph,
          );
          const projectedItemIds = heldIds(projectedDecision);
          const projectedSlots = deriveAdaptiveSlotStateV1(
            projectedItemIds,
            input.decision.itemGraph,
            input.decision.economyRules
              ? slotRulesFromEconomyRulesV1(input.decision.economyRules)
              : {
                  baseSlots: node.slots.baseSlots,
                  baseSlotsByType: node.slots.baseSlotsByType,
                  maxFlexSlots: node.slots.maxFlexSlots,
                  maxActiveItems: node.slots.maxActiveItems,
                },
            { unlockedFlexSlots: node.slots.unlockedFlexSlots, evidence: node.slots.evidence ?? node.slots.flexEvidence },
          );
          const projectedInvestment = deriveAdaptiveInvestmentStateV1(
            projectedItemIds,
            input.decision.itemGraph,
            input.decision.economyRules,
          );
          const baseProjectedContract = this.contracts.resolve({
            strategy,
            itemGraph: input.decision.itemGraph,
            ownedItemIds: projectedItemIds,
            selectedBranches: branches.selected,
            committedBranches: branches.committed,
            commitment: node.contract.commitment,
          });
          const projectedInvestmentPlan = this.investments.resolve({
            strategy,
            contract: baseProjectedContract,
            investment: projectedInvestment,
          });
          const projectedContract = applyHardInvestmentObligations(
            strategy,
            baseProjectedContract,
            projectedInvestmentPlan,
            projectedInvestment,
          );
          const completionGain = resolvedHardGoalCount(strategy, projectedContract) -
            resolvedHardGoalCount(strategy, node.contract);
          const projected: StrategyNodeV1 = {
            decisionState: projectedDecision,
            slots: projectedSlots,
            investment: projectedInvestment,
            contract: projectedContract,
            actions: [...node.actions, scored],
            utility: node.utility + (scored.score + completionGain * 1.5) * Math.pow(0.82, step),
          };
          next.push(projected);
          if (projected.utility > best.utility || projectedContract.status === 'COMPLETE') best = projected;
        }
      }
      if (next.length === 0) break;
      beam = next
        .sort((a, b) => b.utility - a.utility || actionPathKey(a).localeCompare(actionPathKey(b)))
        .slice(0, width);
    }
    return best.actions.length === 0 && beam[0]?.actions.length ? beam[0] : best;
  }

  private evaluateNode(
    input: StrategyFirstBuildPlannerV1Input,
    strategy: BuildStrategySpecV1,
    node: StrategyNodeV1,
    branches: { selected: Record<string, string>; committed: Record<string, string> },
    scorerContext: AdaptiveItemScoreContextV1,
  ): ScoredStrategyCandidateV1[] {
    const owned = heldIds(node.decisionState);
    const slotPlan = this.slots.plan({
      strategy,
      contract: node.contract,
      itemGraph: input.decision.itemGraph,
      ownedItemIds: owned,
      slots: node.slots,
    });
    const currentGoal = strategy.goals.find((goal) => goal.goalId === node.contract.currentGoalId);
    const beforeInvestmentPlan = this.investments.resolve({
      strategy,
      contract: node.contract,
      investment: node.investment,
    });
    const activeInvestmentObjective = currentGoal
      ? undefined
      : firstActionableHardInvestmentObjective(strategy, beforeInvestmentPlan);
    const rules = candidateGeneratorRulesFromSlotStateV1(node.slots, {
      allowSellOnlyActions: true,
      generateTargetedWaitActions: true,
    });
    const all = generateRecommendationCandidates({
      state: node.decisionState,
      itemGraph: input.decision.itemGraph,
      rules,
    }).filter((candidate) => candidate.feasible && candidate.recommendationEligible);
    let relevant = all
      .filter((candidate) => this.candidateRelevant(
        candidate,
        currentGoal,
        activeInvestmentObjective,
        strategy,
        slotPlan,
        input.decision.itemGraph,
      ))
      .filter((candidate) => preservesResolvedHardGoalsAfterCandidate(
        candidate,
        node,
        strategy,
        branches,
        input,
        this.contracts,
      ));
    relevant = relevant.filter((candidate) =>
      candidate.action.type !== 'REPLACE_ITEM' ||
      this.replacementImprovesWholeBuild(candidate, node, strategy, input, scorerContext),
    );
    const transactions = relevant.filter((candidate) => candidate.action.type !== 'WAIT_SAVE');
    const candidates = transactions.length > 0
      ? relevant
      : relevant.length > 0
        ? relevant
        : all.filter((candidate) => candidate.action.type === 'WAIT_SAVE' && candidate.action.targetItemId === undefined);

    return candidates.map((candidate) => {
      const targetItemId = candidateTarget(candidate);
      const itemScore = targetItemId === undefined ? undefined : safeScoreItem(this.scorer, targetItemId, scorerContext);
      const projectedDecision = projectRecommendationCandidateState(
        node.decisionState,
        candidate,
        input.decision.itemGraph,
      );
      const projectedItemIds = heldIds(projectedDecision);
      const baseProjectedContract = this.contracts.resolve({
        strategy,
        itemGraph: input.decision.itemGraph,
        ownedItemIds: projectedItemIds,
        selectedBranches: branches.selected,
        committedBranches: branches.committed,
        commitment: node.contract.commitment,
      });
      const projectedInvestment = deriveAdaptiveInvestmentStateV1(
        projectedItemIds,
        input.decision.itemGraph,
        input.decision.economyRules,
      );
      const afterInvestmentPlan = this.investments.resolve({
        strategy,
        contract: baseProjectedContract,
        investment: projectedInvestment,
      });
      const projectedContract = applyHardInvestmentObligations(
        strategy,
        baseProjectedContract,
        afterInvestmentPlan,
        projectedInvestment,
      );
      const investmentUtility = this.investments.alignmentUtility(
        beforeInvestmentPlan,
        afterInvestmentPlan,
        strategy,
      );
      const strategic = strategicCandidateUtility(
        candidate,
        currentGoal,
        node.contract,
        projectedContract,
        slotPlan,
        input.decision.itemGraph,
      );
      const continuity = continuityAdjustment(candidate, input);
      const waitAdjustment = candidate.action.type === 'WAIT_SAVE' ? (transactions.length === 0 ? 0.12 : -0.25) : 0;
      const score = (itemScore?.score ?? 0) + strategic + investmentUtility * 0.45 + continuity.score + waitAdjustment;
      const reasonCodes = [
        ...(currentGoal ? [`STRATEGY_GOAL:${currentGoal.goalId}`, ...currentGoal.rationaleCodes] : []),
        ...(activeInvestmentObjective ? [`INVESTMENT_OBJECTIVE:${activeInvestmentObjective.objectiveId}`] : []),
        ...candidate.recommendationSuppressionReasons,
        ...continuity.reasonCodes,
        ...(strategic > 0 ? ['ADVANCES_SELECTED_STRATEGY'] : []),
        ...(investmentUtility > 0 ? ['ADVANCES_STRATEGIC_INVESTMENT'] : []),
      ];
      return {
        candidate,
        score,
        confidence: itemScore?.confidence ?? (candidate.action.type === 'WAIT_SAVE' ? 0.5 : 0.25),
        components: itemScore?.components ?? [],
        reasonCodes: unique(reasonCodes).sort(),
      };
    }).sort((a, b) =>
      b.score - a.score ||
      b.confidence - a.confidence ||
      a.candidate.actionId.localeCompare(b.candidate.actionId),
    );
  }

  private replacementImprovesWholeBuild(
    candidate: RecommendationCandidate,
    node: StrategyNodeV1,
    strategy: BuildStrategySpecV1,
    input: StrategyFirstBuildPlannerV1Input,
    scorerContext: AdaptiveItemScoreContextV1,
  ): boolean {
    const action = candidate.action;
    if (action.type !== 'REPLACE_ITEM') return true;

    const currentItemIds = heldIds(node.decisionState);
    const projectedDecision = projectRecommendationCandidateState(
      node.decisionState,
      candidate,
      input.decision.itemGraph,
    );
    const projectedItemIds = heldIds(projectedDecision);
    const projectedInvestment = deriveAdaptiveInvestmentStateV1(
      projectedItemIds,
      input.decision.itemGraph,
      input.decision.economyRules,
    );
    const investmentDelta = derivePlannerInvestmentDeltaV1(node.investment, projectedInvestment);
    const continuity = continuityAdjustment(candidate, input);
    const evaluation = this.wholeBuildUtility.evaluateReplacement({
      kind: replacementKindV1(strategy, input.decision.itemGraph, action.sellItemId, action.buyItemId),
      current: wholeBuildContributionsV1(currentItemIds, this.scorer, scorerContext),
      candidate: wholeBuildContributionsV1(projectedItemIds, this.scorer, scorerContext),
      transactionFriction: 0,
      churnPenalty: Math.max(0, -continuity.score),
      investmentLoss: investmentDelta.achievedBreakpointsLost *
        ADAPTIVE_POLICY_V1_CONFIG.investment.achievedBreakpointDropPenalty,
      finalItemCount: projectedItemIds.length,
      maxItemCount: node.slots.totalCapacity ?? node.slots.baseSlots + node.slots.maxFlexSlots,
      protectedSale: isHardCoreProtectedSaleV1(strategy, input.decision.itemGraph, action.sellItemId),
      sellEconomicsKnown: candidate.evidence.transaction !== 'UNKNOWN',
    });
    return evaluation.accepted;
  }

  private candidateRelevant(
    candidate: RecommendationCandidate,
    currentGoal: BuildStrategyGoalV1 | undefined,
    activeInvestmentObjective: BuildInvestmentObjectiveV1 | undefined,
    strategy: BuildStrategySpecV1,
    slotPlan: BuildSlotPlanV1,
    graph: RecommendationItemGraph,
  ): boolean {
    const action = candidate.action;
    if (currentGoal) {
      const relevant = new Set<number>();
      for (const target of currentGoal.targetItemIds) {
        relevant.add(target);
        for (const component of graph.getTransitiveComponentIds(target)) relevant.add(component);
      }
      const transition = slotPlan.futureTransitions.find((entry) => entry.targetGoalId === currentGoal.goalId);
      if (action.type === 'WAIT_SAVE') {
        return action.targetItemId === undefined ||
          (action.targetItemId !== undefined && relevant.has(action.targetItemId));
      }
      if (transition?.requirement === 'BLOCKED') return false;
      if (action.type === 'BUY_ITEM' || action.type === 'UPGRADE_ITEM') return relevant.has(action.itemId);
      if (action.type === 'REPLACE_ITEM') {
        return transition?.requirement === 'REPLACE' && relevant.has(action.buyItemId);
      }
      if (action.type === 'SELL_ITEM') {
        return transition?.requirement === 'SELL_TEMPORARY' && transition.sourceItemId === action.itemId;
      }
      return false;
    }

    if (!activeInvestmentObjective) {
      return action.type === 'WAIT_SAVE' && action.targetItemId === undefined;
    }
    if (action.type === 'WAIT_SAVE') return action.targetItemId === undefined;
    if (action.type === 'SELL_ITEM') return false;
    const targetItemId = action.type === 'BUY_ITEM' || action.type === 'UPGRADE_ITEM'
      ? action.itemId
      : action.type === 'REPLACE_ITEM'
        ? action.buyItemId
        : undefined;
    if (targetItemId === undefined || !strategyItemUniverse(strategy, graph).has(targetItemId)) return false;
    return graph.getItem(targetItemId)?.slotType === activeInvestmentObjective.type;
  }

  private buildRecommendedBuild(
    strategy: BuildStrategySpecV1,
    contract: BuildContractV1,
    slotPlan: BuildSlotPlanV1,
    input: StrategyFirstBuildPlannerV1Input,
    scorerContext: AdaptiveItemScoreContextV1,
    nextAction: AdaptiveActionV1,
    nextCandidate: RecommendationCandidate | undefined,
  ): readonly AdaptivePlannedItemV1[] {
    const owned = heldIds(input.decision.state);
    const rows: AdaptivePlannedItemV1[] = owned.map((itemId, index) => ({
      itemId,
      position: index + 1,
      status: 'OWNED',
      score: 0,
      confidence: 1,
      skeletonStrength: 0,
      contextualSupport: 1,
      reasonCodes: ['OWNED_ITEM', `STRATEGY:${strategy.strategyId}`],
    }));
    const seen = new Set(owned);
    const nextTransactionTarget = nextCandidate ? candidateTarget(nextCandidate) : undefined;
    if (nextTransactionTarget !== undefined && !seen.has(nextTransactionTarget) &&
      !input.decision.itemGraph.isTargetSatisfied(nextTransactionTarget, owned)) {
      const score = safeScoreItem(this.scorer, nextTransactionTarget, scorerContext);
      rows.push({
        itemId: nextTransactionTarget,
        position: rows.length + 1,
        status: nextAction.targetItemId === nextTransactionTarget ? 'NEXT' : 'PLANNED',
        score: score?.score ?? 0,
        confidence: score?.confidence ?? 0,
        skeletonStrength: 0,
        contextualSupport: score?.confidence ?? 0,
        reasonCodes: ['FIRST_LEGAL_STRATEGY_TRANSACTION', `STRATEGY:${strategy.strategyId}`],
      });
      seen.add(nextTransactionTarget);
    }

    const orderedGoals = stableGoalOrder(strategy, input.previousRecommendedBuild);
    for (const goal of orderedGoals) {
      const state = contract.goalStates[goal.goalId];
      if (state === 'SKIPPED' || state === 'WAIVED' || state === 'SATISFIED') continue;
      // Soft goals stay non-mandatory: they never gate completion and never become the
      // executable target, but the semantic build path still shows the progression.
      const optionalProgression = !goal.hard && contract.currentGoalId !== goal.goalId;
      const slotTransition = slotPlan.futureTransitions.find((entry) => entry.targetGoalId === goal.goalId);
      if (slotTransition?.requirement === 'BLOCKED') continue;
      for (const itemId of goal.targetItemIds) {
        if (seen.has(itemId) || input.decision.itemGraph.isTargetSatisfied(itemId, owned)) continue;
        if (goal.type === 'BRANCH' && !Object.values(contract.selectedBranches).includes(goal.goalId)) continue;
        const score = safeScoreItem(this.scorer, itemId, scorerContext);
        rows.push({
          itemId,
          position: rows.length + 1,
          status: rows.every((entry) => entry.status !== 'NEXT') && nextAction.targetItemId === itemId ? 'NEXT' : 'PLANNED',
          score: score?.score ?? 0,
          confidence: score?.confidence ?? 0,
          skeletonStrength: 0,
          contextualSupport: score?.confidence ?? 0,
          reasonCodes: [
            `STRATEGY_GOAL:${goal.goalId}`,
            ...(optionalProgression ? ['OPTIONAL_PROGRESSION'] : []),
            ...goal.rationaleCodes,
          ],
        });
        seen.add(itemId);
        if (goal.maxSelect === 1) break;
      }
    }
    return rows.map((row, index) => ({ ...row, position: index + 1 }));
  }

  private baseScorerContext(
    input: StrategyFirstBuildPlannerV1Input,
    ownedItemIds: readonly number[],
    strategyId: string,
  ): AdaptiveItemScoreContextV1 {
    const soulDelta = input.decision.ourTeamSouls === undefined || input.decision.enemyTeamSouls === undefined
      ? undefined
      : (input.decision.ourTeamSouls - input.decision.enemyTeamSouls) /
        Math.max(1, input.decision.ourTeamSouls + input.decision.enemyTeamSouls);
    const blend = soulDelta === undefined
      ? { ahead: 0, even: 0, behind: 0 }
      : soulDelta > 0.08
        ? { ahead: 1, even: 0, behind: 0 }
        : soulDelta < -0.08
          ? { ahead: 0, even: 0, behind: 1 }
          : { ahead: 0, even: 1, behind: 0 };
    return {
      heroId: input.decision.state.heroId,
      enemyHeroIds: input.decision.enemyHeroIds,
      gameTimeSec: input.decision.state.gameTimeSec,
      gameStateBlend: blend,
      ownedItemIds,
      plannedPrefixItemIds: [],
      evidence: input.evidence,
      ownBuildArchetype: strategyId,
      enemyCompositionKey: [...input.decision.enemyHeroIds].sort((a, b) => a - b).join(','),
    };
  }
}

function applyHardInvestmentObligations(
  strategy: BuildStrategySpecV1,
  contract: BuildContractV1,
  investmentPlan: BuildInvestmentPlanV1,
  investment: AdaptiveInvestmentStateV1,
  immediateMode?: 'TRANSACTION' | 'WAIT',
): BuildContractV1 {
  const stateById = new Map(investmentPlan.objectives.map((objective) => [objective.objectiveId, objective.state]));
  const remaining = strategy.investmentPolicy.objectives
    .filter((objective) => objective.hard)
    .filter((objective) => {
      const state = stateById.get(objective.objectiveId);
      return state !== 'SATISFIED' && state !== 'WAIVED';
    })
    .map((objective) => objective.objectiveId)
    .sort();
  if (remaining.length === 0) return contract;

  const reasons = unique([
    ...contract.completionReasonCodes,
    'HARD_INVESTMENT_OBJECTIVES_REMAIN',
    ...remaining.map((objectiveId) => `REMAINING_INVESTMENT:${objectiveId}`),
  ]).sort();
  if (investment.evidence === 'UNKNOWN' && contract.remainingHardGoalIds.length === 0) {
    return {
      ...contract,
      status: 'REPLAN_REQUIRED',
      completionReasonCodes: unique([...reasons, 'INVESTMENT_RULES_UNKNOWN']).sort(),
    };
  }
  const locked = investmentPlan.objectives.some((objective) =>
    remaining.includes(objective.objectiveId) && objective.state === 'LOCKED',
  );
  if (locked && contract.remainingHardGoalIds.length === 0) {
    return {
      ...contract,
      status: 'REPLAN_REQUIRED',
      completionReasonCodes: unique([...reasons, 'HARD_INVESTMENT_OBJECTIVE_LOCKED']).sort(),
    };
  }
  if (contract.status === 'COMPLETE') {
    return {
      ...contract,
      status: immediateMode === 'WAIT' ? 'WAITING' : 'IN_PROGRESS',
      completionReasonCodes: reasons,
    };
  }
  return { ...contract, completionReasonCodes: reasons };
}

function firstActionableHardInvestmentObjective(
  strategy: BuildStrategySpecV1,
  plan: BuildInvestmentPlanV1,
): BuildInvestmentObjectiveV1 | undefined {
  const active = new Set(plan.objectives
    .filter((objective) => objective.state === 'ACTIVE')
    .map((objective) => objective.objectiveId));
  return strategy.investmentPolicy.objectives.find((objective) => objective.hard && active.has(objective.objectiveId));
}

function preservesResolvedHardGoalsAfterCandidate(
  candidate: RecommendationCandidate,
  node: StrategyNodeV1,
  strategy: BuildStrategySpecV1,
  branches: { selected: Record<string, string>; committed: Record<string, string> },
  input: StrategyFirstBuildPlannerV1Input,
  contracts: BuildContractV1Service,
): boolean {
  const terminalGoalIds = new Set(strategy.terminalPolicy.requiredGoalIds);
  const protectedGoalIds = strategy.goals
    .filter((goal) => goal.hard && terminalGoalIds.has(goal.goalId) && isResolved(node.contract.goalStates[goal.goalId]))
    .map((goal) => goal.goalId);
  if (protectedGoalIds.length === 0) return true;
  const projected = projectRecommendationCandidateState(node.decisionState, candidate, input.decision.itemGraph);
  const projectedContract = contracts.resolve({
    strategy,
    itemGraph: input.decision.itemGraph,
    ownedItemIds: heldIds(projected),
    selectedBranches: branches.selected,
    committedBranches: branches.committed,
    commitment: node.contract.commitment,
  });
  return protectedGoalIds.every((goalId) => isResolved(projectedContract.goalStates[goalId]));
}

function semanticNextTargetItemId(
  strategy: BuildStrategySpecV1,
  contract: BuildContractV1,
  investmentPlan: BuildInvestmentPlanV1,
  decision: AdaptiveDecisionStateV1,
  selectedCandidate: RecommendationCandidate | undefined,
): number | undefined {
  const candidateItemId = selectedCandidate ? candidateTarget(selectedCandidate) : undefined;
  if (candidateItemId !== undefined) return candidateItemId;
  const owned = heldIds(decision.state);
  const currentGoal = strategy.goals.find((goal) => goal.goalId === contract.currentGoalId);
  const goalTarget = currentGoal?.targetItemIds.find((itemId) => !decision.itemGraph.isTargetSatisfied(itemId, owned));
  if (goalTarget !== undefined) return goalTarget;
  const objective = firstActionableHardInvestmentObjective(strategy, investmentPlan);
  if (!objective) return undefined;
  return strategyItemIdsInOrder(strategy)
    .find((itemId) =>
      decision.itemGraph.getItem(itemId)?.slotType === objective.type &&
      !decision.itemGraph.isTargetSatisfied(itemId, owned),
    );
}

function wholeBuildContributionsV1(
  itemIds: readonly number[],
  scorer: AdaptiveEvidenceScorerV1Service,
  context: AdaptiveItemScoreContextV1,
): WholeBuildUtilityContributionsV1 {
  const result: WholeBuildUtilityContributionsV1 = {
    skeletonAdherence: 0,
    coreIntegrity: 0,
    branchCoherence: 0,
    threatMatchup: 0,
    synergy: 0,
    timing: 0,
    slotEfficiency: 0,
    economyOpportunityCost: 0,
    investmentContinuity: 0,
  };
  const buildContext: AdaptiveItemScoreContextV1 = {
    ...context,
    ownedItemIds: [...itemIds],
    plannedPrefixItemIds: [],
  };

  for (const itemId of itemIds) {
    const score = safeScoreItem(scorer, itemId, buildContext);
    for (const component of score?.components ?? []) {
      const weighted = Number.isFinite(component.weighted) ? component.weighted : 0;
      if (component.key === 'skeletonPrior' || component.key === 'skeletonDeviation') {
        result.skeletonAdherence += weighted;
      } else if (component.key === 'ownBuildFit') {
        result.branchCoherence += weighted;
      } else if (component.key === 'draftMatchupFit' || component.key === 'enemyCompositionFit') {
        result.threatMatchup += weighted;
      } else if (component.key === 'chainFit') {
        result.synergy += weighted;
      } else if (component.key === 'gameStateFit' || component.key === 'timingFit' || component.key === 'laneFit') {
        result.timing += weighted;
      } else if (component.key === 'slotEfficiency') {
        result.slotEfficiency += weighted;
      } else if (component.key === 'investmentUtility') {
        result.investmentContinuity += weighted;
      }
    }
  }
  return result;
}

function replacementKindV1(
  strategy: BuildStrategySpecV1,
  graph: RecommendationItemGraph,
  sellItemId: number,
  buyItemId: number,
): WholeBuildReplacementKindV1 {
  if (!strategyItemUniverse(strategy, graph).has(buyItemId)) return 'OUTSIDE_SKELETON';
  const soldGoal = strategy.goals.find((goal) => goal.targetItemIds.some((targetItemId) =>
    targetItemId === sellItemId || graph.isComponentAncestor(sellItemId, targetItemId),
  ));
  return soldGoal && buildGoalRigidityV1(soldGoal) === 'SOFT_CORE' ? 'SOFT_CORE' : 'ORDINARY';
}

function isHardCoreProtectedSaleV1(
  strategy: BuildStrategySpecV1,
  graph: RecommendationItemGraph,
  sellItemId: number,
): boolean {
  return strategy.goals
    .filter((goal) => buildGoalRigidityV1(goal) === 'HARD_CORE')
    .some((goal) => goal.targetItemIds.some((targetItemId) =>
      targetItemId === sellItemId || graph.isComponentAncestor(sellItemId, targetItemId),
    ));
}

function strategicCandidateUtility(
  candidate: RecommendationCandidate,
  currentGoal: BuildStrategyGoalV1 | undefined,
  before: BuildContractV1,
  after: BuildContractV1,
  slotPlan: BuildSlotPlanV1,
  graph: RecommendationItemGraph,
): number {
  let utility = 0;
  if (currentGoal && isResolved(after.goalStates[currentGoal.goalId]) && !isResolved(before.goalStates[currentGoal.goalId])) utility += 1.25;
  const target = candidateTarget(candidate);
  if (currentGoal && target !== undefined) {
    if (currentGoal.targetItemIds.includes(target)) utility += 0.55;
    else if (currentGoal.targetItemIds.some((goalTarget) => graph.isComponentAncestor(target, goalTarget))) utility += 0.25;
  }
  const transition = currentGoal
    ? slotPlan.futureTransitions.find((entry) => entry.targetGoalId === currentGoal.goalId)
    : undefined;
  if (transition?.requirement === 'SELL_TEMPORARY' && candidate.action.type === 'SELL_ITEM' && transition.sourceItemId === candidate.action.itemId) utility += 0.65;
  if (transition?.requirement === 'REPLACE' && candidate.action.type === 'REPLACE_ITEM' && transition.sourceItemId === candidate.action.sellItemId) utility += 0.65;
  if (transition?.requirement === 'UPGRADE' && candidate.action.type === 'UPGRADE_ITEM') utility += 0.35;
  return utility;
}

function continuityAdjustment(
  candidate: RecommendationCandidate,
  input: StrategyFirstBuildPlannerV1Input,
): ContinuityAdjustmentV1 {
  let score = 0;
  const reasons: string[] = [];
  const recentPurchased = new Set(input.recentPurchasedItemIds ?? []);
  const recentSold = new Set(input.recentSoldItemIds ?? []);
  const target = candidateTarget(candidate);
  const action = candidate.action;
  if (target !== undefined && recentSold.has(target)) {
    score -= 0.9;
    reasons.push('RECENTLY_SOLD_REBUY_PENALTY');
  }
  const exitItemId = action.type === 'SELL_ITEM'
    ? action.itemId
    : action.type === 'REPLACE_ITEM'
      ? action.sellItemId
      : undefined;
  if (exitItemId !== undefined && recentPurchased.has(exitItemId)) {
    score -= 1;
    reasons.push('RECENT_PURCHASE_PROTECTION');
  }
  const previousNext = input.previousRecommendedBuild?.find((item) => item.status === 'NEXT')?.itemId;
  if (target !== undefined && previousNext === target) {
    score += 0.12;
    reasons.push('PLAN_CONTINUITY');
  }
  return { score, reasonCodes: reasons };
}

function makeStrategyPlan(
  strategy: BuildStrategySpecV1,
  contract: BuildContractV1,
  slotPlan: BuildSlotPlanV1,
  investmentPlan: BuildInvestmentPlanV1,
): AdaptiveStrategyPlanV1 {
  const hardGoals = strategy.goals.filter((goal) => goal.hard && contract.goalStates[goal.goalId] !== 'SKIPPED');
  const satisfiedHardGoals = hardGoals.filter((goal) => isResolved(contract.goalStates[goal.goalId])).length;
  const currentGoal = strategy.goals.find((goal) => goal.goalId === contract.currentGoalId);
  const investmentStateById = new Map(investmentPlan.objectives.map((objective) => [objective.objectiveId, objective.state]));
  const remainingHardInvestmentObjectiveIds = strategy.investmentPolicy.objectives
    .filter((objective) => objective.hard)
    .filter((objective) => {
      const state = investmentStateById.get(objective.objectiveId);
      return state !== 'SATISFIED' && state !== 'WAIVED';
    })
    .map((objective) => objective.objectiveId)
    .sort();
  return {
    strategyId: strategy.strategyId,
    buildStatus: contract.status,
    progress: { satisfiedHardGoals, totalHardGoals: hardGoals.length },
    currentGoal: currentGoal
      ? { goalId: currentGoal.goalId, type: currentGoal.type, reasonCodes: currentGoal.rationaleCodes }
      : undefined,
    remainingGoalIds: [...contract.remainingHardGoalIds],
    remainingHardInvestmentObjectiveIds,
    slotPlan,
    investmentPlan,
    situationalDecision: contract.activeSituationalDecision,
  };
}

function adaptiveAction(
  candidate: RecommendationCandidate,
  reasons: readonly string[],
  semanticTargetItemId?: number,
): AdaptiveActionV1 {
  const action = candidate.action;
  if (action.type === 'BUY_ITEM') {
    return { actionKey: candidate.actionId, type: 'BUY', itemId: action.itemId, targetItemId: action.itemId, reasonCodes: reasons };
  }
  if (action.type === 'UPGRADE_ITEM') {
    return { actionKey: candidate.actionId, type: 'UPGRADE', itemId: action.itemId, targetItemId: action.itemId, reasonCodes: reasons };
  }
  if (action.type === 'SELL_ITEM') {
    return {
      actionKey: candidate.actionId,
      type: 'SELL',
      itemId: action.itemId,
      sellItemId: action.itemId,
      targetItemId: semanticTargetItemId,
      reasonCodes: reasons,
    };
  }
  if (action.type === 'REPLACE_ITEM') {
    return {
      actionKey: candidate.actionId,
      type: 'REPLACE',
      sellItemId: action.sellItemId,
      buyItemId: action.buyItemId,
      targetItemId: action.buyItemId,
      reasonCodes: reasons,
    };
  }
  return {
    actionKey: candidate.actionId,
    type: 'WAIT',
    targetItemId: action.targetItemId ?? semanticTargetItemId,
    reasonCodes: reasons,
  };
}

function fallbackAction(contract: BuildContractV1, semanticTargetItemId?: number): AdaptiveActionV1 {
  if (contract.status === 'COMPLETE') {
    return { actionKey: 'HOLD', type: 'HOLD', reasonCodes: ['BUILD_CONTRACT_COMPLETE'] };
  }
  if (contract.status === 'REPLAN_REQUIRED' || contract.status === 'OUT_OF_DISTRIBUTION') {
    return {
      actionKey: 'HOLD',
      type: 'HOLD',
      targetItemId: semanticTargetItemId,
      reasonCodes: [contract.status, ...contract.completionReasonCodes],
    };
  }
  return {
    actionKey: 'WAIT',
    type: 'WAIT',
    targetItemId: semanticTargetItemId,
    reasonCodes: ['NO_LEGAL_STRATEGY_TRANSACTION', ...contract.completionReasonCodes],
  };
}

function toAdaptiveScoredAction(
  value: ScoredStrategyCandidateV1,
  semanticTargetItemId?: number,
): AdaptiveScoredActionV1 {
  return {
    action: adaptiveAction(value.candidate, value.reasonCodes, semanticTargetItemId),
    score: value.score,
    confidence: value.confidence,
    components: value.components,
    reasonCodes: value.reasonCodes,
  };
}

function candidateTarget(candidate: RecommendationCandidate): number | undefined {
  const action = candidate.action;
  if (action.type === 'BUY_ITEM' || action.type === 'UPGRADE_ITEM') return action.itemId;
  if (action.type === 'REPLACE_ITEM') return action.buyItemId;
  if (action.type === 'WAIT_SAVE') return action.targetItemId;
  return undefined;
}

function strategyItemUniverse(
  strategy: BuildStrategySpecV1,
  graph: RecommendationItemGraph,
): ReadonlySet<number> {
  const values = new Set<number>();
  for (const itemId of strategyItemIdsInOrder(strategy)) {
    values.add(itemId);
    for (const componentId of graph.getTransitiveComponentIds(itemId)) values.add(componentId);
  }
  for (const window of strategy.situationalWindows) {
    for (const itemIds of Object.values(window.candidateItemIdsByPurpose ?? {})) {
      for (const itemId of itemIds ?? []) values.add(itemId);
    }
  }
  return values;
}

function strategyItemIdsInOrder(strategy: BuildStrategySpecV1): number[] {
  const result: number[] = [];
  const seen = new Set<number>();
  for (const goal of strategy.goals) {
    for (const itemId of goal.targetItemIds) {
      if (seen.has(itemId)) continue;
      seen.add(itemId);
      result.push(itemId);
    }
  }
  return result;
}

function stableGoalOrder(
  strategy: BuildStrategySpecV1,
  previousBuild: readonly AdaptivePlannedItemV1[] | undefined,
): BuildStrategyGoalV1[] {
  if (!previousBuild?.length) return [...strategy.goals];
  const previousPosition = new Map(previousBuild.map((item) => [item.itemId, item.position]));
  const declaration = new Map(strategy.goals.map((goal, index) => [goal.goalId, index]));
  return [...strategy.goals].sort((a, b) => {
    const aPosition = Math.min(...a.targetItemIds.map((itemId) => previousPosition.get(itemId) ?? Number.MAX_SAFE_INTEGER));
    const bPosition = Math.min(...b.targetItemIds.map((itemId) => previousPosition.get(itemId) ?? Number.MAX_SAFE_INTEGER));
    const aHadPosition = Number.isFinite(aPosition) && aPosition !== Number.MAX_SAFE_INTEGER;
    const bHadPosition = Number.isFinite(bPosition) && bPosition !== Number.MAX_SAFE_INTEGER;
    if (aHadPosition && bHadPosition && aPosition !== bPosition) return aPosition - bPosition;
    if (aHadPosition !== bHadPosition) return aHadPosition ? -1 : 1;
    return (declaration.get(a.goalId) ?? 0) - (declaration.get(b.goalId) ?? 0);
  });
}

function scoreGoal(
  goal: BuildStrategyGoalV1 | undefined,
  scorer: AdaptiveEvidenceScorerV1Service,
  context: AdaptiveItemScoreContextV1,
): number {
  if (!goal) return Number.NEGATIVE_INFINITY;
  return Math.max(...goal.targetItemIds.map((itemId) =>
    safeScoreItem(scorer, itemId, context)?.score ?? Number.NEGATIVE_INFINITY,
  ));
}

function safeScoreItem(
  scorer: AdaptiveEvidenceScorerV1Service,
  itemId: number,
  context: AdaptiveItemScoreContextV1,
): AdaptiveItemScoreV1 | undefined {
  try {
    return scorer.scoreItem(itemId, context);
  } catch {
    return undefined;
  }
}

function heldIds(state: RecommendationDecisionState): number[] {
  return [...state.inventory.heldByItemId.keys()].sort((a, b) => a - b);
}

function resolvedHardGoalCount(strategy: BuildStrategySpecV1, contract: BuildContractV1): number {
  return strategy.goals.filter((goal) => goal.hard && isResolved(contract.goalStates[goal.goalId])).length;
}

function isResolved(value: string | undefined): boolean {
  return value === 'SATISFIED' || value === 'SKIPPED' || value === 'WAIVED';
}

function actionPathKey(node: StrategyNodeV1): string {
  return node.actions.map((entry) => entry.candidate.actionId).join('|');
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
