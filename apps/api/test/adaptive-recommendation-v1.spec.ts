import 'reflect-metadata';
import {
  createRecommendationItemGraph,
  observedFact,
  unknownFact,
} from '@deadlock-live-probe/build-domain';
import { AdaptiveEvidenceScorerV1Service } from '../src/statlocker-adaptive/adaptive-evidence-scorer-v1.service';
import { AdaptiveBuildPlannerV1Service } from '../src/statlocker-adaptive/adaptive-build-planner-v1.service';
import { AdaptiveRecommendationV1Service } from '../src/statlocker-adaptive/adaptive-recommendation-v1.service';
import { AdaptiveRecommendationObservabilityV1Service } from '../src/statlocker-adaptive/adaptive-recommendation-observability-v1.service';
import { ConsensusBuildGroupV1 } from '../src/statlocker-adaptive/statlocker-adaptive.types';

const catalogSha256 = 'a'.repeat(64);

function graph() {
  return createRecommendationItemGraph([1, 2, 3].map((itemId) => ({
    itemId,
    name: `Item ${itemId}`,
    slotType: 'weapon' as const,
    active: false,
    availableRulesetIds: ['ruleset-a'],
    directPurchaseCost: 500,
    upgradeRecipes: [],
    sellTransition: { soulsRefund: 250, returnedItemIds: [] },
    maxCopies: 1,
  })));
}

function inventory(ids: number[] = []) {
  return {
    initializedFromSnapshot: true,
    heldByItemId: new Map(ids.map((itemId) => [itemId, {
      itemId,
      instanceId: `item-${itemId}`,
      lifecycle: 1,
      acquiredBy: 'RECONCILE' as const,
      acquiredAtMs: 0,
    }])),
    lifecycleCountByItemId: new Map(ids.map((itemId) => [itemId, 1])),
    nextInstanceSequence: ids.length + 1,
  };
}

function decision(options: {
  wallet?: number;
  shop?: 'AVAILABLE' | 'UNKNOWN';
  revision?: string;
  owned?: number[];
  gameTimeSec?: number;
  slotsEvidence?: 'OBSERVED' | 'UNKNOWN';
  investmentEvidence?: 'RECONSTRUCTED' | 'UNKNOWN';
} = {}) {
  const wallet = options.wallet;
  const shop = options.shop ?? 'AVAILABLE';
  const stateRevision = options.revision ?? 'revision-a';
  const owned = options.owned ?? [];
  const slotsEvidence = options.slotsEvidence ?? 'OBSERVED';
  const unlockedFlexSlots = slotsEvidence === 'UNKNOWN' ? undefined : 3;
  return {
    state: {
      decisionId: `adaptive:${stateRevision}`,
      matchId: 'match-a',
      playerSlot: 0,
      gameTimeSec: options.gameTimeSec ?? 700,
      rulesetId: 'ruleset-a',
      heroId: 10,
      inventory: inventory(options.owned ?? []),
      economy: {
        spendableSouls: wallet === undefined ? unknownFact<number>('test') : observedFact(wallet, 'test'),
        shopOpportunity: shop === 'UNKNOWN' ? unknownFact('test') : observedFact(shop, 'test'),
      },
    },
    slots: {
      baseSlots: 9,
      baseSlotsByType: { weapon: 3, vitality: 3, spirit: 3 },
      maxActiveItems: 4,
      maxFlexSlots: 3,
      unlockedFlexSlots,
      usedSlots: owned.length,
      usedFlexSlots: Math.max(0, owned.length - 9),
      usedSlotsByType: { weapon: owned.length, vitality: 0, spirit: 0 },
      overflowByType: { weapon: Math.max(0, owned.length - 3), vitality: 0, spirit: 0 },
      provedFlexLowerBound: Math.max(0, owned.length - 9),
      freeBaseSlots: Math.max(0, 9 - owned.length),
      freeFlexSlots: unlockedFlexSlots === undefined ? undefined : Math.max(0, unlockedFlexSlots - Math.max(0, owned.length - 9)),
      totalCapacity: unlockedFlexSlots === undefined ? undefined : 9 + unlockedFlexSlots,
      flexCapacityEvidence: slotsEvidence,
      evidence: slotsEvidence,
    },
    economyRules: {
      rulesetId: 'ruleset-a',
      catalogSha256,
      baseSlots: 9,
      baseSlotsByType: { weapon: 3, vitality: 3, spirit: 3 },
      maxActiveItems: 4,
      maxFlexSlots: 3,
      investmentBreakpoints: { weapon: [1600], vitality: [1600], spirit: [1600] },
    },
    investment: options.investmentEvidence === 'UNKNOWN'
      ? {
          tracks: {
            weapon: { type: 'weapon', currentValue: 0 },
            vitality: { type: 'vitality', currentValue: 0 },
            spirit: { type: 'spirit', currentValue: 0 },
          },
          evidence: 'UNKNOWN',
        }
      : {
          tracks: {
            weapon: { type: 'weapon', currentValue: 0 },
            vitality: { type: 'vitality', currentValue: 0 },
            spirit: { type: 'spirit', currentValue: 0 },
          },
          evidence: 'RECONSTRUCTED',
        },
    itemGraph: graph(),
    catalogVersionId: 'catalog-a',
    catalogSha256,
    rulesetId: 'ruleset-a',
    localSteamId: 'steam-a',
    enemyHeroIds: [20],
    enemyLiveStates: [],
    ourTeamSouls: 100000,
    enemyTeamSouls: 100000,
    stateRevision,
  } as any;
}

function evidence(usable = true, patchId = '15-1') {
  const unavailable = (dataset: string, scopeKey: string) => ({ dataset, scopeKey, freshness: 'UNAVAILABLE', confidence: 0 });
  const fresh = {
    dataset: 'WPA_PATCH_DATA',
    scopeKey: `patch:${patchId}`,
    snapshotId: 'snapshot-wpa',
    contentSha256: 'b'.repeat(64),
    fetchedAt: '2026-08-31T12:00:00.000Z',
    freshness: 'FRESH',
    confidence: 1,
    payload: { patchId, items: [] },
  };
  return {
    heroId: 10,
    rulesetVersion: 'ruleset-a',
    catalogSha256,
    statlockerPatchId: patchId,
    usable,
    snapshotIds: usable ? ['snapshot-wpa'] : [],
    degradedReasons: usable ? [] : ['WPA_PATCH_DATA:UNAVAILABLE'],
    families: usable ? [fresh] : [unavailable('WPA_PATCH_DATA', `patch:${patchId}`)],
    byDataset: {
      WPA_PATCH_DATA: usable ? fresh : unavailable('WPA_PATCH_DATA', `patch:${patchId}`),
      VS_HERO_WPA: unavailable('VS_HERO_WPA', 'global'),
      T4_CHAINS: unavailable('T4_CHAINS', 'global'),
      CONSENSUS_SKELETON: unavailable('CONSENSUS_SKELETON', 'hero:10:consensus'),
      WPA_FILTERED_ITEMS: unavailable('WPA_FILTERED_ITEMS', 'hero:10'),
    },
  } as any;
}

function plannerResult() {
  return {
    gameState: 'EVEN',
    nextAction: { actionKey: 'BUY_ITEM:1', type: 'BUY', itemId: 1, targetItemId: 1, reasonCodes: ['FEASIBLE'] },
    recommendedBuild: [{ itemId: 1, position: 1, status: 'NEXT', score: 0.9, confidence: 0.8, skeletonStrength: 0.7, contextualSupport: 0.2, reasonCodes: ['SKELETON_CORE'] }],
    changes: [{ type: 'INSERT', itemId: 1, toPosition: 1, reasonCodes: ['PLAN_TARGET_ADDED'] }],
    rankedImmediateCandidates: [
      { action: { actionKey: 'BUY_ITEM:1', type: 'BUY', itemId: 1, targetItemId: 1, reasonCodes: ['FEASIBLE'] }, score: 0.9, confidence: 0.8, components: [], reasonCodes: ['FEASIBLE'] },
      { action: { actionKey: 'WAIT_SAVE:1', type: 'WAIT', targetItemId: 1, reasonCodes: ['FEASIBLE'] }, score: 0.1, confidence: 0.5, components: [], reasonCodes: ['FEASIBLE'] },
    ],
    totalScore: 0.9,
    confidence: 0.8,
    plannerVersion: 'adaptive-build-planner-v1',
  } as any;
}

function previousResult() {
  return {
    ready: true,
    blockers: [],
    decisionId: 'old-decision',
    stateRevision: 'revision-old',
    gameState: 'EVEN',
    nextAction: { actionKey: 'HOLD', type: 'HOLD', targetItemId: 1, reasonCodes: ['PLAN_HYSTERESIS'] },
    nextTargetItemId: 1,
    recommendedBuild: plannerResult().recommendedBuild,
    changes: [],
    rankedImmediateCandidates: [],
    totalScore: 1,
    confidence: 0.8,
    scorerVersion: 'adaptive-evidence-scorer-v1',
    plannerVersion: 'adaptive-build-planner-v1',
    configVersion: 'statlocker-adaptive-v1.0.0',
    evidence: { rulesetVersion: 'ruleset-a', catalogSha256, statlockerPatchId: '15-1', snapshotIds: ['snapshot-old'], families: [], degradedReasons: [] },
  } as any;
}

function realPlannerEvidence(groups: readonly ConsensusBuildGroupV1[], exactWpa: Readonly<Record<number, number>>) {
  const itemIds = [...new Set(groups.flatMap((group) => group.candidates.map((candidate) => candidate.itemId)))];
  const wpaItems = itemIds.map((itemId) => ({
    heroId: 10,
    itemId,
    meanWpa: exactWpa[itemId] ?? 0,
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
    WPA_PATCH_DATA: {
      dataset: 'WPA_PATCH_DATA',
      scopeKey: 'patch:15-1',
      snapshotId: 'WPA_PATCH_DATA-snapshot',
      contentSha256: 'b'.repeat(64),
      freshness: 'FRESH',
      confidence: 1,
      payload: { patchId: '15-1', items: wpaItems },
    },
    VS_HERO_WPA: {
      dataset: 'VS_HERO_WPA',
      scopeKey: 'global',
      snapshotId: 'VS_HERO_WPA-snapshot',
      contentSha256: 'b'.repeat(64),
      freshness: 'FRESH',
      confidence: 1,
      payload: {
        slices: [{ heroId: 10, enemyHeroId: 20, items: exactItems }],
      },
    },
    T4_CHAINS: {
      dataset: 'T4_CHAINS',
      scopeKey: 'global',
      snapshotId: 'T4_CHAINS-snapshot',
      contentSha256: 'b'.repeat(64),
      freshness: 'FRESH',
      confidence: 1,
      payload: { chains: [] },
    },
    CONSENSUS_SKELETON: {
      dataset: 'CONSENSUS_SKELETON',
      scopeKey: 'hero:10:consensus',
      snapshotId: 'CONSENSUS_SKELETON-snapshot',
      contentSha256: 'b'.repeat(64),
      freshness: 'FRESH',
      confidence: 1,
      payload: { heroId: 10, profileCount: 10, groups },
    },
    WPA_FILTERED_ITEMS: {
      dataset: 'WPA_FILTERED_ITEMS',
      scopeKey: 'hero:10',
      snapshotId: 'WPA_FILTERED_ITEMS-snapshot',
      contentSha256: 'b'.repeat(64),
      freshness: 'FRESH',
      confidence: 1,
      payload: { heroId: 10, items: wpaItems },
    },
  };
  return {
    heroId: 10,
    rulesetVersion: 'ruleset-a',
    catalogSha256,
    statlockerPatchId: '15-1',
    usable: true,
    snapshotIds: Object.values(byDataset).map((entry: any) => entry.snapshotId),
    degradedReasons: [],
    families: Object.values(byDataset),
    byDataset,
  } as any;
}

function choiceGroup(itemIds: readonly number[], maxSelect = 1, phase: ConsensusBuildGroupV1['phase'] = 'EARLY'): ConsensusBuildGroupV1 {
  return {
    groupId: `choice:${itemIds.join(',')}`,
    phase,
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

function requiredGroup(itemId: number, phase: ConsensusBuildGroupV1['phase']): ConsensusBuildGroupV1 {
  return {
    groupId: `required:${itemId}`,
    phase,
    type: 'REQUIRED',
    minSelect: 1,
    maxSelect: 1,
    candidates: [{
      itemId,
      strength: 0.8,
      coverage: 0.8,
      purchaseRate: 0.8,
      medianBuyTimeS: 300,
      timingSpreadS: 30,
      sourceProfileCount: 8,
      frequencyTier: 'CORE' as const,
      rushEvidence: false,
    }],
    confidence: 0.9,
    inferred: false,
  };
}

function harness(options: {
  states?: any[];
  localEvidence?: any;
  patchId?: string | null;
  previous?: any;
  plan?: any;
  planner?: any;
  observability?: AdaptiveRecommendationObservabilityV1Service;
} = {}) {
  const states = options.states ?? [decision({ wallet: 1000 }), decision({ wallet: 1000 })];
  const stateService = { build: jest.fn().mockResolvedValueOnce(states[0]).mockResolvedValueOnce(states[1] ?? states[0]) };
  const observability = options.observability ?? new AdaptiveRecommendationObservabilityV1Service();
  const evidenceService = {
    resolveLocalPatchId: jest.fn(() => options.patchId === null ? undefined : (options.patchId ?? '15-1')),
    getLocalEvidence: jest.fn((input: any) => options.localEvidence ?? evidence(true, input.statlockerPatchId)),
  };
  const planner = options.planner ?? { version: 'adaptive-build-planner-v1', plan: jest.fn(() => options.plan ?? plannerResult()) };
  const replay = {
    getPreviousPlan: jest.fn().mockResolvedValue(options.previous),
    toReplayInput: jest.fn((builtDecision: any) => ({
      decision: { stateRevision: builtDecision.stateRevision },
      snapshotIds: ['snapshot-wpa'],
    })),
    persist: jest.fn().mockResolvedValue(undefined),
  };
  const service = new AdaptiveRecommendationV1Service(
    stateService as any,
    evidenceService as any,
    planner as any,
    replay as any,
    observability,
  );
  return { service, stateService, evidenceService, planner, replay, observability };
}

describe('AdaptiveRecommendationV1Service', () => {
  it('has no Chromium collector or V8 runtime constructor dependency', () => {
    const names = (Reflect.getMetadata('design:paramtypes', AdaptiveRecommendationV1Service) ?? []).map((type: any) => type?.name ?? 'unknown');
    expect(names).toEqual([
      'AdaptiveDecisionStateV1Service',
      'StatlockerEvidenceService',
      'AdaptiveBuildPlannerV1Service',
      'AdaptiveReplayV1Service',
      'AdaptiveRecommendationObservabilityV1Service',
      'StrategyFirstPromotionGateV1Service',
    ]);
    expect(names.join('|')).not.toMatch(/BrowserCollector|RecommendationRealtime|RecommendationEngine|Behavioral|Value|Policy/);
  });

  it('re-checks legality on fresh state and never publishes a stale legal BUY', async () => {
    const h = harness({ states: [decision({ wallet: 1000, revision: 'revision-a' }), decision({ wallet: undefined, revision: 'revision-b' })] });
    const result = await h.service.recommend({ matchId: 'match-a', localSteamId: 'steam-a' });
    expect(h.stateService.build).toHaveBeenCalledTimes(2);
    expect(result.nextAction.type).toBe('WAIT');
    expect(result.nextAction.actionKey).toBe('WAIT_SAVE:1');
    expect(result.blockers).toContain('STATE_CHANGED_LEGALITY_RECHECK');
    expect(h.replay.persist).toHaveBeenCalledTimes(1);
    expect(h.replay.persist.mock.calls[0][0].result.nextAction.type).toBe('WAIT');
  });

  it('fails a stale transaction plan closed instead of selecting an unrelated fresh action', async () => {
    const plan = plannerResult();
    plan.planSession = {
      planSessionId: 'plan-a',
      strategyId: 'strategy-a',
      revision: 1,
      createdAtGameTimeSec: 700,
      updatedAtGameTimeSec: 700,
      state: 'ACTIVE',
      nextStepId: 'buy-1',
      reasonCodes: [],
      steps: [{
        stepId: 'buy-1',
        goalId: 'goal-1',
        kind: 'TRANSACTION',
        state: 'NEXT',
        action: { type: 'BUY', buyItemId: 1 },
        prerequisiteStepIds: [],
        blockingReasons: [],
        projectedBefore: {
          inventoryItemIds: [],
          spendableSouls: 1000,
          usedByType: { weapon: 0, vitality: 0, spirit: 0 },
          flexUsed: 0,
          unlockedFlexSlots: 3,
          activeItemsUsed: 0,
        },
        projectedAfter: {
          inventoryItemIds: [1],
          spendableSouls: 500,
          usedByType: { weapon: 1, vitality: 0, spirit: 0 },
          flexUsed: 0,
          unlockedFlexSlots: 3,
          activeItemsUsed: 0,
        },
        reasonCodes: [],
      }],
    };
    const h = harness({
      plan,
      states: [
        decision({ wallet: 1000, revision: 'revision-a' }),
        decision({ wallet: undefined, revision: 'revision-b' }),
      ],
    });

    const result = await h.service.recommend({ matchId: 'match-a', localSteamId: 'steam-a' });

    expect(result.planSession).toMatchObject({
      state: 'REPLAN_REQUIRED',
      nextStepId: undefined,
      reasonCodes: expect.arrayContaining(['FRESH_NEXT_TRANSACTION_NOT_EXECUTABLE']),
    });
    expect(result.nextAction).toMatchObject({
      actionKey: 'HOLD',
      type: 'HOLD',
      reasonCodes: ['TRANSACTION_PLAN_FRESH_LEGALITY_MISMATCH'],
    });
    expect(result.recommendedBuild).toEqual([]);
    expect(result.rankedImmediateCandidates).toEqual([]);
    expect(result.confidence).toBe(0);
    expect(result.blockers).toEqual(expect.arrayContaining([
      'STATE_CHANGED_LEGALITY_RECHECK',
      'TRANSACTION_PLAN_FRESH_LEGALITY_MISMATCH',
    ]));
  });

  it('persists replay input from the same fresh state revision as the published result', async () => {
    const h = harness({
      states: [
        decision({ wallet: 1000, revision: 'revision-a' }),
        decision({ wallet: 1000, revision: 'revision-b' }),
      ],
    });

    await h.service.recommend({ matchId: 'match-a', localSteamId: 'steam-a' });

    const persisted = h.replay.persist.mock.calls[0][0];
    expect(persisted.replayInput.decision.stateRevision).toBe(persisted.result.stateRevision);
    expect(persisted.replayInput.decision.stateRevision).toBe('revision-b');
  });

  it('publishes a planned build rebased to an item purchased before the fresh state read', async () => {
    const plan = plannerResult();
    plan.recommendedBuild = [
      ...plan.recommendedBuild,
      { ...plan.recommendedBuild[0], itemId: 2, position: 2, status: 'PLANNED' },
    ];
    const h = harness({
      states: [
        decision({ wallet: 1000, revision: 'revision-a' }),
        decision({ wallet: 1000, owned: [1], revision: 'revision-b' }),
      ],
      plan,
    });

    const result = await h.service.recommend({ matchId: 'match-a', localSteamId: 'steam-a' });

    expect(result.recommendedBuild).toEqual([
      expect.objectContaining({ itemId: 1, status: 'OWNED' }),
      expect.objectContaining({ itemId: 2, status: 'NEXT' }),
    ]);
    expect(result.nextTargetItemId).toBe(2);
  });

  it('replans a changed revision instead of resurrecting sold or consumed prior inventory as NEXT', async () => {
    const initialPlan = plannerResult();
    initialPlan.recommendedBuild = [
      { ...initialPlan.recommendedBuild[0], itemId: 1, position: 1, status: 'OWNED' },
      { ...initialPlan.recommendedBuild[0], itemId: 2, position: 2, status: 'NEXT' },
    ];
    initialPlan.nextAction = {
      actionKey: 'BUY_ITEM:2',
      type: 'BUY',
      itemId: 2,
      targetItemId: 2,
      reasonCodes: ['FEASIBLE'],
    };
    const freshPlan = plannerResult();
    freshPlan.recommendedBuild = [
      { ...freshPlan.recommendedBuild[0], itemId: 2, position: 1, status: 'NEXT' },
    ];
    freshPlan.nextAction = {
      actionKey: 'BUY_ITEM:2',
      type: 'BUY',
      itemId: 2,
      targetItemId: 2,
      reasonCodes: ['FEASIBLE'],
    };
    const planner = {
      version: 'adaptive-build-planner-v1',
      plan: jest.fn(({ decision: builtDecision }: any) =>
        builtDecision.stateRevision === 'revision-a' ? initialPlan : freshPlan,
      ),
    };
    const h = harness({
      planner,
      states: [
        decision({ wallet: 1000, owned: [1], revision: 'revision-a' }),
        decision({ wallet: 1000, owned: [], revision: 'revision-b' }),
      ],
    });

    const result = await h.service.recommend({ matchId: 'match-a', localSteamId: 'steam-a' });

    expect(result.recommendedBuild.some((item) => item.itemId === 1)).toBe(false);
    expect(result.recommendedBuild.find((item) => item.status === 'NEXT')?.itemId).toBe(2);
  });

  it('rebases a feasible HOLD action target when its planned item becomes owned', async () => {
    const plan = plannerResult();
    plan.nextAction = { actionKey: 'HOLD', type: 'HOLD', targetItemId: 1, reasonCodes: ['PLAN_HYSTERESIS'] };
    plan.recommendedBuild = [
      ...plan.recommendedBuild,
      { ...plan.recommendedBuild[0], itemId: 2, position: 2, status: 'PLANNED' },
    ];
    const h = harness({
      states: [
        decision({ wallet: 1000, revision: 'revision-a' }),
        decision({ wallet: 1000, owned: [1], revision: 'revision-b' }),
      ],
      plan,
    });

    const result = await h.service.recommend({ matchId: 'match-a', localSteamId: 'steam-a' });

    expect(result.nextAction).toEqual(expect.objectContaining({ type: 'HOLD', targetItemId: 2 }));
    expect(result.nextTargetItemId).toBe(2);
  });

  it('aligns a rebased semantic wait wrapper with the fresh target and hides owned alternatives', async () => {
    const plan = plannerResult();
    plan.nextAction = { actionKey: 'WAIT_SAVE:1', type: 'HOLD', targetItemId: 1, reasonCodes: ['PLAN_HYSTERESIS'] };
    plan.recommendedBuild = [
      ...plan.recommendedBuild,
      { ...plan.recommendedBuild[0], itemId: 2, position: 2, status: 'PLANNED' },
    ];
    plan.rankedImmediateCandidates.push({
      action: { actionKey: 'WAIT_SAVE:2', type: 'WAIT', targetItemId: 2, reasonCodes: ['FEASIBLE'] },
      score: 0.05,
      confidence: 0.5,
      components: [],
      reasonCodes: ['FEASIBLE'],
    });
    const h = harness({
      states: [
        decision({ wallet: 1000, revision: 'revision-a' }),
        decision({ wallet: undefined, owned: [1], revision: 'revision-b' }),
      ],
      plan,
    });

    const result = await h.service.recommend({ matchId: 'match-a', localSteamId: 'steam-a' });

    expect(result.nextAction).toMatchObject({ actionKey: 'WAIT_SAVE:2', targetItemId: 2 });
    expect(result.rankedImmediateCandidates.some(({ action }) => action.actionKey === 'WAIT_SAVE:2')).toBe(true);
  });

  it('falls back to the generic fresh wait when the rebased target has no targeted wait candidate', async () => {
    const plan = plannerResult();
    plan.nextAction = { actionKey: 'WAIT_SAVE:1', type: 'HOLD', targetItemId: 1, reasonCodes: ['PLAN_HYSTERESIS'] };
    plan.recommendedBuild = [
      ...plan.recommendedBuild,
      { ...plan.recommendedBuild[0], itemId: 2, position: 2, status: 'PLANNED' },
    ];
    const h = harness({
      states: [
        decision({ wallet: 1000, revision: 'revision-a' }),
        decision({ wallet: 1000, owned: [1], revision: 'revision-b' }),
      ],
      plan,
    });

    const result = await h.service.recommend({ matchId: 'match-a', localSteamId: 'steam-a' });

    expect(result.nextAction).toMatchObject({ actionKey: 'WAIT_SAVE', targetItemId: 2 });
    expect(result.nextTargetItemId).toBe(2);
  });

  it('clears a feasible HOLD action target when its final planned item becomes owned', async () => {
    const plan = plannerResult();
    plan.nextAction = { actionKey: 'HOLD', type: 'HOLD', targetItemId: 1, reasonCodes: ['PLAN_HYSTERESIS'] };
    const h = harness({
      states: [
        decision({ wallet: 1000, revision: 'revision-a' }),
        decision({ wallet: 1000, owned: [1], revision: 'revision-b' }),
      ],
      plan,
    });

    const result = await h.service.recommend({ matchId: 'match-a', localSteamId: 'steam-a' });

    expect(result.nextAction).toEqual(expect.objectContaining({ type: 'HOLD', targetItemId: undefined }));
    expect(result.nextTargetItemId).toBeUndefined();
  });

  it('clears a fallback WAIT target and top-level target when the fresh build is entirely owned', async () => {
    const h = harness({
      states: [
        decision({ wallet: 1000, revision: 'revision-a' }),
        decision({ wallet: undefined, owned: [1], revision: 'revision-b' }),
      ],
    });

    const result = await h.service.recommend({ matchId: 'match-a', localSteamId: 'steam-a' });

    expect(result.recommendedBuild).toEqual([expect.objectContaining({ itemId: 1, status: 'OWNED' })]);
    expect(result.nextAction).toEqual(expect.objectContaining({ type: 'WAIT', targetItemId: undefined }));
    expect(result.nextTargetItemId).toBeUndefined();
  });

  it('rebuilds a fallback targeted WAIT key when the fresh build advances its target', async () => {
    const plan = plannerResult();
    plan.recommendedBuild = [
      ...plan.recommendedBuild,
      { ...plan.recommendedBuild[0], itemId: 2, position: 2, status: 'PLANNED' },
    ];
    const h = harness({
      states: [
        decision({ wallet: 1000, revision: 'revision-a' }),
        decision({ wallet: undefined, owned: [1], revision: 'revision-b' }),
      ],
      plan,
    });

    const result = await h.service.recommend({ matchId: 'match-a', localSteamId: 'steam-a' });

    expect(result.nextAction).toEqual(expect.objectContaining({ type: 'WAIT', targetItemId: 2 }));
    expect(result.nextTargetItemId).toBe(2);
  });

  it('fails closed without reusing a previous plan when local Statlocker evidence is unavailable', async () => {
    const previous = previousResult();
    const h = harness({ previous, localEvidence: evidence(false) });
    const result = await h.service.recommend({ matchId: 'match-a', localSteamId: 'steam-a' });
    expect(result.ready).toBe(false);
    expect(result.recommendedBuild).toEqual([]);
    expect(result.planActions).toEqual([]);
    expect(result.nextAction.type).toBe('ABSTAIN');
    expect(result.confidence).toBe(0);
    expect(result.blockers).toContain('STATLOCKER_EVIDENCE_UNAVAILABLE');
  });

  it('does not advance or expose a stale previous plan while evidence is unavailable', async () => {
    const previous = previousResult();
    previous.recommendedBuild = [
      { ...previous.recommendedBuild[0], itemId: 1, position: 1, status: 'NEXT' },
      { ...previous.recommendedBuild[0], itemId: 2, position: 2, status: 'PLANNED' },
    ];
    previous.nextAction = { actionKey: 'HOLD', type: 'HOLD', targetItemId: 1, reasonCodes: ['PLAN_HYSTERESIS'] };
    previous.nextTargetItemId = 1;
    const current = decision({ wallet: 1000, owned: [1], revision: 'revision-b' });
    const h = harness({
      states: [current, current],
      previous,
      localEvidence: evidence(false),
    });

    const result = await h.service.recommend({ matchId: 'match-a', localSteamId: 'steam-a' });

    expect(result.ready).toBe(false);
    expect(result.recommendedBuild).toEqual([]);
    expect(result.nextAction).toEqual(expect.objectContaining({ type: 'ABSTAIN' }));
    expect(result.nextTargetItemId).toBeUndefined();
  });

  it('returns a safe non-transaction action when no local evidence and no previous plan exist', async () => {
    const h = harness({ localEvidence: evidence(false), previous: undefined });
    const result = await h.service.recommend({ matchId: 'match-a', localSteamId: 'steam-a' });
    expect(result.ready).toBe(false);
    expect(result.nextAction.type).toBe('ABSTAIN');
    expect(['BUY', 'UPGRADE', 'SELL', 'REPLACE']).not.toContain(result.nextAction.type);
    expect(result.blockers).toContain('STATLOCKER_EVIDENCE_UNAVAILABLE');
  });

  it('does not schedule background collection through the serving evidence path', async () => {
    const h = harness();
    await h.service.recommend({ matchId: 'match-a', localSteamId: 'steam-a' });
    expect(h.evidenceService.getLocalEvidence).toHaveBeenCalledTimes(1);
    expect((h.evidenceService as any).getEvidence).toBeUndefined();
  });

  it('bootstraps an empty snapshot cache through a passive local lookup', async () => {
    const h = harness({ patchId: null, localEvidence: evidence(false, 'UNKNOWN'), previous: undefined });
    const result = await h.service.recommend({ matchId: 'match-a', localSteamId: 'steam-a' });
    expect(h.evidenceService.getLocalEvidence).toHaveBeenCalledWith({
      heroId: 10,
      rulesetVersion: 'ruleset-a',
      catalogSha256,
      statlockerPatchId: 'UNKNOWN',
    });
    expect(result.nextAction.type).not.toBe('BUY');
    expect(result.blockers).toContain('STATLOCKER_EVIDENCE_UNAVAILABLE');
  });

  it('records evidence degradation and fallback counts', async () => {
    const h = harness({ localEvidence: evidence(false), previous: undefined });
    await h.service.recommend({ matchId: 'match-a', localSteamId: 'steam-a' });
    const status = h.observability.getStatus();
    expect(status.counters.evidenceDegradedCount).toBe(1);
    expect(status.counters.evidenceFallbackCount).toBe(1);
    expect(status.reasonCodeCounts['WPA_PATCH_DATA:UNAVAILABLE']).toBe(1);
  });

  it('records a final-legality fallback when a non-transaction action is rewritten', async () => {
    const plan = plannerResult();
    plan.nextAction = { actionKey: 'HOLD', type: 'HOLD', targetItemId: 1, reasonCodes: ['PLAN_HYSTERESIS'] };
    plan.recommendedBuild = [
      { ...plan.recommendedBuild[0], itemId: 1, position: 1, status: 'OWNED' },
      { ...plan.recommendedBuild[0], itemId: 2, position: 2, status: 'PLANNED' },
    ];
    const h = harness({
      states: [
        decision({ wallet: 1000, revision: 'revision-a' }),
        decision({ wallet: 1000, owned: [1], revision: 'revision-b' }),
      ],
      plan,
    });

    const result = await h.service.recommend({ matchId: 'match-a', localSteamId: 'steam-a' });

    const status = h.observability.getStatus();
    expect(result.nextAction).toEqual(expect.objectContaining({ type: 'HOLD', targetItemId: 2 }));
    expect(status.counters.finalLegalityFallbackCount).toBe(1);
  });

  it('records unknown flex and investment state at the coordinator boundary', async () => {
    const h = harness({
      states: [
        decision({ wallet: 1000, slotsEvidence: 'UNKNOWN', investmentEvidence: 'UNKNOWN', revision: 'revision-a' }),
        decision({ wallet: 1000, slotsEvidence: 'UNKNOWN', investmentEvidence: 'UNKNOWN', revision: 'revision-b' }),
      ],
    });
    await h.service.recommend({ matchId: 'match-a', localSteamId: 'steam-a' });
    const status = h.observability.getStatus();
    expect(status.counters.flexCapacityUnknownCount).toBe(1);
    expect(status.counters.investmentRulesUnknownCount).toBe(1);
  });

  it('records plan switch and churn when the previous plan is replaced', async () => {
    const plan = plannerResult();
    plan.recommendedBuild = [
      ...plan.recommendedBuild,
      { ...plan.recommendedBuild[0], itemId: 2, position: 2, status: 'PLANNED' },
    ];
    const h = harness({
      previous: previousResult(),
      states: [
        decision({ wallet: 1000, revision: 'revision-a' }),
        decision({ wallet: 1000, revision: 'revision-b' }),
      ],
      plan,
    });
    await h.service.recommend({ matchId: 'match-a', localSteamId: 'steam-a' });
    const status = h.observability.getStatus();
    expect(status.counters.planSwitchCount).toBe(1);
    expect(status.counters.planChurnCount).toBe(1);
  });

  it('records SELL frequency and final-legality retargeting when the fresh target changes', async () => {
    const plan = plannerResult();
    plan.nextAction = {
      actionKey: 'SELL_ITEM:1',
      type: 'SELL',
      itemId: 1,
      sellItemId: 1,
      targetItemId: 1,
      reasonCodes: ['PREPARE_NEXT'],
    };
    plan.recommendedBuild = [
      { ...plan.recommendedBuild[0], itemId: 1, position: 1, status: 'OWNED' },
      { ...plan.recommendedBuild[0], itemId: 2, position: 2, status: 'PLANNED' },
    ];
    plan.rankedImmediateCandidates = [
      {
        action: {
          actionKey: 'SELL_ITEM:1',
          type: 'SELL',
          itemId: 1,
          sellItemId: 1,
          targetItemId: 1,
          reasonCodes: ['PREPARE_NEXT'],
        },
        score: 0.7,
        confidence: 0.6,
        components: [],
        reasonCodes: ['PREPARE_NEXT'],
      },
    ];
    const h = harness({
      states: [
        decision({ wallet: 1000, owned: [1], gameTimeSec: 700, revision: 'revision-a' }),
        decision({ wallet: 1000, owned: [1], gameTimeSec: 700, revision: 'revision-b' }),
      ],
      plan,
    });

    const result = await h.service.recommend({ matchId: 'match-a', localSteamId: 'steam-a' });

    const status = h.observability.getStatus();
    expect(result.nextAction).toMatchObject({ type: 'SELL', sellItemId: 1, targetItemId: 2 });
    expect(status.counters.sellCount).toBe(1);
    expect(status.counters.finalLegalityFallbackCount).toBe(1);
  });

  it('tracks phase and choice prevention through the real planner boundary', async () => {
    const observability = new AdaptiveRecommendationObservabilityV1Service();
    const planner = new AdaptiveBuildPlannerV1Service(
      new AdaptiveEvidenceScorerV1Service(),
      undefined,
      undefined,
      observability,
    );
    const groups = [
      requiredGroup(3, 'MID'),
      choiceGroup([1, 2], 1, 'EARLY'),
    ];
    const h = harness({
      observability,
      planner,
      states: [
        decision({ wallet: 1000, owned: [1, 2], gameTimeSec: 500, revision: 'revision-a' }),
        decision({ wallet: 1000, owned: [1, 2], gameTimeSec: 500, revision: 'revision-b' }),
      ],
      localEvidence: realPlannerEvidence(groups, { 1: 0.15, 2: 0.1, 3: 0.05 }),
    });

    await h.service.recommend({ matchId: 'match-a', localSteamId: 'steam-a' });
    const status = h.observability.getStatus();
    expect(status.counters.phaseViolationPreventedCount).toBeGreaterThan(0);
    expect(status.counters.choiceGroupViolationPreventedCount).toBe(1);
    expect(status.counters.externallyDivergedChoiceStateCount).toBe(1);
  });

  it('records the legacy planner sell when canonical replacement is unavailable', async () => {
    const observability = new AdaptiveRecommendationObservabilityV1Service();
    const planner = new AdaptiveBuildPlannerV1Service(
      new AdaptiveEvidenceScorerV1Service(),
      undefined,
      undefined,
      observability,
    );
    const group = choiceGroup([1, 2], 1, 'EARLY');
    const h = harness({
      observability,
      planner,
      states: [
        decision({ wallet: 1000, owned: [1], gameTimeSec: 700, revision: 'revision-a' }),
        decision({ wallet: 1000, owned: [1], gameTimeSec: 700, revision: 'revision-b' }),
      ],
      localEvidence: realPlannerEvidence([group], { 1: 0, 2: 0.9 }),
    });

    const result = await h.service.recommend({ matchId: 'match-a', localSteamId: 'steam-a' });

    const status = h.observability.getStatus();
    expect(result.nextAction.type).toBe('SELL');
    expect(status.counters.replaceCount).toBe(0);
    expect(status.counters.postCommitReplacementCount).toBe(0);
  });
});
