import { createRecommendationItemGraph } from '@deadlock-live-probe/build-domain';
import { BuildArchetypeV2 } from '../src/statlocker-adaptive/build-archetype-v2';
import { evaluateBuildFamilySatisfactionV2 } from '../src/statlocker-adaptive/build-family-satisfaction-v2';

const A = 101;
const B = 102;
const C = 103;
const D = 104;

function archetype(): BuildArchetypeV2 {
  return {
    archetypeId: 'archetype:test',
    heroId: 72,
    rulesetVersion: 'r1',
    catalogSha256: 'a'.repeat(64),
    statlockerPatchId: 'p1',
    sourceProfileAccountIds: ['p1', 'p2'],
    families: [{
      familyId: A,
      requirement: 'REQUIRED',
      aggregateFrequencyTier: 'CORE',
      sourceProfileCount: 2,
      profileCoverage: 1,
      purchaseRate: 0.95,
      structuralPriority: 1,
      progressionNodes: [
        { itemId: A, rawFrequencyTier: 'CORE', progressionRole: 'ENTRY', sourceProfileCount: 2, profileCoverage: 1, purchaseRate: 0.95, timing: { medianBuyTimeS: 300, spreadS: 20, phase: 'EARLY' } },
        { itemId: B, rawFrequencyTier: 'CORE', progressionRole: 'INTERMEDIATE', sourceProfileCount: 2, profileCoverage: 1, purchaseRate: 0.9, timing: { medianBuyTimeS: 700, spreadS: 30, phase: 'MID' } },
        { itemId: C, rawFrequencyTier: 'FREQUENT', progressionRole: 'DEFAULT_TERMINAL', sourceProfileCount: 2, profileCoverage: 1, purchaseRate: 0.8, timing: { medianBuyTimeS: 1_200, spreadS: 40, phase: 'MID' } },
        { itemId: D, rawFrequencyTier: 'SOMETIMES', progressionRole: 'OPTIONAL_TERMINAL', sourceProfileCount: 1, profileCoverage: 0.5, purchaseRate: 0.1, timing: { medianBuyTimeS: 1_800, spreadS: 80, phase: 'LATE' } },
      ],
      terminalCandidates: [
        { itemId: C, kind: 'DEFAULT_TERMINAL', sourceProfileCount: 2, profileCoverage: 1, purchaseRate: 0.8, rawFrequencyTier: 'FREQUENT' },
        { itemId: D, kind: 'OPTIONAL_TERMINAL', sourceProfileCount: 1, profileCoverage: 0.5, purchaseRate: 0.1, rawFrequencyTier: 'SOMETIMES' },
      ],
    }],
    items: [],
    groups: [],
    orderEdges: [],
    relationships: [],
    quality: { support: 1, coherence: 0.9, separation: 0.5, sourceProfileCount: 2 },
  };
}

function graph() {
  return createRecommendationItemGraph(
    [A, B, C, D].map((itemId) => ({
      itemId,
      name: `item-${itemId}`,
      slotType: 'weapon' as const,
      active: true,
      availableRulesetIds: ['r1'],
      directPurchaseCost: itemId === A ? 500 : undefined,
      upgradeRecipes: [],
    })),
    [
      { parentItemId: B, componentItemId: A },
      { parentItemId: C, componentItemId: B },
      { parentItemId: D, componentItemId: C },
    ],
  );
}

function status(inventoryItemIds: readonly number[]) {
  return evaluateBuildFamilySatisfactionV2(archetype(), inventoryItemIds, graph())[0].status;
}

describe('evaluateBuildFamilySatisfactionV2', () => {
  it('derives family state only from the current inventory', () => {
    expect(status([])).toBe('UNSATISFIED');
    expect(status([B])).toBe('IN_PROGRESS');
    expect(status([C])).toBe('DEFAULT_TERMINAL_SATISFIED');
    expect(status([D])).toBe('OPTIONAL_TERMINAL_SATISFIED');
  });
});
