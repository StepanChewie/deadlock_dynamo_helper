import { StatlockerRefreshService } from '../src/statlocker-adaptive/statlocker-refresh.service';

const identity = {
  rulesetVersion: 'ruleset-a',
  catalogSha256: 'a'.repeat(64),
};

function createHarness() {
  let publishSequence = 0;
  const collector = {
    collectBatch: jest.fn(async (targets: readonly any[]) => ({
      statlockerPatchId: '15-1',
      fetchedAt: '2026-09-01T12:00:00.000Z',
      datasets: targets.map((target) => ({
        ...target,
        path: target.dataset,
        status: 200,
        fetchedAt: '2026-09-01T12:00:00.000Z',
        statlockerPatchId: '15-1',
        data: { dataset: target.dataset },
      })),
    })),
  };
  const normalizer = {
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
    normalizeWpaFilteredItems: jest.fn((_: unknown, __: string, heroId: number) => ({
      dataset: 'WPA_FILTERED_ITEMS',
      scopeKey: `hero:${heroId}`,
      statlockerPatchId: '15-1',
      contentSha256: `life${heroId}`.padEnd(64, '0').slice(-64),
      payload: { heroId, items: [] },
    })),
  };
  const active = new Map<string, any>();
  const publish = jest.fn(async (input: any): Promise<any> => {
    const key = [input.dataset, input.rulesetVersion, input.catalogSha256, input.statlockerPatchId, input.scopeKey].join('|');
    publishSequence += 1;
    const saved: any = { ...input, snapshotId: `snapshot-${publishSequence}` };
    active.set(key, saved);
    return saved;
  });
  const store: any = { publish, listActive: jest.fn(() => [...active.values()]) };
  const service = new (StatlockerRefreshService as any)(
    collector,
    normalizer,
    store,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
  ) as StatlockerRefreshService;
  service.observeGameIdentity(identity, 1_000);

  return { service, collector, normalizer, store, active };
}

describe('Statlocker hero item lifecycle refresh', () => {
  it('collects one lifecycle dataset for a due hero alongside existing targets', async () => {
    const h = createHarness();

    await h.service.refreshHeroNow(6, true, 1_000);

    const lifecycleTargets = h.collector.collectBatch.mock.calls
      .flatMap(([targets]) => targets)
      .filter((target: any) => target.dataset === 'WPA_FILTERED_ITEMS');
    expect(lifecycleTargets).toEqual([
      { dataset: 'WPA_FILTERED_ITEMS', scopeKey: 'hero:6', heroId: 6 },
    ]);

    const leaderboardTargets = h.collector.collectBatch.mock.calls
      .flatMap(([targets]) => targets)
      .filter((target: any) => target.dataset === 'HERO_LEADERBOARD');
    expect(leaderboardTargets).toEqual([
      { dataset: 'HERO_LEADERBOARD', scopeKey: 'hero:6', heroId: 6 },
    ]);

    const profileTargets = h.collector.collectBatch.mock.calls
      .flatMap(([targets]) => targets)
      .filter((target: any) => target.dataset === 'PRO_BUILD_ANALYSIS');
    expect(profileTargets).toEqual([
      { dataset: 'PRO_BUILD_ANALYSIS', scopeKey: 'hero:6:account:101', heroId: 6, accountId: '101' },
    ]);
  });

  it('publishes the normalized lifecycle snapshot under the hero scope', async () => {
    const h = createHarness();

    await h.service.refreshHeroNow(6, true, 1_000);

    expect(h.normalizer.normalizeWpaFilteredItems).toHaveBeenCalledTimes(1);
    const published = [...h.active.values()].filter((row) => row.dataset === 'WPA_FILTERED_ITEMS');
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({
      dataset: 'WPA_FILTERED_ITEMS',
      scopeKey: 'hero:6',
      statlockerPatchId: '15-1',
      rulesetVersion: identity.rulesetVersion,
      catalogSha256: identity.catalogSha256,
    });
  });
});
