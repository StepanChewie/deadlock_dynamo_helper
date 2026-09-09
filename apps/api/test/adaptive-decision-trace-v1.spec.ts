import { createRecommendationItemGraph, observedFact } from '@deadlock-live-probe/build-domain';
import { AdaptiveDecisionTraceV1Service, reconcileAdaptiveDecisionTraceFinalSelectionV1 } from '../src/statlocker-adaptive/adaptive-decision-trace-v1.service';
import { StrategyFirstBuildPlannerV1Result } from '../src/statlocker-adaptive/strategy-first-build-planner-v1.service';

const items = Array.from({ length: 13 }, (_, index) => {
  const itemId = index + 1;
  return {
    itemId,
    name: `Item ${itemId}`,
    slotType: 'weapon' as const,
    active: false,
    availableRulesetIds: ['r1'],
    directPurchaseCost: 800,
    upgradeRecipes: [],
    sellTransition: { soulsRefund: 400, returnedItemIds: [] },
    maxCopies: 1,
  };
});
const graph = createRecommendationItemGraph(items);
const ownedItemIds = items.slice(0, 12).map((item) => item.itemId);

const decision: any = {
  state: {
    decisionId: 'decision-trace',
    matchId: 'match-trace',
    playerSlot: 0,
    gameTimeSec: 1200,
    rulesetId: 'r1',
    heroId: 1,
    inventory: {
      initializedFromSnapshot: true,
      heldByItemId: new Map(ownedItemIds.map((itemId, index) => [itemId, {
        instanceId: `i-${index}`,
        itemId,
        acquiredAtGameTimeSec: 100,
      }])),
      lifecycleCountByItemId: new Map(ownedItemIds.map((itemId) => [itemId, 1])),
      nextInstanceSequence: 13,
    },
    economy: {
      spendableSouls: observedFact(5000, 'test'),
      shopOpportunity: observedFact('AVAILABLE', 'test'),
    },
  },
  itemGraph: graph,
  catalogVersionId: 'c',
  catalogSha256: 'a'.repeat(64),
  rulesetId: 'r1',
  localSteamId: 'p',
  allyHeroIds: [],
  enemyHeroIds: [99],
  enemyLiveStates: [],
  allyItemIds: [],
  enemyItemIds: [],
  slots: {
    baseSlots: 0,
    baseSlotsByType: { weapon: 0, vitality: 0, spirit: 0 },
    maxActiveItems: 4,
    maxFlexSlots: 12,
    unlockedFlexSlots: 12,
    usedSlots: 12,
    usedFlexSlots: 12,
    usedSlotsByType: { weapon: 12, vitality: 0, spirit: 0 },
    overflowByType: { weapon: 12, vitality: 0, spirit: 0 },
    provedFlexLowerBound: 12,
    freeBaseSlots: 0,
    freeFlexSlots: 0,
    totalCapacity: 12,
    flexEvidence: 'OBSERVED',
    mechanicsEvidence: 'RECONSTRUCTED',
    evidence: 'OBSERVED',
  },
  investment: {
    tracks: {
      weapon: { type: 'weapon', currentValue: 9600 },
      vitality: { type: 'vitality', currentValue: 0 },
      spirit: { type: 'spirit', currentValue: 0 },
    },
    evidence: 'RECONSTRUCTED',
  },
  economyRules: {
    rulesetId: 'r1',
    catalogSha256: 'a'.repeat(64),
    baseSlots: 0,
    baseSlotsByType: { weapon: 0, vitality: 0, spirit: 0 },
    maxActiveItems: 4,
    maxFlexSlots: 12,
    investmentBreakpoints: { weapon: [3200], vitality: [3200], spirit: [3200] },
  },
  economyRulesEvidence: 'RECONSTRUCTED',
  stateRevision: 'revision-trace',
};

const strategy: any = {
  schemaVersion: 1,
  strategyId: 'strategy-trace',
  heroId: 1,
  rulesetId: 'r1',
  sourcePatchId: 'p',
  support: 1,
  stability: 1,
  representativeTraceId: 't',
  goals: [{
    goalId: 'target',
    type: 'CORE',
    phase: 'MID',
    targetItemIds: [13],
    minSelect: 1,
    maxSelect: 1,
    prerequisiteGoalIds: [],
    hard: true,
    rigidity: 'HARD_CORE',
    lifecycleByItemId: { 13: 'PERMANENT_CORE' },
    rationaleCodes: ['CORE'],
  }],
  branchGroups: [],
  situationalWindows: [],
  investmentPolicy: { objectives: [], preferredWeights: { weapon: 1, vitality: 0, spirit: 0 } },
  slotPolicy: { reservedSituationalSlots: 0, maxTemporarySlots: 0 },
  terminalPolicy: { requiredGoalIds: ['target'], allowWaiveSoftGoals: true },
};

const evidence: any = {
  heroId: 1,
  rulesetVersion: 'r1',
  catalogSha256: 'a'.repeat(64),
  statlockerPatchId: 'p',
  usable: true,
  snapshotIds: [],
  degradedReasons: [],
  families: [],
  byDataset: {},
};

const scorer: any = {
  scoreItem(itemId: number) {
    const weighted = itemId === 2 ? 0.1 : itemId === 13 ? 0.8 : 0.4;
    return {
      itemId,
      score: weighted,
      confidence: 0.9,
      completeness: 1,
      components: [{ key: 'skeletonPrior', raw: weighted, normalized: weighted, confidence: 0.9, weight: 1, weighted }],
      version: 'adaptive-evidence-scorer-v1',
    };
  },
};

const result = {
  gameState: 'EVEN',
  strategy,
  strategySelection: { selectedStrategyId: strategy.strategyId, commitment: 'PROVISIONAL', posteriors: [], reasonCodes: [] },
  strategySession: { strategyId: strategy.strategyId, commitment: 'PROVISIONAL', posterior: 1, selectedAtGameTimeSec: 1200, replanReasons: [] },
  contract: {
    strategyId: strategy.strategyId,
    status: 'IN_PROGRESS',
    commitment: 'PROVISIONAL',
    currentGoalId: 'target',
    goalStates: { target: 'ACTIVE' },
    selectedBranches: {},
    committedBranches: {},
    temporaryItemIds: [],
    reservedSituationalWindowIds: [],
    remainingHardGoalIds: ['target'],
    completionReasonCodes: ['MANDATORY_GOALS_REMAIN'],
  },
  strategyPlan: {
    strategyId: strategy.strategyId,
    buildStatus: 'IN_PROGRESS',
    progress: { satisfiedHardGoals: 0, totalHardGoals: 1 },
    currentGoal: { goalId: 'target', type: 'CORE', reasonCodes: ['CORE'] },
    remainingGoalIds: ['target'],
    slotPlan: { currentUsedSlots: 12, currentFlexUsed: 12, unlockedFlexSlots: 12, reservedSituationalSlots: 0, futureTransitions: [], feasible: true, reasonCodes: [] },
    investmentPlan: { objectives: [], activeObjectiveIds: [] },
  },
  nextAction: { actionKey: 'replace:2:13', type: 'REPLACE', sellItemId: 2, buyItemId: 13, targetItemId: 13, reasonCodes: ['WHOLE_BUILD_REPLACEMENT_ACCEPTED'] },
  recommendedBuild: [
    ...ownedItemIds.filter((itemId) => itemId !== 2).map((itemId, index) => ({ itemId, position: index + 1, status: 'OWNED' as const, score: 0, confidence: 1, skeletonStrength: 0, contextualSupport: 1, reasonCodes: ['OWNED_ITEM'] })),
    { itemId: 13, position: 12, status: 'NEXT' as const, score: 0.8, confidence: 0.9, skeletonStrength: 0, contextualSupport: 0.9, reasonCodes: ['CORE'] },
  ],
  changes: [],
  rankedImmediateCandidates: [{
    action: { actionKey: 'replace:2:13', type: 'REPLACE', sellItemId: 2, buyItemId: 13, targetItemId: 13, reasonCodes: ['WHOLE_BUILD_REPLACEMENT_ACCEPTED'] },
    score: 0.8,
    confidence: 0.9,
    components: [],
    reasonCodes: ['WHOLE_BUILD_REPLACEMENT_ACCEPTED'],
  }],
  totalScore: 0.8,
  confidence: 0.9,
  plannerVersion: 'strategy-first-build-planner-v1',
} as any as StrategyFirstBuildPlannerV1Result;

describe('adaptive decision trace v1', () => {
  it('exposes a bounded replacement trace and the exact effective policy snapshot', () => {
    const trace = new AdaptiveDecisionTraceV1Service(scorer).build({
      decision,
      evidence,
      previousResult: undefined,
      recentPurchasedItemIds: [],
      recentSoldItemIds: [],
    }, result);

    expect(trace.version).toBe('adaptive-decision-trace-v1');
    expect(trace.stages).toEqual(expect.arrayContaining(['SKELETON_BASELINE', 'SELL_SOURCE_EVALUATION', 'FINAL_SELECTION']));
    expect(trace.policy).toMatchObject({
      heldItemCapacity: 12,
      threatWeights: { souls: 0.35, heroDamage: 0.30, killsAssists: 0.20, level: 0.10, deaths: -0.05 },
      threatClamp: { min: 0.75, max: 1.5 },
      thresholds: { planSwitch: 0.08, sellBuy: 0.20, softCoreReplace: 0.25, wildcardReplace: 0.30 },
      recentPurchaseProtectionMs: 120000,
      soldItemRebuyPenaltyMs: 180000,
    });
    expect(trace.replacements.length).toBeLessThanOrEqual(6);
    expect(trace.replacements).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sellItemId: 2,
        buyItemId: 13,
        inventoryCount: 12,
        maxItemCount: 12,
        selected: true,
        accepted: true,
        requiredThreshold: 0.20,
      }),
    ]));
    const selected = trace.replacements.find((row: any) => row.selected)!;
    expect(Number.isFinite(selected.utilityBefore)).toBe(true);
    expect(Number.isFinite(selected.utilityAfter)).toBe(true);
    expect(Number.isFinite(selected.rawImprovement)).toBe(true);
    expect(Number.isFinite(selected.netImprovement)).toBe(true);
  });

  it('reconciles final selection after a fresh-legality change', () => {
    const trace = new AdaptiveDecisionTraceV1Service(scorer).build({ decision, evidence } as any, result);
    const hold = { actionKey: 'HOLD', type: 'HOLD' as const, reasonCodes: ['FRESH_NEXT_TRANSACTION_NOT_EXECUTABLE'] };
    const reconciled = reconcileAdaptiveDecisionTraceFinalSelectionV1(trace, hold, true)!;

    expect(reconciled.finalSelection.action).toEqual(hold);
    expect(reconciled.finalSelection.legalityRecheckChanged).toBe(true);
    expect(reconciled.candidates.every((candidate: any) => !candidate.selected)).toBe(true);
    expect(reconciled.replacements.every((replacement: any) => !replacement.selected)).toBe(true);
  });
});
