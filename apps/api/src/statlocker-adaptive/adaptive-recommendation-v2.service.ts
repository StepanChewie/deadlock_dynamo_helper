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
import { BuildArchetypeSnapshotV2, BuildArchetypeV2 } from './build-archetype-v2';
import {
  BuildArchetypeSelectionV2,
  BuildArchetypeSelectorV2Service,
} from './build-archetype-selector-v2.service';
import { BuildArchetypeSessionV2Service } from './build-archetype-session-v2.service';
import { BuildArchetypeSnapshotStoreV2Service } from './build-archetype-snapshot-store-v2.service';
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
import { StatlockerVsHeroWpaRepositoryV1Service } from './statlocker-vs-hero-wpa-repository-v1.service';

const FULL_ENEMY_ROSTER_SIZE = 6;

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
    const enemyHeroIds = normalizeHeroIds(decision.enemyHeroIds);
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

    const identity = {
      heroId: decision.state.heroId,
      rulesetVersion: decision.rulesetId,
      statlockerPatchId,
      catalogSha256: decision.catalogSha256,
    };
    let snapshot: BuildArchetypeSnapshotV2;
    try {
      snapshot = await this.snapshotStore.getActive(identity);
    } catch {
      return notReadyRecommendation(decision, ['BUILD_ARCHETYPE_V2_UNAVAILABLE']);
    }

    const evidence = this.evidence.getLocalEvidence(identity);
    const vsHeroRows = await this.wpaRepository.findActive({
      statlockerPatchId,
      rulesetVersion: decision.rulesetId,
      catalogSha256: decision.catalogSha256,
      ourHeroId: decision.state.heroId,
      enemyHeroIds,
    });
    const trace = new BuildDecisionTraceCollectorV2();
    trace.record({
      stage: 'SOURCE',
      reasonCodes: [...evidence.degradedReasons],
      payload: {
        heroId: decision.state.heroId,
        statlockerPatchId,
        profileAccountIds: [...snapshot.sourceProfileAccountIds],
        profileCount: snapshot.sourceProfileAccountIds.length,
        wpaRowCount: vsHeroRows.length,
        t4Available: familyPayload<StatlockerT4ChainsV1>(evidence.byDataset.T4_CHAINS) !== undefined,
      },
    });

    const selection = this.selector.select({
      heroId: decision.state.heroId,
      enemyHeroIds,
      snapshot,
      vsHeroRows,
      wpaQueryCount: 1,
    }, trace);
    const lock = await this.session.getOrLock(request.matchId, {
      heroId: decision.state.heroId,
      snapshotId: snapshot.snapshotId,
      enemyHeroIds,
      selection,
      lockedGameTimeS: decision.state.gameTimeSec,
    });
    const lockedSelection = parseStoredSelection(lock, selection);
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
      selection: lockedSelection,
      archetype,
      plan,
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

function readyRecommendation(input: {
  decision: AdaptiveDecisionStateV1;
  snapshot: BuildArchetypeSnapshotV2;
  evidence: StatlockerEvidenceBundleV1;
  vsHeroRowCount: number;
  lock: BuildArchetypeMatchLockV2Entity;
  selection: BuildArchetypeSelectionV2;
  archetype: BuildArchetypeV2;
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

function parseStoredSelection(
  lock: BuildArchetypeMatchLockV2Entity,
  fallback: BuildArchetypeSelectionV2,
): BuildArchetypeSelectionV2 {
  const value = lock.selection as unknown as Partial<BuildArchetypeSelectionV2>;
  if (
    (value.mode === 'VS_HERO_WPA' || value.mode === 'OFFLINE_DEFAULT') &&
    Array.isArray(value.scores) &&
    Array.isArray(value.degradedReasons)
  ) {
    return {
      archetypeId: lock.archetypeId,
      mode: value.mode,
      scores: value.scores as BuildArchetypeSelectionV2['scores'],
      degradedReasons: value.degradedReasons as readonly string[],
    };
  }
  return fallback;
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
