import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildRecommendationRulesetCatalogV1, compileStrictRecommendationCatalogV1 } from '@deadlock-live-probe/build-domain';
import type { StatlockerBuildV2Fixture } from '../src/scripts/capture-statlocker-build-v2-fixture';
import { resolveRecommendationCatalogAssetSemantics } from '../src/deadlock-live/recommendation-catalog-asset-semantics';
import { BuildArchetypeCompilerV2Service } from '../src/statlocker-adaptive/build-archetype-compiler-v2.service';
import { BuildArchetypeMinerV2Service } from '../src/statlocker-adaptive/build-archetype-miner-v2.service';
import { BuildArchetypeQualityGateV2Service } from '../src/statlocker-adaptive/build-archetype-quality-gate-v2.service';
import { toStatlockerBuildProfileV2 } from '../src/statlocker-adaptive/statlocker-build-profile-v2';

function load() {
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
  const compiled = compileStrictRecommendationCatalogV1(source);
  const ranks = new Map(fixture.leaderboard.profiles.map((entry) => [entry.accountId, entry.rank]));
  const profiles = fixture.proBuildAnalyses.map((analysis) =>
    toStatlockerBuildProfileV2(analysis, compiled.graph, ranks.get(analysis.accountId)),
  );
  return { fixture, compiled, profiles };
}

describe('Billy real-data quality diagnostic', () => {
  it('reports exact semantic gate failures before changing compiler or gate policy', () => {
    const { fixture, compiled, profiles } = load();
    const mining = new BuildArchetypeMinerV2Service().mine(profiles);
    const compiler = new BuildArchetypeCompilerV2Service();
    const archetypes = mining.accepted.map((cluster) => compiler.compile({
      cluster,
      profiles,
      rulesetVersion: fixture.metadata.identity.rulesetVersion,
      statlockerPatchId: fixture.metadata.identity.statlockerPatchId,
      catalogSha256: fixture.metadata.identity.catalogSha256,
    }));
    const snapshot = {
      snapshotId: `quality-diag:${fixture.metadata.identity.catalogSha256.slice(0, 24)}`,
      heroId: fixture.request.heroId,
      rulesetVersion: fixture.metadata.identity.rulesetVersion,
      statlockerPatchId: fixture.metadata.identity.statlockerPatchId,
      catalogSha256: fixture.metadata.identity.catalogSha256,
      generatedAt: fixture.metadata.snapshotProvenance[0]?.fetchedAt ?? '2026-09-10T00:00:00.000Z',
      sourceProfileAccountIds: profiles.map((entry) => entry.accountId),
      archetypes,
    };
    const quality = new BuildArchetypeQualityGateV2Service().evaluate(snapshot, compiled.graph);
    const diagnostic = {
      quality,
      archetypes: archetypes.map((archetype) => ({
        archetypeId: archetype.archetypeId,
        profiles: archetype.sourceProfileAccountIds,
        quality: archetype.quality,
        items: archetype.items.map((item) => ({
          itemId: item.itemId,
          familyId: item.familyId,
          role: item.role,
          sourceProfileCount: item.sourceProfileCount,
          coverage: item.profileCoverage,
        })),
        groups: archetype.groups,
        orderEdges: archetype.orderEdges,
      })),
    };
    throw new Error(`BUILD_V2_QUALITY_DIAGNOSTIC ${JSON.stringify(diagnostic)}`);
  });
});
