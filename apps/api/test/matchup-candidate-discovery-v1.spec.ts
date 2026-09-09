import {
  RecommendationCandidate,
  RecommendationItemDefinition,
  createRecommendationItemGraph,
} from '@deadlock-live-probe/build-domain';
import { AdaptiveItemScoreV1 } from '../src/statlocker-adaptive/adaptive-evidence-scorer-v1.service';
import { MatchupCandidateDiscoveryV1Service } from '../src/statlocker-adaptive/matchup-candidate-discovery-v1.service';
import { BuildStrategySpecV1 } from '../src/statlocker-adaptive/build-strategy-v1';

const items: RecommendationItemDefinition[] = [
  { itemId: 1, name: 'Hard Core', slotType: 'weapon', active: false, availableRulesetIds: ['r1'], directPurchaseCost: 800, upgradeRecipes: [], sellTransition: { soulsRefund: 400, returnedItemIds: [] } },
  { itemId: 2, name: 'Flex', slotType: 'vitality', active: false, availableRulesetIds: ['r1'], directPurchaseCost: 800, upgradeRecipes: [], sellTransition: { soulsRefund: 400, returnedItemIds: [] } },
  { itemId: 3, name: 'Counter', slotType: 'spirit', active: false, availableRulesetIds: ['r1'], directPurchaseCost: 800, upgradeRecipes: [], sellTransition: { soulsRefund: 400, returnedItemIds: [] } },
];
const graph = createRecommendationItemGraph(items);

const strategy: BuildStrategySpecV1 = {
  schemaVersion: 1,
  strategyId: 's',
  heroId: 1,
  rulesetId: 'r1',
  sourcePatchId: 'p',
  support: 1,
  stability: 1,
  representativeTraceId: 't',
  goals: [{
    goalId: 'hard-core',
    type: 'CORE',
    phase: 'EARLY',
    targetItemIds: [1],
    minSelect: 1,
    maxSelect: 1,
    prerequisiteGoalIds: [],
    hard: true,
    rigidity: 'HARD_CORE',
    lifecycleByItemId: { 1: 'PERMANENT_CORE' },
    rationaleCodes: ['CORE'],
  }],
  branchGroups: [],
  situationalWindows: [{
    windowId: 'matchup',
    afterGoalIds: [],
    beforeGoalIds: [],
    maxSlots: 1,
    maxSouls: 3200,
    maxCoreDelaySouls: 3200,
    allowedPurposes: ['COUNTER_ENEMY_HEROES'],
  }],
  investmentPolicy: { objectives: [], preferredWeights: { weapon: 1, vitality: 1, spirit: 1 } },
  slotPolicy: { reservedSituationalSlots: 1, maxTemporarySlots: 0 },
  terminalPolicy: { requiredGoalIds: ['hard-core'], allowWaiveSoftGoals: true },
};

function candidate(action: RecommendationCandidate['action'], resultingItemIds: readonly number[]): RecommendationCandidate {
  return {
    actionId: action.type === 'REPLACE_ITEM' ? `REPLACE_ITEM:${action.sellItemId}->${action.buyItemId}` : 'BUY_ITEM:3',
    action,
    feasible: true,
    reasons: ['FEASIBLE'],
    recommendationEligible: true,
    recommendationSuppressionReasons: [],
    effectiveCostSouls: 800,
    spendableSoulsAfter: 4200,
    resultingItemIds,
    evidence: {
      spendableSouls: 'OBSERVED',
      shopOpportunity: 'OBSERVED',
      ruleset: 'RECONSTRUCTED',
      inventory: 'OBSERVED',
      transaction: 'RECONSTRUCTED',
    },
  };
}

function score(itemId: number, confidence = 0.9): AdaptiveItemScoreV1 {
  return {
    itemId,
    score: 1.2,
    confidence,
    completeness: 1,
    components: [{
      key: 'draftMatchupFit',
      raw: 0.7,
      normalized: 0.7,
      confidence: 0.9,
      weight: 1,
      weighted: 0.7,
    }],
    version: 'adaptive-evidence-scorer-v1',
  };
}

function input(legal: RecommendationCandidate, coverage: number, matchupConfidence = 0.9): any {
  return {
    strategy,
    openWindows: strategy.situationalWindows,
    legalByTarget: new Map([[3, legal]]),
    itemGraph: graph,
    maxTotalItems: 12,
    currentItemCount: 1,
    enemyHeroIds: [99, 100],
    enemyItemIds: [],
    matchupByItemId: {
      '3': {
        raw: 0.08,
        normalized: 0.7,
        confidence: matchupConfidence,
        coverage,
        usedCount: 1,
        contributions: [],
      },
    },
    scoreItem: (itemId: number) => score(itemId),
  };
}

describe('matchup candidate discovery v1', () => {
  const service = new MatchupCandidateDiscoveryV1Service();

  it('accepts a legal outside-skeleton counter with credible matchup evidence', () => {
    const result = service.discover(input(candidate({ type: 'BUY_ITEM', itemId: 3 }, [1, 3]), 0.8));

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      targetItemId: 3,
      purpose: 'COUNTER_ENEMY_HEROES',
    });
  });

  it('rejects an outside-skeleton counter when matchup coverage is below the discovery threshold', () => {
    const result = service.discover(input(candidate({ type: 'BUY_ITEM', itemId: 3 }, [1, 3]), 0.05));

    expect(result).toEqual([]);
  });

  it('rejects an outside-skeleton counter when matchup confidence is below the situational threshold', () => {
    const result = service.discover(input(candidate({ type: 'BUY_ITEM', itemId: 3 }, [1, 3]), 0.8, 0.2));

    expect(result).toEqual([]);
  });

  it('rejects a sell-driven outside-skeleton replacement below the 0.40 matchup confidence floor', () => {
    const result = service.discover(input(
      candidate({ type: 'REPLACE_ITEM', sellItemId: 2, buyItemId: 3 }, [1, 3]),
      0.8,
      0.39,
    ));

    expect(result).toEqual([]);
  });

  it('rejects a replacement that would sell a HARD_CORE item', () => {
    const result = service.discover(input(candidate({ type: 'REPLACE_ITEM', sellItemId: 1, buyItemId: 3 }, [3]), 0.8));

    expect(result).toEqual([]);
  });
});
