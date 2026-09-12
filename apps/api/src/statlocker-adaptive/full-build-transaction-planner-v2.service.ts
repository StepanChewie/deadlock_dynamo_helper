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

interface PendingFamilyProgressionV2 {
  desiredFamily: DesiredFamilyStateV2;
  family: BuildArchetypeFamilyV2;
  path: readonly number[];
  nextIndex: number;
  blocked: boolean;
}

@Injectable()
export class FullBuildTransactionPlannerV2Service {
  plan(input: FullBuildTransactionPlannerV2Input): FullBuildTransactionPlannerV2Result {
    const actions: FullBuildTransitionIntentV2[] = [];
    const reasonCodes = new Set<string>();
    const families = input.archetype.families ?? [];
    let projectedInventory = [...input.currentInventoryItemIds];
    const pending: PendingFamilyProgressionV2[] = [];

    for (const desiredFamily of input.desiredState.families) {
      const family = families.find((entry) => entry.familyId === desiredFamily.familyId);
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
      pending.push({
        desiredFamily,
        family,
        path: progression.path,
        nextIndex: progression.heldItemId === undefined ? 0 : 1,
        blocked: false,
      });
    }

    while (true) {
      const next = pending
        .filter((entry) => !entry.blocked && entry.nextIndex < entry.path.length)
        .sort(comparePendingProgressions)[0];
      if (!next) break;

      const buyItemId = next.path[next.nextIndex];
      let action: FullBuildTransitionIntentV2 | undefined;

      if (next.nextIndex === 0) {
        if (projectedInventory.length >= input.capacity) {
          const replacement = this.findSafeReplacement(
            input,
            families,
            projectedInventory,
            next.desiredFamily,
            buyItemId,
          );
          if (!replacement) {
            reasonCodes.add('REQUIRED_FAMILY_REGRESSION');
            next.blocked = true;
            continue;
          }
          action = {
            action: 'REPLACE',
            sellItemId: replacement.sellItemId,
            buyItemId,
            reasonCodes: ['FAMILY_ENTRY_REPLACEMENT'],
          };
        } else {
          action = {
            action: 'BUY',
            buyItemId,
            reasonCodes: ['FAMILY_ENTRY_PURCHASE'],
          };
        }
      } else {
        const previousItemId = next.path[next.nextIndex - 1];
        const recipe = executableOneSlotRecipe(
          buyItemId,
          previousItemId,
          projectedInventory,
          input.itemGraph,
          input.rulesetId,
        );
        if (!recipe) {
          reasonCodes.add('NO_LEGAL_OBSERVED_LINEAGE');
          next.blocked = true;
          continue;
        }
        action = {
          action: 'UPGRADE',
          buyItemId,
          recipeId: recipe.recipeId,
          reasonCodes: ['OBSERVED_FAMILY_UPGRADE'],
        };
      }

      actions.push(action);
      projectedInventory = simulateOne(input, projectedInventory, action);
      next.nextIndex += 1;
    }

    return { actions, reasonCodes: [...reasonCodes].sort() };
  }

  private findSafeReplacement(
    input: FullBuildTransactionPlannerV2Input,
    families: readonly BuildArchetypeFamilyV2[],
    projectedInventory: readonly number[],
    desiredFamily: DesiredFamilyStateV2,
    buyItemId: number,
  ): { sellItemId: number } | undefined {
    const strategicHeldItems = families.flatMap((family) =>
      family.progressionNodes
        .map((node) => node.itemId)
        .filter((itemId) => projectedInventory.includes(itemId)),
    );

    for (const sellItemId of strategicHeldItems) {
      const sellFamily = families.find((family) =>
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
      const beforeRequired = satisfiedRequiredFamilyIds(
        input.archetype,
        projectedInventory,
        input.itemGraph,
      );
      const afterRequired = satisfiedRequiredFamilyIds(
        input.archetype,
        nextInventory,
        input.itemGraph,
      );
      if ([...beforeRequired].some((familyId) => !afterRequired.has(familyId))) continue;
      return { sellItemId };
    }

    return undefined;
  }
}

function comparePendingProgressions(
  left: PendingFamilyProgressionV2,
  right: PendingFamilyProgressionV2,
): number {
  return progressionTime(left) - progressionTime(right)
    || requirementPriority(left.desiredFamily.requirement) - requirementPriority(right.desiredFamily.requirement)
    || left.family.familyId - right.family.familyId
    || left.path[left.nextIndex] - right.path[right.nextIndex];
}

function progressionTime(entry: PendingFamilyProgressionV2): number {
  const itemId = entry.path[entry.nextIndex];
  return entry.family.progressionNodes.find((node) => node.itemId === itemId)?.timing.medianBuyTimeS
    ?? Number.MAX_SAFE_INTEGER;
}

function requirementPriority(value: DesiredFamilyStateV2['requirement']): number {
  if (value === 'REQUIRED' || value === 'CHOICE') return 0;
  if (value === 'OPTIONAL') return 1;
  return 2;
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

  const heldItemId = family.progressionNodes
    .map((node) => node.itemId)
    .filter((itemId) => inventoryItemIds.includes(itemId))
    .filter((itemId) => itemId === terminalItemId || itemGraph.isComponentAncestor(itemId, terminalItemId))
    .sort((left, right) =>
      lineageDepth(left, terminalItemId, observedIds, itemGraph, rulesetId)
        - lineageDepth(right, terminalItemId, observedIds, itemGraph, rulesetId),
    )[0];

  if (heldItemId === terminalItemId) return { heldItemId, path: [heldItemId] };
  if (heldItemId !== undefined) {
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
  if (!item || !item.availableRulesetIds.includes(rulesetId)) return undefined;
  return itemGraph.getExecutableUpgradeRecipes(buyItemId).find((recipe) =>
    recipe.consumedItemIds.length === 1
      && recipe.consumedItemIds[0] === consumedItemId
      && inventoryItemIds.includes(consumedItemId),
  );
}

function directPurchasable(itemId: number, itemGraph: RecommendationItemGraph, rulesetId: string): boolean {
  const item = itemGraph.getItem(itemId);
  return Boolean(item && item.availableRulesetIds.includes(rulesetId) && item.directPurchaseCost !== undefined);
}

function lineageDepth(
  startItemId: number,
  targetItemId: number,
  observedIds: ReadonlySet<number>,
  itemGraph: RecommendationItemGraph,
  rulesetId: string,
): number {
  return shortestObservedPath(startItemId, targetItemId, observedIds, itemGraph, rulesetId)?.length
    ?? Number.MAX_SAFE_INTEGER;
}

function simulateOne(
  input: FullBuildTransactionPlannerV2Input,
  inventoryItemIds: readonly number[],
  action: FullBuildTransitionIntentV2,
): number[] {
  return [...simulateFullBuildInventoryV2({
    rulesetId: input.rulesetId,
    itemGraph: input.itemGraph,
    capacity: input.capacity,
    initialInventoryItemIds: inventoryItemIds,
    actions: [action],
  }).finalInventoryItemIds];
}

function satisfiedRequiredFamilyIds(
  archetype: BuildArchetypeV2,
  inventoryItemIds: readonly number[],
  itemGraph: RecommendationItemGraph,
): ReadonlySet<number> {
  const statusByFamily = new Map(
    evaluateBuildFamilySatisfactionV2(archetype, inventoryItemIds, itemGraph)
      .map((entry) => [entry.familyId, entry.status] as const),
  );
  return new Set(
    (archetype.families ?? [])
      .filter((family) =>
        family.requirement === 'REQUIRED'
          && isTerminalFamilySatisfactionV2(statusByFamily.get(family.familyId) ?? 'UNSATISFIED'),
      )
      .map((family) => family.familyId),
  );
}
