import { RecommendationItemGraph } from '@dynamo-lab/build-domain';
import { StatlockerBuildProfileItemV2, StatlockerBuildProfileV2 } from './build-archetype-v2';
import { StatlockerProBuildAnalysisV1, StatlockerProBuildItemV1 } from './statlocker-adaptive.types';

export function toStatlockerBuildProfileV2(
  analysis: StatlockerProBuildAnalysisV1,
  graph: RecommendationItemGraph,
  leaderboardRank?: number,
  playerName?: string,
): StatlockerBuildProfileV2 {
  if (analysis.items.length === 0) {
    throw new Error('Statlocker build profile v2: items must not be empty');
  }

  const byItemId = new Map<number, StatlockerBuildProfileItemV2>();
  for (const source of analysis.items) {
    const normalized = normalizeProfileItem(source, graph);
    const existing = byItemId.get(normalized.itemId);
    if (!existing) {
      byItemId.set(normalized.itemId, normalized);
      continue;
    }
    if (!sameProfileItem(existing, normalized)) {
      throw new Error(`Statlocker build profile v2: conflicting duplicate item ${normalized.itemId}`);
    }
  }

  const items = [...byItemId.values()].sort((a, b) => a.itemId - b.itemId);
  const normalizedPlayerName = typeof playerName === 'string' ? playerName.trim() : '';
  return {
    accountId: analysis.accountId,
    heroId: analysis.heroId,
    ...(leaderboardRank === undefined ? {} : { leaderboardRank }),
    ...(normalizedPlayerName ? { playerName: normalizedPlayerName } : {}),
    items,
  };
}

export function statlockerBuildFamilyIdV2(itemId: number, graph: RecommendationItemGraph): number {
  if (!graph.getItem(itemId)) {
    throw new Error(`Statlocker build profile v2: unknown item ${itemId}`);
  }

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

function normalizeProfileItem(
  item: StatlockerProBuildItemV1,
  graph: RecommendationItemGraph,
): StatlockerBuildProfileItemV2 {
  const relationships = [...item.relationships]
    .map((relationship) => ({ ...relationship }))
    .sort((a, b) => a.itemId - b.itemId || a.strength - b.strength);

  return {
    itemId: item.itemId,
    familyId: statlockerBuildFamilyIdV2(item.itemId, graph),
    purchaseRate: item.purchaseRate,
    medianBuyTimeS: item.medianBuyTimeS,
    frequencyTier: item.frequencyTier,
    phase: item.phase,
    relationships,
    ...(item.explicitGroup ? { explicitGroup: { ...item.explicitGroup } } : {}),
  };
}

function sameProfileItem(
  left: StatlockerBuildProfileItemV2,
  right: StatlockerBuildProfileItemV2,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}