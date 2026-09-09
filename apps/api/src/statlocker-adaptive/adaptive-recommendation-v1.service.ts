import { Inject, Injectable, Optional } from '@nestjs/common';
import {
  DEFAULT_RECOMMENDATION_CANDIDATE_RULES,
  RecommendationCandidate,
  RecommendationItemGraph,
  generateRecommendationCandidates,
} from '@deadlock-live-probe/build-domain';
import {
  AdaptiveActionV1,
  AdaptivePlanSessionV1,
  AdaptivePlanActionV1,
  AdaptiveRecommendationRequestV1,
  AdaptiveRecommendationResultV1,
  AdaptiveRecommendationStrategyV1,
  AdaptiveScoredActionV1,
  AdaptiveSituationalContextV1,
} from '@deadlock-live-probe/shared';
import {
  AdaptiveBuildPlannerResultV1,
  AdaptiveBuildPlannerV1Service,
} from './adaptive-build-planner-v1.service';
import {
  AdaptiveDecisionStateV1,
  AdaptiveDecisionStateV1Service,
} from './adaptive-decision-state-v1.service';
import { AdaptiveEvidenceScorerV1Service } from './adaptive-evidence-scorer-v1.service';
import {
  buildAdaptivePlanActionsV1,
  projectAdaptivePlanActionsFromSessionV1,
} from './adaptive-plan-action-v1';
import { AdaptiveRecommendationObservabilityV1Service } from './adaptive-recommendation-observability-v1.service';
import { AdaptiveReplayV1Service } from './adaptive-replay-v1.service';
import { AdaptiveSituationalContextV1Service } from './adaptive-situational-context-v1.service';
import { resolveSituationalPlanV1 } from './adaptive-situational-planner-v1';
import {
  loadAdaptiveSituationalWindowRegistryV1,
  resolveAdaptiveSituationalWindowsV1,
} from './adaptive-situational-window-registry-v1';
import {
  toAdaptiveBuildContractViewV1,
  toAdaptiveStrategySessionViewV1,
} from './adaptive-strategy-state-view-v1';
import { DraftMatchupEvidenceV1Service } from './draft-matchup-evidence-v1.service';
import {
  AdaptiveStrategySessionV1,
  resolveAdaptiveStrategySessionV1,
} from './strategy-session-v1';
import {
  AdaptiveScoringDatasetV1,
  StatlockerEvidenceBundleV1,
  StatlockerEvidenceService,
} from './statlocker-evidence.service';
import { ADAPTIVE_POLICY_V1_CONFIG } from './statlocker-adaptive.config';
import { StatlockerEvidenceFamilyV1 } from './statlocker-adaptive.types';

const SCORER_VERSION = 'adaptive-evidence-scorer-v1';

type AdaptivePlannerRuntimeResultV1 = ReturnType<AdaptiveBuildPlannerV1Service['plan']> & {
  strategy?: AdaptiveRecommendationStrategyV1;
  planSession?: AdaptivePlanSessionV1;
};

interface PlannedRecommendationV1 {
  planned: AdaptivePlannerRuntimeResultV1;
  situationalByTargetItemId: ReadonlyMap<number, AdaptiveSituationalContextV1>;
}

@Injectable()
export class AdaptiveRecommendationV1Service {
  private readonly situationalScorer = new AdaptiveEvidenceScorerV1Service();
  private readonly situationalEvaluator = new AdaptiveSituationalContextV1Service();

  @Optional()
  @Inject(DraftMatchupEvidenceV1Service)
  private readonly draftMatchupEvidence?: DraftMatchupEvidenceV1Service;

  constructor(
    private readonly decisionState: AdaptiveDecisionStateV1Service,
    private readonly evidence: StatlockerEvidenceService,
    private readonly planner: AdaptiveBuildPlannerV1Service,
    private readonly replay: AdaptiveReplayV1Service,
    private readonly observability: AdaptiveRecommendationObservabilityV1Service = new AdaptiveRecommendationObservabilityV1Service(),
  ) {}

  async recommend(request: AdaptiveRecommendationRequestV1): Promise<AdaptiveRecommendationResultV1> {
    validateRequest(request);
    const initial = await this.decisionState.build(request.matchId, request.localSteamId);
    this.observability.recordDecisionState(initial);
    const previousContext = typeof this.replay?.getPreviousContext === 'function'
      ? await this.replay.getPreviousContext(initial.state.matchId, initial.localSteamId)
      : typeof (this.replay as any)?.getPreviousPlan === 'function'
        ? await (async () => {
            const res = await (this.replay as any).getPreviousPlan(initial.state.matchId, initial.localSteamId);
            return res ? { result: res, replayInput: { decision: { state: { ownedItemIds: res.recommendedBuild?.filter((i: any) => i.status === 'OWNED')?.map((i: any) => i.itemId) ?? [] } } } } as any : undefined;
          })()
        : undefined;
    const previous = previousContext?.result;
    const previousOwnedItemIds = previousContext?.replayInput.decision.state.ownedItemIds;
    const initialDelta = deriveInventoryDeltaV1(
      previousOwnedItemIds ?? [...initial.state.inventory.heldByItemId.keys()],
      [...initial.state.inventory.heldByItemId.keys()],
      initial.itemGraph,
    );
    const patchId = this.evidence.resolveLocalPatchId(initial.rulesetId, initial.catalogSha256) ?? 'UNKNOWN';
    const evidenceRequest = {
      heroId: initial.state.heroId,
      rulesetVersion: initial.rulesetId,
      catalogSha256: initial.catalogSha256,
      statlockerPatchId: patchId,
    };
    const getEvidence = (this.evidence as any).getEvidence;
    const localEvidence = typeof getEvidence === 'function'
      ? getEvidence.call(this.evidence, evidenceRequest)
      : this.evidence.getLocalEvidence(evidenceRequest);
    const initialPlanningEvidence = await this.enrichDraftMatchupEvidence(localEvidence, initial);
    this.observability.recordEvidence(initialPlanningEvidence);

    let plannerUnavailable = false;
    let plannedBundle: PlannedRecommendationV1 | undefined;
    if (initialPlanningEvidence.usable &&
      initial.economyRulesEvidence !== 'UNKNOWN' &&
      initial.slots?.mechanicsEvidence !== 'UNKNOWN') {
      try {
        plannedBundle = this.planWithSituational(
          initial,
          initialPlanningEvidence,
          previous,
          initialDelta.purchasedItemIds,
          initialDelta.soldItemIds,
          false,
        );
      } catch (error) {
        plannerUnavailable = true;
        this.observability.recordEvidence({
          ...initialPlanningEvidence,
          degradedReasons: [...initialPlanningEvidence.degradedReasons, `PLANNER_UNAVAILABLE:${error instanceof Error ? error.message : 'UNKNOWN'}`],
        });
      }
    }

    const fresh = await this.decisionState.build(request.matchId, request.localSteamId);
    const freshDelta = deriveInventoryDeltaV1(
      previousOwnedItemIds ?? [...initial.state.inventory.heldByItemId.keys()],
      [...fresh.state.inventory.heldByItemId.keys()],
      fresh.itemGraph,
    );
    const freshPlanningEvidence = fresh.stateRevision === initial.stateRevision
      ? initialPlanningEvidence
      : await this.enrichDraftMatchupEvidence(localEvidence, fresh);
    if (freshPlanningEvidence.usable && plannedBundle && fresh.stateRevision !== initial.stateRevision) {
      try {
        plannedBundle = this.planWithSituational(
          fresh,
          freshPlanningEvidence,
          previous,
          freshDelta.purchasedItemIds,
          freshDelta.soldItemIds,
          true,
        );
      } catch (error) {
        plannerUnavailable = true;
        plannedBundle = undefined;
      }
    }
    const planned = plannedBundle?.planned;
    const situationalByTargetItemId = plannedBundle?.situationalByTargetItemId ?? new Map();

    const criticalEvidenceUnavailable = !freshPlanningEvidence.usable ||
      fresh.economyRulesEvidence === 'UNKNOWN' ||
      fresh.slots?.mechanicsEvidence === 'UNKNOWN' ||
      plannerUnavailable;
    const freshCandidates = criticalEvidenceUnavailable ? [] : generateRecommendationCandidates({
      state: fresh.state,
      itemGraph: fresh.itemGraph,
      rules: finalLegalityRules(fresh),
    });
    const feasibleByActionKey = new Map(
      freshCandidates
        .filter((candidate) => candidate.feasible && candidate.recommendationEligible)
        .map((candidate) => [candidate.actionId, candidate]),
    );

    const blockers = new Set<string>(freshPlanningEvidence.degradedReasons);
    if (plannerUnavailable) blockers.add('STRATEGY_OUT_OF_DISTRIBUTION');
    if (fresh.economyRulesEvidence === 'UNKNOWN') blockers.add('RULESET_ECONOMY_MECHANICS_UNKNOWN');
    if (fresh.slots?.mechanicsEvidence === 'UNKNOWN') blockers.add('SLOT_MECHANICS_UNKNOWN');
    if (fresh.slots?.flexEvidence === 'UNKNOWN') blockers.add('FLEX_CAPACITY_UNKNOWN');

    let result: AdaptiveRecommendationResultV1;
    let legalityFallback = false;
    let legalityFallbackReasonCodes: readonly string[] = [];

    if (criticalEvidenceUnavailable) {
      if (!freshPlanningEvidence.usable) blockers.add('STATLOCKER_EVIDENCE_UNAVAILABLE');
      result = unavailableRecommendation(fresh, freshPlanningEvidence, blockers);
    } else if (planned) {
      let freshBuild = planned.planSession
        ? planned.recommendedBuild
        : rebasePlanAgainstDecisionV1(planned.recommendedBuild, fresh);
      let freshRanked = planned.rankedImmediateCandidates.filter(({ action }) =>
        feasibleByActionKey.has(action.actionKey),
      );
      const legality = planned.planSession
        ? selectFreshTransactionPlanAction(planned.nextAction, planned.planSession, feasibleByActionKey)
        : selectFreshLegalAction(planned.nextAction, freshRanked, feasibleByActionKey, freshBuild);
      let nextAction = legality.action;
      let planSession = planned.planSession;
      let confidence = clamp01(planned.confidence * (legality.changed ? 0.85 : 1));

      if (legality.changed || fresh.stateRevision !== initial.stateRevision) {
        blockers.add('STATE_CHANGED_LEGALITY_RECHECK');
      }
      if (planSession && legality.changed) {
        blockers.add('TRANSACTION_PLAN_FRESH_LEGALITY_MISMATCH');
        planSession = {
          ...planSession,
          state: 'REPLAN_REQUIRED',
          nextStepId: undefined,
          reasonCodes: unique([
            ...planSession.reasonCodes,
            'FRESH_NEXT_TRANSACTION_NOT_EXECUTABLE',
          ]),
        };
        nextAction = {
          actionKey: 'HOLD',
          type: 'HOLD',
          targetItemId: planned.nextAction.targetItemId,
          reasonCodes: ['TRANSACTION_PLAN_FRESH_LEGALITY_MISMATCH'],
        };
        freshBuild = ownedOnlyCompatibilityBuild(freshBuild, fresh);
        freshRanked = [];
        confidence = 0;
      }

      legalityFallback = legality.changed;
      legalityFallbackReasonCodes = nextAction.reasonCodes ?? [];
      const strategySession = planned.buildContract
        ? resolveStrategySession(planned, fresh, previous)
        : undefined;
      if (strategySession?.state === 'OUT_OF_DISTRIBUTION') blockers.add('STRATEGY_OUT_OF_DISTRIBUTION');
      result = {
        ready: true,
        blockers: [...blockers].sort(),
        decisionId: fresh.state.decisionId,
        stateRevision: fresh.stateRevision,
        gameState: planned.gameState,
        nextAction,
        nextTargetItemId: firstNextTarget(freshBuild) ?? nextAction.targetItemId,
        recommendedBuild: freshBuild,
        changes: planned.changes,
        rankedImmediateCandidates: freshRanked,
        totalScore: planSession?.state === 'REPLAN_REQUIRED' ? 0 : planned.totalScore,
        confidence,
        ...(planned.buildContract ? { buildContract: toAdaptiveBuildContractViewV1(planned.buildContract) } : {}),
        ...(strategySession ? { strategySession: toAdaptiveStrategySessionViewV1(strategySession) } : {}),
        scorerVersion: SCORER_VERSION,
        plannerVersion: planned.plannerVersion,
        configVersion: ADAPTIVE_POLICY_V1_CONFIG.version,
        plannerMethod: planned.strategy ? 'STRATEGY_FIRST' : 'LEGACY_GREEDY',
        strategy: planned.strategy,
        planSession,
        evidence: toProvenance(freshPlanningEvidence),
      };
    } else {
      throw new Error('Adaptive planner did not produce a result');
    }

    const semanticPlanActions = result.planSession
      ? projectAdaptivePlanActionsFromSessionV1(result.planSession, fresh.stateRevision, situationalByTargetItemId)
      : buildAdaptivePlanActionsV1({
          stateRevision: fresh.stateRevision,
          decision: fresh,
          nextAction: result.nextAction,
          recommendedBuild: result.recommendedBuild,
          situationalByTargetItemId,
        });
    result = reconcileResultWithSemanticPlan(result, semanticPlanActions);

    this.observability.recordRecommendationOutcome({
      evidence: freshPlanningEvidence,
      decision: fresh,
      previousResult: previous,
      result,
      legalityFallback,
      legalityFallbackReasonCodes,
    });

    const replayInput = this.replay.toReplayInput(fresh, freshPlanningEvidence, {
      previousResult: previous,
      recentPurchasedItemIds: freshDelta.purchasedItemIds,
      recentSoldItemIds: freshDelta.soldItemIds,
    });
    await this.replay.persist({
      decisionId: result.decisionId,
      matchId: resultMatchId(fresh),
      playerKey: fresh.localSteamId,
      stateRevision: result.stateRevision,
      replayInput,
      result,
    });
    return result;
  }

  private async enrichDraftMatchupEvidence(
    evidence: StatlockerEvidenceBundleV1,
    decision: AdaptiveDecisionStateV1,
  ): Promise<StatlockerEvidenceBundleV1> {
    if (!this.draftMatchupEvidence) return evidence;
    try {
      return await this.draftMatchupEvidence.enrich(evidence, decision);
    } catch {
      return evidence;
    }
  }

  private planWithSituational(
    decision: AdaptiveDecisionStateV1,
    evidence: StatlockerEvidenceBundleV1,
    previous: AdaptiveRecommendationResultV1 | undefined,
    recentPurchasedItemIds: readonly number[],
    recentSoldItemIds: readonly number[],
    suppressObservability: boolean,
  ): PlannedRecommendationV1 {
    const plannerStartedAt = Date.now();
    const corePlan = this.planner.plan({
      decision,
      evidence,
      previousResult: previous,
      recentPurchasedItemIds,
      recentSoldItemIds,
      suppressObservability,
    });
    const windows = resolveAdaptiveSituationalWindowsV1(
      loadAdaptiveSituationalWindowRegistryV1(),
      decision.state.heroId,
      decision.rulesetId,
      decision.catalogSha256,
    );
    const situational = resolveSituationalPlanV1({
      decision,
      evidence,
      corePlan,
      scorer: this.situationalScorer,
      evaluator: this.situationalEvaluator,
      windows,
      optionalTargetItemIds: optionalTargetItemIds(evidence, decision.state.heroId),
      previousResult: previous,
    });
    const planned = situational.windowStates.length === 0
      ? corePlan
      : this.planner.plan({
          decision,
          evidence,
          previousResult: previous,
          recentPurchasedItemIds,
          recentSoldItemIds,
          situationalWindowStates: situational.windowStates,
          suppressObservability,
        });
    this.observability.recordPlannerLatency(Date.now() - plannerStartedAt);

    const selectedTargets = new Set(planned.recommendedBuild.map((item) => item.itemId));
    const contexts = new Map(
      [...situational.contextByTargetItemId.entries()]
        .filter(([targetItemId]) => selectedTargets.has(targetItemId)),
    );
    return { planned, situationalByTargetItemId: contexts };
  }
}

function resolveStrategySession(
  planned: AdaptiveBuildPlannerResultV1,
  decision: AdaptiveDecisionStateV1,
  previous: AdaptiveRecommendationResultV1 | undefined,
): AdaptiveStrategySessionV1 {
  const strategyId = planned.buildContract.strategyId;
  const feasible = Boolean(
    strategyId &&
    planned.buildContract.status !== 'OUT_OF_DISTRIBUTION' &&
    planned.buildContract.status !== 'REPLAN_REQUIRED',
  );
  const previousSession = previous?.strategySession as AdaptiveStrategySessionV1 | undefined;
  return resolveAdaptiveStrategySessionV1({
    decisionId: decision.state.decisionId,
    heroId: decision.state.heroId,
    rulesetId: decision.rulesetId,
    catalogSha256: decision.catalogSha256,
    previous: previousSession,
    candidates: strategyId ? [{
      strategyId,
      heroId: decision.state.heroId,
      rulesetId: decision.rulesetId,
      catalogSha256: decision.catalogSha256,
      score: planned.totalScore,
      confidence: planned.confidence,
      support: Math.max(1, planned.buildContract.completedGoalIds.size + planned.buildContract.remainingGoalIds.length),
      feasible,
    }] : [],
    irreversibleBranchInvestment: planned.buildContract.committedChoiceItemIdsByGroup.size > 0,
    meaningfulUserDivergence: planned.buildContract.temporaryItemIds.size > 0,
  });
}

function optionalTargetItemIds(
  evidence: StatlockerEvidenceBundleV1,
  heroId: number,
): ReadonlySet<number> {
  const payload: unknown = evidence.byDataset.CONSENSUS_SKELETON.payload;
  if (!isRecord(payload) || payload.heroId !== heroId || !Array.isArray(payload.groups)) return new Set();
  const result = new Set<number>();
  for (const group of payload.groups) {
    if (!isRecord(group) || group.type !== 'OPTIONAL' || !Array.isArray(group.candidates)) continue;
    for (const candidate of group.candidates) {
      if (!isRecord(candidate) || !Number.isSafeInteger(candidate.itemId) || Number(candidate.itemId) <= 0) continue;
      result.add(Number(candidate.itemId));
    }
  }
  return result;
}

export function finalLegalityRules(decision: AdaptiveDecisionStateV1) {
  const slots = decision.slots;
  if (!slots || slots.mechanicsEvidence === 'UNKNOWN') {
    return {
      ...DEFAULT_RECOMMENDATION_CANDIDATE_RULES,
      baseSlots: 0,
      baseSlotsByType: { weapon: 0, vitality: 0, spirit: 0 },
      maxFlexSlots: 0,
      unlockedFlexSlots: 0,
      flexCapacityEvidence: 'UNKNOWN' as const,
      maxActiveItems: 0,
      allowSellOnlyActions: false,
    };
  }
  return {
    ...DEFAULT_RECOMMENDATION_CANDIDATE_RULES,
    baseSlots: slots.baseSlots,
    baseSlotsByType: { ...slots.baseSlotsByType },
    maxFlexSlots: slots.maxFlexSlots,
    unlockedFlexSlots: slots.unlockedFlexSlots,
    flexCapacityEvidence: slots.flexEvidence,
    maxActiveItems: slots.maxActiveItems,
    allowSellOnlyActions: true,
  };
}

function reconcileResultWithSemanticPlan(
  result: AdaptiveRecommendationResultV1,
  planActions: readonly AdaptivePlanActionV1[],
): AdaptiveRecommendationResultV1 {
  const first = planActions[0];
  if (!first) return { ...result, planActions };

  let nextAction = result.nextAction;
  if (first.status === 'BLOCKED' && isTransactionAction(nextAction)) {
    nextAction = {
      actionKey: `WAIT_PLAN_REQUIREMENTS:${first.planActionId}`,
      type: 'WAIT',
      targetItemId: first.targetItemId,
      reasonCodes: unique(['PLAN_REQUIREMENTS_BLOCKED', ...first.reasonCodes]),
    };
  } else if (
    first.status === 'READY' &&
    isTransactionAction(first.action) &&
    isTransactionAction(nextAction) &&
    nextAction.actionKey !== first.action.actionKey
  ) {
    nextAction = {
      ...first.action,
      reasonCodes: unique([...first.action.reasonCodes, 'SEMANTIC_TRANSACTION_PATH']),
    };
  } else if (
    (nextAction.type === 'WAIT' || nextAction.type === 'HOLD' || nextAction.type === 'CONTINUE_CORE') &&
    first.targetItemId !== undefined
  ) {
    nextAction = { ...nextAction, targetItemId: first.targetItemId };
  }

  return {
    ...result,
    nextAction,
    nextTargetItemId: first.targetItemId ?? result.nextTargetItemId,
    planActions,
  };
}

function selectFreshTransactionPlanAction(
  selected: AdaptiveActionV1,
  session: AdaptivePlanSessionV1,
  feasibleByActionKey: ReadonlyMap<string, RecommendationCandidate>,
): { action: AdaptiveActionV1; changed: boolean } {
  if (session.state === 'WAITING' || session.state === 'REPLAN_REQUIRED' || session.state === 'COMPLETE') {
    return { action: selected, changed: false };
  }
  if (!isTransactionAction(selected)) {
    return {
      action: {
        actionKey: 'HOLD',
        type: 'HOLD',
        targetItemId: selected.targetItemId,
        reasonCodes: ['TRANSACTION_PLAN_NEXT_MISSING'],
      },
      changed: true,
    };
  }
  const candidate = feasibleByActionKey.get(selected.actionKey)
    ?? (selected.type === 'REPLACE' ? feasibleByActionKey.get(`REPLACE_ITEM:${selected.sellItemId}->${selected.buyItemId}`) : undefined)
    ?? (selected.type === 'BUY' && (selected.buyItemId || selected.itemId) ? feasibleByActionKey.get(`BUY_ITEM:${selected.buyItemId ?? selected.itemId}`) : undefined)
    ?? (selected.type === 'SELL' && (selected.sellItemId || selected.itemId) ? feasibleByActionKey.get(`SELL_ITEM:${selected.sellItemId ?? selected.itemId}`) : undefined);
  if (!candidate) {
    return {
      action: {
        actionKey: 'HOLD',
        type: 'HOLD',
        targetItemId: selected.targetItemId,
        reasonCodes: ['TRANSACTION_PLAN_NEXT_NOT_FRESHLY_EXECUTABLE'],
      },
      changed: true,
    };
  }
  const canonical = canonicalFreshAction(selected, candidate, selected.targetItemId);
  return { action: canonical, changed: actionWasRewritten(selected, canonical) };
}

function selectFreshLegalAction(
  selected: AdaptiveActionV1,
  ranked: readonly AdaptiveScoredActionV1[],
  feasibleByActionKey: ReadonlyMap<string, RecommendationCandidate>,
  build: AdaptiveRecommendationResultV1['recommendedBuild'],
): { action: AdaptiveActionV1; changed: boolean } {
  const targetItemId = firstNextTarget(build);
  if (!isTransactionAction(selected)) {
    if (selected.actionKey === 'WAIT' || selected.actionKey === 'HOLD' || selected.actionKey === 'CONTINUE_CORE' || selected.actionKey === 'ABSTAIN') {
      const action = rebasePlanTarget(selected, build, feasibleByActionKey);
      return { action, changed: actionWasRewritten(selected, action) };
    }
    if (feasibleByActionKey.has(selected.actionKey)) {
      const action = rebasePlanTarget(selected, build, feasibleByActionKey);
      return { action, changed: actionWasRewritten(selected, action) };
    }
  } else {
    const candidate = feasibleByActionKey.get(selected.actionKey)
      ?? (selected.type === 'REPLACE' ? feasibleByActionKey.get(`REPLACE_ITEM:${selected.sellItemId}->${selected.buyItemId}`) : undefined)
      ?? (selected.type === 'BUY' && (selected.buyItemId || selected.itemId) ? feasibleByActionKey.get(`BUY_ITEM:${selected.buyItemId ?? selected.itemId}`) : undefined)
      ?? (selected.type === 'SELL' && (selected.sellItemId || selected.itemId) ? feasibleByActionKey.get(`SELL_ITEM:${selected.sellItemId ?? selected.itemId}`) : undefined);
    if (candidate && selectedActionServesFreshNext(selected, targetItemId)) {
      const action = canonicalFreshAction(selected, candidate, targetItemId);
      return { action, changed: actionWasRewritten(selected, action) };
    }
  }

  for (const scored of ranked) {
    const candidate = feasibleByActionKey.get(scored.action.actionKey)
      ?? (scored.action.type === 'REPLACE' ? feasibleByActionKey.get(`REPLACE_ITEM:${scored.action.sellItemId}->${scored.action.buyItemId}`) : undefined)
      ?? (scored.action.type === 'BUY' && (scored.action.buyItemId || scored.action.itemId) ? feasibleByActionKey.get(`BUY_ITEM:${scored.action.buyItemId ?? scored.action.itemId}`) : undefined)
      ?? (scored.action.type === 'SELL' && (scored.action.sellItemId || scored.action.itemId) ? feasibleByActionKey.get(`SELL_ITEM:${scored.action.sellItemId ?? scored.action.itemId}`) : undefined);
    if (!candidate || !fallbackActionServesFreshNext(scored.action, targetItemId)) continue;
    return {
      action: withFreshLegalityFallback(canonicalFreshAction(scored.action, candidate, targetItemId)),
      changed: true,
    };
  }

  return {
    action: {
      actionKey: freshWaitActionKey(targetItemId, feasibleByActionKey),
      type: 'WAIT',
      targetItemId,
      reasonCodes: ['NO_FRESH_LEGAL_TRANSACTION'],
    },
    changed: true,
  };
}

function actionWasRewritten(before: AdaptiveActionV1, after: AdaptiveActionV1): boolean {
  return before.actionKey !== after.actionKey ||
    before.type !== after.type ||
    before.targetItemId !== after.targetItemId ||
    before.itemId !== after.itemId ||
    before.sellItemId !== after.sellItemId ||
    before.buyItemId !== after.buyItemId;
}

function unavailableRecommendation(
  fresh: AdaptiveDecisionStateV1,
  evidence: StatlockerEvidenceBundleV1,
  blockers: ReadonlySet<string>,
): AdaptiveRecommendationResultV1 {
  return {
    ready: false,
    blockers: [...blockers].sort(),
    decisionId: fresh.state.decisionId,
    stateRevision: fresh.stateRevision,
    gameState: 'UNKNOWN',
    nextAction: {
      actionKey: 'ABSTAIN',
      type: 'ABSTAIN',
      reasonCodes: [
        'CRITICAL_EVIDENCE_UNAVAILABLE',
        ...(blockers.has('CONSENSUS_SKELETON:UNAVAILABLE') ? ['STRUCTURED_SKELETON_UNAVAILABLE'] : []),
      ],
    },
    nextTargetItemId: undefined,
    planActions: [],
    recommendedBuild: [],
    changes: [],
    rankedImmediateCandidates: [],
    totalScore: 0,
    confidence: 0,
    scorerVersion: SCORER_VERSION,
    plannerVersion: 'adaptive-build-planner-v1',
    configVersion: ADAPTIVE_POLICY_V1_CONFIG.version,
    plannerMethod: 'STRATEGY_FIRST',
    evidence: toProvenance(evidence),
  };
}

function unavailableEvidence(decision: AdaptiveDecisionStateV1, patchId: string): StatlockerEvidenceBundleV1 {
  const unavailable = (dataset: AdaptiveScoringDatasetV1, scopeKey: string): StatlockerEvidenceFamilyV1 => ({
    dataset,
    scopeKey,
    freshness: 'UNAVAILABLE',
    confidence: 0,
  });
  const byDataset = {
    WPA_PATCH_DATA: unavailable('WPA_PATCH_DATA', `patch:${patchId}`),
    VS_HERO_WPA: unavailable('VS_HERO_WPA', 'global'),
    T4_CHAINS: unavailable('T4_CHAINS', 'global'),
    CONSENSUS_SKELETON: unavailable('CONSENSUS_SKELETON', `hero:${decision.state.heroId}:consensus`),
    WPA_FILTERED_ITEMS: unavailable('WPA_FILTERED_ITEMS', `hero:${decision.state.heroId}`),
  };
  return {
    heroId: decision.state.heroId,
    rulesetVersion: decision.rulesetId,
    catalogSha256: decision.catalogSha256.toLowerCase(),
    statlockerPatchId: patchId,
    usable: false,
    snapshotIds: [],
    degradedReasons: [
      'CONSENSUS_SKELETON:UNAVAILABLE',
      'T4_CHAINS:UNAVAILABLE',
      'VS_HERO_WPA:UNAVAILABLE',
      'WPA_PATCH_DATA:UNAVAILABLE',
    ],
    families: [
      byDataset.WPA_PATCH_DATA,
      byDataset.VS_HERO_WPA,
      byDataset.T4_CHAINS,
      byDataset.CONSENSUS_SKELETON,
      byDataset.WPA_FILTERED_ITEMS,
    ],
    byDataset,
  };
}

function toProvenance(evidence: StatlockerEvidenceBundleV1): AdaptiveRecommendationResultV1['evidence'] {
  return {
    rulesetVersion: evidence.rulesetVersion,
    catalogSha256: evidence.catalogSha256,
    statlockerPatchId: evidence.statlockerPatchId,
    snapshotIds: [...evidence.snapshotIds].sort(),
    families: evidence.families.map((family) => ({
      dataset: family.dataset,
      freshness: family.freshness,
      snapshotId: family.snapshotId,
      contentSha256: family.contentSha256,
      fetchedAt: family.fetchedAt,
      confidence: family.confidence,
    })),
    degradedReasons: [...evidence.degradedReasons].sort(),
  };
}

function isTransactionAction(action: AdaptiveActionV1): boolean {
  return action.type === 'BUY' || action.type === 'UPGRADE' || action.type === 'SELL' || action.type === 'REPLACE';
}

function transactionTargetsNextItem(action: AdaptiveActionV1): boolean {
  return action.type === 'BUY' || action.type === 'UPGRADE' || action.type === 'REPLACE';
}

function selectedActionServesFreshNext(action: AdaptiveActionV1, targetItemId: number | undefined): boolean {
  if (action.type === 'SELL') return targetItemId !== undefined;
  return !transactionTargetsNextItem(action) || action.targetItemId === targetItemId;
}

function fallbackActionServesFreshNext(action: AdaptiveActionV1, targetItemId: number | undefined): boolean {
  if (action.type === 'SELL') return targetItemId !== undefined && action.targetItemId === targetItemId;
  return !transactionTargetsNextItem(action) || action.targetItemId === targetItemId;
}

function canonicalFreshAction(
  planned: AdaptiveActionV1,
  candidate: RecommendationCandidate,
  semanticNextTargetItemId: number | undefined,
): AdaptiveActionV1 {
  const action = candidate.action;
  if (action.type === 'BUY_ITEM') {
    return {
      ...planned,
      actionKey: candidate.actionId,
      type: 'BUY',
      itemId: action.itemId,
      buyItemId: action.itemId,
      targetItemId: action.itemId,
    };
  }
  if (action.type === 'UPGRADE_ITEM') {
    return {
      ...planned,
      actionKey: candidate.actionId,
      type: 'UPGRADE',
      itemId: action.itemId,
      buyItemId: action.itemId,
      targetItemId: action.itemId,
    };
  }
  if (action.type === 'REPLACE_ITEM') {
    return {
      ...planned,
      actionKey: candidate.actionId,
      type: 'REPLACE',
      sellItemId: action.sellItemId,
      buyItemId: action.buyItemId,
      targetItemId: action.buyItemId,
    };
  }
  if (action.type === 'SELL_ITEM') {
    return {
      ...planned,
      actionKey: candidate.actionId,
      type: 'SELL',
      itemId: action.itemId,
      sellItemId: action.itemId,
      targetItemId: semanticNextTargetItemId,
    };
  }
  return {
    ...planned,
    actionKey: candidate.actionId,
    type: 'WAIT',
    targetItemId: semanticNextTargetItemId,
  };
}

function firstNextTarget(build: AdaptiveRecommendationResultV1['recommendedBuild']): number | undefined {
  return build.find((item) => item.status === 'NEXT')?.itemId;
}

function rebasePlanTarget(
  action: AdaptiveActionV1,
  build: AdaptiveRecommendationResultV1['recommendedBuild'],
  feasibleByActionKey: ReadonlyMap<string, RecommendationCandidate>,
): AdaptiveActionV1 {
  if (action.type !== 'WAIT' && action.type !== 'HOLD' && action.type !== 'CONTINUE_CORE') return action;
  const targetItemId = firstNextTarget(build);
  return {
    ...action,
    actionKey: isWaitSaveActionKey(action.actionKey)
      ? freshWaitActionKey(targetItemId, feasibleByActionKey)
      : action.actionKey,
    targetItemId,
  };
}

function withFreshLegalityFallback(action: AdaptiveActionV1): AdaptiveActionV1 {
  return {
    ...action,
    reasonCodes: unique([...action.reasonCodes, 'FRESH_LEGALITY_FALLBACK']),
  };
}

function freshWaitActionKey(
  targetItemId: number | undefined,
  feasibleByActionKey: ReadonlyMap<string, RecommendationCandidate>,
): string {
  const targetedActionKey = targetItemId === undefined ? 'WAIT_SAVE' : `WAIT_SAVE:${targetItemId}`;
  const targetedWait = feasibleByActionKey.get(targetedActionKey);
  if (targetedWait?.action.type === 'WAIT_SAVE') return targetedWait.actionId;
  const genericWait = feasibleByActionKey.get('WAIT_SAVE');
  return genericWait?.action.type === 'WAIT_SAVE' ? genericWait.actionId : 'WAIT';
}

function isWaitSaveActionKey(actionKey: string): boolean {
  return actionKey === 'WAIT_SAVE' || actionKey.startsWith('WAIT_SAVE:');
}

export function rebasePlanAgainstDecisionV1(
  build: AdaptiveRecommendationResultV1['recommendedBuild'],
  decision: Pick<AdaptiveDecisionStateV1, 'state' | 'itemGraph'>,
): AdaptiveRecommendationResultV1['recommendedBuild'] {
  const ownedItemIds = [...decision.state.inventory.heldByItemId.keys()];
  const owned = new Set(ownedItemIds);
  const relevant = build.filter((item) =>
    owned.has(item.itemId) || !decision.itemGraph.isTargetSatisfied(item.itemId, ownedItemIds),
  );
  let nextAssigned = false;
  return relevant.map((item, index) => {
    let status: typeof item.status;
    if (owned.has(item.itemId)) {
      status = 'OWNED';
    } else if (!nextAssigned) {
      status = 'NEXT';
      nextAssigned = true;
    } else {
      status = 'PLANNED';
    }
    return { ...item, position: index + 1, status };
  });
}

function ownedOnlyCompatibilityBuild(
  build: AdaptiveRecommendationResultV1['recommendedBuild'],
  decision: AdaptiveDecisionStateV1,
): AdaptiveRecommendationResultV1['recommendedBuild'] {
  const owned = new Set(decision.state.inventory.heldByItemId.keys());
  const existing = build
    .filter((row) => owned.has(row.itemId))
    .sort((a, b) => a.position - b.position || a.itemId - b.itemId)
    .map((row, index) => ({ ...row, position: index + 1, status: 'OWNED' as const }));
  const represented = new Set(existing.map((row) => row.itemId));
  for (const itemId of [...owned].sort((a, b) => a - b)) {
    if (represented.has(itemId)) continue;
    existing.push({
      itemId,
      position: existing.length + 1,
      status: 'OWNED',
      score: 0,
      confidence: 1,
      skeletonStrength: 0,
      contextualSupport: 1,
      reasonCodes: ['OWNED_ITEM', 'TRANSACTION_PLAN_FRESH_LEGALITY_MISMATCH'],
    });
  }
  return existing;
}

export interface AdaptiveInventoryDeltaV1 {
  purchasedItemIds: readonly number[];
  soldItemIds: readonly number[];
  consumedItemIds: readonly number[];
}

export function deriveInventoryDeltaV1(
  previousOwnedItemIds: readonly number[],
  currentOwnedItemIds: readonly number[],
  itemGraph?: RecommendationItemGraph,
): AdaptiveInventoryDeltaV1 {
  const previous = new Set(stableItemIds(previousOwnedItemIds));
  const current = new Set(stableItemIds(currentOwnedItemIds));
  const purchasedItemIds = [...current]
    .filter((itemId) => !previous.has(itemId))
    .sort((a, b) => a - b);
  const removed = [...previous]
    .filter((itemId) => !current.has(itemId))
    .sort((a, b) => a - b);
  const consumedItemIds = itemGraph
    ? removed.filter((removedItemId) => purchasedItemIds.some((purchasedItemId) =>
        itemGraph.isComponentAncestor(removedItemId, purchasedItemId),
      ))
    : [];
  const consumed = new Set(consumedItemIds);
  return {
    purchasedItemIds,
    soldItemIds: removed.filter((itemId) => !consumed.has(itemId)),
    consumedItemIds,
  };
}

function stableItemIds(values: readonly number[]): number[] {
  return [...new Set(values.filter((itemId) => Number.isInteger(itemId) && itemId > 0))].sort((a, b) => a - b);
}

function resultMatchId(decision: AdaptiveDecisionStateV1): string {
  return decision.state.matchId;
}

function validateRequest(request: AdaptiveRecommendationRequestV1): void {
  if (!request || typeof request.matchId !== 'string' || request.matchId.trim() === '') {
    throw new Error('Adaptive recommendation matchId is required');
  }
  if (request.localSteamId !== undefined && (typeof request.localSteamId !== 'string' || request.localSteamId.trim() === '')) {
    throw new Error('Adaptive recommendation localSteamId is invalid');
  }
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}
