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

  it('returns an existing content identity without mutating or reinserting it', async () => {
    const existing = {
      snapshotId: 'b'.repeat(64),
      contentSha256: 'b'.repeat(64),
      fetchedAt: new Date('2026-09-09T10:00:00.000Z'),
      sourcePath: '/old-path',
      sourceStatus: 200,
      statlockerPatchId: 'old-patch',
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
    };
    const store = new StatlockerVsHeroWpaRawStoreV1Service(repository as never);
    jest.spyOn(store, 'contentSha256').mockReturnValue(existing.contentSha256);

    const row = await store.persist({
      fetchedAt: '2026-09-09T11:00:00.000Z',
      sourcePath: '/new-path',
      sourceStatus: 200,
      statlockerPatchId: 'new-patch',
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
  });
});
