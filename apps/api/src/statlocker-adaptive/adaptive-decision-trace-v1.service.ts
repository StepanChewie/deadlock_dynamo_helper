import { Injectable } from '@nestjs/common';
import {
  generateRecommendationCandidates,
  projectRecommendationCandidateState,
  RecommendationCandidate,
  RecommendationItemGraph,
} from '@deadlock-live-probe/build-domain';
import {
  ADAPTIVE_DECISION_TRACE_VERSION_V1,
  AdaptiveActionV1,
  AdaptiveDecisionCandidateSourceV1,
  AdaptiveDecisionPolicySnapshotV1,
  AdaptiveDecisionReplacementTraceV1,
  AdaptiveDecisionTraceCandidateV1,
  AdaptiveDecisionTraceUtilityDeltaV1,
  AdaptiveDecisionTraceV1,
  AdaptiveScoredActionV1,
} from '@deadlock-live-probe/shared';
import { AdaptiveBuildPlannerInputV1 } from './adaptive-build-planner-v1.service';
import {
  candidateGeneratorRulesFromSlotStateV1,
  deriveAdaptiveInvestmentStateV1,
} from './adaptive-economy-v1';
import {
  AdaptiveEvidenceScorerV1Service,
  AdaptiveItemScoreContextV1,
} from './adaptive-evidence-scorer-v1.service';
import { derivePlannerInvestmentDeltaV1 } from './adaptive-planner-transition-v1';
import { buildGoalRigidityV1, BuildStrategySpecV1 } from './build-strategy-v1';
import { StrategyFirstBuildPlannerV1Result } from './strategy-first-build-planner-v1.service';
import { ADAPTIVE_POLICY_V1_CONFIG } from './statlocker-adaptive.config';
import {
  WholeBuildReplacementKindV1,
  WholeBuildUtilityContributionsV1,
  WholeBuildUtilityV1Service,
} from './whole-build-utility-v1.service';

const MAX_REPLACEMENT_TRACE_ROWS = 6;

@Injectable()
export class AdaptiveDecisionTraceV1Service {
  private readonly wholeBuildUtility = new WholeBuildUtilityV1Service();

  constructor(private readonly scorer: AdaptiveEvidenceScorerV1Service) {}

  build(input: AdaptiveBuildPlannerInputV1, result: StrategyFirstBuildPlannerV1Result): AdaptiveDecisionTraceV1 {
    const replacementRows = this.replacementRows(input, result);
    const candidateByKey = new Map<string, AdaptiveDecisionTraceCandidateV1>();

    for (const ranked of result.rankedImmediateCandidates) {
      const selected = sameAction(ranked.action, result.nextAction);
      candidateByKey.set(ranked.action.actionKey, {
        action: cloneAction(ranked.action),
        source: classifyCandidateSource(ranked.action, result.strategy, result.contract, input.decision.itemGraph),
        selected,
        score: ranked.score,
        confidence: ranked.confidence,
        scoreComponents: ranked.components.map((component) => ({ ...component })),
        rejectionReasonCodes: selected ? [] : ['NOT_SELECTED_HIGHER_UTILITY'],
        matchup: matchupTrace(ranked),
      });
    }

    for (const replacement of replacementRows) {
      const action: AdaptiveActionV1 = {
        actionKey: `REPLACE:${replacement.sellItemId}->${replacement.buyItemId}`,
        type: 'REPLACE',
        sellItemId: replacement.sellItemId,
        buyItemId: replacement.buyItemId,
        targetItemId: replacement.buyItemId,
        reasonCodes: [...replacement.reasonCodes],
      };
      const existing = [...candidateByKey.values()].find((candidate) => sameReplacement(candidate.action, action));
      if (existing) {
        existing.requiredThreshold = replacement.requiredThreshold;
        if (!replacement.accepted) {
          existing.selected = false;
          existing.rejectionReasonCodes = [...replacement.reasonCodes];
        }
      } else {
        candidateByKey.set(action.actionKey, {
          action,
          source: classifyCandidateSource(action, result.strategy, result.contract, input.decision.itemGraph),
          selected: replacement.selected,
          scoreComponents: [],
          rejectionReasonCodes: replacement.accepted ? ['NOT_SELECTED_HIGHER_UTILITY'] : [...replacement.reasonCodes],
          matchup: { score: replacement.matchupGain, reasonCodes: [] },
          requiredThreshold: replacement.requiredThreshold,
        });
      }
    }

    return {
      version: ADAPTIVE_DECISION_TRACE_VERSION_V1,
      decisionId: input.decision.state.decisionId,
      stateRevision: input.decision.stateRevision,
      stages: [
        'SKELETON_BASELINE',
        'BRANCH_CHOICES',
        'MATCHUP_DISCOVERY',
        'WHOLE_BUILD_VALIDATION',
        ...(replacementRows.length > 0 ? ['SELL_SOURCE_EVALUATION' as const] : []),
        'FINAL_SELECTION',
      ],
      baseline: {
        strategyId: result.strategy.strategyId,
        inventoryItemIds: [...input.decision.state.inventory.heldByItemId.keys()].sort((a, b) => a - b),
        recommendedBuild: result.recommendedBuild.map((row) => ({ ...row, reasonCodes: [...row.reasonCodes] })),
      },
      branchChoices: { ...result.contract.selectedBranches },
      candidates: [...candidateByKey.values()]
        .sort((a, b) => Number(b.selected) - Number(a.selected) || (b.score ?? Number.NEGATIVE_INFINITY) - (a.score ?? Number.NEGATIVE_INFINITY) || a.action.actionKey.localeCompare(b.action.actionKey)),
      replacements: replacementRows,
      finalSelection: {
        action: cloneAction(result.nextAction),
        legalityRecheckChanged: false,
        reasonCodes: [...result.nextAction.reasonCodes],
      },
      policy: effectivePolicySnapshotV1(input),
    };
  }

  private replacementRows(
    input: AdaptiveBuildPlannerInputV1,
    result: StrategyFirstBuildPlannerV1Result,
  ): AdaptiveDecisionReplacementTraceV1[] {
    const seriousTargets = seriousTargetItemIds(result);
    const rules = candidateGeneratorRulesFromSlotStateV1(input.decision.slots, {
      allowSellOnlyActions: true,
      generateTargetedWaitActions: true,
    });
    const candidates = generateRecommendationCandidates({
      state: input.decision.state,
      itemGraph: input.decision.itemGraph,
      rules,
    }).filter((candidate) =>
      candidate.feasible &&
      candidate.recommendationEligible &&
      candidate.action.type === 'REPLACE_ITEM' &&
      (seriousTargets.size === 0 || seriousTargets.has(candidate.action.buyItemId)),
    );

    const context = scorerContext(input, result.strategy.strategyId);
    const rows = candidates.map((candidate) => this.evaluateReplacement(candidate, input, result, context));
    const selectedSignature = result.nextAction.type === 'REPLACE'
      ? `${result.nextAction.sellItemId ?? ''}->${result.nextAction.buyItemId ?? result.nextAction.targetItemId ?? ''}`
      : undefined;
    return rows
      .sort((a, b) => tracePriority(a, selectedSignature) - tracePriority(b, selectedSignature) || a.sellItemId - b.sellItemId || a.buyItemId - b.buyItemId)
      .slice(0, MAX_REPLACEMENT_TRACE_ROWS);
  }

  private evaluateReplacement(
    candidate: RecommendationCandidate,
    input: AdaptiveBuildPlannerInputV1,
    result: StrategyFirstBuildPlannerV1Result,
    context: AdaptiveItemScoreContextV1,
  ): AdaptiveDecisionReplacementTraceV1 {
    const action = candidate.action;
    if (action.type !== 'REPLACE_ITEM') throw new Error('Expected REPLACE_ITEM');
    const currentItemIds = heldIds(input.decision.state.inventory.heldByItemId);
    const projected = projectRecommendationCandidateState(input.decision.state, candidate, input.decision.itemGraph);
    const projectedItemIds = heldIds(projected.inventory.heldByItemId);
    const projectedInvestment = deriveAdaptiveInvestmentStateV1(
      projectedItemIds,
      input.decision.itemGraph,
      input.decision.economyRules,
    );
    const investmentDelta = derivePlannerInvestmentDeltaV1(input.decision.investment, projectedInvestment);
    const recentPurchaseProtected = new Set(input.recentPurchasedItemIds ?? []).has(action.sellItemId);
    const targetRecentlySold = new Set(input.recentSoldItemIds ?? []).has(action.buyItemId);
    const previousNext = input.previousResult?.recommendedBuild.find((row) => row.status === 'NEXT')?.itemId;
    const continuityPenalty = (recentPurchaseProtected ? 1 : 0) + (targetRecentlySold ? 0.9 : 0) - (previousNext === action.buyItemId ? 0.12 : 0);
    const evaluation = this.wholeBuildUtility.evaluateReplacement({
      kind: replacementKindV1(result.strategy, input.decision.itemGraph, action.sellItemId, action.buyItemId),
      current: wholeBuildContributionsV1(currentItemIds, this.scorer, context),
      candidate: wholeBuildContributionsV1(projectedItemIds, this.scorer, context),
      transactionFriction: 0,
      churnPenalty: Math.max(0, continuityPenalty),
      investmentLoss: investmentDelta.achievedBreakpointsLost * ADAPTIVE_POLICY_V1_CONFIG.investment.achievedBreakpointDropPenalty,
      finalItemCount: projectedItemIds.length,
      maxItemCount: input.decision.slots.totalCapacity ?? input.decision.slots.baseSlots + input.decision.slots.maxFlexSlots,
      protectedSale: recentPurchaseProtected || isHardCoreProtectedSaleV1(result.strategy, input.decision.itemGraph, action.sellItemId),
      sellEconomicsKnown: candidate.evidence.transaction !== 'UNKNOWN',
    });
    const deltas = utilityDeltas(evaluation.trace.current, evaluation.trace.candidate);
    const rawImprovement = round(evaluation.candidateUtility - evaluation.currentUtility);
    const economicOpportunityLoss = Math.max(0, round(evaluation.trace.current.economyOpportunityCost - evaluation.trace.candidate.economyOpportunityCost));
    return {
      sellItemId: action.sellItemId,
      buyItemId: action.buyItemId,
      selected: result.nextAction.type === 'REPLACE' && result.nextAction.sellItemId === action.sellItemId && result.nextAction.buyItemId === action.buyItemId,
      accepted: evaluation.accepted,
      inventoryCount: currentItemIds.length,
      maxItemCount: input.decision.slots.totalCapacity ?? input.decision.slots.baseSlots + input.decision.slots.maxFlexSlots,
      utilityBefore: evaluation.currentUtility,
      utilityAfter: evaluation.candidateUtility,
      rawImprovement,
      matchupGain: deltas.threatMatchup,
      skeletonDelta: deltas.skeletonAdherence,
      synergyDelta: deltas.synergy,
      timingDelta: deltas.timing,
      economicLoss: round(economicOpportunityLoss + evaluation.trace.penalties.investmentLoss),
      transactionPenalty: evaluation.trace.penalties.transactionFriction,
      churnPenalty: evaluation.trace.penalties.churnPenalty,
      netImprovement: evaluation.netGain,
      requiredThreshold: evaluation.threshold,
      utilityDeltas: deltas,
      reasonCodes: [...evaluation.reasonCodes],
    };
  }
}

export function reconcileAdaptiveDecisionTraceFinalSelectionV1(
  trace: AdaptiveDecisionTraceV1 | undefined,
  action: AdaptiveActionV1,
  legalityRecheckChanged: boolean,
): AdaptiveDecisionTraceV1 | undefined {
  if (!trace) return undefined;
  return {
    ...trace,
    candidates: trace.candidates.map((candidate) => ({
      ...candidate,
      selected: sameAction(candidate.action, action),
      rejectionReasonCodes: sameAction(candidate.action, action)
        ? []
        : candidate.rejectionReasonCodes.length > 0
          ? [...candidate.rejectionReasonCodes]
          : ['NOT_SELECTED_AFTER_FRESH_LEGALITY_RECHECK'],
    })),
    replacements: trace.replacements.map((replacement) => ({
      ...replacement,
      selected: action.type === 'REPLACE' && action.sellItemId === replacement.sellItemId && action.buyItemId === replacement.buyItemId,
    })),
    finalSelection: {
      action: cloneAction(action),
      legalityRecheckChanged,
      reasonCodes: [...action.reasonCodes],
    },
  };
}

export function effectivePolicySnapshotV1(input: AdaptiveBuildPlannerInputV1): AdaptiveDecisionPolicySnapshotV1 {
  const config = ADAPTIVE_POLICY_V1_CONFIG;
  return {
    policyVersion: config.version,
    heldItemCapacity: input.decision.slots.totalCapacity ?? input.decision.slots.baseSlots + input.decision.slots.maxFlexSlots,
    threatWeights: { ...config.threat.weights },
    threatClamp: { min: config.threat.minMultiplier, max: config.threat.maxMultiplier },
    shrinkK: { ...config.shrinkK },
    thresholds: {
      planSwitch: config.minPlanSwitchImprovement,
      sellBuy: config.sellMinImprovement,
      softCoreReplace: config.coreReplaceMinImprovement,
      wildcardReplace: config.situational.matchupDiscoveryReplaceMinImprovement,
      matchupConfidence: config.situational.minTargetConfidence,
    },
    recentPurchaseProtectionMs: config.recentPurchaseProtectionMs,
    soldItemRebuyPenaltyMs: config.recentSellRebuyPenaltyMs,
  };
}

function seriousTargetItemIds(result: StrategyFirstBuildPlannerV1Result): Set<number> {
  const ids = new Set<number>();
  for (const ranked of result.rankedImmediateCandidates) {
    const target = actionTarget(ranked.action);
    if (target !== undefined) ids.add(target);
  }
  const selected = actionTarget(result.nextAction);
  if (selected !== undefined) ids.add(selected);
  const currentGoal = result.strategy.goals.find((goal) => goal.goalId === result.contract.currentGoalId);
  for (const target of currentGoal?.targetItemIds ?? []) ids.add(target);
  return ids;
}

function scorerContext(input: AdaptiveBuildPlannerInputV1, strategyId: string): AdaptiveItemScoreContextV1 {
  const soulDelta = input.decision.ourTeamSouls === undefined || input.decision.enemyTeamSouls === undefined
    ? undefined
    : (input.decision.ourTeamSouls - input.decision.enemyTeamSouls) /
      Math.max(1, input.decision.ourTeamSouls + input.decision.enemyTeamSouls);
  const gameStateBlend = soulDelta === undefined
    ? { ahead: 0, even: 0, behind: 0 }
    : soulDelta > ADAPTIVE_POLICY_V1_CONFIG.gameStateThreshold
      ? { ahead: 1, even: 0, behind: 0 }
      : soulDelta < -ADAPTIVE_POLICY_V1_CONFIG.gameStateThreshold
        ? { ahead: 0, even: 0, behind: 1 }
        : { ahead: 0, even: 1, behind: 0 };
  return {
    heroId: input.decision.state.heroId,
    enemyHeroIds: input.decision.enemyHeroIds,
    gameTimeSec: input.decision.state.gameTimeSec,
    gameStateBlend,
    ownedItemIds: heldIds(input.decision.state.inventory.heldByItemId),
    plannedPrefixItemIds: [],
    evidence: input.evidence,
    ownBuildArchetype: strategyId,
    enemyCompositionKey: [...input.decision.enemyHeroIds].sort((a, b) => a - b).join(','),
  };
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
  const buildContext: AdaptiveItemScoreContextV1 = { ...context, ownedItemIds: [...itemIds], plannedPrefixItemIds: [] };
  for (const itemId of itemIds) {
    let score;
    try {
      score = scorer.scoreItem(itemId, buildContext);
    } catch {
      continue;
    }
    for (const component of score.components) {
      const weighted = Number.isFinite(component.weighted) ? component.weighted : 0;
      if (component.key === 'skeletonPrior' || component.key === 'skeletonDeviation') result.skeletonAdherence += weighted;
      else if (component.key === 'ownBuildFit') result.branchCoherence += weighted;
      else if (component.key === 'draftMatchupFit' || component.key === 'enemyCompositionFit') result.threatMatchup += weighted;
      else if (component.key === 'chainFit') result.synergy += weighted;
      else if (component.key === 'gameStateFit' || component.key === 'timingFit' || component.key === 'laneFit') result.timing += weighted;
      else if (component.key === 'slotEfficiency') result.slotEfficiency += weighted;
      else if (component.key === 'investmentUtility') result.investmentContinuity += weighted;
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
  const soldGoal = strategy.goals.find((goal) => goal.targetItemIds.some((target) => target === sellItemId || graph.isComponentAncestor(sellItemId, target)));
  return soldGoal && buildGoalRigidityV1(soldGoal) === 'SOFT_CORE' ? 'SOFT_CORE' : 'ORDINARY';
}

function isHardCoreProtectedSaleV1(strategy: BuildStrategySpecV1, graph: RecommendationItemGraph, sellItemId: number): boolean {
  return strategy.goals
    .filter((goal) => buildGoalRigidityV1(goal) === 'HARD_CORE')
    .some((goal) => goal.targetItemIds.some((target) => target === sellItemId || graph.isComponentAncestor(sellItemId, target)));
}

function strategyItemUniverse(strategy: BuildStrategySpecV1, graph: RecommendationItemGraph): Set<number> {
  const result = new Set<number>();
  for (const goal of strategy.goals) {
    for (const target of goal.targetItemIds) {
      result.add(target);
      for (const component of graph.getTransitiveComponentIds(target)) result.add(component);
    }
  }
  for (const window of strategy.situationalWindows) {
    for (const itemIds of Object.values(window.candidateItemIdsByPurpose ?? {})) {
      for (const itemId of itemIds ?? []) result.add(itemId);
    }
  }
  return result;
}

function classifyCandidateSource(
  action: AdaptiveActionV1,
  strategy: BuildStrategySpecV1,
  contract: StrategyFirstBuildPlannerV1Result['contract'],
  graph: RecommendationItemGraph,
): AdaptiveDecisionCandidateSourceV1 {
  const targetItemId = actionTarget(action);
  if (targetItemId === undefined) return 'SKELETON';
  if (contract.activeSituationalDecision?.targetItemId === targetItemId) return 'EXPLICIT_SITUATIONAL';
  const selectedBranchGoalIds = new Set(Object.values(contract.selectedBranches));
  if (strategy.goals.some((goal) => selectedBranchGoalIds.has(goal.goalId) && goal.targetItemIds.some((target) => target === targetItemId || graph.isComponentAncestor(targetItemId, target)))) return 'BRANCH';
  if (strategy.goals.some((goal) => goal.targetItemIds.some((target) => target === targetItemId || graph.isComponentAncestor(targetItemId, target)))) return 'SKELETON';
  if (strategy.situationalWindows.some((window) => Object.values(window.candidateItemIdsByPurpose ?? {}).some((items) => items?.includes(targetItemId)))) return 'DISCOVERED';
  return 'WILDCARD';
}

function matchupTrace(candidate: AdaptiveScoredActionV1) {
  const components = candidate.components.filter((component) => component.key === 'draftMatchupFit' || component.key === 'exactEnemyFit' || component.key === 'enemyCompositionFit');
  if (components.length === 0) return { reasonCodes: [] };
  return {
    score: round(components.reduce((sum, component) => sum + component.weighted, 0)),
    confidence: round(Math.max(...components.map((component) => component.confidence))),
    reasonCodes: candidate.reasonCodes.filter((code) => /MATCHUP|THREAT|ENEMY/.test(code)),
  };
}

function utilityDeltas(current: WholeBuildUtilityContributionsV1, candidate: WholeBuildUtilityContributionsV1): AdaptiveDecisionTraceUtilityDeltaV1 {
  return {
    skeletonAdherence: round(candidate.skeletonAdherence - current.skeletonAdherence),
    coreIntegrity: round(candidate.coreIntegrity - current.coreIntegrity),
    branchCoherence: round(candidate.branchCoherence - current.branchCoherence),
    threatMatchup: round(candidate.threatMatchup - current.threatMatchup),
    synergy: round(candidate.synergy - current.synergy),
    timing: round(candidate.timing - current.timing),
    slotEfficiency: round(candidate.slotEfficiency - current.slotEfficiency),
    economyOpportunityCost: round(candidate.economyOpportunityCost - current.economyOpportunityCost),
    investmentContinuity: round(candidate.investmentContinuity - current.investmentContinuity),
  };
}

function tracePriority(row: AdaptiveDecisionReplacementTraceV1, selectedSignature: string | undefined): number {
  if (`${row.sellItemId}->${row.buyItemId}` === selectedSignature) return -1_000_000;
  return Math.abs(row.netImprovement - row.requiredThreshold);
}

function sameReplacement(a: AdaptiveActionV1, b: AdaptiveActionV1): boolean {
  return a.type === 'REPLACE' && b.type === 'REPLACE' && a.sellItemId === b.sellItemId && a.buyItemId === b.buyItemId;
}

function sameAction(a: AdaptiveActionV1, b: AdaptiveActionV1): boolean {
  return a.type === b.type && a.itemId === b.itemId && a.sellItemId === b.sellItemId && a.buyItemId === b.buyItemId && a.targetItemId === b.targetItemId;
}

function actionTarget(action: AdaptiveActionV1): number | undefined {
  return action.buyItemId ?? action.itemId ?? action.targetItemId;
}

function heldIds(heldByItemId: ReadonlyMap<number, unknown>): number[] {
  return [...heldByItemId.keys()].sort((a, b) => a - b);
}

function cloneAction(action: AdaptiveActionV1): AdaptiveActionV1 {
  return { ...action, reasonCodes: [...action.reasonCodes] };
}

function round(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 1_000_000) / 1_000_000;
}
