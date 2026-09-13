import {
  reconstructInventoryTransaction,
  type InventoryTransactionReconstructionConfidence,
} from './inventory-transaction-reconstruction';

export interface ContextualV3PreviousActionsResult {
  actionKeys: string[];
  confidence: InventoryTransactionReconstructionConfidence;
  ambiguous: boolean;
  unresolvedIntervalCount: number;
}

export function deriveContextualV3PreviousActions(
  inventorySnapshots: readonly (readonly number[])[],
  recipeResolver: (parentItemId: number) => readonly number[],
): ContextualV3PreviousActionsResult {
  if (inventorySnapshots.length < 2) {
    return createResult([], false, 0);
  }

  const actionKeys: string[] = [];
  let ambiguous = false;
  let unresolvedIntervalCount = 0;

  for (let index = 1; index < inventorySnapshots.length; index += 1) {
    const reconstruction = reconstructInventoryTransaction(
      inventorySnapshots[index - 1],
      inventorySnapshots[index],
      recipeResolver,
    );
    if (reconstruction.previousStateKey === reconstruction.currentStateKey) {
      continue;
    }
    actionKeys.push(...reconstruction.actionKeys);
    ambiguous ||= reconstruction.ambiguous;
    if (!reconstruction.resolved) {
      unresolvedIntervalCount += 1;
    }
  }

  const truncated = actionKeys.length > 64;
  return createResult(
    actionKeys.slice(0, 64),
    ambiguous,
    unresolvedIntervalCount + (truncated ? 1 : 0),
  );
}

export function deriveContextualV3PreviousActionKeys(
  inventorySnapshots: readonly (readonly number[])[],
  recipeResolver: (parentItemId: number) => readonly number[],
): string[] {
  return deriveContextualV3PreviousActions(
    inventorySnapshots,
    recipeResolver,
  ).actionKeys;
}

function createResult(
  actionKeys: string[],
  ambiguous: boolean,
  unresolvedIntervalCount: number,
): ContextualV3PreviousActionsResult {
  return {
    actionKeys: [...actionKeys],
    confidence: resolveConfidence(
      actionKeys.length,
      ambiguous,
      unresolvedIntervalCount,
    ),
    ambiguous,
    unresolvedIntervalCount,
  };
}

function resolveConfidence(
  actionCount: number,
  ambiguous: boolean,
  unresolvedIntervalCount: number,
): InventoryTransactionReconstructionConfidence {
  if (unresolvedIntervalCount > 0 || actionCount === 0) {
    return 'UNRESOLVED';
  }
  if (ambiguous) {
    return 'AMBIGUOUS_MULTI_ACTION';
  }
  return actionCount === 1
    ? 'EXACT_SINGLE_ACTION'
    : 'MULTI_ACTION_INTERVAL';
}
