import {
  InventoryAction,
  InventoryAcquisitionType,
  InventoryItem,
  InventoryItemInstance,
  InventoryReducerResult,
  InventoryRuleset,
  InventorySlotType,
  InventoryState,
  InventoryValidationError,
  RecipeGraph,
} from './types';

export const DEFAULT_INVENTORY_RULESET: InventoryRuleset = {
  duplicateItemsAllowed: false,
  baseSlotsByType: {
    weapon: 0,
    vitality: 0,
    spirit: 0,
  },
  maxFlexSlots: 12,
};

export interface InventoryReducerContext {
  recipeGraph: RecipeGraph;
  ruleset?: InventoryRuleset;
}

export function createEmptyInventoryState(): InventoryState {
  return {
    initializedFromSnapshot: false,
    heldByItemId: new Map(),
    lifecycleCountByItemId: new Map(),
    nextInstanceSequence: 1,
  };
}

export function getHeldItemIds(state: InventoryState): number[] {
  return [...state.heldByItemId.keys()].sort((a, b) => a - b);
}

export function cloneInventoryState(state: InventoryState): InventoryState {
  return {
    initializedFromSnapshot: state.initializedFromSnapshot,
    heldByItemId: new Map(state.heldByItemId),
    lifecycleCountByItemId: new Map(state.lifecycleCountByItemId),
    nextInstanceSequence: state.nextInstanceSequence,
  };
}

export function applyInventoryAction(
  state: InventoryState,
  action: InventoryAction,
  context: InventoryReducerContext,
): InventoryReducerResult {
  const ruleset = context.ruleset ?? DEFAULT_INVENTORY_RULESET;

  switch (action.type) {
    case 'RECONCILE':
      return reconcile(state, action.items, action.metadata.observedAtMs, action.metadata.gameTimeSec, ruleset);
    case 'BUY':
      return acquire(state, action.item, 'BUY', action.metadata.observedAtMs, action.metadata.gameTimeSec, ruleset);
    case 'REBUY':
      if ((state.lifecycleCountByItemId.get(action.item.itemId) ?? 0) === 0) {
        return failure(state, {
          code: 'ITEM_NOT_PREVIOUSLY_OWNED',
          message: `Item ${action.item.itemId} cannot be rebought before it has been owned.`,
          itemIds: [action.item.itemId],
        });
      }
      return acquire(state, action.item, 'REBUY', action.metadata.observedAtMs, action.metadata.gameTimeSec, ruleset);
    case 'UPGRADE':
      return upgrade(state, action, context.recipeGraph, ruleset);
    case 'SELL':
    case 'CONSUME':
      return removeItems(state, [action.itemId]);
    case 'UNKNOWN_REMOVE':
      return removeItems(state, action.itemIds);
    case 'USE':
    case 'HOLD':
      if (!state.heldByItemId.has(action.itemId)) {
        return failure(state, {
          code: 'ITEM_NOT_OWNED',
          message: `Item ${action.itemId} is not currently held.`,
          itemIds: [action.itemId],
        });
      }
      return { ok: true, state };
  }
}

function reconcile(
  state: InventoryState,
  items: readonly InventoryItem[],
  observedAtMs: number,
  gameTimeSec: number | undefined,
  ruleset: InventoryRuleset,
): InventoryReducerResult {
  const duplicateIds = findDuplicateIds(items.map((item) => item.itemId));
  if (!ruleset.duplicateItemsAllowed && duplicateIds.length > 0) {
    return failure(state, {
      code: 'DUPLICATE_ITEM_NOT_ALLOWED',
      message: `Snapshot contains duplicate item ids: ${duplicateIds.join(', ')}.`,
      itemIds: duplicateIds,
    });
  }

  const held = new Map<number, InventoryItemInstance>();
  const lifecycleCounts = new Map(state.lifecycleCountByItemId);
  let nextSequence = state.nextInstanceSequence;

  for (const item of items) {
    const existing = state.heldByItemId.get(item.itemId);
    if (existing) {
      held.set(item.itemId, { ...existing, ...item });
      continue;
    }

    const lifecycle = (lifecycleCounts.get(item.itemId) ?? 0) + 1;
    lifecycleCounts.set(item.itemId, lifecycle);
    held.set(
      item.itemId,
      createInstance(item, 'RECONCILE', lifecycle, nextSequence++, observedAtMs, gameTimeSec),
    );
  }

  const nextState: InventoryState = {
    initializedFromSnapshot: true,
    heldByItemId: held,
    lifecycleCountByItemId: lifecycleCounts,
    nextInstanceSequence: nextSequence,
  };
  return validateSlots(state, nextState, ruleset);
}

function acquire(
  state: InventoryState,
  item: InventoryItem,
  acquiredBy: InventoryAcquisitionType,
  observedAtMs: number,
  gameTimeSec: number | undefined,
  ruleset: InventoryRuleset,
): InventoryReducerResult {
  if (!ruleset.duplicateItemsAllowed && state.heldByItemId.has(item.itemId)) {
    return failure(state, {
      code: 'DUPLICATE_ITEM_NOT_ALLOWED',
      message: `Item ${item.itemId} is already held.`,
      itemIds: [item.itemId],
    });
  }

  const held = new Map(state.heldByItemId);
  const lifecycleCounts = new Map(state.lifecycleCountByItemId);
  const lifecycle = (lifecycleCounts.get(item.itemId) ?? 0) + 1;
  lifecycleCounts.set(item.itemId, lifecycle);
  held.set(
    item.itemId,
    createInstance(item, acquiredBy, lifecycle, state.nextInstanceSequence, observedAtMs, gameTimeSec),
  );

  const nextState: InventoryState = {
    initializedFromSnapshot: state.initializedFromSnapshot,
    heldByItemId: held,
    lifecycleCountByItemId: lifecycleCounts,
    nextInstanceSequence: state.nextInstanceSequence + 1,
  };
  return validateSlots(state, nextState, ruleset);
}

function upgrade(
  state: InventoryState,
  action: Extract<InventoryAction, { type: 'UPGRADE' }>,
  recipeGraph: RecipeGraph,
  ruleset: InventoryRuleset,
): InventoryReducerResult {
  if (!ruleset.duplicateItemsAllowed && state.heldByItemId.has(action.item.itemId)) {
    return failure(state, {
      code: 'DUPLICATE_ITEM_NOT_ALLOWED',
      message: `Upgrade target ${action.item.itemId} is already held.`,
      itemIds: [action.item.itemId],
    });
  }

  const componentIds = [...new Set(action.consumedComponentIds)].sort((a, b) => a - b);
  for (const componentId of componentIds) {
    if (!state.heldByItemId.has(componentId)) {
      return failure(state, {
        code: 'ITEM_NOT_OWNED',
        message: `Upgrade component ${componentId} is not held.`,
        itemIds: [componentId],
      });
    }
    if (!recipeGraph.isDirectComponent(action.item.itemId, componentId)) {
      return failure(state, {
        code: 'INVALID_UPGRADE_COMPONENT',
        message: `Item ${componentId} is not a direct component of ${action.item.itemId}.`,
        itemIds: [componentId, action.item.itemId],
      });
    }
  }

  if (componentIds.length === 0) {
    return failure(state, {
      code: 'INVALID_UPGRADE_COMPONENT',
      message: `Upgrade ${action.item.itemId} has no consumed components.`,
      itemIds: [action.item.itemId],
    });
  }

  const held = new Map(state.heldByItemId);
  for (const componentId of componentIds) held.delete(componentId);

  const lifecycleCounts = new Map(state.lifecycleCountByItemId);
  const lifecycle = (lifecycleCounts.get(action.item.itemId) ?? 0) + 1;
  lifecycleCounts.set(action.item.itemId, lifecycle);
  held.set(
    action.item.itemId,
    createInstance(
      action.item,
      'UPGRADE',
      lifecycle,
      state.nextInstanceSequence,
      action.metadata.observedAtMs,
      action.metadata.gameTimeSec,
    ),
  );

  const nextState: InventoryState = {
    initializedFromSnapshot: state.initializedFromSnapshot,
    heldByItemId: held,
    lifecycleCountByItemId: lifecycleCounts,
    nextInstanceSequence: state.nextInstanceSequence + 1,
  };
  return validateSlots(state, nextState, ruleset);
}

function removeItems(state: InventoryState, itemIds: readonly number[]): InventoryReducerResult {
  const uniqueIds = [...new Set(itemIds)].sort((a, b) => a - b);
  const missing = uniqueIds.filter((itemId) => !state.heldByItemId.has(itemId));
  if (missing.length > 0) {
    return failure(state, {
      code: 'ITEM_NOT_OWNED',
      message: `Items are not currently held: ${missing.join(', ')}.`,
      itemIds: missing,
    });
  }

  const held = new Map(state.heldByItemId);
  for (const itemId of uniqueIds) held.delete(itemId);
  return {
    ok: true,
    state: {
      ...state,
      heldByItemId: held,
    },
  };
}

function validateSlots(
  previousState: InventoryState,
  nextState: InventoryState,
  ruleset: InventoryRuleset,
): InventoryReducerResult {
  const counts: Record<InventorySlotType, number> = { weapon: 0, vitality: 0, spirit: 0 };
  for (const item of nextState.heldByItemId.values()) {
    if (item.slotType) counts[item.slotType] += 1;
  }

  const flexUsed = (Object.keys(counts) as InventorySlotType[]).reduce(
    (total, slotType) => total + Math.max(0, counts[slotType] - ruleset.baseSlotsByType[slotType]),
    0,
  );
  if (flexUsed > ruleset.maxFlexSlots) {
    return failure(previousState, {
      code: 'SLOT_LIMIT_EXCEEDED',
      message: `Inventory requires ${flexUsed} flex slots but only ${ruleset.maxFlexSlots} are available.`,
      itemIds: getHeldItemIds(nextState),
    });
  }

  return { ok: true, state: nextState };
}

function createInstance(
  item: InventoryItem,
  acquiredBy: InventoryAcquisitionType,
  lifecycle: number,
  sequence: number,
  observedAtMs: number,
  gameTimeSec: number | undefined,
): InventoryItemInstance {
  return {
    ...item,
    instanceId: `${item.itemId}:${lifecycle}:${sequence}`,
    lifecycle,
    acquiredBy,
    acquiredAtMs: observedAtMs,
    acquiredAtGameTimeSec: gameTimeSec,
  };
}

function findDuplicateIds(itemIds: readonly number[]): number[] {
  const seen = new Set<number>();
  const duplicates = new Set<number>();
  for (const itemId of itemIds) {
    if (seen.has(itemId)) duplicates.add(itemId);
    seen.add(itemId);
  }
  return [...duplicates].sort((a, b) => a - b);
}

function failure(state: InventoryState, error: InventoryValidationError): InventoryReducerResult {
  return { ok: false, state, error };
}
