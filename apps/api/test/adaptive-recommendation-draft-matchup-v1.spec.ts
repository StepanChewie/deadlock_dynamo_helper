import { createRecommendationItemGraph, observedFact } from '@deadlock-live-probe/build-domain';
import { AdaptiveRecommendationObservabilityV1Service } from '../src/statlocker-adaptive/adaptive-recommendation-observability-v1.service';
import { AdaptiveRecommendationV1Service } from '../src/statlocker-adaptive/adaptive-recommendation-v1.service';

const catalogSha256 = 'a'.repeat(64);

function graph() {
  return createRecommendationItemGraph([{
    itemId: 1,
    name: 'Item 1',
    slotType: 'weapon' as const,
    active: false,
    availableRulesetIds: ['ruleset-a'],
    directPurchaseCost: 500,
    upgradeRecipes: [],
    sellTransition: { soulsRefund: 250, returnedItemIds: [] },
    maxCopies: 1,
  }]);
}

function decision(stateRevision: string) {
  return {
    state: {
      decisionId: `decision:${stateRevision}`,
      matchId: 'match-a',
      playerSlot: 0,
      gameTimeSec: 700,
      rulesetId: 'ruleset-a',
      heroId: 10,
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
    itemGraph: graph(),
    catalogVersionId: 'catalog-a',
    catalogSha256,
    rulesetId: 'ruleset-a',
    localSteamId: 'steam-local',
    enemyHeroIds: [20],
    enemyLiveStates: [{ steamId: 'enemy-20', heroId: 20, souls: 10000 }],
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
    investment: {
      tracks: {
        weapon: { type: 'weapon', currentValue: 0 },
        vitality: { type: 'vitality', currentValue: 0 },
        spirit: { type: 'spirit', currentValue: 0 },
      },
      evidence: 'RECONSTRUCTED',
    },
    economyRules: {
      rulesetId: 'ruleset-a',
      catalogSha256,
      baseSlots: 0,
      baseSlotsByType: { weapon: 0, vitality: 0, spirit: 0 },
      maxActiveItems: 4,
      maxFlexSlots: 12,
      investmentBreakpoints: { weapon: [1600], vitality: [1600], spirit: [1600] },
    },
    economyRulesEvidence: 'RECONSTRUCTED',
    stateRevision,
  } as any;
}

function family(dataset: string) {
  return {
    dataset,
    scopeKey: 'test',
    freshness: 'UNAVAILABLE',
    confidence: 0,
  };
}

function evidence() {
  return {
    heroId: 10,
    rulesetVersion: 'ruleset-a',
    catalogSha256,
    statlockerPatchId: 'patch-a',
    usable: true,
    snapshotIds: ['base-snapshot'],
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

function plannerResult() {
  return {
    gameState: 'EVEN',
    nextAction: {
      actionKey: 'BUY_ITEM:1',
      type: 'BUY',
      itemId: 1,
      buyItemId: 1,
      targetItemId: 1,
      reasonCodes: ['FEASIBLE'],
    },
    recommendedBuild: [{
      itemId: 1,
      position: 1,
      status: 'NEXT',
      score: 0.8,
      confidence: 0.8,
      reasonCodes: ['TEST'],
    }],
    changes: [],
    rankedImmediateCandidates: [],
    totalScore: 0.8,
    confidence: 0.8,
    plannerVersion: 'adaptive-build-planner-v1',
  } as any;
}

describe('AdaptiveRecommendationV1Service draft matchup integration', () => {
  it('plans with enriched evidence and persists enrichment for the fresh revision', async () => {
    const states = [decision('revision-a'), decision('revision-b')];
    const decisionState = {
      build: jest.fn()
        .mockResolvedValueOnce(states[0])
        .mockResolvedValueOnce(states[1]),
    };
    const baseEvidence = evidence();
    const evidenceService = {
      resolveLocalPatchId: jest.fn(() => 'patch-a'),
      getLocalEvidence: jest.fn(() => baseEvidence),
    };
    const planner = {
      version: 'adaptive-build-planner-v1',
      plan: jest.fn((_input: any) => plannerResult()),
    };
    const replay = {
      getPreviousContext: jest.fn(async () => undefined),
      toReplayInput: jest.fn((builtDecision: any, planningEvidence: any) => ({
        decision: { stateRevision: builtDecision.stateRevision },
        evidenceMarker: planningEvidence.draftMarker,
        snapshotIds: planningEvidence.snapshotIds,
      })),
      persist: jest.fn(async (_payload: any) => undefined),
    };
    const draftMatchupEvidence = {
      enrich: jest.fn(async (base: any, builtDecision: any) => ({
        ...base,
        draftMarker: builtDecision.stateRevision,
        draftMatchupByItemId: {},
        draftEnemyThreats: [],
      })),
    };
    const service = new AdaptiveRecommendationV1Service(
      decisionState as any,
      evidenceService as any,
      planner as any,
      replay as any,
      new AdaptiveRecommendationObservabilityV1Service(),
    );
    (service as any).draftMatchupEvidence = draftMatchupEvidence;

    await service.recommend({ matchId: 'match-a', localSteamId: 'steam-local' });

    expect(draftMatchupEvidence.enrich).toHaveBeenCalledTimes(2);
    const plannerMarkers = planner.plan.mock.calls.map(([input]) => input.evidence.draftMarker);
    expect(plannerMarkers).toContain('revision-a');
    expect(plannerMarkers).toContain('revision-b');
    expect(replay.toReplayInput).toHaveBeenCalledWith(
      states[1],
      expect.objectContaining({ draftMarker: 'revision-b' }),
      expect.any(Object),
    );
    expect(replay.persist.mock.calls[0][0].replayInput.evidenceMarker).toBe('revision-b');
  });
});
