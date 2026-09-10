import { BuildArchetypeV2, BuildArchetypeSnapshotV2 } from '../src/statlocker-adaptive/build-archetype-v2';
import { BuildArchetypeSelectorV2Service } from '../src/statlocker-adaptive/build-archetype-selector-v2.service';
import { BuildDecisionTraceCollectorV2 } from '../src/statlocker-adaptive/build-decision-trace-v2';
import { StatlockerVsHeroWpaAggregateSourceV1 } from '../src/statlocker-adaptive/statlocker-vs-hero-wpa-repository-v1.service';

const CATALOG_SHA = 'a'.repeat(64);

function archetype(
  archetypeId: string,
  itemId: number,
  support: number,
  coherence: number,
  extraFlexItemIds: readonly number[] = [],
): BuildArchetypeV2 {
  return {
    archetypeId,
    heroId: 72,
    rulesetVersion: 'r1',
    catalogSha256: CATALOG_SHA,
    statlockerPatchId: 'patch-1',
    sourceProfileAccountIds: ['p1', 'p2', 'p3'],
    items: [
      {
        itemId,
        familyId: itemId,
        role: 'CORE',
        sourceProfileCount: 3,
        profileCoverage: 1,
        purchaseRate: 0.95,
        timing: { medianBuyTimeS: 600, spreadS: 60, phase: 'MID' },
        structuralPriority: 1,
      },
      ...extraFlexItemIds.map((flexItemId) => ({
        itemId: flexItemId,
        familyId: flexItemId,
        role: 'FLEX' as const,
        sourceProfileCount: 3,
        profileCoverage: 0.4,
        purchaseRate: 0.4,
        timing: { medianBuyTimeS: 1200, spreadS: 180, phase: 'LATE' as const },
        structuralPriority: 0.2,
      })),
    ],
    groups: [],
    orderEdges: [],
    relationships: [],
    quality: { support, coherence, separation: 0.5, sourceProfileCount: 3 },
  };
}

function snapshot(archetypes: readonly BuildArchetypeV2[]): BuildArchetypeSnapshotV2 {
  return {
    snapshotId: 'snapshot-1',
    heroId: 72,
    rulesetVersion: 'r1',
    catalogSha256: CATALOG_SHA,
    statlockerPatchId: 'patch-1',
    generatedAt: '2026-09-10T00:00:00.000Z',
    sourceProfileAccountIds: ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'],
    archetypes,
  };
}

function wpa(
  enemyHeroId: number,
  itemId: number,
  deltaWpa: number,
  count = 1000,
): StatlockerVsHeroWpaAggregateSourceV1 {
  return { heroId: 72, enemyHeroId, itemId, deltaWpa, count };
}

describe('BuildArchetypeSelectorV2Service', () => {
  const selector = new BuildArchetypeSelectorV2Service();

  it('selects between already-valid archetypes using VS_HERO_WPA only', () => {
    const a = archetype('a', 101, 0.9, 0.95);
    const b = archetype('b', 201, 0.6, 0.85);
    const rows = [
      wpa(10, 101, -0.01),
      wpa(20, 101, 0.00),
      wpa(10, 201, 0.06),
      wpa(20, 201, 0.05),
    ];

    const result = selector.select({
      heroId: 72,
      enemyHeroIds: [10, 20],
      snapshot: snapshot([a, b]),
      vsHeroRows: rows,
    });

    expect(result.mode).toBe('VS_HERO_WPA');
    expect(result.archetypeId).toBe('b');
    expect(result.degradedReasons).toEqual([]);
    expect(result.scores.find((entry) => entry.archetypeId === 'b')!.score)
      .toBeGreaterThan(result.scores.find((entry) => entry.archetypeId === 'a')!.score);
  });

  it('records the same WPA archetype scores and winner used by selection', () => {
    const a = archetype('a', 101, 0.9, 0.95);
    const b = archetype('b', 201, 0.6, 0.85);
    const rows = [
      wpa(10, 101, -0.01),
      wpa(20, 101, 0.00),
      wpa(10, 201, 0.06),
      wpa(20, 201, 0.05),
    ];
    const trace = new BuildDecisionTraceCollectorV2();

    const result = selector.select({
      heroId: 72,
      enemyHeroIds: [10, 20],
      snapshot: snapshot([a, b]),
      vsHeroRows: rows,
    }, trace);
    const stage = trace.stages().find((entry) => entry.stage === 'ARCHETYPE_SELECTION');

    expect(stage?.stage).toBe('ARCHETYPE_SELECTION');
    if (!stage || stage.stage !== 'ARCHETYPE_SELECTION') throw new Error('Missing archetype selection trace');
    expect(stage.payload.selectedArchetypeId).toBe(result.archetypeId);
    expect(stage.payload.fallbackUsed).toBe(false);
    expect(stage.payload.enemyHeroIds).toEqual([10, 20]);
    expect(stage.payload.candidates).toEqual(result.scores.map((score) => expect.objectContaining({
      candidateId: score.archetypeId,
      archetypeId: score.archetypeId,
      score: score.score,
      confidence: score.confidence,
      coverage: score.coverage,
      disposition: score.archetypeId === result.archetypeId ? 'SELECTED' : 'REJECTED',
    })));
  });

  it('locks the best offline archetype immediately when VS_HERO_WPA is unavailable', () => {
    const a = archetype('a', 101, 0.9, 0.95);
    const b = archetype('b', 201, 0.6, 0.85);

    const result = selector.select({
      heroId: 72,
      enemyHeroIds: [10, 20],
      snapshot: snapshot([a, b]),
      vsHeroRows: [],
    });

    expect(result.mode).toBe('OFFLINE_DEFAULT');
    expect(result.archetypeId).toBe('a');
    expect(result.degradedReasons).toContain('ARCHETYPE_SELECTION_WPA_UNAVAILABLE');
  });

  it('records the offline fallback and its selected archetype when WPA is unavailable', () => {
    const a = archetype('a', 101, 0.9, 0.95);
    const b = archetype('b', 201, 0.6, 0.85);
    const trace = new BuildDecisionTraceCollectorV2();

    const result = selector.select({
      heroId: 72,
      enemyHeroIds: [20, 10],
      snapshot: snapshot([a, b]),
      vsHeroRows: [],
    }, trace);
    const stage = trace.stages().find((entry) => entry.stage === 'ARCHETYPE_SELECTION');

    expect(stage?.stage).toBe('ARCHETYPE_SELECTION');
    if (!stage || stage.stage !== 'ARCHETYPE_SELECTION') throw new Error('Missing archetype selection trace');
    expect(stage.payload.selectedArchetypeId).toBe(result.archetypeId);
    expect(stage.payload.fallbackUsed).toBe(true);
    expect(stage.payload.enemyHeroIds).toEqual([10, 20]);
    expect(stage.reasonCodes).toContain('ARCHETYPE_SELECTION_WPA_UNAVAILABLE');
  });

  it('normalizes matchup score by structural weight so extra FLEX items do not win by length', () => {
    const concise = archetype('concise', 101, 0.8, 0.9);
    const long = archetype('long', 201, 0.8, 0.9, [202, 203, 204, 205]);
    const rows = [
      wpa(10, 101, 0.04),
      wpa(10, 201, 0.04),
      wpa(10, 202, 0.04),
      wpa(10, 203, 0.04),
      wpa(10, 204, 0.04),
      wpa(10, 205, 0.04),
    ];

    const result = selector.select({
      heroId: 72,
      enemyHeroIds: [10],
      snapshot: snapshot([concise, long]),
      vsHeroRows: rows,
    });
    const conciseScore = result.scores.find((entry) => entry.archetypeId === 'concise')!;
    const longScore = result.scores.find((entry) => entry.archetypeId === 'long')!;

    expect(longScore.score).toBeCloseTo(conciseScore.score, 8);
  });
});
