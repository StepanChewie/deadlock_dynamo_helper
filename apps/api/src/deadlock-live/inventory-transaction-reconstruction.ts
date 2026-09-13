import {
  applyInventoryMultisetActionSequence,
  createInventoryMultiset,
  createInventoryStateKeyFromMultiset,
  type InventoryMultiset,
  type InventoryMultisetAction,
} from './inventory-multiset-action-engine';

export type InventoryTransactionReconstructionConfidence =
  | 'EXACT_SINGLE_ACTION'
  | 'MULTI_ACTION_INTERVAL'
  | 'AMBIGUOUS_MULTI_ACTION'
  | 'UNRESOLVED';

export type ReconstructedInventoryActionType = 'BUY' | 'SELL' | 'UPGRADE';

export interface ReconstructedInventoryAction {
  type: ReconstructedInventoryActionType;
  itemId: number;
  actionKey: string;
  componentItemIds?: number[];
}

export interface InventoryTransactionReconstructionResult {
  previousStateKey: string;
  currentStateKey: string;
  actions: ReconstructedInventoryAction[];
  actionKeys: string[];
  confidence: InventoryTransactionReconstructionConfidence;
  resolved: boolean;
  ambiguous: boolean;
}

interface UpgradePlanSearchResult {
  consumedComponentCount: number;
  upgradePlans: number[][];
}

const MAX_DISTINCT_OPTIMAL_PLANS = 2;

export function reconstructInventoryTransaction(
  previousItemIds: readonly number[],
  currentItemIds: readonly number[],
  recipeResolver: (parentItemId: number) => readonly number[],
): InventoryTransactionReconstructionResult {
  const previousItemCounts = createInventoryMultiset(previousItemIds);
  const currentItemCounts = createInventoryMultiset(currentItemIds);
  const previousStateKey = createInventoryStateKeyFromMultiset(
    previousItemCounts,
  );
  const currentStateKey = createInventoryStateKeyFromMultiset(currentItemCounts);

  if (previousStateKey === currentStateKey) {
    return createResult(
      previousStateKey,
      currentStateKey,
      [],
      true,
      false,
    );
  }

  const additions = subtractItemCounts(currentItemCounts, previousItemCounts);
  const removals = subtractItemCounts(previousItemCounts, currentItemCounts);
  const addedItemIds = expandItemCounts(additions);
  const planSearch = findOptimalUpgradePlans(
    addedItemIds,
    removals,
    recipeResolver,
  );
  const selectedUpgradeItemIds = planSearch.upgradePlans[0] ?? [];
  const remainingAdditions = new Map(additions);
  const remainingRemovals = new Map(removals);
  const actions: ReconstructedInventoryAction[] = [];

  for (const itemId of selectedUpgradeItemIds) {
    const componentItemIds = normalizeRecipe(
      recipeResolver(itemId),
      itemId,
    );
    if (
      !componentItemIds ||
      !decrementItemCount(remainingAdditions, itemId) ||
      !consumeItemCounts(remainingRemovals, componentItemIds)
    ) {
      return createResult(
        previousStateKey,
        currentStateKey,
        [],
        false,
        false,
      );
    }
    actions.push({
      type: 'UPGRADE',
      itemId,
      actionKey: `UPGRADE:${itemId}`,
      componentItemIds: [...componentItemIds],
    });
  }

  appendCountedActions(actions, remainingRemovals, 'SELL');
  appendCountedActions(actions, remainingAdditions, 'BUY');

  const replay = applyInventoryMultisetActionSequence(
    previousItemCounts,
    actions.map(toMultisetAction),
  );
  if (!replay.legal || replay.finalStateKey !== currentStateKey) {
    return createResult(
      previousStateKey,
      currentStateKey,
      actions,
      false,
      false,
    );
  }

  return createResult(
    previousStateKey,
    currentStateKey,
    actions,
    true,
    planSearch.upgradePlans.length > 1,
  );
}

function findOptimalUpgradePlans(
  addedItemIds: readonly number[],
  removals: InventoryMultiset,
  recipeResolver: (parentItemId: number) => readonly number[],
): UpgradePlanSearchResult {
  const memo = new Map<string, UpgradePlanSearchResult>();

  const visit = (
    index: number,
    availableRemovals: InventoryMultiset,
  ): UpgradePlanSearchResult => {
    if (index >= addedItemIds.length) {
      return { consumedComponentCount: 0, upgradePlans: [[]] };
    }

    const memoKey = `${index}:${createInventoryStateKeyFromMultiset(
      availableRemovals,
    )}`;
    const cached = memo.get(memoKey);
    if (cached) {
      return cached;
    }

    const itemId = addedItemIds[index];
    const buyResult = visit(index + 1, availableRemovals);
    let best: UpgradePlanSearchResult = {
      consumedComponentCount: buyResult.consumedComponentCount,
      upgradePlans: buyResult.upgradePlans.map((plan) => [...plan]),
    };

    const componentItemIds = normalizeRecipe(recipeResolver(itemId), itemId);
    if (componentItemIds && hasItemCounts(availableRemovals, componentItemIds)) {
      const remainingRemovals = new Map(availableRemovals);
      consumeItemCounts(remainingRemovals, componentItemIds);
      const upgradeResult = visit(index + 1, remainingRemovals);
      const candidate: UpgradePlanSearchResult = {
        consumedComponentCount:
          upgradeResult.consumedComponentCount + componentItemIds.length,
        upgradePlans: upgradeResult.upgradePlans.map((plan) => [
          itemId,
          ...plan,
        ]),
      };
      best = selectBetterPlanSearchResult(best, candidate);
    }

    const normalized = normalizePlanSearchResult(best);
    memo.set(memoKey, normalized);
    return normalized;
  };

  return visit(0, removals);
}

function selectBetterPlanSearchResult(
  left: UpgradePlanSearchResult,
  right: UpgradePlanSearchResult,
): UpgradePlanSearchResult {
  if (left.consumedComponentCount > right.consumedComponentCount) {
    return left;
  }
  if (right.consumedComponentCount > left.consumedComponentCount) {
    return right;
  }
  return {
    consumedComponentCount: left.consumedComponentCount,
    upgradePlans: [...left.upgradePlans, ...right.upgradePlans],
  };
}

function normalizePlanSearchResult(
  result: UpgradePlanSearchResult,
): UpgradePlanSearchResult {
  const uniquePlans = new Map<string, number[]>();
  for (const plan of result.upgradePlans) {
    const normalizedPlan = [...plan].sort((left, right) => left - right);
    uniquePlans.set(createUpgradePlanKey(normalizedPlan), normalizedPlan);
  }
  return {
    consumedComponentCount: result.consumedComponentCount,
    upgradePlans: [...uniquePlans.values()]
      .sort(compareUpgradePlans)
      .slice(0, MAX_DISTINCT_OPTIMAL_PLANS),
  };
}

function normalizeRecipe(
  componentItemIds: readonly number[],
  parentItemId: number,
): number[] | undefined {
  if (componentItemIds.length === 0) {
    return undefined;
  }
  const normalized = [...componentItemIds].sort((left, right) => left - right);
  if (
    normalized.some(
      (componentItemId) =>
        !Number.isSafeInteger(componentItemId) ||
        componentItemId <= 0 ||
        componentItemId === parentItemId,
    )
  ) {
    return undefined;
  }
  return normalized;
}

function subtractItemCounts(
  left: InventoryMultiset,
  right: InventoryMultiset,
): Map<number, number> {
  const result = new Map<number, number>();
  for (const [itemId, count] of left) {
    const difference = count - (right.get(itemId) ?? 0);
    if (difference > 0) {
      result.set(itemId, difference);
    }
  }
  return result;
}

function expandItemCounts(itemCounts: InventoryMultiset): number[] {
  const itemIds: number[] = [];
  for (const [itemId, count] of [...itemCounts.entries()].sort(
    ([leftItemId], [rightItemId]) => leftItemId - rightItemId,
  )) {
    for (let index = 0; index < count; index += 1) {
      itemIds.push(itemId);
    }
  }
  return itemIds;
}

function hasItemCounts(
  itemCounts: InventoryMultiset,
  requiredItemIds: readonly number[],
): boolean {
  const requiredCounts = createInventoryMultiset(requiredItemIds);
  return [...requiredCounts].every(
    ([itemId, requiredCount]) =>
      (itemCounts.get(itemId) ?? 0) >= requiredCount,
  );
}

function consumeItemCounts(
  itemCounts: Map<number, number>,
  consumedItemIds: readonly number[],
): boolean {
  if (!hasItemCounts(itemCounts, consumedItemIds)) {
    return false;
  }
  for (const itemId of consumedItemIds) {
    decrementItemCount(itemCounts, itemId);
  }
  return true;
}

function decrementItemCount(
  itemCounts: Map<number, number>,
  itemId: number,
): boolean {
  const count = itemCounts.get(itemId) ?? 0;
  if (count <= 0) {
    return false;
  }
  if (count === 1) {
    itemCounts.delete(itemId);
  } else {
    itemCounts.set(itemId, count - 1);
  }
  return true;
}

function appendCountedActions(
  actions: ReconstructedInventoryAction[],
  itemCounts: InventoryMultiset,
  type: 'BUY' | 'SELL',
): void {
  for (const itemId of expandItemCounts(itemCounts)) {
    actions.push({ type, itemId, actionKey: `${type}:${itemId}` });
  }
}

function toMultisetAction(
  action: ReconstructedInventoryAction,
): InventoryMultisetAction {
  return {
    type: action.type,
    itemId: action.itemId,
    componentItemIds: action.componentItemIds,
  };
}

function createResult(
  previousStateKey: string,
  currentStateKey: string,
  actions: ReconstructedInventoryAction[],
  resolved: boolean,
  ambiguous: boolean,
): InventoryTransactionReconstructionResult {
  const actionKeys = actions.map((action) => action.actionKey);
  return {
    previousStateKey,
    currentStateKey,
    actions: actions.map((action) => ({
      ...action,
      componentItemIds: action.componentItemIds
        ? [...action.componentItemIds]
        : undefined,
    })),
    actionKeys,
    confidence: resolveConfidence(actionKeys.length, resolved, ambiguous),
    resolved,
    ambiguous,
  };
}

function resolveConfidence(
  actionCount: number,
  resolved: boolean,
  ambiguous: boolean,
): InventoryTransactionReconstructionConfidence {
  if (!resolved || actionCount === 0) {
    return 'UNRESOLVED';
  }
  if (ambiguous) {
    return 'AMBIGUOUS_MULTI_ACTION';
  }
  return actionCount === 1
    ? 'EXACT_SINGLE_ACTION'
    : 'MULTI_ACTION_INTERVAL';
}

function createUpgradePlanKey(plan: readonly number[]): string {
  return plan.join(',');
}

function compareUpgradePlans(
  left: readonly number[],
  right: readonly number[],
): number {
  return createUpgradePlanKey(left).localeCompare(createUpgradePlanKey(right));
}
