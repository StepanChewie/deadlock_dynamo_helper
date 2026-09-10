import { RecommendationItemGraph } from '@deadlock-live-probe/build-domain';
import { StatlockerBuildProfileItemV2, StatlockerBuildProfileV2 } from './build-archetype-v2';
import { StatlockerProBuildAnalysisV1 } from './statlocker-adaptive.types';

export function toStatlockerBuildProfileV2(
  analysis: StatlockerProBuildAnalysisV1,
  graph: RecommendationItemGraph,
  leaderboardRank?: number,
): StatlockerBuildProfileV2 {
  void graph;
  void leaderboardRank;

  const items = analysis.items.map((item): StatlockerBuildProfileItemV2 => ({
    itemId: item.itemId,
    familyId: item.itemId,
    purchaseRate: item.purchaseRate,
    medianBuyTimeS: item.medianBuyTimeS,
    frequencyTier: item.frequencyTier,
    phase: item.phase,
    relationships: item.relationships,
  }));

  return {
    accountId: analysis.accountId,
    heroId: analysis.heroId,
    items,
  };
}
