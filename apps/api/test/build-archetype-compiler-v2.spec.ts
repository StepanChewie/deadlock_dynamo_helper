import { createRecommendationItemGraph, RecommendationItemGraph } from '@deadlock-live-probe/build-domain';
import { BuildArchetypeCompilerV2Service } from '../src/statlocker-adaptive/build-archetype-compiler-v2.service';
import {
  BuildProgressionNodeV2,
  StatlockerBuildProfileItemV2,
  StatlockerBuildProfileV2,
} from '../src/statlocker-adaptive/build-archetype-v2';
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

function compile(
  profiles: readonly StatlockerBuildProfileV2[],
  itemGraph?: RecommendationItemGraph,
) {
  return new BuildArchetypeCompilerV2Service().compile({
    cluster: clusterFor(profiles),
    profiles,
    rulesetVersion: 'r1',
    statlockerPatchId: 'p1',
    catalogSha256: 'a'.repeat(64),
    itemGraph,
  });
}

function progressionNodeOf(
  archetype: ReturnType<BuildArchetypeCompilerV2Service['compile']>,
  itemId: number,
): BuildProgressionNodeV2 {
  const node = archetype.families
    ?.flatMap((family) => family.progressionNodes)
    .find((entry) => entry.itemId === itemId);
  if (!node) throw new Error(`missing progression node for item ${itemId}`);
  return node;
}

function progressionGraph(): RecommendationItemGraph {
  return createRecommendationItemGraph([
    {
      itemId: A,
      name: 'Component',
      slotType: 'weapon',
      active: false,
      availableRulesetIds: ['r1'],
      directPurchaseCost: 1_600,
      upgradeRecipes: [],
    },
    {
      itemId: A_UPGRADE,
      name: 'Upgrade',
      slotType: 'weapon',
      active: false,
      availableRulesetIds: ['r1'],
      directPurchaseCost: 6_400,
      upgradeRecipes: [],
    },
  ], [{ parentItemId: A_UPGRADE, componentItemId: A }]);
}

function multiStepProgressionGraph(): RecommendationItemGraph {
  return createRecommendationItemGraph([
    {
      itemId: A,
      name: 'Entry',
      slotType: 'weapon',
      active: false,
      availableRulesetIds: ['r1'],
      directPurchaseCost: 1_600,
      upgradeRecipes: [],
    },
    {
      itemId: B,
      name: 'Intermediate',
      slotType: 'weapon',
      active: false,
      availableRulesetIds: ['r1'],
      upgradeRecipes: [],
    },
    {
      itemId: C,
      name: 'Terminal',
      slotType: 'weapon',
      active: false,
      availableRulesetIds: ['r1'],
      upgradeRecipes: [],
    },
  ], [
    { parentItemId: B, componentItemId: A },
    { parentItemId: C, componentItemId: B },
  ]);
}

function progressionEdgesOf(
  archetype: ReturnType<BuildArchetypeCompilerV2Service['compile']>,
): readonly unknown[] | undefined {
  const family = archetype.families?.[0] as unknown as { progressionEdges?: readonly unknown[] } | undefined;
  return family?.progressionEdges;
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

function hasOrderCycle(archetype: ReturnType<BuildArchetypeCompilerV2Service['compile']>): boolean {
  const adjacency = new Map<number, number[]>();
  for (const edge of archetype.orderEdges) {
    const next = adjacency.get(edge.beforeItemId) ?? [];
    next.push(edge.afterItemId);
    adjacency.set(edge.beforeItemId, next);
  }
  const visiting = new Set<number>();
  const visited = new Set<number>();
  const visit = (itemId: number): boolean => {
    if (visiting.has(itemId)) return true;
    if (visited.has(itemId)) return false;
    visiting.add(itemId);
    for (const next of adjacency.get(itemId) ?? []) {
      if (visit(next)) return true;
    }
    visiting.delete(itemId);
    visited.add(itemId);
    return false;
  };
  return archetype.items.some((item) => visit(item.itemId));
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

  it('keeps the compiled precedence graph acyclic under Condorcet-style profile disagreement', () => {
    const archetype = compile([
      profile('p1', [itemAt(A, 300), itemAt(B, 600), itemAt(C, 900)]),
      profile('p2', [itemAt(B, 300), itemAt(C, 600), itemAt(A, 900)]),
      profile('p3', [itemAt(C, 300), itemAt(A, 600), itemAt(B, 900)]),
    ]);

    expect(archetype.orderEdges).toHaveLength(2);
    expect(hasOrderCycle(archetype)).toBe(false);
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

  it('compiles same-profile observed progression with lineage-specific timing', () => {
    const archetype = compile([
      profile('p1', [
        itemAt(A, 300, { familyId: A, frequencyTier: 'FREQUENT' }),
        itemAt(A_UPGRADE, 900, { familyId: A }),
      ]),
      profile('p2', [
        itemAt(A, 330, { familyId: A, frequencyTier: 'FREQUENT' }),
        itemAt(A_UPGRADE, 960, { familyId: A }),
      ]),
      profile('p3', [
        itemAt(A, 310, { familyId: A, frequencyTier: 'FREQUENT' }),
        itemAt(A_UPGRADE, 920, { familyId: A }),
      ]),
    ], progressionGraph());

    expect(progressionEdgesOf(archetype)).toEqual([
      {
        fromItemId: A,
        toItemId: A_UPGRADE,
        sourceProfileCount: 3,
        orderedProfileCount: 3,
        orderConfidence: 1,
        timing: {
          fromMedianBuyTimeS: 310,
          toMedianBuyTimeS: 920,
          fromSpreadS: 10,
          toSpreadS: 20,
        },
        evidence: 'STATLOCKER_SAME_PROFILE',
      },
    ]);
  });

  it('compiles only direct catalog upgrade relations as executable progression edges', () => {
    const archetype = compile([
      profile('p1', [
        itemAt(A, 300, { familyId: A }),
        itemAt(B, 700, { familyId: A }),
        itemAt(C, 1_100, { familyId: A }),
      ]),
      profile('p2', [
        itemAt(A, 320, { familyId: A }),
        itemAt(B, 720, { familyId: A }),
        itemAt(C, 1_120, { familyId: A }),
      ]),
    ], multiStepProgressionGraph());

    expect(progressionEdgesOf(archetype)).toEqual([
      expect.objectContaining({ fromItemId: A, toItemId: B }),
      expect.objectContaining({ fromItemId: B, toItemId: C }),
    ]);
    expect(progressionEdgesOf(archetype)).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ fromItemId: A, toItemId: C }),
    ]));
  });

  it('does not synthesize progression from items observed only in different profiles', () => {
    const archetype = compile([
      profile('p1', [itemAt(A, 300, { familyId: A })]),
      profile('p2', [itemAt(A, 320, { familyId: A })]),
      profile('p3', [itemAt(A_UPGRADE, 900, { familyId: A })]),
      profile('p4', [itemAt(A_UPGRADE, 920, { familyId: A })]),
    ], progressionGraph());

    expect(progressionEdgesOf(archetype)).toEqual([]);
  });

  it('rejects same-profile progression below soft order confidence', () => {
    const archetype = compile([
      profile('p1', [
        itemAt(A, 300, { familyId: A }),
        itemAt(A_UPGRADE, 900, { familyId: A }),
      ]),
      profile('p2', [
        itemAt(A, 900, { familyId: A }),
        itemAt(A_UPGRADE, 300, { familyId: A }),
      ]),
    ], progressionGraph());

    expect(progressionEdgesOf(archetype)).toEqual([]);
  });

  it('ignores same-profile observations inside the order timing tolerance', () => {
    const archetype = compile([
      profile('p1', [
        itemAt(A, 300, { familyId: A }),
        itemAt(A_UPGRADE, 330, { familyId: A }),
      ]),
      profile('p2', [
        itemAt(A, 500, { familyId: A }),
        itemAt(A_UPGRADE, 530, { familyId: A }),
      ]),
    ], progressionGraph());

    expect(progressionEdgesOf(archetype)).toEqual([]);
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

  it('weights the progression timing median by purchase rate', () => {
    const archetype = compile([
      profile('p1', [itemAt(A, 303, { purchaseRate: 0.21 })]),
      profile('p2', [itemAt(A, 423, { purchaseRate: 0.45 })]),
    ]);

    expect(progressionNodeOf(archetype, A).timing.medianBuyTimeS).toBe(423);
  });

  it('weights the compiled item timing median by family purchase rate', () => {
    const archetype = compile([
      profile('p1', [itemAt(A, 303, { purchaseRate: 0.21 })]),
      profile('p2', [itemAt(A, 423, { purchaseRate: 0.45 })]),
    ]);

    expect(archetype.items.find((entry) => entry.itemId === A)?.timing.medianBuyTimeS).toBe(423);
  });

  it('keeps the plain timing median when profile purchase rates are equal', () => {
    const archetype = compile([
      profile('p1', [itemAt(A, 300)]),
      profile('p2', [itemAt(A, 900)]),
    ]);

    expect(progressionNodeOf(archetype, A).timing.medianBuyTimeS).toBe(600);
  });

  it('falls back to the plain timing median when purchase rates sum to zero', () => {
    const archetype = compile([
      profile('p1', [itemAt(A, 300, { purchaseRate: 0 })]),
      profile('p2', [itemAt(A, 900, { purchaseRate: 0 })]),
    ]);

    expect(progressionNodeOf(archetype, A).timing.medianBuyTimeS).toBe(600);
  });
});
