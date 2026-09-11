import {
  BuildArchetypeFamilyV2,
  BuildArchetypeSnapshotV2,
  BuildArchetypeV2,
} from '../src/statlocker-adaptive/build-archetype-v2';
import { BuildArchetypeSelectorV2Service } from '../src/statlocker-adaptive/build-archetype-selector-v2.service';
import { StatlockerVsHeroWpaAggregateSourceV1 } from '../src/statlocker-adaptive/statlocker-vs-hero-wpa-repository-v1.service';

function family(familyId: number, terminalItemId: number): BuildArchetypeFamilyV2 {
  return {
    familyId,
    requirement: 'REQUIRED',
    aggregateFrequencyTier: 'CORE',
    sourceProfileCount: 2,
    profileCoverage: 1,
    purchaseRate: 0.9,
    structuralPriority: 1,
    progressionNodes: [
      {
        itemId: familyId,
        rawFrequencyTier: 'CORE',
        progressionRole: familyId === terminalItemId ? 'DEFAULT_TERMINAL' : 'ENTRY',
        sourceProfileCount: 2,
        profileCoverage: 1,
        purchaseRate: 0.9,
        timing: { medianBuyTimeS: 300, spreadS: 20, phase: 'EARLY' },
      },
      ...(familyId === terminalItemId ? [] : [{
        itemId: terminalItemId,
        rawFrequencyTier: 'FREQUENT' as const,
        progressionRole: 'DEFAULT_TERMINAL' as const,
        sourceProfileCount: 2,
        profileCoverage: 1,
        purchaseRate: 0.8,
        timing: { medianBuyTimeS: 900, spreadS: 30, phase: 'MID' as const },
      }]),
    ],
    terminalCandidates: [{
      itemId: terminalItemId,
      kind: 'DEFAULT_TERMINAL',
      sourceProfileCount: 2,
      profileCoverage: 1,
      purchaseRate: 0.8,
      rawFrequencyTier: terminalItemId === familyId ? 'CORE' : 'FREQUENT',
    }],
  };
}

function archetype(id: string, familyValue: BuildArchetypeFamilyV2): BuildArchetypeV2 {
  return {
    archetypeId: id,
    heroId: 72,
    rulesetVersion: 'r1',
    catalogSha256: 'a'.repeat(64),
    statlockerPatchId: 'p1',
    sourceProfileAccountIds: ['p1', 'p2'],
    families: [familyValue],
    items: [{
      itemId: familyValue.familyId,
      familyId: familyValue.familyId,
      role: 'CORE',
      sourceProfileCount: 2,
      profileCoverage: 1,
      purchaseRate: 0.9,
      timing: { medianBuyTimeS: 300, spreadS: 20, phase: 'EARLY' },
      structuralPriority: 1,
    }],
    groups: [],
    orderEdges: [],
    relationships: [],
    quality: { support: 0.5, coherence: 0.9, separation: 0.4, sourceProfileCount: 2 },
  };
}

function wpa(itemId: number, deltaWpa: number): StatlockerVsHeroWpaAggregateSourceV1 {
  return {
    heroId: 72,
    enemyHeroId: 6,
    itemId,
    count: 10_000,
    deltaWpa,
  };
}

describe('BuildArchetypeSelectorV2Service family terminals', () => {
  it('scores the Statlocker-backed default terminal instead of the legacy representative item', () => {
    const misleadingRepresentative = archetype('archetype:a', family(100, 101));
    const betterTerminal = archetype('archetype:b', family(200, 200));
    const snapshot: BuildArchetypeSnapshotV2 = {
      snapshotId: 'snapshot:test',
      heroId: 72,
      rulesetVersion: 'r1',
      catalogSha256: 'a'.repeat(64),
      statlockerPatchId: 'p1',
      generatedAt: '2026-09-11T00:00:00.000Z',
      sourceProfileAccountIds: ['p1', 'p2'],
      archetypes: [misleadingRepresentative, betterTerminal],
    };

    const result = new BuildArchetypeSelectorV2Service().select({
      heroId: 72,
      enemyHeroIds: [6],
      snapshot,
      vsHeroRows: [
        wpa(100, 0.5),
        wpa(101, -0.2),
        wpa(200, 0.1),
      ],
    });

    expect(result.mode).toBe('VS_HERO_WPA');
    expect(result.archetypeId).toBe('archetype:b');
  });
});
