import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { parseInventoryStateKey } from './inventory-multiset-action-engine';
import {
  RECOMMENDATION_DECISION_DATASET_V4_SCHEMA_VERSION,
  RECOMMENDATION_DECISION_DATASET_V4_VERSION,
  type RecommendationDecisionDatasetV4Row,
} from './recommendation-decision-dataset-v4.service';
import type { RecommendationTelemetryCandidateAction } from './recommendation-decision-telemetry.service';

export const RECOMMENDATION_DECISION_DATASET_V4_HISTORICAL_BOOTSTRAP_VERSION =
  'RECOMMENDATION_DECISION_DATASET_V4_HISTORICAL_V3_VALIDATION_BOOTSTRAP_1' as const;

const DEFAULT_TRAINING_DIRECTORY =
  '/app/apps/api/storage/contextual-v3-training';
const DEFAULT_CANDIDATE_DIRECTORY =
  '/app/apps/api/storage/contextual-v3-candidate-evaluation-v2';
const DEFAULT_OUTPUT_DIRECTORY =
  '/app/apps/api/storage/recommendation-decision-dataset-v4-historical-bootstrap';
const TRAINING_DIRECTORY_ENV =
  'DEADLOCK_RECOMMENDATION_DECISION_DATASET_V4_BOOTSTRAP_TRAINING_DIR';
const CANDIDATE_DIRECTORY_ENV =
  'DEADLOCK_RECOMMENDATION_DECISION_DATASET_V4_BOOTSTRAP_CANDIDATE_DIR';
const OUTPUT_DIRECTORY_ENV =
  'DEADLOCK_RECOMMENDATION_DECISION_DATASET_V4_BOOTSTRAP_OUTPUT_DIR';
const LIVE_TIME_BUCKET_SECONDS = 120;
const BUFFER_LIMIT_BYTES = 1024 * 1024;

export interface RecommendationDecisionDatasetV4HistoricalBootstrapStartRequest {
  maxRows?: number;
  expectedValidationSha256?: string;
  expectedCandidateSha256?: string;
}

export interface RecommendationDecisionDatasetV4HistoricalBootstrapOptions {
  maxRows?: number;
  expectedValidationSha256?: string;
  expectedCandidateSha256?: string;
}

export interface RecommendationDecisionDatasetV4HistoricalBootstrapStatus {
  state: 'IDLE' | 'RUNNING' | 'COMPLETE' | 'FAILED';
  phase: 'PREPARING' | 'JOINING' | 'FINALIZING' | 'COMPLETE';
  sourceValidationRowCount: number;
  sourceCandidateRowCount: number;
  processedRowCount: number;
  rowCount: number;
  candidateCoveredRowCount: number;
  matchCount: number;
  outputDirectory: string;
  datasetPath: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  options?: RecommendationDecisionDatasetV4HistoricalBootstrapOptions;
  datasetAvailable: boolean;
  manifestAvailable: boolean;
  auditAvailable: boolean;
}

interface HistoricalValidationRow {
  schemaVersion: number;
  decisionId: string;
  matchId: number;
  matchStartTime: string;
  playerId: number;
  features: {
    heroId: number;
    team: number;
    gameTimeS: number;
    phase: string;
    inventoryBeforeStateKey: string;
    previousActionKeys: string[];
    buildPrefixKey: string;
    alliedHeroIds: number[];
    enemyHeroIds: number[];
    buildArchetypeId: string;
  };
  target: {
    actionType: 'BUY' | 'REBUY' | 'UPGRADE';
    itemId: number;
    actionKey: string;
  };
  outcomeLabel: {
    playerWon: boolean;
  };
}

interface HistoricalCandidateRow {
  schemaVersion: number;
  decisionId: string;
  candidateActionKeys: string[];
  actualActionKey: string;
  actualActionCovered: boolean;
  actualActionObservedInTrain: boolean;
  actualActionLegal: boolean;
  actualActionRankBeforeLimit: number;
}

interface SourceDescriptor {
  validationPath: string;
  validationSha256: string;
  validationRowCount: number;
  candidatePath: string;
  candidateSha256: string;
  candidateRowCount: number;
  candidatePolicy: string;
  candidateLimit: number;
  modelVersion: string;
  modelSha256: string;
  sourceDatasetVersion: string;
  sourceDatasetSha256: string;
  validationWindowStartTime?: string;
  validationWindowEndTime?: string;
}

interface HistoricalBootstrapRow extends RecommendationDecisionDatasetV4Row {
  datasetSourceKind: 'HISTORICAL_V3_HELD_OUT_VALIDATION_BOOTSTRAP';
}

interface ArtifactPaths {
  dataset: string;
  manifest: string;
  audit: string;
}

@Injectable()
export class RecommendationDecisionDatasetV4HistoricalBootstrapService
  implements OnModuleInit
{
  private readonly logger = new Logger(
    RecommendationDecisionDatasetV4HistoricalBootstrapService.name,
  );
  private readonly trainingDirectory =
    process.env[TRAINING_DIRECTORY_ENV]?.trim() || DEFAULT_TRAINING_DIRECTORY;
  private readonly candidateDirectory =
    process.env[CANDIDATE_DIRECTORY_ENV]?.trim() || DEFAULT_CANDIDATE_DIRECTORY;
  private readonly outputDirectory =
    process.env[OUTPUT_DIRECTORY_ENV]?.trim() || DEFAULT_OUTPUT_DIRECTORY;
  private readonly paths: ArtifactPaths = {
    dataset: join(this.outputDirectory, 'dataset.ndjson'),
    manifest: join(this.outputDirectory, 'manifest.json'),
    audit: join(this.outputDirectory, 'audit.json'),
  };

  private status = this.createIdleStatus();
  private manifest?: Record<string, unknown>;
  private audit?: Record<string, unknown>;
  private runPromise: Promise<void> = Promise.resolve();

  async onModuleInit(): Promise<void> {
    await mkdir(this.outputDirectory, { recursive: true });
    this.manifest = await readJson(this.paths.manifest);
    this.audit = await readJson(this.paths.audit);
    if (this.manifest && this.audit) {
      const artifact = asRecord(this.manifest.artifact);
      const source = asRecord(this.audit.source);
      const candidates = asRecord(this.audit.candidates);
      this.status = {
        ...this.createIdleStatus(),
        state: 'COMPLETE',
        phase: 'COMPLETE',
        sourceValidationRowCount: toNumber(source.validationRowCount),
        sourceCandidateRowCount: toNumber(source.candidateRowCount),
        processedRowCount: toNumber(artifact.rowCount),
        rowCount: toNumber(artifact.rowCount),
        candidateCoveredRowCount: toNumber(candidates.coveredRowCount),
        matchCount: toNumber(source.matchCount),
        completedAt: String(this.manifest.generatedAt ?? ''),
        datasetAvailable: true,
        manifestAvailable: true,
        auditAvailable: true,
      };
    }
  }

  async start(
    request: RecommendationDecisionDatasetV4HistoricalBootstrapStartRequest = {},
  ): Promise<RecommendationDecisionDatasetV4HistoricalBootstrapStatus> {
    if (this.status.state === 'RUNNING') {
      throw new Error('Recommendation V4 historical bootstrap is already running.');
    }
    const options = normalizeOptions(request);
    this.status = {
      ...this.createIdleStatus(),
      state: 'RUNNING',
      startedAt: new Date().toISOString(),
      options,
      datasetAvailable: this.manifest !== undefined,
      manifestAvailable: this.manifest !== undefined,
      auditAvailable: this.audit !== undefined,
    };
    this.runPromise = this.run(options);
    return this.getStatus();
  }

  async waitForIdle(): Promise<void> {
    await this.runPromise;
  }

  getStatus(): RecommendationDecisionDatasetV4HistoricalBootstrapStatus {
    return cloneJson(this.status);
  }

  getManifest(): Record<string, unknown> | undefined {
    return this.manifest ? cloneJson(this.manifest) : undefined;
  }

  getAudit(): Record<string, unknown> | undefined {
    return this.audit ? cloneJson(this.audit) : undefined;
  }

  private async run(
    options: RecommendationDecisionDatasetV4HistoricalBootstrapOptions,
  ): Promise<void> {
    try {
      const source = await this.loadAndValidateSource(options);
      await mkdir(this.outputDirectory, { recursive: true });
      await this.clearOutputs();
      this.manifest = undefined;
      this.audit = undefined;
      this.status = {
        ...this.status,
        phase: 'JOINING',
        sourceValidationRowCount: source.validationRowCount,
        sourceCandidateRowCount: source.candidateRowCount,
        processedRowCount: 0,
        rowCount: 0,
        candidateCoveredRowCount: 0,
        matchCount: 0,
        datasetAvailable: false,
        manifestAvailable: false,
        auditAvailable: false,
      };

      const writer = await LineWriter.create(`${this.paths.dataset}.partial`);
      const decisionIds = new Set<string>();
      const matchIds = new Set<string>();
      let processedRowCount = 0;
      let rowCount = 0;
      let candidateCoveredRowCount = 0;
      let emptyCandidateRowCount = 0;
      let duplicateDecisionIdCount = 0;
      let duplicateCandidateActionKeyCount = 0;
      let lockstepMismatchCount = 0;
      try {
        const validationIterator = createJsonLineIterator<HistoricalValidationRow>(
          source.validationPath,
          parseValidationRow,
        );
        const candidateIterator = createJsonLineIterator<HistoricalCandidateRow>(
          source.candidatePath,
          parseCandidateRow,
        );
        while (true) {
          if (options.maxRows !== undefined && rowCount >= options.maxRows) {
            break;
          }
          const [validationResult, candidateResult] = await Promise.all([
            validationIterator.next(),
            candidateIterator.next(),
          ]);
          if (validationResult.done || candidateResult.done) {
            if (validationResult.done !== candidateResult.done) {
              lockstepMismatchCount += 1;
            }
            break;
          }
          processedRowCount += 1;
          const validation = validationResult.value;
          const candidate = candidateResult.value;
          if (validation.decisionId !== candidate.decisionId) {
            lockstepMismatchCount += 1;
            throw new Error(
              `Historical source decision mismatch at row ${processedRowCount}: ` +
                `${validation.decisionId} versus ${candidate.decisionId}.`,
            );
          }
          if (validation.target.actionKey !== candidate.actualActionKey) {
            throw new Error(
              `Historical source target mismatch for decision ${validation.decisionId}.`,
            );
          }
          if (decisionIds.has(validation.decisionId)) {
            duplicateDecisionIdCount += 1;
          } else {
            decisionIds.add(validation.decisionId);
          }
          const uniqueCandidates = uniqueActionKeys(candidate.candidateActionKeys);
          duplicateCandidateActionKeyCount +=
            candidate.candidateActionKeys.length - uniqueCandidates.length;
          emptyCandidateRowCount += uniqueCandidates.length === 0 ? 1 : 0;
          candidateCoveredRowCount += candidate.actualActionCovered ? 1 : 0;
          const row = createBootstrapRow(
            validation,
            uniqueCandidates,
            source,
          );
          matchIds.add(row.matchId);
          await writer.write(row);
          rowCount += 1;
          if (processedRowCount % 1_000 === 0) {
            this.status = {
              ...this.status,
              processedRowCount,
              rowCount,
              candidateCoveredRowCount,
              matchCount: matchIds.size,
            };
          }
          if (processedRowCount % 10_000 === 0) {
            await yieldToEventLoop();
          }
        }
      } finally {
        await writer.close();
      }
      if (lockstepMismatchCount > 0) {
        throw new Error('Historical validation and candidate artifacts are not lockstep aligned.');
      }
      if (options.maxRows === undefined && rowCount !== source.validationRowCount) {
        throw new Error(
          `Historical bootstrap produced ${rowCount} rows from ` +
            `${source.validationRowCount} validation rows.`,
        );
      }
      if (rowCount <= 0) {
        throw new Error('Historical bootstrap produced no Recommendation V4 rows.');
      }
      await promote(this.paths.dataset);

      this.status = {
        ...this.status,
        phase: 'FINALIZING',
        processedRowCount,
        rowCount,
        candidateCoveredRowCount,
        matchCount: matchIds.size,
      };
      const generatedAt = new Date().toISOString();
      const datasetMetadata = await stat(this.paths.dataset);
      const datasetSha256 = await hashFile(this.paths.dataset);
      const warnings = [
        'Rows were generated from held-out Contextual V3 validation and are not live production decisions.',
        'Candidate metadata contains action keys and deterministic rank placeholders only; candidate scores and predicted states were not available in the source artifact.',
      ];
      if (emptyCandidateRowCount > 0) {
        warnings.push(`${emptyCandidateRowCount} rows contain an empty candidate set.`);
      }
      if (candidateCoveredRowCount < rowCount) {
        warnings.push(
          `${rowCount - candidateCoveredRowCount} observed actions were outside the recorded candidate shortlist.`,
        );
      }
      const audit = {
        schemaVersion: RECOMMENDATION_DECISION_DATASET_V4_SCHEMA_VERSION,
        datasetVersion: RECOMMENDATION_DECISION_DATASET_V4_VERSION,
        bootstrapVersion:
          RECOMMENDATION_DECISION_DATASET_V4_HISTORICAL_BOOTSTRAP_VERSION,
        generatedAt,
        passed:
          duplicateDecisionIdCount === 0 &&
          lockstepMismatchCount === 0 &&
          rowCount > 0 &&
          matchIds.size > 1,
        source: {
          sourceKind: 'HISTORICAL_V3_HELD_OUT_VALIDATION_BOOTSTRAP',
          validationRowCount: source.validationRowCount,
          candidateRowCount: source.candidateRowCount,
          processedRowCount,
          matchCount: matchIds.size,
          validationSha256: source.validationSha256,
          candidateSha256: source.candidateSha256,
          modelVersion: source.modelVersion,
          modelSha256: source.modelSha256,
        },
        integrity: {
          duplicateDecisionIdCount,
          lockstepMismatchCount,
          duplicateCandidateActionKeyCount,
        },
        rows: {
          rowCount,
          exactSingleActionCount: rowCount,
          multiActionIntervalCount: 0,
          ambiguousActionIntervalCount: 0,
          unresolvedActionCount: 0,
          missingObservedActionCount: 0,
          supersededDecisionCount: 0,
          rowsWithOutcomeCount: rowCount,
          exactActionEligibleCount: rowCount,
          outcomeEligibleCount: rowCount,
        },
        candidates: {
          candidatePolicy: source.candidatePolicy,
          candidateLimit: source.candidateLimit,
          coveredRowCount: candidateCoveredRowCount,
          coverageRate: divide(candidateCoveredRowCount, rowCount),
          uncoveredRowCount: rowCount - candidateCoveredRowCount,
          emptyCandidateRowCount,
          metadataAvailability: 'ACTION_KEYS_AND_RANK_ONLY',
        },
        leakage: {
          sourceSplit: 'HELD_OUT_CONTEXTUAL_V3_VALIDATION',
          sourceModelTrainingRowsUsedAsBootstrapRows: false,
          targetUsedForCandidateConstruction: false,
          targetUsedForCoverageDiagnosticsOnly: true,
          outcomeUsedForCandidateConstruction: false,
        },
        exclusionReasonCounts: {},
        warnings,
      };
      const manifest = {
        schemaVersion: RECOMMENDATION_DECISION_DATASET_V4_SCHEMA_VERSION,
        datasetVersion: RECOMMENDATION_DECISION_DATASET_V4_VERSION,
        bootstrapVersion:
          RECOMMENDATION_DECISION_DATASET_V4_HISTORICAL_BOOTSTRAP_VERSION,
        generatedAt,
        source: {
          kind: 'HISTORICAL_V3_HELD_OUT_VALIDATION_BOOTSTRAP',
          trainingDirectory: this.trainingDirectory,
          candidateDirectory: this.candidateDirectory,
          sourceDatasetVersion: source.sourceDatasetVersion,
          sourceDatasetSha256: source.sourceDatasetSha256,
          validation: {
            fileName: source.validationPath.split('/').pop(),
            sha256: source.validationSha256,
            rowCount: source.validationRowCount,
            windowStartTime: source.validationWindowStartTime,
            windowEndTime: source.validationWindowEndTime,
          },
          candidates: {
            fileName: source.candidatePath.split('/').pop(),
            sha256: source.candidateSha256,
            rowCount: source.candidateRowCount,
            policy: source.candidatePolicy,
            limit: source.candidateLimit,
          },
          modelVersion: source.modelVersion,
          modelSha256: source.modelSha256,
        },
        options,
        artifact: {
          format: 'NDJSON',
          fileName: 'dataset.ndjson',
          byteLength: datasetMetadata.size,
          sha256: datasetSha256,
          rowCount,
        },
        featureContract: {
          featureCutoff: 'HISTORICAL_DECISION_TIME',
          featureFields: [
            'heroId',
            'teamId',
            'gameTimeS',
            'timeBucket',
            'inventoryStateKey',
            'previousActionKeys',
            'alliedHeroIds',
            'enemyHeroIds',
            'buildArchetypeId',
            'candidateActions',
          ],
          labelFields: ['observedLabel.exactActionKey', 'outcomeLabel.playerWon'],
          exactActionEligibility:
            'Every bootstrap row is an exact held-out observed action.',
          outcomeEligibility:
            'Every bootstrap row has a non-conflicting historical match outcome.',
          candidateMetadataAvailability: 'ACTION_KEYS_AND_RANK_ONLY',
        },
        auditPassed: audit.passed,
        warnings,
      };
      await Promise.all([
        atomicJson(this.paths.audit, audit),
        atomicJson(this.paths.manifest, manifest),
      ]);
      this.audit = audit;
      this.manifest = manifest;
      this.status = {
        ...this.status,
        state: 'COMPLETE',
        phase: 'COMPLETE',
        completedAt: generatedAt,
        processedRowCount,
        rowCount,
        candidateCoveredRowCount,
        matchCount: matchIds.size,
        datasetAvailable: true,
        manifestAvailable: true,
        auditAvailable: true,
        error: undefined,
      };
      this.logger.log(
        `Recommendation V4 historical bootstrap completed: ${rowCount} rows, ` +
          `${matchIds.size} matches, coverage ${divide(candidateCoveredRowCount, rowCount)}.`,
      );
    } catch (error) {
      const message = getErrorMessage(error);
      this.status = {
        ...this.status,
        state: 'FAILED',
        completedAt: new Date().toISOString(),
        error: message,
      };
      this.logger.error(`Recommendation V4 historical bootstrap failed: ${message}`);
    }
  }

  private async loadAndValidateSource(
    options: RecommendationDecisionDatasetV4HistoricalBootstrapOptions,
  ): Promise<SourceDescriptor> {
    const trainingManifest = await requiredJson<Record<string, unknown>>(
      join(this.trainingDirectory, 'manifest.json'),
    );
    const trainingAudit = await requiredJson<Record<string, unknown>>(
      join(this.trainingDirectory, 'audit.json'),
    );
    const candidateManifest = await requiredJson<Record<string, unknown>>(
      join(this.candidateDirectory, 'manifest.json'),
    );
    const candidateAudit = await requiredJson<Record<string, unknown>>(
      join(this.candidateDirectory, 'audit.json'),
    );
    if (!trainingAudit.passed) {
      throw new Error('Contextual V3 training source did not pass audit.');
    }
    if (!candidateManifest.evaluationReleaseGatePassed || !candidateAudit.passed) {
      throw new Error('Contextual V3 candidate source did not pass its release gate and audit.');
    }
    const trainingArtifacts = asRecord(trainingManifest.artifacts);
    const validationArtifact = asRecord(trainingArtifacts.validation);
    const candidateArtifacts = asRecord(candidateManifest.artifacts);
    const candidateArtifact = asRecord(candidateArtifacts.candidates);
    const validationFileName = requireString(
      validationArtifact.fileName,
      'training artifacts.validation.fileName',
    );
    const candidateFileName = requireString(
      candidateArtifact.fileName,
      'candidate artifacts.candidates.fileName',
    );
    const validationPath = join(this.trainingDirectory, validationFileName);
    const candidatePath = join(this.candidateDirectory, candidateFileName);
    const [validationSha256, candidateSha256] = await Promise.all([
      hashFile(validationPath),
      hashFile(candidatePath),
    ]);
    assertHash(
      validationSha256,
      requireString(validationArtifact.sha256, 'validation SHA-256'),
      'Contextual V3 validation artifact',
    );
    assertHash(
      candidateSha256,
      requireString(candidateArtifact.sha256, 'candidate SHA-256'),
      'Contextual V3 candidate artifact',
    );
    const candidateSource = asRecord(candidateManifest.source);
    assertHash(
      validationSha256,
      requireString(candidateSource.validationSha256, 'candidate source validation SHA-256'),
      'Candidate source validation artifact',
    );
    assertOptionalHash(
      options.expectedValidationSha256,
      validationSha256,
      'validation',
    );
    assertOptionalHash(
      options.expectedCandidateSha256,
      candidateSha256,
      'candidate',
    );
    const validationRowCount = requirePositiveInteger(
      validationArtifact.rowCount,
      'validation row count',
    );
    const candidateRowCount = requirePositiveInteger(
      candidateArtifact.rowCount,
      'candidate row count',
    );
    if (validationRowCount !== candidateRowCount) {
      throw new Error(
        `Historical validation and candidate row counts differ: ` +
          `${validationRowCount} versus ${candidateRowCount}.`,
      );
    }
    const candidatePolicy = asRecord(candidateManifest.candidatePolicy);
    const sourceDataset = asRecord(candidateSource.sourceDataset);
    const split = asRecord(candidateSource.split);
    return {
      validationPath,
      validationSha256,
      validationRowCount,
      candidatePath,
      candidateSha256,
      candidateRowCount,
      candidatePolicy: requireString(candidatePolicy.name, 'candidate policy name'),
      candidateLimit: requirePositiveInteger(
        candidatePolicy.candidateLimit,
        'candidate limit',
      ),
      modelVersion: requireString(candidateSource.modelVersion, 'model version'),
      modelSha256: requireString(candidateSource.modelSha256, 'model SHA-256'),
      sourceDatasetVersion: requireString(
        sourceDataset.datasetVersion,
        'source dataset version',
      ),
      sourceDatasetSha256: requireString(
        sourceDataset.datasetSha256,
        'source dataset SHA-256',
      ),
      validationWindowStartTime: optionalString(split.validationWindowStartTime),
      validationWindowEndTime: optionalString(split.validationWindowEndTime),
    };
  }

  private async clearOutputs(): Promise<void> {
    await Promise.all(
      Object.values(this.paths).flatMap((path) => [
        rm(path, { force: true }),
        rm(`${path}.partial`, { force: true }),
      ]),
    );
  }

  private createIdleStatus(): RecommendationDecisionDatasetV4HistoricalBootstrapStatus {
    return {
      state: 'IDLE',
      phase: 'PREPARING',
      sourceValidationRowCount: 0,
      sourceCandidateRowCount: 0,
      processedRowCount: 0,
      rowCount: 0,
      candidateCoveredRowCount: 0,
      matchCount: 0,
      outputDirectory: this.outputDirectory,
      datasetPath: this.paths.dataset,
      datasetAvailable: false,
      manifestAvailable: false,
      auditAvailable: false,
    };
  }
}

function createBootstrapRow(
  validation: HistoricalValidationRow,
  candidateActionKeys: readonly string[],
  source: SourceDescriptor,
): HistoricalBootstrapRow {
  const itemIds = expandInventoryStateKey(
    validation.features.inventoryBeforeStateKey,
  );
  const decisionTimeMs =
    parseTimestamp(validation.matchStartTime) +
    validation.features.gameTimeS * 1_000;
  const candidateActions = candidateActionKeys.map((actionKey, index) =>
    createCandidateAction(
      actionKey,
      candidateActionKeys.length - index,
      validation.features.inventoryBeforeStateKey,
    ),
  );
  return {
    schemaVersion: RECOMMENDATION_DECISION_DATASET_V4_SCHEMA_VERSION,
    datasetVersion: RECOMMENDATION_DECISION_DATASET_V4_VERSION,
    datasetSourceKind: 'HISTORICAL_V3_HELD_OUT_VALIDATION_BOOTSTRAP',
    decisionId: validation.decisionId,
    decisionOccurredAt: new Date(decisionTimeMs).toISOString(),
    matchId: String(validation.matchId),
    steamId: String(validation.playerId),
    heroId: validation.features.heroId,
    teamId: validation.features.team,
    itemIds,
    alliedHeroIds: [...validation.features.alliedHeroIds],
    enemyHeroIds: [...validation.features.enemyHeroIds],
    previousActionKeys: [...validation.features.previousActionKeys],
    inventoryStateKey: validation.features.inventoryBeforeStateKey,
    gameTimeS: validation.features.gameTimeS,
    timeBucket: Math.floor(
      validation.features.gameTimeS / LIVE_TIME_BUCKET_SECONDS,
    ),
    traversalKey: `historical-v3:${validation.decisionId}`,
    recommendationModel: 'CONTEXTUAL_V3_HELD_OUT_CANDIDATE_REPLAY',
    modelVersion: source.modelVersion,
    modelSha256: source.modelSha256,
    candidateSetPolicy: source.candidatePolicy,
    candidateLimit: source.candidateLimit,
    buildArchetypeId: validation.features.buildArchetypeId,
    servedActionKey: candidateActionKeys[0] ?? '',
    candidateActions,
    elapsedMs: 0,
    observedLabel: {
      observedActionKeys: [validation.target.actionKey],
      reconstructionConfidence: 'EXACT_SINGLE_ACTION',
      exactActionKey: validation.target.actionKey,
      observedAtGameTimeS: validation.features.gameTimeS,
      observationDelayS: 0,
    },
    lifecycle: {
      superseded: false,
      supersedeReasons: [],
      duplicateDecisionCount: 0,
      observedEventCount: 1,
    },
    outcomeLabel: {
      available: true,
      conflicting: false,
      playerWon: validation.outcomeLabel.playerWon,
      source: 'HISTORICAL_MATCH_PLAYER',
    },
    trainingEligibility: {
      exactAction: true,
      outcome: true,
      actionExclusionReasons: [],
      outcomeExclusionReasons: [],
    },
  };
}

function createCandidateAction(
  actionKey: string,
  rankScore: number,
  inventoryStateKey: string,
): RecommendationTelemetryCandidateAction {
  const parsed = parseActionKey(actionKey);
  return {
    actionKey,
    actionType: parsed.actionType,
    itemId: parsed.itemId,
    score: rankScore,
    confidence: 0,
    historicalCount: 0,
    historicalProbability: 0,
    predictedStateKey: inventoryStateKey,
    matchupSignals: [],
  };
}

function parseActionKey(actionKey: string): {
  actionType: RecommendationTelemetryCandidateAction['actionType'];
  itemId?: number;
} {
  const [rawType, rawItemId] = actionKey.split(':', 2);
  const actionType = rawType as RecommendationTelemetryCandidateAction['actionType'];
  if (!['BUY', 'REBUY', 'UPGRADE', 'SELL', 'HOLD'].includes(actionType)) {
    throw new Error(`Unsupported historical candidate action key: ${actionKey}.`);
  }
  if (actionType === 'HOLD') {
    return { actionType };
  }
  const itemId = Number(rawItemId);
  if (!Number.isSafeInteger(itemId) || itemId <= 0) {
    throw new Error(`Invalid historical candidate action key: ${actionKey}.`);
  }
  return { actionType, itemId };
}

function expandInventoryStateKey(stateKey: string): number[] {
  const multiset = parseInventoryStateKey(stateKey);
  if (!multiset) {
    throw new Error(`Invalid historical inventory state key: ${stateKey}.`);
  }
  const itemIds: number[] = [];
  for (const [itemId, count] of [...multiset.entries()].sort(
    ([left], [right]) => left - right,
  )) {
    for (let index = 0; index < count; index += 1) {
      itemIds.push(itemId);
    }
  }
  return itemIds;
}

async function* createJsonLineIterator<T>(
  path: string,
  parser: (value: unknown, lineNumber: number) => T,
): AsyncGenerator<T> {
  const lines = createInterface({
    input: createReadStream(path, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  let lineNumber = 0;
  for await (const line of lines) {
    lineNumber += 1;
    if (!line.trim()) {
      continue;
    }
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      throw new Error(`Invalid JSON in ${path} at line ${lineNumber}.`);
    }
    yield parser(value, lineNumber);
  }
}

function parseValidationRow(
  value: unknown,
  lineNumber: number,
): HistoricalValidationRow {
  if (!isRecord(value)) {
    throw new Error(`Invalid historical validation row at line ${lineNumber}.`);
  }
  const features = asRecord(value.features);
  const target = asRecord(value.target);
  const outcomeLabel = asRecord(value.outcomeLabel);
  if (
    typeof value.decisionId !== 'string' ||
    !Number.isSafeInteger(Number(value.matchId)) ||
    typeof value.matchStartTime !== 'string' ||
    !Number.isSafeInteger(Number(value.playerId)) ||
    !Number.isSafeInteger(Number(features.heroId)) ||
    !Number.isSafeInteger(Number(features.team)) ||
    !Number.isFinite(Number(features.gameTimeS)) ||
    typeof features.inventoryBeforeStateKey !== 'string' ||
    !Array.isArray(features.previousActionKeys) ||
    !Array.isArray(features.alliedHeroIds) ||
    !Array.isArray(features.enemyHeroIds) ||
    typeof features.buildArchetypeId !== 'string' ||
    typeof target.actionKey !== 'string' ||
    typeof target.actionType !== 'string' ||
    !Number.isSafeInteger(Number(target.itemId)) ||
    typeof outcomeLabel.playerWon !== 'boolean'
  ) {
    throw new Error(`Invalid historical validation row at line ${lineNumber}.`);
  }
  return value as unknown as HistoricalValidationRow;
}

function parseCandidateRow(
  value: unknown,
  lineNumber: number,
): HistoricalCandidateRow {
  if (
    !isRecord(value) ||
    typeof value.decisionId !== 'string' ||
    !Array.isArray(value.candidateActionKeys) ||
    typeof value.actualActionKey !== 'string' ||
    typeof value.actualActionCovered !== 'boolean'
  ) {
    throw new Error(`Invalid historical candidate row at line ${lineNumber}.`);
  }
  return value as unknown as HistoricalCandidateRow;
}

function uniqueActionKeys(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function normalizeOptions(
  request: RecommendationDecisionDatasetV4HistoricalBootstrapStartRequest,
): RecommendationDecisionDatasetV4HistoricalBootstrapOptions {
  return {
    maxRows: normalizeOptionalInteger(request.maxRows, 'maxRows', 1, 1_000_000),
    expectedValidationSha256: normalizeOptionalSha256(
      request.expectedValidationSha256,
      'expectedValidationSha256',
    ),
    expectedCandidateSha256: normalizeOptionalSha256(
      request.expectedCandidateSha256,
      'expectedCandidateSha256',
    ),
  };
}

function normalizeOptionalInteger(
  value: number | undefined,
  fieldName: string,
  minimum: number,
  maximum: number,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(
      `${fieldName} must be a safe integer from ${minimum} to ${maximum}.`,
    );
  }
  return value;
}

function normalizeOptionalSha256(
  value: string | undefined,
  fieldName: string,
): string | undefined {
  if (value === undefined || !value.trim()) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new Error(`${fieldName} must be a 64-character SHA-256.`);
  }
  return normalized;
}

function requireString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Required source field is missing: ${fieldName}.`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function requirePositiveInteger(value: unknown, fieldName: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`Required source field is invalid: ${fieldName}.`);
  }
  return parsed;
}

function assertHash(actual: string, expected: string, label: string): void {
  if (actual !== expected) {
    throw new Error(
      `${label} SHA-256 mismatch: expected ${expected}, received ${actual}.`,
    );
  }
}

function assertOptionalHash(
  expected: string | undefined,
  actual: string,
  label: string,
): void {
  if (expected && expected !== actual) {
    throw new Error(
      `${label} SHA-256 mismatch: expected ${expected}, received ${actual}.`,
    );
  }
}

function parseTimestamp(value: string): number {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) {
    throw new Error(`Invalid historical timestamp: ${value}.`);
  }
  return timestamp;
}

async function requiredJson<T>(path: string): Promise<T> {
  const value = await readJson(path);
  if (!value) {
    throw new Error(`Required artifact is missing: ${path}.`);
  }
  return value as T;
}

async function readJson(
  path: string,
): Promise<Record<string, unknown> | undefined> {
  try {
    const content = await readFile(path, 'utf8');
    const value = JSON.parse(content) as unknown;
    return isRecord(value) ? value : undefined;
  } catch (error) {
    if (isErrorWithCode(error) && error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  const partialPath = `${path}.partial`;
  await writeFile(partialPath, `${JSON.stringify(value, undefined, 2)}\n`, 'utf8');
  await rm(path, { force: true });
  await rename(partialPath, path);
}

async function promote(path: string): Promise<void> {
  await rm(path, { force: true });
  await rename(`${path}.partial`, path);
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  const stream = createReadStream(path);
  for await (const chunk of stream) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

function divide(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

function toNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isErrorWithCode(error: unknown): error is Error & { code: string } {
  return isRecord(error) && typeof error.code === 'string';
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

class LineWriter {
  private buffer = '';

  private constructor(private readonly handle: FileHandle) {}

  static async create(path: string): Promise<LineWriter> {
    await rm(path, { force: true });
    return new LineWriter(await open(path, 'w'));
  }

  async write(value: unknown): Promise<void> {
    this.buffer += `${JSON.stringify(value)}\n`;
    if (Buffer.byteLength(this.buffer, 'utf8') >= BUFFER_LIMIT_BYTES) {
      await this.flush();
    }
  }

  async close(): Promise<void> {
    await this.flush();
    await this.handle.close();
  }

  private async flush(): Promise<void> {
    if (!this.buffer) {
      return;
    }
    const value = this.buffer;
    this.buffer = '';
    await this.handle.write(value);
  }
}
