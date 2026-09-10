import { BuildArchetypeCompilerV2Service } from '../src/statlocker-adaptive/build-archetype-compiler-v2.service';
import { StatlockerBuildProfileItemV2, StatlockerBuildProfileV2 } from '../src/statlocker-adaptive/build-archetype-v2';
import { BuildArchetypeClusterV2 } from '../src/statlocker-adaptive/build-archetype-miner-v2.service';

const A = 101;
const A_UPGRADE = 111;
const B = 102;
const C = 103;
const D = 104;
const E = 105;
const F = 106;

function itemAt(
  itemId: number,
  medianBuyTimeS: number,
  options: Partial<StatlockerBuildProfileItemV2> = {},
): StatlockerBuildProfileItemV2 {
  return {
    itemId,
    familyId: itemId,
    purchaseRate: 0.9,
    medianBuyTimeS,
    frequencyTier: 'CORE',
    phase: medianBuyTimeS < 600 ? 'EARLY' : medianBuyTimeS < 1_500 ? 'MID' : 'LATE',
    relationships: [],
    ...options,
  };
}

function profile(accountId: string, items: readonly StatlockerBuildProfileItemV2[]): StatlockerBuildProfileV2 {
  return { accountId, heroId: 72, items };
}

function clusterFor(profiles: readonly StatlockerBuildProfileV2[]): BuildArchetypeClusterV2 {
  return {
    clusterId: 'hero:72:cluster:test',
    heroId: 72,
    profileAccountIds: profiles.map((entry) => entry.accountId).sort(),
    support: 1,
    internalSimilarity: 0.95,
    separation: 0.5,
    reasonCodes: [],
  };
}

function compile(profiles: readonly StatlockerBuildProfileV2[]) {
  return new BuildArchetypeCompilerV2Service().compile({
    cluster: clusterFor(profiles),
    profiles,
    rulesetVersion: 'r1',
    statlockerPatchId: 'p1',
    catalogSha256: 'a'.repeat(64),
  });
}

function hasHardEdge(
  archetype: ReturnType<BuildArchetypeCompilerV2Service['compile']>,
  beforeItemId: number,
  afterItemId: number,
): boolean {
  return archetype.orderEdges.some((edge) =>
    edge.beforeItemId === beforeItemId && edge.afterItemId === afterItemId && edge.strength === 'HARD',
  );
}

describe('BuildArchetypeCompilerV2Service', () => {
  it('retains semantic milestones when B and C swap purchase order', () => {
    const archetype = compile([
      profile('p1', [itemAt(A, 300), itemAt(B, 500), itemAt(C, 700), itemAt(D, 1_000)]),
      profile('p2', [itemAt(A, 320), itemAt(C, 510), itemAt(B, 690), itemAt(D, 1_020)]),
      profile('p3', [itemAt(A, 310), itemAt(B, 520), itemAt(C, 680), itemAt(D, 990)]),
    ]);

    expect(new Set(archetype.items.map((entry) => entry.itemId))).toEqual(new Set([A, B, C, D]));
    expect(archetype.items.filter((entry) => entry.itemId === B)).toHaveLength(1);
    expect(archetype.items.filter((entry) => entry.itemId === C)).toHaveLength(1);
    expect(hasHardEdge(archetype, B, C)).toBe(false);
    expect(hasHardEdge(archetype, C, B)).toBe(false);
    expect(hasHardEdge(archetype, A, D)).toBe(true);
  });

  it('deduplicates repeated item variants from one semantic upgrade family', () => {
    const archetype = compile([
      profile('p1', [
        itemAt(A, 300, { familyId: A, frequencyTier: 'FREQUENT' }),
        itemAt(A_UPGRADE, 900, { familyId: A }),
      ]),
      profile('p2', [itemAt(A_UPGRADE, 850, { familyId: A })]),
      profile('p3', [itemAt(A_UPGRADE, 880, { familyId: A })]),
    ]);

    expect(archetype.items.filter((entry) => entry.familyId === A)).toHaveLength(1);
    expect(archetype.items[0].itemId).toBe(A_UPGRADE);
    expect(archetype.items[0].sourceProfileCount).toBe(3);
  });

  it('preserves a consistent Statlocker explicit CHOICE as one semantic group', () => {
    const explicitChoice = {
      type: 'CHOICE' as const,
      groupKey: 'mobility-choice',
      minSelect: 1,
      maxSelect: 1,
    };
    const archetype = compile([
      profile('p1', [
        itemAt(A, 300),
        itemAt(E, 900, { frequencyTier: 'SOMETIMES', explicitGroup: explicitChoice }),
        itemAt(F, 920, { frequencyTier: 'SOMETIMES', explicitGroup: explicitChoice }),
      ]),
      profile('p2', [
        itemAt(A, 310),
        itemAt(E, 880, { frequencyTier: 'SOMETIMES', explicitGroup: explicitChoice }),
        itemAt(F, 940, { frequencyTier: 'SOMETIMES', explicitGroup: explicitChoice }),
      ]),
      profile('p3', [
        itemAt(A, 290),
        itemAt(E, 910, { frequencyTier: 'SOMETIMES', explicitGroup: explicitChoice }),
        itemAt(F, 930, { frequencyTier: 'SOMETIMES', explicitGroup: explicitChoice }),
      ]),
    ]);

    expect(archetype.groups).toEqual(expect.arrayContaining([
      expect.objectContaining({
        groupId: 'mobility-choice',
        type: 'CHOICE',
        candidateItemIds: [E, F],
        minSelect: 1,
        maxSelect: 1,
        source: 'STATLOCKER_EXPLICIT',
      }),
    ]));
  });

  it('carries patch, ruleset and catalog identity into the compiled archetype', () => {
    const archetype = compile([
      profile('p1', [itemAt(A, 300)]),
      profile('p2', [itemAt(A, 320)]),
      profile('p3', [itemAt(A, 310)]),
    ]);

    expect(archetype).toMatchObject({
      heroId: 72,
      rulesetVersion: 'r1',
      statlockerPatchId: 'p1',
      catalogSha256: 'a'.repeat(64),
    });
  });
});
