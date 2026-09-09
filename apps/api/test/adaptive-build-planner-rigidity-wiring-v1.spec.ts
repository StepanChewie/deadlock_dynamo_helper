import {
  createRecommendationItemGraph,
  observedFact,
} from '@deadlock-live-probe/build-domain';
import { AdaptiveBuildPlannerV1Service } from '../src/statlocker-adaptive/adaptive-build-planner-v1.service';
import { AdaptiveEvidenceScorerV1Service } from '../src/statlocker-adaptive/adaptive-evidence-scorer-v1.service';
import * as buildStrategyV1 from '../src/statlocker-adaptive/build-strategy-v1';

const catalogSha256 = 'a'.repeat(64);

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
  const candidate = (itemId: number) => ({
    itemId,
    strength: 0.9,
    coverage: 0.9,
    purchaseRate: 0.9,
    medianBuyTimeS: 300,
    timingSpreadS: 90,
    sourceProfileCount: 10,
    frequencyTier: itemId === 1 ? 'CORE' : 'SOMETIMES',
    rushEvidence: false,
  });
  const wpaItem = (itemId: number) => ({
    heroId: 10,
    itemId,
    meanWpa: 0,
    sampleSize: 1000,
    wpaConfidence: 1,
    gameState: { even: 0 },
    purchaseTiming: { medianPurchaseSec: 300 },
  });
  const byDataset = {
    WPA_PATCH_DATA: family('WPA_PATCH_DATA', { patchId: '15-1', items: [wpaItem(1), wpaItem(4)] }),
    VS_HERO_WPA: family('VS_HERO_WPA', { slices: [] }),
    T4_CHAINS: family('T4_CHAINS', { chains: [] }),
    CONSENSUS_SKELETON: family('CONSENSUS_SKELETON', {
      heroId: 10,
      profileCount: 10,
      groups: [
        {
          groupId: 'required-core',
          phase: 'EARLY',
          type: 'REQUIRED',
          minSelect: 1,
          maxSelect: 1,
          candidates: [candidate(1)],
          confidence: 0.9,
          inferred: false,
        },
        {
          groupId: 'optional-utility',
          phase: 'EARLY',
          type: 'OPTIONAL',
          minSelect: 0,
          maxSelect: 1,
          candidates: [candidate(4)],
          confidence: 0.9,
          inferred: false,
        },
      ],
    }),
    WPA_FILTERED_ITEMS: family('WPA_FILTERED_ITEMS', { heroId: 10, items: [wpaItem(1), wpaItem(4)] }),
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

function decision() {
  const itemGraph = createRecommendationItemGraph([1, 4].map((itemId) => ({
    itemId,
    name: `Item ${itemId}`,
    slotType: 'weapon' as const,
    active: false,
    availableRulesetIds: ['ruleset-a'],
    directPurchaseCost: 800,
    upgradeRecipes: [],
    sellTransition: { soulsRefund: 400, returnedItemIds: [] },
    maxCopies: 1,
  })));
  const heldByItemId = new Map([[1, {
    itemId: 1,
    instanceId: 'item-1',
    lifecycle: 1,
    acquiredBy: 'RECONCILE' as const,
    acquiredAtMs: 0,
  }]]);
  return {
    state: {
      decisionId: 'decision-rigidity',
      matchId: 'match-rigidity',
      playerSlot: 0,
      gameTimeSec: 700,
      rulesetId: 'ruleset-a',
      heroId: 10,
      inventory: {
        initializedFromSnapshot: true,
        heldByItemId,
        lifecycleCountByItemId: new Map([[1, 1]]),
        nextInstanceSequence: 2,
      },
      economy: {
        spendableSouls: observedFact(5000, 'test'),
        shopOpportunity: observedFact('AVAILABLE' as const, 'test'),
      },
    },
    itemGraph,
    catalogVersionId: 'catalog-a',
    catalogSha256,
    rulesetId: 'ruleset-a',
    localSteamId: 'steam-a',
    enemyHeroIds: [],
    ourTeamSouls: 100000,
    enemyTeamSouls: 100000,
    slots: {
      baseSlots: 0,
      baseSlotsByType: { weapon: 0, vitality: 0, spirit: 0 },
      maxFlexSlots: 12,
      maxActiveItems: 4,
      unlockedFlexSlots: 12,
      usedSlots: 1,
      usedByType: { weapon: 1, vitality: 0, spirit: 0 },
      usedActiveItems: 0,
      usedFlexSlots: 1,
      provedFlexLowerBound: 12,
      freeBaseSlots: 0,
      freeBaseByType: { weapon: 0, vitality: 0, spirit: 0 },
      freeFlexSlots: 11,
      totalCapacity: 12,
      mechanicsEvidence: 'RECONSTRUCTED',
      flexEvidence: 'OBSERVED',
      evidence: 'OBSERVED',
    },
    investment: {
      tracks: {
        weapon: { type: 'weapon', currentValue: 800 },
        vitality: { type: 'vitality', currentValue: 0 },
        spirit: { type: 'spirit', currentValue: 0 },
      },
      evidence: 'RECONSTRUCTED',
    },
    stateRevision: 'revision-rigidity',
  } as any;
}

describe('AdaptiveBuildPlannerV1Service rigidity wiring', () => {
  it('passes completed hard-core goals into the pre-score protected goal set', () => {
    const filterSpy = jest.spyOn(buildStrategyV1, 'filterRecommendationCandidatesForActiveGoalsV1');
    const planner = new AdaptiveBuildPlannerV1Service(new AdaptiveEvidenceScorerV1Service());

    try {
      planner.plan({
        decision: decision(),
        evidence: evidence(),
        situationalWindowStates: [{
          windowId: 'utility',
          state: 'OPEN',
          targetItemIds: [4],
          reasonCodes: ['TEST_WINDOW'],
        }],
      });

      const calls = filterSpy.mock.calls as any[][];
      const callWithSituationalGoal = calls.find((call) =>
        (call[1] as any[]).some((goal) => goal.goalId === 'situational:utility'),
      );
      expect(callWithSituationalGoal).toBeDefined();
      expect(callWithSituationalGoal?.[3]?.protectedGoals).toEqual(expect.arrayContaining([
        expect.objectContaining({ goalId: 'required-core', rigidity: 'HARD_CORE' }),
        expect.objectContaining({ goalId: 'situational:utility', rigidity: 'FLEX' }),
      ]));
    } finally {
      filterSpy.mockRestore();
    }
  });
});
