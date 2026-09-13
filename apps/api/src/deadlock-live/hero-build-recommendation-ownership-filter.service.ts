import { Injectable } from '@nestjs/common';
import {
  HeroBuildRecommendationAction,
  HeroBuildRecommendationResponse,
  parseInventoryStateKey,
} from './hero-build-recommendation.service';
import { RecipeAwareTimelineReconciliationService } from './recipe-aware-timeline-reconciliation.service';

@Injectable()
export class HeroBuildRecommendationOwnershipFilterService {
  constructor(
    private readonly recipeAwareTimelineReconciliationService:
      RecipeAwareTimelineReconciliationService,
  ) {}

  filter<T extends HeroBuildRecommendationResponse>(response: T): T {
    const currentItemCounts = parseInventoryStateKey(response.requestedStateKey);
    if (!currentItemCounts) {
      return response;
    }

    const legalActions = [response.action, ...response.alternatives].filter((action) =>
      this.isLegalAction(action, currentItemCounts),
    );

    if (legalActions.length === response.alternatives.length + 1) {
      return response;
    }

    if (legalActions.length === 0) {
      return {
        ...response,
        mode: 'NO_MATCH',
        action: createHoldAction(response),
        alternatives: [],
        noMatchReason: 'NO_LEGAL_ACTION',
      } as T;
    }

    return {
      ...response,
      action: { ...legalActions[0] },
      alternatives: legalActions.slice(1).map((action) => ({ ...action })),
    } as T;
  }

  isActionLegalForState(
    action: HeroBuildRecommendationAction,
    stateKey: string,
  ): boolean {
    const currentItemCounts = parseInventoryStateKey(stateKey);
    return currentItemCounts
      ? this.isLegalAction(action, currentItemCounts)
      : true;
  }

  private isLegalAction(
    action: HeroBuildRecommendationAction,
    currentItemCounts: ReadonlyMap<number, number>,
  ): boolean {
    if (action.type !== 'BUY' || action.itemId === undefined) {
      return true;
    }

    const observedOwnedCountLimit = action.observedOwnedCountLimit ?? 1;
    return this.getEffectiveOwnedCount(action.itemId, currentItemCounts) < observedOwnedCountLimit;
  }

  private getEffectiveOwnedCount(
    itemId: number,
    currentItemCounts: ReadonlyMap<number, number>,
  ): number {
    let count = currentItemCounts.get(itemId) ?? 0;

    for (const [ownedItemId, ownedCount] of currentItemCounts) {
      if (ownedItemId === itemId || ownedCount <= 0) {
        continue;
      }

      count += ownedCount * this.countContainedCopies(ownedItemId, itemId, new Set());
    }

    return count;
  }

  private countContainedCopies(
    parentItemId: number,
    targetItemId: number,
    visited: ReadonlySet<number>,
  ): number {
    if (visited.has(parentItemId)) {
      return 0;
    }

    const nextVisited = new Set(visited);
    nextVisited.add(parentItemId);

    let count = 0;
    for (const componentItemId of this.recipeAwareTimelineReconciliationService.getComponentItemIds(
      parentItemId,
    )) {
      if (componentItemId === targetItemId) {
        count += 1;
        continue;
      }

      count += this.countContainedCopies(componentItemId, targetItemId, nextVisited);
    }

    return count;
  }
}

function createHoldAction(
  response: HeroBuildRecommendationResponse,
): HeroBuildRecommendationAction {
  return {
    type: 'HOLD',
    actionKey: 'HOLD',
    historicalCount: 0,
    historicalProbability: 0,
    averageGameTimeS: response.gameTimeS,
    matchedStateKey: response.requestedStateKey,
    matchedStateObservationCount: 0,
    stateDistance: 0,
    missingItemCount: 0,
    extraItemCount: 0,
    matchedBySubset: true,
    predictedStateKey: response.requestedStateKey,
    score: 0,
    confidence: 0,
  };
}
