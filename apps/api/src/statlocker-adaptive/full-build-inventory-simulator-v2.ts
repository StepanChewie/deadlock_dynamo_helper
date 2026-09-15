import { RecommendationItemGraph } from '@dynamo-lab/build-domain';
import {
  FullBuildInventorySimulationV2,
  FullBuildStepV2,
  FullBuildTransitionIntentV2,
} from './full-build-plan-v2';

export interface SimulateFullBuildInventoryV2Input {
  rulesetId: string;
  itemGraph: RecommendationItemGraph;
  capacity: number;
  initialInventoryItemIds: readonly number[];
  actions: readonly FullBuildTransitionIntentV2[];
}

export function simulateFullBuildInventoryV2(
  input: SimulateFullBuildInventoryV2Input,
): FullBuildInventorySimulationV2 {
  validateInput(input);
  let inventory = normalizeInventory(input.initialInventoryItemIds);
  validateInventory(inventory, input.itemGraph, input.capacity, 'initial inventory');

  const steps: FullBuildStepV2[] = [];
  for (let index = 0; index < input.actions.length; index += 1) {
    const intent = input.actions[index];
    const inventoryBefore = [...inventory];

    if (intent.action === 'BUY') {
      const item = requirePurchasableItem(intent.buyItemId, input.rulesetId, input.itemGraph);
      const nextInventory = normalizeInventory([...inventory, item.itemId]);
      validateMaxCopies(nextInventory, input.itemGraph, item.itemId);
      if (nextInventory.length > input.capacity) {
        throw new Error('Full build inventory v2: BUY would exceed held-item capacity');
      }
      inventory = nextInventory;
      steps.push({
        sequence: index + 1,
        action: 'BUY',
        buyItemId: item.itemId,
        consumedItemIds: [],
        inventoryBefore,
        inventoryAfter: [...inventory],
        reasonCodes: [...intent.reasonCodes],
      });
      continue;
    }

    if (intent.action === 'UPGRADE') {
      const item = requireAvailableItem(intent.buyItemId, input.rulesetId, input.itemGraph);
      const recipe = item.upgradeRecipes.find((entry) => entry.recipeId === intent.recipeId);
      if (!recipe) {
        throw new Error(
          `Full build inventory v2: upgrade recipe ${intent.recipeId} does not exist for item ${item.itemId}`,
        );
      }

      let nextInventory = [...inventory];
      for (const componentItemId of recipe.consumedItemIds) {
        nextInventory = removeHeldItem(
          nextInventory,
          componentItemId,
          `Full build inventory v2: upgrade component ${componentItemId} is not held`,
        );
      }
      nextInventory = normalizeInventory([...nextInventory, item.itemId]);
      validateInventory(nextInventory, input.itemGraph, input.capacity, 'UPGRADE result');
      inventory = nextInventory;
      steps.push({
        sequence: index + 1,
        action: 'UPGRADE',
        buyItemId: item.itemId,
        recipeId: recipe.recipeId,
        consumedItemIds: [...recipe.consumedItemIds],
        inventoryBefore,
        inventoryAfter: [...inventory],
        reasonCodes: [...intent.reasonCodes],
      });
      continue;
    }

    if (!inventory.includes(intent.sellItemId)) {
      throw new Error(`Full build inventory v2: replacement sell item ${intent.sellItemId} is not held`);
    }
    const soldItem = input.itemGraph.getItem(intent.sellItemId);
    if (!soldItem) {
      throw new Error(`Full build inventory v2: replacement sell item ${intent.sellItemId} is not in the catalog`);
    }
    if (!soldItem.sellTransition) {
      throw new Error(
        `Full build inventory v2: replacement sell transition for item ${intent.sellItemId} is unavailable`,
      );
    }
    const boughtItem = requirePurchasableItem(intent.buyItemId, input.rulesetId, input.itemGraph);
    let nextInventory = removeHeldItem(
      inventory,
      intent.sellItemId,
      `Full build inventory v2: replacement sell item ${intent.sellItemId} is not held`,
    );
    nextInventory = normalizeInventory([
      ...nextInventory,
      ...soldItem.sellTransition.returnedItemIds,
      boughtItem.itemId,
    ]);
    validateInventory(nextInventory, input.itemGraph, input.capacity, 'REPLACE result');
    inventory = nextInventory;
    steps.push({
      sequence: index + 1,
      action: 'REPLACE',
      sellItemId: intent.sellItemId,
      buyItemId: boughtItem.itemId,
      consumedItemIds: [],
      inventoryBefore,
      inventoryAfter: [...inventory],
      reasonCodes: [...intent.reasonCodes],
    });
  }

  return {
    steps,
    finalInventoryItemIds: [...inventory],
    validation: { valid: true, reasonCodes: [] },
  };
}

function validateInput(input: SimulateFullBuildInventoryV2Input): void {
  if (!input.rulesetId) throw new Error('Full build inventory v2: rulesetId is required');
  if (!Number.isInteger(input.capacity) || input.capacity <= 0) {
    throw new Error('Full build inventory v2: capacity must be a positive integer');
  }
  for (const itemId of input.initialInventoryItemIds) validateItemId(itemId);
  for (const action of input.actions) {
    validateItemId(action.buyItemId);
    if (action.action === 'REPLACE') validateItemId(action.sellItemId);
    if (action.action === 'UPGRADE' && !action.recipeId) {
      throw new Error('Full build inventory v2: UPGRADE recipeId is required');
    }
  }
}

function validateInventory(
  inventory: readonly number[],
  itemGraph: RecommendationItemGraph,
  capacity: number,
  context: string,
): void {
  if (inventory.length > capacity) {
    throw new Error(`Full build inventory v2: ${context} exceeds held-item capacity`);
  }
  for (const itemId of inventory) {
    if (!itemGraph.getItem(itemId)) {
      throw new Error(`Full build inventory v2: item ${itemId} is not in the catalog`);
    }
  }
  for (const itemId of [...new Set(inventory)]) validateMaxCopies(inventory, itemGraph, itemId);
}

function validateMaxCopies(
  inventory: readonly number[],
  itemGraph: RecommendationItemGraph,
  itemId: number,
): void {
  const item = itemGraph.getItem(itemId);
  if (!item) throw new Error(`Full build inventory v2: item ${itemId} is not in the catalog`);
  const maxCopies = item.maxCopies ?? 1;
  const copies = inventory.filter((heldItemId) => heldItemId === itemId).length;
  if (copies > maxCopies) {
    throw new Error(`Full build inventory v2: item ${itemId} would exceed maxCopies`);
  }
}

function requireAvailableItem(
  itemId: number,
  rulesetId: string,
  itemGraph: RecommendationItemGraph,
) {
  const item = itemGraph.getItem(itemId);
  if (!item) throw new Error(`Full build inventory v2: item ${itemId} is not in the catalog`);
  if (!item.availableRulesetIds.includes(rulesetId)) {
    throw new Error(`Full build inventory v2: item ${itemId} is unavailable in ruleset ${rulesetId}`);
  }
  return item;
}

function requirePurchasableItem(
  itemId: number,
  rulesetId: string,
  itemGraph: RecommendationItemGraph,
) {
  const item = requireAvailableItem(itemId, rulesetId, itemGraph);
  if (item.directPurchaseCost === undefined) {
    throw new Error(`Full build inventory v2: item ${itemId} does not support direct purchase`);
  }
  return item;
}

function removeHeldItem(
  inventory: readonly number[],
  itemId: number,
  errorMessage: string,
): number[] {
  const index = inventory.indexOf(itemId);
  if (index < 0) throw new Error(errorMessage);
  return [...inventory.slice(0, index), ...inventory.slice(index + 1)];
}

function normalizeInventory(itemIds: readonly number[]): number[] {
  return [...itemIds].sort((left, right) => left - right);
}

function validateItemId(itemId: number): void {
  if (!Number.isInteger(itemId) || itemId <= 0) {
    throw new Error(`Full build inventory v2: invalid item id ${itemId}`);
  }
}
