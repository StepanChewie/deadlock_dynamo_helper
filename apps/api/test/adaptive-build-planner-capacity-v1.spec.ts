import {
  RecommendationItemDefinition,
  createRecommendationItemGraph,
  observedFact,
} from '@deadlock-live-probe/build-domain';
import { AdaptiveBuildPlannerV1Service } from '../src/statlocker-adaptive/adaptive-build-planner-v1.service';
import { AdaptiveEvidenceScorerV1Service } from '../src/statlocker-adaptive/adaptive-evidence-scorer-v1.service';

function item(overrides: Partial<RecommendationItemDefinition> = {}): RecommendationItemDefinition {
  return {
    itemId: 1,
    name: 'Capacity Target',
    slotType: 'weapon',
    active: false,
    availableRulesetIds: ['ruleset-a'],
    directPurchaseCost: 800,
    upgradeRecipes: [],
    sellTransition: { soulsRefund: 400, returnedItemIds: [] },
    maxCopies: 1,
    ...overrides,
  };
}

function decision(options: {
  target: RecommendationItemDefinition;
  baseSlotsByType: { weapon: number; vitality: number; spirit: number };
  maxFlexSlots: number;
  maxActiveItems: number;
}) {
  const itemGraph = createRecommendationItemGraph([options.target]);
  const baseSlots = Object.values(options.baseSlotsByType).reduce((sum, value) => sum + value, 0);
  return {
    state: {
      decisionId: 'decision-capacity',
      matchId: 'match-capacity',
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
        spendableSouls: observedFact(5_000, 'test'),
        shopOpportunity: observedFact('AVAILABLE' as const, 'test'),
      },
    },
    itemGraph,
    catalogVersionId: 'catalog-a',
    catalogSha256: 'a'.repeat(64),
    rulesetId: 'ruleset-a',
    localSteamId: 'steam-a',
    enemyHeroIds: [],
    enemyLiveStates: [],
    ourTeamSouls: 100_000,
    enemyTeamSouls: 100_000,
    slots: {
      baseSlots,
      baseSlotsByType: options.baseSlotsByType,
      maxFlexSlots: options.maxFlexSlots,
      maxActiveItems: options.maxActiveItems,
      unlockedFlexSlots: options.maxFlexSlots,
      usedSlots: 0,
      usedByType: { weapon: 0, vitality: 0, spirit: 0 },
      usedActiveItems: 0,
      usedFlexSlots: 0,
      provedFlexLowerBound: 0,
      freeBaseSlots: baseSlots,
      freeBaseByType: options.baseSlotsByType,
      freeFlexSlots: options.maxFlexSlots,
      totalCapacity: baseSlots + options.maxFlexSlots,
      mechanicsEvidence: 'RECONSTRUCTED' as const,
      flexEvidence: 'OBSERVED' as const,
      evidence: 'OBSERVED' as const,
    },
    investment: {
      tracks: {
        weapon: { type: 'weapon' as const, currentValue: 0 },
        vitality: { type: 'vitality' as const, currentValue: 0 },
        spirit: { type: 'spirit' as const, currentValue: 0 },
      },
      evidence: 'UNKNOWN' as const,
    },
    economyRulesEvidence: 'RECONSTRUCTED' as const,
    stateRevision: 'revision-capacity',
  } as any;
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

function evidence() {
  const skeletonCandidate = {
    itemId: 1,
    strength: 0.9,
    coverage: 0.9,
    purchaseRate: 0.9,
    medianBuyTimeS: 300,
    timingSpreadS: 90,
    sourceProfileCount: 10,
    frequencyTier: 'CORE',
    rushEvidence: false,
  };
  const wpaItem = {
    heroId: 10,
    itemId: 1,
    meanWpa: 0.1,
    sampleSize: 1_000,
    wpaConfidence: 1,
    gameState: { even: 0.1 },
    purchaseTiming: { medianPurchaseSec: 300 },
  };
  const byDataset = {
    WPA_PATCH_DATA: family('WPA_PATCH_DATA', { patchId: '15-1', items: [wpaItem] }),
    VS_HERO_WPA: family('VS_HERO_WPA', { slices: [] }),
    T4_CHAINS: family('T4_CHAINS', { chains: [] }),
    CONSENSUS_SKELETON: family('CONSENSUS_SKELETON', {
      heroId: 10,
      profileCount: 10,
      groups: [{
        groupId: 'required-target',
        phase: 'EARLY',
        type: 'REQUIRED',
        minSelect: 1,
        maxSelect: 1,
        candidates: [skeletonCandidate],
        confidence: 0.9,
        inferred: false,
      }],
    }),
    WPA_FILTERED_ITEMS: family('WPA_FILTERED_ITEMS', { heroId: 10, items: [wpaItem] }),
  };
  return {
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
}

describe('AdaptiveBuildPlannerV1Service capacity authority', () => {
  const planner = new AdaptiveBuildPlannerV1Service(new AdaptiveEvidenceScorerV1Service());

  it('honors the active-item capacity carried by the planner node instead of the generator default', () => {
    const result = planner.plan({
      decision: decision({
        target: item({ active: true }),
        baseSlotsByType: { weapon: 4, vitality: 4, spirit: 4 },
        maxFlexSlots: 3,
        maxActiveItems: 0,
      }),
      evidence: evidence(),
    });

    expect(result.nextAction.type).not.toBe('BUY');
    expect(result.rankedImmediateCandidates.some((candidate) => candidate.action.type === 'BUY')).toBe(false);
  });

  it('honors per-type base-slot capacity carried by the planner node instead of 4/4/4 defaults', () => {
    const result = planner.plan({
      decision: decision({
        target: item({ active: false }),
        baseSlotsByType: { weapon: 0, vitality: 4, spirit: 4 },
        maxFlexSlots: 0,
        maxActiveItems: 4,
      }),
      evidence: evidence(),
    });

    expect(result.nextAction.type).not.toBe('BUY');
    expect(result.rankedImmediateCandidates.some((candidate) => candidate.action.type === 'BUY')).toBe(false);
  });
});
