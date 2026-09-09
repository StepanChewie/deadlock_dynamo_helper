import { StatlockerRefreshService } from '../src/statlocker-adaptive/statlocker-refresh.service';

type RefreshServiceWithRelationalDepsConstructor = new (
  collector: unknown,
  normalizer: unknown,
  store: unknown,
  skeleton?: unknown,
  catalogVersionRepo?: unknown,
  rawVsHeroWpaStore?: unknown,
  rowNormalizer?: unknown,
  publisher?: unknown,
) => StatlockerRefreshService;

const RefreshServiceWithRelationalDeps = StatlockerRefreshService as unknown as RefreshServiceWithRelationalDepsConstructor;

describe('Statlocker VS_HERO_WPA RAW ingest V1', () => {
  it('persists the exact collected RAW payload before normalization and marks it failed when normalization fails', async () => {
    const rawPayload = {
      metadata: { source: 'statlocker' },
      by_patch: { patch_test: { rank_8: { hero_1: {} } } },
    };
    const events: string[] = [];
    let persistedRawPayload: unknown;

    const collector = {
      collectBatch: jest.fn(async () => ({
        statlockerPatchId: 'test',
        fetchedAt: '2026-09-09T10:00:00.000Z',
        datasets: [
          {
            dataset: 'VS_HERO_WPA' as const,
            scopeKey: 'global',
            path: '/api/info/vs-hero-wpa-data',
            status: 200,
            fetchedAt: '2026-09-09T10:00:00.000Z',
            statlockerPatchId: 'test',
            data: rawPayload,
          },
        ],
      })),
    };
    const normalizer = {
      normalizeVsHeroWpa: jest.fn(() => {
        events.push('normalize');
        throw new Error('normalization failed');
      }),
    };
    const normalizedStore = {
      publish: jest.fn(),
      listActive: jest.fn(() => []),
    };
    const rawStore = {
      persistCollected: jest.fn(async (input: { rawPayload: unknown }) => {
        events.push('raw');
        persistedRawPayload = input.rawPayload;
        return { snapshotId: 'snapshot-b' };
      }),
    };
    const rowNormalizer = {
      normalize: jest.fn(),
    };
    const publisher = {
      publish: jest.fn(),
      markFailed: jest.fn(async () => {
        events.push('failed');
      }),
    };

    const service = new RefreshServiceWithRelationalDeps(
      collector,
      normalizer,
      normalizedStore,
      undefined,
      undefined,
      rawStore,
      rowNormalizer,
      publisher,
    );
    service.observeGameIdentity({
      rulesetVersion: 'ruleset-test',
      catalogSha256: 'a'.repeat(64),
    });

    await expect(service.refreshGlobalNow(true)).rejects.toThrow('normalization failed');

    expect(events).toEqual(['raw', 'normalize', 'failed']);
    expect(rawStore.persistCollected).toHaveBeenCalledWith(expect.objectContaining({
      fetchedAt: new Date('2026-09-09T10:00:00.000Z'),
      sourcePath: '/api/info/vs-hero-wpa-data',
      sourceStatus: 200,
      statlockerPatchId: 'test',
      rulesetVersion: 'ruleset-test',
      catalogSha256: 'a'.repeat(64),
      rawPayload,
    }));
    expect(persistedRawPayload).toBe(rawPayload);
    expect(rowNormalizer.normalize).not.toHaveBeenCalled();
    expect(publisher.publish).not.toHaveBeenCalled();
    expect(publisher.markFailed).toHaveBeenCalledWith('snapshot-b', expect.any(Error));
    expect(normalizedStore.publish).not.toHaveBeenCalled();
  });

  it('normalizes and atomically publishes relational rows before publishing the legacy observation', async () => {
    const rawPayload = { by_patch: { patch_test: { by_rank: {} } } };
    const events: string[] = [];
    const normalized = {
      dataset: 'VS_HERO_WPA' as const,
      scopeKey: 'global',
      statlockerPatchId: 'test',
      contentSha256: 'c'.repeat(64),
      payload: { slices: [] },
    };
    const relationalRows = [
      {
        snapshotId: 'snapshot-b',
        statlockerPatchId: 'test',
        rulesetVersion: 'ruleset-test',
        catalogSha256: 'a'.repeat(64),
        rankBucket: 'rank_8',
        heroId: 6,
        enemyHeroId: 77,
        itemId: 123,
        count: 100,
        deltaWpa: 0.01,
        meanWpa: 0.02,
      },
    ];
    const collector = {
      collectBatch: jest.fn(async () => ({
        statlockerPatchId: 'test',
        fetchedAt: '2026-09-09T10:00:00.000Z',
        datasets: [
          {
            dataset: 'VS_HERO_WPA' as const,
            scopeKey: 'global',
            path: '/api/info/vs-hero-wpa-data',
            status: 200,
            fetchedAt: '2026-09-09T10:00:00.000Z',
            statlockerPatchId: 'test',
            data: rawPayload,
          },
        ],
      })),
    };
    const normalizer = {
      normalizeVsHeroWpa: jest.fn(() => {
        events.push('legacy-normalize');
        return normalized;
      }),
    };
    const normalizedStore = {
      publish: jest.fn(async () => {
        events.push('legacy-publish');
      }),
      listActive: jest.fn(() => []),
    };
    const rawStore = {
      persistCollected: jest.fn(async () => {
        events.push('raw');
        return { snapshotId: 'snapshot-b' };
      }),
    };
    const rowNormalizer = {
      normalize: jest.fn(() => {
        events.push('relational-normalize');
        return relationalRows;
      }),
    };
    const publisher = {
      publish: jest.fn(async () => {
        events.push('relational-publish');
      }),
      markFailed: jest.fn(),
    };

    const service = new RefreshServiceWithRelationalDeps(
      collector,
      normalizer,
      normalizedStore,
      undefined,
      undefined,
      rawStore,
      rowNormalizer,
      publisher,
    );
    service.observeGameIdentity({
      rulesetVersion: 'ruleset-test',
      catalogSha256: 'a'.repeat(64),
    });

    await service.refreshGlobalNow(true);

    expect(events).toEqual([
      'raw',
      'legacy-normalize',
      'relational-normalize',
      'relational-publish',
      'legacy-publish',
    ]);
    expect(rowNormalizer.normalize).toHaveBeenCalledWith(rawPayload, {
      snapshotId: 'snapshot-b',
      statlockerPatchId: 'test',
      rulesetVersion: 'ruleset-test',
      catalogSha256: 'a'.repeat(64),
    });
    expect(publisher.publish).toHaveBeenCalledWith({
      snapshotId: 'snapshot-b',
      rows: relationalRows,
    });
    expect(publisher.markFailed).not.toHaveBeenCalled();
  });

  it('marks the RAW snapshot failed and does not publish legacy data when relational normalization fails', async () => {
    const rawPayload = { by_patch: { patch_test: { by_rank: {} } } };
    const collector = {
      collectBatch: jest.fn(async () => ({
        statlockerPatchId: 'test',
        fetchedAt: '2026-09-09T10:00:00.000Z',
        datasets: [
          {
            dataset: 'VS_HERO_WPA' as const,
            scopeKey: 'global',
            path: '/api/info/vs-hero-wpa-data',
            status: 200,
            fetchedAt: '2026-09-09T10:00:00.000Z',
            statlockerPatchId: 'test',
            data: rawPayload,
          },
        ],
      })),
    };
    const normalizer = {
      normalizeVsHeroWpa: jest.fn(() => ({
        dataset: 'VS_HERO_WPA' as const,
        scopeKey: 'global',
        statlockerPatchId: 'test',
        contentSha256: 'c'.repeat(64),
        payload: { slices: [] },
      })),
    };
    const normalizedStore = {
      publish: jest.fn(),
      listActive: jest.fn(() => []),
    };
    const rawStore = {
      persistCollected: jest.fn(async () => ({ snapshotId: 'snapshot-b' })),
    };
    const rowNormalizer = {
      normalize: jest.fn(() => {
        throw new Error('relational normalization failed');
      }),
    };
    const publisher = {
      publish: jest.fn(),
      markFailed: jest.fn(async () => undefined),
    };

    const service = new RefreshServiceWithRelationalDeps(
      collector,
      normalizer,
      normalizedStore,
      undefined,
      undefined,
      rawStore,
      rowNormalizer,
      publisher,
    );
    service.observeGameIdentity({
      rulesetVersion: 'ruleset-test',
      catalogSha256: 'a'.repeat(64),
    });

    await expect(service.refreshGlobalNow(true)).rejects.toThrow('relational normalization failed');

    expect(publisher.markFailed).toHaveBeenCalledWith('snapshot-b', expect.any(Error));
    expect(publisher.publish).not.toHaveBeenCalled();
    expect(normalizedStore.publish).not.toHaveBeenCalled();
  });

  it('refreshes VS_HERO_WPA every 24 hours without slowing other global datasets and force bypasses cadence', async () => {
    const collector = {
      collectBatch: jest.fn(async (_targets: unknown) => ({
        statlockerPatchId: 'test',
        fetchedAt: '2026-09-09T10:00:00.000Z',
        datasets: [],
      })),
    };
    const service = new StatlockerRefreshService(
      collector as never,
      {} as never,
      { listActive: jest.fn(() => []) } as never,
    );
    service.observeGameIdentity({
      rulesetVersion: 'ruleset-test',
      catalogSha256: 'a'.repeat(64),
    });

    await service.refreshGlobalNow(false, 0);
    expect(datasetNames(collector.collectBatch.mock.calls[0]?.[0])).toEqual([
      'WPA_PATCH_DATA',
      'VS_HERO_WPA',
      'T4_CHAINS',
    ]);

    await service.refreshGlobalNow(false, 31 * 60_000);
    expect(datasetNames(collector.collectBatch.mock.calls[1]?.[0])).toEqual([
      'WPA_PATCH_DATA',
      'T4_CHAINS',
    ]);

    await service.refreshGlobalNow(false, 24 * 60 * 60_000 + 1);
    expect(datasetNames(collector.collectBatch.mock.calls[2]?.[0])).toEqual([
      'WPA_PATCH_DATA',
      'VS_HERO_WPA',
      'T4_CHAINS',
    ]);

    await service.refreshGlobalNow(true, 24 * 60 * 60_000 + 60_000);
    expect(datasetNames(collector.collectBatch.mock.calls[3]?.[0])).toEqual([
      'WPA_PATCH_DATA',
      'VS_HERO_WPA',
      'T4_CHAINS',
    ]);
  });
});

function datasetNames(targets: unknown): string[] {
  if (!Array.isArray(targets)) return [];
  return targets.map((target) => {
    if (typeof target !== 'object' || target === null || !('dataset' in target)) return '';
    return String(target.dataset);
  });
}
