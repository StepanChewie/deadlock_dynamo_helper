import {
  BuildArchetypeV2,
  StatlockerBuildProfileItemV2,
  StatlockerBuildProfileV2,
} from '../src/statlocker-adaptive/build-archetype-v2';
import { withSourceProfileProvenance } from '../src/statlocker-adaptive/build-archetype-refresh-v2.service';

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

function family(familyId: number): NonNullable<BuildArchetypeV2['families']>[number] {
  return {
    familyId,
    requirement: 'REQUIRED',
    aggregateFrequencyTier: 'CORE',
    sourceProfileCount: 2,
    profileCoverage: 2 / 3,
    purchaseRate: 0.9,
    structuralPriority: 0.9,
    progressionNodes: [],
    terminalCandidates: [],
  };
}

describe('Build archetype V2 family provenance', () => {
  it('keeps nicknames on the archetype and exact contributor account ids on each family', () => {
    const profiles = [
      profile('account-a', 'Alpha', [item(101, 101)]),
      profile('account-b', 'Bravo', [item(101, 101), item(201, 201)]),
      profile('account-c', 'Charlie', [item(201, 201)]),
    ];
    const archetype: BuildArchetypeV2 = {
      archetypeId: 'archetype:test',
      heroId: HERO_ID,
      rulesetVersion: 'r1',
      catalogSha256: 'a'.repeat(64),
      statlockerPatchId: 'p1',
      sourceProfileAccountIds: profiles.map((entry) => entry.accountId),
      families: [family(101), family(201)],
      items: [],
      groups: [],
      orderEdges: [],
      relationships: [],
      quality: { support: 1, coherence: 0.9, separation: 0.5, sourceProfileCount: 3 },
    };

    const decorated = withSourceProfileProvenance(archetype, profiles);

    expect(decorated.sourceProfiles).toEqual([
      { accountId: 'account-a', playerName: 'Alpha' },
      { accountId: 'account-b', playerName: 'Bravo' },
      { accountId: 'account-c', playerName: 'Charlie' },
    ]);
    expect(decorated.families?.find((entry) => entry.familyId === 101)?.sourceProfileAccountIds).toEqual([
      'account-a',
      'account-b',
    ]);
    expect(decorated.families?.find((entry) => entry.familyId === 201)?.sourceProfileAccountIds).toEqual([
      'account-b',
      'account-c',
    ]);
  });
});
