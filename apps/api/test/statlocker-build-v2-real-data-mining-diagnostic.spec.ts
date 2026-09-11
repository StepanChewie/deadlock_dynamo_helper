import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildRecommendationRulesetCatalogV1,
  compileStrictRecommendationCatalogV1,
} from '@deadlock-live-probe/build-domain';
import type { StatlockerBuildV2Fixture } from '../src/scripts/capture-statlocker-build-v2-fixture';
import { resolveRecommendationCatalogAssetSemantics } from '../src/deadlock-live/recommendation-catalog-asset-semantics';
import { BuildArchetypeMinerV2Service } from '../src/statlocker-adaptive/build-archetype-miner-v2.service';
import { compareBuildProfilesV2 } from '../src/statlocker-adaptive/build-archetype-similarity-v2';
import { STATLOCKER_BUILD_V2_CONFIG } from '../src/statlocker-adaptive/statlocker-build-v2.config';
import { toStatlockerBuildProfileV2 } from '../src/statlocker-adaptive/statlocker-build-profile-v2';

function fixture(): StatlockerBuildV2Fixture {
  return JSON.parse(readFileSync(
    join(__dirname, 'fixtures/statlocker-build-v2/billy-real.fixture.json'),
    'utf8',
  )) as StatlockerBuildV2Fixture;
}

function graphFor(value: StatlockerBuildV2Fixture) {
  const version = value.catalog.version;
  const provenanceTimes = value.metadata.snapshotProvenance.map((entry) => entry.fetchedAt).sort();
  const importedAt = version.importedAt ?? provenanceTimes[provenanceTimes.length - 1] ?? '2026-09-10T00:00:00.000Z';
  const source = buildRecommendationRulesetCatalogV1({
    version: {
      catalogVersionId: version.catalogVersionId,
      contentCatalogVersionId: version.contentCatalogVersionId,
      clientVersion: version.clientVersion,
      rulesetKey: version.rulesetKey,
      source: version.source,
      payloadSha256: version.payloadSha256,
      importedAt,
    },
    items: value.catalog.items.map((row) => {
      const semantics = resolveRecommendationCatalogAssetSemantics(row);
      return {
        itemId: Number(row.itemId),
        name: row.name,
        className: row.className,
        itemType: semantics.itemType,
        slotType: row.slotType,
        cost: row.cost,
        tier: row.tier,
        shopable: semantics.shopable,
        disabled: semantics.disabled,
        active: semantics.active,
        isActiveItem: semantics.isActiveItem,
        activationType: semantics.activationType,
        rawPayload: row.rawPayload,
      };
    }),
    recipeEdges: value.catalog.recipes.map((row) => ({
      parentItemId: Number(row.parentItemId),
      componentItemId: Number(row.componentItemId),
      componentOrder: row.componentOrder,
    })),
  });
  return compileStrictRecommendationCatalogV1(source).graph;
}

describe('Billy real-data archetype mining diagnostic', () => {
  it('reports the real similarity structure before changing mining policy', () => {
    const value = fixture();
    const graph = graphFor(value);
    const ranks = new Map(value.leaderboard.profiles.map((entry) => [entry.accountId, entry.rank]));
    const profiles = value.proBuildAnalyses.map((analysis) =>
      toStatlockerBuildProfileV2(analysis, graph, ranks.get(analysis.accountId)),
    ).sort((left, right) => (left.leaderboardRank ?? 999) - (right.leaderboardRank ?? 999));

    const pairs = [] as Array<{
      left: string;
      right: string;
      leftRank?: number;
      rightRank?: number;
      total: number;
      composition: number;
      tier: number;
      phase: number;
      timing: number;
      groups: number;
      relationships: number;
    }>;
    for (let i = 0; i < profiles.length; i += 1) {
      for (let j = i + 1; j < profiles.length; j += 1) {
        const score = compareBuildProfilesV2(profiles[i], profiles[j]);
        pairs.push({
          left: profiles[i].accountId,
          right: profiles[j].accountId,
          leftRank: profiles[i].leaderboardRank,
          rightRank: profiles[j].leaderboardRank,
          total: score.total,
          composition: score.composition,
          tier: score.tierAgreement,
          phase: score.phaseAgreement,
          timing: score.timingAgreement,
          groups: score.groupAgreement,
          relationships: score.relationshipAgreement,
        });
      }
    }
    const totals = pairs.map((entry) => entry.total).sort((a, b) => a - b);
    const compositions = pairs.map((entry) => entry.composition).sort((a, b) => a - b);
    const mean = (values: readonly number[]) => values.reduce((sum, current) => sum + current, 0) / Math.max(1, values.length);
    const median = (values: readonly number[]) => values.length % 2 === 0
      ? (values[values.length / 2 - 1] + values[values.length / 2]) / 2
      : values[Math.floor(values.length / 2)];
    const mining = new BuildArchetypeMinerV2Service().mine(profiles);
    const profileSummary = profiles.map((profile) => ({
      accountId: profile.accountId,
      rank: profile.leaderboardRank,
      itemCount: profile.items.length,
      familyCount: new Set(profile.items.map((entry) => entry.familyId)).size,
      core: profile.items.filter((entry) => entry.frequencyTier === 'CORE').length,
      frequent: profile.items.filter((entry) => entry.frequencyTier === 'FREQUENT').length,
      sometimes: profile.items.filter((entry) => entry.frequencyTier === 'SOMETIMES').length,
      flex: profile.items.filter((entry) => entry.frequencyTier === 'FLEX').length,
    }));
    const diagnostic = {
      thresholds: {
        link: STATLOCKER_BUILD_V2_CONFIG.profileLinkSimilarity,
        internal: STATLOCKER_BUILD_V2_CONFIG.minInternalSimilarity,
        consensus: STATLOCKER_BUILD_V2_CONFIG.minConsensusSimilarity,
        minClusterSize: STATLOCKER_BUILD_V2_CONFIG.minClusterSize,
      },
      profiles: profileSummary,
      pairwise: {
        count: totals.length,
        totalMin: totals[0],
        totalMedian: median(totals),
        totalMean: mean(totals),
        totalMax: totals[totals.length - 1],
        compositionMin: compositions[0],
        compositionMedian: median(compositions),
        compositionMean: mean(compositions),
        compositionMax: compositions[compositions.length - 1],
        aboveLink: totals.filter((score) => score >= STATLOCKER_BUILD_V2_CONFIG.profileLinkSimilarity).length,
        highestPairs: [...pairs].sort((a, b) => b.total - a.total).slice(0, 12),
        lowestPairs: [...pairs].sort((a, b) => a.total - b.total).slice(0, 8),
      },
      accepted: mining.accepted,
      rejected: mining.rejected,
    };

    throw new Error(`BUILD_V2_MINING_DIAGNOSTIC ${JSON.stringify(diagnostic)}`);
  });
});
