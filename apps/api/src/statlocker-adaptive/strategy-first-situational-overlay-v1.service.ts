import { Injectable } from '@nestjs/common';
import {
  RecommendationCandidate,
  generateRecommendationCandidates,
} from '@deadlock-live-probe/build-domain';
import {
  AdaptiveActionV1,
  AdaptivePlannedItemV1,
  AdaptiveScoredActionV1,
} from '@deadlock-live-probe/shared';
import { AdaptiveDecisionStateV1 } from './adaptive-decision-state-v1.service';
import { candidateGeneratorRulesFromSlotStateV1 } from './adaptive-economy-v1';
import { ADAPTIVE_POLICY_V1_CONFIG } from './statlocker-adaptive.config';
import {
  AdaptiveEvidenceScorerV1Service,
  AdaptiveItemScoreV1,
} from './adaptive-evidence-scorer-v1.service';
import {
  BuildSituationalCandidateEvidenceV1,
  BuildSituationalResolverV1Service,
} from './build-situational-resolver-v1.service';
import {
  BuildSituationalPurposeV1,
  BuildSituationalWindowV1,
} from './build-strategy-v1';
import { MatchupCandidateDiscoveryV1Service } from './matchup-candidate-discovery-v1.service';
import { StatlockerEvidenceBundleV1 } from './statlocker-evidence.service';
import { StrategyFirstBuildPlannerV1Result } from './strategy-first-build-planner-v1.service';

export interface StrategyFirstSituationalOverlayV1Input {
  result: StrategyFirstBuildPlannerV1Result;
  decision: AdaptiveDecisionStateV1;
  evidence: StatlockerEvidenceBundleV1;
}

@Injectable()
export class StrategyFirstSituationalOverlayV1Service {
  private readonly resolver = new BuildSituationalResolverV1Service();
  private readonly discovery = new MatchupCandidateDiscoveryV1Service();

  constructor(private readonly scorer: AdaptiveEvidenceScorerV1Service) {}

  apply(input: StrategyFirstSituationalOverlayV1Input): StrategyFirstBuildPlannerV1Result {
    const openWindows = input.result.strategy.situationalWindows
      .filter((window) => input.result.contract.reservedSituationalWindowIds.includes(window.windowId))
      .filter((window) => isActionableSituationalWindow(window));
    if (openWindows.length === 0) return input.result;

    const rules = candidateGeneratorRulesFromSlotStateV1(input.decision.slots, {
      allowSellOnlyActions: true,
      generateTargetedWaitActions: false,
    });
    const legalCandidatesByTarget = new Map<number, RecommendationCandidate[]>();
    for (const candidate of generateRecommendationCandidates({
      state: input.decision.state,
      itemGraph: input.decision.itemGraph,
      rules,
    }).filter((candidate) => candidate.feasible && candidate.recommendationEligible)) {
      const target = candidateTarget(candidate);
      if (target === undefined || candidate.action.type === 'WAIT_SAVE' || candidate.action.type === 'SELL_ITEM') continue;
      const list = legalCandidatesByTarget.get(target) ?? [];
      list.push(candidate);
      legalCandidatesByTarget.set(target, list);
    }
    const legalByTarget = new Map<number, RecommendationCandidate>();
    for (const [targetItemId, candidates] of legalCandidatesByTarget) {
      const candidate = bestTransaction(candidates);
      if (candidate) legalByTarget.set(targetItemId, candidate);
    }

    const evidence: BuildSituationalCandidateEvidenceV1[] = [];
    for (const window of openWindows) {
      for (const purpose of window.allowedPurposes) {
        for (const itemId of explicitCandidates(window, purpose)) {
          if (input.decision.itemGraph.isTargetSatisfied(itemId, input.decision.state.inventory.heldByItemId.keys())) continue;
          const candidate = legalByTarget.get(itemId);
          if (!candidate) continue;
          const score = safeScore(this.scorer, itemId, input);
          if (!score) continue;
          evidence.push({
            targetItemId: itemId,
            purpose,
            contextualScore: score.score,
            statisticalSupport: draftMatchupSupport(score),
            confidence: score.confidence,
            effectiveCostSouls: Math.max(0, candidate.effectiveCostSouls),
            slotImpact: Math.max(0, candidate.resultingItemIds.length - input.decision.state.inventory.heldByItemId.size),
            investmentImpact: 0,
            coreInterruptionSouls: Math.max(0, candidate.effectiveCostSouls),
            enemyHeroIds: [...input.decision.enemyHeroIds],
            enemyItemIds: [...(input.decision.enemyItemIds ?? [])],
            reasonCodes: [`SITUATIONAL_PURPOSE:${purpose}`],
          });
        }
      }
    }
    evidence.push(...this.discovery.discover({
      strategy: input.result.strategy,
      openWindows,
      legalByTarget,
      itemGraph: input.decision.itemGraph,
      maxTotalItems: input.decision.slots.totalCapacity,
      currentItemCount: input.decision.state.inventory.heldByItemId.size,
      enemyHeroIds: input.decision.enemyHeroIds,
      enemyItemIds: input.decision.enemyItemIds ?? [],
      scoreItem: (itemId) => safeScore(this.scorer, itemId, input),
    }));

    const coreScore = coreContinuationScore(input.result, this.scorer, input);
    const selected = this.resolver.resolve({
      strategy: input.result.strategy,
      contract: input.result.contract,
      continueCoreScore: coreScore,
      candidates: evidence,
      minOverrideImprovement: ADAPTIVE_POLICY_V1_CONFIG.situational.minImprovementOverCore,
    });
    if (!selected) return input.result;

    const selectedCandidate = legalByTarget.get(selected.targetItemId);
    if (!selectedCandidate) return input.result;

    const score = safeScore(this.scorer, selected.targetItemId, input);
    const nextAction = adaptiveAction(selectedCandidate, selected.reasonCodes);
    const contract = {
      ...input.result.contract,
      activeSituationalDecision: selected,
    };
    const strategyPlan = {
      ...input.result.strategyPlan,
      situationalDecision: selected,
    };
    const recommendedBuild = insertSituationalNext(
      input.result.recommendedBuild,
      selected.targetItemId,
      score,
      input.decision.state.inventory.heldByItemId.keys(),
    );
    const scoredAction: AdaptiveScoredActionV1 = {
      action: nextAction,
      score: score?.score ?? coreScore,
      confidence: selected.confidence,
      components: score?.components ?? [],
      reasonCodes: [...selected.reasonCodes],
    };

    return {
      ...input.result,
      contract,
      strategyPlan,
      nextAction,
      recommendedBuild,
      rankedImmediateCandidates: [
        scoredAction,
        ...input.result.rankedImmediateCandidates.filter((entry) => entry.action.actionKey !== nextAction.actionKey),
      ],
      totalScore: Math.max(input.result.totalScore, score?.score ?? coreScore),
      confidence: selected.confidence,
    };
  }
}

function isActionableSituationalWindow(window: BuildSituationalWindowV1): boolean {
  return hasExplicitSituationalCandidates(window) || window.allowedPurposes.includes('COUNTER_ENEMY_HEROES');
}

function hasExplicitSituationalCandidates(window: BuildSituationalWindowV1): boolean {
  return window.allowedPurposes.some((purpose) => explicitCandidates(window, purpose).length > 0);
}

function explicitCandidates(window: BuildSituationalWindowV1, purpose: BuildSituationalPurposeV1): readonly number[] {
  return [...new Set(window.candidateItemIdsByPurpose?.[purpose] ?? [])]
    .filter((itemId) => Number.isInteger(itemId) && itemId > 0)
    .sort((a, b) => a - b);
}

function safeScore(
  scorer: AdaptiveEvidenceScorerV1Service,
  itemId: number,
  input: StrategyFirstSituationalOverlayV1Input,
): AdaptiveItemScoreV1 | undefined {
  try {
    return scorer.scoreItem(itemId, {
      heroId: input.decision.state.heroId,
      enemyHeroIds: input.decision.enemyHeroIds,
      gameTimeSec: input.decision.state.gameTimeSec,
      gameStateBlend: { ahead: 0, even: 0, behind: 0 },
      ownedItemIds: [...input.decision.state.inventory.heldByItemId.keys()].sort((a, b) => a - b),
      plannedPrefixItemIds: [],
      evidence: input.evidence,
      ownBuildArchetype: input.result.strategy.strategyId,
      enemyCompositionKey: [...input.decision.enemyHeroIds].sort((a, b) => a - b).join(','),
      transactionPenalty: 0,
      churnPenalty: 0,
    });
  } catch {
    return undefined;
  }
}

function draftMatchupSupport(score: AdaptiveItemScoreV1): number {
  const component = score.components.find((entry) => entry.key === 'draftMatchupFit');
  return Math.max(0, component?.normalized ?? component?.raw ?? 0);
}

function coreContinuationScore(
  result: StrategyFirstBuildPlannerV1Result,
  scorer: AdaptiveEvidenceScorerV1Service,
  input: StrategyFirstSituationalOverlayV1Input,
): number {
  const targetItemId = result.nextAction.targetItemId;
  if (targetItemId !== undefined) {
    const score = safeScore(scorer, targetItemId, input);
    if (score?.score !== undefined) return score.score;
  }
  const selected = result.rankedImmediateCandidates.find((entry) => entry.action.actionKey === result.nextAction.actionKey);
  if (selected) return selected.score;
  return result.rankedImmediateCandidates[0]?.score ?? Math.max(0, result.totalScore);
}

function candidateTarget(candidate: RecommendationCandidate): number | undefined {
  if (candidate.action.type === 'BUY_ITEM' || candidate.action.type === 'UPGRADE_ITEM') return candidate.action.itemId;
  if (candidate.action.type === 'REPLACE_ITEM') return candidate.action.buyItemId;
  return undefined;
}

function bestTransaction(candidates: readonly RecommendationCandidate[]): RecommendationCandidate | undefined {
  return [...candidates].sort((a, b) =>
    transactionRank(a) - transactionRank(b) ||
    a.effectiveCostSouls - b.effectiveCostSouls ||
    a.actionId.localeCompare(b.actionId),
  )[0];
}

function transactionRank(candidate: RecommendationCandidate): number {
  if (candidate.action.type === 'UPGRADE_ITEM') return 0;
  if (candidate.action.type === 'BUY_ITEM') return 1;
  if (candidate.action.type === 'REPLACE_ITEM') return 2;
  return 3;
}

function adaptiveAction(candidate: RecommendationCandidate, reasonCodes: readonly string[]): AdaptiveActionV1 {
  const action = candidate.action;
  if (action.type === 'BUY_ITEM') {
    return { actionKey: candidate.actionId, type: 'BUY', itemId: action.itemId, buyItemId: action.itemId, targetItemId: action.itemId, reasonCodes };
  }
  if (action.type === 'UPGRADE_ITEM') {
    return { actionKey: candidate.actionId, type: 'UPGRADE', itemId: action.itemId, targetItemId: action.itemId, reasonCodes };
  }
  if (action.type === 'REPLACE_ITEM') {
    return { actionKey: candidate.actionId, type: 'REPLACE', sellItemId: action.sellItemId, buyItemId: action.buyItemId, targetItemId: action.buyItemId, reasonCodes };
  }
  return { actionKey: candidate.actionId, type: 'WAIT', reasonCodes };
}

function insertSituationalNext(
  build: readonly AdaptivePlannedItemV1[],
  itemId: number,
  score: AdaptiveItemScoreV1 | undefined,
  ownedItemIds: Iterable<number>,
): readonly AdaptivePlannedItemV1[] {
  const owned = new Set(ownedItemIds);
  const withoutTarget = [...build]
    .sort((a, b) => a.position - b.position || a.itemId - b.itemId)
    .filter((entry) => entry.itemId !== itemId);
  const ownedPrefix = withoutTarget.filter((entry) => owned.has(entry.itemId));
  const future = withoutTarget.filter((entry) => !owned.has(entry.itemId));
  const situational: AdaptivePlannedItemV1 = {
    itemId,
    position: ownedPrefix.length + 1,
    status: 'NEXT',
    score: score?.score ?? 0,
    confidence: score?.confidence ?? 0,
    skeletonStrength: 0,
    contextualSupport: score?.score ?? 0,
    reasonCodes: ['SITUATIONAL_WINDOW_ACTIVE'],
  };
  return [...ownedPrefix, situational, ...future]
    .map((entry, index): AdaptivePlannedItemV1 => ({
      ...entry,
      position: index + 1,
      status: owned.has(entry.itemId) ? 'OWNED' : entry.itemId === itemId ? 'NEXT' : 'PLANNED',
    }));
}
