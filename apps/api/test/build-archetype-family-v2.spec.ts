import { BuildArchetypeCompilerV2Service } from '../src/statlocker-adaptive/build-archetype-compiler-v2.service';
import { StatlockerBuildProfileItemV2, StatlockerBuildProfileV2 } from '../src/statlocker-adaptive/build-archetype-v2';
import { BuildArchetypeClusterV2 } from '../src/statlocker-adaptive/build-archetype-miner-v2.service';

const A = 101;
const B = 111;
const C = 121;
const D = 131;

function itemAt(
  itemId: number,
  medianBuyTimeS: number,
  frequencyTier: StatlockerBuildProfileItemV2['frequencyTier'],
): StatlockerBuildProfileItemV2 {
  return {
    itemId,
    familyId: A,
    purchaseRate: frequencyTier === 'CORE' ? 0.95 : frequencyTier === 'FREQUENT' ? 0.82 : 0.25,
    medianBuyTimeS,
    frequencyTier,
    phase: medianBuyTimeS < 600 ? 'EARLY' : medianBuyTimeS < 1_500 ? 'MID' : 'LATE',
    relationships: [],
  };
}

function profile(accountId: string, items: readonly StatlockerBuildProfileItemV2[]): StatlockerBuildProfileV2 {
  return { accountId, heroId: 72, items };
}

function clusterFor(profiles: readonly StatlockerBuildProfileV2[]): BuildArchetypeClusterV2 {
  return {
    clusterId: 'hero:72:cluster:family-test',
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

type ExpectedFamily = {
  familyId: number;
  progressionNodes: readonly {
    itemId: number;
    progressionRole: 'ENTRY' | 'INTERMEDIATE' | 'DEFAULT_TERMINAL' | 'OPTIONAL_TERMINAL';
  }[];
  terminalCandidates: readonly {
    itemId: number;
    kind: 'DEFAULT_TERMINAL' | 'OPTIONAL_TERMINAL';
  }[];
};

function familiesOf(archetype: ReturnType<typeof compile>): readonly ExpectedFamily[] {
  return (archetype as unknown as { families?: readonly ExpectedFamily[] }).families ?? [];
}

describe('BuildArchetypeCompilerV2Service family semantics', () => {
  it('collapses an observed upgrade lineage into one semantic family progression', () => {
    const archetype = compile([
      profile('p1', [itemAt(A, 300, 'CORE'), itemAt(B, 700, 'CORE'), itemAt(C, 1_200, 'FREQUENT')]),
      profile('p2', [itemAt(A, 320, 'CORE'), itemAt(B, 720, 'CORE'), itemAt(C, 1_180, 'FREQUENT')]),
      profile('p3', [itemAt(A, 310, 'CORE'), itemAt(B, 710, 'CORE'), itemAt(C, 1_210, 'FREQUENT')]),
    ]);

    const families = familiesOf(archetype);
    expect(families).toHaveLength(1);
    expect(families[0].familyId).toBe(A);
    expect(families[0].progressionNodes.map((node) => [node.itemId, node.progressionRole])).toEqual([
      [A, 'ENTRY'],
      [B, 'INTERMEDIATE'],
      [C, 'DEFAULT_TERMINAL'],
    ]);
    expect(families[0].terminalCandidates).toEqual([
      expect.objectContaining({ itemId: C, kind: 'DEFAULT_TERMINAL' }),
    ]);
  });

  it('keeps a rare observed descendant optional instead of making it a mandatory terminal', () => {
    const archetype = compile([
      profile('p1', [
        itemAt(A, 300, 'CORE'),
        itemAt(B, 700, 'CORE'),
        itemAt(C, 1_200, 'FREQUENT'),
        itemAt(D, 1_800, 'SOMETIMES'),
      ]),
      profile('p2', [itemAt(A, 320, 'CORE'), itemAt(B, 720, 'CORE'), itemAt(C, 1_180, 'FREQUENT')]),
      profile('p3', [itemAt(A, 310, 'CORE'), itemAt(B, 710, 'CORE'), itemAt(C, 1_210, 'FREQUENT')]),
    ]);

    const family = familiesOf(archetype)[0];
    expect(family.terminalCandidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ itemId: C, kind: 'DEFAULT_TERMINAL' }),
      expect.objectContaining({ itemId: D, kind: 'OPTIONAL_TERMINAL' }),
    ]));
    expect(family.progressionNodes.find((node) => node.itemId === D)?.progressionRole).toBe('OPTIONAL_TERMINAL');
  });
});
