import { readFileSync } from 'fs';
import { join } from 'path';
import { StatlockerNormalizerService } from '../src/statlocker-adaptive/statlocker-normalizer.service';
import { StatlockerVsHeroWpaRowNormalizerV1Service } from '../src/statlocker-adaptive/statlocker-vs-hero-wpa-row-normalizer-v1.service';
import { aggregateStatlockerVsHeroWpaRowsV1 } from '../src/statlocker-adaptive/statlocker-vs-hero-wpa-repository-v1.service';

const PATCH_ID = '676255623445218601';
const FIXTURE_PATH = join(__dirname, 'fixtures', 'statlocker-vs-hero-wpa-v1.json');
const ROW_IDENTITY = {
  snapshotId: 'snapshot-test',
  statlockerPatchId: PATCH_ID,
  rulesetVersion: 'ruleset-test',
  catalogSha256: 'A'.repeat(64),
};

describe('VS_HERO_WPA roadmap raw fixture V1', () => {
  const normalizer = new StatlockerNormalizerService();
  const rowNormalizer = new StatlockerVsHeroWpaRowNormalizerV1Service();

  it('captures the required multi-rank raw evidence cases', () => {
    const raw = readFixture();
    const byRank = raw.by_patch[`patch_${PATCH_ID}`].by_rank;
    const rankBuckets = Object.keys(byRank);

    expect(rankBuckets.length).toBeGreaterThanOrEqual(2);

    const leaves = rankBuckets.flatMap((rankBucket) => {
      const byHero = byRank[rankBucket].by_hero;
      const ourHero = byHero.Abrams;
      expect(ourHero).toBeDefined();
      expect(Object.keys(ourHero).length).toBeGreaterThanOrEqual(3);

      return Object.values(ourHero).flatMap((matchups) =>
        Object.entries(matchups).map(([enemyName, leaf]) => ({ enemyName, leaf })),
      );
    });

    const enemyNames = new Set(
      leaves.filter(({ enemyName }) => enemyName !== '_baseline').map(({ enemyName }) => enemyName),
    );
    expect(enemyNames.size).toBeGreaterThanOrEqual(3);
    expect(leaves.some(({ enemyName }) => enemyName === '_baseline')).toBe(true);

    const matchupLeaves = leaves.filter(({ enemyName }) => enemyName !== '_baseline');
    expect(matchupLeaves.every(({ leaf }) =>
      Number.isFinite(leaf.mean_wpa) &&
      Number.isFinite(leaf.count) &&
      Number.isFinite(leaf.delta_wpa),
    )).toBe(true);
    expect(matchupLeaves.some(({ leaf }) => leaf.count <= 10 && leaf.delta_wpa >= 0.05)).toBe(true);
    expect(matchupLeaves.some(({ leaf }) => leaf.count >= 1000 && leaf.delta_wpa > 0 && leaf.delta_wpa < 0.02)).toBe(true);
    expect(matchupLeaves.some(({ leaf }) => leaf.delta_wpa < 0)).toBe(true);
  });

  it('documents current count-weighted rank collapse and ignored matchup mean_wpa', () => {
    const normalized = normalizer.normalizeVsHeroWpa(readFixture(), PATCH_ID);
    const apollo = normalized.payload.slices.find((slice) =>
      slice.heroId === 6 && slice.enemyHeroId === 77,
    );
    const arcaneSurge = apollo?.items.find((item) => item.itemId === 1150006784);

    expect(arcaneSurge).toMatchObject({
      itemId: 1150006784,
      count: 100,
    });
    expect(arcaneSurge?.deltaWpa).toBeCloseTo(0.007, 12);
    expect(arcaneSurge).not.toHaveProperty('meanWpa');
  });

  it('preserves source rank rows, excludes baseline, and retains valid mean_wpa', () => {
    const rows = rowNormalizer.normalize(readFixture(), ROW_IDENTITY);
    const arcaneApollo = rows.filter((row) =>
      row.heroId === 6 && row.enemyHeroId === 77 && row.itemId === 1150006784,
    );

    expect(arcaneApollo).toEqual([
      expect.objectContaining({
        ...normalizedIdentity(),
        rankBucket: 'rank_8',
        heroId: 6,
        enemyHeroId: 77,
        itemId: 1150006784,
        count: 10,
        deltaWpa: 0.052,
        meanWpa: 0.05,
      }),
      expect.objectContaining({
        ...normalizedIdentity(),
        rankBucket: 'rank_9',
        heroId: 6,
        enemyHeroId: 77,
        itemId: 1150006784,
        count: 90,
        deltaWpa: 0.002,
        meanWpa: 0.001,
      }),
    ]);
    expect(rows.every((row) => Number.isInteger(row.enemyHeroId) && row.enemyHeroId > 0)).toBe(true);
  });

  it('reproduces the current all-rank count-weighted delta only at the query boundary', () => {
    const rows = rowNormalizer.normalize(readFixture(), ROW_IDENTITY);
    const aggregate = aggregateStatlockerVsHeroWpaRowsV1(rows).find((row) =>
      row.heroId === 6 && row.enemyHeroId === 77 && row.itemId === 1150006784,
    );

    expect(aggregate).toMatchObject({
      heroId: 6,
      enemyHeroId: 77,
      itemId: 1150006784,
      count: 100,
    });
    expect(aggregate?.deltaWpa).toBeCloseTo(0.007, 12);
  });

  it('ignores malformed required matchup leaves deterministically', () => {
    const raw = readFixture() as unknown as MutableRawFixture;
    raw.by_patch[`patch_${PATCH_ID}`].by_rank.rank_8.by_hero.Abrams['Arcane Surge'].Apollo.delta_wpa = 'invalid';
    raw.by_patch[`patch_${PATCH_ID}`].by_rank.rank_9.by_hero.Abrams['Arcane Surge'].Billy.count = Number.NaN;

    const rows = rowNormalizer.normalize(raw, ROW_IDENTITY);

    expect(rows).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ rankBucket: 'rank_8', heroId: 6, enemyHeroId: 77, itemId: 1150006784 }),
      expect.objectContaining({ rankBucket: 'rank_9', heroId: 6, enemyHeroId: 72, itemId: 1150006784 }),
    ]));
  });
});

type RawLeaf = {
  mean_wpa: number;
  count: number;
  delta_wpa: number;
};

type RawFixture = {
  by_patch: Record<string, {
    by_rank: Record<string, {
      by_hero: Record<string, Record<string, Record<string, RawLeaf>>>;
    }>;
  }>;
};

type MutableRawLeaf = {
  mean_wpa: unknown;
  count: unknown;
  delta_wpa: unknown;
};

type MutableRawFixture = {
  by_patch: Record<string, {
    by_rank: Record<string, {
      by_hero: Record<string, Record<string, Record<string, MutableRawLeaf>>>;
    }>;
  }>;
};

function readFixture(): RawFixture {
  return JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as RawFixture;
}

function normalizedIdentity(): typeof ROW_IDENTITY {
  return {
    ...ROW_IDENTITY,
    catalogSha256: ROW_IDENTITY.catalogSha256.toLowerCase(),
  };
}
