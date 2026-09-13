import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import {
  InventorySnapshotEventV8,
  PlayerStateEventV8,
  RecommendationDecisionEventV8,
  RecommendationExposureAckEventV8,
  RecommendationOutcomeEventV8,
  RecommendationRuntimeHealthEventV8,
  recommendationTelemetryDeduplicationKeyV8,
  validatePlayerStateEventV8,
  validateRecommendationDecisionEventV8,
  validateRecommendationExposureAckEventV8,
  validateRecommendationOutcomeEventV8,
  validateRecommendationRuntimeHealthEventV8,
  validateRecommendationTelemetryEnvelopeV8,
} from '@deadlock-live-probe/shared';
import { RecommendationDecisionCandidateV8 } from './entities/recommendation-decision-candidate.entity';
import { RecommendationDecisionV8 } from './entities/recommendation-decision.entity';
import { RecommendationExposureAckV8 } from './entities/recommendation-exposure-ack.entity';
import { RecommendationTelemetryEvent } from './entities/recommendation-telemetry-event.entity';
import { RecommendationTelemetryRejectionV8 } from './entities/recommendation-telemetry-rejection.entity';

type RecommendationTelemetryInputV8 =
  | PlayerStateEventV8
  | InventorySnapshotEventV8
  | RecommendationDecisionEventV8
  | RecommendationExposureAckEventV8
  | RecommendationOutcomeEventV8
  | RecommendationRuntimeHealthEventV8;

export interface AppendRecommendationTelemetryResult {
  status: 'APPENDED' | 'DUPLICATE';
  eventId: string;
  deduplicationKey: string;
}

@Injectable()
export class RecommendationTelemetryStoreService {
  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(RecommendationTelemetryEvent)
    private readonly eventRepo: Repository<RecommendationTelemetryEvent>,
    @InjectRepository(RecommendationTelemetryRejectionV8)
    private readonly rejectionRepo: Repository<RecommendationTelemetryRejectionV8>,
  ) {}

  async append(event: RecommendationTelemetryInputV8): Promise<AppendRecommendationTelemetryResult> {
    const validation = this.validate(event);
    if (!validation.valid) {
      await this.reject(event, validation.errors);
      throw new Error(`Invalid recommendation telemetry event ${event.eventId}: ${validation.errors.join(',')}`);
    }

    const deduplicationKey = recommendationTelemetryDeduplicationKeyV8(event);
    const existing = await this.eventRepo.findOne({ where: { deduplicationKey } });
    if (existing) return { status: 'DUPLICATE', eventId: existing.eventId, deduplicationKey };

    try {
      await this.dataSource.transaction(async (manager) => {
        const eventRepo = manager.getRepository(RecommendationTelemetryEvent);
        await eventRepo.save(eventRepo.create({
          eventId: event.eventId,
          deduplicationKey,
          schemaVersion: event.schemaVersion,
          contractVersion: event.contractVersion,
          eventType: event.eventType,
          matchId: event.matchId,
          playerKey: event.playerKey,
          source: event.source,
          sourceEventId: event.sourceEventId,
          sourceOccurredAt: new Date(event.sourceOccurredAtMs),
          receivedAt: new Date(event.receivedAtMs),
          gameTimeMs: event.gameTimeMs,
          sequenceNo: event.sequenceNo,
          clientVersion: event.versions.client,
          gepVersion: event.versions.gep,
          normalizerVersion: event.versions.normalizer,
          rulesetVersion: event.versions.ruleset,
          catalogSha256: event.versions.catalogSha256,
          directlyObserved: event.quality.directlyObserved,
          reconstructed: event.quality.reconstructed,
          stale: event.quality.stale,
          alignmentAgeMs: event.quality.alignmentAgeMs,
          payload: event.payload as unknown as Record<string, unknown>,
        }));

        if (event.eventType === 'RECOMMENDATION_DECISION') {
          const decisionRepo = manager.getRepository(RecommendationDecisionV8);
          const candidateRepo = manager.getRepository(RecommendationDecisionCandidateV8);
          await decisionRepo.save(decisionRepo.create({
            decisionId: event.payload.decisionId,
            eventId: event.eventId,
            matchId: event.matchId,
            playerKey: event.playerKey as string,
            decidedAt: new Date(event.sourceOccurredAtMs),
            gameTimeMs: event.gameTimeMs,
            stateRevision: event.payload.stateRevision,
            candidateGeneratorVersion: event.payload.candidateGeneratorVersion,
            rulesetVersion: event.versions.ruleset,
            catalogSha256: event.versions.catalogSha256,
            selectedActionKey: event.payload.selectedActionKey,
            modelVersion: event.payload.modelVersion,
            policyProbability: event.payload.policyProbability,
            experimentId: event.payload.experiment.experimentId,
            experimentArm: event.payload.experiment.arm,
            assignmentVersion: event.payload.experiment.assignmentVersion,
            armAssignmentPropensity: event.payload.experiment.armAssignmentPropensity,
            actionLoggingPropensity: event.payload.actionLoggingPropensity,
            randomized: event.payload.experiment.randomized,
            runtimeMode: event.payload.runtimeMode,
            fallbackUsed: event.payload.fallbackUsed,
            fallbackReasons: [...event.payload.fallbackReasons],
            inferenceLatencyMs: event.payload.inferenceLatencyMs,
            observedActionInjected: event.payload.observedActionInjected,
          }));
          const candidates = event.payload.candidates.map((candidate) => candidateRepo.create({
            decisionId: event.payload.decisionId,
            actionKey: candidate.actionKey,
            actionType: candidate.actionType,
            targetItemId: candidate.targetItemId,
            sellItemId: candidate.sellItemId,
            recipeId: candidate.recipeId,
            consumedItemIds: candidate.consumedItemIds ? [...candidate.consumedItemIds] : undefined,
            effectiveCostSouls: candidate.effectiveCostSouls,
            spendableSoulsAfter: candidate.spendableSoulsAfter,
            resultingItemIds: candidate.resultingItemIds ? [...candidate.resultingItemIds] : undefined,
            feasible: candidate.feasible,
            feasibilityReasons: [...candidate.feasibilityReasons],
            affordable: String(candidate.affordable),
            slotLegal: String(candidate.slotLegal),
            recipeLegal: String(candidate.recipeLegal),
            shopLegal: String(candidate.shopLegal),
            rulesetLegal: String(candidate.rulesetLegal),
            transactionMechanicsKnown: candidate.transactionMechanicsKnown,
            evidence: { ...candidate.evidence },
            behaviorProbability: candidate.behaviorProbability,
            policyScore: candidate.policyScore,
            valueScore: candidate.valueScore,
          }));
          if (candidates.length > 0) await candidateRepo.save(candidates, { chunk: 250 });
        }

        if (event.eventType === 'RECOMMENDATION_EXPOSURE_ACK') {
          const exposureRepo = manager.getRepository(RecommendationExposureAckV8);
          await exposureRepo.save(exposureRepo.create({
            eventId: event.eventId,
            decisionId: event.payload.decisionId,
            selectedActionKey: event.payload.selectedActionKey,
            displayedAt: new Date(event.payload.displayedAtMs),
            displayOrder: [...event.payload.displayOrder],
            ttlMs: event.payload.ttlMs,
          }));
        }
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        return { status: 'DUPLICATE', eventId: event.eventId, deduplicationKey };
      }
      throw error;
    }

    return { status: 'APPENDED', eventId: event.eventId, deduplicationKey };
  }

  async reject(event: Partial<RecommendationTelemetryInputV8>, errors: readonly string[]): Promise<void> {
    const payload = isRecord(event.payload) ? event.payload : undefined;
    const runtimeMode = stringValue(payload?.runtimeMode);
    await this.rejectionRepo.save(this.rejectionRepo.create({
      eventId: stringValue(event.eventId),
      eventType: stringValue(event.eventType),
      matchId: stringValue(event.matchId),
      playerKey: stringValue(event.playerKey),
      source: stringValue(event.source),
      runtimeMode,
      errors: [...new Set(errors)].sort(),
    }));
  }

  private validate(event: RecommendationTelemetryInputV8) {
    switch (event.eventType) {
      case 'PLAYER_STATE':
        return validatePlayerStateEventV8(event);
      case 'RECOMMENDATION_DECISION':
        return validateRecommendationDecisionEventV8(event);
      case 'RECOMMENDATION_EXPOSURE_ACK':
        return validateRecommendationExposureAckEventV8(event);
      case 'RECOMMENDATION_OUTCOME':
        return validateRecommendationOutcomeEventV8(event);
      case 'RECOMMENDATION_RUNTIME_HEALTH':
        return validateRecommendationRuntimeHealthEventV8(event);
      default:
        return validateRecommendationTelemetryEnvelopeV8(event);
    }
  }
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
