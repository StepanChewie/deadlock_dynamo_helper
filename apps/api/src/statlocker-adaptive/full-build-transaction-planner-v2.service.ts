import { Injectable } from '@nestjs/common';
import { RecommendationItemGraph } from '@deadlock-live-probe/build-domain';
import { BuildArchetypeFamilyV2, BuildArchetypeV2 } from './build-archetype-v2';
import { DesiredBuildStateV2, DesiredFamilyStateV2 } from './build-desired-state-v2.service';
import {
  evaluateBuildFamilySatisfactionV2,
  isTerminalFamilySatisfactionV2,
} from './build-family-satisfaction-v2';
import { FullBuildTransitionIntentV2 } from './full-build-plan-v2';
import { simulateFullBuildInventoryV2 } from './full-build-inventory-simulator-v2';

export interface FullBuildTransactionPlannerV2Input {
  archetype: BuildArchetypeV2;
  desiredState: DesiredBuildStateV2;
  itemGraph: RecommendationItemGraph;
  rulesetId: string;
  capacity: number;
  currentInventoryItemIds: readonly number[];
}

export interface FullBuildTransactionPlannerV2Result {
  actions: readonly FullBuildTransitionIntentV2[];
  reasonCodes: readonly string[];
}

@Injectable()
export class FullBuildTransactionPlannerV2Service {
  plan(input: FullBuildTransactionPlannerV2Input): FullBuildTransactionPlannerV2Result {
    const actions: FullBuildTransitionIntentV2[] = [];
    const reasonCodes = new Set<string>();
    let projectedInventory = [...input.currentInventoryItemIds];

    const desiredFamilies = [...input.desiredState.families].sort(compareDesiredFamilies);
    for (const desiredFamily of desiredFamilies) {
      const family = input.archetype.families.find((entry) => entry.familyId === desiredFamily.familyId);
      if (!family) {
        reasonCodes.add('DESIRED_FAMILY_NOT_IN_ARCHETYPE');
        continue;
      }

      if (projectedInventory.includes(desiredFamily.selectedTerminalItemId)) continue;

      const progression = findObservedLineagePath(
        family,
        desiredFamily.selectedTerminalItemId,
        projectedInventory,
        input.itemGraph,
        input.rulesetId,
      );
      if (!progression) {
        reasonCodes.add('NO_LEGAL_OBSERVED_LINEAGE');
        continue;
      }

      if (!progression.heldItemId && projectedInventory.length >= input.capacity) {
        const replacement = this.findSafeReplacement(input, projectedInventory, desiredFamily, progression.path[0]);
        if (!replacement) {
          reasonCodes.add('REQUIRED_FAMILY_REGRESSION');
          continue;
        }

        const replaceAction: FullBuildTransitionIntentV2 = {
          action: 'REPLACE',
          sellItemId: replacement.sellItemId,
          buyItemId: progression.path[0],
          reasonCodes: ['FAMILY_ENTRY_REPLACEMENT'],
        };
        actions.push(replaceAction);
        projectedInventory = simulateOne(input, projectedInventory, replaceAction);
      } else if (!progression.heldItemId) {
        const buyAction: FullBuildTransitionIntentV2 = {
          action: 'BUY',
          buyItemId: progression.path[0],
          reasonCodes: ['FAMILY_ENTRY_PURCHASE'],
        };
        actions.push(buyAction);
        projectedInventory = simulateOne(input, projectedInventory, buyAction);
      }

      const startIndex = progression.heldItemId ? 1 : 1;
      for (let index = startIndex; index < progression.path.length; index += 1) {
        const previousItemId = progression.path[index - 1];
        const buyItemId = progression.path[index];
        const recipe = executableOneSlotRecipe(
          buyItemId,
          previousItemId,
          projectedInventory,
          input.itemGraph,
          input.rulesetId,
        );
        if (!recipe) {
          reasonCodes.add('NO_LEGAL_OBSERVED_LINEAGE');
          break;
        }

        const upgradeAction: FullBuildTransitionIntentV2 = {
          action: 'UPGRADE',
          buyItemId,
          recipeId: recipe.recipeId,
          reasonCodes: ['OBSERVED_FAMILY_UPGRADE'],
        };
        actions.push(upgradeAction);
        projectedInventory = simulateOne(input, projectedInventory, upgradeAction);
      }
    }

    return {
      actions,
      reasonCodes: [...reasonCodes].sort(),
    };
  }

  private findSafeReplacement(
    input: FullBuildTransactionPlannerV2Input,
    projectedInventory: readonly number[],
    desiredFamily: DesiredFamilyStateV2,
    buyItemId: number,
  ): { sellItemId: number } | undefined {
    const strategicHeldItems = input.archetype.families.flatMap((family) =>
      family.progressionNodes
        .map((node) => node.itemId)
        .filter((itemId) => projectedInventory.includes(itemId)),
    );

    for (const sellItemId of strategicHeldItems) {
      const sellFamily = input.archetype.families.find((family) =>
        family.progressionNodes.some((node) => node.itemId === sellItemId),
      );
      if (!sellFamily || sellFamily.familyId === desiredFamily.familyId) continue;

      const action: FullBuildTransitionIntentV2 = {
        action: 'REPLACE',
        sellItemId,
        buyItemId,
        reasonCodes: ['FAMILY_ENTRY_REPLACEMENT'],
      };
      const nextInventory = simulateOne(input, projectedInventory, action);
      if (requiredFamilyCount(input.archetype, nextInventory, input.itemGraph)
        < requiredFamilyCount(input.archetype, projectedInventory, input.itemGraph)) {
        continue;
      }
      return { sellItemId };
    }

    return undefined;
  }
}

function findObservedLineagePath(
  family: BuildArchetypeFamilyV2,
  terminalItemId: number,
  inventoryItemIds: readonly number[],
  itemGraph: RecommendationItemGraph,
  rulesetId: string,
): { heldItemId?: number; path: number[] } | undefined {
  const observedIds = new Set(family.progressionNodes.map((node) => node.itemId));
  if (!observedIds.has(terminalItemId)) return undefined;

  const heldCandidates = family.progressionNodes
    .map((node) => node.itemId)
    .filter((itemId) => inventoryItemIds.includes(itemId))
    .filter((itemId) => itemId === terminalItemId || itemGraph.isComponentAncestor(itemId, terminalItemId));

  const heldItemId = heldCandidates.sort((left, right) =>
    lineageDepth(right, terminalItemId, observedIds, itemGraph, rulesetId)
      - lineageDepth(left, terminalItemId, observedIds, itemGraph, rulesetId),
  )[0];

  if (heldItemId === terminalItemId) return { heldItemId, path: [heldItemId] };

  if (heldItemId) {
    const path = shortestObservedPath(heldItemId, terminalItemId, observedIds, itemGraph, rulesetId);
    return path ? { heldItemId, path } : undefined;
  }

  const entries = family.progressionNodes
    .filter((node) => node.progressionRole === 'ENTRY' || directPurchasable(node.itemId, itemGraph, rulesetId))
    .map((node) => node.itemId)
    .filter((itemId) => directPurchasable(itemId, itemGraph, rulesetId))
    .sort((a, b) => a - b);

  for (const entryItemId of entries) {
    const path = shortestObservedPath(entryItemId, terminalItemId, observedIds, itemGraph, rulesetId);
    if (path) return { path };
  }
  return undefined;
}

function shortestObservedPath(
  startItemId: number,
  targetItemId: number,
  observedIds: ReadonlySet<number>,
  itemGraph: RecommendationItemGraph,
  rulesetId: string,
): number[] | undefined {
  const queue: number[][] = [[startItemId]];
  const visited = new Set<number>([startItemId]);
  while (queue.length > 0) {
    const path = queue.shift()!;
    const current = path[path.length - 1];
    if (current === targetItemId) return path;

    for (const nextItemId of itemGraph.getDirectUpgradeIds(current)) {
      if (!observedIds.has(nextItemId) || visited.has(nextItemId)) continue;
      if (!executableOneSlotRecipe(nextItemId, current, [current], itemGraph, rulesetId)) continue;
      visited.add(nextItemId);
      queue.push([...path, nextItemId]);
    }
  }
  return undefined;
}

function executableOneSlotRecipe(
  buyItemId: number,
  consumedItemId: number,
  inventoryItemIds: readonly number[],
  itemGraph: RecommendationItemGraph,
  rulesetId: string,
) {
  const item = itemGraph.getItem(buyItemId);
  if (!item?.active || !item.availableRulesetIds.includes(rulesetId)) return undefined;
  return itemGraph.getExecutableUpgradeRecipes(buyItemId).find((recipe) =>
    recipe.consumedItemIds.length === 1
      && recipe.consumedItemIds[0] === consumedItemId
      && inventoryItemIds.includes(consumedItemId),
  );
}

function directPurchasable(itemId: number, itemGraph: RecommendationItemGraph, rulesetId: string): boolean {
  const item = itemGraph.getItem(itemId);
  return Boolean(
    item
      && item.active
      && item.availableRulesetIds.includes(rulesetId)
      && item.directPurchaseCost !== undefined,
  );
}

function lineageDepth(
  startItemId: number,
  targetItemId: number,
  observedIds: ReadonlySet<number>,
  itemGraph: RecommendationItemGraph,
  rulesetId: string,
): number {
  const path = shortestObservedPath(startItemId, targetItemId, observedIds, itemGraph, rulesetId);
  return path?.length ?? Number.MAX_SAFE_INTEGER;
}

function simulateOne(
  input: FullBuildTransactionPlannerV2Input,
  inventoryItemIds: readonly number[],
  action: FullBuildTransitionIntentV2,
): number[] {
  const result = simulateFullBuildInventoryV2({
    rulesetId: input.rulesetId,
    itemGraph: input.itemGraph,
    capacity: input.capacity,
    initialInventoryItemIds: inventoryItemIds,
    actions: [action],
  });
  return [...result.finalInventoryItemIds];
}

function requiredFamilyCount(
  archetype: BuildArchetypeV2,
  inventoryItemIds: readonly number[],
  itemGraph: RecommendationItemGraph,
): number {
  const statusByFamily = new Map(
    evaluateBuildFamilySatisfactionV2(archetype, inventoryItemIds, itemGraph)
      .map((entry) => [entry.familyId, entry.status] as const),
  );
  return archetype.families.filter((family) =>
    family.requirement === 'REQUIRED'
      && isTerminalFamilySatisfactionV2(statusByFamily.get(family.familyId) ?? 'UNSATISFIED'),
  ).length;
}

function compareDesiredFamilies(left: DesiredFamilyStateV2, right: DesiredFamilyStateV2): number {
  const priority = (value: DesiredFamilyStateV2['requirement']): number => {
    if (value === 'REQUIRED' || value === 'CHOICE') return 0;
    if (value === 'OPTIONAL') return 1;
    return 2;
  };
  return priority(left.requirement) - priority(right.requirement)
    || right.score - left.score
    || left.familyId - right.familyId;
}
