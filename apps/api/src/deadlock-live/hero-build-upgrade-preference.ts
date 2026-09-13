import type {
  HeroBuildRecommendationAction,
  HeroBuildRecommendationResponse,
} from './hero-build-recommendation.service';

export function preferUpgradeOverComponentSell<
  TResponse extends HeroBuildRecommendationResponse,
>(
  response: TResponse,
  currentItemIds: readonly number[],
): TResponse {
  const sellAction = response.action;
  const soldItemId = Number(sellAction.itemId);
  if (
    sellAction.type !== 'SELL' ||
    !Number.isSafeInteger(soldItemId) ||
    soldItemId <= 0
  ) {
    return response;
  }

  const currentOwnedCount = countItemIds(currentItemIds, soldItemId);
  if (currentOwnedCount === 0) {
    return response;
  }

  const upgradeIndex = response.alternatives.findIndex((alternative) =>
    isUpgradeConsumingItem(alternative, soldItemId, currentOwnedCount),
  );
  if (upgradeIndex < 0) {
    return response;
  }

  const upgradeAction = response.alternatives[upgradeIndex];
  const alternatives = response.alternatives.map((alternative, index) =>
    index === upgradeIndex ? { ...sellAction } : { ...alternative },
  );

  return {
    ...response,
    matchedStateKey: upgradeAction.matchedStateKey,
    stateDistance: upgradeAction.stateDistance,
    missingItemCount: upgradeAction.missingItemCount,
    extraItemCount: upgradeAction.extraItemCount,
    matchedBySubset: upgradeAction.matchedBySubset,
    observationCount: upgradeAction.matchedStateObservationCount,
    action: { ...upgradeAction },
    alternatives,
  };
}

function isUpgradeConsumingItem(
  action: HeroBuildRecommendationAction,
  componentItemId: number,
  currentOwnedCount: number,
): boolean {
  if (action.type !== 'UPGRADE') {
    return false;
  }

  const predictedOwnedCount = readStateItemCount(
    action.predictedStateKey,
    componentItemId,
  );
  return predictedOwnedCount !== undefined && predictedOwnedCount < currentOwnedCount;
}

function countItemIds(itemIds: readonly number[], targetItemId: number): number {
  let count = 0;
  for (const itemId of itemIds) {
    if (Number(itemId) === targetItemId) {
      count += 1;
    }
  }
  return count;
}

function readStateItemCount(
  stateKey: string,
  targetItemId: number,
): number | undefined {
  if (stateKey === 'EMPTY') {
    return 0;
  }

  for (const token of stateKey.split('|')) {
    const match = /^(\d+)x(\d+)$/.exec(token);
    if (!match) {
      return undefined;
    }

    const itemId = Number(match[1]);
    const count = Number(match[2]);
    if (
      !Number.isSafeInteger(itemId) ||
      itemId <= 0 ||
      !Number.isSafeInteger(count) ||
      count <= 0
    ) {
      return undefined;
    }

    if (itemId === targetItemId) {
      return count;
    }
  }

  return 0;
}
