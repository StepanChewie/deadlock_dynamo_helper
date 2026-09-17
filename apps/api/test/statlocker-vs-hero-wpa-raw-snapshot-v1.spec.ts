import { getMetadataArgsStorage } from 'typeorm';
import { StatlockerVsHeroWpaRawSnapshotV1Entity } from '../src/deadlock-live/entities/statlocker-vs-hero-wpa-raw-snapshot-v1.entity';
import { StatlockerVsHeroWpaRawStoreV1Service } from '../src/statlocker-adaptive/statlocker-vs-hero-wpa-raw-store-v1.service';

describe('Statlocker VS_HERO_WPA RAW snapshot V1 persistence contract', () => {
  it('maps the dedicated immutable RAW snapshot table and required provenance fields', () => {
    const metadata = getMetadataArgsStorage();
    const table = metadata.tables.find(
      (candidate) => candidate.target === StatlockerVsHeroWpaRawSnapshotV1Entity,
    );
    const columns = metadata.columns
      .filter((candidate) => candidate.target === StatlockerVsHeroWpaRawSnapshotV1Entity)
      .map((candidate) => candidate.propertyName);

    expect(table?.name).toBe('statlocker_vs_hero_wpa_raw_snapshots_v1');
    expect(columns).toEqual(
      expect.arrayContaining([
        'snapshotId',
        'contentSha256',
        'fetchedAt',
        'sourcePath',
        'sourceStatus',
        'statlockerPatchId',
        'rulesetVersion',
        'catalogSha256',
        'collectorVersion',
        'rawPayload',
        'ingestStatus',
        'ingestMetadata',
      ]),
    );
  });

  it('uses the content hash as immutable content identity', () => {
    const metadata = getMetadataArgsStorage();
    const unique = metadata.uniques.find(
      (candidate) => candidate.target === StatlockerVsHeroWpaRawSnapshotV1Entity,
    );

    expect(unique?.columns).toEqual(['contentSha256']);
  });

  it('persists the exact RAW payload with pending publication state', async () => {
    const repository = {
      create: jest.fn((row) => row),
      findOne: jest.fn().mockResolvedValue(undefined),
      insert: jest.fn().mockResolvedValue({ identifiers: [] }),
    };
    const store = new StatlockerVsHeroWpaRawStoreV1Service(repository as never);
    const rawPayload = {
      heroes: [{ hero_id: 1, wpa: 0.123456 }],
      untouched: { nested: ['raw', 7] },
    };

    const row = await store.persist({
      fetchedAt: '2026-09-09T11:00:00.000Z',
      sourcePath: '/api/items/vs-hero-wpa',
      sourceStatus: 200,
      statlockerPatchId: 'patch-123',
      rulesetVersion: 'rules-v1',
      catalogSha256: 'a'.repeat(64),
      collectorVersion: 'collector-v1',
      rawPayload,
    });

    expect(row.snapshotId).toBe(row.contentSha256);
    expect(row.contentSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(row.rawPayload).toBe(rawPayload);
    expect(row.ingestStatus).toBe('PENDING');
    expect(row.ingestMetadata).toEqual({});
    expect(repository.insert).toHaveBeenCalledWith(row);
  });

  it('returns an existing content identity unchanged when the identity still matches', async () => {
    const existing = {
      snapshotId: 'b'.repeat(64),
      contentSha256: 'b'.repeat(64),
      fetchedAt: new Date('2026-09-09T10:00:00.000Z'),
      sourcePath: '/old-path',
      sourceStatus: 200,
      statlockerPatchId: 'patch-1',
      rulesetVersion: 'rules-v1',
      catalogSha256: 'a'.repeat(64),
      collectorVersion: 'collector-v1',
      rawPayload: { stable: true },
      ingestStatus: 'PUBLISHED',
      ingestMetadata: { publicationId: 'dataset-1' },
      createdAt: new Date('2026-09-09T10:00:00.000Z'),
    } as StatlockerVsHeroWpaRawSnapshotV1Entity;
    const repository = {
      create: jest.fn((row) => row),
      findOne: jest.fn().mockResolvedValue(existing),
      insert: jest.fn(),
      update: jest.fn(),
    };
    const store = new StatlockerVsHeroWpaRawStoreV1Service(repository as never);
    jest.spyOn(store, 'contentSha256').mockReturnValue(existing.contentSha256);

    const row = await store.persist({
      fetchedAt: '2026-09-09T11:00:00.000Z',
      sourcePath: '/new-path',
      sourceStatus: 200,
      statlockerPatchId: 'patch-1',
      rulesetVersion: 'rules-v1',
      catalogSha256: 'a'.repeat(64),
      collectorVersion: 'collector-v2',
      rawPayload: { stable: true },
    });

    expect(row).toBe(existing);
    expect(repository.findOne).toHaveBeenCalledWith({
      where: { contentSha256: existing.contentSha256 },
    });
    expect(repository.create).not.toHaveBeenCalled();
    expect(repository.insert).not.toHaveBeenCalled();
    expect(repository.update).not.toHaveBeenCalled();
  });

  it('re-stamps and re-ingests an unchanged payload when the catalog moved on', async () => {
    // The relational rows carry the identity they were ingested under, and
    // queryWpa filters on it. An unchanged statlocker payload combined with a new
    // catalog therefore has to be ingested again, or the rows stay invisible and
    // the recommendation silently loses its matchup evidence - which is exactly
    // what happened on 2026-09-17, when all 173 496 rows were still stamped
    // client-6686 / 052d9e97 while the live identity was client-6694 / f5226f2e.
    const existing = {
      snapshotId: 'b'.repeat(64),
      contentSha256: 'b'.repeat(64),
      fetchedAt: new Date('2026-09-09T10:00:00.000Z'),
      sourcePath: '/old-path',
      sourceStatus: 200,
      statlockerPatchId: 'patch-1',
      rulesetVersion: 'client-6686',
      catalogSha256: 'a'.repeat(64),
      collectorVersion: 'collector-v1',
      rawPayload: { stable: true },
      ingestStatus: 'PUBLISHED',
      ingestMetadata: { publicationId: 'dataset-1' },
      createdAt: new Date('2026-09-09T10:00:00.000Z'),
    } as StatlockerVsHeroWpaRawSnapshotV1Entity;
    const repository = {
      create: jest.fn((row) => row),
      findOne: jest.fn().mockResolvedValue(existing),
      insert: jest.fn(),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    const store = new StatlockerVsHeroWpaRawStoreV1Service(repository as never);
    jest.spyOn(store, 'contentSha256').mockReturnValue(existing.contentSha256);

    const row = await store.persist({
      fetchedAt: '2026-09-17T18:00:00.000Z',
      sourcePath: '/new-path',
      sourceStatus: 200,
      statlockerPatchId: 'patch-1',
      rulesetVersion: 'client-6694',
      catalogSha256: 'c'.repeat(64),
      collectorVersion: 'collector-v2',
      rawPayload: { stable: true },
    });

    expect(repository.update).toHaveBeenCalledWith(
      { snapshotId: existing.snapshotId },
      expect.objectContaining({
        rulesetVersion: 'client-6694',
        catalogSha256: 'c'.repeat(64),
        ingestStatus: 'PENDING',
      }),
    );
    expect(row.rulesetVersion).toBe('client-6694');
    expect(row.catalogSha256).toBe('c'.repeat(64));
    expect(row.ingestStatus).toBe('PENDING');
    expect(row.snapshotId).toBe(existing.snapshotId);
    expect(repository.insert).not.toHaveBeenCalled();
  });

  it('re-stamps when only the catalog changed', async () => {
    const existing = {
      snapshotId: 'b'.repeat(64),
      contentSha256: 'b'.repeat(64),
      fetchedAt: new Date('2026-09-09T10:00:00.000Z'),
      sourcePath: '/old-path',
      sourceStatus: 200,
      statlockerPatchId: 'patch-1',
      rulesetVersion: 'client-6694',
      catalogSha256: 'a'.repeat(64),
      collectorVersion: 'collector-v1',
      rawPayload: { stable: true },
      ingestStatus: 'PUBLISHED',
      ingestMetadata: {},
      createdAt: new Date('2026-09-09T10:00:00.000Z'),
    } as StatlockerVsHeroWpaRawSnapshotV1Entity;
    const repository = {
      create: jest.fn((row) => row),
      findOne: jest.fn().mockResolvedValue(existing),
      insert: jest.fn(),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    const store = new StatlockerVsHeroWpaRawStoreV1Service(repository as never);
    jest.spyOn(store, 'contentSha256').mockReturnValue(existing.contentSha256);

    const row = await store.persist({
      fetchedAt: '2026-09-17T18:00:00.000Z',
      sourcePath: '/new-path',
      sourceStatus: 200,
      statlockerPatchId: 'patch-1',
      rulesetVersion: 'client-6694',
      catalogSha256: 'c'.repeat(64),
      collectorVersion: 'collector-v2',
      rawPayload: { stable: true },
    });

    expect(repository.update).toHaveBeenCalledTimes(1);
    expect(row.ingestStatus).toBe('PENDING');
  });
});
