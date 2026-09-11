import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildRecommendationRulesetCatalogV1, compileStrictRecommendationCatalogV1 } from '@deadlock-live-probe/build-domain';
import type { StatlockerBuildV2Fixture } from '../src/scripts/capture-statlocker-build-v2-fixture';
import { resolveRecommendationCatalogAssetSemantics } from '../src/deadlock-live/recommendation-catalog-asset-semantics';
import { BuildArchetypeMinerV2Service } from '../src/statlocker-adaptive/build-archetype-miner-v2.service';
import { toStatlockerBuildProfileV2 } from '../src/statlocker-adaptive/statlocker-build-profile-v2';

function loadProfiles() {
  const fixture = JSON.parse(readFileSync(
    join(__dirname, 'fixtures/statlocker-build-v2/billy-real.fixture.json'),
    'utf8',
  )) as StatlockerBuildV2Fixture;
  const version = fixture.catalog.version;
  const source = buildRecommendationRulesetCatalogV1({
    version: {
      catalogVersionId: version.catalogVersionId,
      contentCatalogVersionId: version.contentCatalogVersionId,
      clientVersion: version.clientVersion,
      rulesetKey: version.rulesetKey,
      source: version.source,
      payloadSha256: version.payloadSha256,
      importedAt: version.importedAt ?? fixture.metadata.snapshotProvenance[0]?.fetchedAt ?? '2026-09-10T00:00:00.000Z',
    },
    items: fixture.catalog.items.map((row) => {
      const semantics = resolveRecommendationCatalogAssetSemantics(row);
      return {
        itemId: Number(row.itemId), name: row.name, className: row.className,
        itemType: semantics.itemType, slotType: row.slotType, cost: row.cost, tier: row.tier,
        shopable: semantics.shopable, disabled: semantics.disabled, active: semantics.active,
        isActiveItem: semantics.isActiveItem, activationType: semantics.activationType, rawPayload: row.rawPayload,
      };
    }),
    recipeEdges: fixture.catalog.recipes.map((row) => ({
      parentItemId: Number(row.parentItemId), componentItemId: Number(row.componentItemId), componentOrder: row.componentOrder,
    })),
  });
  const graph = compileStrictRecommendationCatalogV1(source).graph;
  const rankByAccount = new Map(fixture.leaderboard.profiles.map((entry) => [entry.accountId, entry.rank]));
  return fixture.proBuildAnalyses.map((analysis) =>
    toStatlockerBuildProfileV2(analysis, graph, rankByAccount.get(analysis.accountId)),
  );
}

describe('Billy real-data clustering topology', () => {
  it('reports components at candidate link thresholds without changing production policy', () => {
    const profiles = loadProfiles();
    const miner = new BuildArchetypeMinerV2Service();
    const links = [0.68, 0.65, 0.62, 0.60, 0.58, 0.55, 0.52, 0.50, 0.48];
    const sweeps = links.map((link) => {
      const result = miner.mine(profiles, {
        profileLinkSimilarity: link,
        minClusterSize: 2,
        minInternalSimilarity: 0,
        minConsensusSimilarity: 1,
        minClusterSeparation: 0,
        maxPublishedArchetypes: 10,
      });
      return {
        link,
        accepted: result.accepted.map((cluster) => ({
          ranks: cluster.profileAccountIds
            .map((accountId) => profiles.find((profile) => profile.accountId === accountId)?.leaderboardRank)
            .sort((a, b) => Number(a) - Number(b)),
          profiles: cluster.profileAccountIds,
          support: cluster.support,
          internal: cluster.internalSimilarity,
          separation: cluster.separation,
        })),
        small: result.rejected
          .filter((cluster) => cluster.reasonCodes.includes('CLUSTER_TOO_SMALL'))
          .map((cluster) => cluster.profileAccountIds.map((accountId) =>
            profiles.find((profile) => profile.accountId === accountId)?.leaderboardRank)),
      };
    });
    throw new Error(`BUILD_V2_CLUSTER_SWEEP ${JSON.stringify(sweeps)}`);
  });
});
