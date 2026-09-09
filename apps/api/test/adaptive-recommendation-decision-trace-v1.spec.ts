import { createRecommendationItemGraph, observedFact } from '@deadlock-live-probe/build-domain';
import { AdaptiveRecommendationObservabilityV1Service } from '../src/statlocker-adaptive/adaptive-recommendation-observability-v1.service';
import { AdaptiveRecommendationV1Service } from '../src/statlocker-adaptive/adaptive-recommendation-v1.service';

const catalogSha256 = 'a'.repeat(64);

function decision() {
  return {
    state: {
      decisionId: 'decision-trace-response',
      matchId: 'match-trace-response',
      playerSlot: 0,
      gameTimeSec: 700,
      rulesetId: 'r1',
      heroId: 1,
      inventory: {
        initializedFromSnapshot: true,
        heldByItemId: new Map(),
        lifecycleCountByItemId: new Map(),
        nextInstanceSequence: 1,
      },
      economy: {
        spendableSouls: observedFact(1000, 'test'),
        shopOpportunity: observedFact('AVAILABLE', 'test'),
      },
    },
    itemGraph: createRecommendationItemGraph([{
      itemId: 1,
      name: 'Item 1',
      slotType: 'weapon' as const,
      active: false,
      availableRulesetIds: ['r1'],
      directPurchaseCost: 500,
      upgradeRecipes: [],
      sellTransition: { soulsRefund: 250, returnedItemIds: [] },
      maxCopies: 1,
    }]),
    catalogVersionId: 'catalog',
    catalogSha256,
    rulesetId: 'r1',
    localSteamId: 'steam-local',
    allyHeroIds: [],
    enemyHeroIds: [2],
    enemyLiveStates: [],
    allyItemIds: [],
    enemyItemIds: [],
    slots: {
      baseSlots: 0,
      baseSlotsByType: { weapon: 0, vitality: 0, spirit: 0 },
      maxActiveItems: 4,
      maxFlexSlots: 12,
      unlockedFlexSlots: 12,
      usedSlots: 0,
      usedFlexSlots: 0,
      usedSlotsByType: { weapon: 0, vitality: 0, spirit: 0 },
      overflowByType: { weapon: 0, vitality: 0, spirit: 0 },
      provedFlexLowerBound: 0,
      freeBaseSlots: 0,
      freeFlexSlots: 12,
      totalCapacity: 12,
      flexEvidence: 'OBSERVED',
      mechanicsEvidence: 'RECONSTRUCTED',
      evidence: 'OBSERVED',
    },
    investment: { tracks: { weapon: { type: 'weapon', currentValue: 0 }, vitality: { type: 'vitality', currentValue: 0 }, spirit: { type: 'spirit', currentValue: 0 } }, evidence: 'RECONSTRUCTED' },
    economyRules: { rulesetId: 'r1', catalogSha256, baseSlots: 0, baseSlotsByType: { weapon: 0, vitality: 0, spirit: 0 }, maxActiveItems: 4, maxFlexSlots: 12, investmentBreakpoints: { weapon: [1600], vitality: [1600], spirit: [1600] } },
    economyRulesEvidence: 'RECONSTRUCTED',
    stateRevision: 'revision-trace-response',
  } as any;
}

function evidence() {
  const family = (dataset: string) => ({ dataset, scopeKey: 'test', freshness: 'UNAVAILABLE', confidence: 0 });
  return {
    heroId: 1,
    rulesetVersion: 'r1',
    catalogSha256,
    statlockerPatchId: 'p1',
    usable: true,
    snapshotIds: [],
    degradedReasons: [],
    families: [],
    byDataset: {
      WPA_PATCH_DATA: family('WPA_PATCH_DATA'),
      VS_HERO_WPA: family('VS_HERO_WPA'),
      T4_CHAINS: family('T4_CHAINS'),
      CONSENSUS_SKELETON: family('CONSENSUS_SKELETON'),
      WPA_FILTERED_ITEMS: family('WPA_FILTERED_ITEMS'),
    },
  } as any;
}

const decisionTrace: any = {
  version: 'adaptive-decision-trace-v1',
  decisionId: 'decision-trace-response',
  stateRevision: 'revision-trace-response',
  stages: ['SKELETON_BASELINE', 'FINAL_SELECTION'],
  baseline: { strategyId: 's1', inventoryItemIds: [], recommendedBuild: [] },
  branchChoices: {},
  candidates: [],
  replacements: [],
  finalSelection: { action: { actionKey: 'BUY_ITEM:1', type: 'BUY', itemId: 1, targetItemId: 1, reasonCodes: ['TEST'] }, legalityRecheckChanged: false, reasonCodes: ['TEST'] },
  policy: {
    policyVersion: 'statlocker-adaptive-v1.4.0',
    heldItemCapacity: 12,
    threatWeights: { souls: 0.35, heroDamage: 0.30, killsAssists: 0.20, level: 0.10, deaths: -0.05 },
    threatClamp: { min: 0.75, max: 1.5 },
    shrinkK: { baseWpa: 200, gameState: 250, exactEnemy: 500, chain: 200, proProfile: 50 },
    thresholds: { planSwitch: 0.08, sellBuy: 0.20, softCoreReplace: 0.25, wildcardReplace: 0.30, matchupConfidence: 0.35 },
    recentPurchaseProtectionMs: 120000,
    soldItemRebuyPenaltyMs: 180000,
  },
};

describe('AdaptiveRecommendationV1Service decision trace wiring', () => {
  it('returns and persists the planner trace reconciled to the final executable action', async () => {
    const built = decision();
    const decisionState = { build: jest.fn().mockResolvedValue(built) };
    const planningEvidence = evidence();
    const evidenceService = {
      resolveLocalPatchId: jest.fn(() => 'p1'),
      getLocalEvidence: jest.fn(() => planningEvidence),
    };
    const planner = {
      plan: jest.fn(() => ({
        gameState: 'EVEN',
        nextAction: { actionKey: 'BUY_ITEM:1', type: 'BUY', itemId: 1, targetItemId: 1, reasonCodes: ['TEST'] },
        recommendedBuild: [{ itemId: 1, position: 1, status: 'NEXT', score: 0.5, confidence: 0.8, skeletonStrength: 0, contextualSupport: 0.8, reasonCodes: ['TEST'] }],
        changes: [],
        rankedImmediateCandidates: [],
        totalScore: 0.5,
        confidence: 0.8,
        plannerVersion: 'adaptive-build-planner-v1',
        decisionTrace,
      } as any)),
    };
    const replay = {
      getPreviousContext: jest.fn(async () => undefined),
      toReplayInput: jest.fn(() => ({ decision: { stateRevision: built.stateRevision } })),
      persist: jest.fn(async () => undefined),
    };
    const service = new AdaptiveRecommendationV1Service(
      decisionState as any,
      evidenceService as any,
      planner as any,
      replay as any,
      new AdaptiveRecommendationObservabilityV1Service(),
    );

    const result = await service.recommend({ matchId: built.state.matchId, localSteamId: built.localSteamId });

    expect(result.decisionTrace).toBeDefined();
    expect(result.decisionTrace?.finalSelection.action).toEqual(result.nextAction);
    expect(result.decisionTrace?.finalSelection.legalityRecheckChanged).toBe(true);
    expect(replay.persist).toHaveBeenCalledWith(expect.objectContaining({
      result: expect.objectContaining({ decisionTrace: result.decisionTrace }),
    }));
  });
});
