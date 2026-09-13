import { Injectable } from '@nestjs/common';
import { RecommendationItemGraph } from '@deadlock-live-probe/build-domain';
import {
  BuildArchetypeFamilyV2,
  BuildArchetypeV2,
  BuildObservedProgressionEdgeV2,
} from './build-archetype-v2';
import { DesiredBuildStateV2, DesiredFamilyStateV2 } from './build-desired-state-v2.service';
import {
  evaluateBuildFamilySatisfactionV2,
  isTerminalFamilySatisfactionV2,
} from './build-family-satisfaction-v2';
import { FullBuildTransitionIntentV2 } from './full-build-plan-v2';
import { simulateFullBuildInventoryV2 } from './full-build-inventory-simulator-v2';
import {
  FullBuildReplacementContextV2,
  FullBuildReplacementV2Service,
} from './full-build-replacement-v2.service';

export interface FullBuildTransactionPlannerV2Input {
  archetype: BuildArchetypeV2;
  desiredState: DesiredBuildStateV2;
  itemGraph: RecommendationItemGraph;
  rulesetId: string;
  capacity: number;
  currentInventoryItemIds: readonly number[];
  /** Matchup and lifecycle facts for the replacement service; the planner itself never queries repositories. */
  replacementContext?: FullBuildReplacementContextV2;
}

export interface FullBuildTransactionPlannerV2Result {
  actions: readonly FullBuildTransitionIntentV2[];
  reasonCodes: readonly string[];
}

interface PendingFamilyProgressionV2 {
  desiredFamily: DesiredFamilyStateV2;
  family: BuildArchetypeFamilyV2;
  path: readonly number[];
  timingByItemId: ReadonlyMap<number, number>;
  nextIndex: number;
  blocked: boolean;
}

interface ConfirmedProgressionPathV2 {
  heldItemId?: number;
  path: readonly number[];
  timingByItemId: ReadonlyMap<number, number>;
}

@Injectable()
export class FullBuildTransactionPlannerV2Service {
  constructor(private readonly replacement?: FullBuildReplacementV2Service) {}

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

      const hasConfirmedLineage = hasConfirmedProgressionToTarget(
        family,
        desiredFamily.selectedTerminalItemId,
      );
      const confirmed = hasConfirmedLineage
        ? findConfirmedProgressionPath(
            family,
            desiredFamily.selectedTerminalItemId,
            projectedInventory,
            input.itemGraph,
            input.rulesetId,
          )
        : undefined;

      if (confirmed) {
        pending.push({
          desiredFamily,
          family,
          path: confirmed.path,
          timingByItemId: confirmed.timingByItemId,
          nextIndex: confirmed.heldItemId === undefined ? 0 : 1,
          blocked: false,
        });
        continue;
      }

      if (hasConfirmedLineage) {
        reasonCodes.add('CONFIRMED_PROGRESSION_RECIPE_UNAVAILABLE');
        continue;
      }

      if (!verifiedDirectPurchasable(
        desiredFamily.selectedTerminalItemId,
        input.itemGraph,
        input.rulesetId,
      )) {
        reasonCodes.add('NO_LEGAL_OBSERVED_LINEAGE');
        continue;
      }

      const standaloneTiming = family.progressionNodes.find(
        (node) => node.itemId === desiredFamily.selectedTerminalItemId,
      )?.timing.medianBuyTimeS ?? Number.MAX_SAFE_INTEGER;
      pending.push({
        desiredFamily,
        family,
        path: [desiredFamily.selectedTerminalItemId],
        timingByItemId: new Map([[desiredFamily.selectedTerminalItemId, standaloneTiming]]),
        nextIndex: 0,
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
        // A standalone goal whose mechanics recipe consumes an already-held
        // component executes as an in-place UPGRADE: the component's slot is
        // reused, no replacement runs, and the component never counts as an
        // extra item on top of the pending goal.
        const heldRecipe = executableUpgradeFromHeldComponents(
          buyItemId,
          projectedInventory,
          input.itemGraph,
          input.rulesetId,
        );
        if (heldRecipe) {
          action = {
            action: 'UPGRADE',
            buyItemId,
            recipeId: heldRecipe.recipeId,
            reasonCodes: ['HELD_COMPONENT_UPGRADE'],
          };
        } else if (projectedInventory.length === input.capacity) {
          // New family-entry BUY at full capacity: replacement may run.
          action = this.replaceAtCapacity(
            input,
            pending,
            projectedInventory,
            next,
            buyItemId,
            reasonCodes,
          );
          if (!action) continue;
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
          reasonCodes.add('CONFIRMED_PROGRESSION_RECIPE_UNAVAILABLE');
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

  /**
   * New family-entry BUY at exactly full capacity. The sell decision is
   * delegated to FullBuildReplacementV2Service; the planner only derives the
   * active-progression protection set and applies the blocked policy. When the
   * planner is constructed without the replacement service (legacy direct
   * construction), the previous conservative local guard is preserved.
   */
  private replaceAtCapacity(
    input: FullBuildTransactionPlannerV2Input,
    pending: readonly PendingFamilyProgressionV2[],
    projectedInventory: readonly number[],
    next: PendingFamilyProgressionV2,
    buyItemId: number,
    reasonCodes: Set<string>,
  ): FullBuildTransitionIntentV2 | undefined {
    if (!this.replacement) {
      const legacy = this.findSafeReplacement(
        input,
        input.archetype.families ?? [],
        projectedInventory,
        next.desiredFamily,
        buyItemId,
      );
      if (!legacy) {
        reasonCodes.add('REQUIRED_FAMILY_REGRESSION');
        next.blocked = true;
        return undefined;
      }
      return {
        action: 'REPLACE',
        sellItemId: legacy.sellItemId,
        buyItemId,
        reasonCodes: ['FAMILY_ENTRY_REPLACEMENT'],
      };
    }

    const decision = this.replacement.decide({
      archetype: input.archetype,
      desiredFamily: next.desiredFamily,
      buyItemId,
      projectedInventoryItemIds: projectedInventory,
      activeProgressionProtectedItemIds: activeProgressionProtectedItemIds(pending, projectedInventory),
      itemGraph: input.itemGraph,
      rulesetId: input.rulesetId,
      context: input.replacementContext ?? emptyReplacementContext(),
    });
    if (decision.kind === 'BLOCKED') {
      reasonCodes.add('CAPACITY_BLOCKED_NO_SAFE_REPLACEMENT');
      for (const reasonCode of decision.reasonCodes) reasonCodes.add(reasonCode);
      next.blocked = true;
      return undefined;
    }
    return {
      action: 'REPLACE',
      sellItemId: decision.sellItemId,
      buyItemId,
      reasonCodes: [...new Set(['FAMILY_ENTRY_REPLACEMENT', ...decision.reasonCodes])],
    };
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

/**
 * Held items that a still-pending confirmed progression consumes at a future
 * accepted edge/UPGRADE step: every non-blocked pending goal contributes the
 * from-items of its remaining confirmed steps when they are currently held.
 * Held items that are not such sources stay unprotected even when they are
 * components that were already consumed elsewhere.
 */
function activeProgressionProtectedItemIds(
  pending: readonly PendingFamilyProgressionV2[],
  projectedInventory: readonly number[],
): ReadonlySet<number> {
  const protectedIds = new Set<number>();
  for (const entry of pending) {
    if (entry.blocked) continue;
    const edges = entry.family.progressionEdges ?? [];
    if (edges.length === 0) continue;
    for (let index = Math.max(1, entry.nextIndex); index < entry.path.length; index += 1) {
      const consumedItemId = entry.path[index - 1];
      const edge = edges.find((candidate) =>
        candidate.fromItemId === consumedItemId && candidate.toItemId === entry.path[index],
      );
      if (edge && projectedInventory.includes(consumedItemId)) protectedIds.add(consumedItemId);
    }
  }
  return protectedIds;
}

/**
 * Fallback context for planners called without replacement facts: the
 * replacement service then only sees empty matchup and lifecycle evidence and
 * fails closed instead of selling blindly.
 */
function emptyReplacementContext(): FullBuildReplacementContextV2 {
  return {
    heroId: 0,
    gameTimeSec: 0,
    enemyHeroIds: [],
    enemyThreats: [],
    vsHeroRows: [],
    lifecycleEvidence: [],
  };
}

function progressionTime(entry: PendingFamilyProgressionV2): number {
  const itemId = entry.path[entry.nextIndex];
  return entry.timingByItemId.get(itemId) ?? Number.MAX_SAFE_INTEGER;
}

function requirementPriority(value: DesiredFamilyStateV2['requirement']): number {
  if (value === 'REQUIRED' || value === 'CHOICE') return 0;
  if (value === 'OPTIONAL') return 1;
  return 2;
}

function hasConfirmedProgressionToTarget(
  family: BuildArchetypeFamilyV2,
  targetItemId: number,
): boolean {
  const edges = family.progressionEdges ?? [];
  if (edges.length === 0) return false;
  const reverse = new Map<number, number[]>();
  for (const edge of edges) {
    const values = reverse.get(edge.toItemId) ?? [];
    values.push(edge.fromItemId);
    reverse.set(edge.toItemId, values);
  }
  const pending = [targetItemId];
  const visited = new Set<number>([targetItemId]);
  while (pending.length > 0) {
    const current = pending.shift()!;
    for (const previous of reverse.get(current) ?? []) {
      if (previous !== targetItemId) return true;
      if (visited.has(previous)) continue;
      visited.add(previous);
      pending.push(previous);
    }
  }
  return false;
}

function findConfirmedProgressionPath(
  family: BuildArchetypeFamilyV2,
  terminalItemId: number,
  inventoryItemIds: readonly number[],
  itemGraph: RecommendationItemGraph,
  rulesetId: string,
): ConfirmedProgressionPathV2 | undefined {
  const edges = family.progressionEdges ?? [];
  if (edges.length === 0) return undefined;

  const heldCandidates = family.progressionNodes
    .map((node) => node.itemId)
    .filter((itemId) => inventoryItemIds.includes(itemId) && itemId !== terminalItemId)
    .map((itemId) => ({
      itemId,
      path: shortestConfirmedExecutablePath(itemId, terminalItemId, edges, itemGraph, rulesetId),
    }))
    .filter((entry): entry is { itemId: number; path: number[] } => Boolean(entry.path))
    .sort((left, right) => left.path.length - right.path.length || left.itemId - right.itemId);

  if (heldCandidates.length > 0) {
    const selected = heldCandidates[0];
    return {
      heldItemId: selected.itemId,
      path: selected.path,
      timingByItemId: timingMapForPath(selected.path, edges),
    };
  }

  const ancestors = confirmedAncestorsOf(terminalItemId, edges);
  const roots = [...ancestors]
    .filter((itemId) => itemId !== terminalItemId)
    .filter((itemId) => !edges.some((edge) =>
      edge.toItemId === itemId && ancestors.has(edge.fromItemId),
    ))
    .sort((left, right) =>
      confirmedStartTiming(left, edges) - confirmedStartTiming(right, edges) || left - right,
    );

  for (const rootItemId of roots) {
    if (!verifiedDirectPurchasable(rootItemId, itemGraph, rulesetId)) continue;
    const path = shortestConfirmedExecutablePath(
      rootItemId,
      terminalItemId,
      edges,
      itemGraph,
      rulesetId,
    );
    if (!path) continue;
    return {
      path,
      timingByItemId: timingMapForPath(path, edges),
    };
  }

  return undefined;
}

function confirmedAncestorsOf(
  targetItemId: number,
  edges: readonly BuildObservedProgressionEdgeV2[],
): Set<number> {
  const result = new Set<number>([targetItemId]);
  const pending = [targetItemId];
  while (pending.length > 0) {
    const current = pending.shift()!;
    for (const edge of edges) {
      if (edge.toItemId !== current || result.has(edge.fromItemId)) continue;
      result.add(edge.fromItemId);
      pending.push(edge.fromItemId);
    }
  }
  return result;
}

function shortestConfirmedExecutablePath(
  startItemId: number,
  targetItemId: number,
  edges: readonly BuildObservedProgressionEdgeV2[],
  itemGraph: RecommendationItemGraph,
  rulesetId: string,
): number[] | undefined {
  const queue: number[][] = [[startItemId]];
  const visited = new Set<number>([startItemId]);
  while (queue.length > 0) {
    const path = queue.shift()!;
    const current = path[path.length - 1];
    if (current === targetItemId) return path;
    const nextEdges = edges
      .filter((edge) => edge.fromItemId === current)
      .sort((left, right) => left.toItemId - right.toItemId);
    for (const edge of nextEdges) {
      if (visited.has(edge.toItemId)) continue;
      if (!executableOneSlotRecipe(edge.toItemId, current, [current], itemGraph, rulesetId)) continue;
      visited.add(edge.toItemId);
      queue.push([...path, edge.toItemId]);
    }
  }
  return undefined;
}

function timingMapForPath(
  path: readonly number[],
  edges: readonly BuildObservedProgressionEdgeV2[],
): ReadonlyMap<number, number> {
  const result = new Map<number, number>();
  for (let index = 1; index < path.length; index += 1) {
    const fromItemId = path[index - 1];
    const toItemId = path[index];
    const edge = edges.find((candidate) =>
      candidate.fromItemId === fromItemId && candidate.toItemId === toItemId,
    );
    if (!edge) continue;
    if (index === 1) result.set(fromItemId, edge.timing.fromMedianBuyTimeS);
    result.set(toItemId, edge.timing.toMedianBuyTimeS);
  }
  return result;
}

function confirmedStartTiming(
  itemId: number,
  edges: readonly BuildObservedProgressionEdgeV2[],
): number {
  return edges
    .filter((edge) => edge.fromItemId === itemId)
    .map((edge) => edge.timing.fromMedianBuyTimeS)
    .sort((a, b) => a - b)[0] ?? Number.MAX_SAFE_INTEGER;
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

function executableUpgradeFromHeldComponents(
  buyItemId: number,
  inventoryItemIds: readonly number[],
  itemGraph: RecommendationItemGraph,
  rulesetId: string,
) {
  for (const recipe of itemGraph.getExecutableUpgradeRecipes(buyItemId)) {
    if (recipe.consumedItemIds.length !== 1) continue;
    const executable = executableOneSlotRecipe(
      buyItemId,
      recipe.consumedItemIds[0],
      inventoryItemIds,
      itemGraph,
      rulesetId,
    );
    if (executable) return executable;
  }
  return undefined;
}

function verifiedDirectPurchasable(
  itemId: number,
  itemGraph: RecommendationItemGraph,
  rulesetId: string,
): boolean {
  const item = itemGraph.getItem(itemId);
  return Boolean(
    item
      && item.availableRulesetIds.includes(rulesetId)
      && item.directPurchaseCost !== undefined,
  );
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
