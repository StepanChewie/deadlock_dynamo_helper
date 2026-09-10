import { createRecommendationItemGraph } from '@deadlock-live-probe/build-domain';
import { BuildArchetypeQualityGateV2Service } from '../src/statlocker-adaptive/build-archetype-quality-gate-v2.service';
import { BuildArchetypeSnapshotStoreV2Service } from '../src/statlocker-adaptive/build-archetype-snapshot-store-v2.service';
import { BuildArchetypeSnapshotV2, BuildArchetypeV2 } from '../src/statlocker-adaptive/build-archetype-v2';

const CATALOG_SHA = 'a'.repeat(64);
const graph = createRecommendationItemGraph([
  { itemId: 1, name: 'Core', slotType: 'weapon', active: false, availableRulesetIds: ['r1'], directPurchaseCost: 800, upgradeRecipes: [] },
  { itemId: 2, name: 'Followup', slotType: 'vitality', active: false, availableRulesetIds: ['r1'], directPurchaseCost: 1600, upgradeRecipes: [] },
]);

function archetype(heroId = 72): BuildArchetypeV2 {
  return {
    archetypeId: `archetype:${heroId}:core`,
    heroId,
    rulesetVersion: 'r1',
    catalogSha256: CATALOG_SHA,
    statlockerPatchId: 'patch-1',
    sourceProfileAccountIds: ['p1', 'p2', 'p3'],
    items: [
      {
        itemId: 1,
        familyId: 1,
        role: 'CORE',
        sourceProfileCount: 3,
        profileCoverage: 1,
        purchaseRate: 0.9,
        timing: { medianBuyTimeS: 300, spreadS: 20, phase: 'EARLY' },
        structuralPriority: 0.95,
      },
      {
        itemId: 2,
        familyId: 2,
        role: 'FREQUENT',
        sourceProfileCount: 3,
        profileCoverage: 1,
        purchaseRate: 0.8,
        timing: { medianBuyTimeS: 700, spreadS: 40, phase: 'MID' },
        structuralPriority: 0.85,
      },
    ],
    groups: [],
    orderEdges: [{ beforeItemId: 1, afterItemId: 2, confidence: 1, sourceProfileCount: 3, strength: 'HARD' }],
    relationships: [],
    quality: { support: 1, coherence: 0.9, separation: 0.3, sourceProfileCount: 3 },
  };
}

function snapshot(snapshotId: string, heroId = 72): BuildArchetypeSnapshotV2 {
  return {
    snapshotId,
    heroId,
    rulesetVersion: 'r1',
    catalogSha256: CATALOG_SHA,
    statlockerPatchId: 'patch-1',
    generatedAt: '2026-09-10T00:00:00.000Z',
    sourceProfileAccountIds: ['p1', 'p2', 'p3'],
    archetypes: [archetype(heroId)],
  };
}

function matches(row: any, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, value]) => row[key] === value);
}

function persistence() {
  const rows: any[] = [];
  let failNextSave = false;
  const repository = {
    create: jest.fn((value: any) => ({ ...value })),
    save: jest.fn(async (value: any) => {
      if (failNextSave) {
        failNextSave = false;
        throw new Error('simulated persistence failure');
      }
      const index = rows.findIndex((row) => row.snapshotId === value.snapshotId);
      if (index >= 0) rows[index] = { ...value };
      else rows.push({ ...value });
      return value;
    }),
    update: jest.fn(async (where: any, patch: any) => {
      for (const row of rows) {
        if (matches(row, where)) Object.assign(row, patch);
      }
      return { affected: rows.filter((row) => matches(row, where)).length };
    }),
    findOne: jest.fn(async (options: any) => {
      const candidates = rows.filter((row) => matches(row, options?.where ?? {}));
      candidates.sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime());
      return candidates[0];
    }),
  };
  const manager = { getRepository: jest.fn(() => repository) };
  const dataSource = {
    getRepository: jest.fn(() => repository),
    transaction: jest.fn(async (callback: (manager: any) => Promise<unknown>) => {
      const before = rows.map((row) => ({ ...row }));
      try {
        return await callback(manager);
      } catch (error) {
        rows.splice(0, rows.length, ...before);
        throw error;
      }
    }),
  } as any;
  return {
    rows,
    dataSource,
    failNextSave: () => { failNextSave = true; },
  };
}

describe('BuildArchetypeSnapshotStoreV2Service', () => {
  const gate = new BuildArchetypeQualityGateV2Service();

  it('publishes a gate-approved snapshot and returns the active payload', async () => {
    const db = persistence();
    const store = new BuildArchetypeSnapshotStoreV2Service(db.dataSource);
    const value = snapshot('snapshot-1');
    const quality = gate.evaluate(value, graph);

    await store.publishValidated(value, quality, new Date('2026-09-10T12:00:00.000Z'));

    expect(db.rows).toHaveLength(1);
    expect(db.rows[0]).toMatchObject({
      snapshotId: 'snapshot-1',
      heroId: 72,
      rulesetVersion: 'r1',
      statlockerPatchId: 'patch-1',
      catalogSha256: CATALOG_SHA,
      isActive: true,
      sourceProfileCount: 3,
    });
    await expect(store.getActive({
      heroId: 72,
      rulesetVersion: 'r1',
      statlockerPatchId: 'patch-1',
      catalogSha256: CATALOG_SHA,
    })).resolves.toEqual(value);
  });

  it('keeps the previous active snapshot when a rejected replacement is offered', async () => {
    const db = persistence();
    const store = new BuildArchetypeSnapshotStoreV2Service(db.dataSource);
    const first = snapshot('snapshot-1');
    await store.publishValidated(first, gate.evaluate(first, graph));

    const rejected = snapshot('snapshot-rejected');
    rejected.archetypes[0].items.forEach((item) => {
      (item as { role: 'FLEX' }).role = 'FLEX';
    });
    const rejectedQuality = gate.evaluate(rejected, graph);
    expect(rejectedQuality.accepted).toBe(false);

    await expect(store.publishValidated(rejected, rejectedQuality)).rejects.toThrow('quality gate rejected');
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0]).toMatchObject({ snapshotId: 'snapshot-1', isActive: true });
  });

  it('rolls back old-snapshot deactivation when insertion fails', async () => {
    const db = persistence();
    const store = new BuildArchetypeSnapshotStoreV2Service(db.dataSource);
    const first = snapshot('snapshot-1');
    await store.publishValidated(first, gate.evaluate(first, graph));

    const second = snapshot('snapshot-2');
    db.failNextSave();
    await expect(store.publishValidated(second, gate.evaluate(second, graph))).rejects.toThrow('simulated persistence failure');

    expect(db.rows).toHaveLength(1);
    expect(db.rows[0]).toMatchObject({ snapshotId: 'snapshot-1', isActive: true });
  });

  it('replaces only the exact hero/ruleset/patch/catalog scope', async () => {
    const db = persistence();
    const store = new BuildArchetypeSnapshotStoreV2Service(db.dataSource);
    const hero72v1 = snapshot('hero72-v1', 72);
    const hero73 = snapshot('hero73-v1', 73);
    const hero72v2 = snapshot('hero72-v2', 72);

    await store.publishValidated(hero72v1, gate.evaluate(hero72v1, graph));
    await store.publishValidated(hero73, gate.evaluate(hero73, graph));
    await store.publishValidated(hero72v2, gate.evaluate(hero72v2, graph));

    expect(db.rows.find((row) => row.snapshotId === 'hero72-v1')?.isActive).toBe(false);
    expect(db.rows.find((row) => row.snapshotId === 'hero73-v1')?.isActive).toBe(true);
    expect(db.rows.find((row) => row.snapshotId === 'hero72-v2')?.isActive).toBe(true);
  });
});
