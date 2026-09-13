import { StatlockerItemLifecycleRepositoryV1Service } from '../src/statlocker-adaptive/statlocker-item-lifecycle-repository-v1.service';

const identity = {
  rulesetVersion: 'ruleset-a',
  catalogSha256: 'a'.repeat(64),
};

function snapshot(overrides: Record<string, unknown>): any {
  return {
    rulesetVersion: identity.rulesetVersion,
    catalogSha256: identity.catalogSha256,
    fetchedAt: new Date('2026-09-01T12:00:00.000Z'),
    ...overrides,
  };
}

function createHarness(storeRows: any[]) {
  const store: any = {
    listActive: jest.fn(() => storeRows),
    getActive: jest.fn((lookup: any) => storeRows.find((row) =>
      row.dataset === lookup.dataset &&
      row.rulesetVersion === lookup.rulesetVersion &&
      row.catalogSha256 === lookup.catalogSha256 &&
      row.statlockerPatchId === lookup.statlockerPatchId &&
      row.scopeKey === lookup.scopeKey,
    )),
  };
  return { store, repository: new StatlockerItemLifecycleRepositoryV1Service(store) };
}

describe('StatlockerItemLifecycleRepositoryV1Service', () => {
  const lifecyclePayload = {
    heroId: 6,
    items: [
      { heroId: 6, itemId: 805079544, generalWpa: 0.049, averagePurchaseTimeS: 734.4, sampleSize: 3651 },
      { heroId: 6, itemId: 951866250, generalWpa: 0.052, averagePurchaseTimeS: 1977.1, sampleSize: 563 },
    ],
  };

  it('loads current-patch lifecycle evidence for one hero', async () => {
    const h = createHarness([
      snapshot({ dataset: 'WPA_PATCH_DATA', statlockerPatchId: '15-1', scopeKey: 'patch:current' }),
      snapshot({ dataset: 'WPA_FILTERED_ITEMS', statlockerPatchId: '15-1', scopeKey: 'hero:6', payload: lifecyclePayload }),
    ]);

    await expect(h.repository.loadCurrentPatchForHero({
      heroId: 6,
      rulesetVersion: identity.rulesetVersion,
      catalogSha256: identity.catalogSha256,
    })).resolves.toEqual(lifecyclePayload.items);
  });

  it('does not return lifecycle evidence captured for an older patch', async () => {
    const h = createHarness([
      snapshot({ dataset: 'WPA_PATCH_DATA', statlockerPatchId: '15-1', scopeKey: 'patch:current' }),
      snapshot({ dataset: 'WPA_FILTERED_ITEMS', statlockerPatchId: '14-9', scopeKey: 'hero:6', payload: lifecyclePayload }),
    ]);

    await expect(h.repository.loadCurrentPatchForHero({
      heroId: 6,
      rulesetVersion: identity.rulesetVersion,
      catalogSha256: identity.catalogSha256,
    })).resolves.toEqual([]);
  });

  it('returns no evidence when the current patch identity is unknown', async () => {
    const h = createHarness([
      snapshot({ dataset: 'WPA_FILTERED_ITEMS', statlockerPatchId: '15-1', scopeKey: 'hero:6', payload: lifecyclePayload }),
    ]);

    await expect(h.repository.loadCurrentPatchForHero({
      heroId: 6,
      rulesetVersion: identity.rulesetVersion,
      catalogSha256: identity.catalogSha256,
    })).resolves.toEqual([]);
  });

  it('rejects lifecycle payloads from a different hero scope', async () => {
    const h = createHarness([
      snapshot({ dataset: 'WPA_PATCH_DATA', statlockerPatchId: '15-1', scopeKey: 'patch:current' }),
      snapshot({ dataset: 'WPA_FILTERED_ITEMS', statlockerPatchId: '15-1', scopeKey: 'hero:6', payload: lifecyclePayload }),
    ]);

    await expect(h.repository.loadCurrentPatchForHero({
      heroId: 10,
      rulesetVersion: identity.rulesetVersion,
      catalogSha256: identity.catalogSha256,
    })).resolves.toEqual([]);
  });
});
