import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import {
  RecommendationActionObservedEvent,
  RecommendationActionReconstructionConfidence,
  RecommendationDecisionServedEvent,
  RecommendationDecisionSupersededEvent,
  RecommendationDecisionSupersedeReason,
  RecommendationDecisionTelemetryEvent,
  RecommendationMatchOutcomeEvent,
  RecommendationOutcomeSource,
  RecommendationTelemetryCandidateAction,
  RecommendationDecisionTelemetryService,
} from './recommendation-decision-telemetry.service';

export const RECOMMENDATION_DECISION_DATASET_V4_SCHEMA_VERSION = 1;
export const RECOMMENDATION_DECISION_DATASET_V4_VERSION =
  'RECOMMENDATION_DECISION_DATASET_V4_1' as const;

const SOURCE_TELEMETRY_SCHEMA_VERSION = 1;
const DEFAULT_OUTPUT_DIRECTORY =
  '/app/apps/api/storage/recommendation-decision-dataset-v4';
const OUTPUT_DIRECTORY_ENV =
  'DEADLOCK_RECOMMENDATION_DECISION_DATASET_V4_DIR';
const DATASET_FILE_NAME = 'dataset.ndjson';
const MANIFEST_FILE_NAME = 'manifest.json';
const AUDIT_FILE_NAME = 'audit.json';

export type RecommendationDecisionDatasetV4RunState =
  | 'IDLE'
  | 'RUNNING'
  | 'COMPLETE'
  | 'FAILED';

export type RecommendationDecisionDatasetV4ExclusionReason =
  | 'DUPLICATE_DECISION'
  | 'SUPERSEDED_DECISION'
  | 'MISSING_OBSERVED_ACTION'
  | 'DUPLICATE_OBSERVED_ACTION'
  | 'MULTI_ACTION_INTERVAL'
  | 'AMBIGUOUS_ACTION_INTERVAL'
  | 'UNRESOLVED_ACTION'
  | 'INVALID_EXACT_ACTION_LABEL'
  | 'MISSING_MATCH_OUTCOME'
  | 'CONFLICTING_MATCH_OUTCOME';

export interface RecommendationDecisionDatasetV4ObservedLabel {
  observedActionKeys: string[];
  reconstructionConfidence?: RecommendationActionReconstructionConfidence;
  exactActionKey?: string;
  observedInventoryStateKey?: string;
  observedAtGameTimeS?: number;
  observationDelayS?: number;
}

export interface RecommendationDecisionDatasetV4Lifecycle {
  superseded: boolean;
  supersedeReasons: RecommendationDecisionSupersedeReason[];
  duplicateDecisionCount: number;
  observedEventCount: number;
}

export interface RecommendationDecisionDatasetV4OutcomeLabel {
  available: boolean;
  conflicting: boolean;
  playerWon?: boolean;
  source?: RecommendationOutcomeSource;
}

export interface RecommendationDecisionDatasetV4TrainingEligibility {
  exactAction: boolean;
  outcome: boolean;
  actionExclusionReasons: RecommendationDecisionDatasetV4ExclusionReason[];
  outcomeExclusionReasons: RecommendationDecisionDatasetV4ExclusionReason[];
}

export interface RecommendationDecisionDatasetV4Row {
  schemaVersion: typeof RECOMMENDATION_DECISION_DATASET_V4_SCHEMA_VERSION;
  datasetVersion: typeof RECOMMENDATION_DECISION_DATASET_V4_VERSION;
  decisionId: string;
  decisionOccurredAt: string;
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
  recommendationModel: string;
  modelVersion?: string;
  modelSha256?: string;
  candidateSetPolicy?: string;
  candidateLimit?: number;
  buildArchetypeId?: string;
  servedActionKey: string;
  candidateActions: RecommendationTelemetryCandidateAction[];
  elapsedMs: number;
  observedLabel: RecommendationDecisionDatasetV4ObservedLabel;
  lifecycle: RecommendationDecisionDatasetV4Lifecycle;
  outcomeLabel: RecommendationDecisionDatasetV4OutcomeLabel;
  trainingEligibility: RecommendationDecisionDatasetV4TrainingEligibility;
}

export interface RecommendationDecisionDatasetV4Audit {
  schemaVersion: typeof RECOMMENDATION_DECISION_DATASET_V4_SCHEMA_VERSION;
  datasetVersion: typeof RECOMMENDATION_DECISION_DATASET_V4_VERSION;
  generatedAt: string;
  passed: boolean;
  source: {
    eventCount: number;
    decisionEventCount: number;
    observedActionEventCount: number;
    supersededEventCount: number;
    matchOutcomeEventCount: number;
    modelErrorEventCount: number;
    invalidLineCount: number;
    duplicateEventIdCount: number;
  };
  integrity: {
    duplicateDecisionIdCount: number;
    orphanObservedActionCount: number;
    orphanSupersededDecisionCount: number;
    conflictingOutcomeKeyCount: number;
  };
  rows: {
    rowCount: number;
    exactSingleActionCount: number;
    multiActionIntervalCount: number;
    ambiguousActionIntervalCount: number;
    unresolvedActionCount: number;
    missingObservedActionCount: number;
    supersededDecisionCount: number;
    rowsWithOutcomeCount: number;
    exactActionEligibleCount: number;
    outcomeEligibleCount: number;
  };
  exclusionReasonCounts: Record<string, number>;
  warnings: string[];
}

export interface RecommendationDecisionDatasetV4Manifest {
  schemaVersion: typeof RECOMMENDATION_DECISION_DATASET_V4_SCHEMA_VERSION;
  datasetVersion: typeof RECOMMENDATION_DECISION_DATASET_V4_VERSION;
  generatedAt: string;
  source: {
    telemetrySchemaVersion: number;
    eventLogPath: string;
    byteLength: number;
    sha256: string;
    eventCount: number;
  };
  artifact: {
    format: 'NDJSON';
    fileName: typeof DATASET_FILE_NAME;
    byteLength: number;
    sha256: string;
    rowCount: number;
  };
  featureContract: {
    featureCutoff: 'DECISION_SERVED_TIME';
    featureFields: string[];
    labelFields: string[];
    exactActionEligibility: string;
    outcomeEligibility: string;
  };
  auditPassed: boolean;
  warnings: string[];
}

export interface RecommendationDecisionDatasetV4Status {
  state: RecommendationDecisionDatasetV4RunState;
  outputDirectory: string;
  sourceEventLogPath: string;
  datasetPath: string;
  rowCount: number;
  exactActionEligibleCount: number;
  outcomeEligibleCount: number;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  datasetAvailable: boolean;
  manifestAvailable: boolean;
  auditAvailable: boolean;
}

export interface RecommendationDecisionDatasetV4BuildResult {
  rows: RecommendationDecisionDatasetV4Row[];
  audit: RecommendationDecisionDatasetV4Audit;
}

interface DecisionAccumulator {
  decision?: RecommendationDecisionServedEvent;
  duplicateDecisionCount: number;
  observedEvents: RecommendationActionObservedEvent[];
  supersededEvents: RecommendationDecisionSupersededEvent[];
}

interface OutcomeResolution {
  available: boolean;
  conflicting: boolean;
  playerWon?: boolean;
  source?: RecommendationOutcomeSource;
}

interface SourceCounters {
  decisionEventCount: number;
  observedActionEventCount: number;
  supersededEventCount: number;
  matchOutcomeEventCount: number;
  modelErrorEventCount: number;
  duplicateEventIdCount: number;
}

export interface RecommendationDecisionDatasetV4BuildOptions {
  generatedAt?: string;
  invalidLineCount?: number;
}

@Injectable()
export class RecommendationDecisionDatasetV4Service implements OnModuleInit {
  private readonly logger = new Logger(
    RecommendationDecisionDatasetV4Service.name,
  );
  private readonly outputDirectory =
    process.env[OUTPUT_DIRECTORY_ENV]?.trim() || DEFAULT_OUTPUT_DIRECTORY;
  private readonly datasetPath = join(this.outputDirectory, DATASET_FILE_NAME);
  private readonly partialDatasetPath = join(
    this.outputDirectory,
    `${DATASET_FILE_NAME}.partial`,
  );
  private readonly manifestPath = join(
    this.outputDirectory,
    MANIFEST_FILE_NAME,
  );
  private readonly auditPath = join(this.outputDirectory, AUDIT_FILE_NAME);
  private status: RecommendationDecisionDatasetV4Status;
  private manifest?: RecommendationDecisionDatasetV4Manifest;
  private audit?: RecommendationDecisionDatasetV4Audit;
  private buildPromise: Promise<void> = Promise.resolve();

  constructor(
    private readonly telemetryService: RecommendationDecisionTelemetryService,
  ) {
    this.status = this.createIdleStatus();
  }

  async onModuleInit(): Promise<void> {
    await mkdir(this.outputDirectory, { recursive: true });
    this.manifest = await readJsonFile<RecommendationDecisionDatasetV4Manifest>(
      this.manifestPath,
    );
    this.audit = await readJsonFile<RecommendationDecisionDatasetV4Audit>(
      this.auditPath,
    );
    if (this.manifest && this.audit) {
      this.status = {
        ...this.createIdleStatus(),
        state: 'COMPLETE',
        rowCount: this.manifest.artifact.rowCount,
        exactActionEligibleCount: this.audit.rows.exactActionEligibleCount,
        outcomeEligibleCount: this.audit.rows.outcomeEligibleCount,
        completedAt: this.manifest.generatedAt,
        datasetAvailable: true,
        manifestAvailable: true,
        auditAvailable: true,
      };
    }
  }

  start(): RecommendationDecisionDatasetV4Status {
    if (this.status.state === 'RUNNING') {
      throw new Error('Recommendation decision dataset V4 build is already running.');
    }
    const startedAt = new Date().toISOString();
    this.status = {
      ...this.createIdleStatus(),
      state: 'RUNNING',
      startedAt,
    };
    this.buildPromise = this.runBuild(startedAt);
    return this.getStatus();
  }

  getStatus(): RecommendationDecisionDatasetV4Status {
    return { ...this.status };
  }

  getManifest(): RecommendationDecisionDatasetV4Manifest | undefined {
    return this.manifest ? cloneJson(this.manifest) : undefined;
  }

  getAudit(): RecommendationDecisionDatasetV4Audit | undefined {
    return this.audit ? cloneJson(this.audit) : undefined;
  }

  async waitForIdle(): Promise<void> {
    await this.buildPromise;
  }

  private async runBuild(startedAt: string): Promise<void> {
    try {
      await this.telemetryService.waitForIdle();
      const sourceEventLogPath =
        this.telemetryService.getStatus().eventLogPath;
      const loaded = await loadTelemetryEvents(sourceEventLogPath);
      const generatedAt = new Date().toISOString();
      const buildResult = buildRecommendationDecisionDatasetV4(
        loaded.events,
        {
          generatedAt,
          invalidLineCount: loaded.invalidLineCount,
        },
      );
      const datasetContent = serializeRows(buildResult.rows);
      await mkdir(this.outputDirectory, { recursive: true });
      await writeFile(this.partialDatasetPath, datasetContent, 'utf8');
      const sourceStat = await stat(sourceEventLogPath);
      const manifest = await buildManifest({
        generatedAt,
        sourceEventLogPath,
        sourceByteLength: sourceStat.size,
        sourceSha256: await sha256File(sourceEventLogPath),
        datasetContent,
        rowCount: buildResult.rows.length,
        audit: buildResult.audit,
      });
      await Promise.all([
        writeJsonAtomically(this.auditPath, buildResult.audit),
        writeJsonAtomically(this.manifestPath, manifest),
      ]);
      await rm(this.datasetPath, { force: true });
      await rename(this.partialDatasetPath, this.datasetPath);
      this.audit = buildResult.audit;
      this.manifest = manifest;
      this.status = {
        ...this.createIdleStatus(),
        state: 'COMPLETE',
        startedAt,
        completedAt: generatedAt,
        rowCount: buildResult.rows.length,
        exactActionEligibleCount:
          buildResult.audit.rows.exactActionEligibleCount,
        outcomeEligibleCount: buildResult.audit.rows.outcomeEligibleCount,
        datasetAvailable: true,
        manifestAvailable: true,
        auditAvailable: true,
      };
      this.logger.log(
        `Recommendation decision dataset V4 completed with ${buildResult.rows.length} rows, ` +
          `${buildResult.audit.rows.exactActionEligibleCount} exact-action eligible rows, and ` +
          `${buildResult.audit.rows.outcomeEligibleCount} outcome-eligible rows.`,
      );
    } catch (error) {
      await rm(this.partialDatasetPath, { force: true });
      const message = getErrorMessage(error);
      this.status = {
        ...this.status,
        state: 'FAILED',
        completedAt: new Date().toISOString(),
        error: message,
      };
      this.logger.error(
        `Recommendation decision dataset V4 build failed: ${message}`,
      );
    }
  }

  private createIdleStatus(): RecommendationDecisionDatasetV4Status {
    const telemetryStatus = this.telemetryService.getStatus();
    return {
      state: 'IDLE',
      outputDirectory: this.outputDirectory,
      sourceEventLogPath: telemetryStatus.eventLogPath,
      datasetPath: this.datasetPath,
      rowCount: 0,
      exactActionEligibleCount: 0,
      outcomeEligibleCount: 0,
      datasetAvailable: false,
      manifestAvailable: false,
      auditAvailable: false,
    };
  }
}

export function buildRecommendationDecisionDatasetV4(
  events: readonly RecommendationDecisionTelemetryEvent[],
  options: RecommendationDecisionDatasetV4BuildOptions = {},
): RecommendationDecisionDatasetV4BuildResult {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const invalidLineCount = normalizeNonNegativeInteger(
    options.invalidLineCount ?? 0,
  );
  const decisionAccumulators = new Map<string, DecisionAccumulator>();
  const outcomesByKey = new Map<string, RecommendationMatchOutcomeEvent[]>();
  const eventIds = new Set<string>();
  const counters: SourceCounters = {
    decisionEventCount: 0,
    observedActionEventCount: 0,
    supersededEventCount: 0,
    matchOutcomeEventCount: 0,
    modelErrorEventCount: 0,
    duplicateEventIdCount: 0,
  };

  for (const event of events) {
    if (eventIds.has(event.eventId)) {
      counters.duplicateEventIdCount += 1;
    } else {
      eventIds.add(event.eventId);
    }
    if (event.eventType === 'DECISION_SERVED') {
      counters.decisionEventCount += 1;
      const accumulator = getDecisionAccumulator(
        decisionAccumulators,
        event.decisionId,
      );
      if (accumulator.decision) {
        accumulator.duplicateDecisionCount += 1;
        if (compareOccurredAt(event, accumulator.decision) < 0) {
          accumulator.decision = event;
        }
      } else {
        accumulator.decision = event;
      }
      continue;
    }
    if (event.eventType === 'ACTION_OBSERVED') {
      counters.observedActionEventCount += 1;
      getDecisionAccumulator(
        decisionAccumulators,
        event.decisionId,
      ).observedEvents.push(event);
      continue;
    }
    if (event.eventType === 'DECISION_SUPERSEDED') {
      counters.supersededEventCount += 1;
      getDecisionAccumulator(
        decisionAccumulators,
        event.decisionId,
      ).supersededEvents.push(event);
      continue;
    }
    if (event.eventType === 'MATCH_OUTCOME') {
      counters.matchOutcomeEventCount += 1;
      const outcomeKey = createOutcomeKey(event);
      const outcomeEvents = outcomesByKey.get(outcomeKey) ?? [];
      outcomeEvents.push(event);
      outcomesByKey.set(outcomeKey, outcomeEvents);
      continue;
    }
    counters.modelErrorEventCount += 1;
  }

  const rows = [...decisionAccumulators.values()]
    .filter(
      (accumulator): accumulator is DecisionAccumulator & {
        decision: RecommendationDecisionServedEvent;
      } => accumulator.decision !== undefined,
    )
    .sort((left, right) => compareOccurredAt(left.decision, right.decision))
    .map((accumulator) =>
      createDatasetRow(
        accumulator,
        outcomesByKey.get(createOutcomeKey(accumulator.decision)) ?? [],
      ),
    );

  const duplicateDecisionIdCount = [...decisionAccumulators.values()].reduce(
    (sum, accumulator) => sum + accumulator.duplicateDecisionCount,
    0,
  );
  const orphanObservedActionCount = [...decisionAccumulators.values()]
    .filter((accumulator) => !accumulator.decision)
    .reduce((sum, accumulator) => sum + accumulator.observedEvents.length, 0);
  const orphanSupersededDecisionCount = [...decisionAccumulators.values()]
    .filter((accumulator) => !accumulator.decision)
    .reduce(
      (sum, accumulator) => sum + accumulator.supersededEvents.length,
      0,
    );
  const conflictingOutcomeKeyCount = [...outcomesByKey.values()].filter(
    (outcomeEvents) => resolveOutcome(outcomeEvents).conflicting,
  ).length;
  const exclusionReasonCounts: Record<string, number> = {};
  for (const row of rows) {
    for (const reason of new Set([
      ...row.trainingEligibility.actionExclusionReasons,
      ...row.trainingEligibility.outcomeExclusionReasons,
    ])) {
      incrementRecord(exclusionReasonCounts, reason);
    }
  }
  const warnings: string[] = [];
  if (invalidLineCount > 0) {
    warnings.push(
      `${invalidLineCount} invalid telemetry lines were ignored during materialization.`,
    );
  }
  if (orphanObservedActionCount > 0) {
    warnings.push(
      `${orphanObservedActionCount} observed-action events did not reference a persisted decision.`,
    );
  }
  if (orphanSupersededDecisionCount > 0) {
    warnings.push(
      `${orphanSupersededDecisionCount} supersede events did not reference a persisted decision.`,
    );
  }
  if (conflictingOutcomeKeyCount > 0) {
    warnings.push(
      `${conflictingOutcomeKeyCount} match-player outcome keys contain conflicting labels and were excluded from outcome training.`,
    );
  }

  const audit: RecommendationDecisionDatasetV4Audit = {
    schemaVersion: RECOMMENDATION_DECISION_DATASET_V4_SCHEMA_VERSION,
    datasetVersion: RECOMMENDATION_DECISION_DATASET_V4_VERSION,
    generatedAt,
    passed:
      rows.length > 0 &&
      invalidLineCount === 0 &&
      counters.duplicateEventIdCount === 0 &&
      duplicateDecisionIdCount === 0,
    source: {
      eventCount: events.length,
      decisionEventCount: counters.decisionEventCount,
      observedActionEventCount: counters.observedActionEventCount,
      supersededEventCount: counters.supersededEventCount,
      matchOutcomeEventCount: counters.matchOutcomeEventCount,
      modelErrorEventCount: counters.modelErrorEventCount,
      invalidLineCount,
      duplicateEventIdCount: counters.duplicateEventIdCount,
    },
    integrity: {
      duplicateDecisionIdCount,
      orphanObservedActionCount,
      orphanSupersededDecisionCount,
      conflictingOutcomeKeyCount,
    },
    rows: {
      rowCount: rows.length,
      exactSingleActionCount: countRows(
        rows,
        (row) =>
          row.observedLabel.reconstructionConfidence ===
          'EXACT_SINGLE_ACTION',
      ),
      multiActionIntervalCount: countRows(
        rows,
        (row) =>
          row.observedLabel.reconstructionConfidence ===
          'MULTI_ACTION_INTERVAL',
      ),
      ambiguousActionIntervalCount: countRows(
        rows,
        (row) =>
          row.observedLabel.reconstructionConfidence ===
          'AMBIGUOUS_MULTI_ACTION',
      ),
      unresolvedActionCount: countRows(
        rows,
        (row) =>
          row.observedLabel.reconstructionConfidence === 'UNRESOLVED',
      ),
      missingObservedActionCount: countRows(
        rows,
        (row) => row.lifecycle.observedEventCount === 0,
      ),
      supersededDecisionCount: countRows(
        rows,
        (row) => row.lifecycle.superseded,
      ),
      rowsWithOutcomeCount: countRows(
        rows,
        (row) => row.outcomeLabel.available,
      ),
      exactActionEligibleCount: countRows(
        rows,
        (row) => row.trainingEligibility.exactAction,
      ),
      outcomeEligibleCount: countRows(
        rows,
        (row) => row.trainingEligibility.outcome,
      ),
    },
    exclusionReasonCounts,
    warnings,
  };

  return { rows, audit };
}

function createDatasetRow(
  accumulator: DecisionAccumulator & {
    decision: RecommendationDecisionServedEvent;
  },
  outcomeEvents: readonly RecommendationMatchOutcomeEvent[],
): RecommendationDecisionDatasetV4Row {
  const decision = accumulator.decision;
  const observedEvents = [...accumulator.observedEvents].sort(compareOccurredAt);
  const supersededEvents = [...accumulator.supersededEvents].sort(
    compareOccurredAt,
  );
  const observed = observedEvents[0];
  const outcome = resolveOutcome(outcomeEvents);
  const actionExclusionReasons = resolveActionExclusionReasons(
    accumulator,
    observed,
  );
  const outcomeOnlyExclusionReasons: RecommendationDecisionDatasetV4ExclusionReason[] = [];
  if (!outcome.available) {
    outcomeOnlyExclusionReasons.push('MISSING_MATCH_OUTCOME');
  }
  if (outcome.conflicting) {
    outcomeOnlyExclusionReasons.push('CONFLICTING_MATCH_OUTCOME');
  }
  const outcomeExclusionReasons = uniqueReasons([
    ...actionExclusionReasons,
    ...outcomeOnlyExclusionReasons,
  ]);
  const exactActionKey =
    observed?.reconstructionConfidence === 'EXACT_SINGLE_ACTION' &&
    observed.observedActionKeys.length === 1 &&
    observed.observedActionKeys[0].trim().length > 0
      ? observed.observedActionKeys[0]
      : undefined;

  return {
    schemaVersion: RECOMMENDATION_DECISION_DATASET_V4_SCHEMA_VERSION,
    datasetVersion: RECOMMENDATION_DECISION_DATASET_V4_VERSION,
    decisionId: decision.decisionId,
    decisionOccurredAt: decision.occurredAt,
    matchId: decision.matchId,
    steamId: decision.steamId,
    heroId: decision.heroId,
    teamId: decision.teamId,
    itemIds: [...decision.itemIds],
    alliedHeroIds: [...decision.alliedHeroIds],
    enemyHeroIds: [...decision.enemyHeroIds],
    previousActionKeys: [...decision.previousActionKeys],
    inventoryStateKey: decision.inventoryStateKey,
    gameTimeS: decision.gameTimeS,
    timeBucket: decision.timeBucket,
    traversalKey: decision.traversalKey,
    recommendationModel: decision.recommendationModel,
    modelVersion: decision.modelVersion,
    modelSha256: decision.modelSha256,
    candidateSetPolicy: decision.candidateSetPolicy,
    candidateLimit: decision.candidateLimit,
    buildArchetypeId: decision.buildArchetypeId,
    servedActionKey: decision.servedActionKey,
    candidateActions: decision.candidateActions.map(cloneCandidateAction),
    elapsedMs: decision.elapsedMs,
    observedLabel: {
      observedActionKeys: observed ? [...observed.observedActionKeys] : [],
      reconstructionConfidence: observed?.reconstructionConfidence,
      exactActionKey,
      observedInventoryStateKey: observed?.observedInventoryStateKey,
      observedAtGameTimeS: observed?.observedAtGameTimeS,
      observationDelayS: observed
        ? Math.max(0, observed.observedAtGameTimeS - decision.gameTimeS)
        : undefined,
    },
    lifecycle: {
      superseded: supersededEvents.length > 0,
      supersedeReasons: uniqueValues(
        supersededEvents.map((event) => event.reason),
      ),
      duplicateDecisionCount: accumulator.duplicateDecisionCount,
      observedEventCount: observedEvents.length,
    },
    outcomeLabel: {
      available: outcome.available,
      conflicting: outcome.conflicting,
      playerWon: outcome.playerWon,
      source: outcome.source,
    },
    trainingEligibility: {
      exactAction: actionExclusionReasons.length === 0,
      outcome: outcomeExclusionReasons.length === 0,
      actionExclusionReasons,
      outcomeExclusionReasons,
    },
  };
}

function resolveActionExclusionReasons(
  accumulator: DecisionAccumulator,
  observed: RecommendationActionObservedEvent | undefined,
): RecommendationDecisionDatasetV4ExclusionReason[] {
  const reasons: RecommendationDecisionDatasetV4ExclusionReason[] = [];
  if (accumulator.duplicateDecisionCount > 0) {
    reasons.push('DUPLICATE_DECISION');
  }
  if (accumulator.supersededEvents.length > 0) {
    reasons.push('SUPERSEDED_DECISION');
  }
  if (!observed) {
    reasons.push('MISSING_OBSERVED_ACTION');
    return reasons;
  }
  if (accumulator.observedEvents.length > 1) {
    reasons.push('DUPLICATE_OBSERVED_ACTION');
  }
  if (observed.reconstructionConfidence === 'MULTI_ACTION_INTERVAL') {
    reasons.push('MULTI_ACTION_INTERVAL');
  } else if (
    observed.reconstructionConfidence === 'AMBIGUOUS_MULTI_ACTION'
  ) {
    reasons.push('AMBIGUOUS_ACTION_INTERVAL');
  } else if (observed.reconstructionConfidence === 'UNRESOLVED') {
    reasons.push('UNRESOLVED_ACTION');
  } else if (
    observed.observedActionKeys.length !== 1 ||
    observed.observedActionKeys[0].trim().length === 0
  ) {
    reasons.push('INVALID_EXACT_ACTION_LABEL');
  }
  return uniqueReasons(reasons);
}

function resolveOutcome(
  outcomeEvents: readonly RecommendationMatchOutcomeEvent[],
): OutcomeResolution {
  if (outcomeEvents.length === 0) {
    return { available: false, conflicting: false };
  }
  const sorted = [...outcomeEvents].sort(compareOccurredAt);
  const playerWonValues = new Set(sorted.map((event) => event.playerWon));
  const conflicting = playerWonValues.size > 1;
  const selected = sorted[sorted.length - 1];
  return {
    available: !conflicting,
    conflicting,
    playerWon: conflicting ? undefined : selected.playerWon,
    source: conflicting ? undefined : selected.source,
  };
}

function getDecisionAccumulator(
  accumulators: Map<string, DecisionAccumulator>,
  decisionId: string,
): DecisionAccumulator {
  const existing = accumulators.get(decisionId);
  if (existing) {
    return existing;
  }
  const created: DecisionAccumulator = {
    duplicateDecisionCount: 0,
    observedEvents: [],
    supersededEvents: [],
  };
  accumulators.set(decisionId, created);
  return created;
}

async function loadTelemetryEvents(eventLogPath: string): Promise<{
  events: RecommendationDecisionTelemetryEvent[];
  invalidLineCount: number;
}> {
  const events: RecommendationDecisionTelemetryEvent[] = [];
  let invalidLineCount = 0;
  const lines = createInterface({
    input: createReadStream(eventLogPath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    if (!line.trim()) {
      continue;
    }
    try {
      const value = JSON.parse(line) as unknown;
      if (isTelemetryEvent(value)) {
        events.push(value);
      } else {
        invalidLineCount += 1;
      }
    } catch {
      invalidLineCount += 1;
    }
  }
  return { events, invalidLineCount };
}

function isTelemetryEvent(
  value: unknown,
): value is RecommendationDecisionTelemetryEvent {
  if (!isRecord(value)) {
    return false;
  }
  return (
    value.schemaVersion === SOURCE_TELEMETRY_SCHEMA_VERSION &&
    typeof value.eventId === 'string' &&
    value.eventId.length > 0 &&
    typeof value.occurredAt === 'string' &&
    value.occurredAt.length > 0 &&
    [
      'DECISION_SERVED',
      'DECISION_SUPERSEDED',
      'ACTION_OBSERVED',
      'MODEL_ERROR',
      'MATCH_OUTCOME',
    ].includes(String(value.eventType))
  );
}

async function buildManifest(input: {
  generatedAt: string;
  sourceEventLogPath: string;
  sourceByteLength: number;
  sourceSha256: string;
  datasetContent: string;
  rowCount: number;
  audit: RecommendationDecisionDatasetV4Audit;
}): Promise<RecommendationDecisionDatasetV4Manifest> {
  return {
    schemaVersion: RECOMMENDATION_DECISION_DATASET_V4_SCHEMA_VERSION,
    datasetVersion: RECOMMENDATION_DECISION_DATASET_V4_VERSION,
    generatedAt: input.generatedAt,
    source: {
      telemetrySchemaVersion: SOURCE_TELEMETRY_SCHEMA_VERSION,
      eventLogPath: input.sourceEventLogPath,
      byteLength: input.sourceByteLength,
      sha256: input.sourceSha256,
      eventCount: input.audit.source.eventCount,
    },
    artifact: {
      format: 'NDJSON',
      fileName: DATASET_FILE_NAME,
      byteLength: Buffer.byteLength(input.datasetContent),
      sha256: sha256String(input.datasetContent),
      rowCount: input.rowCount,
    },
    featureContract: {
      featureCutoff: 'DECISION_SERVED_TIME',
      featureFields: [
        'heroId',
        'teamId',
        'itemIds',
        'alliedHeroIds',
        'enemyHeroIds',
        'previousActionKeys',
        'inventoryStateKey',
        'gameTimeS',
        'timeBucket',
        'recommendationModel',
        'modelVersion',
        'candidateActions',
        'servedActionKey',
      ],
      labelFields: [
        'observedLabel.observedActionKeys',
        'observedLabel.reconstructionConfidence',
        'observedLabel.exactActionKey',
        'outcomeLabel.playerWon',
      ],
      exactActionEligibility:
        'One EXACT_SINGLE_ACTION observation, no duplicate decision, no duplicate observation, and no supersede event.',
      outcomeEligibility:
        'Exact-action eligible with one available non-conflicting match outcome.',
    },
    auditPassed: input.audit.passed,
    warnings: [...input.audit.warnings],
  };
}

function cloneCandidateAction(
  candidate: RecommendationTelemetryCandidateAction,
): RecommendationTelemetryCandidateAction {
  return {
    ...candidate,
    matchupSignals: candidate.matchupSignals.map((signal) => ({ ...signal })),
  };
}

function createOutcomeKey(input: {
  matchId: string;
  steamId: string;
  heroId: number;
}): string {
  return `${input.matchId}:${input.steamId}:${input.heroId}`;
}

function compareOccurredAt(
  left: { occurredAt: string; eventId: string },
  right: { occurredAt: string; eventId: string },
): number {
  return (
    left.occurredAt.localeCompare(right.occurredAt) ||
    left.eventId.localeCompare(right.eventId)
  );
}

function serializeRows(rows: readonly RecommendationDecisionDatasetV4Row[]): string {
  return rows.length > 0
    ? `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`
    : '';
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  const stream = createReadStream(path);
  for await (const chunk of stream) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

function sha256String(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function writeJsonAtomically(path: string, value: unknown): Promise<void> {
  const partialPath = `${path}.partial`;
  await writeFile(partialPath, `${JSON.stringify(value, undefined, 2)}\n`, 'utf8');
  await rm(path, { force: true });
  await rename(partialPath, path);
}

async function readJsonFile<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch (error) {
    if (isErrorWithCode(error) && error.code === 'ENOENT') {
      return undefined;
    }
    return undefined;
  }
}

function countRows(
  rows: readonly RecommendationDecisionDatasetV4Row[],
  predicate: (row: RecommendationDecisionDatasetV4Row) => boolean,
): number {
  return rows.reduce((count, row) => count + (predicate(row) ? 1 : 0), 0);
}

function incrementRecord(record: Record<string, number>, key: string): void {
  record[key] = (record[key] ?? 0) + 1;
}

function uniqueReasons(
  values: readonly RecommendationDecisionDatasetV4ExclusionReason[],
): RecommendationDecisionDatasetV4ExclusionReason[] {
  return [...new Set(values)];
}

function uniqueValues<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function normalizeNonNegativeInteger(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
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
