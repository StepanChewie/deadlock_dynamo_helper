import { Injectable } from '@nestjs/common';
import {
  RecommendationCandidate,
  generateRecommendationCandidates,
} from '@deadlock-live-probe/build-domain';
import {
  AdaptiveArchetypeLockSummaryV2,
  AdaptiveEvidenceFamilyV2,
  AdaptiveEvidenceSummaryV2,
  AdaptiveFullBuildPlanV2,
  AdaptiveImmediateActionV2,
  AdaptiveRecommendationRequestV2,
  AdaptiveRecommendationResultV2,
} from '@deadlock-live-probe/shared';
import { BuildArchetypeMatchLockV2Entity } from '../deadlock-live/entities/build-archetype-match-lock-v2.entity';
import { candidateGeneratorRulesFromSlotStateV1 } from './adaptive-economy-v1';
import {
  AdaptiveDecisionStateV1,
  AdaptiveDecisionStateV1Service,
} from './adaptive-decision-state-v1.service';
import { BuildArchetypeSnapshotV2 } from './build-archetype-v2';
import {
  BuildArchetypeSelectionV2,
  BuildArchetypeSelectorV2Service,
} from './build-archetype-selector-v2.service';
import { BuildArchetypeSessionV2Service } from './build-archetype-session-v2.service';
import {
  BuildArchetypeSnapshotIdentityV2,
  BuildArchetypeSnapshotStoreV2Service,
} from './build-archetype-snapshot-store-v2.service';
import { BuildDebugTraceStoreV2Service } from './build-debug-trace-store-v2.service';
import { BuildDecisionTraceCollectorV2 } from './build-decision-trace-v2';
import { EnemyThreatV1Service } from './enemy-threat-v1.service';
import { ResolvedFullBuildPlanV2 } from './full-build-plan-v2';
import { FullBuildResolverV2Service } from './full-build-resolver-v2.service';
import { MatchupCandidateDiscoveryV2Service } from './matchup-candidate-discovery-v2.service';
import {
  StatlockerEvidenceBundleV1,
  StatlockerEvidenceService,
} from './statlocker-evidence.service';
import {
  StatlockerEvidenceFamilyV1,
  StatlockerT4ChainsV1,
  StatlockerWpaPatchDataV1,
} from './statlocker-adaptive.types';
import {
  StatlockerVsHeroWpaAggregateSourceV1,
  StatlockerVsHeroWpaRepositoryV1Service,
} from './statlocker-vs-hero-wpa-repository-v1.service';

const FULL_ENEMY_ROSTER_SIZE = 6;

interface AdaptiveRecommendationLockContextV2 {
  lock: BuildArchetypeMatchLockV2Entity;
  snapshot: BuildArchetypeSnapshotV2;
  selection: BuildArchetypeSelectionV2;
  enemyHeroIds: readonly number[];
  evidence: StatlockerEvidenceBundleV1;
  vsHeroRows: readonly StatlockerVsHeroWpaAggregateSourceV1[];
  trace: BuildDecisionTraceCollectorV2;
}

@Injectable()
export class AdaptiveRecommendationV2Service {
  constructor(
    private readonly decisionState: AdaptiveDecisionStateV1Service,
    private readonly evidence: StatlockerEvidenceService,
    private readonly snapshotStore: BuildArchetypeSnapshotStoreV2Service,
    private readonly wpaRepository: StatlockerVsHeroWpaRepositoryV1Service,
    private readonly selector: BuildArchetypeSelectorV2Service,
    private readonly session: BuildArchetypeSessionV2Service,
    private readonly enemyThreat: EnemyThreatV1Service,
    private readonly discovery: MatchupCandidateDiscoveryV2Service,
    private readonly resolver: FullBuildResolverV2Service,
    private readonly traceStore: BuildDebugTraceStoreV2Service,
  ) {}

  async recommend(request: AdaptiveRecommendationRequestV2): Promise<AdaptiveRecommendationResultV2> {
    validateRequest(request);
    const decision = await this.decisionState.build(request.matchId, request.localSteamId);
    const existingLock = await this.session.get(request.matchId);
    const context = existingLock
      ? await this.reuseLock(decision, existingLock)
      : await this.createLock(decision, request.matchId);
    if ('ready' in context) return context;

    const { lock, snapshot, selection, enemyHeroIds, evidence, vsHeroRows, trace } = context;
    const archetype = snapshot.archetypes.find((entry) => entry.archetypeId === lock.archetypeId);
    if (!archetype) {
      return notReadyRecommendation(decision, ['LOCKED_ARCHETYPE_V2_UNAVAILABLE']);
    }

    const enemyThreats = this.enemyThreat.scoreEnemies(
      enemyHeroIds.map((heroId) =>
        decision.enemyLiveStates.find((enemy) => enemy.heroId === heroId) ?? {
          steamId: `enemy-hero:${heroId}`,
          heroId,
        },
      ),
    );
    const legalByTarget = legalStrategicCandidates(decision);
    const wpaPatchData = familyPayload<StatlockerWpaPatchDataV1>(evidence.byDataset.WPA_PATCH_DATA);
    const t4Chains = familyPayload<StatlockerT4ChainsV1>(evidence.byDataset.T4_CHAINS);
    const outsideCandidates = this.discovery.discover({
      heroId: decision.state.heroId,
      archetype,
      legalByTarget,
      itemGraph: decision.itemGraph,
      gameTimeSec: decision.state.gameTimeSec,
      ownedItemIds: [...decision.state.inventory.heldByItemId.keys()],
      projectedItemIds: [],
      enemyHeroIds,
      enemyThreats,
      vsHeroRows,
      wpaPatchData,
      t4Chains,
    });
    const capacity = decision.slots.totalCapacity;
    if (!Number.isInteger(capacity) || Number(capacity) <= 0) {
      return notReadyRecommendation(decision, ['SLOT_CAPACITY_UNAVAILABLE']);
    }

    const plan = this.resolver.resolve({
      matchId: request.matchId,
      stateRevision: decision.stateRevision,
      heroId: decision.state.heroId,
      rulesetId: decision.rulesetId,
      archetype,
      itemGraph: decision.itemGraph,
      capacity: Number(capacity),
      gameTimeSec: decision.state.gameTimeSec,
      currentInventoryItemIds: [...decision.state.inventory.heldByItemId.keys()],
      enemyHeroIds,
      enemyThreats,
      vsHeroRows,
      wpaPatchData,
      t4Chains,
      outsideCandidates,
      trace,
    });
    const previousTrace = this.traceStore.get(request.matchId);
    this.traceStore.put({
      matchId: request.matchId,
      revision: (previousTrace?.revision ?? 0) + 1,
      stateRevision: decision.stateRevision,
      generatedAt: new Date().toISOString(),
      stages: trace.stages(),
      finalPlan: plan,
    });

    return readyRecommendation({
      decision,
      snapshot,
      evidence,
      vsHeroRowCount: vsHeroRows.length,
      lock,
      selection,
      plan,
    });
  }

  private async reuseLock(
    decision: AdaptiveDecisionStateV1,
    lock: BuildArchetypeMatchLockV2Entity,
  ): Promise<AdaptiveRecommendationLockContextV2 | AdaptiveRecommendationResultV2> {
    if (lock.heroId !== decision.state.heroId) {
      return notReadyRecommendation(decision, ['LOCKED_ARCHETYPE_HERO_MISMATCH']);
    }
    const enemyHeroIds = normalizeHeroIds(lock.enemyHeroIds);
    if (enemyHeroIds.length !== FULL_ENEMY_ROSTER_SIZE) {
      return notReadyRecommendation(decision, ['LOCKED_ENEMY_ROSTER_INVALID']);
    }

    let snapshot: BuildArchetypeSnapshotV2;
    try {
      snapshot = await this.snapshotStore.getById(lock.snapshotId);
    } catch {
      return notReadyRecommendation(decision, ['LOCKED_ARCHETYPE_SNAPSHOT_UNAVAILABLE']);
    }
    const compatibilityBlocker = lockedSnapshotCompatibilityBlocker(decision, lock, snapshot);
    if (compatibilityBlocker) return notReadyRecommendation(decision, [compatibilityBlocker]);

    const selection = parseStoredSelection(lock);
    if (!selection) {
      return notReadyRecommendation(decision, ['LOCKED_ARCHETYPE_SELECTION_INVALID']);
    }
    const identity = snapshotIdentity(snapshot);
    const evidence = this.evidence.getLocalEvidence(identity);
    const vsHeroRows = await this.queryWpa(identity, enemyHeroIds);
    const trace = new BuildDecisionTraceCollectorV2();
    recordSourceTrace(trace, snapshot, evidence, vsHeroRows.length);
    recordReusedSelectionTrace(trace, lock, selection, vsHeroRows.length > 0 ? 1 : 1);
    return { lock, snapshot, selection, enemyHeroIds, evidence, vsHeroRows, trace };
  }

  private async createLock(
    decision: AdaptiveDecisionStateV1,
    matchId: string,
  ): Promise<AdaptiveRecommendationLockContextV2 | AdaptiveRecommendationResultV2> {
    let enemyHeroIds = normalizeHeroIds(decision.enemyHeroIds);
    if (enemyHeroIds.length !== FULL_ENEMY_ROSTER_SIZE) {
      return notReadyRecommendation(decision, ['ENEMY_ROSTER_INCOMPLETE']);
    }

    const statlockerPatchId = this.evidence.resolveLocalPatchId(
      decision.rulesetId,
      decision.catalogSha256,
    );
    if (!statlockerPatchId) {
      return notReadyRecommendation(decision, ['STATLOCKER_PATCH_UNAVAILABLE']);
    }

    const activeIdentity: BuildArchetypeSnapshotIdentityV2 = {
      heroId: decision.state.heroId,
      rulesetVersion: decision.rulesetId,
      statlockerPatchId,
      catalogSha256: decision.catalogSha256,
    };
    let snapshot: BuildArchetypeSnapshotV2;
    try {
      snapshot = await this.snapshotStore.getActive(activeIdentity);
    } catch {
      return notReadyRecommendation(decision, ['BUILD_ARCHETYPE_V2_UNAVAILABLE']);
    }

    let evidence = this.evidence.getLocalEvidence(activeIdentity);
    let vsHeroRows = await this.queryWpa(activeIdentity, enemyHeroIds);
    let trace = new BuildDecisionTraceCollectorV2();
    recordSourceTrace(trace, snapshot, evidence, vsHeroRows.length);
    const proposedSelection = this.selector.select({
      heroId: decision.state.heroId,
      enemyHeroIds,
      snapshot,
      vsHeroRows,
      wpaQueryCount: 1,
    }, trace);
    const lock = await this.session.getOrLock(matchId, {
      heroId: decision.state.heroId,
      snapshotId: snapshot.snapshotId,
      enemyHeroIds,
      selection: proposedSelection,
      lockedGameTimeS: decision.state.gameTimeSec,
    });

    const lockMatchesProposal = lock.snapshotId === snapshot.snapshotId &&
      lock.archetypeId === proposedSelection.archetypeId;
    if (lockMatchesProposal) {
      const selection = parseStoredSelection(lock) ?? proposedSelection;
      enemyHeroIds = normalizeHeroIds(lock.enemyHeroIds);
      return { lock, snapshot, selection, enemyHeroIds, evidence, vsHeroRows, trace };
    }

    let lockedSnapshot: BuildArchetypeSnapshotV2;
    try {
      lockedSnapshot = await this.snapshotStore.getById(lock.snapshotId);
    } catch {
      return notReadyRecommendation(decision, ['LOCKED_ARCHETYPE_SNAPSHOT_UNAVAILABLE']);
    }
    const compatibilityBlocker = lockedSnapshotCompatibilityBlocker(decision, lock, lockedSnapshot);
    if (compatibilityBlocker) return notReadyRecommendation(decision, [compatibilityBlocker]);
    const selection = parseStoredSelection(lock);
    if (!selection) return notReadyRecommendation(decision, ['LOCKED_ARCHETYPE_SELECTION_INVALID']);

    enemyHeroIds = normalizeHeroIds(lock.enemyHeroIds);
    const lockedIdentity = snapshotIdentity(lockedSnapshot);
    evidence = this.evidence.getLocalEvidence(lockedIdentity);
    vsHeroRows = await this.queryWpa(lockedIdentity, enemyHeroIds);
    trace = new BuildDecisionTraceCollectorV2();
    recordSourceTrace(trace, lockedSnapshot, evidence, vsHeroRows.length);
    recordReusedSelectionTrace(trace, lock, selection, 1);
    return {
      lock,
      snapshot: lockedSnapshot,
      selection,
      enemyHeroIds,
      evidence,
      vsHeroRows,
      trace,
    };
  }

  private queryWpa(
    identity: BuildArchetypeSnapshotIdentityV2,
    enemyHeroIds: readonly number[],
  ): Promise<StatlockerVsHeroWpaAggregateSourceV1[]> {
    return this.wpaRepository.findActive({
      statlockerPatchId: identity.statlockerPatchId,
      rulesetVersion: identity.rulesetVersion,
      catalogSha256: identity.catalogSha256,
      ourHeroId: identity.heroId,
      enemyHeroIds,
    });
  }
}

function legalStrategicCandidates(decision: AdaptiveDecisionStateV1): ReadonlyMap<number, RecommendationCandidate> {
  const generated = generateRecommendationCandidates({
    state: decision.state,
    itemGraph: decision.itemGraph,
    rules: candidateGeneratorRulesFromSlotStateV1(decision.slots, {
      allowSellOnlyActions: false,
      generateTargetedWaitActions: false,
    }),
  });
  const result = new Map<number, RecommendationCandidate>();
  for (const candidate of [...generated].sort((left, right) => left.actionId.localeCompare(right.actionId))) {
    const targetItemId = candidateTargetItemId(candidate);
    if (targetItemId === undefined || result.has(targetItemId)) continue;
    if (!candidate.feasible || !candidate.recommendationEligible) continue;
    result.set(targetItemId, candidate);
  }
  return result;
}

function candidateTargetItemId(candidate: RecommendationCandidate): number | undefined {
  if (candidate.action.type === 'BUY_ITEM' || candidate.action.type === 'UPGRADE_ITEM') {
    return candidate.action.itemId;
  }
  if (candidate.action.type === 'REPLACE_ITEM') return candidate.action.buyItemId;
  return undefined;
}

function recordSourceTrace(
  trace: BuildDecisionTraceCollectorV2,
  snapshot: BuildArchetypeSnapshotV2,
  evidence: StatlockerEvidenceBundleV1,
  wpaRowCount: number,
): void {
  trace.record({
    stage: 'SOURCE',
    reasonCodes: [...evidence.degradedReasons],
    payload: {
      heroId: snapshot.heroId,
      statlockerPatchId: snapshot.statlockerPatchId,
      profileAccountIds: [...snapshot.sourceProfileAccountIds],
      profileCount: snapshot.sourceProfileAccountIds.length,
      wpaRowCount,
      t4Available: familyPayload<StatlockerT4ChainsV1>(evidence.byDataset.T4_CHAINS) !== undefined,
    },
  });
}

function recordReusedSelectionTrace(
  trace: BuildDecisionTraceCollectorV2,
  lock: BuildArchetypeMatchLockV2Entity,
  selection: BuildArchetypeSelectionV2,
  wpaQueryCount: number,
): void {
  trace.record({
    stage: 'ARCHETYPE_SELECTION',
    reasonCodes: ['ARCHETYPE_LOCK_REUSED', ...selection.degradedReasons],
    payload: {
      enemyHeroIds: [...lock.enemyHeroIds],
      wpaQueryCount,
      candidates: selection.scores.map((score) => ({
        candidateId: `archetype:${score.archetypeId}`,
        archetypeId: score.archetypeId,
        score: score.score,
        confidence: score.confidence,
        coverage: score.coverage,
        disposition: score.archetypeId === lock.archetypeId ? 'SELECTED' : 'REJECTED',
        reasonCodes: score.archetypeId === lock.archetypeId
          ? ['ARCHETYPE_LOCK_REUSED']
          : ['ARCHETYPE_LOCK_REUSED', 'LOCKED_OTHER_ARCHETYPE'],
      })),
      selectedArchetypeId: lock.archetypeId,
      fallbackUsed: selection.mode === 'OFFLINE_DEFAULT',
    },
  });
}

function snapshotIdentity(snapshot: BuildArchetypeSnapshotV2): BuildArchetypeSnapshotIdentityV2 {
  return {
    heroId: snapshot.heroId,
    rulesetVersion: snapshot.rulesetVersion,
    statlockerPatchId: snapshot.statlockerPatchId,
    catalogSha256: snapshot.catalogSha256,
  };
}

function lockedSnapshotCompatibilityBlocker(
  decision: AdaptiveDecisionStateV1,
  lock: BuildArchetypeMatchLockV2Entity,
  snapshot: BuildArchetypeSnapshotV2,
): string | undefined {
  if (snapshot.snapshotId !== lock.snapshotId || snapshot.heroId !== lock.heroId) {
    return 'LOCKED_ARCHETYPE_SNAPSHOT_IDENTITY_MISMATCH';
  }
  if (snapshot.rulesetVersion !== decision.rulesetId) {
    return 'LOCKED_ARCHETYPE_RULESET_MISMATCH';
  }
  if (snapshot.catalogSha256.toLowerCase() !== decision.catalogSha256.toLowerCase()) {
    return 'LOCKED_ARCHETYPE_CATALOG_MISMATCH';
  }
  return undefined;
}

function readyRecommendation(input: {
  decision: AdaptiveDecisionStateV1;
  snapshot: BuildArchetypeSnapshotV2;
  evidence: StatlockerEvidenceBundleV1;
  vsHeroRowCount: number;
  lock: BuildArchetypeMatchLockV2Entity;
  selection: BuildArchetypeSelectionV2;
  plan: ResolvedFullBuildPlanV2;
}): AdaptiveRecommendationResultV2 {
  const plan: AdaptiveFullBuildPlanV2 = {
    planRevision: input.plan.planRevision,
    steps: input.plan.steps,
    degradedReasons: input.plan.degradedReasons,
    validation: input.plan.validation,
  };
  const selectionScore = input.selection.scores.find((entry) => entry.archetypeId === input.lock.archetypeId);
  const degradedReasons = unique([
    ...input.evidence.degradedReasons,
    ...input.lock.degradedReasons,
    ...plan.degradedReasons,
  ]);
  return {
    ready: true,
    blockers: [],
    decisionId: input.decision.state.decisionId,
    stateRevision: input.decision.stateRevision,
    heroId: input.decision.state.heroId,
    lock: lockSummary(input.lock, input.selection),
    nextAction: nextAction(plan),
    fullBuild: plan,
    score: {
      total: selectionScore?.score ?? 0,
      confidence: selectionScore?.confidence ?? 0,
    },
    evidence: evidenceSummary(input.snapshot, input.evidence, input.vsHeroRowCount),
    degradedReasons,
  };
}

function notReadyRecommendation(
  decision: AdaptiveDecisionStateV1,
  blockers: readonly string[],
): AdaptiveRecommendationResultV2 {
  return {
    ready: false,
    blockers: [...blockers],
    decisionId: decision.state.decisionId,
    stateRevision: decision.stateRevision,
    heroId: decision.state.heroId,
    nextAction: {
      type: 'HOLD',
      reasonCodes: [...blockers],
    },
    score: { total: 0, confidence: 0 },
    degradedReasons: [...blockers],
  };
}

function nextAction(plan: AdaptiveFullBuildPlanV2): AdaptiveImmediateActionV2 {
  const step = plan.steps[0];
  if (!step) {
    return {
      type: 'HOLD',
      reasonCodes: plan.validation.valid ? ['FULL_BUILD_COMPLETE'] : [...plan.validation.reasonCodes],
    };
  }
  return {
    type: step.action,
    buyItemId: step.buyItemId,
    ...(step.sellItemId === undefined ? {} : { sellItemId: step.sellItemId }),
    ...(step.recipeId === undefined ? {} : { recipeId: step.recipeId }),
    reasonCodes: [...step.reasonCodes],
  };
}

function lockSummary(
  lock: BuildArchetypeMatchLockV2Entity,
  selection: BuildArchetypeSelectionV2,
): AdaptiveArchetypeLockSummaryV2 {
  return {
    matchId: lock.matchId,
    heroId: lock.heroId,
    snapshotId: lock.snapshotId,
    archetypeId: lock.archetypeId,
    enemyHeroIds: [...lock.enemyHeroIds],
    selectionMode: selection.mode,
    lockedAt: lock.lockedAt.toISOString(),
    ...(lock.lockedGameTimeS === undefined ? {} : { lockedGameTimeS: lock.lockedGameTimeS }),
    degradedReasons: [...lock.degradedReasons],
  };
}

function evidenceSummary(
  snapshot: BuildArchetypeSnapshotV2,
  evidence: StatlockerEvidenceBundleV1,
  vsHeroRowCount: number,
): AdaptiveEvidenceSummaryV2 {
  return {
    rulesetVersion: snapshot.rulesetVersion,
    catalogSha256: snapshot.catalogSha256,
    statlockerPatchId: snapshot.statlockerPatchId,
    sourceProfileCount: snapshot.sourceProfileAccountIds.length,
    sourceProfileAccountIds: [...snapshot.sourceProfileAccountIds],
    families: [
      {
        dataset: 'PRO_BUILD_ANALYSIS',
        available: snapshot.sourceProfileAccountIds.length > 0,
        snapshotId: snapshot.snapshotId,
        rowCount: snapshot.sourceProfileAccountIds.length,
        confidence: snapshot.sourceProfileAccountIds.length === 10 ? 1 : 0,
        reasonCodes: snapshot.sourceProfileAccountIds.length === 10 ? [] : ['PRO_BUILD_PROFILE_COUNT_INCOMPLETE'],
      },
      {
        dataset: 'VS_HERO_WPA',
        available: vsHeroRowCount > 0,
        rowCount: vsHeroRowCount,
        reasonCodes: vsHeroRowCount > 0 ? [] : ['VS_HERO_WPA_UNAVAILABLE'],
      },
      mapEvidenceFamily('WPA_PATCH_DATA', evidence.byDataset.WPA_PATCH_DATA),
      mapEvidenceFamily('T4_CHAINS', evidence.byDataset.T4_CHAINS),
    ],
    degradedReasons: [...evidence.degradedReasons],
  };
}

function mapEvidenceFamily(
  dataset: 'WPA_PATCH_DATA' | 'T4_CHAINS',
  family: StatlockerEvidenceFamilyV1,
): AdaptiveEvidenceFamilyV2 {
  const available = family.payload !== undefined &&
    (family.freshness === 'FRESH' || family.freshness === 'STALE_USABLE');
  return {
    dataset,
    available,
    ...(family.snapshotId === undefined ? {} : { snapshotId: family.snapshotId }),
    confidence: family.confidence,
    reasonCodes: available ? [] : [`${dataset}_${family.freshness}`],
  };
}

function familyPayload<T>(family: StatlockerEvidenceFamilyV1): T | undefined {
  return family.payload as T | undefined;
}

function parseStoredSelection(lock: BuildArchetypeMatchLockV2Entity): BuildArchetypeSelectionV2 | undefined {
  const value = lock.selection as unknown as Partial<BuildArchetypeSelectionV2>;
  if (
    (value.mode === 'VS_HERO_WPA' || value.mode === 'OFFLINE_DEFAULT') &&
    Array.isArray(value.scores) &&
    Array.isArray(value.degradedReasons) &&
    value.scores.some((score) => score?.archetypeId === lock.archetypeId)
  ) {
    return {
      archetypeId: lock.archetypeId,
      mode: value.mode,
      scores: value.scores as BuildArchetypeSelectionV2['scores'],
      degradedReasons: value.degradedReasons as readonly string[],
    };
  }
  return undefined;
}

function normalizeHeroIds(heroIds: readonly number[]): number[] {
  return [...new Set(heroIds.filter((heroId) => Number.isInteger(heroId) && heroId > 0))]
    .sort((left, right) => left - right);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function validateRequest(request: AdaptiveRecommendationRequestV2): void {
  if (!request || typeof request.matchId !== 'string' || request.matchId.trim() === '') {
    throw new Error('Adaptive recommendation v2: matchId is required');
  }
  if (
    request.localSteamId !== undefined &&
    (typeof request.localSteamId !== 'string' || request.localSteamId.trim() === '')
  ) {
    throw new Error('Adaptive recommendation v2: localSteamId is invalid');
  }
}
