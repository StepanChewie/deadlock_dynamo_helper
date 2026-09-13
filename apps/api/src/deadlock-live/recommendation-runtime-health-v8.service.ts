import { Injectable } from '@nestjs/common';
import {
  RECOMMENDATION_TELEMETRY_CONTRACT_VERSION,
  RECOMMENDATION_TELEMETRY_SCHEMA_VERSION,
  RecommendationRuntimeHealthEventV8,
  RecommendationRuntimeModeTelemetryV8,
  RecommendationTelemetryVersionsV8,
} from '@deadlock-live-probe/shared';
import { RecommendationTelemetryIngestV8Service } from './recommendation-telemetry-ingest-v8.service';

export interface RecommendationRuntimeHealthV8Input {
  eventId: string;
  matchId: string;
  playerKey?: string;
  sourceEventId?: string;
  occurredAtMs: number;
  receivedAtMs?: number;
  versions: RecommendationTelemetryVersionsV8;
  runtimeMode: RecommendationRuntimeModeTelemetryV8;
  healthType: 'HEARTBEAT' | 'CRASH_RECOVERY';
  crashCountDelta: number;
  recommendationReady: boolean;
  modelVersion?: string;
}

@Injectable()
export class RecommendationRuntimeHealthV8Service {
  constructor(private readonly telemetryIngest: RecommendationTelemetryIngestV8Service) {}

  emit(input: RecommendationRuntimeHealthV8Input) {
    validateInput(input);
    const event: RecommendationRuntimeHealthEventV8 = {
      schemaVersion: RECOMMENDATION_TELEMETRY_SCHEMA_VERSION,
      contractVersion: RECOMMENDATION_TELEMETRY_CONTRACT_VERSION,
      eventId: input.eventId,
      eventType: 'RECOMMENDATION_RUNTIME_HEALTH',
      matchId: input.matchId,
      playerKey: input.playerKey,
      source: 'RECOMMENDATION_RUNTIME_V8',
      sourceEventId: input.sourceEventId,
      sourceOccurredAtMs: input.occurredAtMs,
      receivedAtMs: input.receivedAtMs ?? Date.now(),
      versions: input.versions,
      payload: {
        runtimeMode: input.runtimeMode,
        healthType: input.healthType,
        crashCountDelta: input.crashCountDelta,
        modelVersion: input.modelVersion,
        recommendationReady: input.recommendationReady,
      },
      quality: {
        directlyObserved: true,
        reconstructed: false,
        stale: false,
        alignmentAgeMs: 0,
      },
    };
    return this.telemetryIngest.appendInternal(event);
  }
}

function validateInput(input: RecommendationRuntimeHealthV8Input): void {
  if (!input.eventId) throw new Error('eventId is required');
  if (!input.matchId) throw new Error('matchId is required');
  if (!Number.isFinite(input.occurredAtMs)) throw new Error('occurredAtMs is invalid');
  if (input.receivedAtMs !== undefined && !Number.isFinite(input.receivedAtMs)) throw new Error('receivedAtMs is invalid');
  if (!Number.isInteger(input.crashCountDelta) || input.crashCountDelta < 0) throw new Error('crashCountDelta must be a non-negative integer');
  if (input.healthType === 'HEARTBEAT' && input.crashCountDelta !== 0) {
    throw new Error('HEARTBEAT crashCountDelta must be zero');
  }
}
