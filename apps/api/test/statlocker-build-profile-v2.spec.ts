import { createRecommendationItemGraph } from '@deadlock-live-probe/build-domain';
import { toStatlockerBuildProfileV2 } from '../src/statlocker-adaptive/statlocker-build-profile-v2';
import { StatlockerProBuildAnalysisV1 } from '../src/statlocker-adaptive/statlocker-adaptive.types';

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

const analysis: StatlockerProBuildAnalysisV1 = {
  accountId: '100',
  heroId: 72,
  items: [
    {
      itemId: 11,
      purchaseRate: 0.9,
      medianBuyTimeS: 420,
      frequencyTier: 'CORE',
      phase: 'EARLY',
      relationships: [{ itemId: 22, strength: 0.7 }],
    },
    {
      itemId: 22,
      purchaseRate: 0.7,
      medianBuyTimeS: 780,
      frequencyTier: 'FREQUENT',
      phase: 'MID',
      relationships: [{ itemId: 11, strength: 0.7 }],
    },
  ],
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
});
