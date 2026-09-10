import {
  createRecommendationItemGraph,
  observedFact,
  unknownFact,
} from '@deadlock-live-probe/build-domain';
import { AdaptiveBuildPlannerV1Service } from '../src/statlocker-adaptive/adaptive-build-planner-v1.service';
import {
  RecommendationEconomyRulesV1,
  deriveAdaptiveInvestmentStateV1,
  deriveAdaptiveSlotStateV1,
} from '../src/statlocker-adaptive/adaptive-economy-v1';
import { AdaptiveEvidenceScorerV1Service } from '../src/statlocker-adaptive/adaptive-evidence-scorer-v1.service';
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
  baseSlotsByType: { weapon: 3, vitality: 3, spirit: 3 },
  maxFlexSlots: 3,
  maxActiveItems: 4,
  investmentBreakpoints: {
    weapon: [1600, 3200, 6400],
    vitality: [1600, 3200, 6400],
    spirit: [1600, 3200, 6400],
  },
};

function graph() {
  const standard = Array.from({ length: 30 }, (_, index) => {
    const itemId = index + 1;
    const slotType = itemId === 10
      ? 'vitality' as const
      : itemId % 3 === 0
        ? 'spirit' as const
        : itemId % 3 === 1
          ? 'weapon' as const
          : 'vitality' as const;
    return {
      itemId,
      name: `Item ${itemId}`,
      slotType,
      active: false,
      availableRulesetIds: ['ruleset-a'],
      directPurchaseCost: 800,
      upgradeRecipes: [] as { recipeId: string; consumedItemIds: number[]; soulsCost: number }[],
      sellTransition: { soulsRefund: 400, returnedItemIds: [] as number[] },
      maxCopies: 1,
    };
  });
  standard[0].slotType = 'weapon';
  standard[19].slotType = 'weapon';
  standard[10] = {
    ...standard[10],
    slotType: 'weapon',
    directPurchaseCost: undefined as unknown as number,
    upgradeRecipes: [{ recipeId: 'upgrade-11', consumedItemIds: [1], soulsCost: 800 }],
  };
  standard[11] = {
    ...standard[11],
    slotType: 'vitality',
    directPurchaseCost: undefined as unknown as number,
    upgradeRecipes: [{ recipeId: 'upgrade-12', consumedItemIds: [2], soulsCost: 800 }],
  };
  return createRecommendationItemGraph(standard);
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

function decision(options: {
  owned?: number[];
  wallet?: number;
  gameTimeSec?: number;
  flexEvidence?: 'OBSERVED' | 'RECONSTRUCTED' | 'UNKNOWN';
  unlockedFlexSlots?: number;
  verifiedEconomy?: boolean;
  shop?: 'AVAILABLE' | 'UNKNOWN';
} = {}) {
  const itemGraph = graph();
  const owned = options.owned ?? [];
  const rules = options.verifiedEconomy === false ? undefined : economyRules;
  const slotState = deriveAdaptiveSlotStateV1(
    owned,
    itemGraph,
    { baseSlots: 9, baseSlotsByType: { weapon: 3, vitality: 3, spirit: 3 }, maxFlexSlots: 3, maxActiveItems: 4 },
    {
      unlockedFlexSlots: options.unlockedFlexSlots ?? (options.flexEvidence === 'UNKNOWN' ? undefined : 3),
      evidence: options.flexEvidence ?? 'OBSERVED',
    },
  );
  return {
    state: {
      decisionId: 'decision-a',
      matchId: 'match-a',
      playerSlot: 0,
      gameTimeSec: options.gameTimeSec ?? 700,
      rulesetId: 'ruleset-a',
      heroId: 10,
      inventory: inventory(owned),
      economy: {
        spendableSouls: options.wallet === undefined ? observedFact(5000, 'test') : observedFact(options.wallet, 'test'),
        shopOpportunity: options.shop === 'UNKNOWN' ? unknownFact('test') : observedFact('AVAILABLE', 'test'),
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
    slots: slotState,
    investment: deriveAdaptiveInvestmentStateV1(owned, itemGraph, rules),
    economyRules: rules,
    stateRevision: 'revision-a',
  } as any;
}

function group(
  groupId: string,
  phase: ConsensusBuildPhaseV1,
  type: ConsensusBuildGroupTypeV1,
  itemIds: number[],
  options: { strength?: number; rushEvidence?: boolean; minSelect?: number; maxSelect?: number } = {},
): ConsensusBuildGroupV1 {
  return {
    groupId,
    phase,
    type,
    minSelect: options.minSelect ?? 1,
    maxSelect: options.maxSelect ?? 1,
    candidates: itemIds.map((itemId) => ({
      itemId,
      strength: options.strength ?? 0.8,
      coverage: 0.8,
      purchaseRate: 0.8,
      medianBuyTimeS: phase === 'EARLY' ? 300 : phase === 'MID' ? 900 : 1800,
      timingSpreadS: 90,
      sourceProfileCount: 8,
      frequencyTier: type === 'OPTIONAL' ? 'SOMETIMES' : 'CORE',
      rushEvidence: options.rushEvidence ?? false,
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

function evidence(options: {
  groups: ConsensusBuildGroupV1[];
  baseWpa?: Record<number, number>;
  exactWpa?: Record<number, number>;
  extraWpaItems?: number[];
}) {
  const candidateIds = [...new Set([
    ...options.groups.flatMap((entry) => entry.candidates.map((candidate) => candidate.itemId)),
    ...(options.extraWpaItems ?? []),
  ])].sort((a, b) => a - b);
  const wpaItems = candidateIds.map((itemId) => ({
    heroId: 10,
    itemId,
    meanWpa: options.baseWpa?.[itemId] ?? 0,
    sampleSize: 1000,
    wpaConfidence: 1,
    gameState: { even: options.baseWpa?.[itemId] ?? 0 },
    purchaseTiming: {
      medianPurchaseSec: options.groups
        .flatMap((entry) => entry.candidates)
        .find((candidate) => candidate.itemId === itemId)?.medianBuyTimeS ?? 700,
    },
  }));
  const exactItems = candidateIds.map((itemId) => ({
    itemId,
    deltaWpa: options.exactWpa?.[itemId] ?? 0,
    count: 2000,
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
      groups: options.groups,
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
      candidateIds.map((itemId) => {
        const raw = options.exactWpa?.[itemId] ?? 0;
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

function previousPlan(itemId: number) {
  return {
    recommendedBuild: [{
      itemId,
      position: 1,
      status: 'NEXT',
      score: 0.5,
      confidence: 0.6,
      skeletonStrength: 0.8,
      contextualSupport: 0.1,
      reasonCodes: [],
    }],
    totalScore: 0,
    nextAction: {
      actionKey: `BUY_ITEM:${itemId}`,
      type: 'BUY',
      itemId,
      targetItemId: itemId,
      reasonCodes: [],
    },
    confidence: 0.6,
  } as any;
}

describe('AdaptiveBuildPlannerV1Service structured planning', () => {
  const planner = new AdaptiveBuildPlannerV1Service(new AdaptiveEvidenceScorerV1Service());

  it('hard-gates a high-WPA MID item at 120 seconds while retaining only the next reachable phase as PLANNED', () => {
    const result = planner.plan({
      decision: decision({ gameTimeSec: 120 }),
      evidence: evidence({
        groups: [
          group('early-core', 'EARLY', 'REQUIRED', [1]),
          group('mid-core', 'MID', 'REQUIRED', [9]),
          group('late-core', 'LATE', 'REQUIRED', [18]),
        ],
        baseWpa: { 1: 0.01, 9: 0.8, 18: 0.95 },
        exactWpa: { 1: 0, 9: 0.8, 18: 0.95 },
      }),
    });

    expect(result.recommendedBuild.find((item) => item.status === 'NEXT')?.itemId).toBe(1);
    expect(result.recommendedBuild.find((item) => item.itemId === 9)?.status).toBe('PLANNED');
    expect(result.recommendedBuild.some((item) => item.itemId === 18)).toBe(false);
  });

  it('opens MID from reconstructed strong investment passed through the planner context', () => {
    const result = planner.plan({
      decision: decision({ gameTimeSec: 480, owned: [1, 2, 4, 5] }),
      evidence: evidence({
        groups: [
          group('early-core', 'EARLY', 'REQUIRED', [1]),
          group('mid-core', 'MID', 'REQUIRED', [9]),
        ],
      }),
    });

    expect(result.recommendedBuild.find((item) => item.status === 'NEXT')?.itemId).toBe(9);
  });

  it('projects only the selected future CHOICE branch inside the reachable planning horizon', () => {
    const result = planner.plan({
      decision: decision({ gameTimeSec: 120 }),
      evidence: evidence({
        groups: [
          group('early-core', 'EARLY', 'REQUIRED', [1]),
          group('mid-choice', 'MID', 'CHOICE', [2, 3]),
        ],
        exactWpa: { 1: 0, 2: 0.01, 3: 0.6 },
      }),
    });

    expect(result.recommendedBuild.find((item) => item.status === 'NEXT')?.itemId).toBe(1);
    expect(result.recommendedBuild.find((item) => item.itemId === 3)).toBeUndefined();
    expect(result.recommendedBuild.some((item) => item.itemId === 2)).toBe(false);
    expect(result.nextAction.targetItemId).toBe(1);
  });

  it('searches the component path of a reachable future-phase required target', () => {
    const result = planner.plan({
      decision: decision({ gameTimeSec: 120, owned: [4] }),
      evidence: evidence({
        groups: [
          group('early-core', 'EARLY', 'REQUIRED', [4]),
          group('mid-upgrade', 'MID', 'REQUIRED', [11]),
        ],
      }),
    });

    expect(result.nextAction).toMatchObject({ type: 'CONTINUE_CORE', targetItemId: 11 });
    expect(result.recommendedBuild.find((item) => item.status === 'NEXT')?.itemId).toBe(11);
    expect(result.recommendedBuild.find((item) => item.itemId === 11)?.status).toBe('NEXT');
  });

  it('resolves a CHOICE with exact-enemy WPA and never emits both alternatives', () => {
    const result = planner.plan({
      decision: decision(),
      evidence: evidence({
        groups: [group('defense-choice', 'EARLY', 'CHOICE', [2, 3])],
        exactWpa: { 2: 0.01, 3: 0.5 },
      }),
    });

    expect(result.recommendedBuild.some((item) => item.itemId === 3)).toBe(true);
    expect(result.recommendedBuild.some((item) => item.itemId === 2)).toBe(false);
  });

  it('can switch an uncommitted previous CHOICE when contextual evidence materially improves', () => {
    const result = planner.plan({
      decision: decision(),
      evidence: evidence({
        groups: [group('choice', 'EARLY', 'CHOICE', [2, 3])],
        exactWpa: { 2: 0, 3: 0.7 },
      }),
      previousResult: previousPlan(2),
    });

    expect(result.recommendedBuild.find((item) => item.status === 'NEXT')?.itemId).toBe(3);
  });

  it('does not switch a CHOICE after branch-unique component investment below the replacement threshold', () => {
    const result = planner.plan({
      decision: decision({ owned: [1] }),
      evidence: evidence({
        groups: [group('upgrade-choice', 'EARLY', 'CHOICE', [11, 12])],
        exactWpa: { 11: 0, 12: 0.02 },
      }),
    });

    expect(result.recommendedBuild.some((item) => item.itemId === 12)).toBe(false);
    expect(result.nextAction.targetItemId).toBe(11);
  });

  it('does not activate a weak OPTIONAL group', () => {
    const result = planner.plan({
      decision: decision(),
      evidence: evidence({
        groups: [
          group('core', 'EARLY', 'REQUIRED', [1]),
          group('optional', 'EARLY', 'OPTIONAL', [4], { strength: 0.15 }),
        ],
      }),
    });

    expect(result.recommendedBuild.some((item) => item.itemId === 4)).toBe(false);
  });

  it('does not treat raw WPA-only items as mandatory build targets', () => {
    const result = planner.plan({
      decision: decision(),
      evidence: evidence({
        groups: [group('core', 'EARLY', 'REQUIRED', [1])],
        baseWpa: { 1: 0.01, 19: 0.9 },
        exactWpa: { 1: 0, 19: 0.9 },
        extraWpaItems: [19],
      }),
    });

    expect(result.recommendedBuild.some((item) => item.itemId === 19)).toBe(false);
  });

  it('never assumes unknown flex slots are already unlocked', () => {
    const result = planner.plan({
      decision: decision({
        owned: [20, 21, 22, 23, 24, 25, 26, 27, 28],
        flexEvidence: 'UNKNOWN',
        unlockedFlexSlots: undefined,
      }),
      evidence: evidence({ groups: [group('core', 'EARLY', 'REQUIRED', [1])] }),
    });

    expect(result.nextAction.type).not.toBe('BUY');
    if (result.nextAction.type === 'REPLACE') expect(result.nextAction.buyItemId).toBe(1);
  });

  it('can prefer a verified investment breakpoint over an otherwise equal target', () => {
    const result = planner.plan({
      decision: decision({ owned: [20], verifiedEconomy: true }),
      evidence: evidence({
        groups: [
          group('weapon', 'EARLY', 'REQUIRED', [1], { strength: 0.75 }),
          group('vitality', 'EARLY', 'REQUIRED', [10], { strength: 0.75 }),
        ],
      }),
    });

    expect(result.recommendedBuild.find((item) => item.status === 'NEXT')?.itemId).toBe(1);
  });

  it('lets a critical exact-enemy counter override the investment preference', () => {
    const result = planner.plan({
      decision: decision({ owned: [20], verifiedEconomy: true }),
      evidence: evidence({
        groups: [
          group('weapon', 'EARLY', 'REQUIRED', [1], { strength: 0.75 }),
          group('vitality', 'EARLY', 'REQUIRED', [10], { strength: 0.75 }),
        ],
        exactWpa: { 1: 0, 10: 0.8 },
      }),
    });

    expect(result.recommendedBuild.find((item) => item.status === 'NEXT')?.itemId).toBe(1);
  });

  it('uses a legal upgrade at full base inventory instead of an illegal extra buy', () => {
    const result = planner.plan({
      decision: decision({
        owned: [1, 20, 21, 22, 23, 24, 25, 26, 27],
        unlockedFlexSlots: 0,
      }),
      evidence: evidence({ groups: [group('upgrade', 'EARLY', 'REQUIRED', [11])] }),
    });

    expect(result.nextAction.type).toBe('UPGRADE');
    expect(result.nextAction.targetItemId).toBe(11);
  });

  it('uses a preparatory SELL when one replacement refund is insufficient to reach the required target', () => {
    const result = planner.plan({
      decision: decision({ owned: [20, 21], wallet: 0 }),
      evidence: evidence({ groups: [group('core', 'EARLY', 'REQUIRED', [1])] }),
    });

    expect(result.nextAction.type).toBe('SELL');
    expect(result.nextAction.targetItemId).toBe(1);
    expect(result.recommendedBuild.find((item) => item.status === 'NEXT')?.itemId).toBe(1);
  });

  it('rejects stale hysteresis when the previous NEXT upgrade is not an executable transaction step', () => {
    const previous = previousPlan(11);
    previous.totalScore = 100;
    const result = planner.plan({
      decision: decision(),
      evidence: evidence({ groups: [group('upgrade', 'EARLY', 'REQUIRED', [11])] }),
      previousResult: previous,
    });

    expect(result.nextAction.type).not.toBe('HOLD');
    expect(result.nextAction.targetItemId).toBe(1);
    expect(result.recommendedBuild.find((item) => item.status === 'NEXT')?.itemId).toBe(1);
  });

  it('never appends unselected choice or inactive optional skeleton tails', () => {
    const result = planner.plan({
      decision: decision(),
      evidence: evidence({
        groups: [
          group('core', 'EARLY', 'REQUIRED', [1]),
          group('choice', 'EARLY', 'CHOICE', [2, 3]),
          group('optional', 'EARLY', 'OPTIONAL', [4], { strength: 0.1 }),
        ],
        exactWpa: { 2: 0, 3: 0.5 },
      }),
    });

    const ids = result.recommendedBuild.map((item) => item.itemId);
    expect(ids).toEqual(expect.arrayContaining([1, 3]));
    expect(ids).not.toContain(2);
    expect(ids).not.toContain(4);
  });

  it('keeps NEXT consistent with the selected legal action target', () => {
    const result = planner.plan({
      decision: decision(),
      evidence: evidence({ groups: [group('core', 'EARLY', 'REQUIRED', [1])] }),
    });

    expect(result.recommendedBuild.filter((item) => item.status === 'NEXT')).toHaveLength(1);
    expect(result.recommendedBuild.find((item) => item.status === 'NEXT')?.itemId)
      .toBe(result.nextAction.targetItemId);
  });
});
