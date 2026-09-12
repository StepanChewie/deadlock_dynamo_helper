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
  medianBuyTimeS = 900,
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
        timing: { medianBuyTimeS, spreadS: 60, phase: 'MID' },
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
  flexGoalCapacity?: number,
) {
  return new BuildDesiredStateV2Service(new ThreatWeightedMatchupV1Service()).resolve({
    heroId: 72,
    archetype: value,
    enemyHeroIds: [6],
    enemyThreats: [],
    vsHeroRows: rows,
    ...(flexGoalCapacity === undefined ? {} : { flexGoalCapacity }),
  });
}

describe('BuildDesiredStateV2Service', () => {
  it('keeps the default terminal when optional-terminal WPA improvement is weak', () => {
    const value = archetype([family(1000, 101, 102)]);

    const result = resolve(value, [wpa(101, 0.05), wpa(102, 0.055)]);

    expect(result.families).toHaveLength(1);
    expect(result.families[0]).toMatchObject({
      familyId: 1000,
      goalKind: 'REQUIRED',
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
      goalKind: 'REQUIRED',
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
      goalKind: 'CHOICE_SELECTED',
      groupId: 'choice:defense',
      selectedTerminalItemId: 202,
    });
  });

  it('keeps all OPTIONAL goals and only matchup-supported SITUATIONAL goals', () => {
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

    const result = resolve(value, rows);
    const selectedFamilyIds = new Set(result.families.map((entry) => entry.familyId));

    for (const entry of required) expect(selectedFamilyIds.has(entry.familyId)).toBe(true);
    expect(result.selectedChoiceFamilyIdsByGroup['choice:one']).toEqual([3101]);
    expect(selectedFamilyIds.has(3200)).toBe(true);
    expect(selectedFamilyIds.has(3201)).toBe(true);
    expect(selectedFamilyIds.has(3202)).toBe(true);
    expect(selectedFamilyIds.has(3203)).toBe(false);
    expect(result.families).toHaveLength(12);
  });

  it('keeps more than 12 eligible lifetime goals instead of truncating them to inventory capacity', () => {
    const required = Array.from({ length: 10 }, (_, index) => family(5000 + index, 6000 + index));
    const optional = Array.from({ length: 4 }, (_, index) => family(5100 + index, 6100 + index, undefined, 'OPTIONAL'));

    const result = resolve(archetype([...required, ...optional]), []);

    expect(result.families).toHaveLength(14);
    expect(result.families.map((entry) => entry.familyId)).toEqual([
      ...required.map((entry) => entry.familyId),
      ...optional.map((entry) => entry.familyId),
    ]);
    expect(result.reasonCodes).not.toContain('DESIRED_STATE_CAPACITY_LIMITED');
  });

  it('excludes a SITUATIONAL goal when configured matchup confidence is insufficient', () => {
    const situational = family(7000, 7100, undefined, 'SITUATIONAL');

    const result = resolve(archetype([situational]), []);

    expect(result.families).toEqual([]);
  });

  it('includes a SITUATIONAL goal with sufficient configured matchup evidence', () => {
    const situational = family(7200, 7300, undefined, 'SITUATIONAL');

    const result = resolve(archetype([situational]), [wpa(7300, 0.1)]);

    expect(result.families).toHaveLength(1);
    expect(result.families[0]).toMatchObject({
      familyId: 7200,
      requirement: 'SITUATIONAL',
      goalKind: 'SITUATIONAL_MATCHUP_SELECTED',
    });
  });

  it('appends provisional flex goals up to the requested visible capacity without displacing primary goals', () => {
    const required = family(6000, 6001);
    const passing = family(6100, 6101, undefined, 'SITUATIONAL');
    const weakEvidence = family(6200, 6201, undefined, 'SITUATIONAL', 2_200);
    const negativeWpa = family(6300, 6301, undefined, 'SITUATIONAL', 1_500);
    const value = archetype([required, passing, weakEvidence, negativeWpa]);

    // weakEvidence has no rows (confidence 0); negativeWpa has confident rows
    // but negative matchup WPA, so both fail the SITUATIONAL gate yet remain
    // real captured families eligible for the provisional flex fill. Flex
    // order follows purchase time: 6300 (1500s) before 6200 (2200s).
    const result = resolve(
      value,
      [wpa(6101, 0.1), wpa(6301, -0.05)],
      4,
    );

    expect(result.families).toHaveLength(4);
    expect(result.families.slice(0, 2).map((entry) => entry.goalKind)).toEqual([
      'REQUIRED',
      'SITUATIONAL_MATCHUP_SELECTED',
    ]);
    const flex = result.families.slice(2);
    expect(flex.map((entry) => entry.familyId)).toEqual([6300, 6200]);
    expect(flex.map((entry) => entry.goalKind)).toEqual(['FLEX_PROVISIONAL', 'FLEX_PROVISIONAL']);
    expect(flex.map((entry) => entry.selectedTerminalKind)).toEqual(['DEFAULT_TERMINAL', 'DEFAULT_TERMINAL']);
    for (const entry of flex) {
      expect(entry.reasonCodes).toContain('FLEX_PROVISIONAL_FILL');
    }
  });

  it('never appends flex goals when primary goals already cover the visible capacity', () => {
    const required = [1, 2, 3].map((index) => family(6500 + index, 6600 + index));
    const value = archetype(required);

    const result = resolve(value, [], 2);

    expect(result.families).toHaveLength(3);
    expect(result.families.every((entry) => entry.goalKind === 'REQUIRED')).toBe(true);
  });

  it('treats the flex capacity as a floor target only and never truncates primary goals', () => {
    const required = [1, 2, 3, 4, 5].map((index) => family(6700 + index, 6800 + index));
    const value = archetype(required);

    const result = resolve(value, [], 3);

    expect(result.families).toHaveLength(5);
    expect(result.families.every((entry) => entry.goalKind === 'REQUIRED')).toBe(true);
  });

  it('appends no flex goals when no flex capacity is requested', () => {
    const required = family(6900, 6901);
    const weakEvidence = family(7000, 7001, undefined, 'SITUATIONAL');
    const value = archetype([required, weakEvidence]);

    const result = resolve(value, []);

    expect(result.families).toHaveLength(1);
    expect(result.families[0].goalKind).toBe('REQUIRED');
  });
});
