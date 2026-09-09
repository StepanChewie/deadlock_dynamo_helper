import {
  RecommendationItemDefinition,
  buildInventoryInstancesForRecommendation,
  createRecommendationItemGraph,
  observedFact,
} from '@deadlock-live-probe/build-domain';
import { AdaptivePlanSessionV1 } from '@deadlock-live-probe/shared';
import { AdaptiveDecisionStateV1 } from '../src/statlocker-adaptive/adaptive-decision-state-v1.service';
import { deriveAdaptiveSlotStateV1, unknownAdaptiveInvestmentStateV1 } from '../src/statlocker-adaptive/adaptive-economy-v1';
import {
  evaluateTransactionPlanInvariantsV1,
  summarizeTransactionPlanInvariantChecksV1,
} from '../src/statlocker-adaptive/transaction-plan-invariants-v1';

const items: RecommendationItemDefinition[] = [1, 2, 3].map((itemId) => ({
  itemId, name: `Item ${itemId}`, slotType: 'weapon', active: false, availableRulesetIds: ['r1'], directPurchaseCost: 500,
  upgradeRecipes: [], sellTransition: { soulsRefund: 250, returnedItemIds: [] }, maxCopies: 1,
}));
const graph = createRecommendationItemGraph(items);
const slotRules = { baseSlots: 12, baseSlotsByType: { weapon: 4, vitality: 4, spirit: 4 } as const, maxFlexSlots: 4, maxActiveItems: 4 };

function decision(owned: readonly number[], souls = 5000): AdaptiveDecisionStateV1 {
  const held = buildInventoryInstancesForRecommendation(owned, graph);
  return {
    state: {
      decisionId: 'd', matchId: 'm', playerSlot: 0, gameTimeSec: 100, rulesetId: 'r1', heroId: 1,
      inventory: { initializedFromSnapshot: true, heldByItemId: held, lifecycleCountByItemId: new Map(), nextInstanceSequence: held.size + 1 },
      economy: { spendableSouls: observedFact(souls, 'test'), shopOpportunity: observedFact('AVAILABLE', 'test') },
    },
    itemGraph: graph, catalogVersionId: 'c', catalogSha256: 'a'.repeat(64), rulesetId: 'r1', localSteamId: 'p',
    allyHeroIds: [], enemyHeroIds: [], enemyLiveStates: [], allyItemIds: [], enemyItemIds: [],
    slots: deriveAdaptiveSlotStateV1(owned, graph, slotRules, { unlockedFlexSlots: 0, evidence: 'OBSERVED' }),
    investment: unknownAdaptiveInvestmentStateV1(), economyRulesEvidence: 'UNKNOWN', stateRevision: 'r',
  };
}

const projection = {
  inventoryItemIds: [1] as number[], spendableSouls: 5000,
  usedByType: { weapon: 1, vitality: 0, spirit: 0 }, flexUsed: 0, unlockedFlexSlots: 0, activeItemsUsed: 0,
};

function validSession(): AdaptivePlanSessionV1 {
  return {
    planSessionId: 'p', strategyId: 's', revision: 1, createdAtGameTimeSec: 1, updatedAtGameTimeSec: 1,
    state: 'ACTIVE', nextStepId: 'replace', reasonCodes: [],
    steps: [{
      stepId: 'replace', goalId: 'g', kind: 'TRANSACTION', state: 'NEXT',
      action: { type: 'SELL_AND_BUY', sellItemId: 1, buyItemId: 2 }, prerequisiteStepIds: [], blockingReasons: [],
      projectedBefore: projection,
      projectedAfter: {
        inventoryItemIds: [2], spendableSouls: 4750,
        usedByType: { weapon: 1, vitality: 0, spirit: 0 }, flexUsed: 0, unlockedFlexSlots: 0, activeItemsUsed: 0,
      },
      reasonCodes: [],
    }],
  };
}

function waitingSession(): AdaptivePlanSessionV1 {
  return {
    planSessionId: 'p-wait', strategyId: 's', revision: 1, createdAtGameTimeSec: 1, updatedAtGameTimeSec: 1,
    state: 'WAITING', nextStepId: undefined, reasonCodes: ['WAITING_ON_PLAN_BARRIER'],
    steps: [{
      stepId: 'wait-flex', goalId: 'g', kind: 'BARRIER', state: 'BLOCKED',
      barrier: { type: 'WAIT_FOR_FLEX', targetItemId: 2, requiredUnlockedFlexSlots: 1 },
      prerequisiteStepIds: [], blockingReasons: ['INSUFFICIENT_FLEX'],
      projectedBefore: projection,
      reasonCodes: [],
    }],
  };
}

function validBuild() {
  return [
    { itemId: 1, position: 1, status: 'OWNED' as const, score: 0, confidence: 1, skeletonStrength: 0, contextualSupport: 1, reasonCodes: [] },
    { itemId: 2, position: 2, status: 'NEXT' as const, score: 0, confidence: 0, skeletonStrength: 0, contextualSupport: 0, reasonCodes: ['TRANSACTION_STEP:replace'] },
  ];
}

describe('transaction plan invariants v1', () => {
  it('accepts a coherent replacement source of truth and compatibility projection', () => {
    const check = evaluateTransactionPlanInvariantsV1({
      decision: decision([1]),
      planSession: validSession(),
      nextAction: { actionKey: 'REPLACE_ITEM:1->2', type: 'REPLACE', sellItemId: 1, buyItemId: 2, targetItemId: 2, reasonCodes: [] },
      recommendedBuild: validBuild(),
    });
    expect(check.valid).toBe(true);
  });

  it('accepts a waiting HOLD and semantic NEXT that match the blocked barrier target', () => {
    const check = evaluateTransactionPlanInvariantsV1({
      decision: decision([1]),
      planSession: waitingSession(),
      nextAction: { actionKey: 'HOLD', type: 'HOLD', targetItemId: 2, reasonCodes: ['WAIT_FOR_FLEX'] },
      recommendedBuild: validBuild(),
    });
    expect(check.valid).toBe(true);
  });

  it('rejects a waiting HOLD that points at a different target than the blocked barrier', () => {
    const check = evaluateTransactionPlanInvariantsV1({
      decision: decision([1]),
      planSession: waitingSession(),
      nextAction: { actionKey: 'HOLD', type: 'HOLD', targetItemId: 3, reasonCodes: ['WAIT_FOR_FLEX'] },
      recommendedBuild: validBuild(),
    });
    expect(check.violations.some((violation) => violation.code === 'NEXT_STEP_MISMATCH')).toBe(true);
  });

  it('allows PLANNED semantic targets beyond the transaction plan horizon', () => {
    const check = evaluateTransactionPlanInvariantsV1({
      decision: decision([1]),
      planSession: validSession(),
      nextAction: { actionKey: 'REPLACE_ITEM:1->2', type: 'REPLACE', sellItemId: 1, buyItemId: 2, targetItemId: 2, reasonCodes: [] },
      recommendedBuild: [
        ...validBuild(),
        { itemId: 3, position: 3, status: 'PLANNED', score: 0, confidence: 0, skeletonStrength: 0, contextualSupport: 0, reasonCodes: ['STRATEGIC_FUTURE_TARGET'] },
      ],
    });
    expect(check.violations.some((violation) => violation.code === 'FUTURE_TARGET_WITHOUT_STEP')).toBe(false);
    expect(check.valid).toBe(true);
  });

  it('rejects a NEXT action that does not match planSession.nextStepId', () => {
    const check = evaluateTransactionPlanInvariantsV1({
      decision: decision([1]),
      planSession: validSession(),
      nextAction: { actionKey: 'BUY_ITEM:3', type: 'BUY', itemId: 3, buyItemId: 3, targetItemId: 3, reasonCodes: [] },
      recommendedBuild: [],
    });
    expect(check.violations.some((violation) => violation.code === 'NEXT_STEP_MISMATCH')).toBe(true);
  });

  it('rejects a structurally aligned NEXT transaction that is not executable now', () => {
    const check = evaluateTransactionPlanInvariantsV1({
      decision: decision([1], 0),
      planSession: validSession(),
      nextAction: { actionKey: 'REPLACE_ITEM:1->2', type: 'REPLACE', sellItemId: 1, buyItemId: 2, targetItemId: 2, reasonCodes: [] },
      recommendedBuild: validBuild(),
    });
    expect(check.violations.some((violation) => violation.code === 'NEXT_NOT_EXECUTABLE')).toBe(true);
  });

  it('rejects an unknown flex path and an over-capacity projection', () => {
    const base = validSession();
    const broken: AdaptivePlanSessionV1 = {
      ...base,
      nextStepId: undefined,
      state: 'WAITING',
      steps: [{
        stepId: 'flex', goalId: 'g', kind: 'BARRIER', state: 'BLOCKED',
        barrier: { type: 'WAIT_FOR_FLEX', targetItemId: 2, requiredUnlockedFlexSlots: 1 },
        prerequisiteStepIds: [], blockingReasons: ['INSUFFICIENT_FLEX'],
        projectedBefore: { ...projection, flexUsed: 1, unlockedFlexSlots: undefined }, reasonCodes: [],
      }],
    };
    const check = evaluateTransactionPlanInvariantsV1({
      decision: decision([1]), planSession: broken,
      nextAction: { actionKey: 'HOLD', type: 'HOLD', targetItemId: 2, reasonCodes: [] }, recommendedBuild: [],
    });
    expect(check.violations.some((violation) => violation.code === 'UNKNOWN_SLOT_PATH')).toBe(true);
    expect(check.violations.some((violation) => violation.code === 'PROJECTED_SLOT_VIOLATION')).toBe(true);
  });

  it('rejects a projected inventory above the 12-item held cap even when flex usage reports within capacity', () => {
    const base = validSession();
    const broken: AdaptivePlanSessionV1 = {
      ...base,
      steps: base.steps.map((step) => ({
        ...step,
        projectedAfter: step.projectedAfter
          ? {
              ...step.projectedAfter,
              inventoryItemIds: Array.from({ length: 13 }, (_, index) => index + 1),
              flexUsed: 12,
              unlockedFlexSlots: 12,
            }
          : undefined,
      })),
    };
    const check = evaluateTransactionPlanInvariantsV1({
      decision: decision([1]),
      planSession: broken,
      nextAction: { actionKey: 'REPLACE_ITEM:1->2', type: 'REPLACE', sellItemId: 1, buyItemId: 2, targetItemId: 2, reasonCodes: [] },
      recommendedBuild: validBuild(),
    });
    expect(check.violations.some((violation) => violation.code === 'PROJECTED_SLOT_VIOLATION')).toBe(true);
  });

  it('summarizes zero-tolerance rates by decision', () => {
    const valid = evaluateTransactionPlanInvariantsV1({
      decision: decision([1]), planSession: validSession(),
      nextAction: { actionKey: 'REPLACE_ITEM:1->2', type: 'REPLACE', sellItemId: 1, buyItemId: 2, targetItemId: 2, reasonCodes: [] },
      recommendedBuild: validBuild(),
    });
    const invalid = evaluateTransactionPlanInvariantsV1({
      decision: decision([1]), planSession: validSession(),
      nextAction: { actionKey: 'BUY_ITEM:3', type: 'BUY', itemId: 3, targetItemId: 3, reasonCodes: [] },
      recommendedBuild: [],
    });
    const summary = summarizeTransactionPlanInvariantChecksV1([valid, invalid]);
    expect(summary.evaluatedDecisions).toBe(2);
    expect(summary.nextStepMismatchRate).toBe(0.5);
  });

  it('keeps every hard transaction release rate at zero for a valid served path', () => {
    const valid = evaluateTransactionPlanInvariantsV1({
      decision: decision([1]),
      planSession: validSession(),
      nextAction: { actionKey: 'REPLACE_ITEM:1->2', type: 'REPLACE', sellItemId: 1, buyItemId: 2, targetItemId: 2, reasonCodes: [] },
      recommendedBuild: validBuild(),
    });
    const summary = summarizeTransactionPlanInvariantChecksV1([valid]);
    expect(summary).toEqual({
      evaluatedDecisions: 1,
      futureTargetWithoutStepRate: 0,
      projectedSlotViolationRate: 0,
      replaceWithoutValidatedBuyRate: 0,
      nextStepMismatchRate: 0,
      nextNotExecutableRate: 0,
      unknownSlotPathRate: 0,
      compatibilityProjectionDivergenceRate: 0,
    });
  });
});
