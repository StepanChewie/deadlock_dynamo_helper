import { StatlockerRefreshService } from '../src/statlocker-adaptive/statlocker-refresh.service';
import { statlockerV1Fixtures } from './fixtures/statlocker-v1';

const identity = {
  rulesetVersion: 'ruleset-a',
  catalogSha256: 'a'.repeat(64),
};

const EXPECTED_STATLOCKER_HERO_POOL = [
  1, 2, 3, 4, 6, 7, 8, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
  25, 27, 31, 35, 50, 52, 58, 60, 63, 64, 65, 66, 67, 69, 72, 76, 77, 79, 80, 81,
] as const;

function createHarness(options: { observeIdentity?: boolean } = {}) {
  let releaseCollector: (() => void) | undefined;
  let publishSequence = 0;
  const block = { enabled: false };
  const collector = {
    collectBatch: jest.fn(async (targets: readonly any[]) => {
      if (block.enabled) {
        await new Promise<void>((resolve) => { releaseCollector = resolve; });
      }
      return {
        statlockerPatchId: '15-1',
        fetchedAt: '2026-08-31T12:00:00.000Z',
        datasets: targets.map((target) => ({
          ...target,
          path: target.dataset,
          status: 200,
          fetchedAt: '2026-08-31T12:00:00.000Z',
          statlockerPatchId: '15-1',
          data:
            target.dataset === 'WPA_PATCH_DATA' ? statlockerV1Fixtures.patchData :
            target.dataset === 'VS_HERO_WPA' ? statlockerV1Fixtures.vsHero :
            target.dataset === 'T4_CHAINS' ? statlockerV1Fixtures.t4Chains :
            target.dataset === 'HERO_LEADERBOARD' ? statlockerV1Fixtures.leaderboard :
            target.dataset === 'PRO_BUILD_ANALYSIS' ? statlockerV1Fixtures.proBuild :
            statlockerV1Fixtures.filteredItems,
        })),
      };
    }),
  };
  const normalizer = {
    normalizeWpaPatchData: jest.fn(() => ({ dataset: 'WPA_PATCH_DATA', scopeKey: 'patch:15-1', statlockerPatchId: '15-1', contentSha256: '1'.repeat(64), payload: { patchId: '15-1', items: [] } })),
    normalizeVsHeroWpa: jest.fn(() => ({ dataset: 'VS_HERO_WPA', scopeKey: 'global', statlockerPatchId: '15-1', contentSha256: '2'.repeat(64), payload: { slices: [] } })),
    normalizeT4Chains: jest.fn(() => ({ dataset: 'T4_CHAINS', scopeKey: 'global', statlockerPatchId: '15-1', contentSha256: '3'.repeat(64), payload: { chains: [] } })),
    normalizeHeroLeaderboard: jest.fn((_: unknown, __: string, heroId: number) => ({
      dataset: 'HERO_LEADERBOARD',
      scopeKey: `hero:${heroId}`,
      statlockerPatchId: '15-1',
      contentSha256: `${heroId}`.padStart(64, '0').slice(-64),
      payload: { heroId, profiles: [{ accountId: '101', heroId, rank: 1 }] },
    })),
    normalizeProBuildAnalysis: jest.fn((_: unknown, __: string, accountId: string, heroId: number) => ({
      dataset: 'PRO_BUILD_ANALYSIS',
      scopeKey: `hero:${heroId}:account:${accountId}`,
      statlockerPatchId: '15-1',
      contentSha256: `${heroId}${accountId}`.padStart(64, '0').slice(-64),
      payload: { accountId, heroId, items: [] },
    })),
  };
  const active = new Map<string, any>();
  const publish = jest.fn(async (input: any): Promise<any> => {
    const key = [input.dataset, input.rulesetVersion, input.catalogSha256, input.statlockerPatchId, input.scopeKey].join('|');
    const current = active.get(key);
    if (current?.contentSha256 === input.contentSha256) {
      current.fetchedAt = input.fetchedAt;
      return current;
    }
    publishSequence += 1;
    const saved: any = { ...input, snapshotId: `snapshot-${publishSequence}` };
    active.set(key, saved);
    return saved;
  });
  const store: any = {
    publish,
    getActive: jest.fn((lookup: any) => active.get([
      lookup.dataset,
      lookup.rulesetVersion,
      lookup.catalogSha256,
      lookup.statlockerPatchId,
      lookup.scopeKey,
    ].join('|'))),
    listActive: jest.fn(() => [...active.values()]),
  };
  const versionRepo = {
    find: jest.fn().mockResolvedValue([{
      rulesetKey: identity.rulesetVersion,
      payloadSha256: identity.catalogSha256,
      importedAt: new Date('2026-09-01T00:00:00.000Z'),
      catalogVersionId: 'catalog-a',
    }]),
  };
  let rawSnapshotSequence = 0;
  const rawVsHeroWpaStore = {
    persistCollected: jest.fn(async (input: any) => {
      rawSnapshotSequence += 1;
      return {
        snapshotId: `raw-snapshot-${rawSnapshotSequence}`,
        ingestStatus: 'PENDING',
        statlockerPatchId: input.statlockerPatchId,
      };
    }),
  };
  const vsHeroWpaRowNormalizer = {
    normalize: jest.fn(() => [
      { heroId: 10, enemyHeroId: 20, itemId: 1, count: 10, deltaWpa: 0.02, rankBucket: 'rank_8' },
    ]),
  };
  const vsHeroWpaPublisher = {
    publish: jest.fn(async (input: any) => ({ snapshotId: input.snapshotId, rowCount: input.rows.length })),
    markFailed: jest.fn(async () => undefined),
  };
  const service = new (StatlockerRefreshService as any)(
    collector,
    normalizer,
    store,
    undefined,
    versionRepo,
    rawVsHeroWpaStore,
    vsHeroWpaRowNormalizer,
    vsHeroWpaPublisher,
  ) as StatlockerRefreshService;
  if (options.observeIdentity !== false) service.observeGameIdentity(identity, 1_000);

  return {
    service,
    collector,
    normalizer,
    store,
    active,
    versionRepo,
    block,
    rawVsHeroWpaStore,
    vsHeroWpaRowNormalizer,
    vsHeroWpaPublisher,
    release: () => releaseCollector?.(),
  };
}

describe('StatlockerRefreshService', () => {
  it('gates global refresh by TTL', async () => {
    const h = createHarness();
    await h.service.refreshGlobalNow(false, 1_000);
    await h.service.refreshGlobalNow(false, 1_001);
    expect(h.collector.collectBatch).toHaveBeenCalledTimes(1);

    // Repeated scheduler ticks inside the 24h VS_HERO_WPA TTL never re-fetch the
    // large endpoint; the smaller global datasets keep their own 30 minute cadence,
    // but only the elapsed 24h TTL re-arms the daily VS_HERO_WPA target.
    await h.service.refreshGlobalNow(false, 1_000 + 23 * 60 * 60_000);
    const vsHeroTargets = () => h.collector.collectBatch.mock.calls
      .flatMap(([targets]) => targets)
      .filter((target: any) => target.dataset === 'VS_HERO_WPA');
    expect(vsHeroTargets()).toHaveLength(1);

    await h.service.refreshGlobalNow(false, 1_000 + 24 * 60 * 60_000 + 1);
    expect(vsHeroTargets()).toHaveLength(2);
  });

  it('uses single-flight for the same global identity', async () => {
    const h = createHarness();
    h.block.enabled = true;
    const first = h.service.refreshGlobalNow(true, 1_000);
    const second = h.service.refreshGlobalNow(true, 1_000);
    expect(h.collector.collectBatch).toHaveBeenCalledTimes(1);
    h.release();
    await Promise.all([first, second]);
  });

  it('preserves published snapshots when a later refresh fails', async () => {
    const h = createHarness();
    await h.service.refreshGlobalNow(true, 1_000);
    const before = [...h.active.values()].map((entry) => entry.snapshotId);
    h.collector.collectBatch.mockRejectedValueOnce(new Error('collector failed'));

    await expect(h.service.refreshGlobalNow(true, 2_000)).rejects.toThrow('collector failed');
    expect([...h.active.values()].map((entry) => entry.snapshotId)).toEqual(before);
  });

  it('enqueueHeroRefresh is fire-and-forget and records active hero scope', () => {
    const h = createHarness();
    h.block.enabled = true;
    expect(h.service.enqueueHeroRefresh(10, 1_000)).toBeUndefined();
    expect(h.service.getStatus().activeHeroIds).toEqual([10]);
    h.release();
  });

  it('keeps duplicate normalized content on the same active snapshots', async () => {
    const h = createHarness();
    await h.service.refreshGlobalNow(true, 1_000);
    const snapshotIdsAfterFirst = [...h.active.values()].map((entry) => entry.snapshotId).sort();

    await h.service.refreshGlobalNow(true, 2_000);

    expect([...h.active.values()].map((entry) => entry.snapshotId).sort()).toEqual(snapshotIdsAfterFirst);
  });

  it('walks the complete current Statlocker hero pool without active-player observations', async () => {
    const h = createHarness();
    const startMs = Date.parse('2026-09-01T00:00:00.000Z');

    for (let index = 0; index < EXPECTED_STATLOCKER_HERO_POOL.length; index += 1) {
      await h.service.scheduledTick(startMs + index * 60_000);
    }

    const leaderboardHeroIds = h.collector.collectBatch.mock.calls
      .flatMap(([targets]) => targets)
      .filter((target: any) => target.dataset === 'HERO_LEADERBOARD')
      .map((target: any) => target.heroId);

    expect(leaderboardHeroIds).toEqual(EXPECTED_STATLOCKER_HERO_POOL);
  });

  it('refreshes hero data before the two-day freshness deadline', async () => {
    const h = createHarness();
    const startMs = Date.parse('2026-09-01T00:00:00.000Z');
    await h.service.refreshHeroNow(6, false, startMs);
    h.collector.collectBatch.mockClear();

    await h.service.refreshHeroNow(6, false, startMs + (35 * 60 * 60_000));
    expect(h.collector.collectBatch).not.toHaveBeenCalled();

    await h.service.refreshHeroNow(6, false, startMs + (37 * 60 * 60_000));
    expect(h.collector.collectBatch).toHaveBeenCalled();
  });

  it('bootstraps collection identity from the latest serving catalog when no recommendation was served', async () => {
    const h = createHarness({ observeIdentity: false });
    const nowMs = Date.parse('2026-09-01T00:00:00.000Z');

    await h.service.scheduledTick(nowMs);

    expect(h.versionRepo.find).toHaveBeenCalledWith({
      order: { importedAt: 'DESC', catalogVersionId: 'DESC' },
      take: 1,
    });
    expect(h.service.getStatus().identity).toEqual(identity);
    const leaderboardTargets = h.collector.collectBatch.mock.calls
      .flatMap(([targets]) => targets)
      .filter((target: any) => target.dataset === 'HERO_LEADERBOARD');
    expect(leaderboardTargets).toHaveLength(1);
  });
});
