import { createRecommendationItemGraph } from '@dynamo-lab/build-domain';
import { BuildArchetypeQualityGateV2Service } from '../src/statlocker-adaptive/build-archetype-quality-gate-v2.service';
import { BuildArchetypeSnapshotV2, BuildArchetypeV2 } from '../src/statlocker-adaptive/build-archetype-v2';

const CATALOG_SHA = 'a'.repeat(64);
const graph = createRecommendationItemGraph([
  { itemId: 1, name: 'A', slotType: 'weapon', active: false, availableRulesetIds: ['r1'], directPurchaseCost: 800, upgradeRecipes: [] },
  { itemId: 2, name: 'B', slotType: 'vitality', active: false, availableRulesetIds: ['r1'], directPurchaseCost: 1600, upgradeRecipes: [] },
  { itemId: 3, name: 'C', slotType: 'spirit', active: false, availableRulesetIds: ['r1'], directPurchaseCost: 3200, upgradeRecipes: [] },
  { itemId: 4, name: 'D', slotType: 'weapon', active: false, availableRulesetIds: ['r1'], directPurchaseCost: 3200, upgradeRecipes: [] },
]);

function archetype(overrides: Partial<BuildArchetypeV2> = {}): BuildArchetypeV2 {
  return {
    archetypeId: 'archetype:core',
    heroId: 72,
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
      {
        itemId: 3,
        familyId: 3,
        role: 'SITUATIONAL',
        sourceProfileCount: 2,
        profileCoverage: 2 / 3,
        purchaseRate: 0.5,
        timing: { medianBuyTimeS: 1100, spreadS: 60, phase: 'LATE' },
        structuralPriority: 0.55,
      },
    ],
    groups: [],
    orderEdges: [
      { beforeItemId: 1, afterItemId: 2, confidence: 1, sourceProfileCount: 3, strength: 'HARD' },
      { beforeItemId: 2, afterItemId: 3, confidence: 0.75, sourceProfileCount: 3, strength: 'SOFT' },
    ],
    relationships: [],
    quality: { support: 1, coherence: 0.9, separation: 0.3, sourceProfileCount: 3 },
    ...overrides,
  };
}

function snapshot(archetypes: readonly BuildArchetypeV2[] = [archetype()]): BuildArchetypeSnapshotV2 {
  return {
    snapshotId: 'snapshot-1',
    heroId: 72,
    rulesetVersion: 'r1',
    catalogSha256: CATALOG_SHA,
    statlockerPatchId: 'patch-1',
    generatedAt: '2026-09-10T00:00:00.000Z',
    sourceProfileAccountIds: ['p1', 'p2', 'p3'],
    archetypes,
  };
}

describe('BuildArchetypeQualityGateV2Service', () => {
  const gate = new BuildArchetypeQualityGateV2Service();

  it('accepts a coherent multi-profile semantic archetype', () => {
    const result = gate.evaluate(snapshot(), graph);

    expect(result.accepted).toBe(true);
    expect(result.reasonCodes).toEqual([]);
    expect(result.archetypes[0]).toMatchObject({ archetypeId: 'archetype:core', accepted: true });
  });

  it('rejects duplicate semantic families even when item IDs differ', () => {
    const base = archetype();
    const duplicate = {
      ...base.items[1],
      itemId: 4,
      familyId: 1,
    };
    const result = gate.evaluate(snapshot([{ ...base, items: [...base.items, duplicate] }]), graph);

    expect(result.accepted).toBe(false);
    expect(result.reasonCodes).toContain('DUPLICATE_SEMANTIC_FAMILY');
  });

  it('rejects conflicting group membership for the same item', () => {
    const base = archetype();
    const groups = [
      { groupId: 'g1', type: 'CHOICE' as const, candidateItemIds: [2, 3], minSelect: 1, maxSelect: 1, source: 'STATLOCKER_EXPLICIT' as const, confidence: 1 },
      { groupId: 'g2', type: 'OPTIONAL' as const, candidateItemIds: [3], minSelect: 0, maxSelect: 1, source: 'STATLOCKER_EXPLICIT' as const, confidence: 1 },
    ];
    const result = gate.evaluate(snapshot([{ ...base, groups }]), graph);

    expect(result.accepted).toBe(false);
    expect(result.reasonCodes).toContain('CONFLICTING_GROUP_MEMBERSHIP');
  });

  it('rejects invalid group bounds', () => {
    const base = archetype();
    const groups = [
      { groupId: 'g1', type: 'CHOICE' as const, candidateItemIds: [2, 3], minSelect: 2, maxSelect: 3, source: 'STATLOCKER_EXPLICIT' as const, confidence: 1 },
    ];
    const result = gate.evaluate(snapshot([{ ...base, groups }]), graph);

    expect(result.accepted).toBe(false);
    expect(result.reasonCodes).toContain('INVALID_GROUP_BOUNDS');
  });

  it('rejects unknown item IDs', () => {
    const base = archetype();
    const result = gate.evaluate(snapshot([{
      ...base,
      items: [...base.items, { ...base.items[2], itemId: 999, familyId: 999 }],
    }]), graph);

    expect(result.accepted).toBe(false);
    expect(result.reasonCodes).toContain('UNKNOWN_ITEM');
  });

  it('rejects cyclic order graphs instead of silently repairing them', () => {
    const base = archetype();
    const orderEdges = [
      { beforeItemId: 1, afterItemId: 2, confidence: 1, sourceProfileCount: 3, strength: 'HARD' as const },
      { beforeItemId: 2, afterItemId: 3, confidence: 1, sourceProfileCount: 3, strength: 'HARD' as const },
      { beforeItemId: 3, afterItemId: 1, confidence: 1, sourceProfileCount: 3, strength: 'HARD' as const },
    ];
    const result = gate.evaluate(snapshot([{ ...base, orderEdges }]), graph);

    expect(result.accepted).toBe(false);
    expect(result.reasonCodes).toContain('ORDER_GRAPH_CYCLE');
  });

  it('rejects a structurally meaningless flex-only progression', () => {
    const base = archetype();
    const items = base.items.map((item) => ({ ...item, role: 'FLEX' as const, structuralPriority: 0.2 }));
    const result = gate.evaluate(snapshot([{ ...base, items, groups: [] }]), graph);

    expect(result.accepted).toBe(false);
    expect(result.reasonCodes).toContain('MEANINGLESS_PROGRESSION');
  });

  it('rejects an unsupported one-profile archetype', () => {
    const base = archetype({
      sourceProfileAccountIds: ['p1'],
      quality: { support: 0.1, coherence: 1, separation: 1, sourceProfileCount: 1 },
    });
    const result = gate.evaluate(snapshot([base]), graph);

    expect(result.accepted).toBe(false);
    expect(result.reasonCodes).toContain('INSUFFICIENT_SOURCE_PROFILES');
  });
});
