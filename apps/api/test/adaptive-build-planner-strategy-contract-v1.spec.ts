import {
  createRecommendationItemGraph,
  observedFact,
} from '@deadlock-live-probe/build-domain';
import { AdaptiveBuildPlannerV1Service } from '../src/statlocker-adaptive/adaptive-build-planner-v1.service';
import {
  deriveAdaptiveInvestmentStateV1,
  deriveAdaptiveSlotStateV1,
} from '../src/statlocker-adaptive/adaptive-economy-v1';

function item(itemId: number, upgradeFrom?: number) {
  return {
    itemId,
    name: `Item ${itemId}`,
    slotType: 'weapon' as const,
    active: false,
    availableRulesetIds: ['ruleset-a'],
    ...(upgradeFrom === undefined ? { directPurchaseCost: 800 } : {}),
    upgradeRecipes: upgradeFrom === undefined
      ? []
      : [{ recipeId: `upgrade:${itemId}`, consumedItemIds: [upgradeFrom], soulsCost: 800 }],
    sellTransition: { soulsRefund: 400, returnedItemIds: [] },
    maxCopies: 1,
  };
}

function candidate(itemId: number) {
  return {
    itemId,
    strength: 0.8,
    coverage: 0.8,
    purchaseRate: 0.8,
    medianBuyTimeS: 900,
    timingSpreadS: 90,
    sourceProfileCount: 10,
    frequencyTier: 'CORE' as const,
    rushEvidence: false,
  };
}

function family(dataset: string, payload: unknown) {
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

function fixture() {
  const graph = createRecommendationItemGraph([
    item(1),
    item(2),
    item(3),
    item(11, 1),
    item(50),
  ]);
  const economyRules = {
    rulesetId: 'ruleset-a',
    catalogSha256: 'a'.repeat(64),
    baseSlotsByType: { weapon: 4, vitality: 4, spirit: 4 },
    maxFlexSlots: 4,
    maxActiveItems: 4,
    investmentBreakpoints: {
      weapon: [1600, 3200],
      vitality: [1600, 3200],
      spirit: [1600, 3200],
    },
  } as const;
  const slots = deriveAdaptiveSlotStateV1(
    [],
    graph,
    {
      baseSlotsByType: economyRules.baseSlotsByType,
      maxFlexSlots: economyRules.maxFlexSlots,
      maxActiveItems: economyRules.maxActiveItems,
      evidence: 'RECONSTRUCTED',
    },
    { unlockedFlexSlots: 0, evidence: 'OBSERVED' },
  );
  const skeleton = {
    heroId: 10,
    profileCount: 10,
    groups: [
      {
        groupId: 'early-core',
        phase: 'EARLY',
        type: 'REQUIRED',
        minSelect: 1,
        maxSelect: 1,
        candidates: [{ ...candidate(1), medianBuyTimeS: 240 }],
        confidence: 0.9,
        inferred: false,
      },
      {
        groupId: 'mid-choice',
        phase: 'MID',
        type: 'CHOICE',
        minSelect: 1,
        maxSelect: 1,
        candidates: [candidate(2), candidate(3)],
        confidence: 0.9,
        inferred: false,
      },
      {
        groupId: 'mid-situational',
        phase: 'MID',
        type: 'OPTIONAL',
        minSelect: 0,
        maxSelect: 1,
        candidates: [{ ...candidate(50), frequencyTier: 'SOMETIMES' as const }],
        confidence: 0.8,
        inferred: false,
      },
    ],
  } as any;
  const byDataset = {
    WPA_PATCH_DATA: family('WPA_PATCH_DATA', { patchId: '15-1', items: [] }),
    VS_HERO_WPA: family('VS_HERO_WPA', { slices: [] }),
    T4_CHAINS: family('T4_CHAINS', { chains: [] }),
    CONSENSUS_SKELETON: family('CONSENSUS_SKELETON', skeleton),
    WPA_FILTERED_ITEMS: family('WPA_FILTERED_ITEMS', { heroId: 10, items: [] }),
  };
  const evidence = {
    heroId: 10,
    rulesetVersion: 'ruleset-a',
    catalogSha256: 'a'.repeat(64),
    statlockerPatchId: '15-1',
    usable: true,
    snapshotIds: Object.values(byDataset).map((entry) => entry.snapshotId),
    degradedReasons: [],
    families: Object.values(byDataset),
    byDataset,
  } as any;
  const decision = {
    state: {
      decisionId: 'decision-a',
      matchId: 'match-a',
      playerSlot: 0,
      gameTimeSec: 120,
      rulesetId: 'ruleset-a',
      heroId: 10,
      inventory: {
        initializedFromSnapshot: true,
        heldByItemId: new Map(),
        lifecycleCountByItemId: new Map(),
        nextInstanceSequence: 1,
      },
      economy: {
        spendableSouls: observedFact(5000, 'test'),
        shopOpportunity: observedFact('AVAILABLE' as const, 'test'),
      },
    },
    itemGraph: graph,
    catalogVersionId: 'catalog-a',
    catalogSha256: 'a'.repeat(64),
    rulesetId: 'ruleset-a',
    localSteamId: 'steam-a',
    enemyHeroIds: [20],
    enemyLiveStates: [],
    ourTeamSouls: 100000,
    enemyTeamSouls: 100000,
    slots,
    investment: deriveAdaptiveInvestmentStateV1([], graph, economyRules),
    economyRules,
    economyRulesEvidence: 'RECONSTRUCTED',
    stateRevision: 'revision-a',
  } as any;
  return { decision, evidence };
}

function scorer() {
  return {
    scoreItem: jest.fn((itemId: number) => ({
      itemId,
      score: itemId === 50 ? 10 : itemId === 3 ? 5 : 1,
      confidence: 1,
      components: [],
    })),
  } as any;
}

describe('AdaptiveBuildPlannerV1Service strategy contract integration', () => {
  it('does not score a future CHOICE or closed OPTIONAL item before the current core goal', () => {
    const score = scorer();
    const planner = new AdaptiveBuildPlannerV1Service(score);
    const { decision, evidence } = fixture();

    const result = planner.plan({ decision, evidence });
    const scoredIds = score.scoreItem.mock.calls.map((call: [number]) => call[0]);

    expect(scoredIds).toContain(1);
    expect(scoredIds).not.toContain(2);
    expect(scoredIds).not.toContain(3);
    expect(scoredIds).not.toContain(50);
    expect(result.buildContract.status).toBe('IN_PROGRESS');
    expect(result.buildContract.currentGoalId).toBe('early-core');
  });

  it('only admits an OPTIONAL item when an explicit situational window is open for it', () => {
    const score = scorer();
    const planner = new AdaptiveBuildPlannerV1Service(score);
    const { decision, evidence } = fixture();

    planner.plan({
      decision,
      evidence,
      situationalWindowStates: [{
        windowId: 'catch-window',
        state: 'OPEN',
        targetItemIds: [50],
        reasonCodes: ['MATCHUP_SUPPORTED'],
      }],
    });

    const scoredIds = score.scoreItem.mock.calls.map((call: [number]) => call[0]);
    expect(scoredIds).toContain(50);
  });

  it('keeps HOLD separate from build completion when mandatory goals remain', () => {
    const score = scorer();
    const planner = new AdaptiveBuildPlannerV1Service(score);
    const { decision, evidence } = fixture();
    const first = planner.plan({ decision, evidence });

    const held = planner.plan({
      decision,
      evidence,
      previousResult: {
        recommendedBuild: first.recommendedBuild,
        totalScore: first.totalScore + 100,
        nextAction: first.nextAction,
        confidence: first.confidence,
      },
    });

    expect(held.nextAction.type).toBe('HOLD');
    expect(held.buildContract.status).toBe('IN_PROGRESS');
    expect(held.buildContract.remainingGoalIds.length).toBeGreaterThan(0);
  });
});
