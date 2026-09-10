import 'reflect-metadata';
import { createHash } from 'crypto';
import {
  buildInventoryInstancesForRecommendation,
  observedFact,
} from '@deadlock-live-probe/build-domain';
import { MinimalMatchState } from '@deadlock-live-probe/shared';
import { AdaptiveDecisionStateV1Service } from '../src/statlocker-adaptive/adaptive-decision-state-v1.service';
import { StatlockerSnapshotStoreService } from '../src/statlocker-adaptive/statlocker-snapshot-store.service';
import { BuildSkeletonService } from '../src/statlocker-adaptive/build-skeleton.service';
import { StatlockerEvidenceService } from '../src/statlocker-adaptive/statlocker-evidence.service';
import { AdaptiveEvidenceScorerV1Service } from '../src/statlocker-adaptive/adaptive-evidence-scorer-v1.service';
import { AdaptiveBuildPlannerV1Service } from '../src/statlocker-adaptive/adaptive-build-planner-v1.service';
import { AdaptiveReplayV1Service } from '../src/statlocker-adaptive/adaptive-replay-v1.service';
import { AdaptiveRecommendationV1Service } from '../src/statlocker-adaptive/adaptive-recommendation-v1.service';
import { ADAPTIVE_POLICY_V1_CONFIG } from '../src/statlocker-adaptive/statlocker-adaptive.config';

const catalogSha256 = 'a'.repeat(64);
const rulesetVersion = 'ruleset-a';
const patchId = '15-1';

function sha(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function jsonHash(value: unknown): string {
  return sha(JSON.stringify(value));
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function snapshotRepository() {
  const rows: any[] = [];
  return {
    rows,
    create: jest.fn((value: any) => value),
    save: jest.fn(async (value: any) => {
      const existingIndex = rows.findIndex((row) => row.snapshotId === value.snapshotId);
      if (existingIndex >= 0) rows[existingIndex] = value;
      else rows.push(value);
      return value;
    }),
    find: jest.fn(async () => [...rows]),
    findOne: jest.fn(async (options: any) => rows.find((row) => row.snapshotId === options?.where?.snapshotId)),
  } as any;
}

function decisionRepository() {
  const rows: any[] = [];
  return {
    rows,
    create: jest.fn((value: any) => value),
    save: jest.fn(async (value: any) => {
      rows.push(value);
      return value;
    }),
    findOne: jest.fn(async (options: any) => {
      if (options?.where?.decisionId) {
        return [...rows].reverse().find((row) => row.decisionId === options.where.decisionId);
      }
      return rows
        .filter((row) => row.matchId === options?.where?.matchId && row.playerKey === options?.where?.playerKey)
        .sort((a, b) => b.decidedAt.getTime() - a.decidedAt.getTime() || b.decisionId.localeCompare(a.decisionId))[0];
    }),
  } as any;
}

function liveMatch(): MinimalMatchState {
  return {
    matchId: 'match-integration',
    gameTimeSec: 700,
    lastUpdatedAt: new Date().toISOString(),
    playersBySteamId: {
      local: {
        steamId: 'local',
        playerName: 'Local',
        isLocal: true,
        heroId: 10,
        teamId: 1,
        souls: 2000,
        items: [{ id: 1, name: 'Owned', className: 'item-1', enhanced: false }],
      },
      ally: {
        steamId: 'ally',
        playerName: 'Ally',
        heroId: 11,
        teamId: 1,
        souls: 98000,
        items: [],
      },
      enemyA: {
        steamId: 'enemy-a',
        playerName: 'Enemy A',
        heroId: 20,
        teamId: 2,
        souls: 50000,
        items: [],
      },
      enemyB: {
        steamId: 'enemy-b',
        playerName: 'Enemy B',
        heroId: 30,
        teamId: 2,
        souls: 50000,
        items: [],
      },
    },
  };
}

function catalogItems() {
  return Array.from({ length: 9 }, (_, index) => {
    const itemId = index + 1;
    return {
      catalogVersionId: 'catalog-integration',
      itemId,
      name: `Item ${itemId}`,
      className: `item-${itemId}`,
      slotType: 'weapon',
      cost: itemId === 9 ? 3000 : 500,
      shopable: true,
      disabled: false,
      active: true,
      isActiveItem: false,
      rawPayload: {},
    };
  });
}

function proProfile(accountId: string, index: number) {
  return {
    accountId,
    heroId: 10,
    items: [
      {
        itemId: 9,
        purchaseRate: 0.95,
        medianBuyTimeS: 860 + index * 5,
        frequencyTier: 'CORE',
        phase: 'mid',
        relationships: [{ itemId: 1, strength: 0.8 }],
      },
      {
        itemId: 2,
        purchaseRate: 0.65,
        medianBuyTimeS: 620 + index * 5,
        frequencyTier: 'FREQUENT',
        phase: 'mid',
        relationships: [{ itemId: 9, strength: 0.5 }],
      },
    ],
  };
}

async function publish(
  store: StatlockerSnapshotStoreService,
  dataset: any,
  scopeKey: string,
  payload: Record<string, unknown>,
  fetchedAt: Date,
  statlockerPatchId = patchId,
  lineage: Partial<Pick<
    Parameters<StatlockerSnapshotStoreService['publish']>[0],
    'schemaVersion' | 'collectorVersion' | 'normalizerVersion'
  >> = {},
): Promise<void> {
  await store.publish({
    dataset,
    rulesetVersion,
    catalogSha256,
    statlockerPatchId,
    scopeKey,
    fetchedAt,
    schemaVersion: lineage.schemaVersion ?? 'statlocker-evidence-v1',
    collectorVersion: lineage.collectorVersion ?? 'integration-fixture-v1',
    normalizerVersion: lineage.normalizerVersion ?? 'integration-fixture-v1',
    contentSha256: sha(`${dataset}|${scopeKey}|${statlockerPatchId}|${JSON.stringify(payload)}`),
    payload,
    metadata: { source: 'adaptive-policy-v1.integration' },
  });
}

async function createFixture(options: { rebuildSkeleton?: boolean } = {}) {
  const match = liveMatch();
  const liveState = { getState: jest.fn((matchId: string) => matchId === match.matchId ? match : undefined) } as any;
  const soulsEvidence = { canVerifyScope: jest.fn().mockResolvedValue(true) } as any;
  const version = {
    catalogVersionId: 'catalog-integration',
    rulesetKey: rulesetVersion,
    source: 'TEST',
    payloadSha256: catalogSha256,
    importedAt: new Date('2026-08-31T12:00:00.000Z'),
  };
  const versionRepo = { find: jest.fn().mockResolvedValue([version]) } as any;
  const itemRepo = { find: jest.fn().mockResolvedValue(catalogItems()) } as any;
  const recipeRepo = { find: jest.fn().mockResolvedValue([]) } as any;
  const decisionState = new AdaptiveDecisionStateV1Service(
    liveState,
    soulsEvidence,
    versionRepo,
    itemRepo,
    recipeRepo,
    { getRules: jest.fn().mockResolvedValue(undefined) } as any,
  );

  const snapshotRepo = snapshotRepository();
  const store = new StatlockerSnapshotStoreService(snapshotRepo);
  const freshAt = new Date(Date.now() - 30_000);
  const wpaPayload = {
    patchId,
    items: [{
      heroId: 10,
      itemId: 9,
      meanWpa: 0.4,
      sampleSize: 2000,
      wpaConfidence: 1,
      gameState: { ahead: 0.3, even: 0.4, behind: 0.5 },
      purchaseTiming: { medianPurchaseSec: 900 },
    }],
  };
  await publish(store, 'WPA_PATCH_DATA', `patch:${patchId}`, wpaPayload, freshAt);
  // VS_HERO_WPA is relational-only since the threat-weighted WPA roadmap; the
  // snapshot store rejects its publication, so this fixture no longer seeds it.
  await publish(store, 'T4_CHAINS', 'global', {
    chains: [{ heroId: 10, itemIds: [1, 9], sampleSize: 800, meanWpa: 0.2 }],
  }, freshAt);

  const profiles = Array.from({ length: 6 }, (_, index) => ({
    accountId: String(100 + index),
    heroId: 10,
    rank: index + 1,
  }));
  await publish(store, 'HERO_LEADERBOARD', 'hero:10', { heroId: 10, profiles }, freshAt);
  for (let index = 0; index < profiles.length; index += 1) {
    const accountId = profiles[index].accountId;
    await publish(
      store,
      'PRO_BUILD_ANALYSIS',
      `hero:10:account:${accountId}`,
      proProfile(accountId, index),
      freshAt,
    );
  }

  const skeleton = new BuildSkeletonService(store);
  const skeletonResult = options.rebuildSkeleton === false
    ? undefined
    : await skeleton.rebuild({
      heroId: 10,
      rulesetVersion,
      catalogSha256,
      statlockerPatchId: patchId,
    });
  if (options.rebuildSkeleton !== false && !skeletonResult) throw new Error('Integration skeleton was not produced');

  await publish(
    store,
    'WPA_PATCH_DATA',
    'patch:15-2',
    { ...wpaPayload, patchId: '15-2' },
    new Date(Date.now() - 49 * 60 * 60_000),
    '15-2',
  );

  const refresh = {
    observeGameIdentity: jest.fn(),
    observeActiveHero: jest.fn(),
    refreshGlobalNow: jest.fn(() => {
      throw new Error('Serving path attempted to launch global collection');
    }),
    enqueueHeroRefresh: jest.fn(),
  } as any;
  const evidence = new StatlockerEvidenceService(store, refresh);
  const scorer = new AdaptiveEvidenceScorerV1Service();
  const planner = new AdaptiveBuildPlannerV1Service(scorer);
  const decisionRepo = decisionRepository();
  const replay = new AdaptiveReplayV1Service(decisionRepo, planner);
  const coordinator = new AdaptiveRecommendationV1Service(decisionState, evidence, planner, replay);

  return {
    match,
    decisionState,
    store,
    skeletonResult,
    refresh,
    evidence,
    planner,
    replay,
    decisionRepo,
    coordinator,
  };
}

function withImmediateEconomy(decision: any, ownedItemIds: readonly number[], spendableSouls: number) {
  const heldByItemId = buildInventoryInstancesForRecommendation(ownedItemIds, decision.itemGraph);
  return {
    ...decision,
    state: {
      ...decision.state,
      inventory: {
        initializedFromSnapshot: true,
        heldByItemId,
        lifecycleCountByItemId: new Map(ownedItemIds.map((itemId) => [itemId, 1])),
        nextInstanceSequence: heldByItemId.size + 1,
      },
      economy: {
        spendableSouls: observedFact(spendableSouls, 'integration'),
        shopOpportunity: observedFact('AVAILABLE', 'integration'),
      },
    },
  };
}

describe('Statlocker adaptive policy v1 integration', () => {
  it('rejects a fresh flat skeleton until rebuild publishes a structured replacement', async () => {
    const h = await createFixture({ rebuildSkeleton: false });
    const flatPayload = {
      heroId: 10,
      profileCount: 6,
      items: [{
        itemId: 9,
        medianBuyTimeS: 900,
        strength: 0.95,
        tier: 'CORE',
        components: { coverage: 1, purchaseRate: 0.95, frequencyTier: 1, orderConsistency: 1, relationship: 0.8 },
      }],
    };
    await publish(
      h.store,
      'CONSENSUS_SKELETON',
      'hero:10:consensus',
      flatPayload,
      new Date(Date.now() - 30_000),
      patchId,
      {
        schemaVersion: 'statlocker-consensus-skeleton-v2',
        collectorVersion: 'internal-consensus-v1',
        normalizerVersion: 'consensus-builder-v1',
      },
    );

    const beforeRebuild = h.evidence.getLocalEvidence({
      heroId: 10,
      rulesetVersion,
      catalogSha256,
      statlockerPatchId: patchId,
    });
    expect(beforeRebuild.byDataset.CONSENSUS_SKELETON.freshness).toBe('UNAVAILABLE');
    expect(beforeRebuild.byDataset.CONSENSUS_SKELETON.payload).toBeUndefined();

    const degraded = await h.coordinator.recommend({ matchId: h.match.matchId, localSteamId: 'local' });
    expect(['WAIT', 'HOLD', 'ABSTAIN']).toContain(degraded.nextAction.type);
    expect(degraded.nextAction.reasonCodes).toContain('STRUCTURED_SKELETON_UNAVAILABLE');

    const rebuilt = await new BuildSkeletonService(h.store).rebuild({
      heroId: 10,
      rulesetVersion,
      catalogSha256,
      statlockerPatchId: patchId,
    });
    expect(rebuilt?.groups.length).toBeGreaterThan(0);

    const afterRebuild = h.evidence.getLocalEvidence({
      heroId: 10,
      rulesetVersion,
      catalogSha256,
      statlockerPatchId: patchId,
    });
    expect(afterRebuild.byDataset.CONSENSUS_SKELETON.freshness).toBe('FRESH');
    expect(afterRebuild.byDataset.CONSENSUS_SKELETON.payload).toEqual(expect.objectContaining({
      groups: expect.any(Array),
    }));
    expect(h.store.getActive({
      dataset: 'CONSENSUS_SKELETON',
      rulesetVersion,
      catalogSha256,
      statlockerPatchId: patchId,
      scopeKey: 'hero:10:consensus',
    })).toEqual(expect.objectContaining({
      schemaVersion: 'statlocker-consensus-skeleton-v2',
      normalizerVersion: 'consensus-builder-v2',
    }));

    const rebuiltRecommendation = await h.coordinator.recommend({
      matchId: h.match.matchId,
      localSteamId: 'local',
    });
    expect(rebuiltRecommendation.ready).toBe(false);
    expect(rebuiltRecommendation.nextAction.type).toBe('ABSTAIN');
  });

  it('serves from deterministic local state/snapshots, persists a previous plan, and never lets evidence bypass legality', async () => {
    const h = await createFixture();
    const decision = await h.decisionState.build(h.match.matchId, 'local');

    expect(decision.localSteamId).toBe('local');
    expect(decision.enemyHeroIds).toEqual([20, 30]);
    expect(decision.ourTeamSouls).toBe(100000);
    expect(decision.enemyTeamSouls).toBe(100000);
    expect(decision.state.economy.spendableSouls.value).toBe(2000);
    expect(decision.state.economy.spendableSouls.evidence).toBe('OBSERVED');
    expect(decision.itemGraph.getItem(9)?.directPurchaseCost).toBe(3000);
    expect(h.skeletonResult?.items.find((item) => item.itemId === 9)?.tier).toBe('CORE');

    const result = await h.coordinator.recommend({ matchId: h.match.matchId, localSteamId: 'local' });

    expect(result.ready).toBe(false);
    expect(result.evidence.snapshotIds).toEqual([...result.evidence.snapshotIds].sort());
    expect(result.nextAction.type).toBe('ABSTAIN');
    expect(result.rankedImmediateCandidates.every((candidate) =>
      !['BUY', 'UPGRADE', 'SELL', 'REPLACE'].includes(candidate.action.type),
    )).toBe(true);
    expect(h.refresh.refreshGlobalNow).not.toHaveBeenCalled();
    expect(h.refresh.enqueueHeroRefresh).not.toHaveBeenCalled();

    const previous = await h.replay.getPreviousPlan(h.match.matchId, 'local');
    expect(previous).toBeUndefined();

    const persisted = h.decisionRepo.rows[0];
    const replayA = h.replay.run(persisted.replayInput);
    const replayB = h.replay.run(persisted.replayInput);
    expect(jsonHash(replayA)).toBe(jsonHash(replayB));
    expect(replayA.snapshotIds).toEqual(result.evidence.snapshotIds);
  });

  it('shrinks low-sample enemy evidence and preserves hysteresis while enforcing stronger destructive thresholds', async () => {
    const h = await createFixture();
    const baseDecision = await h.decisionState.build(h.match.matchId, 'local');
    const evidence = h.evidence.getLocalEvidence({
      heroId: 10,
      rulesetVersion,
      catalogSha256,
      statlockerPatchId: patchId,
    });

    const fullInventory = withImmediateEconomy(baseDecision, [1, 2, 3, 4, 5, 6, 7, 8], 5000);
    const lowSample = clone(evidence) as any;
    lowSample.byDataset.CONSENSUS_SKELETON.payload.items = [];
    lowSample.byDataset.CONSENSUS_SKELETON.payload.groups = [];
    lowSample.byDataset.WPA_PATCH_DATA.payload.items = [{
      heroId: 10,
      itemId: 9,
      meanWpa: 0,
      sampleSize: 0,
      wpaConfidence: 0,
      gameState: { even: 0 },
      purchaseTiming: {},
    }];
    lowSample.families = Object.values(lowSample.byDataset);

    const lowSamplePlan = h.planner.plan({ decision: fullInventory, evidence: lowSample });
    expect(lowSamplePlan.nextAction.type).not.toBe('REPLACE');

    const savingDecision = withImmediateEconomy(baseDecision, [], 100);
    const original = h.planner.plan({ decision: savingDecision, evidence });
    const held = h.planner.plan({
      decision: savingDecision,
      evidence,
      previousResult: { ...original, totalScore: original.totalScore + 0.01 },
    });
    expect(held.nextAction.type).toBe('HOLD');
    expect(held.recommendedBuild.map((item) => item.itemId)).toEqual(
      original.recommendedBuild.map((item) => item.itemId),
    );

    expect(ADAPTIVE_POLICY_V1_CONFIG.sellMinImprovement)
      .toBeGreaterThan(ADAPTIVE_POLICY_V1_CONFIG.minPlanSwitchImprovement);
    expect(ADAPTIVE_POLICY_V1_CONFIG.coreReplaceMinImprovement)
      .toBeGreaterThan(ADAPTIVE_POLICY_V1_CONFIG.sellMinImprovement);
  });

  it('degrades confidence with age and disables patch-mismatched contextual WPA instead of using it', async () => {
    const h = await createFixture();
    const fresh = h.evidence.getLocalEvidence({
      heroId: 10,
      rulesetVersion,
      catalogSha256,
      statlockerPatchId: patchId,
    });
    const stale = h.evidence.getLocalEvidence({
      heroId: 10,
      rulesetVersion,
      catalogSha256,
      statlockerPatchId: '15-2',
    });
    const mismatch = h.evidence.getLocalEvidence({
      heroId: 10,
      rulesetVersion,
      catalogSha256,
      statlockerPatchId: '16-1',
    });

    expect(fresh.byDataset.WPA_PATCH_DATA.freshness).toBe('FRESH');
    expect(stale.byDataset.WPA_PATCH_DATA.freshness).toBe('STALE_USABLE');
    expect(stale.byDataset.WPA_PATCH_DATA.confidence)
      .toBeLessThan(fresh.byDataset.WPA_PATCH_DATA.confidence);
    expect(mismatch.byDataset.T4_CHAINS.freshness).toBe('PATCH_MISMATCH');
    expect(mismatch.byDataset.T4_CHAINS.confidence).toBe(0);
    expect(mismatch.byDataset.T4_CHAINS.payload).toBeUndefined();
  });

  it('keeps Chromium and ML8 runtime services out of the adaptive recommendation constructor graph', () => {
    const names = (Reflect.getMetadata('design:paramtypes', AdaptiveRecommendationV1Service) ?? [])
      .map((type: any) => type?.name ?? 'unknown');
    expect(names).toEqual([
      'AdaptiveDecisionStateV1Service',
      'StatlockerEvidenceService',
      'AdaptiveBuildPlannerV1Service',
      'AdaptiveReplayV1Service',
      'AdaptiveRecommendationObservabilityV1Service',
      'StrategyFirstPromotionGateV1Service',
    ]);
    expect(names.join('|')).not.toMatch(
      /BrowserCollector|RecommendationBehavioral|RecommendationValue|RecommendationPolicy|RecommendationRealtimeCoordinatorV8|RecommendationEngineV8|RecommendationRealtimeStateV8/,
    );
  });
});
