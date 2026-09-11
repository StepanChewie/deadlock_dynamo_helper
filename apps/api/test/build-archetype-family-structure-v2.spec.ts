import { BuildArchetypeCompilerV2Service } from '../src/statlocker-adaptive/build-archetype-compiler-v2.service';
import { StatlockerBuildProfileItemV2, StatlockerBuildProfileV2 } from '../src/statlocker-adaptive/build-archetype-v2';
import { BuildArchetypeClusterV2 } from '../src/statlocker-adaptive/build-archetype-miner-v2.service';

const X = 201;
const Y = 301;

function familyItem(
  itemId: number,
  familyId: number,
  medianBuyTimeS: number,
  relationships: readonly { itemId: number; strength: number }[] = [],
): StatlockerBuildProfileItemV2 {
  return {
    itemId,
    familyId,
    purchaseRate: 0.82,
    medianBuyTimeS,
    frequencyTier: 'FREQUENT',
    phase: medianBuyTimeS < 600 ? 'EARLY' : 'MID',
    relationships,
    explicitGroup: {
      type: 'CHOICE',
      groupKey: 'choice:defense',
      minSelect: 1,
      maxSelect: 1,
    },
  };
}

function profile(accountId: string): StatlockerBuildProfileV2 {
  return {
    accountId,
    heroId: 72,
    items: [
      familyItem(X, X, 300, [{ itemId: Y, strength: 0.8 }]),
      familyItem(Y, Y, 900, [{ itemId: X, strength: 0.8 }]),
    ],
  };
}

describe('BuildArchetypeCompilerV2Service family structural references', () => {
  it('emits groups, order edges, and relationships in family identity space', () => {
    const profiles = [profile('p1'), profile('p2'), profile('p3')];
    const cluster: BuildArchetypeClusterV2 = {
      clusterId: 'hero:72:cluster:family-structure',
      heroId: 72,
      profileAccountIds: profiles.map((entry) => entry.accountId),
      support: 1,
      internalSimilarity: 0.95,
      separation: 0.5,
      reasonCodes: [],
    };

    const archetype = new BuildArchetypeCompilerV2Service().compile({
      cluster,
      profiles,
      rulesetVersion: 'r1',
      statlockerPatchId: 'p1',
      catalogSha256: 'a'.repeat(64),
    });

    const group = archetype.groups[0] as unknown as { candidateFamilyIds?: readonly number[] };
    expect(group.candidateFamilyIds).toEqual([X, Y]);

    const orderEdge = archetype.orderEdges[0] as unknown as {
      beforeFamilyId?: number;
      afterFamilyId?: number;
    };
    expect(orderEdge).toMatchObject({ beforeFamilyId: X, afterFamilyId: Y });

    const relationship = archetype.relationships[0] as unknown as {
      leftFamilyId?: number;
      rightFamilyId?: number;
    };
    expect(relationship).toMatchObject({ leftFamilyId: X, rightFamilyId: Y });
  });
});
