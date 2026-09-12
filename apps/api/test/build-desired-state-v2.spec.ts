import {
  BuildArchetypeFamilyV2,
  BuildArchetypeV2,
} from '../src/statlocker-adaptive/build-archetype-v2';
import { BuildDesiredStateV2Service } from '../src/statlocker-adaptive/build-desired-state-v2.service';
import { StatlockerVsHeroWpaAggregateSourceV1 } from '../src/statlocker-adaptive/statlocker-vs-hero-wpa-repository-v1.service';
import { ThreatWeightedMatchupV1Service } from '../src/statlocker-adaptive/threat-weighted-matchup-v1.service';

function family(
  familyId: number,
  defaultItemId: number,
  optionalItemId?: number,
  requirement: BuildArchetypeFamilyV2['requirement'] = 'REQUIRED',
): BuildArchetypeFamilyV2 {
  return {
    familyId,
    requirement,
    aggregateFrequencyTier: requirement === 'REQUIRED' ? 'CORE' : 'FREQUENT',
    sourceProfileCount: 10,
    profileCoverage: requirement === 'REQUIRED' ? 1 : 0.7,
    purchaseRate: requirement === 'REQUIRED' ? 0.95 : 0.65,
    structuralPriority: requirement === 'REQUIRED' ? 1 : 0.65,
    progressionNodes: [
      {
        itemId: defaultItemId,
        rawFrequencyTier: requirement === 'REQUIRED' ? 'CORE' : 'FREQUENT',
        progressionRole: 'DEFAULT_TERMINAL',
        sourceProfileCount: 10,
        profileCoverage: requirement === 'REQUIRED' ? 1 : 0.7,
        purchaseRate: requirement === 'REQUIRED' ? 0.95 : 0.65,
        timing: { medianBuyTimeS: 900, spreadS: 60, phase: 'MID' },
      },
      ...(optionalItemId === undefined ? [] : [{
        itemId: optionalItemId,
        rawFrequencyTier: 'SOMETIMES' as const,
        progressionRole: 'OPTIONAL_TERMINAL' as const,
        sourceProfileCount: 3,
        profileCoverage: 0.3,
        purchaseRate: 0.12,
        timing: { medianBuyTimeS: 1_800, spreadS: 120, phase: 'LATE' as const },
      }]),
    ],
    terminalCandidates: [
      {
        itemId: defaultItemId,
        kind: 'DEFAULT_TERMINAL',
        sourceProfileCount: 10,
        profileCoverage: requirement === 'REQUIRED' ? 1 : 0.7,
        purchaseRate: requirement === 'REQUIRED' ? 0.95 : 0.65,
        rawFrequencyTier: requirement === 'REQUIRED' ? 'CORE' : 'FREQUENT',
      },
      ...(optionalItemId === undefined ? [] : [{
        itemId: optionalItemId,
        kind: 'OPTIONAL_TERMINAL' as const,
        sourceProfileCount: 3,
        profileCoverage: 0.3,
        purchaseRate: 0.12,
        rawFrequencyTier: 'SOMETIMES' as const,
      }]),
    ],
  };
}

function archetype(
  families: readonly BuildArchetypeFamilyV2[],
  groups: BuildArchetypeV2['groups'] = [],
): BuildArchetypeV2 {
  return {
    archetypeId: 'archetype:test',
    heroId: 72,
    rulesetVersion: 'r1',
    catalogSha256: 'a'.repeat(64),
    statlockerPatchId: 'p1',
    sourceProfileAccountIds: Array.from({ length: 10 }, (_, index) => `p${index + 1}`),
    families,
    items: families.map((entry) => ({
      itemId: entry.terminalCandidates.find((candidate) => candidate.kind === 'DEFAULT_TERMINAL')!.itemId,
      familyId: entry.familyId,
      role: entry.requirement === 'REQUIRED' ? 'CORE' as const : 'FREQUENT' as const,
      sourceProfileCount: 10,
      profileCoverage: entry.profileCoverage,
      purchaseRate: entry.purchaseRate,
      timing: { medianBuyTimeS: 900, spreadS: 60, phase: 'MID' as const },
      structuralPriority: entry.structuralPriority,
    })),
    groups,
    orderEdges: [],
    relationships: [],
    quality: { support: 1, coherence: 0.9, separation: 0.5, sourceProfileCount: 10 },
  };
}

function wpa(itemId: number, deltaWpa: number, count = 10_000): StatlockerVsHeroWpaAggregateSourceV1 {
  return { heroId: 72, enemyHeroId: 6, itemId, deltaWpa, count };
}

function resolve(
  value: BuildArchetypeV2,
  rows: readonly StatlockerVsHeroWpaAggregateSourceV1[],
  totalCapacity = 12,
) {
  return new BuildDesiredStateV2Service(new ThreatWeightedMatchupV1Service()).resolve({
    heroId: 72,
    archetype: value,
    totalCapacity,
    enemyHeroIds: [6],
    enemyThreats: [],
    vsHeroRows: rows,
  });
}

describe('BuildDesiredStateV2Service', () => {
  it('keeps the default terminal when optional-terminal WPA improvement is weak', () => {
    const value = archetype([family(1000, 101, 102)]);

    const result = resolve(value, [wpa(101, 0.05), wpa(102, 0.055)]);

    expect(result.families).toHaveLength(1);
    expect(result.families[0]).toMatchObject({
      familyId: 1000,
      selectedTerminalItemId: 101,
      selectedTerminalKind: 'DEFAULT_TERMINAL',
    });
    expect(result.families[0].reasonCodes).toContain('DEFAULT_TERMINAL_SELECTED');
  });

  it('promotes a Statlocker-observed optional terminal when exact-enemy WPA improvement is strong and confident', () => {
    const value = archetype([family(1000, 101, 102)]);

    const result = resolve(value, [wpa(101, 0), wpa(102, 0.12)]);

    expect(result.families[0]).toMatchObject({
      familyId: 1000,
      selectedTerminalItemId: 102,
      selectedTerminalKind: 'OPTIONAL_TERMINAL',
    });
    expect(result.families[0].reasonCodes).toContain('OPTIONAL_TERMINAL_WPA_SELECTED');
  });

  it('selects only the required number of CHOICE families by exact-enemy WPA', () => {
    const left = family(2000, 201, undefined, 'OPTIONAL');
    const right = family(2001, 202, undefined, 'OPTIONAL');
    const value = archetype([left, right], [{
      groupId: 'choice:defense',
      type: 'CHOICE',
      candidateFamilyIds: [2000, 2001],
      candidateItemIds: [201, 202],
      minSelect: 1,
      maxSelect: 1,
      source: 'STATLOCKER_EXPLICIT',
      confidence: 1,
    }]);

    const result = resolve(value, [wpa(201, -0.04), wpa(202, 0.1)]);

    expect(result.selectedChoiceFamilyIdsByGroup['choice:defense']).toEqual([2001]);
    expect(result.families).toHaveLength(1);
    expect(result.families[0]).toMatchObject({
      familyId: 2001,
      requirement: 'CHOICE',
      groupId: 'choice:defense',
      selectedTerminalItemId: 202,
    });
  });

  it('fills remaining capacity with Statlocker-backed optional families even when WPA is below the buy-improvement floor', () => {
    const required = Array.from({ length: 8 }, (_, index) => family(3000 + index, 4000 + index));
    const choiceLeft = family(3100, 4100, undefined, 'OPTIONAL');
    const choiceRight = family(3101, 4101, undefined, 'OPTIONAL');
    const optional = [
      family(3200, 4200, undefined, 'OPTIONAL'),
      family(3201, 4201, undefined, 'OPTIONAL'),
      family(3202, 4202, undefined, 'SITUATIONAL'),
      family(3203, 4203, undefined, 'SITUATIONAL'),
    ];
    const value = archetype([...required, choiceLeft, choiceRight, ...optional], [{
      groupId: 'choice:one',
      type: 'CHOICE',
      candidateFamilyIds: [3100, 3101],
      candidateItemIds: [4100, 4101],
      minSelect: 1,
      maxSelect: 1,
      source: 'STATLOCKER_EXPLICIT',
      confidence: 1,
    }]);
    const rows = [
      wpa(4100, -0.01),
      wpa(4101, 0.08),
      wpa(4200, 0.12),
      wpa(4201, 0.10),
      wpa(4202, 0.005),
      wpa(4203, -0.05),
    ];

    const result = resolve(value, rows, 12);
    const selectedFamilyIds = new Set(result.families.map((entry) => entry.familyId));

    for (const entry of required) expect(selectedFamilyIds.has(entry.familyId)).toBe(true);
    expect(result.selectedChoiceFamilyIdsByGroup['choice:one']).toEqual([3101]);
    expect(selectedFamilyIds.has(3200)).toBe(true);
    expect(selectedFamilyIds.has(3201)).toBe(true);
    expect(selectedFamilyIds.has(3202)).toBe(true);
    expect(selectedFamilyIds.has(3203)).toBe(false);
    expect(result.families).toHaveLength(12);
    expect(result.reasonCodes).not.toContain('DESIRED_STATE_UNDER_CAPACITY');
  });
});
