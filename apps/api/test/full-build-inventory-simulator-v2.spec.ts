import {
  RecommendationItemDefinition,
  createRecommendationItemGraph,
} from '@dynamo-lab/build-domain';
import { FullBuildTransitionIntentV2 } from '../src/statlocker-adaptive/full-build-plan-v2';
import { simulateFullBuildInventoryV2 } from '../src/statlocker-adaptive/full-build-inventory-simulator-v2';

function directItem(itemId: number): RecommendationItemDefinition {
  return {
    itemId,
    name: `Item ${itemId}`,
    slotType: itemId % 3 === 0 ? 'spirit' : itemId % 3 === 1 ? 'weapon' : 'vitality',
    active: false,
    availableRulesetIds: ['ruleset-a'],
    directPurchaseCost: 500,
    upgradeRecipes: [],
    sellTransition: { soulsRefund: 250, returnedItemIds: [] },
    maxCopies: 1,
  };
}

describe('simulateFullBuildInventoryV2', () => {
  it('allows a lifetime plan longer than held capacity only through explicit REPLACE steps', () => {
    const graph = createRecommendationItemGraph(
      Array.from({ length: 15 }, (_, index) => directItem(index + 1)),
    );
    const actions: FullBuildTransitionIntentV2[] = [
      ...Array.from({ length: 12 }, (_, index): FullBuildTransitionIntentV2 => ({
        action: 'BUY',
        buyItemId: index + 1,
        reasonCodes: ['ARCHETYPE_PROGRESSION'],
      })),
      { action: 'REPLACE', sellItemId: 1, buyItemId: 13, reasonCodes: ['SLOT_REPLACEMENT'] },
      { action: 'REPLACE', sellItemId: 2, buyItemId: 14, reasonCodes: ['SLOT_REPLACEMENT'] },
      { action: 'REPLACE', sellItemId: 3, buyItemId: 15, reasonCodes: ['SLOT_REPLACEMENT'] },
    ];

    const result = simulateFullBuildInventoryV2({
      rulesetId: 'ruleset-a',
      itemGraph: graph,
      capacity: 12,
      initialInventoryItemIds: [],
      actions,
    });

    expect(result.steps).toHaveLength(15);
    expect(result.steps.every((step) => step.inventoryAfter.length <= 12)).toBe(true);
    expect(result.steps.slice(12).map((step) => step.action)).toEqual(['REPLACE', 'REPLACE', 'REPLACE']);
    expect(result.finalInventoryItemIds).toHaveLength(12);
    expect(result.validation).toEqual({ valid: true, reasonCodes: [] });
  });

  it('rejects an implicit thirteenth BUY instead of truncating the projected plan', () => {
    const graph = createRecommendationItemGraph(
      Array.from({ length: 13 }, (_, index) => directItem(index + 1)),
    );

    expect(() => simulateFullBuildInventoryV2({
      rulesetId: 'ruleset-a',
      itemGraph: graph,
      capacity: 12,
      initialInventoryItemIds: Array.from({ length: 12 }, (_, index) => index + 1),
      actions: [{ action: 'BUY', buyItemId: 13, reasonCodes: [] }],
    })).toThrow('Full build inventory v2: BUY would exceed held-item capacity');
  });

  it('represents recipe component consumption as UPGRADE and never as SELL', () => {
    const graph = createRecommendationItemGraph([
      directItem(1),
      directItem(100),
      {
        itemId: 200,
        name: 'Upgrade 200',
        slotType: 'weapon',
        active: false,
        availableRulesetIds: ['ruleset-a'],
        upgradeRecipes: [{ recipeId: '100-to-200', consumedItemIds: [100], soulsCost: 1000 }],
        sellTransition: { soulsRefund: 750, returnedItemIds: [] },
        maxCopies: 1,
      },
    ]);

    const result = simulateFullBuildInventoryV2({
      rulesetId: 'ruleset-a',
      itemGraph: graph,
      capacity: 2,
      initialInventoryItemIds: [1, 100],
      actions: [{ action: 'UPGRADE', buyItemId: 200, recipeId: '100-to-200', reasonCodes: ['UPGRADE_PATH'] }],
    });

    expect(result.steps[0]).toMatchObject({
      action: 'UPGRADE',
      buyItemId: 200,
      consumedItemIds: [100],
      inventoryBefore: [1, 100],
      inventoryAfter: [1, 200],
    });
    expect(result.steps[0].sellItemId).toBeUndefined();
  });

  it('keeps projected inventory continuous across every strategic step', () => {
    const graph = createRecommendationItemGraph([directItem(1), directItem(2), directItem(3)]);
    const result = simulateFullBuildInventoryV2({
      rulesetId: 'ruleset-a',
      itemGraph: graph,
      capacity: 2,
      initialInventoryItemIds: [],
      actions: [
        { action: 'BUY', buyItemId: 1, reasonCodes: [] },
        { action: 'BUY', buyItemId: 2, reasonCodes: [] },
        { action: 'REPLACE', sellItemId: 1, buyItemId: 3, reasonCodes: [] },
      ],
    });

    for (let index = 1; index < result.steps.length; index += 1) {
      expect(result.steps[index].inventoryBefore).toEqual(result.steps[index - 1].inventoryAfter);
    }
  });
});