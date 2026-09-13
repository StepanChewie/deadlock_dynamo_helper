import { Injectable } from '@nestjs/common';
import {
  RecommendationBehavioralRuntimePredictorV1,
  RecommendationBehavioralV8LinearModel,
  RecommendationBehavioralV8Prediction,
  RecommendationExperimentAssignmentV1,
  RecommendationPolicyV1Config,
  RecommendationRuntimeModeV8,
  RecommendationValueV8Model,
} from '@deadlock-live-probe/shared';
import { RecommendationBehavioralServingV1Service } from './recommendation-behavioral-serving-v1.service';
import {
  RecommendationActionSelectionModeV8,
  RecommendationDecisionV8Result,
  RecommendationDecisionV8Service,
} from './recommendation-decision-v8.service';
import { RecommendationRealtimeStateV8Service } from './recommendation-realtime-state-v8.service';
import { RecommendationRuntimeTrustV8Service } from './recommendation-runtime-trust-v8.service';
import { RecommendationTelemetryIngestV8Service } from './recommendation-telemetry-ingest-v8.service';

export interface RecommendationBehavioralServingModelV1 {
  modelVersion: string;
  manifestSha256: string;
}

export interface RecommendationRealtimeModelsV8 {
  behavioralModel?: RecommendationBehavioralV8LinearModel;
  behavioralPredictor?: RecommendationBehavioralRuntimePredictorV1;
  behavioralServing?: RecommendationBehavioralServingModelV1;
  valueModel?: RecommendationValueV8Model;
  policyConfig?: RecommendationPolicyV1Config;
}

export interface RecommendationRealtimeDecisionV8Request {
  eventId: string;
  sourceEventId?: string;
  decisionId: string;
  matchId: string;
  playerKey: string;
  playerSlot: number;
  decisionAtMs: number;
  candidateGeneratorVersion: string;
  modelVersion: string;
  runtimeMode: RecommendationRuntimeModeV8;
  experiment: RecommendationExperimentAssignmentV1;
  selectionMode: RecommendationActionSelectionModeV8;
  explorationProbabilityByActionKey?: Readonly<Record<string, number>>;
  maximumAlignmentAgeMs?: number;
  maximumHistoryEvents?: number;
}

export interface RecommendationRealtimeDecisionV8Result {
  ready: boolean;
  blockers: readonly string[];
  decision?: RecommendationDecisionV8Result;
  persistence?: {
    status: 'APPENDED' | 'DUPLICATE';
    eventId: string;
    deduplicationKey: string;
  };
}

@Injectable()
export class RecommendationRealtimeCoordinatorV8Service {
  constructor(
    private readonly realtimeState: RecommendationRealtimeStateV8Service,
    private readonly decisionService: RecommendationDecisionV8Service,
    private readonly telemetryIngest: RecommendationTelemetryIngestV8Service,
    private readonly behavioralServing: RecommendationBehavioralServingV1Service,
    private readonly runtimeTrust: RecommendationRuntimeTrustV8Service,
  ) {}

  async decide(
    request: RecommendationRealtimeDecisionV8Request,
    models: RecommendationRealtimeModelsV8 = {},
  ): Promise<RecommendationRealtimeDecisionV8Result> {
    const requestErrors = validateRequest(request, models);
    if (requestErrors.length > 0) return { ready: false, blockers: requestErrors };

    const trust = await this.runtimeTrust.resolve({
      runtimeMode: request.runtimeMode,
      selectionMode: request.selectionMode,
    });
    if (!trust.safeExplorationAuthorized || trust.blockers.length > 0) {
      return {
        ready: false,
        blockers: trust.blockers.length > 0 ? trust.blockers : ['RUNTIME_TRUST_NOT_AUTHORIZED'],
      };
    }

    const realtime = await this.realtimeState.build({
      decisionId: request.decisionId,
      matchId: request.matchId,
      playerKey: request.playerKey,
      playerSlot: request.playerSlot,
      decisionAtMs: request.decisionAtMs,
      maximumAlignmentAgeMs: request.maximumAlignmentAgeMs,
      maximumHistoryEvents: request.maximumHistoryEvents,
    });
    if (
      !realtime.ready
      || !realtime.state
      || !realtime.itemGraph
      || !realtime.featureState
      || !realtime.stateRevision
      || !realtime.versions
      || !realtime.quality
    ) {
      return {
        ready: false,
        blockers: realtime.blockers.length > 0 ? realtime.blockers : ['REALTIME_STATE_INCOMPLETE'],
      };
    }

    let behavioralPrediction: RecommendationBehavioralV8Prediction | undefined;
    let upstreamInferenceLatencyMs = 0;
    let servingRuntimeCompatible = true;
    const preInferenceBlockers: string[] = [];
    if (models.behavioralServing) {
      try {
        const prepared = this.decisionService.prepareBehavioralDecision(
          realtime.state,
          realtime.itemGraph,
          realtime.featureState,
        );
        const served = await this.behavioralServing.predict({
          decision: prepared.decision,
          modelVersion: models.behavioralServing.modelVersion,
          featureContractVersion: realtime.featureState.contractVersion,
          candidateGeneratorVersion: request.candidateGeneratorVersion,
          manifestSha256: models.behavioralServing.manifestSha256,
        });
        behavioralPrediction = served.prediction;
        upstreamInferenceLatencyMs = served.inferenceLatencyMs;
      } catch {
        servingRuntimeCompatible = false;
        preInferenceBlockers.push('BEHAVIORAL_SERVING_FAILED');
      }
    }

    const decision = this.decisionService.createDecision({
      eventId: request.eventId,
      playerKey: request.playerKey,
      source: 'RECOMMENDATION_REALTIME_V8',
      sourceEventId: request.sourceEventId,
      sourceOccurredAtMs: request.decisionAtMs,
      receivedAtMs: Date.now(),
      stateRevision: realtime.stateRevision,
      candidateGeneratorVersion: request.candidateGeneratorVersion,
      modelVersion: request.modelVersion,
      versions: realtime.versions,
      quality: realtime.quality,
      state: realtime.state,
      itemGraph: realtime.itemGraph,
      featureState: realtime.featureState,
      behavioralModel: models.behavioralModel,
      behavioralPredictor: models.behavioralPredictor,
      behavioralPrediction,
      valueModel: models.valueModel,
      policyConfig: models.policyConfig,
      runtimeMode: request.runtimeMode,
      observabilityGatePassed: trust.observabilityGatePassed,
      modelRuntimeCompatible: servingRuntimeCompatible && modelConfigurationCompatible(models),
      shadowGatePassed: trust.shadowGatePassed,
      experiment: request.experiment,
      selectionMode: request.selectionMode,
      explorationProbabilityByActionKey: request.explorationProbabilityByActionKey,
      upstreamInferenceLatencyMs,
      preInferenceBlockers,
    });
    const persistence = await this.telemetryIngest.appendInternal(decision.event);
    return {
      ready: true,
      blockers: [],
      decision,
      persistence,
    };
  }
}

function validateRequest(
  request: RecommendationRealtimeDecisionV8Request,
  models: RecommendationRealtimeModelsV8,
): string[] {
  const errors: string[] = [];
  if (!request.eventId) errors.push('EVENT_ID_REQUIRED');
  if (!request.decisionId) errors.push('DECISION_ID_REQUIRED');
  if (!request.matchId) errors.push('MATCH_ID_REQUIRED');
  if (!request.playerKey) errors.push('PLAYER_KEY_REQUIRED');
  if (!Number.isInteger(request.playerSlot) || request.playerSlot < 0) errors.push('PLAYER_SLOT_INVALID');
  if (!Number.isFinite(request.decisionAtMs)) errors.push('DECISION_AT_INVALID');
  if (!request.candidateGeneratorVersion) errors.push('CANDIDATE_GENERATOR_VERSION_REQUIRED');
  if (!request.modelVersion) errors.push('MODEL_VERSION_REQUIRED');

  const behavioralSourceCount = Number(models.behavioralModel !== undefined)
    + Number(models.behavioralPredictor !== undefined)
    + Number(models.behavioralServing !== undefined);
  if (behavioralSourceCount > 1) errors.push('MULTIPLE_BEHAVIORAL_RUNTIME_SOURCES');
  if (models.behavioralModel && models.behavioralModel.modelVersion === '') errors.push('BEHAVIORAL_MODEL_VERSION_REQUIRED');
  if (models.behavioralPredictor && models.behavioralPredictor.modelVersion === '') errors.push('BEHAVIORAL_MODEL_VERSION_REQUIRED');
  if (models.behavioralServing) {
    if (!models.behavioralServing.modelVersion) errors.push('BEHAVIORAL_SERVING_MODEL_VERSION_REQUIRED');
    if (!/^[a-f0-9]{64}$/i.test(models.behavioralServing.manifestSha256)) {
      errors.push('BEHAVIORAL_SERVING_MANIFEST_SHA256_INVALID');
    }
  }
  if (models.valueModel && models.valueModel.modelVersion === '') errors.push('VALUE_MODEL_VERSION_REQUIRED');
  const hasBehavioral = behavioralSourceCount === 1;
  if (models.valueModel && !hasBehavioral) errors.push('VALUE_REQUIRES_BEHAVIORAL_MODEL');
  if (models.policyConfig && (!hasBehavioral || !models.valueModel)) errors.push('POLICY_REQUIRES_BEHAVIORAL_AND_VALUE_MODELS');
  if (request.selectionMode === 'SAFE_EXPLORATION' && !request.experiment.randomized) {
    errors.push('SAFE_EXPLORATION_REQUIRES_RANDOMIZED_EXPERIMENT');
  }
  return [...new Set(errors)].sort();
}

function modelConfigurationCompatible(models: RecommendationRealtimeModelsV8): boolean {
  if (models.behavioralModel && !models.behavioralModel.modelVersion) return false;
  if (models.behavioralPredictor && !models.behavioralPredictor.modelVersion) return false;
  if (models.behavioralServing && !models.behavioralServing.modelVersion) return false;
  if (models.valueModel && !models.valueModel.modelVersion) return false;
  if (models.policyConfig && !models.valueModel) return false;
  return true;
}
