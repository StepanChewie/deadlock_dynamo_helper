import { BuildArchetypeCompilerV2Service } from '../src/statlocker-adaptive/build-archetype-compiler-v2.service';
import {
  StatlockerBuildProfileItemV2,
  StatlockerBuildProfileV2,
} from '../src/statlocker-adaptive/build-archetype-v2';
import { BuildArchetypeClusterV2 } from '../src/statlocker-adaptive/build-archetype-miner-v2.service';

const HERO_ID = 72;

function item(itemId: number, familyId: number): StatlockerBuildProfileItemV2 {
  return {
    itemId,
    familyId,
    purchaseRate: 0.9,
    medianBuyTimeS: 500,
    frequencyTier: 'CORE',
    phase: 'EARLY',
    relationships: [],
  };
}

function profile(
  accountId: string,
  playerName: string,
  items: readonly StatlockerBuildProfileItemV2[],
): StatlockerBuildProfileV2 {
  return { accountId, playerName, heroId: HERO_ID, items };
}

describe('Build archetype V2 family provenance', () => {
  it('keeps nicknames on the archetype and exact contributor account ids on each family', () => {
    const profiles = [
      profile('account-a', 'Alpha', [item(101, 101)]),
      profile('account-b', 'Bravo', [item(101, 101), item(201, 201)]),
      profile('account-c', 'Charlie', [item(201, 201)]),
    ];
    const cluster: BuildArchetypeClusterV2 = {
      clusterId: 'hero:72:provenance',
      heroId: HERO_ID,
      profileAccountIds: profiles.map((entry) => entry.accountId),
      support: 1,
      internalSimilarity: 0.9,
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

    expect(archetype.sourceProfiles).toEqual([
      { accountId: 'account-a', playerName: 'Alpha' },
      { accountId: 'account-b', playerName: 'Bravo' },
      { accountId: 'account-c', playerName: 'Charlie' },
    ]);
    expect(archetype.families?.find((family) => family.familyId === 101)?.sourceProfileAccountIds).toEqual([
      'account-a',
      'account-b',
    ]);
    expect(archetype.families?.find((family) => family.familyId === 201)?.sourceProfileAccountIds).toEqual([
      'account-b',
      'account-c',
    ]);
  });
});
