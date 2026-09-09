import { Injectable } from '@nestjs/common';
import {
  RecommendationCandidate,
  RecommendationItemGraph,
} from '@deadlock-live-probe/build-domain';
import { AdaptiveItemScoreV1 } from './adaptive-evidence-scorer-v1.service';
import { BuildSituationalCandidateEvidenceV1 } from './build-situational-resolver-v1.service';
import {
  BuildStrategySpecV1,
  BuildSituationalWindowV1,
  buildGoalRigidityV1,
} from './build-strategy-v1';
import { ADAPTIVE_POLICY_V1_CONFIG } from './statlocker-adaptive.config';
import { ThreatWeightedMatchupScoreV1 } from './threat-weighted-matchup-v1.service';

export interface MatchupCandidateDiscoveryV1Input {
  strategy: BuildStrategySpecV1;
  openWindows: readonly BuildSituationalWindowV1[];
  legalByTarget: ReadonlyMap<number, RecommendationCandidate>;
  itemGraph: RecommendationItemGraph;
  maxTotalItems?: number;
  currentItemCount: number;
  enemyHeroIds: readonly number[];
  enemyItemIds: readonly number[];
  matchupByItemId: Readonly<Record<string, ThreatWeightedMatchupScoreV1>>;
  scoreItem: (itemId: number) => AdaptiveItemScoreV1 | undefined;
}

@Injectable()
export class MatchupCandidateDiscoveryV1Service {
  discover(input: MatchupCandidateDiscoveryV1Input): readonly BuildSituationalCandidateEvidenceV1[] {
    if (!input.openWindows.some((window) => window.allowedPurposes.includes('COUNTER_ENEMY_HEROES'))) return [];
    if (input.maxTotalItems === undefined || !Number.isFinite(input.maxTotalItems) || input.maxTotalItems <= 0) return [];

    const strategyOwnedItemIds = strategyOwnedItems(input.strategy, input.itemGraph);
    const protectedHardCoreItemIds = hardCoreProtectedItems(input.strategy, input.itemGraph);
    const evidence: BuildSituationalCandidateEvidenceV1[] = [];

    for (const itemId of [...input.legalByTarget.keys()].sort((a, b) => a - b)) {
      if (strategyOwnedItemIds.has(itemId)) continue;
      const candidate = input.legalByTarget.get(itemId);
      if (!candidate || candidate.evidence.transaction === 'UNKNOWN') continue;
      if (candidate.resultingItemIds.length > input.maxTotalItems) continue;
      if (consumesProtectedHardCore(candidate, protectedHardCoreItemIds)) continue;

      const matchup = input.matchupByItemId[String(itemId)];
      if (!matchup || matchup.coverage < ADAPTIVE_POLICY_V1_CONFIG.situational.matchupDiscoveryMinCoverage) continue;

      const score = input.scoreItem(itemId);
      if (!score || score.confidence < ADAPTIVE_POLICY_V1_CONFIG.situational.minTargetConfidence) continue;
      const statisticalSupport = draftMatchupSupport(score);
      if (statisticalSupport <= 0 || matchup.confidence <= 0) continue;

      evidence.push({
        targetItemId: itemId,
        purpose: 'COUNTER_ENEMY_HEROES',
        contextualScore: score.score,
        statisticalSupport,
        confidence: Math.min(score.confidence, matchup.confidence),
        effectiveCostSouls: Math.max(0, candidate.effectiveCostSouls),
        slotImpact: Math.max(0, candidate.resultingItemIds.length - input.currentItemCount),
        investmentImpact: 0,
        coreInterruptionSouls: Math.max(0, candidate.effectiveCostSouls),
        enemyHeroIds: [...input.enemyHeroIds],
        enemyItemIds: [...input.enemyItemIds],
        reasonCodes: [
          'MATCHUP_DISCOVERY_OUTSIDE_SKELETON',
          'SITUATIONAL_PURPOSE:COUNTER_ENEMY_HEROES',
        ],
      });
    }

    return evidence;
  }
}

function strategyOwnedItems(strategy: BuildStrategySpecV1, itemGraph: RecommendationItemGraph): Set<number> {
  const itemIds = new Set<number>();
  for (const goal of strategy.goals) {
    for (const itemId of goal.targetItemIds) {
      itemIds.add(itemId);
      for (const componentId of itemGraph.getTransitiveComponentIds(itemId)) itemIds.add(componentId);
    }
  }
  for (const window of strategy.situationalWindows) {
    for (const purpose of window.allowedPurposes) {
      for (const itemId of window.candidateItemIdsByPurpose?.[purpose] ?? []) itemIds.add(itemId);
    }
  }
  return itemIds;
}

function hardCoreProtectedItems(strategy: BuildStrategySpecV1, itemGraph: RecommendationItemGraph): Set<number> {
  const itemIds = new Set<number>();
  for (const goal of strategy.goals) {
    if (buildGoalRigidityV1(goal) !== 'HARD_CORE') continue;
    for (const itemId of goal.targetItemIds) {
      itemIds.add(itemId);
      for (const componentId of itemGraph.getTransitiveComponentIds(itemId)) itemIds.add(componentId);
    }
  }
  return itemIds;
}

function consumesProtectedHardCore(
  candidate: RecommendationCandidate,
  protectedItemIds: ReadonlySet<number>,
): boolean {
  const action = candidate.action;
  if (action.type === 'REPLACE_ITEM') return protectedItemIds.has(action.sellItemId);
  if (action.type === 'UPGRADE_ITEM') return action.consumedItemIds.some((itemId) => protectedItemIds.has(itemId));
  return false;
}

function draftMatchupSupport(score: AdaptiveItemScoreV1): number {
  const component = score.components.find((entry) => entry.key === 'draftMatchupFit');
  return Math.max(0, component?.normalized ?? component?.raw ?? 0);
}
