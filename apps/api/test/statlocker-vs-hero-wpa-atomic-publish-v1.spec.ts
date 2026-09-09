import { getMetadataArgsStorage } from 'typeorm';
import { StatlockerVsHeroWpaRawSnapshotV1Entity } from '../src/deadlock-live/entities/statlocker-vs-hero-wpa-raw-snapshot-v1.entity';
import { StatlockerVsHeroWpaRowV1Entity } from '../src/deadlock-live/entities/statlocker-vs-hero-wpa-row-v1.entity';
import { StatlockerVsHeroWpaPublisherV1Service } from '../src/statlocker-adaptive/statlocker-vs-hero-wpa-publisher-v1.service';
import { StatlockerVsHeroWpaRepositoryV1Service } from '../src/statlocker-adaptive/statlocker-vs-hero-wpa-repository-v1.service';
import { NormalizedStatlockerVsHeroWpaRowV1 } from '../src/statlocker-adaptive/statlocker-vs-hero-wpa-row-normalizer-v1.service';

describe('Statlocker VS_HERO_WPA atomic relational publication V1', () => {
  it('enforces one published RAW snapshot per patch/ruleset/catalog identity', () => {
    const metadata = getMetadataArgsStorage();
    const index = metadata.indices.find((candidate) =>
      candidate.target === StatlockerVsHeroWpaRawSnapshotV1Entity &&
      candidate.name === 'uq_statlocker_vs_hero_wpa_published_identity_v1',
    );

    expect(index?.columns).toEqual(['statlockerPatchId', 'rulesetVersion', 'catalogSha256']);
    expect(index?.unique).toBe(true);
    expect(index?.where).toBe(`"ingestStatus" = 'PUBLISHED'`);
  });

  it('atomically publishes validated rows and supersedes the previous active snapshot without deleting old rows', async () => {
    const dataSource = new FakePublicationDataSource({
      raw: [
        rawSnapshot('snapshot-a', 'PUBLISHED', '2026-09-08T10:00:00.000Z'),
        rawSnapshot('snapshot-b', 'PENDING', '2026-09-09T10:00:00.000Z'),
      ],
      rows: [persistedRow('snapshot-a', 1, 'rank_8')],
    });
    const publisher = new StatlockerVsHeroWpaPublisherV1Service(dataSource as never);

    await publisher.publish({
      snapshotId: 'snapshot-b',
      rows: [normalizedRow('snapshot-b', 2, 'rank_8'), normalizedRow('snapshot-b', 3, 'rank_9')],
    });

    expect(statusOf(dataSource.state, 'snapshot-a')).toBe('SUPERSEDED');
    expect(statusOf(dataSource.state, 'snapshot-b')).toBe('PUBLISHED');
    expect(dataSource.state.rows.filter((row) => row.snapshotId === 'snapshot-a')).toHaveLength(1);
    expect(dataSource.state.rows.filter((row) => row.snapshotId === 'snapshot-b')).toHaveLength(2);
    expect(metadataOf(dataSource.state, 'snapshot-b')).toEqual(expect.objectContaining({
      rowCount: 2,
      previousSnapshotId: 'snapshot-a',
    }));
  });

  it('keeps the previous published snapshot active and marks the new RAW snapshot failed when row insertion fails', async () => {
    const dataSource = new FakePublicationDataSource({
      raw: [
        rawSnapshot('snapshot-a', 'PUBLISHED', '2026-09-08T10:00:00.000Z'),
        rawSnapshot('snapshot-b', 'PENDING', '2026-09-09T10:00:00.000Z'),
      ],
      rows: [persistedRow('snapshot-a', 1, 'rank_8')],
    });
    dataSource.failRowInsert = true;
    const publisher = new StatlockerVsHeroWpaPublisherV1Service(dataSource as never);

    await expect(publisher.publish({
      snapshotId: 'snapshot-b',
      rows: [normalizedRow('snapshot-b', 2, 'rank_8')],
    })).rejects.toThrow('row insert failed');

    expect(statusOf(dataSource.state, 'snapshot-a')).toBe('PUBLISHED');
    expect(statusOf(dataSource.state, 'snapshot-b')).toBe('FAILED');
    expect(dataSource.state.rows.filter((row) => row.snapshotId === 'snapshot-b')).toHaveLength(0);
    expect(metadataOf(dataSource.state, 'snapshot-b')).toEqual(expect.objectContaining({
      error: 'row insert failed',
    }));
  });

  it('fails closed on an empty relational dataset before switching the active snapshot', async () => {
    const dataSource = new FakePublicationDataSource({
      raw: [
        rawSnapshot('snapshot-a', 'PUBLISHED', '2026-09-08T10:00:00.000Z'),
        rawSnapshot('snapshot-b', 'PENDING', '2026-09-09T10:00:00.000Z'),
      ],
      rows: [persistedRow('snapshot-a', 1, 'rank_8')],
    });
    const publisher = new StatlockerVsHeroWpaPublisherV1Service(dataSource as never);

    await expect(publisher.publish({ snapshotId: 'snapshot-b', rows: [] })).rejects.toThrow(
      'relational rowset must not be empty',
    );

    expect(statusOf(dataSource.state, 'snapshot-a')).toBe('PUBLISHED');
    expect(statusOf(dataSource.state, 'snapshot-b')).toBe('FAILED');
  });

  it('resolves the currently published snapshot before querying requested enemies', async () => {
    const rowRepository = {
      find: jest.fn(async () => []),
    };
    const rawRepository = {
      findOne: jest.fn(async () => rawSnapshot('snapshot-b', 'PUBLISHED', '2026-09-09T10:00:00.000Z')),
    };
    const service = new StatlockerVsHeroWpaRepositoryV1Service(
      rowRepository as never,
      rawRepository as never,
    );

    await service.findActive({
      statlockerPatchId: 'patch-a',
      rulesetVersion: 'ruleset-a',
      catalogSha256: 'A'.repeat(64),
      ourHeroId: 6,
      enemyHeroIds: [77, 11],
    });

    expect(rawRepository.findOne).toHaveBeenCalledWith({
      where: {
        statlockerPatchId: 'patch-a',
        rulesetVersion: 'ruleset-a',
        catalogSha256: 'a'.repeat(64),
        ingestStatus: 'PUBLISHED',
      },
      order: { fetchedAt: 'DESC' },
    });
    expect(rowRepository.find).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.arrayContaining([
        expect.objectContaining({ snapshotId: 'snapshot-b', enemyHeroId: 11 }),
        expect.objectContaining({ snapshotId: 'snapshot-b', enemyHeroId: 77 }),
      ]),
    }));
  });
});

type PublicationState = {
  raw: StatlockerVsHeroWpaRawSnapshotV1Entity[];
  rows: StatlockerVsHeroWpaRowV1Entity[];
};

class FakePublicationDataSource {
  state: PublicationState;
  failRowInsert = false;

  constructor(initial: PublicationState) {
    this.state = cloneState(initial);
  }

  getRepository(entity: unknown): unknown {
    return repositoryFor(this.state, entity, () => this.failRowInsert);
  }

  async transaction<T>(work: (manager: { getRepository(entity: unknown): unknown }) => Promise<T>): Promise<T> {
    const draft = cloneState(this.state);
    const manager = {
      getRepository: (entity: unknown) => repositoryFor(draft, entity, () => this.failRowInsert),
    };
    const result = await work(manager);
    this.state = draft;
    return result;
  }
}

function repositoryFor(
  state: PublicationState,
  entity: unknown,
  shouldFailRowInsert: () => boolean,
): unknown {
  if (entity === StatlockerVsHeroWpaRawSnapshotV1Entity) {
    return {
      findOne: async (options: {
        where: Partial<StatlockerVsHeroWpaRawSnapshotV1Entity>;
        order?: { fetchedAt?: 'ASC' | 'DESC' };
      }) => {
        const rows = state.raw.filter((row) => matches(row, options.where));
        if (options.order?.fetchedAt === 'DESC') {
          rows.sort((a, b) => b.fetchedAt.getTime() - a.fetchedAt.getTime());
        }
        return rows[0];
      },
      update: async (
        where: Partial<StatlockerVsHeroWpaRawSnapshotV1Entity>,
        patch: Partial<StatlockerVsHeroWpaRawSnapshotV1Entity>,
      ) => {
        let affected = 0;
        for (const row of state.raw) {
          if (!matches(row, where)) continue;
          Object.assign(row, patch);
          affected += 1;
        }
        return { affected };
      },
    };
  }

  if (entity === StatlockerVsHeroWpaRowV1Entity) {
    return {
      insert: async (rows: readonly NormalizedStatlockerVsHeroWpaRowV1[]) => {
        if (shouldFailRowInsert()) throw new Error('row insert failed');
        let nextId = state.rows.reduce((max, row) => Math.max(max, row.id), 0) + 1;
        for (const row of rows) {
          state.rows.push({ id: nextId, ...row } as StatlockerVsHeroWpaRowV1Entity);
          nextId += 1;
        }
        return { identifiers: [] };
      },
    };
  }

  throw new Error('unsupported repository entity');
}

function rawSnapshot(
  snapshotId: string,
  ingestStatus: string,
  fetchedAt: string,
): StatlockerVsHeroWpaRawSnapshotV1Entity {
  return {
    snapshotId,
    contentSha256: snapshotId.padEnd(64, snapshotId[0] ?? 'a').slice(0, 64),
    fetchedAt: new Date(fetchedAt),
    sourcePath: '/api/info/vs-hero-wpa-data',
    sourceStatus: 200,
    statlockerPatchId: 'patch-a',
    rulesetVersion: 'ruleset-a',
    catalogSha256: 'a'.repeat(64),
    collectorVersion: 'collector-v1',
    rawPayload: {},
    ingestStatus,
    ingestMetadata: {},
    createdAt: new Date(fetchedAt),
  };
}

function normalizedRow(
  snapshotId: string,
  itemId: number,
  rankBucket: string,
): NormalizedStatlockerVsHeroWpaRowV1 {
  return {
    snapshotId,
    statlockerPatchId: 'patch-a',
    rulesetVersion: 'ruleset-a',
    catalogSha256: 'a'.repeat(64),
    rankBucket,
    heroId: 6,
    enemyHeroId: 77,
    itemId,
    count: 100,
    deltaWpa: 0.01,
    meanWpa: 0.02,
  };
}

function persistedRow(
  snapshotId: string,
  itemId: number,
  rankBucket: string,
): StatlockerVsHeroWpaRowV1Entity {
  return { id: itemId, ...normalizedRow(snapshotId, itemId, rankBucket) } as StatlockerVsHeroWpaRowV1Entity;
}

function statusOf(state: PublicationState, snapshotId: string): string | undefined {
  return state.raw.find((row) => row.snapshotId === snapshotId)?.ingestStatus;
}

function metadataOf(state: PublicationState, snapshotId: string): Record<string, unknown> | undefined {
  return state.raw.find((row) => row.snapshotId === snapshotId)?.ingestMetadata;
}

function matches<T extends object>(row: T, where: Partial<T>): boolean {
  return Object.entries(where).every(([key, value]) => row[key as keyof T] === value);
}

function cloneState(state: PublicationState): PublicationState {
  return {
    raw: state.raw.map((row) => ({
      ...row,
      fetchedAt: new Date(row.fetchedAt),
      createdAt: new Date(row.createdAt),
      ingestMetadata: { ...row.ingestMetadata },
    })),
    rows: state.rows.map((row) => ({ ...row })),
  };
}
