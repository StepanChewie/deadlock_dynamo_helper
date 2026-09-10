import {
  RecommendationItemDefinition,
  createRecommendationItemGraph,
} from '@deadlock-live-probe/build-domain';
import { FullBuildPlanV2Service } from '../src/statlocker-adaptive/full-build-plan-v2.service';

function directItem(itemId: number, maxCopies = 1): RecommendationItemDefinition {
  return {
    itemId,
    name: `Item ${itemId}`,
    slotType: itemId % 3 === 0 ? 'spirit' : itemId % 3 === 1 ? 'weapon' : 'vitality',
    active: false,
    availableRulesetIds: ['ruleset-a'],
    directPurchaseCost: 500,
    upgradeRecipes: [],
    sellTransition: { soulsRefund: 250, returnedItemIds: [] },
    maxCopies,
  };
}

describe('FullBuildPlanV2Service', () => {
  it('models a lifetime plan longer than held capacity through explicit replacements', () => {
    const graph = createRecommendationItemGraph(
      Array.from({ length: 14 }, (_, index) => directItem(index + 1)),
    );
    const service = new FullBuildPlanV2Service();
    const plan = service.simulate({
      rulesetId: 'ruleset-a',
      itemGraph: graph,
      capacity: 12,
      initialInventoryItemIds: [],
      steps: [
        ...Array.from({ length: 12 }, (_, index) => ({
          type: 'BUY' as const,
          itemId: index + 1,
        })),
        { type: 'REPLACE', sellItemId: 1, buyItemId: 13 },
        { type: 'REPLACE', sellItemId: 2, buyItemId: 14 },
      ],
    });

    expect(plan.steps).toHaveLength(14);
    expect(plan.steps.every((step) => step.inventoryAfter.length <= 12)).toBe(true);
    expect(plan.finalInventoryItemIds).toHaveLength(12);
    expect(plan.finalInventoryItemIds).toEqual(expect.arrayContaining([13, 14]));
    expect(plan.finalInventoryItemIds).not.toContain(1);
    expect(plan.finalInventoryItemIds).not.toContain(2);
  });

  it('does not hide slot pressure by allowing an implicit thirteenth BUY', () => {
    const graph = createRecommendationItemGraph(
      Array.from({ length: 13 }, (_, index) => directItem(index + 1)),
    );
    const service = new FullBuildPlanV2Service();

    expect(() => service.simulate({
      rulesetId: 'ruleset-a',
      itemGraph: graph,
      capacity: 12,
      initialInventoryItemIds: Array.from({ length: 12 }, (_, index) => index + 1),
      steps: [{ type: 'BUY', itemId: 13 }],
    })).toThrow('Full build plan v2: BUY would exceed held-item capacity');
  });

  it('models recipe component consumption as UPGRADE rather than SELL', () => {
    const graph = createRecommendationItemGraph([
      directItem(1),
      directItem(100),
      {
        itemId: 200,
        name: 'Upgraded 200',
        slotType: 'weapon',
        active: false,
        availableRulesetIds: ['ruleset-a'],
        upgradeRecipes: [{
          recipeId: 'upgrade-100-200',
          consumedItemIds: [100],
          soulsCost: 1000,
        }],
        sellTransition: { soulsRefund: 750, returnedItemIds: [] },
        maxCopies: 1,
      },
    ]);
    const service = new FullBuildPlanV2Service();
    const plan = service.simulate({
      rulesetId: 'ruleset-a',
      itemGraph: graph,
      capacity: 2,
      initialInventoryItemIds: [1, 100],
      steps: [{ type: 'UPGRADE', itemId: 200, recipeId: 'upgrade-100-200' }],
    });

    expect(plan.steps[0]).toMatchObject({
      type: 'UPGRADE',
      itemId: 200,
      recipeId: 'upgrade-100-200',
      consumedItemIds: [100],
      inventoryBefore: [1, 100],
      inventoryAfter: [1, 200],
    });
    expect('sellItemId' in plan.steps[0]).toBe(false);
  });

  it('rejects a replacement when the proposed sell item is not held', () => {
    const graph = createRecommendationItemGraph([directItem(1), directItem(2)]);
    const service = new FullBuildPlanV2Service();

    expect(() => service.simulate({
      rulesetId: 'ruleset-a',
      itemGraph: graph,
      capacity: 1,
      initialInventoryItemIds: [1],
      steps: [{ type: 'REPLACE', sellItemId: 2, buyItemId: 1 }],
    })).toThrow('Full build plan v2: replacement sell item 2 is not held');
  });

  it('enforces catalog maxCopies across projected future inventory', () => {
    const graph = createRecommendationItemGraph([directItem(1, 1)]);
    const service = new FullBuildPlanV2Service();

    expect(() => service.simulate({
      rulesetId: 'ruleset-a',
      itemGraph: graph,
      capacity: 2,
      initialInventoryItemIds: [1],
      steps: [{ type: 'BUY', itemId: 1 }],
    })).toThrow('Full build plan v2: item 1 would exceed maxCopies');
  });

  it('keeps inventory continuity between every projected strategic step', () => {
    const graph = createRecommendationItemGraph([directItem(1), directItem(2), directItem(3)]);
    const service = new FullBuildPlanV2Service();
    const plan = service.simulate({
      rulesetId: 'ruleset-a',
      itemGraph: graph,
      capacity: 2,
      initialInventoryItemIds: [],
      steps: [
        { type: 'BUY', itemId: 1 },
        { type: 'BUY', itemId: 2 },
        { type: 'REPLACE', sellItemId: 1, buyItemId: 3 },
      ],
    });

    for (let index = 1; index < plan.steps.length; index += 1) {
      expect(plan.steps[index].inventoryBefore).toEqual(plan.steps[index - 1].inventoryAfter);
    }
  });
});