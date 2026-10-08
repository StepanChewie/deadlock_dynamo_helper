import { StatlockerRefreshService } from '../src/statlocker-adaptive/statlocker-refresh.service';

type RefreshServiceConstructor = new (
  collector: unknown,
  normalizer: unknown,
  store: unknown,
  skeleton?: unknown,
  catalogVersionRepo?: unknown,
  rawVsHeroWpaStore?: unknown,
  rowNormalizer?: unknown,
  publisher?: unknown,
) => StatlockerRefreshService;

const RefreshService = StatlockerRefreshService as unknown as RefreshServiceConstructor;

const IDENTITY = { rulesetVersion: 'client-1', catalogSha256: 'a'.repeat(64) };
const HOUR_MS = 60 * 60 * 1000;

function activePatchRow(statlockerPatchId: string, fetchedAt: string) {
  return {
    dataset: 'T4_CHAINS',
    scopeKey: 'global',
    statlockerPatchId,
    rulesetVersion: IDENTITY.rulesetVersion,
    catalogSha256: IDENTITY.catalogSha256,
    fetchedAt: new Date(fetchedAt),
  };
}

function makeService(activeRows: () => unknown[], collected: string[][]) {
  const collector = {
    collectBatch: jest.fn(async (targets: Array<{ dataset: string }>) => {
      collected.push(targets.map((target) => target.dataset));
      return {
        statlockerPatchId: 'patch-old',
        fetchedAt: '2026-10-07T16:00:00.000Z',
        datasets: [],
        failures: [],
      };
    }),
  };
  const store = { publish: jest.fn(), listActive: jest.fn(() => activeRows()) };
  const service = new RefreshService(collector, {}, store);
  service.observeGameIdentity(IDENTITY);
  return service;
}

// The matchup rows are read with a strict patch match and no cross-patch fallback, so a
// patch rollover leaves the matchup term out of every build until VS_HERO_WPA is fetched
// again for the new patch. Keying that dataset by the resolved patch is what makes the
// rollover re-arm it, instead of waiting out the whole 24 h cadence.
describe('Statlocker refresh - VS_HERO_WPA follows the resolved patch', () => {
  it('re-arms the matchup dataset when the resolved patch changes, and nothing else', async () => {
    let rows = [activePatchRow('patch-old', '2026-10-07T16:00:00.000Z')];
    const collected: string[][] = [];
    const service = makeService(() => rows, collected);

    // Nothing has succeeded yet, so the first tick is due for every dataset.
    await service.refreshGlobalNow(false);
    expect(collected[0]).toEqual(['WPA_PATCH_DATA', 'VS_HERO_WPA', 'T4_CHAINS']);

    // Same patch on the next tick: each dataset has just succeeded, so none is due.
    await service.refreshGlobalNow(false);
    expect(collected).toHaveLength(1);

    // The game rolls. Only the matchup dataset re-arms: the 258 MB WPA_PATCH_DATA keeps
    // its daily cadence and T4_CHAINS keeps its own 30 minute one.
    rows = [activePatchRow('patch-new', '2026-10-07T17:00:00.000Z')];
    await service.refreshGlobalNow(false);
    expect(collected).toHaveLength(2);
    expect(collected[1]).toEqual(['VS_HERO_WPA']);
  });

  it('keeps the daily cadence for the matchup dataset while the patch is unchanged', async () => {
    const rows = [activePatchRow('patch-old', '2026-10-07T16:00:00.000Z')];
    const collected: string[][] = [];
    const service = makeService(() => rows, collected);

    const start = Date.parse('2026-10-07T16:00:00.000Z');
    await service.refreshGlobalNow(false, start);
    // 23 h later: T4_CHAINS is due again on its own 30 minute cadence, but the matchup
    // dataset must still be inside its 24 h window.
    await service.refreshGlobalNow(false, start + 23 * HOUR_MS);

    expect(collected).toEqual([
      ['WPA_PATCH_DATA', 'VS_HERO_WPA', 'T4_CHAINS'],
      ['T4_CHAINS'],
    ]);
  });

  it('falls back to the identity-only key when no patch can be resolved', async () => {
    const collected: string[][] = [];
    const service = makeService(() => [], collected);

    const start = Date.parse('2026-10-07T16:00:00.000Z');
    await service.refreshGlobalNow(false, start);
    await service.refreshGlobalNow(false, start + 5 * 60 * 1000);

    // No patch to key on means no extra re-arming - the old behaviour, not a hot loop.
    expect(collected).toHaveLength(1);
  });
});
