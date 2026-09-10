import { RecommendationItemGraph } from '@deadlock-live-probe/build-domain';
import { StatlockerBuildProfileItemV2, StatlockerBuildProfileV2 } from './build-archetype-v2';
import { StatlockerProBuildAnalysisV1 } from './statlocker-adaptive.types';

export function toStatlockerBuildProfileV2(
  analysis: StatlockerProBuildAnalysisV1,
  graph: RecommendationItemGraph,
  leaderboardRank?: number,
): StatlockerBuildProfileV2 {
  const items = analysis.items
    .map((item): StatlockerBuildProfileItemV2 => ({
      itemId: item.itemId,
      familyId: statlockerBuildFamilyIdV2(item.itemId, graph),
      purchaseRate: item.purchaseRate,
      medianBuyTimeS: item.medianBuyTimeS,
      frequencyTier: item.frequencyTier,
      phase: item.phase,
      relationships: [...item.relationships]
        .map((relationship) => ({ ...relationship }))
        .sort((a, b) => a.itemId - b.itemId || a.strength - b.strength),
      ...(item.explicitGroup ? { explicitGroup: { ...item.explicitGroup } } : {}),
    }))
    .sort((a, b) => a.itemId - b.itemId);

  return {
    accountId: analysis.accountId,
    heroId: analysis.heroId,
    ...(leaderboardRank === undefined ? {} : { leaderboardRank }),
    items,
  };
}

export function statlockerBuildFamilyIdV2(itemId: number, graph: RecommendationItemGraph): number {
  const related = new Set<number>([
    itemId,
    ...graph.getTransitiveComponentIds(itemId),
    ...graph.getTransitiveUpgradeIds(itemId),
  ]);

  let changed = true;
  while (changed) {
    changed = false;
    for (const current of [...related]) {
      for (const next of [...graph.getTransitiveComponentIds(current), ...graph.getTransitiveUpgradeIds(current)]) {
        if (related.has(next)) continue;
        related.add(next);
        changed = true;
      }
    }
  }

  return Math.min(...related);
}
