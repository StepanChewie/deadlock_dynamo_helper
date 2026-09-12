import { BuildArchetypeCompilerV2Service } from '../src/statlocker-adaptive/build-archetype-compiler-v2.service';
import { BuildArchetypeMinerV2Service } from '../src/statlocker-adaptive/build-archetype-miner-v2.service';
import { BuildArchetypeQualityGateV2Service } from '../src/statlocker-adaptive/build-archetype-quality-gate-v2.service';
import { BuildArchetypeRefreshV2Service } from '../src/statlocker-adaptive/build-archetype-refresh-v2.service';
import { StatlockerProBuildAnalysisV1 } from '../src/statlocker-adaptive/statlocker-adaptive.types';

const HERO_ID = 72;
const RULESET = 'r1';
const PATCH = 'patch-1';
const CATALOG_SHA = 'a'.repeat(64);

function proBuild(accountId: string): StatlockerProBuildAnalysisV1 {
  return {
    accountId,
    heroId: HERO_ID,
    items: [
      {
        itemId: 1,
        purchaseRate: 0.95,
        medianBuyTimeS: 300,
        frequencyTier: 'CORE',
        phase: 'EARLY',
        relationships: [{ itemId: 2, strength: 0.9 }],
      },
      {
        itemId: 2,
        purchaseRate: 0.82,
        medianBuyTimeS: 720,
        frequencyTier: 'FREQUENT',
        phase: 'MID',
        relationships: [{ itemId: 1, strength: 0.9 }],
      },
    ],
  };
}

function evidenceRow(dataset: string, scopeKey: string, payload: Record<string, unknown>, rank = 0) {
  return {
    snapshotId: `source:${dataset}:${scopeKey}`,
    dataset,
    rulesetVersion: RULESET,
    catalogSha256: CATALOG_SHA,
    statlockerPatchId: PATCH,
    scopeKey,
    fetchedAt: new Date(`2026-09-10T00:${String(rank).padStart(2, '0')}:00.000Z`),
    payload,
  };
}

function sourceStore(profileCount = 12) {
  const leaderboard = {
    heroId: HERO_ID,
    profiles: Array.from({ length: profileCount }, (_, index) => ({
      accountId: `p${String(index + 1).padStart(2, '0')}`,
      heroId: HERO_ID,
      rank: index + 1,
    })),
  };
  const rows = new Map<string, any>();
  rows.set(
    `HERO_LEADERBOARD|hero:${HERO_ID}`,
    evidenceRow('HERO_LEADERBOARD', `hero:${HERO_ID}`, leaderboard),
  );
  for (const profile of leaderboard.profiles) {
    const scopeKey = `hero:${HERO_ID}:account:${profile.accountId}`;
    rows.set(
      `PRO_BUILD_ANALYSIS|${scopeKey}`,
      evidenceRow('PRO_BUILD_ANALYSIS', scopeKey, proBuild(profile.accountId) as unknown as Record<string, unknown>, profile.rank),
    );
  }
  return {
    getActive: jest.fn((input: any) => rows.get(`${input.dataset}|${input.scopeKey}`)),
  } as any;
}

function catalogRepositories(extraItems: readonly any[] = []) {
  const versionRepo = {
    findOne: jest.fn(async () => ({
      catalogVersionId: 'catalog-v1',
      contentCatalogVersionId: undefined,
      rulesetKey: RULESET,
      payloadSha256: CATALOG_SHA,
    })),
  } as any;
  const itemRepo = {
    find: jest.fn(async () => [
      { catalogVersionId: 'catalog-v1', itemId: 1, name: 'Core', slotType: 'weapon', cost: 800, active: true, rawPayload: {} },
      { catalogVersionId: 'catalog-v1', itemId: 2, name: 'Followup', slotType: 'vitality', cost: 1600, active: true, rawPayload: {} },
      ...extraItems,
    ]),
  } as any;
  const recipeRepo = { find: jest.fn(async () => []) } as any;
  return { versionRepo, itemRepo, recipeRepo };
}

function service(source = sourceStore(), extraCatalogItems: readonly any[] = []) {
  const catalog = catalogRepositories(extraCatalogItems);
  const published = {
    publishValidated: jest.fn(async (snapshot: any) => ({ snapshotId: snapshot.snapshotId })),
  } as any;
  return {
    published,
    service: new BuildArchetypeRefreshV2Service(
      source,
      new BuildArchetypeMinerV2Service(),
      new BuildArchetypeCompilerV2Service(),
      new BuildArchetypeQualityGateV2Service(),
      published,
      catalog.versionRepo,
      catalog.itemRepo,
      catalog.recipeRepo,
    ),
  };
}

describe('BuildArchetypeRefreshV2Service', () => {
  it('uses exactly the top ten ranked Statlocker profiles and preserves rank provenance', async () => {
    const source = sourceStore(12);
    const fixture = service(source);

    const result = await fixture.service.refreshHero(HERO_ID, {
      rulesetVersion: RULESET,
      catalogSha256: CATALOG_SHA,
      statlockerPatchId: PATCH,
    });

    expect(result.published).toBe(true);
    expect(result.sourceProfiles).toEqual(
      Array.from({ length: 10 }, (_, index) => ({
        accountId: `p${String(index + 1).padStart(2, '0')}`,
        rank: index + 1,
      })),
    );
    expect(result.sourceProfiles.some((entry) => entry.accountId === 'p11')).toBe(false);
    expect(result.sourceProfiles.some((entry) => entry.accountId === 'p12')).toBe(false);

    const publishedSnapshot = fixture.published.publishValidated.mock.calls[0][0];
    expect(publishedSnapshot.sourceProfileAccountIds).toEqual(
      Array.from({ length: 10 }, (_, index) => `p${String(index + 1).padStart(2, '0')}`),
    );
    expect(publishedSnapshot.archetypes).toHaveLength(1);
    expect(publishedSnapshot.archetypes[0].sourceProfileAccountIds).toHaveLength(10);
  });

  it('does not publish partial top-ten input and therefore cannot replace the active snapshot', async () => {
    const source = sourceStore(9);
    const fixture = service(source);

    const result = await fixture.service.refreshHero(HERO_ID, {
      rulesetVersion: RULESET,
      catalogSha256: CATALOG_SHA,
      statlockerPatchId: PATCH,
    });

    expect(result.published).toBe(false);
    expect(result.reasonCodes).toContain('INSUFFICIENT_TOP_TEN_PROFILES');
    expect(fixture.published.publishValidated).not.toHaveBeenCalled();
  });

  it('does not substitute rank 11 when a top-ten PRO_BUILD_ANALYSIS snapshot is missing', async () => {
    const source = sourceStore(12);
    const originalGetActive = source.getActive.bind(source);
    source.getActive = jest.fn((input: any) => {
      if (input.dataset === 'PRO_BUILD_ANALYSIS' && input.scopeKey.endsWith(':p04')) return undefined;
      return originalGetActive(input);
    });
    const fixture = service(source);

    const result = await fixture.service.refreshHero(HERO_ID, {
      rulesetVersion: RULESET,
      catalogSha256: CATALOG_SHA,
      statlockerPatchId: PATCH,
    });

    expect(result.published).toBe(false);
    expect(result.reasonCodes).toContain('INSUFFICIENT_TOP_TEN_PROFILES');
    expect(result.sourceProfiles.map((entry) => entry.accountId)).not.toContain('p11');
    expect(fixture.published.publishValidated).not.toHaveBeenCalled();
  });

  it('ignores catalog metadata rows without an inventory slot type', async () => {
    const fixture = service(sourceStore(), [
      {
        catalogVersionId: 'catalog-v1',
        itemId: 999,
        name: 'Ability metadata',
        slotType: null,
        active: false,
        rawPayload: { type: 'ability' },
      },
    ]);

    const result = await fixture.service.refreshHero(HERO_ID, {
      rulesetVersion: RULESET,
      catalogSha256: CATALOG_SHA,
      statlockerPatchId: PATCH,
    });

    expect(result.published).toBe(true);
    expect(fixture.published.publishValidated).toHaveBeenCalledTimes(1);
  });
});
