import {
  DEFAULT_RECOMMENDATION_CANDIDATE_RULES,
  createRecommendationItemGraph,
  generateRecommendationCandidates,
  observedFact,
} from '@deadlock-live-probe/build-domain';
import { AdaptiveBuildPlannerV1Service } from '../src/statlocker-adaptive/adaptive-build-planner-v1.service';
import {
  RecommendationEconomyRulesV1,
  deriveAdaptiveInvestmentStateV1,
  deriveAdaptiveSlotStateV1,
} from '../src/statlocker-adaptive/adaptive-economy-v1';
import { AdaptiveEvidenceScorerV1Service } from '../src/statlocker-adaptive/adaptive-evidence-scorer-v1.service';
import {
  createAdaptivePlannerNodeV1,
  projectPlannerCandidateV1,
} from '../src/statlocker-adaptive/adaptive-planner-transition-v1';
import {
  ConsensusBuildGroupTypeV1,
  ConsensusBuildGroupV1,
  ConsensusBuildPhaseV1,
} from '../src/statlocker-adaptive/statlocker-adaptive.types';

const catalogSha256 = 'a'.repeat(64);
const economyRules: RecommendationEconomyRulesV1 = {
  rulesetId: 'ruleset-a',
  catalogSha256,
  baseSlots: 9,
  maxFlexSlots: 3,
  baseSlotsByType: { weapon: 3, vitality: 3, spirit: 3 },
  maxActiveItems: 4,
  investmentBreakpoints: {
    weapon: [1600, 3200, 6400],
    vitality: [1600, 3200, 6400],
    spirit: [1600, 3200, 6400],
  },
};

function graph() {
  const items = Array.from({ length: 12 }, (_, index) => {
    const itemId = index + 1;
    return {
      itemId,
      name: `Item ${itemId}`,
      slotType: itemId % 3 === 0 ? 'spirit' as const : itemId % 3 === 1 ? 'weapon' as const : 'vitality' as const,
      active: false,
      availableRulesetIds: ['ruleset-a'],
      directPurchaseCost: 800,
      upgradeRecipes: [] as { recipeId: string; consumedItemIds: number[]; soulsCost: number }[],
      sellTransition: { soulsRefund: 400, returnedItemIds: [] as number[] },
      maxCopies: 1,
    };
  });
  items[10] = {
    ...items[10],
    slotType: 'weapon',
    directPurchaseCost: undefined as unknown as number,
    upgradeRecipes: [{ recipeId: 'upgrade-11', consumedItemIds: [1], soulsCost: 800 }],
  };
  items[11] = {
    ...items[11],
    slotType: 'vitality',
    directPurchaseCost: undefined as unknown as number,
    upgradeRecipes: [{ recipeId: 'upgrade-12', consumedItemIds: [2], soulsCost: 800 }],
  };
  return createRecommendationItemGraph(items);
}

function inventory(ids: number[]) {
  return {
    initializedFromSnapshot: true,
    heldByItemId: new Map(ids.map((itemId, index) => [itemId, {
      itemId,
      instanceId: `item-${itemId}`,
      lifecycle: 1,
      acquiredBy: 'RECONCILE' as const,
      acquiredAtMs: index,
    }])),
    lifecycleCountByItemId: new Map(ids.map((itemId) => [itemId, 1])),
    nextInstanceSequence: ids.length + 1,
  };
}

function decision(options: { owned?: number[]; wallet?: number; gameTimeSec?: number } = {}) {
  const itemGraph = graph();
  const owned = options.owned ?? [];
  const slots = deriveAdaptiveSlotStateV1(
    owned,
    itemGraph,
    { baseSlots: 9, maxFlexSlots: 3, baseSlotsByType: { weapon: 3, vitality: 3, spirit: 3 }, maxActiveItems: 4 },
    { unlockedFlexSlots: 3, evidence: 'OBSERVED' },
  );
  return {
    state: {
      decisionId: 'decision-lineage',
      matchId: 'match-lineage',
      playerSlot: 0,
      gameTimeSec: options.gameTimeSec ?? 700,
      rulesetId: 'ruleset-a',
      heroId: 10,
      inventory: inventory(owned),
      economy: {
        spendableSouls: observedFact(options.wallet ?? 5_000, 'test'),
        shopOpportunity: observedFact('AVAILABLE', 'test'),
      },
    },
    itemGraph,
    catalogVersionId: 'catalog-a',
    catalogSha256,
    rulesetId: 'ruleset-a',
    localSteamId: 'steam-a',
    enemyHeroIds: [20],
    enemyLiveStates: [],
    ourTeamSouls: 100_000,
    enemyTeamSouls: 100_000,
    slots,
    investment: deriveAdaptiveInvestmentStateV1(owned, itemGraph, economyRules),
    economyRules,
    stateRevision: 'revision-a',
  } as any;
}

function group(
  groupId: string,
  phase: ConsensusBuildPhaseV1,
  type: ConsensusBuildGroupTypeV1,
  itemIds: number[],
): ConsensusBuildGroupV1 {
  return {
    groupId,
    phase,
    type,
    minSelect: 1,
    maxSelect: 1,
    candidates: itemIds.map((itemId) => ({
      itemId,
      strength: 0.8,
      coverage: 0.8,
      purchaseRate: 0.8,
      medianBuyTimeS: phase === 'EARLY' ? 300 : phase === 'MID' ? 900 : 1800,
      timingSpreadS: 90,
      sourceProfileCount: 8,
      frequencyTier: 'CORE',
      rushEvidence: false,
    })),
    confidence: 0.9,
    inferred: false,
  };
}

function family(dataset: string, payload: any) {
  return {
    dataset,
    scopeKey: dataset === 'CONSENSUS_SKELETON' ? 'hero:10:consensus' : 'global',
    snapshotId: `${dataset}-snapshot`,
    contentSha256: 'b'.repeat(64),
    freshness: 'FRESH',
    confidence: 1,
    payload,
  } as any;
}

function evidence(groups: ConsensusBuildGroupV1[], exactWpa: Record<number, number> = {}) {
  const candidateIds = [...new Set(groups.flatMap((entry) => entry.candidates.map((candidate) => candidate.itemId)))];
  const wpaItems = candidateIds.map((itemId) => ({
    heroId: 10,
    itemId,
    meanWpa: 0,
    sampleSize: 1_000,
    wpaConfidence: 1,
    gameState: { even: 0 },
    purchaseTiming: { medianPurchaseSec: 700 },
  }));
  const exactItems = candidateIds.map((itemId) => ({ itemId, deltaWpa: exactWpa[itemId] ?? 0, count: 2_000 }));
  const byDataset = {
    WPA_PATCH_DATA: family('WPA_PATCH_DATA', { patchId: '15-1', items: wpaItems }),
    VS_HERO_WPA: family('VS_HERO_WPA', { slices: [{ heroId: 10, enemyHeroId: 20, items: exactItems }] }),
    T4_CHAINS: family('T4_CHAINS', { chains: [] }),
    CONSENSUS_SKELETON: family('CONSENSUS_SKELETON', { heroId: 10, profileCount: 10, groups }),
    WPA_FILTERED_ITEMS: family('WPA_FILTERED_ITEMS', { heroId: 10, items: wpaItems }),
  };
  return {
    heroId: 10,
    rulesetVersion: 'ruleset-a',
    catalogSha256,
    statlockerPatchId: '15-1',
    usable: true,
    snapshotIds: Object.values(byDataset).map((entry) => entry.snapshotId),
    degradedReasons: [],
    families: Object.values(byDataset),
    byDataset,
  } as any;
}

function previousPlan(itemId: number) {
  return {
    recommendedBuild: [{
      itemId,
      position: 1,
      status: 'NEXT',
      score: 1,
      confidence: 1,
      skeletonStrength: 1,
      contextualSupport: 0,
      reasonCodes: [],
    }],
    totalScore: 100,
    nextAction: {
      actionKey: `BUY_ITEM:${itemId}`,
      type: 'BUY',
      itemId,
      targetItemId: itemId,
      reasonCodes: [],
    },
    confidence: 1,
  } as any;
}

describe('adaptive upgrade-lineage recommendation satisfaction', () => {
  const planner = new AdaptiveBuildPlannerV1Service(new AdaptiveEvidenceScorerV1Service());

  it.each(['REQUIRED', 'CHOICE'] as const)('protects the owned descendant satisfying a %s target from unrelated sales', (type) => {
    const result = planner.plan({
      decision: decision({ owned: [11], wallet: 400 }),
      evidence: evidence([
        group('committed', 'EARLY', type, type === 'CHOICE' ? [1, 2] : [1]),
        group('next', 'EARLY', 'REQUIRED', [3]),
      ]),
    });

    expect(result.rankedImmediateCandidates.some((entry) =>
      (entry.action.type === 'SELL' && entry.action.itemId === 11) ||
      (entry.action.type === 'REPLACE' && entry.action.sellItemId === 11),
    )).toBe(false);
    expect(['SELL', 'REPLACE']).not.toContain(result.nextAction.type);
  });

  it('treats a required lower component as completed when its upgrade descendant is owned', () => {
    const result = planner.plan({
      decision: decision({ owned: [11] }),
      evidence: evidence([
        group('lower-core', 'EARLY', 'REQUIRED', [1]),
        group('next-core', 'EARLY', 'REQUIRED', [4]),
      ]),
    });

    expect(result.recommendedBuild.some((entry) => entry.itemId === 1 && entry.status !== 'OWNED')).toBe(false);
    expect(result.rankedImmediateCandidates.some((entry) => entry.action.targetItemId === 1)).toBe(false);
    expect(result.nextAction.targetItemId).not.toBe(1);
    expect(result.recommendedBuild.find((entry) => entry.status === 'NEXT')?.itemId).toBe(4);
  });

  it('recognizes an owned descendant as commitment to a lower CHOICE target', () => {
    const result = planner.plan({
      decision: decision({ owned: [11] }),
      evidence: evidence(
        [group('choice', 'EARLY', 'CHOICE', [1, 2])],
        { 1: 0, 2: 1 },
      ),
    });

    expect(result.recommendedBuild.some((entry) => entry.itemId === 2 && entry.status !== 'OWNED')).toBe(false);
    expect(result.nextAction.targetItemId).not.toBe(2);
  });

  it('does not preserve a stale lower-component NEXT after its upgrade descendant becomes owned', () => {
    const result = planner.plan({
      decision: decision({ owned: [11] }),
      evidence: evidence([
        group('lower-core', 'EARLY', 'REQUIRED', [1]),
        group('next-core', 'EARLY', 'REQUIRED', [4]),
      ]),
      previousResult: previousPlan(1),
    });

    expect(result.nextAction.targetItemId).not.toBe(1);
    expect(result.recommendedBuild.some((entry) => entry.itemId === 1 && entry.status !== 'OWNED')).toBe(false);
  });

  it('recomputes satisfaction after a projected upgrade and suppresses the consumed ancestor', () => {
    const current = decision({ owned: [1], wallet: 5_000 });
    const rules = {
      ...DEFAULT_RECOMMENDATION_CANDIDATE_RULES,
      baseSlots: current.slots.baseSlots,
      maxFlexSlots: current.slots.maxFlexSlots,
      unlockedFlexSlots: current.slots.unlockedFlexSlots,
      flexCapacityEvidence: current.slots.evidence,
    };
    const candidates = generateRecommendationCandidates({
      state: current.state,
      itemGraph: current.itemGraph,
      rules,
    });
    const upgrade = candidates.find((entry) => entry.actionId === 'UPGRADE_ITEM:11:upgrade-11');
    expect(upgrade).toBeDefined();
    expect(upgrade?.feasible).toBe(true);

    const projected = projectPlannerCandidateV1({
      node: createAdaptivePlannerNodeV1({
        decisionState: current.state,
        slots: current.slots,
        investment: current.investment,
      }),
      candidate: upgrade!,
      graph: current.itemGraph,
      economyRules: current.economyRules,
    });

    expect([...projected.node.decisionState.inventory.heldByItemId.keys()]).toEqual([11]);
    const projectedCandidates = generateRecommendationCandidates({
      state: projected.node.decisionState,
      itemGraph: current.itemGraph,
      rules,
    });
    const ancestorBuy = projectedCandidates.find((entry) => entry.actionId === 'BUY_ITEM:1');
    expect(ancestorBuy).toMatchObject({
      feasible: true,
      recommendationEligible: false,
      recommendationSuppressionReasons: ['TARGET_SATISFIED_BY_OWNED_UPGRADE'],
    });
    expect(projectedCandidates.some((entry) => entry.actionId === 'WAIT_SAVE:1')).toBe(false);
  });
});
