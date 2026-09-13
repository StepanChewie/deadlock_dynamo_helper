import { BuildArchetypeFamilyV2, BuildArchetypeV2 } from '../src/statlocker-adaptive/build-archetype-v2';
import { BuildDesiredStateV2Service } from '../src/statlocker-adaptive/build-desired-state-v2.service';
import { StatlockerVsHeroWpaAggregateSourceV1 } from '../src/statlocker-adaptive/statlocker-vs-hero-wpa-repository-v1.service';
import { ThreatWeightedMatchupV1Service } from '../src/statlocker-adaptive/threat-weighted-matchup-v1.service';

function situationalFamily(familyId: number, itemId: number): BuildArchetypeFamilyV2 {
  return {
    familyId,
    requirement: 'SITUATIONAL',
    aggregateFrequencyTier: 'SOMETIMES',
    sourceProfileCount: 4,
    profileCoverage: 0.4,
    purchaseRate: 0.2,
    structuralPriority: 0.2,
    progressionNodes: [{
      itemId,
      rawFrequencyTier: 'SOMETIMES',
      progressionRole: 'DEFAULT_TERMINAL',
      sourceProfileCount: 4,
      profileCoverage: 0.4,
      purchaseRate: 0.2,
      timing: { medianBuyTimeS: 1_200, spreadS: 120, phase: 'MID' },
    }],
    terminalCandidates: [{
      itemId,
      kind: 'DEFAULT_TERMINAL',
      sourceProfileCount: 4,
      profileCoverage: 0.4,
      purchaseRate: 0.2,
      rawFrequencyTier: 'SOMETIMES',
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
    sourceProfileAccountIds: ['p1', 'p2', 'p3', 'p4'],
    families,
    items: families.map((family) => ({
      itemId: family.progressionNodes[0].itemId,
      familyId: family.familyId,
      role: 'SITUATIONAL',
      sourceProfileCount: family.sourceProfileCount,
      profileCoverage: family.profileCoverage,
      purchaseRate: family.purchaseRate,
      timing: family.progressionNodes[0].timing,
      structuralPriority: family.structuralPriority,
    })),
    groups: [],
    orderEdges: [],
    relationships: [],
    quality: { support: 1, coherence: 0.9, separation: 0.5, sourceProfileCount: 4 },
  };
}

describe('BuildDesiredStateV2Service evidence ranking', () => {
  it('includes only the matchup-supported situational goal without a capacity competition', () => {
    const evidencedFamily = situationalFamily(1001, 101);
    const unsupportedFamily = situationalFamily(1002, 102);
    const rows: StatlockerVsHeroWpaAggregateSourceV1[] = [{
      heroId: 72,
      enemyHeroId: 6,
      itemId: 101,
      deltaWpa: 0.05,
      count: 10_000,
    }];

    const result = new BuildDesiredStateV2Service(new ThreatWeightedMatchupV1Service()).resolve({
      heroId: 72,
      archetype: archetype([evidencedFamily, unsupportedFamily]),
      enemyHeroIds: [6],
      enemyThreats: [],
      vsHeroRows: rows,
    });

    expect(result.families).toHaveLength(1);
    expect(result.families[0]).toMatchObject({
      familyId: 1001,
      goalKind: 'SITUATIONAL_MATCHUP_SELECTED',
    });
    expect(result.families[0].confidence).toBeGreaterThan(0);
  });
});
