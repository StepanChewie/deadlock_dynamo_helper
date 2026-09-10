import { Injectable } from '@nestjs/common';
import { RecommendationItemGraph } from '@deadlock-live-probe/build-domain';
import {
  BuildStrategyPosteriorV1,
  BuildStrategySelectionV1,
  BuildStrategySpecV1,
} from './build-strategy-v1';

export type { BuildStrategySelectionV1 } from './build-strategy-v1';

export interface BuildStrategyPurchaseEvidenceV1 {
  itemId: number;
  gameTimeSec: number;
}

export interface BuildStrategySelectorV1Input {
  strategies: readonly BuildStrategySpecV1[];
  heroId?: number;
  rulesetId?: string;
  itemGraph: RecommendationItemGraph;
  ownedItemIds: readonly number[];
  purchaseHistory: readonly BuildStrategyPurchaseEvidenceV1[];
  allyHeroIds?: readonly number[];
  enemyHeroIds?: readonly number[];
}

@Injectable()
export class BuildStrategySelectorV1Service {
  select(input: BuildStrategySelectorV1Input): BuildStrategySelectionV1 {
    const inferredHeroId = input.heroId ?? input.strategies[0]?.heroId;
    const inferredRulesetId = input.rulesetId ?? input.strategies[0]?.rulesetId;
    const candidates = input.strategies
      .filter((strategy) => strategy.heroId === inferredHeroId)
      .filter((strategy) => strategy.rulesetId === inferredRulesetId)
      .filter((strategy) => Array.isArray(strategy.goals) && strategy.goals.length > 0)
      .sort((a, b) => a.strategyId.localeCompare(b.strategyId));
    if (candidates.length === 0) {
      return { commitment: 'OOD', posteriors: [], reasonCodes: ['NO_STRATEGIES_AVAILABLE_FOR_LIVE_SCOPE'] };
    }

    const scored = candidates.map((strategy) => {
      const conformance = strategyConformance(strategy, input);
      const evidenceCount = matchedEvidenceCount(strategy, input.ownedItemIds, input.itemGraph);
      const logit = conformance * 5 + Math.log(Math.max(0.0001, strategy.support)) + strategy.stability * 0.35;
      return { strategy, conformance, evidenceCount, logit };
    });
    const maxLogit = Math.max(...scored.map((entry) => entry.logit));
    const denominator = scored.reduce((sum, entry) => sum + Math.exp(entry.logit - maxLogit), 0);
    const posteriors: BuildStrategyPosteriorV1[] = scored
      .map((entry) => ({
        strategyId: entry.strategy.strategyId,
        probability: Math.exp(entry.logit - maxLogit) / Math.max(Number.EPSILON, denominator),
        conformance: entry.conformance,
        evidenceCount: entry.evidenceCount,
      }))
      .sort((a, b) => b.probability - a.probability || b.conformance - a.conformance || a.strategyId.localeCompare(b.strategyId));

    const best = posteriors[0];
    const second = posteriors[1];
    if (!best) {
      return { commitment: 'OOD', posteriors, reasonCodes: ['NO_STRATEGY_CONFORMANCE'] };
    }
    if (best.conformance < 0.15) {
      return {
        selectedStrategyId: best.strategyId,
        commitment: 'OOD',
        posteriors,
        reasonCodes: ['NO_STRATEGY_CONFORMANCE', 'NEAREST_STRATEGY_REBASE'],
      };
    }
    const gap = best.probability - (second?.probability ?? 0);
    const distinctiveEvidence = best.evidenceCount >= 2 && gap >= 0.20;
    const committed = best.probability >= 0.65 && distinctiveEvidence;
    return {
      selectedStrategyId: best.strategyId,
      commitment: committed ? 'COMMITTED' : 'PROVISIONAL',
      posteriors,
      reasonCodes: [
        'BEST_POSTERIOR',
        committed ? 'DISTINCTIVE_PREFIX_COMMITMENT' : 'STRATEGY_SELECTION_PROVISIONAL',
      ],
    };
  }
}

function strategyConformance(strategy: BuildStrategySpecV1, input: BuildStrategySelectorV1Input): number {
  const orderedGoals = strategy.goals.filter((goal) => goal.hard);
  const expectedItems = orderedGoals.flatMap((goal) => goal.targetItemIds);
  const owned = input.ownedItemIds;
  if (owned.length === 0 && input.purchaseHistory.length === 0) return 0.5;

  const matchedOwned = owned.filter((ownedItemId) => expectedItems.some((target) =>
    input.itemGraph.isTargetSatisfied(target, [ownedItemId]) || input.itemGraph.isTargetSatisfied(ownedItemId, [target]),
  )).length;
  const knownOwned = owned.filter((itemId) => input.itemGraph.getItem(itemId) !== undefined).length;
  const unknownOrDeviating = owned.length - matchedOwned;
  const denominator = Math.max(1, Math.min(expectedItems.length, Math.max(knownOwned, input.purchaseHistory.length)));
  const coverage = Math.min(1, matchedOwned / denominator);

  let prefixMatches = 0;
  let expectedIndex = 0;
  const history = [...input.purchaseHistory].sort((a, b) => a.gameTimeSec - b.gameTimeSec || a.itemId - b.itemId);
  for (const purchase of history) {
    while (expectedIndex < orderedGoals.length) {
      const goal = orderedGoals[expectedIndex];
      if (goal.targetItemIds.some((target) =>
        input.itemGraph.isTargetSatisfied(target, [purchase.itemId]) || input.itemGraph.isTargetSatisfied(purchase.itemId, [target]),
      )) {
        prefixMatches += 1;
        expectedIndex += 1;
        break;
      }
      const appearsLater = orderedGoals.slice(expectedIndex + 1).some((candidate) => candidate.targetItemIds.includes(purchase.itemId));
      if (appearsLater) break;
      expectedIndex += 1;
    }
  }
  const prefix = history.length === 0 ? coverage : Math.min(1, prefixMatches / Math.max(1, history.length));
  const deviation = unknownOrDeviating / Math.max(1, owned.length);
  return clamp01(coverage * 0.55 + prefix * 0.45 - deviation * 0.60);
}

function matchedEvidenceCount(
  strategy: BuildStrategySpecV1,
  ownedItemIds: readonly number[],
  graph: RecommendationItemGraph,
): number {
  return strategy.goals.filter((goal) =>
    goal.targetItemIds.some((target) => graph.isTargetSatisfied(target, ownedItemIds)),
  ).length;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
