import {
  createRecommendationItemGraph,
  observedFact,
} from '@deadlock-live-probe/build-domain';
import { AdaptiveBuildPlannerV1Service } from '../src/statlocker-adaptive/adaptive-build-planner-v1.service';
import {
  RecommendationEconomyRulesV1,
  deriveAdaptiveInvestmentStateV1,
  deriveAdaptiveSlotStateV1,
} from '../src/statlocker-adaptive/adaptive-economy-v1';
import { AdaptiveEvidenceScorerV1Service } from '../src/statlocker-adaptive/adaptive-evidence-scorer-v1.service';
import { ConsensusBuildGroupV1 } from '../src/statlocker-adaptive/statlocker-adaptive.types';

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
  return createRecommendationItemGraph([
    directItem(1),
    directItem(2),
    directItem(3),
    upgradeItem(11, 1),
    upgradeItem(12, 2),
  ]);
}

function directItem(itemId: number) {
  return {
    itemId,
    name: `Item ${itemId}`,
    slotType: 'weapon' as const,
    active: false,
    availableRulesetIds: ['ruleset-a'],
    directPurchaseCost: 800,
    upgradeRecipes: [],
    sellTransition: { soulsRefund: 400, returnedItemIds: [] as number[] },
    maxCopies: 1,
  };
}

function upgradeItem(itemId: number, componentId: number) {
  return {
    itemId,
    name: `Item ${itemId}`,
    slotType: 'weapon' as const,
    active: false,
    availableRulesetIds: ['ruleset-a'],
    upgradeRecipes: [{
      recipeId: `upgrade-${itemId}`,
      consumedItemIds: [componentId],
      soulsCost: 800,
    }],
    sellTransition: { soulsRefund: 800, returnedItemIds: [] as number[] },
    maxCopies: 1,
  };
}

function inventory(ids: readonly number[]) {
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

function decision(owned: readonly number[]) {
  const itemGraph = graph();
  return {
    state: {
      decisionId: 'decision-a',
      matchId: 'match-a',
      playerSlot: 0,
      gameTimeSec: 700,
      rulesetId: 'ruleset-a',
      heroId: 10,
      inventory: inventory(owned),
      economy: {
        spendableSouls: observedFact(5000, 'test'),
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
    ourTeamSouls: 100000,
    enemyTeamSouls: 100000,
    slots: deriveAdaptiveSlotStateV1(owned, itemGraph, economyRules, {
      unlockedFlexSlots: 3,
      evidence: 'OBSERVED',
    }),
    investment: deriveAdaptiveInvestmentStateV1(owned, itemGraph, economyRules),
    economyRules,
    stateRevision: 'revision-a',
  } as any;
}

function choice(itemIds: readonly number[], maxSelect = 1): ConsensusBuildGroupV1 {
  return {
    groupId: `choice:${itemIds.join(',')}`,
    phase: 'EARLY',
    type: 'CHOICE',
    minSelect: maxSelect,
    maxSelect,
    candidates: itemIds.map((itemId) => ({
      itemId,
      strength: 0.8,
      coverage: 0.8,
      purchaseRate: 0.8,
      medianBuyTimeS: 300,
      timingSpreadS: 30,
      sourceProfileCount: 8,
      frequencyTier: 'CORE' as const,
      rushEvidence: false,
    })),
    confidence: 0.9,
    inferred: false,
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

function evidence(group: ConsensusBuildGroupV1, exactWpa: Readonly<Record<number, number>>) {
  const itemIds = group.candidates.map((candidate) => candidate.itemId);
  const wpaItems = itemIds.map((itemId) => ({
    heroId: 10,
    itemId,
    meanWpa: 0,
    sampleSize: 2000,
    wpaConfidence: 1,
    gameState: { even: 0 },
    purchaseTiming: { medianPurchaseSec: 300 },
  }));
  const exactItems = itemIds.map((itemId) => ({
    itemId,
    deltaWpa: exactWpa[itemId] ?? 0,
    count: 5000,
  }));
  const byDataset = {
    WPA_PATCH_DATA: family('WPA_PATCH_DATA', { patchId: '15-1', items: wpaItems }),
    VS_HERO_WPA: family('VS_HERO_WPA', {
      slices: [{ heroId: 10, enemyHeroId: 20, items: exactItems }],
    }),
    T4_CHAINS: family('T4_CHAINS', { chains: [] }),
    CONSENSUS_SKELETON: family('CONSENSUS_SKELETON', {
      heroId: 10,
      profileCount: 10,
      groups: [group],
    }),
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
    // Threat-weighted roadmap: exact-enemy slices are superseded by the relational
    // draft-matchup aggregate; the scorer no longer reads VS_HERO_WPA slices.
    draftMatchupByItemId: Object.fromEntries(
      itemIds.map((itemId) => {
        const raw = exactWpa[itemId] ?? 0;
        return [String(itemId), {
          raw,
          normalized: Math.tanh(raw / 0.15),
          confidence: raw === 0 ? 0 : 0.8,
          coverage: raw === 0 ? 0 : 1,
          usedCount: raw === 0 ? 0 : 1,
          contributions: [],
        }];
      }),
    ),
  } as any;
}

describe('AdaptiveBuildPlannerV1Service committed choice replacement', () => {
  const planner = new AdaptiveBuildPlannerV1Service(new AdaptiveEvidenceScorerV1Service());

  it('does not replace a committed direct branch below the stricter replacement threshold', () => {
    const group = choice([1, 2]);
    const result = planner.plan({
      decision: decision([1]),
      evidence: evidence(group, { 1: 0, 2: 0.01 }),
    });

    expect(result.nextAction.type).not.toBe('REPLACE');
    expect(result.recommendedBuild.some((item) => item.itemId === 2)).toBe(false);
  });

  it('does not sell branch-unique commitment evidence below the replacement threshold', () => {
    const group = choice([11, 12]);
    const result = planner.plan({
      decision: decision([1]),
      evidence: evidence(group, { 11: 0, 12: 0.02 }),
    });

    expect(result.nextAction.sellItemId).not.toBe(1);
    expect(result.nextAction.targetItemId).toBe(11);
    expect(result.recommendedBuild.some((item) => item.itemId === 12)).toBe(false);
  });

  it('can explicitly REPLACE a committed direct branch when contextual improvement clears the threshold', () => {
    const group = choice([1, 2]);
    const result = planner.plan({
      decision: decision([1]),
      evidence: evidence(group, { 1: 0, 2: 0.9 }),
    });

    expect(result.nextAction.type).toBe('SELL');
    expect(result.nextAction.sellItemId).toBe(1);
    expect(result.recommendedBuild.find((item) => item.itemId === 2)?.status).toBe('NEXT');
  });

  it('can replace branch-unique component investment without re-planning the committed branch', () => {
    const group = choice([11, 12]);
    const result = planner.plan({
      decision: decision([1]),
      evidence: evidence(group, { 11: 0, 12: 0.9 }),
    });

    expect(['SELL', 'REPLACE']).toContain(result.nextAction.type);
    expect(result.nextAction.sellItemId).toBe(1);
    expect(result.recommendedBuild.some((item) => item.itemId === 11 && item.status !== 'OWNED')).toBe(false);
    expect(result.recommendedBuild.some((item) => item.itemId === 12)).toBe(true);
  });

  it('above threshold, divests only one committed K-of-N branch and retains the other', () => {
    const group = choice([1, 2, 3], 2);
    const result = planner.plan({
      decision: decision([1, 2]),
      evidence: evidence(group, { 1: 0, 2: 0, 3: 0.9 }),
    });
    const soldItemId = result.nextAction.sellItemId;
    const retainedItemId = soldItemId === 1 ? 2 : 1;

    expect(['SELL', 'REPLACE']).toContain(result.nextAction.type);
    expect([1, 2]).toContain(soldItemId);
    expect(result.nextAction.targetItemId).toBe(3);
    expect(result.recommendedBuild.find((item) => item.itemId === retainedItemId)?.status).toBe('OWNED');
    expect(result.recommendedBuild.some((item) => item.itemId === 3)).toBe(true);
  });
});
