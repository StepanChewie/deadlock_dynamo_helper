import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  buildStatlockerBuildV2Fixture,
  parseCaptureStatlockerBuildV2FixtureArgs,
  resolveFixtureCatalogContentVersionId,
  statlockerFixtureScope,
} from '../src/scripts/capture-statlocker-build-v2-fixture';

const HERO_ID = 72;
const MATCH_ID = 'statlocker-billy-real-request';
const RULESET_VERSION = 'ruleset-a';
const PATCH_ID = 'patch-a';
const CATALOG_SHA = 'a'.repeat(64);
const CATALOG_VERSION_ID = 'catalog-a';
const ENEMY_HERO_IDS = [6, 10, 13, 27, 31, 35];

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

function realRequest() {
  return {
    matchId: MATCH_ID,
    heroId: HERO_ID,
    gameTimeSec: 620,
    ownedItemIds: [101],
    spendableSouls: 3200,
    allyHeroIds: [1, 2, 3, 4, 5],
    enemyHeroIds: [...ENEMY_HERO_IDS],
    enemyLiveStates: ENEMY_HERO_IDS.map((heroId, index) => ({
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
    unlockedFlexSlots: 4,
    totalCapacity: 12,
    stateRevision: 'request-state-real',
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

  return {
    request: realRequest(),
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
  };
}

describe('capture Statlocker Build V2 fixture', () => {
  it('accepts only request-file live context plus an output path', () => {
    expect(parseCaptureStatlockerBuildV2FixtureArgs([
      '--request', 'test/fixtures/statlocker-build-v2/billy-real.request.json',
      '--out', 'test/fixtures/statlocker-build-v2/billy-real.fixture.json',
    ])).toEqual({
      request: 'test/fixtures/statlocker-build-v2/billy-real.request.json',
      out: 'test/fixtures/statlocker-build-v2/billy-real.fixture.json',
    });

    expect(() => parseCaptureStatlockerBuildV2FixtureArgs([
      '--heroId', '72',
      '--matchId', '676255623445218601',
      '--out', 'test/fixtures/statlocker-build-v2/billy-real.fixture.json',
    ])).toThrow('requires --request');
  });

  it('has no saved recommendation or Overwolf dependency in the capture source', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/scripts/capture-statlocker-build-v2-fixture.ts'),
      'utf8',
    );

    expect(source).not.toContain('AdaptiveRecommendationDecisionV1Entity');
    expect(source).not.toContain('adaptive_recommendation_decisions_v1');
    expect(source).not.toContain('loadLiveReplay');
    expect(source).not.toContain('OVERWOLF');
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

  it('captures request live context plus exactly the ranked Statlocker top 10 and relevant evidence', () => {
    const fixture = buildStatlockerBuildV2Fixture(sourceInput());

    expect(fixture.metadata).toMatchObject({
      heroId: HERO_ID,
      matchId: MATCH_ID,
      source: 'STATLOCKER_ONLY',
      buildEvidenceSource: 'STATLOCKER_ONLY',
      liveContextSource: 'REQUEST',
    });
    expect(fixture.request).toEqual(realRequest());
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
  });

  it('fails fast instead of weakening top-10 provenance', () => {
    const input = sourceInput();
    input.proBuildAnalyses = input.proBuildAnalyses.filter((entry) => entry.accountId !== 'account-4');

    expect(() => buildStatlockerBuildV2Fixture(input))
      .toThrow('exactly 10 ranked PRO_BUILD_ANALYSIS profiles');
  });

  it('fails fast when the request does not contain a complete enemy roster', () => {
    const input = sourceInput();
    input.request.enemyHeroIds = [6, 10, 13, 27, 31];

    expect(() => buildStatlockerBuildV2Fixture(input))
      .toThrow('complete enemy roster');
  });
});
