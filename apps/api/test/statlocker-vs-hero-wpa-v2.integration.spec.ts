import { DataSource } from 'typeorm';
import { StatlockerVsHeroWpaRawSnapshotV1Entity } from '../src/deadlock-live/entities/statlocker-vs-hero-wpa-raw-snapshot-v1.entity';
import { StatlockerVsHeroWpaRowV1Entity } from '../src/deadlock-live/entities/statlocker-vs-hero-wpa-row-v1.entity';
import { AdaptiveRecommendationObservabilityV1Service } from '../src/statlocker-adaptive/adaptive-recommendation-observability-v1.service';
import { StatlockerVsHeroWpaRepositoryV1Service } from '../src/statlocker-adaptive/statlocker-vs-hero-wpa-repository-v1.service';
import { ThreatWeightedMatchupV1Service } from '../src/statlocker-adaptive/threat-weighted-matchup-v1.service';

const HERO_ID = 72;
const ENEMY_A = 27;
const ENEMY_B = 6;
const ITEM_ID = 1342610602;
const PATCH = 'patch-wpa-v2';
const RULESET = 'ruleset-wpa-v2';
const CATALOG_SHA = 'a'.repeat(64);
const SNAPSHOT_ID = 'wpa-v2-integration-snapshot';

const integrationDescribe = process.env.WPA_REPOSITORY_INTEGRATION === 'true'
  ? describe
  : describe.skip;

integrationDescribe('Statlocker VS_HERO_WPA V2 PostgreSQL serving path', () => {
  let dataSource: DataSource;
  let repository: StatlockerVsHeroWpaRepositoryV1Service;
  let observability: AdaptiveRecommendationObservabilityV1Service;

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST || '127.0.0.1',
      port: Number(process.env.DB_PORT || '5432'),
      username: process.env.DB_USER || 'postgres',
      password: process.env.DB_PASSWORD || 'postgres',
      database: process.env.DB_NAME || 'deadlock_builds',
      entities: [StatlockerVsHeroWpaRawSnapshotV1Entity, StatlockerVsHeroWpaRowV1Entity],
      synchronize: true,
      dropSchema: true,
      logging: false,
    });
    await dataSource.initialize();

    const rawRepository = dataSource.getRepository(StatlockerVsHeroWpaRawSnapshotV1Entity);
    const rowRepository = dataSource.getRepository(StatlockerVsHeroWpaRowV1Entity);
    await rawRepository.save(rawRepository.create({
      snapshotId: SNAPSHOT_ID,
      contentSha256: 'b'.repeat(64),
      fetchedAt: new Date('2026-09-10T12:00:00.000Z'),
      sourcePath: '/api/info/vs-hero-wpa-data',
      sourceStatus: 200,
      statlockerPatchId: PATCH,
      rulesetVersion: RULESET,
      catalogSha256: CATALOG_SHA,
      collectorVersion: 'integration-test',
      rawPayload: {},
      ingestStatus: 'PUBLISHED',
      ingestMetadata: { rowCount: 2 },
    }));
    await rowRepository.save([
      rowRepository.create({
        snapshotId: SNAPSHOT_ID,
        statlockerPatchId: PATCH,
        rulesetVersion: RULESET,
        catalogSha256: CATALOG_SHA,
        rankBucket: 'all',
        heroId: HERO_ID,
        enemyHeroId: ENEMY_A,
        itemId: ITEM_ID,
        count: 800,
        deltaWpa: 0.08,
        meanWpa: 0.04,
      }),
      rowRepository.create({
        snapshotId: SNAPSHOT_ID,
        statlockerPatchId: PATCH,
        rulesetVersion: RULESET,
        catalogSha256: CATALOG_SHA,
        rankBucket: 'all',
        heroId: HERO_ID,
        enemyHeroId: ENEMY_B,
        itemId: ITEM_ID,
        count: 1200,
        deltaWpa: 0.05,
        meanWpa: 0.03,
      }),
    ]);

    observability = new AdaptiveRecommendationObservabilityV1Service();
    repository = new StatlockerVsHeroWpaRepositoryV1Service(rowRepository, rawRepository, observability);
  }, 30_000);

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  it('returns numeric item IDs and preserves sample-size and delta-WPA scoring semantics', async () => {
    const rows = await repository.findActive({
      statlockerPatchId: PATCH,
      rulesetVersion: RULESET,
      catalogSha256: CATALOG_SHA,
      ourHeroId: HERO_ID,
      enemyHeroIds: [ENEMY_A, ENEMY_B],
    });

    expect(rows).toHaveLength(2);
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        heroId: HERO_ID,
        enemyHeroId: ENEMY_A,
        itemId: ITEM_ID,
        count: 800,
        deltaWpa: 0.08,
      }),
    ]));
    expect(rows.every((row) => typeof row.itemId === 'number')).toBe(true);
    expect(observability.getStatus().counters.wpaQueryCount).toBe(1);

    const scorer = new ThreatWeightedMatchupV1Service();
    const score = scorer.scoreItem({
      ourHeroId: HERO_ID,
      itemId: ITEM_ID,
      enemyHeroIds: [ENEMY_A, ENEMY_B],
      rows,
      enemyThreats: [
        { heroId: ENEMY_A, threatMultiplier: 1 },
        { heroId: ENEMY_B, threatMultiplier: 1 },
      ],
    });
    const tinySampleScore = scorer.scoreItem({
      ourHeroId: HERO_ID,
      itemId: ITEM_ID,
      enemyHeroIds: [ENEMY_A, ENEMY_B],
      rows: rows.map((row) => ({ ...row, count: 1 })),
      enemyThreats: [
        { heroId: ENEMY_A, threatMultiplier: 1 },
        { heroId: ENEMY_B, threatMultiplier: 1 },
      ],
    });
    const zeroDeltaScore = scorer.scoreItem({
      ourHeroId: HERO_ID,
      itemId: ITEM_ID,
      enemyHeroIds: [ENEMY_A, ENEMY_B],
      rows: rows.map((row) => ({ ...row, deltaWpa: 0 })),
      enemyThreats: [
        { heroId: ENEMY_A, threatMultiplier: 1 },
        { heroId: ENEMY_B, threatMultiplier: 1 },
      ],
    });

    expect(score.usedCount).toBe(2);
    expect(score.coverage).toBe(1);
    expect(score.confidence).toBeGreaterThan(tinySampleScore.confidence);
    expect(score.normalized).toBeGreaterThan(zeroDeltaScore.normalized);
  });
});
