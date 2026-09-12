import { Injectable } from '@nestjs/common';
import { RecommendationItemGraph } from '@deadlock-live-probe/build-domain';

export type FullBuildStrategicStepInputV2 =
  | { type: 'BUY'; itemId: number }
  | { type: 'UPGRADE'; itemId: number; recipeId: string }
  | { type: 'REPLACE'; sellItemId: number; buyItemId: number };

export interface FullBuildPlanSimulationInputV2 {
  rulesetId: string;
  itemGraph: RecommendationItemGraph;
  capacity: number;
  initialInventoryItemIds: readonly number[];
  steps: readonly FullBuildStrategicStepInputV2[];
}

interface FullBuildPlanStepBaseV2 {
  sequence: number;
  inventoryBefore: readonly number[];
  inventoryAfter: readonly number[];
}

export interface FullBuildBuyStepV2 extends FullBuildPlanStepBaseV2 {
  type: 'BUY';
  itemId: number;
}

export interface FullBuildUpgradeStepV2 extends FullBuildPlanStepBaseV2 {
  type: 'UPGRADE';
  itemId: number;
  recipeId: string;
  consumedItemIds: readonly number[];
}

export interface FullBuildReplaceStepV2 extends FullBuildPlanStepBaseV2 {
  type: 'REPLACE';
  sellItemId: number;
  buyItemId: number;
  returnedItemIds: readonly number[];
}

export type FullBuildPlanStepV2 =
  | FullBuildBuyStepV2
  | FullBuildUpgradeStepV2
  | FullBuildReplaceStepV2;

export interface FullBuildPlanV2 {
  schemaVersion: 2;
  capacity: number;
  initialInventoryItemIds: readonly number[];
  steps: readonly FullBuildPlanStepV2[];
  finalInventoryItemIds: readonly number[];
}

@Injectable()
export class FullBuildPlanV2Service {
  simulate(input: FullBuildPlanSimulationInputV2): FullBuildPlanV2 {
    validateSimulationInput(input);
    let inventory = normalizeInventory(input.initialInventoryItemIds);
    validateInventory(inventory, input.itemGraph, input.capacity, 'initial inventory');

    const steps: FullBuildPlanStepV2[] = [];
    for (let index = 0; index < input.steps.length; index += 1) {
      const strategicStep = input.steps[index];
      const inventoryBefore = [...inventory];

      if (strategicStep.type === 'BUY') {
        const item = requirePurchasableItem(strategicStep.itemId, input.rulesetId, input.itemGraph);
        const nextInventory = normalizeInventory([...inventory, item.itemId]);
        validateMaxCopies(nextInventory, input.itemGraph, item.itemId);
        if (nextInventory.length > input.capacity) {
          throw new Error('Full build plan v2: BUY would exceed held-item capacity');
        }
        inventory = nextInventory;
        steps.push({
          sequence: index + 1,
          type: 'BUY',
          itemId: item.itemId,
          inventoryBefore,
          inventoryAfter: [...inventory],
        });
        continue;
      }

      if (strategicStep.type === 'UPGRADE') {
        const item = requireAvailableItem(strategicStep.itemId, input.rulesetId, input.itemGraph);
        const recipe = item.upgradeRecipes.find((entry) => entry.recipeId === strategicStep.recipeId);
        if (!recipe) {
          throw new Error(
            `Full build plan v2: upgrade recipe ${strategicStep.recipeId} does not exist for item ${item.itemId}`,
          );
        }
        let nextInventory = [...inventory];
        for (const componentItemId of recipe.consumedItemIds) {
          nextInventory = removeHeldItem(
            nextInventory,
            componentItemId,
            `Full build plan v2: upgrade component ${componentItemId} is not held`,
          );
        }
        nextInventory = normalizeInventory([...nextInventory, item.itemId]);
        validateMaxCopies(nextInventory, input.itemGraph, item.itemId);
        if (nextInventory.length > input.capacity) {
          throw new Error('Full build plan v2: UPGRADE would exceed held-item capacity');
        }
        inventory = nextInventory;
        steps.push({
          sequence: index + 1,
          type: 'UPGRADE',
          itemId: item.itemId,
          recipeId: recipe.recipeId,
          consumedItemIds: [...recipe.consumedItemIds],
          inventoryBefore,
          inventoryAfter: [...inventory],
        });
        continue;
      }

      if (!inventory.includes(strategicStep.sellItemId)) {
        throw new Error(
          `Full build plan v2: replacement sell item ${strategicStep.sellItemId} is not held`,
        );
      }
      const soldItem = input.itemGraph.getItem(strategicStep.sellItemId);
      if (!soldItem) {
        throw new Error(
          `Full build plan v2: replacement sell item ${strategicStep.sellItemId} is not in the catalog`,
        );
      }
      if (!soldItem.sellTransition) {
        throw new Error(
          `Full build plan v2: replacement sell transition for item ${strategicStep.sellItemId} is unavailable`,
        );
      }
      const boughtItem = requirePurchasableItem(strategicStep.buyItemId, input.rulesetId, input.itemGraph);
      let nextInventory = removeHeldItem(
        inventory,
        strategicStep.sellItemId,
        `Full build plan v2: replacement sell item ${strategicStep.sellItemId} is not held`,
      );
      nextInventory = normalizeInventory([
        ...nextInventory,
        ...soldItem.sellTransition.returnedItemIds,
        boughtItem.itemId,
      ]);
      validateInventory(nextInventory, input.itemGraph, input.capacity, 'replacement result');
      inventory = nextInventory;
      steps.push({
        sequence: index + 1,
        type: 'REPLACE',
        sellItemId: strategicStep.sellItemId,
        buyItemId: boughtItem.itemId,
        returnedItemIds: [...soldItem.sellTransition.returnedItemIds],
        inventoryBefore,
        inventoryAfter: [...inventory],
      });
    }

    return {
      schemaVersion: 2,
      capacity: input.capacity,
      initialInventoryItemIds: normalizeInventory(input.initialInventoryItemIds),
      steps,
      finalInventoryItemIds: [...inventory],
    };
  }
}

function validateSimulationInput(input: FullBuildPlanSimulationInputV2): void {
  if (!input.rulesetId) {
    throw new Error('Full build plan v2: rulesetId is required');
  }
  if (!Number.isInteger(input.capacity) || input.capacity <= 0) {
    throw new Error('Full build plan v2: capacity must be a positive integer');
  }
  for (const itemId of input.initialInventoryItemIds) validateItemId(itemId);
  for (const step of input.steps) {
    if (step.type === 'BUY' || step.type === 'UPGRADE') validateItemId(step.itemId);
    else {
      validateItemId(step.sellItemId);
      validateItemId(step.buyItemId);
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
    throw new Error(`Full build plan v2: ${context} exceeds held-item capacity`);
  }
  for (const itemId of inventory) {
    if (!itemGraph.getItem(itemId)) {
      throw new Error(`Full build plan v2: item ${itemId} is not in the catalog`);
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
  if (!item) {
    throw new Error(`Full build plan v2: item ${itemId} is not in the catalog`);
  }
  const maxCopies = item.maxCopies ?? 1;
  const copies = inventory.filter((heldItemId) => heldItemId === itemId).length;
  if (copies > maxCopies) {
    throw new Error(`Full build plan v2: item ${itemId} would exceed maxCopies`);
  }
}

function requireAvailableItem(
  itemId: number,
  rulesetId: string,
  itemGraph: RecommendationItemGraph,
) {
  const item = itemGraph.getItem(itemId);
  if (!item) {
    throw new Error(`Full build plan v2: item ${itemId} is not in the catalog`);
  }
  if (!item.availableRulesetIds.includes(rulesetId)) {
    throw new Error(`Full build plan v2: item ${itemId} is unavailable in ruleset ${rulesetId}`);
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
    throw new Error(`Full build plan v2: item ${itemId} does not support direct purchase`);
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
  return [...itemIds].sort((a, b) => a - b);
}

function validateItemId(itemId: number): void {
  if (!Number.isInteger(itemId) || itemId <= 0) {
    throw new Error(`Full build plan v2: invalid item id ${itemId}`);
  }
}
