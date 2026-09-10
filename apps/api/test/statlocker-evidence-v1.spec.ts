import { StatlockerEvidenceService } from '../src/statlocker-adaptive/statlocker-evidence.service';

const catalogSha256 = 'a'.repeat(64);
const now = Date.parse('2026-08-31T12:00:00.000Z');
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

function row(dataset: string, scopeKey: string, ageMs: number, overrides: Record<string, unknown> = {}) {
  return {
    snapshotId: `${dataset}-${scopeKey}-${ageMs}`,
    dataset,
    rulesetVersion: 'ruleset-a',
    catalogSha256,
    statlockerPatchId: '15-1',
    scopeKey,
    fetchedAt: new Date(now - ageMs),
    contentSha256: 'b'.repeat(64),
    payload: { dataset, scopeKey },
    ...overrides,
  };
}

function structuredConsensusRow(ageMs: number, overrides: Record<string, unknown> = {}) {
  return row('CONSENSUS_SKELETON', 'hero:10:consensus', ageMs, {
    schemaVersion: 'statlocker-consensus-skeleton-v2',
    normalizerVersion: 'consensus-builder-v2',
    payload: {
      heroId: 10,
      profileCount: 6,
      groups: [],
    },
    ...overrides,
  });
}

function service(rows: any[]) {
  const store = { listActive: jest.fn(() => rows) };
  const refresh = {
    observeGameIdentity: jest.fn(),
    observeActiveHero: jest.fn(),
    enqueueHeroRefresh: jest.fn(),
    refreshGlobalNow: jest.fn().mockResolvedValue(undefined),
  };
  return { service: new StatlockerEvidenceService(store as any, refresh as any), refresh };
}

describe('StatlockerEvidenceService', () => {
  it('treats a current structured consensus snapshot as fresh for up to two days', () => {
    const h = service([
      row('WPA_PATCH_DATA', 'patch:15-1', 47 * HOUR),
      row('T4_CHAINS', 'global', 5 * DAY),
      structuredConsensusRow(47 * HOUR),
    ]);
    const bundle = h.service.getEvidence({ heroId: 10, rulesetVersion: 'ruleset-a', catalogSha256, statlockerPatchId: '15-1', nowMs: now });
    expect(bundle.byDataset.WPA_PATCH_DATA.freshness).toBe('FRESH');
    expect(bundle.byDataset.CONSENSUS_SKELETON.freshness).toBe('FRESH');
    expect(bundle.byDataset.CONSENSUS_SKELETON.payload).toEqual(expect.objectContaining({ groups: [] }));
    // VS_HERO_WPA is relational-only since the threat-weighted WPA roadmap: the
    // evidence service no longer serves it from the legacy snapshot store.
    expect(bundle.byDataset.VS_HERO_WPA.freshness).toBe('UNAVAILABLE');
    expect(bundle.byDataset.VS_HERO_WPA.payload).toBeUndefined();
    expect(bundle.byDataset.T4_CHAINS.freshness).toBe('UNAVAILABLE');
    expect(bundle.snapshotIds).toEqual([...bundle.snapshotIds].sort());
  });

  it('marks incompatible ruleset or catalog evidence as PATCH_MISMATCH and excludes payload', () => {
    const h = service([
      row('WPA_PATCH_DATA', 'patch:15-1', 5 * 60_000, { rulesetVersion: 'ruleset-old' }),
      row('T4_CHAINS', 'global', 5 * 60_000, { catalogSha256: 'c'.repeat(64) }),
    ]);
    const bundle = h.service.getEvidence({ heroId: 10, rulesetVersion: 'ruleset-a', catalogSha256, statlockerPatchId: '15-1', nowMs: now });
    expect(bundle.byDataset.WPA_PATCH_DATA.freshness).toBe('PATCH_MISMATCH');
    expect(bundle.byDataset.WPA_PATCH_DATA.payload).toBeUndefined();
    expect(bundle.byDataset.T4_CHAINS.freshness).toBe('PATCH_MISMATCH');
    expect(bundle.byDataset.T4_CHAINS.payload).toBeUndefined();
  });

  it('keeps partial evidence usable when one family is unavailable', () => {
    const h = service([
      row('WPA_PATCH_DATA', 'patch:15-1', 5 * 60_000),
      structuredConsensusRow(5 * 60_000),
    ]);
    const bundle = h.service.getEvidence({ heroId: 10, rulesetVersion: 'ruleset-a', catalogSha256, statlockerPatchId: '15-1', nowMs: now });
    expect(bundle.usable).toBe(true);
    expect(bundle.byDataset.T4_CHAINS.freshness).toBe('UNAVAILABLE');
    expect(bundle.byDataset.WPA_PATCH_DATA.payload).toBeDefined();
    expect(bundle.byDataset.VS_HERO_WPA.payload).toBeUndefined();
    expect(bundle.byDataset.CONSENSUS_SKELETON.payload).toBeDefined();
  });

  it('enqueues hero refresh without awaiting when hero-scoped evidence is missing', () => {
    const h = service([
      row('WPA_PATCH_DATA', 'patch:15-1', 5 * 60_000),
      row('VS_HERO_WPA', 'global', 5 * 60_000),
      row('T4_CHAINS', 'global', 5 * 60_000),
    ]);
    h.service.getEvidence({ heroId: 10, rulesetVersion: 'ruleset-a', catalogSha256, statlockerPatchId: '15-1', nowMs: now });
    expect(h.refresh.enqueueHeroRefresh).toHaveBeenCalledWith(10, now);
  });

  it('reads local evidence without scheduling collection while passively observing the serving scope', () => {
    const h = service([
      row('WPA_PATCH_DATA', 'patch:15-1', 5 * 60_000),
      row('VS_HERO_WPA', 'global', 5 * 60_000),
      structuredConsensusRow(5 * 60_000),
    ]);
    const bundle = h.service.getLocalEvidence({ heroId: 10, rulesetVersion: 'ruleset-a', catalogSha256, statlockerPatchId: '15-1', nowMs: now });
    expect(bundle.usable).toBe(true);
    expect(h.refresh.observeGameIdentity).toHaveBeenCalledWith({ rulesetVersion: 'ruleset-a', catalogSha256 }, now);
    expect(h.refresh.observeActiveHero).toHaveBeenCalledWith(10, now);
    expect(h.refresh.refreshGlobalNow).not.toHaveBeenCalled();
    expect(h.refresh.enqueueHeroRefresh).not.toHaveBeenCalled();
  });

  it('resolves the newest compatible Statlocker minor patch from local snapshots', () => {
    const h = service([
      row('WPA_PATCH_DATA', 'patch:15-0', 20 * 60_000, { statlockerPatchId: '15-0' }),
      row('VS_HERO_WPA', 'global', 5 * 60_000, { statlockerPatchId: '15-1' }),
      row('T4_CHAINS', 'global', 1 * 60_000, { rulesetVersion: 'ruleset-old', statlockerPatchId: '99-9' }),
    ]);
    expect(h.service.resolveLocalPatchId('ruleset-a', catalogSha256)).toBe('15-1');
  });
});
