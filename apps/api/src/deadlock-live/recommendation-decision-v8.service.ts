import { Injectable } from '@nestjs/common';
import {
  RecommendationDecisionState,
  RecommendationItemGraph,
} from '@deadlock-live-probe/build-domain';
import {
  RECOMMENDATION_TELEMETRY_CONTRACT_VERSION,
  RECOMMENDATION_TELEMETRY_SCHEMA_VERSION,
  RecommendationBehavioralRuntimePredictorV1,
  RecommendationBehavioralV8LinearModel,
  RecommendationBehavioralV8Prediction,
  RecommendationDecisionEventV8,
  RecommendationExperimentAssignmentV1,
  RecommendationFeatureStateV8,
  RecommendationPolicyV1Config,
  RecommendationRuntimeModeV8,
  RecommendationTelemetryQualityV8,
  RecommendationTelemetryVersionsV8,
  RecommendationValueV8Model,
  isSafeFeasibleCandidate,
  selectRecommendationRuntimeActionV8,
  selectSafeExplorationActionV1,
} from '@deadlock-live-probe/shared';
import {
  RecommendationEngineBehavioralPreparationV8,
  RecommendationEngineV8Service,
} from './recommendation-engine-v8.service';

export type RecommendationActionSelectionModeV8 = 'DETERMINISTIC' | 'SAFE_EXPLORATION';

export interface RecommendationDecisionV8Request {
  eventId: string;
  playerKey: string;
  source: string;
  sourceEventId?: string;
  sourceOccurredAtMs: number;
  receivedAtMs: number;
  stateRevision: string;
  candidateGeneratorVersion: string;
  modelVersion: string;
  versions: RecommendationTelemetryVersionsV8;
  quality: RecommendationTelemetryQualityV8;
  state: RecommendationDecisionState;
  itemGraph: RecommendationItemGraph;
  featureState?: RecommendationFeatureStateV8;
  behavioralModel?: RecommendationBehavioralV8LinearModel;
  behavioralPredictor?: RecommendationBehavioralRuntimePredictorV1;
  behavioralPrediction?: RecommendationBehavioralV8Prediction;
  valueModel?: RecommendationValueV8Model;
  policyConfig?: RecommendationPolicyV1Config;
  runtimeMode: RecommendationRuntimeModeV8;
  observabilityGatePassed: boolean;
  modelRuntimeCompatible: boolean;
  shadowGatePassed: boolean;
  experiment: RecommendationExperimentAssignmentV1;
  selectionMode: RecommendationActionSelectionModeV8;
  explorationProbabilityByActionKey?: Readonly<Record<string, number>>;
  upstreamInferenceLatencyMs?: number;
  preInferenceBlockers?: readonly string[];
}

export interface RecommendationDecisionV8Result {
  event: RecommendationDecisionEventV8;
  userVisibleActionKey?: string;
  fallbackUsed: boolean;
  fallbackReasons: readonly string[];
}

@Injectable()
export class RecommendationDecisionV8Service {
  constructor(private readonly engine: RecommendationEngineV8Service) {}

  prepareBehavioralDecision(
    state: RecommendationDecisionState,
    itemGraph: RecommendationItemGraph,
    featureState: RecommendationFeatureStateV8,
  ): RecommendationEngineBehavioralPreparationV8 {
    return this.engine.prepareBehavioralDecision({ state, itemGraph, featureState });
  }

  createDecision(request: RecommendationDecisionV8Request): RecommendationDecisionV8Result {
    const startedAt = process.hrtime.bigint();
    validateRequest(request);
    const engineResult = this.engine.evaluate({
      state: request.state,
      itemGraph: request.itemGraph,
      featureState: request.featureState,
      behavioralModel: request.behavioralModel,
      behavioralPredictor: request.behavioralPredictor,
      behavioralPrediction: request.behavioralPrediction,
      valueModel: request.valueModel,
      policyConfig: request.policyConfig,
    });
    const exactSpendableSoulsKnown = request.state.economy.spendableSouls.evidence !== 'UNKNOWN'
      && request.state.economy.spendableSouls.value !== undefined;
    const shopOpportunityKnown = request.state.economy.shopOpportunity.evidence !== 'UNKNOWN'
      && request.state.economy.shopOpportunity.value !== undefined
      && request.state.economy.shopOpportunity.value !== 'UNKNOWN';

    const runtime = selectRecommendationRuntimeActionV8({
      mode: request.runtimeMode,
      telemetryFresh: !request.quality.stale,
      observabilityGatePassed: request.observabilityGatePassed,
      modelRuntimeCompatible: request.modelRuntimeCompatible && engineResult.policyReady,
      shadowGatePassed: request.shadowGatePassed,
      exactSpendableSoulsKnown,
      shopOpportunityKnown,
      candidates: engineResult.telemetryCandidates,
    });

    let selectedActionKey = runtime.selectedActionKey;
    let actionLoggingPropensity = 1;
    let fallbackUsed = runtime.fallbackUsed;
    const fallbackReasons = [
      ...runtime.fallbackReasons,
      ...(engineResult.policyReady ? [] : engineResult.policyBlockers),
      ...(request.preInferenceBlockers ?? []),
    ];

    if (
      request.selectionMode === 'SAFE_EXPLORATION'
      && !runtime.fallbackUsed
      && request.runtimeMode !== 'DISABLED'
    ) {
      const safeCandidates = engineResult.telemetryCandidates.filter(isSafeFeasibleCandidate);
      const explorationCandidates = safeCandidates.map((candidate) => ({
        actionKey: candidate.actionKey,
        legal: true,
        telemetryFresh: !request.quality.stale,
        feasibilityKnown: candidate.actionType === 'WAIT_SAVE'
          || (
            candidate.affordable !== 'UNKNOWN'
            && candidate.slotLegal !== 'UNKNOWN'
            && candidate.recipeLegal !== 'UNKNOWN'
            && candidate.shopLegal !== 'UNKNOWN'
            && candidate.rulesetLegal !== 'UNKNOWN'
            && candidate.transactionMechanicsKnown
          ),
        probability: request.explorationProbabilityByActionKey?.[candidate.actionKey] ?? 0,
      }));
      try {
        if (explorationCandidates.length < 2 || explorationCandidates.some((candidate) => candidate.probability <= 0)) {
          throw new Error('SAFE_EXPLORATION_DISTRIBUTION_INCOMPLETE');
        }
        const selection = selectSafeExplorationActionV1(
          request.experiment.experimentId,
          request.state.matchId,
          request.state.decisionId,
          explorationCandidates,
        );
        selectedActionKey = selection.actionKey;
        actionLoggingPropensity = selection.actionLoggingPropensity;
      } catch (error) {
        const waitCandidate = engineResult.telemetryCandidates.find(
          (candidate) => candidate.actionType === 'WAIT_SAVE' && candidate.feasible,
        );
        if (!waitCandidate) {
          throw new Error(`SAFE_EXPLORATION fail-closed fallback impossible: ${errorMessage(error)}`);
        }
        selectedActionKey = waitCandidate.actionKey;
        actionLoggingPropensity = 1;
        fallbackUsed = true;
        fallbackReasons.push(
          errorMessage(error).includes('INCOMPLETE')
            ? 'SAFE_EXPLORATION_DISTRIBUTION_INCOMPLETE'
            : 'SAFE_EXPLORATION_DISTRIBUTION_INVALID',
        );
      }
    }

    const selectedCandidate = engineResult.telemetryCandidates.find(
      (candidate) => candidate.actionKey === selectedActionKey,
    );
    if (!selectedCandidate || !selectedCandidate.feasible) {
      throw new Error(`Selected recommendation action is not feasible: ${selectedActionKey}`);
    }
    const policyProbability = selectedCandidate.policyScore
      ?? selectedCandidate.behaviorProbability
      ?? 1;
    const uniqueFallbackReasons = [...new Set(fallbackReasons)].sort();
    const localInferenceLatencyMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    const inferenceLatencyMs = localInferenceLatencyMs + (request.upstreamInferenceLatencyMs ?? 0);

    const event: RecommendationDecisionEventV8 = {
      schemaVersion: RECOMMENDATION_TELEMETRY_SCHEMA_VERSION,
      contractVersion: RECOMMENDATION_TELEMETRY_CONTRACT_VERSION,
      eventId: request.eventId,
      eventType: 'RECOMMENDATION_DECISION',
      matchId: request.state.matchId,
      playerKey: request.playerKey,
      source: request.source,
      sourceEventId: request.sourceEventId,
      sourceOccurredAtMs: request.sourceOccurredAtMs,
      receivedAtMs: request.receivedAtMs,
      gameTimeMs: Math.round(request.state.gameTimeSec * 1000),
      versions: request.versions,
      quality: request.quality,
      payload: {
        decisionId: request.state.decisionId,
        stateRevision: request.stateRevision,
        candidateGeneratorVersion: request.candidateGeneratorVersion,
        candidates: engineResult.telemetryCandidates,
        selectedActionKey,
        modelVersion: request.modelVersion,
        policyProbability,
        actionLoggingPropensity,
        experiment: {
          experimentId: request.experiment.experimentId,
          arm: request.experiment.arm,
          assignmentUnit: request.experiment.assignmentUnit,
          armAssignmentPropensity: request.experiment.armAssignmentPropensity,
          randomized: request.experiment.randomized,
          assignmentVersion: request.experiment.assignmentVersion,
        },
        runtimeMode: request.runtimeMode,
        fallbackUsed,
        fallbackReasons: uniqueFallbackReasons,
        inferenceLatencyMs,
        observedActionInjected: false,
      },
    };

    return {
      event,
      userVisibleActionKey: request.runtimeMode === 'LIVE' ? selectedActionKey : undefined,
      fallbackUsed,
      fallbackReasons: uniqueFallbackReasons,
    };
  }
}

function validateRequest(request: RecommendationDecisionV8Request): void {
  if (!request.eventId) throw new Error('eventId is required');
  if (!request.playerKey) throw new Error('playerKey is required');
  if (!request.source) throw new Error('source is required');
  if (!request.stateRevision) throw new Error('stateRevision is required');
  if (!request.candidateGeneratorVersion) throw new Error('candidateGeneratorVersion is required');
  if (!request.modelVersion) throw new Error('modelVersion is required');
  if (!Number.isFinite(request.sourceOccurredAtMs)) throw new Error('sourceOccurredAtMs is invalid');
  if (!Number.isFinite(request.receivedAtMs)) throw new Error('receivedAtMs is invalid');
  const behavioralSourceCount = Number(request.behavioralModel !== undefined)
    + Number(request.behavioralPredictor !== undefined)
    + Number(request.behavioralPrediction !== undefined);
  if (behavioralSourceCount > 1) throw new Error('Provide exactly one Behavioral runtime source');
  if (request.upstreamInferenceLatencyMs !== undefined
    && (!Number.isFinite(request.upstreamInferenceLatencyMs) || request.upstreamInferenceLatencyMs < 0)) {
    throw new Error('upstreamInferenceLatencyMs is invalid');
  }
  if (request.preInferenceBlockers?.some((blocker) => !blocker)) {
    throw new Error('preInferenceBlockers contains an empty blocker');
  }
  if (request.selectionMode === 'SAFE_EXPLORATION' && !request.experiment.randomized) {
    throw new Error('SAFE_EXPLORATION requires a randomized experiment assignment');
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
