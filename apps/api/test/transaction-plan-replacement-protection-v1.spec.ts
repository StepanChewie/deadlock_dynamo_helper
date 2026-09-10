import {
  RecommendationItemDefinition,
  buildInventoryInstancesForRecommendation,
  createRecommendationItemGraph,
  observedFact,
} from '@deadlock-live-probe/build-domain';
import { AdaptiveDecisionStateV1 } from '../src/statlocker-adaptive/adaptive-decision-state-v1.service';
import { deriveAdaptiveSlotStateV1, unknownAdaptiveInvestmentStateV1 } from '../src/statlocker-adaptive/adaptive-economy-v1';
import { BuildContractV1, BuildSlotPlanV1, BuildStrategySpecV1 } from '../src/statlocker-adaptive/build-strategy-v1';
import { TransactionPlanCompilerV1Service } from '../src/statlocker-adaptive/transaction-plan-compiler-v1.service';

const items: RecommendationItemDefinition[] = [
  {
    itemId: 105,
    name: 'Saved component',
    slotType: 'weapon',
    active: false,
    availableRulesetIds: ['r1'],
    directPurchaseCost: 500,
    upgradeRecipes: [],
    sellTransition: { soulsRefund: 250, returnedItemIds: [] },
    maxCopies: 1,
  },
  ...[102, 103, 104].map((itemId): RecommendationItemDefinition => ({
    itemId,
    name: `Protected core ${itemId}`,
    slotType: 'weapon',
    active: false,
    availableRulesetIds: ['r1'],
    directPurchaseCost: 500,
    upgradeRecipes: [],
    sellTransition: { soulsRefund: 250, returnedItemIds: [] },
    maxCopies: 1,
  })),
  {
    itemId: 202,
    name: 'Current replacement target',
    slotType: 'weapon',
    active: false,
    availableRulesetIds: ['r1'],
    directPurchaseCost: 1200,
    upgradeRecipes: [],
    maxCopies: 1,
  },
  {
    itemId: 303,
    name: 'Near-term upgrade',
    slotType: 'weapon',
    active: false,
    availableRulesetIds: ['r1'],
    upgradeRecipes: [{ recipeId: 'upgrade-303', consumedItemIds: [105], soulsCost: 700 }],
    maxCopies: 1,
  },
];
const graph = createRecommendationItemGraph(items);
const slotRules = {
  baseSlots: 12,
  baseSlotsByType: { weapon: 4, vitality: 4, spirit: 4 } as const,
  maxFlexSlots: 0,
  maxActiveItems: 4,
};

function decision(): AdaptiveDecisionStateV1 {
  const ownedItemIds = [102, 103, 104, 105];
  const held = buildInventoryInstancesForRecommendation(ownedItemIds, graph);
  return {
    state: {
      decisionId: 'replacement-protection',
      matchId: 'match',
      playerSlot: 0,
      gameTimeSec: 1800,
      rulesetId: 'r1',
      heroId: 1,
      inventory: {
        initializedFromSnapshot: true,
        heldByItemId: held,
        lifecycleCountByItemId: new Map(ownedItemIds.map((itemId) => [itemId, 1])),
        nextInstanceSequence: held.size + 1,
      },
      economy: {
        spendableSouls: observedFact(5000, 'test'),
        shopOpportunity: observedFact('AVAILABLE', 'test'),
      },
    },
    itemGraph: graph,
    catalogVersionId: 'catalog',
    catalogSha256: 'e'.repeat(64),
    rulesetId: 'r1',
    localSteamId: 'player',
    allyHeroIds: [],
    enemyHeroIds: [],
    enemyLiveStates: [],
    allyItemIds: [],
    enemyItemIds: [],
    slots: deriveAdaptiveSlotStateV1(ownedItemIds, graph, slotRules, {
      unlockedFlexSlots: 0,
      evidence: 'OBSERVED',
    }),
    investment: unknownAdaptiveInvestmentStateV1(),
    economyRulesEvidence: 'UNKNOWN',
    stateRevision: 'revision',
  };
}

const strategy: BuildStrategySpecV1 = {
  schemaVersion: 1,
  strategyId: 'component-protection',
  heroId: 1,
  rulesetId: 'r1',
  sourcePatchId: 'p',
  support: 1,
  stability: 1,
  representativeTraceId: 'trace',
  goals: [
    ...[102, 103, 104].map((itemId) => ({
      goalId: `core-${itemId}`,
      type: 'CORE' as const,
      phase: 'EARLY' as const,
      targetItemIds: [itemId],
      minSelect: 1,
      maxSelect: 1,
      prerequisiteGoalIds: [],
      hard: true,
      lifecycleByItemId: { [itemId]: 'PERMANENT_CORE' as const },
      rationaleCodes: ['CORE'],
    })),
    {
      goalId: 'current-202',
      type: 'CORE',
      phase: 'MID',
      targetItemIds: [202],
      minSelect: 1,
      maxSelect: 1,
      prerequisiteGoalIds: [],
      hard: true,
      lifecycleByItemId: { 202: 'REPLACEMENT_TARGET' },
      rationaleCodes: ['CURRENT'],
    },
    {
      goalId: 'upgrade-303',
      type: 'UPGRADE',
      phase: 'LATE',
      targetItemIds: [303],
      minSelect: 1,
      maxSelect: 1,
      prerequisiteGoalIds: ['current-202'],
      hard: true,
      lifecycleByItemId: { 303: 'PERMANENT_CORE' },
      rationaleCodes: ['NEAR_TERM_UPGRADE'],
    },
  ],
  branchGroups: [],
  situationalWindows: [],
  investmentPolicy: { objectives: [], preferredWeights: { weapon: 1, vitality: 0, spirit: 0 } },
  slotPolicy: { reservedSituationalSlots: 0, maxTemporarySlots: 0 },
  terminalPolicy: {
    requiredGoalIds: ['core-102', 'core-103', 'core-104', 'current-202', 'upgrade-303'],
    allowWaiveSoftGoals: true,
  },
};

const contract: BuildContractV1 = {
  strategyId: strategy.strategyId,
  status: 'IN_PROGRESS',
  commitment: 'COMMITTED',
  currentGoalId: 'current-202',
  goalStates: {
    'core-102': 'SATISFIED',
    'core-103': 'SATISFIED',
    'core-104': 'SATISFIED',
    'current-202': 'ACTIVE',
    'upgrade-303': 'LOCKED',
  },
  selectedBranches: {},
  committedBranches: {},
  temporaryItemIds: [],
  reservedSituationalWindowIds: [],
  remainingHardGoalIds: ['current-202', 'upgrade-303'],
  completionReasonCodes: [],
};

const slotPlan: BuildSlotPlanV1 = {
  currentUsedSlots: 4,
  currentFlexUsed: 0,
  unlockedFlexSlots: 0,
  reservedSituationalSlots: 0,
  feasible: true,
  reasonCodes: ['EXPLICIT_REPLACEMENT_PATH_REQUIRED'],
  futureTransitions: [{
    targetGoalId: 'current-202',
    targetItemId: 202,
    requirement: 'REPLACE',
    sourceItemId: 105,
    reasonCodes: ['NON_MANDATORY_ITEM_REPLACEMENT_PATH'],
  }],
};

describe('transaction plan replacement protection v1', () => {
  it('does not sell a component that makes a pending hard upgrade immediately reachable', () => {
    const result = new TransactionPlanCompilerV1Service().compile({
      strategy,
      contract,
      slotPlan,
      decision: decision(),
      selectedCandidates: [],
    });

    expect(result.reachable).toBe(false);
    expect(result.steps.some((step) =>
      step.action?.type === 'SELL_AND_BUY' && step.action.sellItemId === 105,
    )).toBe(false);
  });
});
