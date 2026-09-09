import {
  RecommendationItemDefinition,
  buildInventoryInstancesForRecommendation,
  createRecommendationItemGraph,
  observedFact,
} from '@deadlock-live-probe/build-domain';
import { deriveAdaptiveSlotStateV1, unknownAdaptiveInvestmentStateV1 } from '../src/statlocker-adaptive/adaptive-economy-v1';
import { StrategyFirstBuildPlannerV1Service } from '../src/statlocker-adaptive/strategy-first-build-planner-v1.service';
import { StrategyFirstSituationalOverlayV1Service } from '../src/statlocker-adaptive/strategy-first-situational-overlay-v1.service';
import { BuildStrategySpecV1 } from '../src/statlocker-adaptive/build-strategy-v1';

const items: RecommendationItemDefinition[] = [
  { itemId: 1, name: 'Core', slotType: 'weapon', active: false, availableRulesetIds: ['r1'], directPurchaseCost: 800, upgradeRecipes: [], sellTransition: { soulsRefund: 400, returnedItemIds: [] } },
  { itemId: 2, name: 'Anti CC', slotType: 'vitality', active: false, availableRulesetIds: ['r1'], directPurchaseCost: 800, upgradeRecipes: [], sellTransition: { soulsRefund: 400, returnedItemIds: [] } },
  { itemId: 3, name: 'Matchup Discovery', slotType: 'spirit', active: false, availableRulesetIds: ['r1'], directPurchaseCost: 800, upgradeRecipes: [], sellTransition: { soulsRefund: 400, returnedItemIds: [] } },
];
const graph = createRecommendationItemGraph(items);
const slotRules = { baseSlots: 12, baseSlotsByType: { weapon: 4, vitality: 4, spirit: 4 } as const, maxFlexSlots: 4, maxActiveItems: 4 };
const decision: any = {
  state: {
    decisionId: 'd', matchId: 'm', playerSlot: 0, gameTimeSec: 500, rulesetId: 'r1', heroId: 1,
    inventory: { initializedFromSnapshot: true, heldByItemId: buildInventoryInstancesForRecommendation([], graph), lifecycleCountByItemId: new Map(), nextInstanceSequence: 1 },
    economy: { spendableSouls: observedFact(5000, 'test'), shopOpportunity: observedFact('AVAILABLE', 'test') },
  },
  itemGraph: graph, catalogVersionId: 'c', catalogSha256: 'a'.repeat(64), rulesetId: 'r1', localSteamId: 'p',
  allyHeroIds: [], enemyHeroIds: [99], allyItemIds: [], enemyItemIds: [9001],
  slots: deriveAdaptiveSlotStateV1([], graph, slotRules, { unlockedFlexSlots: 0, evidence: 'OBSERVED' }),
  investment: unknownAdaptiveInvestmentStateV1(), economyRulesEvidence: 'UNKNOWN', stateRevision: 'revision-test',
};
const strategy: BuildStrategySpecV1 = {
  schemaVersion: 1, strategyId: 's', heroId: 1, rulesetId: 'r1', sourcePatchId: 'p', support: 1, stability: 1,
  representativeTraceId: 't',
  goals: [{
    goalId: 'core', type: 'CORE', phase: 'EARLY', targetItemIds: [1], minSelect: 1, maxSelect: 1,
    prerequisiteGoalIds: [], hard: true, lifecycleByItemId: { 1: 'PERMANENT_CORE' }, rationaleCodes: ['CORE'],
  }],
  branchGroups: [],
  situationalWindows: [{
    windowId: 'anti-cc-now', afterGoalIds: [], beforeGoalIds: ['core'], maxSlots: 1, maxSouls: 1000, maxCoreDelaySouls: 1000,
    allowedPurposes: ['ANTI_CC'], candidateItemIdsByPurpose: { ANTI_CC: [2] },
  }],
  investmentPolicy: { objectives: [], preferredWeights: { weapon: 1, vitality: 0, spirit: 0 } },
  slotPolicy: { reservedSituationalSlots: 1, maxTemporarySlots: 0 },
  terminalPolicy: { requiredGoalIds: ['core'], allowWaiveSoftGoals: true },
};

const scorer = {
  scoreItem(itemId: number) {
    const score = itemId === 3 ? 1.4 : itemId === 2 ? 1.2 : 0.5;
    const matchup = itemId === 3 ? 0.7 : itemId === 2 ? 0.5 : 0;
    return {
      itemId,
      score,
      confidence: itemId === 1 ? 0.8 : 0.9,
      completeness: 1,
      components: matchup > 0
        ? [{ key: 'draftMatchupFit', raw: matchup, normalized: matchup, confidence: 0.9, weight: 1, weighted: matchup }]
        : [],
      version: 'adaptive-evidence-scorer-v1' as const,
    };
  },
} as any;

const evidence: any = {
  heroId: 1, rulesetVersion: 'r1', catalogSha256: 'a'.repeat(64), statlockerPatchId: 'p', usable: true,
  snapshotIds: [], degradedReasons: [], families: [], byDataset: {},
  draftMatchupByItemId: {
    '3': {
      raw: 0.08,
      normalized: 0.7,
      confidence: 0.9,
      coverage: 1,
      usedCount: 1,
      contributions: [],
    },
  },
};

describe('strategy-first situational integration v1', () => {
  it('selects a bounded situational transaction only when it beats continuing core', () => {
    const planner = new StrategyFirstBuildPlannerV1Service(scorer);
    const base = planner.plan({ decision, evidence, strategies: [strategy] });
    expect(base.nextAction.targetItemId).toBe(1);

    const result = new StrategyFirstSituationalOverlayV1Service(scorer).apply({
      result: base,
      decision,
      evidence,
    });

    expect(result.nextAction).toMatchObject({ type: 'BUY', itemId: 2, targetItemId: 2 });
    expect(result.contract.activeSituationalDecision).toMatchObject({
      windowId: 'anti-cc-now',
      purpose: 'ANTI_CC',
      targetItemId: 2,
      enemyHeroIds: [99],
      enemyItemIds: [9001],
    });
    expect(result.strategyPlan.situationalDecision?.targetItemId).toBe(2);
    expect(result.recommendedBuild.find((entry) => entry.itemId === 2)?.status).toBe('NEXT');
  });

  it('discovers a legal counter-enemy-heroes item outside the strategy skeleton', () => {
    const counterStrategy: BuildStrategySpecV1 = {
      ...strategy,
      situationalWindows: [{
        windowId: 'matchup-now',
        afterGoalIds: [],
        beforeGoalIds: ['core'],
        maxSlots: 1,
        maxSouls: 1000,
        maxCoreDelaySouls: 1000,
        allowedPurposes: ['COUNTER_ENEMY_HEROES'],
      }],
    };
    const planner = new StrategyFirstBuildPlannerV1Service(scorer);
    const base = planner.plan({ decision, evidence, strategies: [counterStrategy] });
    expect(base.nextAction.targetItemId).toBe(1);

    const result = new StrategyFirstSituationalOverlayV1Service(scorer).apply({
      result: base,
      decision,
      evidence,
    });

    expect(result.nextAction).toMatchObject({ type: 'BUY', itemId: 3, targetItemId: 3 });
    expect(result.contract.activeSituationalDecision).toMatchObject({
      windowId: 'matchup-now',
      purpose: 'COUNTER_ENEMY_HEROES',
      targetItemId: 3,
      enemyHeroIds: [99],
    });
    expect(result.contract.activeSituationalDecision?.reasonCodes).toContain('MATCHUP_DISCOVERY_OUTSIDE_SKELETON');
  });
});
