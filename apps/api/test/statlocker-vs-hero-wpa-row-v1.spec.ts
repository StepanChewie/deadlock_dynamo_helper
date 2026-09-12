// RED contract: relational row implementation must satisfy this shape and index policy.
import { getMetadataArgsStorage } from 'typeorm';
import { StatlockerVsHeroWpaRowV1Entity } from '../src/deadlock-live/entities/statlocker-vs-hero-wpa-row-v1.entity';
import { StatlockerVsHeroWpaRepositoryV1Service } from '../src/statlocker-adaptive/statlocker-vs-hero-wpa-repository-v1.service';

describe('Statlocker VS_HERO_WPA relational row V1 contract', () => {
  it('maps the required relational row shape', () => {
    const metadata = getMetadataArgsStorage();
    const table = metadata.tables.find((candidate) => candidate.target === StatlockerVsHeroWpaRowV1Entity);
    const columns = metadata.columns
      .filter((candidate) => candidate.target === StatlockerVsHeroWpaRowV1Entity)
      .map((candidate) => candidate.propertyName);

    expect(table?.name).toBe('statlocker_vs_hero_wpa_rows_v1');
    expect(columns).toEqual(expect.arrayContaining([
      'snapshotId',
      'statlockerPatchId',
      'rulesetVersion',
      'catalogSha256',
      'rankBucket',
      'heroId',
      'enemyHeroId',
      'itemId',
      'count',
      'deltaWpa',
      'meanWpa',
    ]));
  });

  it('defines identity query indexes and source-row uniqueness', () => {
    const metadata = getMetadataArgsStorage();
    const indexes = metadata.indices
      .filter((candidate) => candidate.target === StatlockerVsHeroWpaRowV1Entity)
      .map((candidate) => ({ name: candidate.name, columns: candidate.columns }));

    expect(indexes).toEqual(expect.arrayContaining([
      {
        name: 'idx_statlocker_vs_hero_wpa_identity_hero_enemy_v1',
        columns: ['statlockerPatchId', 'rulesetVersion', 'catalogSha256', 'heroId', 'enemyHeroId'],
      },
      {
        name: 'idx_statlocker_vs_hero_wpa_identity_hero_item_v1',
        columns: ['statlockerPatchId', 'rulesetVersion', 'catalogSha256', 'heroId', 'itemId'],
      },
      {
        name: 'uq_statlocker_vs_hero_wpa_source_row_v1',
        columns: ['snapshotId', 'rankBucket', 'heroId', 'enemyHeroId', 'itemId'],
      },
    ]));
  });

  it('queries one explicit immutable snapshot and requested enemy set without collapsing rank rows', async () => {
    const repository = {
      find: jest.fn(async () => []),
    };
    const service = new StatlockerVsHeroWpaRepositoryV1Service(repository as never);

    await service.findForSnapshot({
      snapshotId: 'snapshot-a',
      statlockerPatchId: 'patch-a',
      rulesetVersion: 'ruleset-a',
      catalogSha256: 'A'.repeat(64),
      ourHeroId: 1,
      enemyHeroIds: [3, 2, 3],
    });

    expect(repository.find).toHaveBeenCalledWith({
      where: [
        {
          snapshotId: 'snapshot-a',
          statlockerPatchId: 'patch-a',
          rulesetVersion: 'ruleset-a',
          catalogSha256: 'a'.repeat(64),
          heroId: 1,
          enemyHeroId: 2,
        },
        {
          snapshotId: 'snapshot-a',
          statlockerPatchId: 'patch-a',
          rulesetVersion: 'ruleset-a',
          catalogSha256: 'a'.repeat(64),
          heroId: 1,
          enemyHeroId: 3,
        },
      ],
      order: {
        itemId: 'ASC',
        enemyHeroId: 'ASC',
        rankBucket: 'ASC',
      },
    });
  });

  it('does not query storage when the enemy set is empty', async () => {
    const repository = {
      find: jest.fn(async () => []),
    };
    const service = new StatlockerVsHeroWpaRepositoryV1Service(repository as never);

    await expect(service.findForSnapshot({
      snapshotId: 'snapshot-a',
      statlockerPatchId: 'patch-a',
      rulesetVersion: 'ruleset-a',
      catalogSha256: 'a'.repeat(64),
      ourHeroId: 1,
      enemyHeroIds: [],
    })).resolves.toEqual([]);

    expect(repository.find).not.toHaveBeenCalled();
  });

  it('records active-query latency only after the WPA row query settles', async () => {
    let resolveRows!: (rows: StatlockerVsHeroWpaRowV1Entity[]) => void;
    let markQueryStarted!: () => void;
    const rows = new Promise<StatlockerVsHeroWpaRowV1Entity[]>((resolve) => {
      resolveRows = resolve;
    });
    const queryStarted = new Promise<void>((resolve) => {
      markQueryStarted = resolve;
    });
    const repository = {
      find: jest.fn(() => {
        markQueryStarted();
        return rows;
      }),
    };
    const rawRepository = {
      findOne: jest.fn(async () => ({ snapshotId: 'snapshot-a' })),
    };
    const observability = {
      recordWpaQueryLatency: jest.fn(),
    };
    const service = new StatlockerVsHeroWpaRepositoryV1Service(
      repository as never,
      rawRepository as never,
      observability as never,
    );

    const pending = service.findActive({
      statlockerPatchId: 'patch-a',
      rulesetVersion: 'ruleset-a',
      catalogSha256: 'A'.repeat(64),
      ourHeroId: 1,
      enemyHeroIds: [2],
    });
    await queryStarted;

    expect(observability.recordWpaQueryLatency).not.toHaveBeenCalled();

    resolveRows([]);
    await expect(pending).resolves.toEqual([]);
    expect(observability.recordWpaQueryLatency).toHaveBeenCalledTimes(1);
  });
});
