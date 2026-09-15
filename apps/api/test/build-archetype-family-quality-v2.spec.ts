import { createRecommendationItemGraph } from '@dynamo-lab/build-domain';
import {
  BuildArchetypeFamilyV2,
  BuildArchetypeSnapshotV2,
  BuildArchetypeV2,
} from '../src/statlocker-adaptive/build-archetype-v2';
import { BuildArchetypeQualityGateV2Service } from '../src/statlocker-adaptive/build-archetype-quality-gate-v2.service';

function family(familyId: number, requirement: BuildArchetypeFamilyV2['requirement'] = 'REQUIRED'): BuildArchetypeFamilyV2 {
  return {
    familyId,
    requirement,
    aggregateFrequencyTier: requirement === 'REQUIRED' ? 'CORE' : 'FREQUENT',
    sourceProfileCount: 2,
    profileCoverage: 1,
    purchaseRate: 0.9,
    structuralPriority: 0.9,
    progressionNodes: [{
      itemId: familyId,
      rawFrequencyTier: requirement === 'REQUIRED' ? 'CORE' : 'FREQUENT',
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
      rawFrequencyTier: requirement === 'REQUIRED' ? 'CORE' : 'FREQUENT',
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
      role: entry.requirement === 'REQUIRED' ? 'CORE' as const : 'FREQUENT' as const,
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

function graphForItemIds(itemIds: readonly number[]) {
  return createRecommendationItemGraph(
    [...new Set(itemIds)].map((itemId) => ({
      itemId,
      name: `item-${itemId}`,
      slotType: 'weapon' as const,
      active: true,
      availableRulesetIds: ['r1'],
      directPurchaseCost: 500,
      upgradeRecipes: [],
    })),
    [],
  );
}

describe('BuildArchetypeQualityGateV2Service family contracts', () => {
  const gate = new BuildArchetypeQualityGateV2Service();

  it('rejects a family contract whose minimum terminal occupancy exceeds 12 slots', () => {
    const families = Array.from({ length: 13 }, (_, index) => family(1000 + index));
    const result = gate.evaluate(snapshot(archetype(families)), graphForItemIds(families.map((entry) => entry.familyId)));

    expect(result.accepted).toBe(false);
    expect(result.reasonCodes).toContain('TERMINAL_CAPACITY_CONFLICT');
  });

  it('accepts eight required families plus two one-of-two choice groups within capacity', () => {
    const required = Array.from({ length: 8 }, (_, index) => family(1100 + index));
    const choices = [family(1200, 'OPTIONAL'), family(1201, 'OPTIONAL'), family(1202, 'OPTIONAL'), family(1203, 'OPTIONAL')];
    const value = archetype([...required, ...choices]);
    value.groups = [
      {
        groupId: 'choice:a',
        type: 'CHOICE',
        candidateFamilyIds: [1200, 1201],
        candidateItemIds: [1200, 1201],
        minSelect: 1,
        maxSelect: 1,
        source: 'STATLOCKER_EXPLICIT',
        confidence: 1,
      },
      {
        groupId: 'choice:b',
        type: 'CHOICE',
        candidateFamilyIds: [1202, 1203],
        candidateItemIds: [1202, 1203],
        minSelect: 1,
        maxSelect: 1,
        source: 'STATLOCKER_EXPLICIT',
        confidence: 1,
      },
    ];

    const result = gate.evaluate(snapshot(value), graphForItemIds([...required, ...choices].map((entry) => entry.familyId)));

    expect(result.accepted).toBe(true);
    expect(result.reasonCodes).not.toContain('TERMINAL_CAPACITY_CONFLICT');
  });

  it('rejects duplicate family IDs', () => {
    const duplicate = family(1300);
    const result = gate.evaluate(snapshot(archetype([duplicate, duplicate])), graphForItemIds([1300]));

    expect(result.accepted).toBe(false);
    expect(result.reasonCodes).toContain('DUPLICATE_SEMANTIC_FAMILY');
  });

  it('rejects a family with no default terminal', () => {
    const invalid: BuildArchetypeFamilyV2 = { ...family(1400), terminalCandidates: [] };
    const result = gate.evaluate(snapshot(archetype([invalid])), graphForItemIds([1400]));

    expect(result.accepted).toBe(false);
    expect(result.reasonCodes).toContain('FAMILY_DEFAULT_TERMINAL_MISSING');
  });

  it('rejects a family whose declared terminal is unknown to the item graph', () => {
    const invalid = family(1500);
    const result = gate.evaluate(snapshot(archetype([invalid])), graphForItemIds([1599]));

    expect(result.accepted).toBe(false);
    expect(result.reasonCodes).toContain('FAMILY_TERMINAL_UNKNOWN_ITEM');
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
    const result = gate.evaluate(snapshot(archetype([invalid])), graphForItemIds([2000, 2999]));

    expect(result.accepted).toBe(false);
    expect(result.reasonCodes).toContain('FAMILY_TERMINAL_NOT_OBSERVED');
  });

  it('rejects invalid CHOICE bounds', () => {
    const value = archetype([family(3000, 'OPTIONAL'), family(3001, 'OPTIONAL')]);
    value.groups = [{
      groupId: 'choice:invalid',
      type: 'CHOICE',
      candidateFamilyIds: [3000, 3001],
      candidateItemIds: [3000, 3001],
      minSelect: 2,
      maxSelect: 1,
      source: 'STATLOCKER_EXPLICIT',
      confidence: 1,
    }];

    const result = gate.evaluate(snapshot(value), graphForItemIds([3000, 3001]));

    expect(result.accepted).toBe(false);
    expect(result.reasonCodes).toContain('INVALID_GROUP_BOUNDS');
  });

  it('rejects CHOICE groups that reference an unknown family', () => {
    const value = archetype([family(3100, 'OPTIONAL')]);
    value.groups = [{
      groupId: 'choice:unknown-family',
      type: 'CHOICE',
      candidateFamilyIds: [3100, 3199],
      candidateItemIds: [3100],
      minSelect: 1,
      maxSelect: 1,
      source: 'STATLOCKER_EXPLICIT',
      confidence: 1,
    }];

    const result = gate.evaluate(snapshot(value), graphForItemIds([3100]));

    expect(result.accepted).toBe(false);
    expect(result.reasonCodes).toContain('GROUP_UNKNOWN_FAMILY');
  });
});
