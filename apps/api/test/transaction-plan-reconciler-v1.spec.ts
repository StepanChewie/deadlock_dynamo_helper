import {
  RecommendationItemDefinition,
  buildInventoryInstancesForRecommendation,
  createRecommendationItemGraph,
  observedFact,
} from '@deadlock-live-probe/build-domain';
import { AdaptivePlanStepV1 } from '@deadlock-live-probe/shared';
import { AdaptiveDecisionStateV1 } from '../src/statlocker-adaptive/adaptive-decision-state-v1.service';
import { deriveAdaptiveSlotStateV1, unknownAdaptiveInvestmentStateV1 } from '../src/statlocker-adaptive/adaptive-economy-v1';
import { TransactionPlanReconcilerV1Service } from '../src/statlocker-adaptive/transaction-plan-reconciler-v1.service';

const items: RecommendationItemDefinition[] = [1, 2, 3, 4].map((itemId) => ({
  itemId, name: `Item ${itemId}`, slotType: 'weapon', active: false, availableRulesetIds: ['r1'], directPurchaseCost: 500,
  upgradeRecipes: [], sellTransition: { soulsRefund: 250, returnedItemIds: [] }, maxCopies: 1,
}));
const graph = createRecommendationItemGraph(items);
const slotRules = { baseSlots: 12, baseSlotsByType: { weapon: 4, vitality: 4, spirit: 4 } as const, maxFlexSlots: 4, maxActiveItems: 4 };

function decision(owned: readonly number[], gameTimeSec = 100): AdaptiveDecisionStateV1 {
  const held = buildInventoryInstancesForRecommendation(owned, graph);
  return {
    state: {
      decisionId: `d-${gameTimeSec}`, matchId: 'm', playerSlot: 0, gameTimeSec, rulesetId: 'r1', heroId: 1,
      inventory: { initializedFromSnapshot: true, heldByItemId: held, lifecycleCountByItemId: new Map(), nextInstanceSequence: held.size + 1 },
      economy: { spendableSouls: observedFact(5000, 'test'), shopOpportunity: observedFact('AVAILABLE', 'test') },
    },
    itemGraph: graph, catalogVersionId: 'c', catalogSha256: 'e'.repeat(64), rulesetId: 'r1', localSteamId: 'p',
    allyHeroIds: [],
    enemyLiveStates: [], enemyHeroIds: [], allyItemIds: [], enemyItemIds: [],
    slots: deriveAdaptiveSlotStateV1(owned, graph, slotRules, { unlockedFlexSlots: 0, evidence: 'OBSERVED' }),
    investment: unknownAdaptiveInvestmentStateV1(), economyRulesEvidence: 'UNKNOWN', stateRevision: `r-${gameTimeSec}`,
  };
}

const projection = {
  inventoryItemIds: [] as number[], spendableSouls: 5000,
  usedByType: { weapon: 0, vitality: 0, spirit: 0 }, flexUsed: 0, unlockedFlexSlots: 0, activeItemsUsed: 0,
};

function buyStep(stepId: string, goalId: string, itemId: number, prerequisiteStepIds: readonly string[] = []): AdaptivePlanStepV1 {
  return {
    stepId, goalId, kind: 'TRANSACTION', state: 'READY', action: { type: 'BUY', buyItemId: itemId },
    prerequisiteStepIds, blockingReasons: [], projectedBefore: projection, reasonCodes: [],
  };
}

describe('transaction plan reconciler v1', () => {
  const reconciler = new TransactionPlanReconcilerV1Service();

  it('preserves session and stable step ids for identical semantic proposals', () => {
    const proposed = [buyStep('step-1', 'g1', 1), buyStep('step-2', 'g2', 2)];
    const first = reconciler.reconcile({ strategyId: 's', gameTimeSec: 100, proposedSteps: proposed, proposedReachable: true, decision: decision([]) });
    const second = reconciler.reconcile({ previous: first, strategyId: 's', gameTimeSec: 101, proposedSteps: proposed, proposedReachable: true, decision: decision([], 101) });
    expect(second.planSessionId).toBe(first.planSessionId);
    expect(second.steps.map((step) => step.stepId)).toEqual(first.steps.map((step) => step.stepId));
  });

  it('marks an executed NEXT step completed while preserving the suffix identity', () => {
    const proposed = [buyStep('step-1', 'g1', 1), buyStep('step-2', 'g2', 2)];
    const first = reconciler.reconcile({ strategyId: 's', gameTimeSec: 100, proposedSteps: proposed, proposedReachable: true, decision: decision([]) });
    const second = reconciler.reconcile({ previous: first, strategyId: 's', gameTimeSec: 110, proposedSteps: [buyStep('step-2', 'g2', 2)], proposedReachable: true, decision: decision([1], 110) });
    expect(second.steps.find((step) => step.stepId === 'step-1')?.state).toBe('COMPLETED');
    expect(second.steps.find((step) => step.stepId === 'step-2')?.stepId).toBe('step-2');
    expect(second.nextStepId).toBe('step-2');
  });

  it('replaces only the changed suffix when the third semantic step changes', () => {
    const original = [buyStep('step-1', 'g1', 1), buyStep('step-2', 'g2', 2), buyStep('step-3', 'g3', 3)];
    const first = reconciler.reconcile({ strategyId: 's', gameTimeSec: 100, proposedSteps: original, proposedReachable: true, decision: decision([]) });
    const changed = [buyStep('step-1', 'g1', 1), buyStep('step-2', 'g2', 2), buyStep('step-4', 'g3', 4)];
    const second = reconciler.reconcile({ previous: first, strategyId: 's', gameTimeSec: 101, proposedSteps: changed, proposedReachable: true, decision: decision([], 101) });
    expect(second.steps.slice(0, 2).map((step) => step.stepId)).toEqual(['step-1', 'step-2']);
    expect(second.steps.map((step) => step.stepId)).toContain('step-4');
    expect(second.steps.map((step) => step.stepId)).not.toContain('step-3');
  });

  it('replans only the affected suffix after a manual alternate-branch purchase', () => {
    const original = [
      buyStep('core', 'core-goal', 1),
      buyStep('branch-a', 'branch-a-goal', 2, ['core']),
      buyStep('late-a', 'late-goal', 3, ['branch-a']),
    ];
    const first = reconciler.reconcile({
      strategyId: 's', gameTimeSec: 100, proposedSteps: original, proposedReachable: true, decision: decision([]),
    });
    const alternate = [
      buyStep('core', 'core-goal', 1),
      buyStep('branch-b', 'branch-b-goal', 4, ['core']),
      buyStep('late-b', 'late-goal', 3, ['branch-b']),
    ];
    const second = reconciler.reconcile({
      previous: first,
      strategyId: 's',
      gameTimeSec: 110,
      proposedSteps: alternate,
      proposedReachable: true,
      decision: decision([4], 110),
    });

    expect(second.planSessionId).toBe(first.planSessionId);
    expect(second.steps[0]?.stepId).toBe('core');
    expect(second.steps.map((step) => step.stepId)).not.toContain('branch-a');
    expect(second.steps.map((step) => step.stepId)).not.toContain('late-a');
    expect(second.steps.find((step) => step.stepId === 'branch-b')?.state).toBe('COMPLETED');
    expect(second.steps.map((step) => step.stepId)).toContain('late-b');
  });

  it('creates a new session id on strategy switch', () => {
    const first = reconciler.reconcile({ strategyId: 's1', gameTimeSec: 100, proposedSteps: [buyStep('step-1', 'g1', 1)], proposedReachable: true, decision: decision([]) });
    const second = reconciler.reconcile({ previous: first, strategyId: 's2', gameTimeSec: 101, proposedSteps: [buyStep('step-9', 'g9', 4)], proposedReachable: true, decision: decision([], 101) });
    expect(second.planSessionId).not.toBe(first.planSessionId);
  });

  it('marks a leading barrier as waiting and never as NEXT', () => {
    const barrier: AdaptivePlanStepV1 = {
      stepId: 'flex', goalId: 'g', kind: 'BARRIER', state: 'BLOCKED',
      barrier: { type: 'WAIT_FOR_FLEX', targetItemId: 1, requiredUnlockedFlexSlots: 1 }, prerequisiteStepIds: [],
      blockingReasons: ['INSUFFICIENT_FLEX'], projectedBefore: projection, reasonCodes: ['WAIT_FOR_FLEX'],
    };
    const current = reconciler.reconcile({ strategyId: 's', gameTimeSec: 100, proposedSteps: [barrier, buyStep('buy', 'g', 1)], proposedReachable: true, decision: decision([]) });
    expect(current.state).toBe('WAITING');
    expect(current.nextStepId).toBeUndefined();
    expect(current.steps[0].state).toBe('BLOCKED');
    expect(current.steps[1].state).toBe('LOCKED');
  });

  it('fails closed when the compiler reports no reachable path', () => {
    const current = reconciler.reconcile({ strategyId: 's', gameTimeSec: 100, proposedSteps: [], proposedReachable: false, decision: decision([]) });
    expect(current.state).toBe('REPLAN_REQUIRED');
    expect(current.nextStepId).toBeUndefined();
  });
});
