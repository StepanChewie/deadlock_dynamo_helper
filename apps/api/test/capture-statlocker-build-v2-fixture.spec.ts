import {
  buildStatlockerBuildV2Fixture,
  parseCaptureStatlockerBuildV2FixtureArgs,
  resolveFixtureCatalogContentVersionId,
  statlockerFixtureScope,
} from '../src/scripts/capture-statlocker-build-v2-fixture';

const HERO_ID = 72;
const MATCH_ID = '676255623445218601';
const RULESET_VERSION = 'ruleset-a';
const PATCH_ID = 'patch-a';
const CATALOG_SHA = 'a'.repeat(64);
const CATALOG_VERSION_ID = 'catalog-a';

function proBuild(accountId: string, itemId: number) {
  return {
    accountId,
    heroId: HERO_ID,
    items: [{
      itemId,
      purchaseRate: 0.9,
      medianBuyTimeS: 300 + itemId,
      frequencyTier: 'CORE' as const,
      phase: 'EARLY' as const,
      relationships: [],
    }],
  };
}

function sourceInput() {
  const rankedAccounts = Array.from({ length: 11 }, (_, index) => ({
    accountId: `account-${index + 1}`,
    heroId: HERO_ID,
    rank: index + 1,
  }));
  const proBuildAnalyses = rankedAccounts
    .map((entry, index) => proBuild(entry.accountId, 100 + index))
    .reverse();
  const enemyHeroIds = [6, 10, 13, 27, 31, 35];

  return {
    heroId: HERO_ID,
    requestedMatchId: MATCH_ID,
    identity: {
      rulesetVersion: RULESET_VERSION,
      catalogSha256: CATALOG_SHA,
      statlockerPatchId: PATCH_ID,
    },
    leaderboard: {
      heroId: HERO_ID,
      profiles: [...rankedAccounts].reverse(),
    },
    proBuildAnalyses,
    wpaPatchData: {
      patchId: PATCH_ID,
      items: [
        { heroId: 999, itemId: 999, meanWpa: 0.5, sampleSize: 10, gameState: {}, purchaseTiming: {} },
        { heroId: HERO_ID, itemId: 102, meanWpa: 0.2, sampleSize: 20, gameState: {}, purchaseTiming: {} },
        { heroId: HERO_ID, itemId: 101, meanWpa: 0.1, sampleSize: 30, gameState: {}, purchaseTiming: {} },
      ],
    },
    t4Chains: {
      chains: [
        { heroId: 999, itemIds: [999], sampleSize: 1 },
        { heroId: HERO_ID, itemIds: [102, 101], sampleSize: 50 },
      ],
    },
    vsHeroWpaRows: [
      { snapshotId: 'wpa-2', statlockerPatchId: PATCH_ID, rulesetVersion: RULESET_VERSION, catalogSha256: CATALOG_SHA, rankBucket: 'all', heroId: HERO_ID, enemyHeroId: 10, itemId: 102, count: 20, deltaWpa: 0.02 },
      { snapshotId: 'wpa-other', statlockerPatchId: PATCH_ID, rulesetVersion: RULESET_VERSION, catalogSha256: CATALOG_SHA, rankBucket: 'all', heroId: 999, enemyHeroId: 10, itemId: 102, count: 20, deltaWpa: 0.02 },
      { snapshotId: 'wpa-1', statlockerPatchId: PATCH_ID, rulesetVersion: RULESET_VERSION, catalogSha256: CATALOG_SHA, rankBucket: 'all', heroId: HERO_ID, enemyHeroId: 6, itemId: 101, count: 30, deltaWpa: 0.03 },
    ],
    catalog: {
      version: {
        catalogVersionId: CATALOG_VERSION_ID,
        rulesetKey: RULESET_VERSION,
        payloadSha256: CATALOG_SHA,
        source: 'test',
      },
      items: [
        { catalogVersionId: CATALOG_VERSION_ID, itemId: 102, name: 'Item 102', slotType: 'spirit', cost: 1600, active: true, disabled: false, rawPayload: {} },
        { catalogVersionId: CATALOG_VERSION_ID, itemId: 101, name: 'Item 101', slotType: 'weapon', cost: 800, active: true, disabled: false, rawPayload: {} },
      ],
      recipes: [
        { catalogVersionId: CATALOG_VERSION_ID, parentItemId: 102, componentItemId: 101, componentOrder: 0 },
      ],
    },
    liveReplay: {
      decisionId: 'decision-real',
      matchId: MATCH_ID,
      decidedAt: '2026-09-10T20:00:00.000Z',
      replayInput: {
        decision: {
          state: {
            decisionId: 'decision-real',
            matchId: MATCH_ID,
            playerSlot: 0,
            gameTimeSec: 620,
            rulesetId: RULESET_VERSION,
            heroId: HERO_ID,
            ownedItemIds: [101],
            spendableSouls: { value: 3200, evidence: 'OBSERVED', source: 'OVERWOLF_GEP' },
            shopOpportunity: { evidence: 'UNKNOWN', source: 'OVERWOLF_GEP' },
          },
          itemDefinitions: [],
          catalogVersionId: CATALOG_VERSION_ID,
          catalogSha256: CATALOG_SHA,
          rulesetId: RULESET_VERSION,
          localSteamId: 'local-player',
          allyHeroIds: [1, 2, 3, 4, 5],
          enemyHeroIds,
          enemyHeroes: enemyHeroIds.map((heroId) => ({ heroId })),
          enemyLiveStates: enemyHeroIds.map((heroId, index) => ({
            steamId: `enemy-${heroId}`,
            heroId,
            level: 10 + index,
            souls: 5000 + index * 100,
            kills: index,
            deaths: 1,
            assists: 2,
            heroDamage: 4000 + index * 200,
          })),
          allyItemIds: [],
          enemyItemIds: [],
          slots: { totalCapacity: 12, evidence: 'OBSERVED' },
          investment: { evidence: 'RECONSTRUCTED', tracks: {} },
          economyRulesEvidence: 'RECONSTRUCTED',
          stateRevision: 'state-real',
        },
      },
    },
  };
}

describe('capture Statlocker Build V2 fixture', () => {
  it('parses the explicit CLI contract', () => {
    expect(parseCaptureStatlockerBuildV2FixtureArgs([
      '--heroId', '72',
      '--matchId', MATCH_ID,
      '--out', 'test/fixtures/statlocker-build-v2/billy-real.fixture.json',
    ])).toEqual({
      heroId: HERO_ID,
      matchId: MATCH_ID,
      out: 'test/fixtures/statlocker-build-v2/billy-real.fixture.json',
    });

    expect(() => parseCaptureStatlockerBuildV2FixtureArgs(['--heroId', '72']))
      .toThrow('matchId');
  });

  it('uses normalized Statlocker snapshot scopes and deduplicated catalog content identity', () => {
    expect(statlockerFixtureScope('WPA_PATCH_DATA', {
      heroId: HERO_ID,
      statlockerPatchId: PATCH_ID,
    })).toBe(`patch:${PATCH_ID}`);
    expect(statlockerFixtureScope('T4_CHAINS', {
      heroId: HERO_ID,
      statlockerPatchId: PATCH_ID,
    })).toBe('global');
    expect(statlockerFixtureScope('HERO_LEADERBOARD', {
      heroId: HERO_ID,
      statlockerPatchId: PATCH_ID,
    })).toBe(`hero:${HERO_ID}`);
    expect(statlockerFixtureScope('PRO_BUILD_ANALYSIS', {
      heroId: HERO_ID,
      statlockerPatchId: PATCH_ID,
      accountId: 'account-1',
    })).toBe(`hero:${HERO_ID}:account:account-1`);

    expect(resolveFixtureCatalogContentVersionId({
      catalogVersionId: 'catalog-alias',
      contentCatalogVersionId: 'catalog-content',
    })).toBe('catalog-content');
    expect(resolveFixtureCatalogContentVersionId({
      catalogVersionId: 'catalog-canonical',
    })).toBe('catalog-canonical');
  });

  it('captures exactly the ranked top 10 profiles and deterministic relevant evidence', () => {
    const fixture = buildStatlockerBuildV2Fixture(sourceInput());

    expect(fixture.metadata).toMatchObject({
      heroId: HERO_ID,
      requestedMatchId: MATCH_ID,
      matchId: MATCH_ID,
      source: 'EXISTING_DATABASE',
    });
    expect(fixture.leaderboard.profiles.map((entry) => entry.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(fixture.proBuildAnalyses).toHaveLength(10);
    expect(fixture.proBuildAnalyses.map((entry) => entry.accountId)).toEqual(
      Array.from({ length: 10 }, (_, index) => `account-${index + 1}`),
    );
    expect(fixture.proBuildAnalyses.some((entry) => entry.accountId === 'account-11')).toBe(false);
    expect(fixture.wpaPatchData.items.map((entry) => entry.itemId)).toEqual([101, 102]);
    expect(fixture.t4Chains.chains).toHaveLength(1);
    expect(fixture.vsHeroWpaRows.map((entry) => [entry.enemyHeroId, entry.itemId])).toEqual([
      [6, 101],
      [10, 102],
    ]);
    expect(fixture.catalog.items.map((entry) => entry.itemId)).toEqual([101, 102]);
    expect(fixture.liveState.enemyHeroIds).toEqual([6, 10, 13, 27, 31, 35]);
    expect(fixture.liveState.state.heroId).toBe(HERO_ID);
  });

  it('fails fast instead of weakening top-10 provenance', () => {
    const input = sourceInput();
    input.proBuildAnalyses = input.proBuildAnalyses.filter((entry) => entry.accountId !== 'account-4');

    expect(() => buildStatlockerBuildV2Fixture(input))
      .toThrow('exactly 10 ranked PRO_BUILD_ANALYSIS profiles');
  });

  it('fails fast when a complete enemy roster cannot be proven from the saved replay', () => {
    const input = sourceInput();
    input.liveReplay.replayInput.decision.enemyHeroIds = [6, 10, 13, 27, 31];

    expect(() => buildStatlockerBuildV2Fixture(input))
      .toThrow('complete enemy roster');
  });
});
