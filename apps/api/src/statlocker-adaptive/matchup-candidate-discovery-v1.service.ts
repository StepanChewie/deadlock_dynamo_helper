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
} from './build-strategy-v1';

export interface MatchupCandidateDiscoveryV1Input {
  strategy: BuildStrategySpecV1;
  openWindows: readonly BuildSituationalWindowV1[];
  legalByTarget: ReadonlyMap<number, RecommendationCandidate>;
  itemGraph: RecommendationItemGraph;
  maxTotalItems?: number;
  currentItemCount: number;
  enemyHeroIds: readonly number[];
  enemyItemIds: readonly number[];
  scoreItem: (itemId: number) => AdaptiveItemScoreV1 | undefined;
}

@Injectable()
export class MatchupCandidateDiscoveryV1Service {
  discover(input: MatchupCandidateDiscoveryV1Input): readonly BuildSituationalCandidateEvidenceV1[] {
    if (!input.openWindows.some((window) => window.allowedPurposes.includes('COUNTER_ENEMY_HEROES'))) return [];
    if (input.maxTotalItems === undefined || !Number.isFinite(input.maxTotalItems) || input.maxTotalItems <= 0) return [];

    const strategyOwnedItemIds = strategyOwnedItems(input.strategy, input.itemGraph);
    const evidence: BuildSituationalCandidateEvidenceV1[] = [];

    for (const itemId of [...input.legalByTarget.keys()].sort((a, b) => a - b)) {
      if (strategyOwnedItemIds.has(itemId)) continue;
      const candidate = input.legalByTarget.get(itemId);
      if (!candidate || candidate.evidence.transaction === 'UNKNOWN') continue;
      if (candidate.resultingItemIds.length > input.maxTotalItems) continue;

      const score = input.scoreItem(itemId);
      if (!score) continue;
      const statisticalSupport = draftMatchupSupport(score);
      if (statisticalSupport <= 0 || score.confidence <= 0) continue;

      evidence.push({
        targetItemId: itemId,
        purpose: 'COUNTER_ENEMY_HEROES',
        contextualScore: score.score,
        statisticalSupport,
        confidence: score.confidence,
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

function draftMatchupSupport(score: AdaptiveItemScoreV1): number {
  const component = score.components.find((entry) => entry.key === 'draftMatchupFit');
  return Math.max(0, component?.normalized ?? component?.raw ?? 0);
}
