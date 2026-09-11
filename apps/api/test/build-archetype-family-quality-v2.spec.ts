import { createRecommendationItemGraph } from '@deadlock-live-probe/build-domain';
import {
  BuildArchetypeFamilyV2,
  BuildArchetypeSnapshotV2,
  BuildArchetypeV2,
} from '../src/statlocker-adaptive/build-archetype-v2';
import { BuildArchetypeQualityGateV2Service } from '../src/statlocker-adaptive/build-archetype-quality-gate-v2.service';

function family(familyId: number): BuildArchetypeFamilyV2 {
  return {
    familyId,
    requirement: 'REQUIRED',
    aggregateFrequencyTier: 'CORE',
    sourceProfileCount: 2,
    profileCoverage: 1,
    purchaseRate: 0.9,
    structuralPriority: 0.9,
    progressionNodes: [{
      itemId: familyId,
      rawFrequencyTier: 'CORE',
      progressionRole: 'DEFAULT_TERMINAL',
      sourceProfileCount: 2,
      profileCoverage: 1,
      purchaseRate: 0.9,
      timing: { medianBuyTimeS: 600, spreadS: 30, phase: 'MID' },
    }],
    terminalCandidates: [{
      itemId: familyId,
      kind: 'DEFAULT_TERMINAL',
      sourceProfileCount: 2,
      profileCoverage: 1,
      purchaseRate: 0.9,
      rawFrequencyTier: 'CORE',
    }],
  };
}

function archetype(families: readonly BuildArchetypeFamilyV2[]): BuildArchetypeV2 {
  return {
    archetypeId: 'archetype:test',
    heroId: 72,
    rulesetVersion: 'r1',
    catalogSha256: 'a'.repeat(64),
    statlockerPatchId: 'p1',
    sourceProfileAccountIds: ['p1', 'p2'],
    families,
    items: families.map((entry) => ({
      itemId: entry.familyId,
      familyId: entry.familyId,
      role: 'CORE' as const,
      sourceProfileCount: 2,
      profileCoverage: 1,
      purchaseRate: 0.9,
      timing: { medianBuyTimeS: 600, spreadS: 30, phase: 'MID' as const },
      structuralPriority: 0.9,
    })),
    groups: [],
    orderEdges: [],
    relationships: [],
    quality: { support: 1, coherence: 0.9, separation: 0.5, sourceProfileCount: 2 },
  };
}

function snapshot(value: BuildArchetypeV2): BuildArchetypeSnapshotV2 {
  return {
    snapshotId: 'snapshot:test',
    heroId: 72,
    rulesetVersion: 'r1',
    catalogSha256: 'a'.repeat(64),
    statlockerPatchId: 'p1',
    generatedAt: '2026-09-11T00:00:00.000Z',
    sourceProfileAccountIds: ['p1', 'p2'],
    archetypes: [value],
  };
}

describe('BuildArchetypeQualityGateV2Service family contracts', () => {
  it('rejects a family contract whose minimum terminal occupancy exceeds 12 slots', () => {
    const families = Array.from({ length: 13 }, (_, index) => family(1000 + index));
    const graph = createRecommendationItemGraph(
      families.map((entry) => ({
        itemId: entry.familyId,
        name: `item-${entry.familyId}`,
        slotType: 'weapon' as const,
        active: true,
        availableRulesetIds: ['r1'],
        directPurchaseCost: 500,
        upgradeRecipes: [],
      })),
      [],
    );

    const result = new BuildArchetypeQualityGateV2Service().evaluate(snapshot(archetype(families)), graph);

    expect(result.accepted).toBe(false);
    expect(result.reasonCodes).toContain('TERMINAL_CAPACITY_CONFLICT');
  });

  it('rejects a family whose declared terminal was not observed by Statlocker', () => {
    const value = family(2000);
    const invalid: BuildArchetypeFamilyV2 = {
      ...value,
      terminalCandidates: [{
        ...value.terminalCandidates[0],
        itemId: 2999,
      }],
    };
    const graph = createRecommendationItemGraph([
      {
        itemId: 2000,
        name: 'observed',
        slotType: 'weapon',
        active: true,
        availableRulesetIds: ['r1'],
        directPurchaseCost: 500,
        upgradeRecipes: [],
      },
      {
        itemId: 2999,
        name: 'catalog-only',
        slotType: 'weapon',
        active: true,
        availableRulesetIds: ['r1'],
        directPurchaseCost: 1250,
        upgradeRecipes: [],
      },
    ], []);

    const result = new BuildArchetypeQualityGateV2Service().evaluate(snapshot(archetype([invalid])), graph);

    expect(result.accepted).toBe(false);
    expect(result.reasonCodes).toContain('FAMILY_TERMINAL_NOT_OBSERVED');
  });
});
