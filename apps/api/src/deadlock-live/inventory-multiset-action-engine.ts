export const EMPTY_INVENTORY_MULTISET_STATE_KEY = 'EMPTY';

export type InventoryMultiset = ReadonlyMap<number, number>;

export type InventoryMultisetActionType =
  | 'BUY'
  | 'REBUY'
  | 'SELL'
  | 'UPGRADE'
  | 'HOLD';

export type InventoryMultisetActionRejectionReason =
  | 'INVALID_ITEM_ID'
  | 'INVALID_OWNED_COUNT_LIMIT'
  | 'OWNED_COUNT_LIMIT_REACHED'
  | 'ITEM_NOT_OWNED'
  | 'RECIPE_COMPONENTS_ABSENT'
  | 'INVALID_RECIPE_COMPONENT'
  | 'MISSING_RECIPE_COMPONENT';

export interface InventoryMultisetAction {
  type: InventoryMultisetActionType;
  itemId?: number;
  componentItemIds?: readonly number[];
  maxOwnedCount?: number;
}

export interface InventoryMultisetActionResult {
  legal: boolean;
  action: InventoryMultisetAction;
  previousStateKey: string;
  nextStateKey: string;
  nextItemCounts: Map<number, number>;
  rejectionReason?: InventoryMultisetActionRejectionReason;
  missingItemId?: number;
  requiredCount?: number;
  availableCount?: number;
}

export interface InventoryMultisetActionSequenceResult {
  legal: boolean;
  steps: InventoryMultisetActionResult[];
  finalItemCounts: Map<number, number>;
  finalStateKey: string;
  failedActionIndex?: number;
}

export function createInventoryMultiset(
  itemIds: readonly number[],
): Map<number, number> {
  const itemCounts = new Map<number, number>();
  for (const itemId of itemIds) {
    if (!isPositiveSafeInteger(itemId)) {
      continue;
    }
    itemCounts.set(itemId, (itemCounts.get(itemId) ?? 0) + 1);
  }
  return itemCounts;
}

export function createInventoryStateKeyFromItemIds(
  itemIds: readonly number[],
): string {
  return createInventoryStateKeyFromMultiset(createInventoryMultiset(itemIds));
}

export function createInventoryStateKeyFromMultiset(
  itemCounts: InventoryMultiset,
): string {
  const tokens = [...itemCounts.entries()]
    .filter(
      ([itemId, count]) =>
        isPositiveSafeInteger(itemId) && isPositiveSafeInteger(count),
    )
    .sort(([leftItemId], [rightItemId]) => leftItemId - rightItemId)
    .map(([itemId, count]) => `${itemId}x${count}`);
  return tokens.join('|') || EMPTY_INVENTORY_MULTISET_STATE_KEY;
}

export function parseInventoryStateKey(
  stateKey: string,
): InventoryMultiset | undefined {
  if (stateKey === EMPTY_INVENTORY_MULTISET_STATE_KEY) {
    return new Map<number, number>();
  }
  if (stateKey.length === 0) {
    return undefined;
  }

  const itemCounts = new Map<number, number>();
  for (const token of stateKey.split('|')) {
    const match = /^([1-9][0-9]*)x([1-9][0-9]*)$/.exec(token);
    if (!match) {
      return undefined;
    }
    const itemId = Number(match[1]);
    const count = Number(match[2]);
    if (!isPositiveSafeInteger(itemId) || !isPositiveSafeInteger(count)) {
      return undefined;
    }
    if (itemCounts.has(itemId)) {
      return undefined;
    }
    itemCounts.set(itemId, count);
  }
  return itemCounts;
}

export function getInventoryItemCount(
  itemCounts: InventoryMultiset,
  itemId: number,
): number {
  return itemCounts.get(itemId) ?? 0;
}

export function applyInventoryMultisetAction(
  currentItemCounts: InventoryMultiset,
  action: InventoryMultisetAction,
): InventoryMultisetActionResult {
  const previousStateKey = createInventoryStateKeyFromMultiset(currentItemCounts);
  const nextItemCounts = cloneInventoryMultiset(currentItemCounts);

  if (action.type === 'HOLD') {
    return createLegalResult(action, previousStateKey, nextItemCounts);
  }

  if (!isPositiveSafeInteger(action.itemId)) {
    return createRejectedResult(
      action,
      previousStateKey,
      nextItemCounts,
      'INVALID_ITEM_ID',
    );
  }
  const itemId = action.itemId;

  if (action.type === 'BUY' || action.type === 'REBUY') {
    if (
      action.maxOwnedCount !== undefined &&
      !isPositiveSafeInteger(action.maxOwnedCount)
    ) {
      return createRejectedResult(
        action,
        previousStateKey,
        nextItemCounts,
        'INVALID_OWNED_COUNT_LIMIT',
      );
    }
    const currentOwnedCount = getInventoryItemCount(nextItemCounts, itemId);
    if (
      action.maxOwnedCount !== undefined &&
      currentOwnedCount >= action.maxOwnedCount
    ) {
      return createRejectedResult(
        action,
        previousStateKey,
        nextItemCounts,
        'OWNED_COUNT_LIMIT_REACHED',
      );
    }
    incrementItemCount(nextItemCounts, itemId);
    return createLegalResult(action, previousStateKey, nextItemCounts);
  }

  if (action.type === 'SELL') {
    if (!decrementItemCount(nextItemCounts, itemId)) {
      return createRejectedResult(
        action,
        previousStateKey,
        nextItemCounts,
        'ITEM_NOT_OWNED',
      );
    }
    return createLegalResult(action, previousStateKey, nextItemCounts);
  }

  const componentItemIds = action.componentItemIds ?? [];
  if (componentItemIds.length === 0) {
    return createRejectedResult(
      action,
      previousStateKey,
      nextItemCounts,
      'RECIPE_COMPONENTS_ABSENT',
    );
  }
  const requiredCounts = new Map<number, number>();
  for (const componentItemId of componentItemIds) {
    if (!isPositiveSafeInteger(componentItemId) || componentItemId === itemId) {
      return createRejectedResult(
        action,
        previousStateKey,
        nextItemCounts,
        'INVALID_RECIPE_COMPONENT',
      );
    }
    requiredCounts.set(
      componentItemId,
      (requiredCounts.get(componentItemId) ?? 0) + 1,
    );
  }
  for (const [componentItemId, requiredCount] of requiredCounts) {
    const availableCount = getInventoryItemCount(
      nextItemCounts,
      componentItemId,
    );
    if (availableCount < requiredCount) {
      return {
        ...createRejectedResult(
          action,
          previousStateKey,
          nextItemCounts,
          'MISSING_RECIPE_COMPONENT',
        ),
        missingItemId: componentItemId,
        requiredCount,
        availableCount,
      };
    }
  }
  for (const [componentItemId, requiredCount] of requiredCounts) {
    for (let index = 0; index < requiredCount; index += 1) {
      decrementItemCount(nextItemCounts, componentItemId);
    }
  }
  incrementItemCount(nextItemCounts, itemId);
  return createLegalResult(action, previousStateKey, nextItemCounts);
}

export function applyInventoryMultisetActionSequence(
  initialItemCounts: InventoryMultiset,
  actions: readonly InventoryMultisetAction[],
): InventoryMultisetActionSequenceResult {
  let currentItemCounts = cloneInventoryMultiset(initialItemCounts);
  const steps: InventoryMultisetActionResult[] = [];

  for (const [index, action] of actions.entries()) {
    const result = applyInventoryMultisetAction(currentItemCounts, action);
    steps.push(result);
    if (!result.legal) {
      return {
        legal: false,
        steps,
        finalItemCounts: currentItemCounts,
        finalStateKey: createInventoryStateKeyFromMultiset(currentItemCounts),
        failedActionIndex: index,
      };
    }
    currentItemCounts = result.nextItemCounts;
  }

  return {
    legal: true,
    steps,
    finalItemCounts: currentItemCounts,
    finalStateKey: createInventoryStateKeyFromMultiset(currentItemCounts),
  };
}

function cloneInventoryMultiset(
  itemCounts: InventoryMultiset,
): Map<number, number> {
  return new Map(
    [...itemCounts.entries()].filter(
      ([itemId, count]) =>
        isPositiveSafeInteger(itemId) && isPositiveSafeInteger(count),
    ),
  );
}

function createLegalResult(
  action: InventoryMultisetAction,
  previousStateKey: string,
  nextItemCounts: Map<number, number>,
): InventoryMultisetActionResult {
  return {
    legal: true,
    action: { ...action },
    previousStateKey,
    nextStateKey: createInventoryStateKeyFromMultiset(nextItemCounts),
    nextItemCounts,
  };
}

function createRejectedResult(
  action: InventoryMultisetAction,
  previousStateKey: string,
  nextItemCounts: Map<number, number>,
  rejectionReason: InventoryMultisetActionRejectionReason,
): InventoryMultisetActionResult {
  return {
    legal: false,
    action: { ...action },
    previousStateKey,
    nextStateKey: previousStateKey,
    nextItemCounts,
    rejectionReason,
  };
}

function incrementItemCount(
  itemCounts: Map<number, number>,
  itemId: number,
): void {
  itemCounts.set(itemId, (itemCounts.get(itemId) ?? 0) + 1);
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

function isPositiveSafeInteger(value: number | undefined): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}
