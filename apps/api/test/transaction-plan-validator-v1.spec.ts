import {
  RecommendationItemDefinition,
  buildInventoryInstancesForRecommendation,
  createRecommendationItemGraph,
  observedFact,
} from '@deadlock-live-probe/build-domain';
import { AdaptivePlanSessionV1 } from '@deadlock-live-probe/shared';
import { AdaptiveDecisionStateV1 } from '../src/statlocker-adaptive/adaptive-decision-state-v1.service';
import { deriveAdaptiveSlotStateV1, unknownAdaptiveInvestmentStateV1 } from '../src/statlocker-adaptive/adaptive-economy-v1';
import { TransactionPlanValidatorV1Service } from '../src/statlocker-adaptive/transaction-plan-validator-v1.service';
import { planProjectionFromDecisionStateV1 } from '../src/statlocker-adaptive/transaction-plan-step-v1';
import { candidateGeneratorRulesFromSlotStateV1 } from '../src/statlocker-adaptive/adaptive-economy-v1';

const items: RecommendationItemDefinition[] = [
  {
    itemId: 1, name: 'Temporary', slotType: 'weapon', active: false, availableRulesetIds: ['r1'], directPurchaseCost: 500,
    upgradeRecipes: [], sellTransition: { soulsRefund: 250, returnedItemIds: [] }, maxCopies: 1,
  },
  ...[2, 3, 4].map((itemId): RecommendationItemDefinition => ({
    itemId, name: `Core ${itemId}`, slotType: 'weapon', active: false, availableRulesetIds: ['r1'], directPurchaseCost: 500,
    upgradeRecipes: [], maxCopies: 1,
  })),
  {
    itemId: 5, name: 'Target', slotType: 'weapon', active: false, availableRulesetIds: ['r1'], directPurchaseCost: 1000,
    upgradeRecipes: [], maxCopies: 1,
  },
  {
    itemId: 6, name: 'Upgrade', slotType: 'weapon', active: false, availableRulesetIds: ['r1'],
    upgradeRecipes: [{ recipeId: 'upgrade-6', consumedItemIds: [1, 2], soulsCost: 500 }], maxCopies: 1,
  },
];
const graph = createRecommendationItemGraph(items);
const slotRules = { baseSlots: 12, baseSlotsByType: { weapon: 4, vitality: 4, spirit: 4 } as const, maxFlexSlots: 4, maxActiveItems: 4 };

function decision(ownedItemIds: readonly number[], unlockedFlexSlots = 0, souls = 5000): AdaptiveDecisionStateV1 {
  const held = buildInventoryInstancesForRecommendation(ownedItemIds, graph);
  return {
    state: {
      decisionId: 'd', matchId: 'm', playerSlot: 0, gameTimeSec: 1000, rulesetId: 'r1', heroId: 1,
      inventory: { initializedFromSnapshot: true, heldByItemId: held, lifecycleCountByItemId: new Map(), nextInstanceSequence: held.size + 1 },
      economy: { spendableSouls: observedFact(souls, 'test'), shopOpportunity: observedFact('AVAILABLE', 'test') },
    },
    itemGraph: graph, catalogVersionId: 'c', catalogSha256: 'd'.repeat(64), rulesetId: 'r1', localSteamId: 'p',
    allyHeroIds: [],
    enemyLiveStates: [], enemyHeroIds: [], allyItemIds: [], enemyItemIds: [],
    slots: deriveAdaptiveSlotStateV1(ownedItemIds, graph, slotRules, { unlockedFlexSlots, evidence: 'OBSERVED' }),
    investment: unknownAdaptiveInvestmentStateV1(), economyRulesEvidence: 'UNKNOWN', stateRevision: 'r',
  };
}

function projection(d: AdaptiveDecisionStateV1) {
  return planProjectionFromDecisionStateV1(d.state, d.itemGraph, candidateGeneratorRulesFromSlotStateV1(d.slots));
}

function session(steps: AdaptivePlanSessionV1['steps']): AdaptivePlanSessionV1 {
  return {
    planSessionId: 'plan', strategyId: 's', revision: 1, createdAtGameTimeSec: 1000, updatedAtGameTimeSec: 1000,
    state: 'ACTIVE', steps, nextStepId: steps.find((step) => step.state === 'NEXT')?.stepId, reasonCodes: [],
  };
}

describe('transaction plan validator v1', () => {
  const validator = new TransactionPlanValidatorV1Service();

  it('accepts an atomic full-slot SELL_AND_BUY path', () => {
    const d = decision([1, 2, 3, 4]);
    const before = projection(d);
    const afterDecision = decision([2, 3, 4, 5], 0, 4250);
    const plan = session([{
      stepId: 'replace', goalId: 'g', kind: 'TRANSACTION', state: 'NEXT',
      action: { type: 'SELL_AND_BUY', sellItemId: 1, buyItemId: 5 }, prerequisiteStepIds: [], blockingReasons: [],
      projectedBefore: before, projectedAfter: projection(afterDecision), reasonCodes: [],
    }]);
    expect(validator.validate({ session: plan, decision: d }).valid).toBe(true);
  });

  it('accepts WAIT_FOR_FLEX followed by a future BUY', () => {
    const d = decision([1, 2, 3, 4], 0);
    const before = projection(d);
    const future = decision([1, 2, 3, 4], 1, 5000);
    const after = decision([1, 2, 3, 4, 5], 1, 4000);
    const plan = session([
      {
        stepId: 'flex', goalId: 'g', kind: 'BARRIER', state: 'BLOCKED',
        barrier: { type: 'WAIT_FOR_FLEX', targetItemId: 5, requiredUnlockedFlexSlots: 1 }, prerequisiteStepIds: [],
        blockingReasons: ['INSUFFICIENT_FLEX'], projectedBefore: before, reasonCodes: ['WAIT_FOR_FLEX'],
      },
      {
        stepId: 'buy', goalId: 'g', kind: 'TRANSACTION', state: 'LOCKED', action: { type: 'BUY', buyItemId: 5 },
        prerequisiteStepIds: ['flex'], blockingReasons: [], projectedBefore: projection(future), projectedAfter: projection(after), reasonCodes: [],
      },
    ]);
    expect(validator.validate({ session: plan, decision: d }).valid).toBe(true);
  });

  it('accepts upgrade compression before a later purchase', () => {
    const d = decision([1, 2, 3, 4]);
    const afterUpgrade = decision([3, 4, 6], 0, 4500);
    const afterBuy = decision([3, 4, 5, 6], 0, 3500);
    const plan = session([
      {
        stepId: 'upgrade', goalId: 'upgrade-goal', kind: 'TRANSACTION', state: 'NEXT',
        action: { type: 'UPGRADE', buyItemId: 6, consumedItemIds: [1, 2], recipeId: 'upgrade-6' },
        prerequisiteStepIds: [], blockingReasons: [], projectedBefore: projection(d), projectedAfter: projection(afterUpgrade), reasonCodes: [],
      },
      {
        stepId: 'buy', goalId: 'target-goal', kind: 'TRANSACTION', state: 'LOCKED', action: { type: 'BUY', buyItemId: 5 },
        prerequisiteStepIds: ['upgrade'], blockingReasons: [], projectedBefore: projection(afterUpgrade), projectedAfter: projection(afterBuy), reasonCodes: [],
      },
    ]);
    expect(validator.validate({ session: plan, decision: d }).valid).toBe(true);
  });

  it('rejects a projectedAfter mismatch', () => {
    const d = decision([1, 2, 3, 4]);
    const invalidAfter = { ...projection(decision([2, 3, 4, 5], 0, 4250)), flexUsed: 99 };
    const plan = session([{
      stepId: 'replace', goalId: 'g', kind: 'TRANSACTION', state: 'NEXT',
      action: { type: 'SELL_AND_BUY', sellItemId: 1, buyItemId: 5 }, prerequisiteStepIds: [], blockingReasons: [],
      projectedBefore: projection(d), projectedAfter: invalidAfter, reasonCodes: [],
    }]);
    const result = validator.validate({ session: plan, decision: d });
    expect(result.valid).toBe(false);
    expect(result.violations.some((violation) => violation.code === 'PROJECTED_AFTER_MISMATCH')).toBe(true);
  });

  it('rejects a full-slot BUY with no exit path', () => {
    const d = decision([1, 2, 3, 4]);
    const plan = session([{
      stepId: 'buy', goalId: 'g', kind: 'TRANSACTION', state: 'NEXT', action: { type: 'BUY', buyItemId: 5 },
      prerequisiteStepIds: [], blockingReasons: [], projectedBefore: projection(d), reasonCodes: [],
    }]);
    const result = validator.validate({ session: plan, decision: d });
    expect(result.valid).toBe(false);
    expect(result.violations.some((violation) => violation.code === 'TRANSACTION_NOT_EXECUTABLE')).toBe(true);
  });

  it('rejects a transaction before an unsatisfied prerequisite', () => {
    const d = decision([]);
    const plan = session([{
      stepId: 'buy', goalId: 'g', kind: 'TRANSACTION', state: 'NEXT', action: { type: 'BUY', buyItemId: 5 },
      prerequisiteStepIds: ['missing'], blockingReasons: [], projectedBefore: projection(d), reasonCodes: [],
    }]);
    const result = validator.validate({ session: plan, decision: d });
    expect(result.valid).toBe(false);
    expect(result.violations.some((violation) => violation.code === 'PREREQUISITE_NOT_SATISFIED')).toBe(true);
  });
});