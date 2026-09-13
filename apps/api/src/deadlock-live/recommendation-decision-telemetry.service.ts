import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type {
  HeroBuildRecommendationAction,
  HeroBuildRecommendationResponse,
} from './hero-build-recommendation.service';

const SCHEMA_VERSION = 1;
const DEFAULT_OUTPUT_DIR =
  '/app/apps/api/storage/recommendation-decision-telemetry';
const EVENT_LOG_FILE = 'events.ndjson';

export type RecommendationDecisionTelemetryEventType =
  | 'DECISION_SERVED'
  | 'DECISION_SUPERSEDED'
  | 'ACTION_OBSERVED'
  | 'MODEL_ERROR'
  | 'MATCH_OUTCOME';

export type RecommendationActionReconstructionConfidence =
  | 'EXACT_SINGLE_ACTION'
  | 'MULTI_ACTION_INTERVAL'
  | 'AMBIGUOUS_MULTI_ACTION'
  | 'UNRESOLVED';

export type RecommendationDecisionSupersedeReason =
  | 'NEW_DECISION_SERVED'
  | 'RUNTIME_EVICTED';

export type RecommendationOutcomeSource =
  | 'HISTORICAL_MATCH_PLAYER'
  | 'MANUAL';

export interface RecommendationDecisionTelemetryContext {
  matchId: string;
  steamId: string;
  heroId: number;
  teamId?: number;
  itemIds: number[];
  alliedHeroIds: number[];
  enemyHeroIds: number[];
  previousActionKeys: string[];
  inventoryStateKey: string;
  gameTimeS: number;
  timeBucket: number;
  traversalKey: string;
}

export interface RecommendationOutcomeContext {
  matchId: string;
  steamId: string;
  heroId: number;
  teamId?: number;
}

export interface RecommendationTelemetryMatchupSignal {
  heroId: number;
  direction: 'POSITIVE' | 'NEGATIVE';
  scoreContribution: number;
  contextualPurchaseLiftPercent: number;
  observationCount: number;
}

export interface RecommendationTelemetryCandidateAction {
  actionKey: string;
  actionType: HeroBuildRecommendationAction['type'];
  sourceActionType?: HeroBuildRecommendationAction['sourceActionType'];
  itemId?: number;
  score: number;
  confidence: number;
  historicalCount: number;
  historicalProbability: number;
  predictedStateKey: string;
  matchupSignals: RecommendationTelemetryMatchupSignal[];
}

interface RecommendationTelemetryBaseEvent {
  schemaVersion: number;
  eventId: string;
  eventType: RecommendationDecisionTelemetryEventType;
  occurredAt: string;
}

export interface RecommendationDecisionServedEvent
  extends RecommendationTelemetryBaseEvent,
    RecommendationDecisionTelemetryContext {
  eventType: 'DECISION_SERVED';
  decisionId: string;
  recommendationModel: string;
  modelVersion?: string;
  modelSha256?: string;
  candidateSetPolicy?: string;
  candidateLimit?: number;
  buildArchetypeId?: string;
  servedActionKey: string;
  candidateActions: RecommendationTelemetryCandidateAction[];
  elapsedMs: number;
}

export interface RecommendationDecisionSupersededEvent
  extends RecommendationTelemetryBaseEvent {
  eventType: 'DECISION_SUPERSEDED';
  decisionId: string;
  matchId: string;
  steamId: string;
  traversalKey: string;
  reason: RecommendationDecisionSupersedeReason;
}

export interface RecommendationActionObservedEvent
  extends RecommendationTelemetryBaseEvent,
    RecommendationOutcomeContext {
  eventType: 'ACTION_OBSERVED';
  decisionId: string;
  observedActionKeys: string[];
  observedInventoryStateKey: string;
  observedAtGameTimeS: number;
  reconstructionConfidence: RecommendationActionReconstructionConfidence;
}

export interface RecommendationModelErrorEvent
  extends RecommendationTelemetryBaseEvent,
    RecommendationDecisionTelemetryContext {
  eventType: 'MODEL_ERROR';
  error: string;
  elapsedMs: number;
}

export interface RecommendationMatchOutcomeEvent
  extends RecommendationTelemetryBaseEvent,
    RecommendationOutcomeContext {
  eventType: 'MATCH_OUTCOME';
  playerWon: boolean;
  source: RecommendationOutcomeSource;
}

export type RecommendationDecisionTelemetryEvent =
  | RecommendationDecisionServedEvent
  | RecommendationDecisionSupersededEvent
  | RecommendationActionObservedEvent
  | RecommendationModelErrorEvent
  | RecommendationMatchOutcomeEvent;

export interface RecommendationDecisionTelemetryStatus {
  state: 'READY' | 'DEGRADED';
  schemaVersion: number;
  outputDirectory: string;
  eventLogPath: string;
  eventCount: number;
  decisionCount: number;
  supersededDecisionCount: number;
  observedActionCount: number;
  modelErrorCount: number;
  matchOutcomeCount: number;
  pendingOutcomeCount: number;
  writeErrorCount: number;
  lastEventAt?: string;
  lastWriteErrorAt?: string;
  lastWriteError?: string;
}

export interface RecordRecommendationDecisionInput {
  context: RecommendationDecisionTelemetryContext;
  recommendation: HeroBuildRecommendationResponse;
  elapsedMs: number;
}

export interface RecordRecommendationObservedActionInput
  extends RecommendationOutcomeContext {
  decisionId: string;
  observedActionKeys: string[];
  observedInventoryStateKey: string;
  observedAtGameTimeS: number;
  reconstructionConfidence: RecommendationActionReconstructionConfidence;
}

export interface RecordRecommendationDecisionSupersededInput {
  decisionId: string;
  matchId: string;
  steamId: string;
  traversalKey: string;
  reason: RecommendationDecisionSupersedeReason;
}

export interface RecordRecommendationModelErrorInput {
  context: RecommendationDecisionTelemetryContext;
  error: unknown;
  elapsedMs: number;
}

export interface RecordRecommendationMatchOutcomeInput
  extends RecommendationOutcomeContext {
  playerWon: boolean;
  source: RecommendationOutcomeSource;
}

@Injectable()
export class RecommendationDecisionTelemetryService implements OnModuleInit {
  private readonly logger = new Logger(
    RecommendationDecisionTelemetryService.name,
  );
  private readonly outputDirectory =
    process.env.DEADLOCK_RECOMMENDATION_TELEMETRY_DIR?.trim() ||
    DEFAULT_OUTPUT_DIR;
  private readonly eventLogPath = join(
    this.outputDirectory,
    EVENT_LOG_FILE,
  );
  private readonly counts: Record<
    RecommendationDecisionTelemetryEventType,
    number
  > = {
    DECISION_SERVED: 0,
    DECISION_SUPERSEDED: 0,
    ACTION_OBSERVED: 0,
    MODEL_ERROR: 0,
    MATCH_OUTCOME: 0,
  };
  private readonly pendingOutcomeContexts = new Map<
    string,
    RecommendationOutcomeContext
  >();
  private readonly resolvedOutcomeKeys = new Set<string>();
  private writeQueue: Promise<void> = Promise.resolve();
  private eventCount = 0;
  private writeErrorCount = 0;
  private lastEventAt?: string;
  private lastWriteErrorAt?: string;
  private lastWriteError?: string;

  async onModuleInit(): Promise<void> {
    await mkdir(this.outputDirectory, { recursive: true });
    await appendFile(this.eventLogPath, '', 'utf8');
    await this.replayPersistedEvents();
    this.logger.log(
      `Recommendation telemetry ready at ${this.eventLogPath} with ${this.eventCount} persisted events.`,
    );
  }

  getStatus(): RecommendationDecisionTelemetryStatus {
    return {
      state: this.writeErrorCount === 0 ? 'READY' : 'DEGRADED',
      schemaVersion: SCHEMA_VERSION,
      outputDirectory: this.outputDirectory,
      eventLogPath: this.eventLogPath,
      eventCount: this.eventCount,
      decisionCount: this.counts.DECISION_SERVED,
      supersededDecisionCount: this.counts.DECISION_SUPERSEDED,
      observedActionCount: this.counts.ACTION_OBSERVED,
      modelErrorCount: this.counts.MODEL_ERROR,
      matchOutcomeCount: this.counts.MATCH_OUTCOME,
      pendingOutcomeCount: this.pendingOutcomeContexts.size,
      writeErrorCount: this.writeErrorCount,
      lastEventAt: this.lastEventAt,
      lastWriteErrorAt: this.lastWriteErrorAt,
      lastWriteError: this.lastWriteError,
    };
  }

  getPendingOutcomeContexts(
    limit = 64,
  ): RecommendationOutcomeContext[] {
    const normalizedLimit = Number.isSafeInteger(limit) && limit > 0
      ? Math.min(limit, 512)
      : 64;
    return [...this.pendingOutcomeContexts.values()]
      .slice(0, normalizedLimit)
      .map((context) => cloneOutcomeContext(context));
  }

  recordDecision(input: RecordRecommendationDecisionInput): string {
    const decisionId = randomUUID();
    const contextual = input.recommendation as HeroBuildRecommendationResponse & {
      recommendationModel?: string;
      modelVersion?: string;
      modelSha256?: string;
      candidateSetPolicy?: string;
      candidateLimit?: number;
      buildArchetypeId?: string;
    };
    const event: RecommendationDecisionServedEvent = {
      schemaVersion: SCHEMA_VERSION,
      eventId: randomUUID(),
      eventType: 'DECISION_SERVED',
      occurredAt: new Date().toISOString(),
      decisionId,
      ...cloneDecisionContext(input.context),
      recommendationModel: contextual.recommendationModel ?? 'UNKNOWN',
      modelVersion: contextual.modelVersion,
      modelSha256: contextual.modelSha256,
      candidateSetPolicy: contextual.candidateSetPolicy,
      candidateLimit: contextual.candidateLimit,
      buildArchetypeId: contextual.buildArchetypeId,
      servedActionKey: input.recommendation.action.actionKey,
      candidateActions: [
        input.recommendation.action,
        ...input.recommendation.alternatives,
      ].map(serializeCandidateAction),
      elapsedMs: normalizeElapsedMs(input.elapsedMs),
    };
    this.appendEvent(event);
    return decisionId;
  }

  recordObservedAction(
    input: RecordRecommendationObservedActionInput,
  ): void {
    this.appendEvent({
      schemaVersion: SCHEMA_VERSION,
      eventId: randomUUID(),
      eventType: 'ACTION_OBSERVED',
      occurredAt: new Date().toISOString(),
      decisionId: input.decisionId,
      ...cloneOutcomeContext(input),
      observedActionKeys: [...input.observedActionKeys],
      observedInventoryStateKey: input.observedInventoryStateKey,
      observedAtGameTimeS: normalizeGameTime(input.observedAtGameTimeS),
      reconstructionConfidence: input.reconstructionConfidence,
    });
  }

  recordDecisionSuperseded(
    input: RecordRecommendationDecisionSupersededInput,
  ): void {
    this.appendEvent({
      schemaVersion: SCHEMA_VERSION,
      eventId: randomUUID(),
      eventType: 'DECISION_SUPERSEDED',
      occurredAt: new Date().toISOString(),
      decisionId: input.decisionId,
      matchId: input.matchId,
      steamId: input.steamId,
      traversalKey: input.traversalKey,
      reason: input.reason,
    });
  }

  recordModelError(input: RecordRecommendationModelErrorInput): void {
    this.appendEvent({
      schemaVersion: SCHEMA_VERSION,
      eventId: randomUUID(),
      eventType: 'MODEL_ERROR',
      occurredAt: new Date().toISOString(),
      ...cloneDecisionContext(input.context),
      error: getErrorMessage(input.error),
      elapsedMs: normalizeElapsedMs(input.elapsedMs),
    });
  }

  recordMatchOutcome(
    input: RecordRecommendationMatchOutcomeInput,
  ): boolean {
    const outcomeKey = createOutcomeKey(input);
    if (this.resolvedOutcomeKeys.has(outcomeKey)) {
      return false;
    }
    this.appendEvent({
      schemaVersion: SCHEMA_VERSION,
      eventId: randomUUID(),
      eventType: 'MATCH_OUTCOME',
      occurredAt: new Date().toISOString(),
      ...cloneOutcomeContext(input),
      playerWon: input.playerWon,
      source: input.source,
    });
    return true;
  }

  async waitForIdle(): Promise<void> {
    await this.writeQueue;
    if (this.lastWriteError) {
      throw new Error(
        `Recommendation telemetry write failed: ${this.lastWriteError}`,
      );
    }
  }

  private appendEvent(event: RecommendationDecisionTelemetryEvent): void {
    this.applyEvent(event);
    const serialized = `${JSON.stringify(event)}\n`;
    this.writeQueue = this.writeQueue
      .then(async () => {
        await mkdir(this.outputDirectory, { recursive: true });
        await appendFile(this.eventLogPath, serialized, 'utf8');
      })
      .catch((error: unknown) => {
        const message = getErrorMessage(error);
        this.writeErrorCount += 1;
        this.lastWriteErrorAt = new Date().toISOString();
        this.lastWriteError = message;
        this.logger.error(
          `Recommendation telemetry append failed: ${message}`,
        );
      });
  }

  private applyEvent(event: RecommendationDecisionTelemetryEvent): void {
    this.eventCount += 1;
    this.counts[event.eventType] += 1;
    this.lastEventAt = event.occurredAt;

    if (event.eventType === 'MATCH_OUTCOME') {
      const key = createOutcomeKey(event);
      this.resolvedOutcomeKeys.add(key);
      this.pendingOutcomeContexts.delete(key);
      return;
    }

    if (event.eventType === 'DECISION_SERVED') {
      const key = createOutcomeKey(event);
      if (!this.resolvedOutcomeKeys.has(key)) {
        this.pendingOutcomeContexts.set(
          key,
          cloneOutcomeContext(event),
        );
      }
    }
  }

  private async replayPersistedEvents(): Promise<void> {
    try {
      const lines = createInterface({
        input: createReadStream(this.eventLogPath, { encoding: 'utf8' }),
        crlfDelay: Infinity,
      });
      for await (const line of lines) {
        if (!line.trim()) {
          continue;
        }
        try {
          const event = JSON.parse(line) as unknown;
          if (isTelemetryEvent(event)) {
            this.applyEvent(event);
          }
        } catch (error) {
          this.logger.warn(
            `Ignored invalid recommendation telemetry line: ${getErrorMessage(error)}`,
          );
        }
      }
    } catch (error) {
      if (isErrorWithCode(error) && error.code === 'ENOENT') {
        return;
      }
      throw error;
    }
  }
}

function serializeCandidateAction(
  action: HeroBuildRecommendationAction,
): RecommendationTelemetryCandidateAction {
  return {
    actionKey: action.actionKey,
    actionType: action.type,
    sourceActionType: action.sourceActionType,
    itemId: action.itemId,
    score: finiteOrZero(action.score),
    confidence: finiteOrZero(action.confidence),
    historicalCount: Number.isSafeInteger(action.historicalCount)
      ? action.historicalCount
      : 0,
    historicalProbability: finiteOrZero(action.historicalProbability),
    predictedStateKey: action.predictedStateKey,
    matchupSignals: (action.matchupSignals ?? []).map((signal) => ({
      heroId: signal.heroId,
      direction: signal.direction,
      scoreContribution: finiteOrZero(signal.scoreContribution),
      contextualPurchaseLiftPercent: finiteOrZero(
        signal.contextualPurchaseLiftPercent,
      ),
      observationCount: Number.isSafeInteger(signal.observationCount)
        ? signal.observationCount
        : 0,
    })),
  };
}

function cloneDecisionContext(
  context: RecommendationDecisionTelemetryContext,
): RecommendationDecisionTelemetryContext {
  return {
    matchId: context.matchId,
    steamId: context.steamId,
    heroId: context.heroId,
    teamId: context.teamId,
    itemIds: [...context.itemIds],
    alliedHeroIds: [...context.alliedHeroIds],
    enemyHeroIds: [...context.enemyHeroIds],
    previousActionKeys: [...context.previousActionKeys],
    inventoryStateKey: context.inventoryStateKey,
    gameTimeS: normalizeGameTime(context.gameTimeS),
    timeBucket: Number.isSafeInteger(context.timeBucket)
      ? Math.max(0, context.timeBucket)
      : 0,
    traversalKey: context.traversalKey,
  };
}

function cloneOutcomeContext(
  context: RecommendationOutcomeContext,
): RecommendationOutcomeContext {
  return {
    matchId: context.matchId,
    steamId: context.steamId,
    heroId: context.heroId,
    teamId: context.teamId,
  };
}

function createOutcomeKey(context: RecommendationOutcomeContext): string {
  return `${context.matchId}:${context.steamId}:${context.heroId}`;
}

function isTelemetryEvent(
  value: unknown,
): value is RecommendationDecisionTelemetryEvent {
  if (!isRecord(value)) {
    return false;
  }
  return (
    value.schemaVersion === SCHEMA_VERSION &&
    typeof value.eventId === 'string' &&
    typeof value.occurredAt === 'string' &&
    [
      'DECISION_SERVED',
      'DECISION_SUPERSEDED',
      'ACTION_OBSERVED',
      'MODEL_ERROR',
      'MATCH_OUTCOME',
    ].includes(String(value.eventType))
  );
}

function normalizeGameTime(value: number): number {
  return Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : 0;
}

function normalizeElapsedMs(value: number): number {
  return Number.isFinite(value)
    ? Math.max(0, Math.round(value))
    : 0;
}

function finiteOrZero(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isErrorWithCode(
  value: unknown,
): value is Error & { code: string } {
  return value instanceof Error && 'code' in value;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
