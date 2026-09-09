import {
  buildInventoryInstancesForRecommendation,
  createRecommendationItemGraph,
  observedFact,
  RecommendationItemDefinition,
} from '@deadlock-live-probe/build-domain';
import {
  deriveAdaptiveSlotStateV1,
  unknownAdaptiveInvestmentStateV1,
} from '../src/statlocker-adaptive/adaptive-economy-v1';
import { BuildStrategySpecV1 } from '../src/statlocker-adaptive/build-strategy-v1';
import { StrategyFirstBuildPlannerV1Service } from '../src/statlocker-adaptive/strategy-first-build-planner-v1.service';

const items: RecommendationItemDefinition[] = Array.from({ length: 13 }, (_, index) => {
  const itemId = index + 1;
  return {
    itemId,
    name: `Item ${itemId}`,
    slotType: 'weapon',
    active: false,
    availableRulesetIds: ['r1'],
    directPurchaseCost: itemId === 1 ? 100 : itemId === 2 ? 200 : 800,
    upgradeRecipes: [],
    sellTransition: { soulsRefund: 400, returnedItemIds: [] },
  };
});

const graph = createRecommendationItemGraph(items);
const ownedItemIds = items.slice(0, 12).map((item) => item.itemId);
const slotRules = {
  baseSlots: 0,
  baseSlotsByType: { weapon: 0, vitality: 0, spirit: 0 } as const,
  maxFlexSlots: 12,
  maxActiveItems: 4,
  evidence: 'RECONSTRUCTED' as const,
};

const decision: any = {
  state: {
    decisionId: 'd',
    matchId: 'm',
    playerSlot: 0,
    gameTimeSec: 1200,
    rulesetId: 'r1',
    heroId: 1,
    inventory: {
      initializedFromSnapshot: true,
      heldByItemId: buildInventoryInstancesForRecommendation(ownedItemIds, graph),
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
  allyItemIds: [],
  enemyItemIds: [],
  slots: deriveAdaptiveSlotStateV1(
    ownedItemIds,
    graph,
    slotRules,
    { unlockedFlexSlots: 12, evidence: 'OBSERVED' },
  ),
  investment: unknownAdaptiveInvestmentStateV1(),
  economyRulesEvidence: 'UNKNOWN',
  stateRevision: 'revision-test',
};

const strategy: BuildStrategySpecV1 = {
  schemaVersion: 1,
  strategyId: 'whole-build-replacement',
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

const scorer = {
  scoreItem(itemId: number) {
    const weighted = itemId === 1 ? 0.9 : itemId === 2 ? 0.1 : itemId === 13 ? 0.8 : 0.4;
    return {
      itemId,
      score: weighted,
      confidence: 0.9,
      completeness: 1,
      components: [{
        key: 'skeletonPrior',
        raw: weighted,
        normalized: weighted,
        confidence: 0.9,
        weight: 1,
        weighted,
      }],
      version: 'adaptive-evidence-scorer-v1' as const,
    };
  },
} as any;

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

describe('strategy-first whole-build replacement v1', () => {
  it('sells the lower-value flex item instead of the cheapest item at 12/12', () => {
    const planner = new StrategyFirstBuildPlannerV1Service(scorer);
    const result = planner.plan({ decision, evidence, strategies: [strategy], planningDepth: 1 });

    expect(result.rankedImmediateCandidates[0]?.action).toMatchObject({
      type: 'REPLACE',
      sellItemId: 2,
      buyItemId: 13,
    });
    expect(result.nextAction).toMatchObject({
      type: 'REPLACE',
      sellItemId: 2,
      buyItemId: 13,
      targetItemId: 13,
    });
    expect(result.nextAction.type).not.toBe('BUY');
    expect(result.strategyPlan.slotPlan.futureTransitions[0]).toMatchObject({
      requirement: 'REPLACE',
      sourceItemId: 2,
      targetItemId: 13,
    });
    expect(result.strategyPlan.slotPlan.reasonCodes).toContain('WHOLE_BUILD_REPLACEMENT_SELECTED');
    expect(result.recommendedBuild).toHaveLength(12);
    expect(result.recommendedBuild.some((item) => item.itemId === 2)).toBe(false);
    expect(result.recommendedBuild.find((item) => item.itemId === 13)?.status).toBe('NEXT');
  });
});
