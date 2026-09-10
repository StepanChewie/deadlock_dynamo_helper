import {
  buildInventoryInstancesForRecommendation,
  createRecommendationItemGraph,
  observedFact,
} from '@deadlock-live-probe/build-domain';
import { deriveAdaptiveSlotStateV1, unknownAdaptiveInvestmentStateV1 } from '../src/statlocker-adaptive/adaptive-economy-v1';
import { evaluateStrategyFirstInvariantsV1 } from '../src/statlocker-adaptive/strategy-first-invariants-v1';

const graph = createRecommendationItemGraph([
  {
    itemId: 1,
    name: 'Core',
    slotType: 'weapon',
    active: false,
    availableRulesetIds: ['r1'],
    directPurchaseCost: 800,
    upgradeRecipes: [],
    sellTransition: { soulsRefund: 400, returnedItemIds: [] },
  },
  {
    itemId: 3,
    name: 'Wildcard Counter',
    slotType: 'spirit',
    active: false,
    availableRulesetIds: ['r1'],
    directPurchaseCost: 800,
    upgradeRecipes: [],
    sellTransition: { soulsRefund: 400, returnedItemIds: [] },
  },
]);

const ownedItemIds = [1];
const held = buildInventoryInstancesForRecommendation(ownedItemIds, graph);
const decision: any = {
  state: {
    decisionId: 'd',
    matchId: 'm',
    playerSlot: 0,
    gameTimeSec: 900,
    rulesetId: 'r1',
    heroId: 1,
    inventory: {
      initializedFromSnapshot: true,
      heldByItemId: held,
      lifecycleCountByItemId: new Map([[1, 1]]),
      nextInstanceSequence: 2,
    },
    economy: {
      spendableSouls: observedFact(5000, 'test'),
      shopOpportunity: observedFact('AVAILABLE', 'test'),
    },
  },
  itemGraph: graph,
  slots: deriveAdaptiveSlotStateV1(
    ownedItemIds,
    graph,
    {
      baseSlots: 12,
      baseSlotsByType: { weapon: 4, vitality: 4, spirit: 4 },
      maxFlexSlots: 4,
      maxActiveItems: 4,
    },
    { unlockedFlexSlots: 0, evidence: 'OBSERVED' },
  ),
  investment: unknownAdaptiveInvestmentStateV1(),
};

function resultWithSituationalReasonCodes(reasonCodes: readonly string[]): any {
  const situationalDecision = {
    windowId: 'matchup',
    purpose: 'COUNTER_ENEMY_HEROES',
    targetItemId: 3,
    enemyHeroIds: [99],
    enemyLiveStates: [],
    enemyItemIds: [],
    statisticalSupport: 0.8,
    confidence: 0.9,
    slotImpact: 1,
    investmentImpact: 0,
    coreInterruptionSouls: 800,
    reasonCodes,
  };

  return {
    strategy: {
      schemaVersion: 1,
      strategyId: 's',
      heroId: 1,
      rulesetId: 'r1',
      sourcePatchId: 'p',
      support: 1,
      stability: 1,
      representativeTraceId: 't',
      goals: [{
        goalId: 'core',
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
      investmentPolicy: {
        objectives: [],
        preferredWeights: { weapon: 1, vitality: 1, spirit: 1 },
      },
      slotPolicy: { reservedSituationalSlots: 1, maxTemporarySlots: 0 },
      terminalPolicy: { requiredGoalIds: ['core'], allowWaiveSoftGoals: true },
    },
    strategySession: {
      strategyId: 's',
      commitment: 'COMMITTED',
      posterior: 1,
      selectedAtGameTimeSec: 0,
      replanReasons: [],
    },
    contract: {
      strategyId: 's',
      status: 'IN_PROGRESS',
      commitment: 'COMMITTED',
      goalStates: { core: 'SATISFIED' },
      selectedBranches: {},
      committedBranches: {},
      temporaryItemIds: [],
      reservedSituationalWindowIds: ['matchup'],
      remainingHardGoalIds: [],
      completionReasonCodes: [],
      activeSituationalDecision: situationalDecision,
    },
    strategyPlan: {
      strategyId: 's',
      buildStatus: 'IN_PROGRESS',
      progress: { satisfiedHardGoals: 1, totalHardGoals: 1 },
      remainingGoalIds: [],
      remainingHardInvestmentObjectiveIds: [],
      situationalDecision,
      slotPlan: {
        currentUsedSlots: 1,
        currentFlexUsed: 0,
        unlockedFlexSlots: 0,
        reservedSituationalSlots: 1,
        futureTransitions: [],
        feasible: true,
        reasonCodes: [],
      },
      investmentPlan: { objectives: [], activeObjectiveIds: [] },
    },
    nextAction: {
      actionKey: 'BUY_ITEM:3',
      type: 'BUY',
      itemId: 3,
      buyItemId: 3,
      targetItemId: 3,
      reasonCodes,
    },
    recommendedBuild: [
      {
        itemId: 1,
        position: 1,
        status: 'OWNED',
        score: 0,
        confidence: 1,
        skeletonStrength: 1,
        contextualSupport: 1,
        reasonCodes: ['CORE'],
      },
      {
        itemId: 3,
        position: 2,
        status: 'NEXT',
        score: 1,
        confidence: 0.9,
        skeletonStrength: 0,
        contextualSupport: 1,
        reasonCodes: ['SITUATIONAL_WINDOW_ACTIVE'],
      },
    ],
  };
}

describe('strategy-first wildcard situational invariant v1', () => {
  it('accepts an undeclared wildcard when it carries full matchup-discovery provenance', () => {
    const result = resultWithSituationalReasonCodes([
      'MATCHUP_DISCOVERY_OUTSIDE_SKELETON',
      'SITUATIONAL_PURPOSE:COUNTER_ENEMY_HEROES',
      'SITUATIONAL_WINDOW_ACTIVE',
      'SITUATIONAL_OVERRIDE_BEATS_CONTINUE_CORE',
    ]);

    const codes = evaluateStrategyFirstInvariantsV1({ decision, result }).violations.map((entry) => entry.code);

    expect(codes).not.toContain('UNEXPLAINED_SITUATIONAL');
  });

  it('still rejects an undeclared situational target without discovery provenance', () => {
    const result = resultWithSituationalReasonCodes([
      'SITUATIONAL_PURPOSE:COUNTER_ENEMY_HEROES',
      'SITUATIONAL_WINDOW_ACTIVE',
      'SITUATIONAL_OVERRIDE_BEATS_CONTINUE_CORE',
    ]);

    const codes = evaluateStrategyFirstInvariantsV1({ decision, result }).violations.map((entry) => entry.code);

    expect(codes).toContain('UNEXPLAINED_SITUATIONAL');
  });
});
