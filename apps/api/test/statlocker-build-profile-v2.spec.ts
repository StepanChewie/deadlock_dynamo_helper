import { createRecommendationItemGraph } from '@dynamo-lab/build-domain';
import { toStatlockerBuildProfileV2 } from '../src/statlocker-adaptive/statlocker-build-profile-v2';
import { StatlockerProBuildAnalysisV1, StatlockerProBuildItemV1 } from '../src/statlocker-adaptive/statlocker-adaptive.types';

const graph = createRecommendationItemGraph([
  {
    itemId: 11,
    name: 'Item 11',
    slotType: 'weapon',
    active: false,
    availableRulesetIds: ['r1'],
    directPurchaseCost: 500,
    upgradeRecipes: [],
  },
  {
    itemId: 22,
    name: 'Item 22',
    slotType: 'spirit',
    active: false,
    availableRulesetIds: ['r1'],
    directPurchaseCost: 1250,
    upgradeRecipes: [],
  },
  {
    itemId: 100,
    name: 'Item 100',
    slotType: 'weapon',
    active: false,
    availableRulesetIds: ['r1'],
    directPurchaseCost: 500,
    upgradeRecipes: [],
  },
  {
    itemId: 200,
    name: 'Item 200',
    slotType: 'weapon',
    active: false,
    availableRulesetIds: ['r1'],
    upgradeRecipes: [{ recipeId: '100-to-200', consumedItemIds: [100], soulsCost: 1250 }],
  },
]);

const item11: StatlockerProBuildItemV1 = {
  itemId: 11,
  purchaseRate: 0.9,
  medianBuyTimeS: 420,
  frequencyTier: 'CORE',
  phase: 'EARLY',
  relationships: [{ itemId: 22, strength: 0.7 }],
};

const item22: StatlockerProBuildItemV1 = {
  itemId: 22,
  purchaseRate: 0.7,
  medianBuyTimeS: 780,
  frequencyTier: 'FREQUENT',
  phase: 'MID',
  relationships: [{ itemId: 11, strength: 0.7 }],
};

const analysis: StatlockerProBuildAnalysisV1 = {
  accountId: '100',
  heroId: 72,
  items: [item11, item22],
};

describe('Statlocker build profile v2', () => {
  it('normalizes one Statlocker build analysis without inventing ordinal milestones', () => {
    const profile = toStatlockerBuildProfileV2(analysis, graph);

    expect(profile.heroId).toBe(72);
    expect(profile.accountId).toBe('100');
    expect(profile.items.map((entry) => entry.itemId)).toEqual([11, 22]);
    expect(profile.items[0]).toMatchObject({
      itemId: 11,
      familyId: 11,
      purchaseRate: 0.9,
      phase: 'EARLY',
    });
    expect(Object.keys(profile)).not.toContain('transactions');
    expect(Object.keys(profile)).not.toContain('orderedItemIds');
  });

  it('canonicalizes an upgraded item to the same semantic family as its component', () => {
    const upgraded: StatlockerProBuildAnalysisV1 = {
      accountId: 'upgrade-profile',
      heroId: 72,
      items: [{
        itemId: 200,
        purchaseRate: 0.8,
        medianBuyTimeS: 900,
        frequencyTier: 'CORE',
        phase: 'MID',
        relationships: [],
      }],
    };

    const profile = toStatlockerBuildProfileV2(upgraded, graph);

    expect(profile.items[0].familyId).toBe(100);
  });

  it('preserves semantic metadata and sorts profile content deterministically', () => {
    const unsorted: StatlockerProBuildAnalysisV1 = {
      accountId: 'ranked-profile',
      heroId: 72,
      items: [
        {
          ...item22,
          relationships: [
            { itemId: 100, strength: 0.4 },
            { itemId: 11, strength: 0.8 },
          ],
          explicitGroup: {
            type: 'CHOICE',
            groupKey: 'mid-defense',
            minSelect: 1,
            maxSelect: 1,
          },
        },
        item11,
      ],
    };

    const profile = toStatlockerBuildProfileV2(unsorted, graph, 3);

    expect(profile.leaderboardRank).toBe(3);
    expect(profile.items.map((entry) => entry.itemId)).toEqual([11, 22]);
    expect(profile.items[1].relationships).toEqual([
      { itemId: 11, strength: 0.8 },
      { itemId: 100, strength: 0.4 },
    ]);
    expect(profile.items[1].explicitGroup).toEqual({
      type: 'CHOICE',
      groupKey: 'mid-defense',
      minSelect: 1,
      maxSelect: 1,
    });
  });

  it('deduplicates identical source items but rejects conflicting duplicates', () => {
    const duplicate: StatlockerProBuildAnalysisV1 = {
      accountId: 'duplicate-profile',
      heroId: 72,
      items: [item11, { ...item11, relationships: [...item11.relationships] }],
    };
    const conflict: StatlockerProBuildAnalysisV1 = {
      accountId: 'conflicting-profile',
      heroId: 72,
      items: [item11, { ...item11, purchaseRate: 0.1 }],
    };

    expect(toStatlockerBuildProfileV2(duplicate, graph).items).toHaveLength(1);
    expect(() => toStatlockerBuildProfileV2(conflict, graph)).toThrow('conflicting duplicate item 11');
  });

  it('rejects empty profiles and unknown catalog items instead of inventing semantics', () => {
    expect(() => toStatlockerBuildProfileV2({ accountId: 'empty', heroId: 72, items: [] }, graph))
      .toThrow('items must not be empty');
    expect(() => toStatlockerBuildProfileV2({
      accountId: 'unknown',
      heroId: 72,
      items: [{
        itemId: 999,
        purchaseRate: 0.5,
        medianBuyTimeS: 600,
        frequencyTier: 'SOMETIMES',
        phase: 'MID',
        relationships: [],
      }],
    }, graph)).toThrow('unknown item 999');
  });
});
