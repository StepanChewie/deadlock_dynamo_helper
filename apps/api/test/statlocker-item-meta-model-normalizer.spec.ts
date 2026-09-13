import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { StatlockerNormalizerService } from '../src/statlocker-adaptive/statlocker-normalizer.service';

interface ExpectedLifecycleFixture {
  heroId: number;
  heroName: string;
  patchId: string;
  sourcePath: string;
  items: readonly {
    itemId: number;
    itemName: string;
    generalWpa: number;
    averagePurchaseTimeS: number;
    sampleSize: number;
  }[];
}

function loadJson(name: string): unknown {
  return JSON.parse(readFileSync(
    join(__dirname, 'fixtures/statlocker-item-meta-model', name),
    'utf8',
  ));
}

function loadExpected(): ExpectedLifecycleFixture {
  return loadJson('billy.expected.json') as ExpectedLifecycleFixture;
}

describe('Statlocker Item Meta Model lifecycle normalization', () => {
  const normalizer = new StatlockerNormalizerService();

  it('reproduces captured Billy general WPA and average purchase time for canonical item ids', () => {
    const raw = loadJson('billy.raw.json');
    const expected = loadExpected();

    const normalized = normalizer.normalizeWpaFilteredItems(
      raw,
      expected.patchId,
      expected.heroId,
    );

    expect(normalized.dataset).toBe('WPA_FILTERED_ITEMS');
    expect(normalized.scopeKey).toBe(`hero:${expected.heroId}`);
    expect(normalized.statlockerPatchId).toBe(expected.patchId);
    expect(normalized.payload.heroId).toBe(expected.heroId);
    expect(normalized.payload.items).toEqual(expect.arrayContaining(
      expected.items.map((item) => ({
        heroId: expected.heroId,
        itemId: item.itemId,
        generalWpa: item.generalWpa,
        averagePurchaseTimeS: item.averagePurchaseTimeS,
        sampleSize: item.sampleSize,
      })),
    ));
  });

  it('does not derive lifecycle evidence from dormant phase-WPA or median-purchase fields', () => {
    const raw = loadJson('billy.raw.json') as { items: Record<string, unknown>[] };
    const expected = loadExpected();
    const poisoned = structuredClone(raw);
    Object.assign(poisoned.items[0], {
      earlyWpa: 999,
      midWpa: 999,
      lateWpa: 999,
      laneWpa: 999,
      postLaneWpa: 999,
      median_purchase_time_s: 1,
    });

    const normalized = normalizer.normalizeWpaFilteredItems(
      poisoned,
      expected.patchId,
      expected.heroId,
    );
    const first = normalized.payload.items.find((item) => item.itemId === expected.items[0].itemId);

    expect(first).toEqual({
      heroId: expected.heroId,
      itemId: expected.items[0].itemId,
      generalWpa: expected.items[0].generalWpa,
      averagePurchaseTimeS: expected.items[0].averagePurchaseTimeS,
      sampleSize: expected.items[0].sampleSize,
    });
  });
});
