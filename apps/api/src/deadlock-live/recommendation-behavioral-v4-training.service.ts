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
import type {
  RecommendationDecisionDatasetV4Audit,
  RecommendationDecisionDatasetV4Manifest,
  RecommendationDecisionDatasetV4Row,
} from './recommendation-decision-dataset-v4.service';
import { RECOMMENDATION_DECISION_DATASET_V4_VERSION } from './recommendation-decision-dataset-v4.service';

export const RECOMMENDATION_BEHAVIORAL_V4_TRAINING_SCHEMA_VERSION = 1;
export const RECOMMENDATION_BEHAVIORAL_V4_MODEL_VERSION =
  'RECOMMENDATION_BEHAVIORAL_V4_HIERARCHICAL_COUNT_RANKER_1' as const;

const DEFAULT_SOURCE_DIRECTORY =
  '/app/apps/api/storage/recommendation-decision-dataset-v4';
const DEFAULT_OUTPUT_DIRECTORY =
  '/app/apps/api/storage/recommendation-behavioral-v4-training';
const SOURCE_DIRECTORY_ENV =
  'DEADLOCK_RECOMMENDATION_BEHAVIORAL_V4_SOURCE_DIR';
const OUTPUT_DIRECTORY_ENV =
  'DEADLOCK_RECOMMENDATION_BEHAVIORAL_V4_TRAINING_DIR';
const PREVIOUS_ACTION_TAIL_LENGTH = 4;
const BUFFER_LIMIT_BYTES = 1024 * 1024;

export interface RecommendationBehavioralV4TrainingStartRequest {
  trainFraction?: number;
  smoothing?: number;
  minContextObservations?: number;
  maxCandidateActions?: number;
  expectedSourceSha256?: string;
}

export interface RecommendationBehavioralV4TrainingOptions {
  trainFraction: number;
  smoothing: number;
  minContextObservations: number;
  maxCandidateActions: number;
  expectedSourceSha256?: string;
}

export interface RecommendationBehavioralV4TrainingStatus {
  state: 'IDLE' | 'RUNNING' | 'COMPLETE' | 'FAILED';
  phase:
    | 'PREPARING'
    | 'SPLITTING'
    | 'TRAINING'
    | 'EVALUATING'
    | 'FINALIZING'
    | 'COMPLETE';
  currentPass: number;
  totalPasses: number;
  sourceRowCount: number;
  eligibleSourceRowCount: number;
  excludedSourceRowCount: number;
  processedRowCount: number;
  trainRowCount: number;
  validationRowCount: number;
  sourceMatchCount: number;
  trainMatchCount: number;
  validationMatchCount: number;
  outputDirectory: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  options?: RecommendationBehavioralV4TrainingOptions;
  manifestAvailable: boolean;
  auditAvailable: boolean;
  evaluationAvailable: boolean;
  modelAvailable: boolean;
}

export interface RecommendationBehavioralV4MatchDescriptor {
  matchId: string;
  firstDecisionOccurredAt: string;
}

export interface RecommendationBehavioralV4ChronologicalSplit {
  train: RecommendationBehavioralV4MatchDescriptor[];
  validation: RecommendationBehavioralV4MatchDescriptor[];
}

export interface RecommendationBehavioralV4PreparedRow {
  schemaVersion: typeof RECOMMENDATION_BEHAVIORAL_V4_TRAINING_SCHEMA_VERSION;
  decisionId: string;
  matchId: string;
  decisionOccurredAt: string;
  features: {
    heroId: number;
    teamId?: number;
    gameTimeS: number;
    timeBucket: number;
    inventoryStateKey: string;
    previousActionKeys: string[];
    previousActionTailKey: string;
    alliedHeroIds: number[];
    enemyHeroIds: number[];
    recommendationModel: string;
    buildArchetypeId?: string;
    candidateSetPolicy?: string;
    servedActionKey: string;
    candidateActionKeys: string[];
  };
  target: {
    actionKey: string;
  };
  outcomeLabel?: {
    playerWon: boolean;
  };
}

type CountMap = Map<string, number>;
type CountTable = Map<string, CountMap>;

interface RecommendationBehavioralV4Model {
  hero: CountTable;
  heroTime: CountTable;
  heroTimeInventory: CountTable;
  heroTimePreviousTail: CountTable;
  ally: CountTable;
  enemy: CountTable;
}

interface RawMetrics {
  evaluatedDecisionCount: number;
  top1Count: number;
  top3Count: number;
  reciprocalRankSum: number;
}

interface FinalizedMetrics {
  evaluatedDecisionCount: number;
  top1Rate: number;
  top3Rate: number;
  meanReciprocalRank: number;
}

interface TrainingArtifacts {
  train: string;
  validation: string;
  candidateEvaluation: string;
  model: string;
  evaluation: string;
  audit: string;
  manifest: string;
}

interface TrainingPassSummary {
  sourceRows: number;
  eligibleRows: number;
  excludedRows: number;
  duplicateEligibleDecisionCount: number;
  matches: RecommendationBehavioralV4MatchDescriptor[];
}

@Injectable()
export class RecommendationBehavioralV4TrainingService implements OnModuleInit {
  private readonly logger = new Logger(
    RecommendationBehavioralV4TrainingService.name,
  );
  private readonly sourceDirectory =
    process.env[SOURCE_DIRECTORY_ENV]?.trim() || DEFAULT_SOURCE_DIRECTORY;
  private readonly outputDirectory =
    process.env[OUTPUT_DIRECTORY_ENV]?.trim() || DEFAULT_OUTPUT_DIRECTORY;
  private readonly sourceDatasetPath = join(
    this.sourceDirectory,
    'dataset.ndjson',
  );
  private readonly sourceManifestPath = join(
    this.sourceDirectory,
    'manifest.json',
  );
  private readonly sourceAuditPath = join(this.sourceDirectory, 'audit.json');
  private readonly paths: TrainingArtifacts = {
    train: join(this.outputDirectory, 'train.ndjson'),
    validation: join(this.outputDirectory, 'validation.ndjson'),
    candidateEvaluation: join(
      this.outputDirectory,
      'candidate-evaluation.ndjson',
    ),
    model: join(this.outputDirectory, 'model.json'),
    evaluation: join(this.outputDirectory, 'evaluation.json'),
    audit: join(this.outputDirectory, 'audit.json'),
    manifest: join(this.outputDirectory, 'manifest.json'),
  };

  private status: RecommendationBehavioralV4TrainingStatus;
  private manifest?: Record<string, unknown>;
  private audit?: Record<string, unknown>;
  private evaluation?: Record<string, unknown>;
  private modelArtifact?: Record<string, unknown>;
  private runPromise: Promise<void> = Promise.resolve();

  constructor() {
    this.status = this.createIdleStatus();
  }

  async onModuleInit(): Promise<void> {
    await mkdir(this.outputDirectory, { recursive: true });
    this.manifest = await readJson(this.paths.manifest);
    this.audit = await readJson(this.paths.audit);
    this.evaluation = await readJson(this.paths.evaluation);
    this.modelArtifact = await readJson(this.paths.model);
    if (this.manifest && this.audit && this.evaluation && this.modelArtifact) {
      const source = asRecord(this.audit.source);
      const split = asRecord(this.audit.split);
      this.status = {
        ...this.createIdleStatus(),
        state: 'COMPLETE',
        phase: 'COMPLETE',
        sourceRowCount: toNumber(source.sourceRowCount),
        eligibleSourceRowCount: toNumber(source.eligibleSourceRowCount),
        excludedSourceRowCount: toNumber(source.excludedSourceRowCount),
        processedRowCount: toNumber(source.sourceRowCount),
        trainRowCount: toNumber(split.trainRowCount),
        validationRowCount: toNumber(split.validationRowCount),
        sourceMatchCount: toNumber(source.eligibleMatchCount),
        trainMatchCount: toNumber(split.trainMatchCount),
        validationMatchCount: toNumber(split.validationMatchCount),
        completedAt: String(this.manifest.generatedAt ?? ''),
        manifestAvailable: true,
        auditAvailable: true,
        evaluationAvailable: true,
        modelAvailable: true,
      };
    }
  }

  async start(
    request: RecommendationBehavioralV4TrainingStartRequest = {},
  ): Promise<RecommendationBehavioralV4TrainingStatus> {
    if (this.status.state === 'RUNNING') {
      throw new Error('Recommendation Behavioral V4 training is already running.');
    }
    const options = normalizeOptions(request);
    this.status = {
      ...this.createIdleStatus(),
      state: 'RUNNING',
      startedAt: new Date().toISOString(),
      options,
      manifestAvailable: this.manifest !== undefined,
      auditAvailable: this.audit !== undefined,
      evaluationAvailable: this.evaluation !== undefined,
      modelAvailable: this.modelArtifact !== undefined,
    };
    this.runPromise = this.run(options);
    return this.getStatus();
  }

  async waitForIdle(): Promise<void> {
    await this.runPromise;
  }

  getStatus(): RecommendationBehavioralV4TrainingStatus {
    return cloneJson(this.status);
  }

  getManifest(): Record<string, unknown> | undefined {
    return this.manifest ? cloneJson(this.manifest) : undefined;
  }

  getAudit(): Record<string, unknown> | undefined {
    return this.audit ? cloneJson(this.audit) : undefined;
  }

  getEvaluation(): Record<string, unknown> | undefined {
    return this.evaluation ? cloneJson(this.evaluation) : undefined;
  }

  getModel(): Record<string, unknown> | undefined {
    return this.modelArtifact ? cloneJson(this.modelArtifact) : undefined;
  }

  private async run(
    options: RecommendationBehavioralV4TrainingOptions,
  ): Promise<void> {
    try {
      const sourceManifest =
        await requiredJson<RecommendationDecisionDatasetV4Manifest>(
          this.sourceManifestPath,
        );
      const sourceAudit =
        await requiredJson<RecommendationDecisionDatasetV4Audit>(
          this.sourceAuditPath,
        );
      validateSourceArtifacts(sourceManifest, sourceAudit);
      const sourceSha256 = await hashFile(this.sourceDatasetPath);
      if (sourceManifest.artifact.sha256 !== sourceSha256) {
        throw new Error(
          'Recommendation Decision Dataset V4 manifest SHA-256 does not match dataset.ndjson.',
        );
      }
      if (
        options.expectedSourceSha256 &&
        options.expectedSourceSha256 !== sourceSha256
      ) {
        throw new Error(
          `Source SHA-256 mismatch: expected ${options.expectedSourceSha256}, received ${sourceSha256}.`,
        );
      }

      await mkdir(this.outputDirectory, { recursive: true });
      await this.clearOutputs();
      this.manifest = undefined;
      this.audit = undefined;
      this.evaluation = undefined;
      this.modelArtifact = undefined;
      this.status = {
        ...this.status,
        manifestAvailable: false,
        auditAvailable: false,
        evaluationAvailable: false,
        modelAvailable: false,
      };

      this.status = {
        ...this.status,
        phase: 'SPLITTING',
        currentPass: 1,
        sourceRowCount: sourceManifest.artifact.rowCount,
      };
      const passSummary = await this.collectSplitDescriptors();
      if (passSummary.sourceRows !== sourceManifest.artifact.rowCount) {
        throw new Error(
          'Recommendation Decision Dataset V4 row count does not match its manifest.',
        );
      }
      if (
        passSummary.eligibleRows !== sourceAudit.rows.exactActionEligibleCount
      ) {
        throw new Error(
          'Exact-action eligible row count does not match the source audit.',
        );
      }
      if (passSummary.duplicateEligibleDecisionCount > 0) {
        throw new Error(
          'The exact-action eligible source subset contains duplicate decision IDs.',
        );
      }
      const split = selectRecommendationBehavioralV4ChronologicalSplit(
        passSummary.matches,
        options.trainFraction,
      );
      const trainMatchIds = new Set(split.train.map((value) => value.matchId));
      const validationMatchIds = new Set(
        split.validation.map((value) => value.matchId),
      );
      this.status = {
        ...this.status,
        sourceRowCount: passSummary.sourceRows,
        eligibleSourceRowCount: passSummary.eligibleRows,
        excludedSourceRowCount: passSummary.excludedRows,
        processedRowCount: passSummary.sourceRows,
        sourceMatchCount: passSummary.matches.length,
        trainMatchCount: trainMatchIds.size,
        validationMatchCount: validationMatchIds.size,
      };

      this.status = {
        ...this.status,
        phase: 'TRAINING',
        currentPass: 2,
        processedRowCount: 0,
      };
      const model = createModel();
      const trainWriter = await LineWriter.create(`${this.paths.train}.partial`);
      let trainRows = 0;
      let processedTrainingPassRows = 0;
      try {
        await eachSourceRow(this.sourceDatasetPath, async (row) => {
          processedTrainingPassRows += 1;
          if (!isExactActionEligibleRow(row)) {
            return;
          }
          if (trainMatchIds.has(row.matchId)) {
            const prepared = prepareRow(row, options.maxCandidateActions);
            updateModel(model, prepared);
            await trainWriter.write(prepared);
            trainRows += 1;
          } else if (!validationMatchIds.has(row.matchId)) {
            throw new Error(`Match ${row.matchId} was not assigned to a split.`);
          }
          if (processedTrainingPassRows % 1_000 === 0) {
            this.status = {
              ...this.status,
              processedRowCount: processedTrainingPassRows,
              trainRowCount: trainRows,
            };
          }
          if (processedTrainingPassRows % 10_000 === 0) {
            await yieldToEventLoop();
          }
        });
      } finally {
        await trainWriter.close();
      }
      await promote(this.paths.train);

      this.status = {
        ...this.status,
        phase: 'EVALUATING',
        currentPass: 3,
        processedRowCount: 0,
        trainRowCount: trainRows,
      };
      const validationWriter = await LineWriter.create(
        `${this.paths.validation}.partial`,
      );
      const candidateEvaluationWriter = await LineWriter.create(
        `${this.paths.candidateEvaluation}.partial`,
      );
      const servedMetrics = emptyMetrics();
      const frequencyMetrics = emptyMetrics();
      const behavioralMetrics = emptyMetrics();
      let validationRows = 0;
      let coveredValidationRows = 0;
      let emptyCandidateSetRows = 0;
      let processedEvaluationPassRows = 0;
      try {
        await eachSourceRow(this.sourceDatasetPath, async (row) => {
          processedEvaluationPassRows += 1;
          if (
            !isExactActionEligibleRow(row) ||
            !validationMatchIds.has(row.matchId)
          ) {
            return;
          }
          const prepared = prepareRow(row, options.maxCandidateActions);
          const candidates = prepared.features.candidateActionKeys;
          const actualActionKey = prepared.target.actionKey;
          const covered = candidates.includes(actualActionKey);
          coveredValidationRows += covered ? 1 : 0;
          emptyCandidateSetRows += candidates.length === 0 ? 1 : 0;
          const servedRanking = rankServedCandidates(
            candidates,
            prepared.features.servedActionKey,
          );
          const frequencyRanking = rankFrequencyCandidates(
            prepared,
            candidates,
            model,
            options,
          );
          const behavioralRanking = rankBehavioralCandidates(
            prepared,
            candidates,
            model,
            options,
          );
          updateMetrics(servedMetrics, servedRanking, actualActionKey);
          updateMetrics(frequencyMetrics, frequencyRanking, actualActionKey);
          updateMetrics(behavioralMetrics, behavioralRanking, actualActionKey);
          await validationWriter.write(prepared);
          await candidateEvaluationWriter.write({
            schemaVersion:
              RECOMMENDATION_BEHAVIORAL_V4_TRAINING_SCHEMA_VERSION,
            decisionId: prepared.decisionId,
            candidateActionKeys: candidates,
            actualActionKey,
            actualActionCovered: covered,
            servedActionKey: prepared.features.servedActionKey,
            servedRanking,
            frequencyRanking,
            behavioralRanking,
          });
          validationRows += 1;
          if (processedEvaluationPassRows % 1_000 === 0) {
            this.status = {
              ...this.status,
              processedRowCount: processedEvaluationPassRows,
              validationRowCount: validationRows,
            };
          }
          if (processedEvaluationPassRows % 10_000 === 0) {
            await yieldToEventLoop();
          }
        });
      } finally {
        await Promise.all([
          validationWriter.close(),
          candidateEvaluationWriter.close(),
        ]);
      }
      await Promise.all([
        promote(this.paths.validation),
        promote(this.paths.candidateEvaluation),
      ]);
      if (trainRows + validationRows !== passSummary.eligibleRows) {
        throw new Error(
          'Train and validation rows do not cover the exact-action eligible source subset.',
        );
      }

      const generatedAt = new Date().toISOString();
      const serializedModel = {
        schemaVersion: RECOMMENDATION_BEHAVIORAL_V4_TRAINING_SCHEMA_VERSION,
        modelVersion: RECOMMENDATION_BEHAVIORAL_V4_MODEL_VERSION,
        generatedAt,
        featureCutoff: 'DECISION_SERVED_TIME',
        target: 'OBSERVED_EXACT_NEXT_ACTION',
        candidateSetPolicy: 'RECORDED_AT_DECISION_TIME',
        options,
        weights: {
          heroTimeBase: 1,
          inventoryDelta: 0.55,
          previousActionTailDelta: 0.35,
          alliedRosterDeltaAverage: 0.08,
          enemyRosterDeltaAverage: 0.12,
        },
        counts: serializeModel(model),
      };
      const evaluation = buildEvaluation({
        servedMetrics,
        frequencyMetrics,
        behavioralMetrics,
        validationRows,
        coveredValidationRows,
        emptyCandidateSetRows,
        options,
        generatedAt,
      });
      await Promise.all([
        atomicJson(this.paths.model, serializedModel),
        atomicJson(this.paths.evaluation, evaluation),
      ]);

      this.status = {
        ...this.status,
        phase: 'FINALIZING',
        processedRowCount: passSummary.sourceRows,
        validationRowCount: validationRows,
      };
      const featureFields = [
        'heroId',
        'teamId',
        'gameTimeS',
        'timeBucket',
        'inventoryStateKey',
        'previousActionKeys',
        'previousActionTailKey',
        'alliedHeroIds',
        'enemyHeroIds',
        'recommendationModel',
        'buildArchetypeId',
        'candidateSetPolicy',
        'servedActionKey',
        'candidateActionKeys',
      ];
      const forbiddenFields = [
        'observedLabel',
        'target.actionKey',
        'outcomeLabel',
        'playerWon',
        'observedInventoryStateKey',
        'observedAtGameTimeS',
      ];
      const forbiddenFieldsPresent = featureFields.filter((field) =>
        forbiddenFields.includes(field),
      );
      const overlapCount = [...trainMatchIds].filter((matchId) =>
        validationMatchIds.has(matchId),
      ).length;
      const releaseGate = asRecord(evaluation.releaseGate);
      const warnings: string[] = [];
      if (passSummary.excludedRows > 0) {
        warnings.push(
          `${passSummary.excludedRows} source rows were excluded because they were not exact-action eligible.`,
        );
      }
      if (validationRows < 100) {
        warnings.push(
          'Validation contains fewer than 100 exact-action decisions.',
        );
      }
      if (!releaseGate.passed) {
        warnings.push(
          'The validation release gate failed; the model must not be used for production serving.',
        );
      }
      const audit = {
        schemaVersion: RECOMMENDATION_BEHAVIORAL_V4_TRAINING_SCHEMA_VERSION,
        generatedAt,
        passed:
          sourceAudit.passed &&
          passSummary.sourceRows === sourceManifest.artifact.rowCount &&
          passSummary.eligibleRows ===
            sourceAudit.rows.exactActionEligibleCount &&
          trainRows + validationRows === passSummary.eligibleRows &&
          passSummary.duplicateEligibleDecisionCount === 0 &&
          overlapCount === 0 &&
          forbiddenFieldsPresent.length === 0,
        source: {
          datasetVersion: sourceManifest.datasetVersion,
          sourceAuditPassed: sourceAudit.passed,
          expectedSha256:
            options.expectedSourceSha256 ?? sourceManifest.artifact.sha256,
          actualSha256: sourceSha256,
          sourceRowCount: passSummary.sourceRows,
          eligibleSourceRowCount: passSummary.eligibleRows,
          excludedSourceRowCount: passSummary.excludedRows,
          eligibleMatchCount: passSummary.matches.length,
          duplicateEligibleDecisionCount:
            passSummary.duplicateEligibleDecisionCount,
        },
        split: {
          strategy: 'CHRONOLOGICAL_MATCH_LEVEL',
          trainFraction: options.trainFraction,
          trainMatchCount: trainMatchIds.size,
          validationMatchCount: validationMatchIds.size,
          overlappingMatchCount: overlapCount,
          trainRowCount: trainRows,
          validationRowCount: validationRows,
        },
        candidates: {
          policy: 'RECORDED_AT_DECISION_TIME',
          maxCandidateActions: options.maxCandidateActions,
          validationDecisionCount: validationRows,
          coveredValidationDecisionCount: coveredValidationRows,
          candidateCoverageRate: divide(
            coveredValidationRows,
            validationRows,
          ),
          emptyCandidateSetRowCount: emptyCandidateSetRows,
        },
        leakage: {
          featureCutoff: 'DECISION_SERVED_TIME',
          featureFields,
          forbiddenFields,
          forbiddenFieldsPresent,
          targetFields: ['target.actionKey'],
          outcomeFields: ['outcomeLabel.playerWon'],
          outcomeUsedForBehavioralTraining: false,
        },
        warnings,
      };
      const manifest = await buildManifest({
        sourceManifest,
        sourceDirectory: this.sourceDirectory,
        sourceSha256,
        options,
        split,
        trainRows,
        validationRows,
        eligibleRows: passSummary.eligibleRows,
        excludedRows: passSummary.excludedRows,
        generatedAt,
        evaluation,
        paths: this.paths,
        auditPassed: audit.passed,
        warnings,
      });
      await Promise.all([
        atomicJson(this.paths.audit, audit),
        atomicJson(this.paths.manifest, manifest),
      ]);
      this.audit = audit;
      this.manifest = manifest;
      this.evaluation = evaluation;
      this.modelArtifact = serializedModel;
      this.status = {
        ...this.status,
        state: 'COMPLETE',
        phase: 'COMPLETE',
        completedAt: generatedAt,
        processedRowCount: passSummary.sourceRows,
        trainRowCount: trainRows,
        validationRowCount: validationRows,
        manifestAvailable: true,
        auditAvailable: true,
        evaluationAvailable: true,
        modelAvailable: true,
        error: undefined,
      };
      this.logger.log(
        `Recommendation Behavioral V4 training completed: ${trainRows} train rows, ` +
          `${validationRows} validation rows, release gate ` +
          `${releaseGate.passed ? 'PASS' : 'FAIL'}.`,
      );
    } catch (error) {
      const message = getErrorMessage(error);
      this.status = {
        ...this.status,
        state: 'FAILED',
        completedAt: new Date().toISOString(),
        error: message,
      };
      this.logger.error(
        `Recommendation Behavioral V4 training failed: ${message}`,
      );
    }
  }

  private async collectSplitDescriptors(): Promise<TrainingPassSummary> {
    const descriptors = new Map<
      string,
      RecommendationBehavioralV4MatchDescriptor
    >();
    const decisionIds = new Set<string>();
    let sourceRows = 0;
    let eligibleRows = 0;
    let excludedRows = 0;
    let duplicateEligibleDecisionCount = 0;
    await eachSourceRow(this.sourceDatasetPath, async (row) => {
      sourceRows += 1;
      if (!isExactActionEligibleRow(row)) {
        excludedRows += 1;
      } else {
        eligibleRows += 1;
        if (decisionIds.has(row.decisionId)) {
          duplicateEligibleDecisionCount += 1;
        } else {
          decisionIds.add(row.decisionId);
        }
        const occurredAtMs = parseTimestamp(row.decisionOccurredAt);
        const existing = descriptors.get(row.matchId);
        if (
          !existing ||
          occurredAtMs < parseTimestamp(existing.firstDecisionOccurredAt)
        ) {
          descriptors.set(row.matchId, {
            matchId: row.matchId,
            firstDecisionOccurredAt: row.decisionOccurredAt,
          });
        }
      }
      if (sourceRows % 1_000 === 0) {
        this.status = {
          ...this.status,
          processedRowCount: sourceRows,
          eligibleSourceRowCount: eligibleRows,
          excludedSourceRowCount: excludedRows,
        };
      }
      if (sourceRows % 10_000 === 0) {
        await yieldToEventLoop();
      }
    });
    return {
      sourceRows,
      eligibleRows,
      excludedRows,
      duplicateEligibleDecisionCount,
      matches: [...descriptors.values()],
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

  private createIdleStatus(): RecommendationBehavioralV4TrainingStatus {
    return {
      state: 'IDLE',
      phase: 'PREPARING',
      currentPass: 0,
      totalPasses: 3,
      sourceRowCount: 0,
      eligibleSourceRowCount: 0,
      excludedSourceRowCount: 0,
      processedRowCount: 0,
      trainRowCount: 0,
      validationRowCount: 0,
      sourceMatchCount: 0,
      trainMatchCount: 0,
      validationMatchCount: 0,
      outputDirectory: this.outputDirectory,
      manifestAvailable: false,
      auditAvailable: false,
      evaluationAvailable: false,
      modelAvailable: false,
    };
  }
}

export function selectRecommendationBehavioralV4ChronologicalSplit(
  descriptors: readonly RecommendationBehavioralV4MatchDescriptor[],
  trainFraction: number,
): RecommendationBehavioralV4ChronologicalSplit {
  if (descriptors.length < 2) {
    throw new Error(
      'At least two matches with exact-action eligible decisions are required.',
    );
  }
  if (
    !Number.isFinite(trainFraction) ||
    trainFraction <= 0 ||
    trainFraction >= 1
  ) {
    throw new Error(
      'trainFraction must be greater than zero and less than one.',
    );
  }
  const sorted = [...descriptors].sort(
    (left, right) =>
      parseTimestamp(left.firstDecisionOccurredAt) -
        parseTimestamp(right.firstDecisionOccurredAt) ||
      left.matchId.localeCompare(right.matchId),
  );
  const trainCount = Math.min(
    sorted.length - 1,
    Math.max(1, Math.floor(sorted.length * trainFraction)),
  );
  return {
    train: sorted.slice(0, trainCount),
    validation: sorted.slice(trainCount),
  };
}

export function prepareRecommendationBehavioralV4Row(
  row: RecommendationDecisionDatasetV4Row,
  maxCandidateActions = 128,
): RecommendationBehavioralV4PreparedRow {
  if (!isExactActionEligibleRow(row)) {
    throw new Error(
      `Decision ${row.decisionId} is not exact-action eligible.`,
    );
  }
  return prepareRow(row, maxCandidateActions);
}

function prepareRow(
  row: RecommendationDecisionDatasetV4Row,
  maxCandidateActions: number,
): RecommendationBehavioralV4PreparedRow {
  const exactActionKey = row.observedLabel.exactActionKey;
  if (!exactActionKey) {
    throw new Error(`Decision ${row.decisionId} has no exact action key.`);
  }
  return {
    schemaVersion: RECOMMENDATION_BEHAVIORAL_V4_TRAINING_SCHEMA_VERSION,
    decisionId: row.decisionId,
    matchId: row.matchId,
    decisionOccurredAt: row.decisionOccurredAt,
    features: {
      heroId: row.heroId,
      teamId: row.teamId,
      gameTimeS: row.gameTimeS,
      timeBucket: row.timeBucket,
      inventoryStateKey: row.inventoryStateKey,
      previousActionKeys: [...row.previousActionKeys],
      previousActionTailKey: createPreviousActionTailKey(
        row.previousActionKeys,
      ),
      alliedHeroIds: [...row.alliedHeroIds],
      enemyHeroIds: [...row.enemyHeroIds],
      recommendationModel: row.recommendationModel,
      buildArchetypeId: row.buildArchetypeId,
      candidateSetPolicy: row.candidateSetPolicy,
      servedActionKey: row.servedActionKey,
      candidateActionKeys: uniqueActionKeys(
        row.candidateActions.map((action) => action.actionKey),
      ).slice(0, maxCandidateActions),
    },
    target: { actionKey: exactActionKey },
    outcomeLabel:
      row.trainingEligibility.outcome &&
      row.outcomeLabel.available &&
      !row.outcomeLabel.conflicting &&
      typeof row.outcomeLabel.playerWon === 'boolean'
        ? { playerWon: row.outcomeLabel.playerWon }
        : undefined,
  };
}

function isExactActionEligibleRow(
  row: RecommendationDecisionDatasetV4Row,
): boolean {
  return Boolean(
    row.trainingEligibility.exactAction &&
      typeof row.observedLabel.exactActionKey === 'string' &&
      row.observedLabel.exactActionKey.trim(),
  );
}

function createPreviousActionTailKey(
  previousActionKeys: readonly string[],
): string {
  const tail = previousActionKeys
    .filter((value) => typeof value === 'string' && value.trim())
    .slice(-PREVIOUS_ACTION_TAIL_LENGTH);
  return tail.length > 0 ? tail.join('>') : 'EMPTY';
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

function createModel(): RecommendationBehavioralV4Model {
  return {
    hero: new Map(),
    heroTime: new Map(),
    heroTimeInventory: new Map(),
    heroTimePreviousTail: new Map(),
    ally: new Map(),
    enemy: new Map(),
  };
}

function updateModel(
  model: RecommendationBehavioralV4Model,
  row: RecommendationBehavioralV4PreparedRow,
): void {
  const features = row.features;
  const actionKey = row.target.actionKey;
  const heroKey = String(features.heroId);
  const baseKey = `${features.heroId}|${features.timeBucket}`;
  increment(model.hero, heroKey, actionKey);
  increment(model.heroTime, baseKey, actionKey);
  increment(
    model.heroTimeInventory,
    `${baseKey}|${features.inventoryStateKey}`,
    actionKey,
  );
  increment(
    model.heroTimePreviousTail,
    `${baseKey}|${features.previousActionTailKey}`,
    actionKey,
  );
  for (const allyHeroId of features.alliedHeroIds) {
    increment(model.ally, `${baseKey}|${allyHeroId}`, actionKey);
  }
  for (const enemyHeroId of features.enemyHeroIds) {
    increment(model.enemy, `${baseKey}|${enemyHeroId}`, actionKey);
  }
}

function rankServedCandidates(
  candidates: readonly string[],
  servedActionKey: string,
): string[] {
  if (!candidates.includes(servedActionKey)) {
    return [...candidates];
  }
  return [
    servedActionKey,
    ...candidates.filter((actionKey) => actionKey !== servedActionKey),
  ];
}

function rankFrequencyCandidates(
  row: RecommendationBehavioralV4PreparedRow,
  candidates: readonly string[],
  model: RecommendationBehavioralV4Model,
  options: RecommendationBehavioralV4TrainingOptions,
): string[] {
  const features = row.features;
  const baseKey = `${features.heroId}|${features.timeBucket}`;
  const counts =
    model.heroTime.get(baseKey) ?? model.hero.get(String(features.heroId));
  return rankCandidates(candidates, (actionKey) =>
    logProbability(
      counts,
      actionKey,
      Math.max(1, candidates.length),
      options.smoothing,
    ),
  );
}

function rankBehavioralCandidates(
  row: RecommendationBehavioralV4PreparedRow,
  candidates: readonly string[],
  model: RecommendationBehavioralV4Model,
  options: RecommendationBehavioralV4TrainingOptions,
): string[] {
  const features = row.features;
  const baseKey = `${features.heroId}|${features.timeBucket}`;
  const heroCounts = model.hero.get(String(features.heroId));
  const heroTimeCounts = model.heroTime.get(baseKey);
  const baseCounts = hasMinimumObservations(
    heroTimeCounts,
    options.minContextObservations,
  )
    ? heroTimeCounts
    : heroCounts;
  return rankCandidates(candidates, (actionKey) => {
    const base = logProbability(
      baseCounts,
      actionKey,
      Math.max(1, candidates.length),
      options.smoothing,
    );
    const inventory = contextualLogProbability(
      model.heroTimeInventory.get(
        `${baseKey}|${features.inventoryStateKey}`,
      ),
      actionKey,
      candidates.length,
      options,
      base,
    );
    const previousTail = contextualLogProbability(
      model.heroTimePreviousTail.get(
        `${baseKey}|${features.previousActionTailKey}`,
      ),
      actionKey,
      candidates.length,
      options,
      base,
    );
    const allies = features.alliedHeroIds.map((allyHeroId) =>
      contextualLogProbability(
        model.ally.get(`${baseKey}|${allyHeroId}`),
        actionKey,
        candidates.length,
        options,
        base,
      ),
    );
    const enemies = features.enemyHeroIds.map((enemyHeroId) =>
      contextualLogProbability(
        model.enemy.get(`${baseKey}|${enemyHeroId}`),
        actionKey,
        candidates.length,
        options,
        base,
      ),
    );
    return (
      base +
      0.55 * (inventory - base) +
      0.35 * (previousTail - base) +
      0.08 * (averageOr(allies, base) - base) +
      0.12 * (averageOr(enemies, base) - base)
    );
  });
}

function contextualLogProbability(
  counts: CountMap | undefined,
  actionKey: string,
  candidateCount: number,
  options: RecommendationBehavioralV4TrainingOptions,
  fallback: number,
): number {
  if (!hasMinimumObservations(counts, options.minContextObservations)) {
    return fallback;
  }
  return logProbability(
    counts,
    actionKey,
    Math.max(1, candidateCount),
    options.smoothing,
  );
}

function hasMinimumObservations(
  counts: CountMap | undefined,
  minimum: number,
): counts is CountMap {
  return Boolean(counts && totalCount(counts) >= minimum);
}

function rankCandidates(
  candidates: readonly string[],
  score: (actionKey: string) => number,
): string[] {
  return [...candidates]
    .map((actionKey) => ({ actionKey, score: score(actionKey) }))
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.actionKey.localeCompare(right.actionKey),
    )
    .map((value) => value.actionKey);
}

function emptyMetrics(): RawMetrics {
  return {
    evaluatedDecisionCount: 0,
    top1Count: 0,
    top3Count: 0,
    reciprocalRankSum: 0,
  };
}

function updateMetrics(
  metrics: RawMetrics,
  ranking: readonly string[],
  actualActionKey: string,
): void {
  metrics.evaluatedDecisionCount += 1;
  const index = ranking.indexOf(actualActionKey);
  metrics.top1Count += index === 0 ? 1 : 0;
  metrics.top3Count += index >= 0 && index < 3 ? 1 : 0;
  metrics.reciprocalRankSum += index >= 0 ? 1 / (index + 1) : 0;
}

function finalizeMetrics(metrics: RawMetrics): FinalizedMetrics {
  return {
    evaluatedDecisionCount: metrics.evaluatedDecisionCount,
    top1Rate: divide(metrics.top1Count, metrics.evaluatedDecisionCount),
    top3Rate: divide(metrics.top3Count, metrics.evaluatedDecisionCount),
    meanReciprocalRank: divide(
      metrics.reciprocalRankSum,
      metrics.evaluatedDecisionCount,
    ),
  };
}

function buildEvaluation(input: {
  servedMetrics: RawMetrics;
  frequencyMetrics: RawMetrics;
  behavioralMetrics: RawMetrics;
  validationRows: number;
  coveredValidationRows: number;
  emptyCandidateSetRows: number;
  options: RecommendationBehavioralV4TrainingOptions;
  generatedAt: string;
}): Record<string, unknown> {
  const served = finalizeMetrics(input.servedMetrics);
  const frequency = finalizeMetrics(input.frequencyMetrics);
  const behavioral = finalizeMetrics(input.behavioralMetrics);
  const coverageRate = divide(
    input.coveredValidationRows,
    input.validationRows,
  );
  const bestBaselineTop1 = Math.max(served.top1Rate, frequency.top1Rate);
  const bestBaselineTop3 = Math.max(served.top3Rate, frequency.top3Rate);
  const bestBaselineMrr = Math.max(
    served.meanReciprocalRank,
    frequency.meanReciprocalRank,
  );
  const deltas = {
    top1VsServed: behavioral.top1Rate - served.top1Rate,
    top1VsFrequency: behavioral.top1Rate - frequency.top1Rate,
    top1VsBestBaseline: behavioral.top1Rate - bestBaselineTop1,
    top3VsBestBaseline: behavioral.top3Rate - bestBaselineTop3,
    meanReciprocalRankVsBestBaseline:
      behavioral.meanReciprocalRank - bestBaselineMrr,
  };
  const reasons: string[] = [];
  if (input.validationRows < 50) {
    reasons.push('Validation contains fewer than 50 exact-action decisions.');
  }
  if (coverageRate < 0.9) {
    reasons.push('Recorded candidate coverage is below 90%.');
  }
  if (deltas.top1VsBestBaseline < 0.005) {
    reasons.push(
      'Behavioral Top-1 improvement over the best baseline is below 0.50 percentage points.',
    );
  }
  if (deltas.top3VsBestBaseline < -0.005) {
    reasons.push(
      'Behavioral Top-3 regression against the best baseline exceeds 0.50 percentage points.',
    );
  }
  if (deltas.meanReciprocalRankVsBestBaseline < 0) {
    reasons.push(
      'Behavioral mean reciprocal rank is below the best baseline.',
    );
  }
  return {
    schemaVersion: RECOMMENDATION_BEHAVIORAL_V4_TRAINING_SCHEMA_VERSION,
    modelVersion: RECOMMENDATION_BEHAVIORAL_V4_MODEL_VERSION,
    generatedAt: input.generatedAt,
    split: 'VALIDATION',
    target: 'OBSERVED_EXACT_NEXT_ACTION',
    candidateSetPolicy: 'RECORDED_AT_DECISION_TIME',
    maxCandidateActions: input.options.maxCandidateActions,
    validationDecisionCount: input.validationRows,
    candidateCoveredDecisionCount: input.coveredValidationRows,
    candidateCoverageRate: coverageRate,
    emptyCandidateSetRowCount: input.emptyCandidateSetRows,
    servedBaseline: served,
    frequencyBaseline: frequency,
    behavioral,
    deltas,
    releaseGate: {
      minimumValidationDecisionCount: 50,
      minimumCandidateCoverageRate: 0.9,
      minimumTop1DeltaVsBestBaseline: 0.005,
      maximumTop3RegressionVsBestBaseline: 0.005,
      minimumMeanReciprocalRankDeltaVsBestBaseline: 0,
      passed: reasons.length === 0,
      reasons,
    },
  };
}

async function buildManifest(input: {
  sourceManifest: RecommendationDecisionDatasetV4Manifest;
  sourceDirectory: string;
  sourceSha256: string;
  options: RecommendationBehavioralV4TrainingOptions;
  split: RecommendationBehavioralV4ChronologicalSplit;
  trainRows: number;
  validationRows: number;
  eligibleRows: number;
  excludedRows: number;
  generatedAt: string;
  evaluation: Record<string, unknown>;
  paths: TrainingArtifacts;
  auditPassed: boolean;
  warnings: string[];
}): Promise<Record<string, unknown>> {
  const artifacts = await artifactMetadata(input.paths);
  return {
    schemaVersion: RECOMMENDATION_BEHAVIORAL_V4_TRAINING_SCHEMA_VERSION,
    modelVersion: RECOMMENDATION_BEHAVIORAL_V4_MODEL_VERSION,
    generatedAt: input.generatedAt,
    source: {
      datasetVersion: input.sourceManifest.datasetVersion,
      directory: input.sourceDirectory,
      artifactSha256: input.sourceSha256,
      sourceRowCount: input.sourceManifest.artifact.rowCount,
      exactActionEligibleRowCount: input.eligibleRows,
      excludedRowCount: input.excludedRows,
    },
    split: {
      strategy: 'CHRONOLOGICAL_MATCH_LEVEL',
      trainFraction: input.options.trainFraction,
      trainMatchCount: input.split.train.length,
      validationMatchCount: input.split.validation.length,
      trainRowCount: input.trainRows,
      validationRowCount: input.validationRows,
      validationStartsAt: input.split.validation[0]?.firstDecisionOccurredAt,
    },
    training: {
      target: 'OBSERVED_EXACT_NEXT_ACTION',
      eligibility: 'trainingEligibility.exactAction === true',
      candidateSetPolicy: 'RECORDED_AT_DECISION_TIME',
      outcomeUsedForBehavioralTraining: false,
      options: input.options,
    },
    artifacts,
    evaluationSummary: {
      candidateCoverageRate: toNumber(input.evaluation.candidateCoverageRate),
      releaseGate: input.evaluation.releaseGate,
    },
    auditPassed: input.auditPassed,
    warnings: [...input.warnings],
  };
}

async function artifactMetadata(
  paths: TrainingArtifacts,
): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = {};
  for (const [name, path] of Object.entries(paths)) {
    if (name === 'manifest' || name === 'audit') {
      continue;
    }
    const metadata = await stat(path);
    result[name] = {
      fileName: path.split('/').pop(),
      byteLength: metadata.size,
      sha256: await hashFile(path),
    };
  }
  return result;
}

function serializeModel(
  model: RecommendationBehavioralV4Model,
): Record<string, Record<string, Record<string, number>>> {
  return {
    hero: serializeCountTable(model.hero),
    heroTime: serializeCountTable(model.heroTime),
    heroTimeInventory: serializeCountTable(model.heroTimeInventory),
    heroTimePreviousTail: serializeCountTable(
      model.heroTimePreviousTail,
    ),
    ally: serializeCountTable(model.ally),
    enemy: serializeCountTable(model.enemy),
  };
}

function serializeCountTable(
  table: CountTable,
): Record<string, Record<string, number>> {
  const result: Record<string, Record<string, number>> = {};
  for (const [contextKey, counts] of [...table.entries()].sort(
    ([left], [right]) => left.localeCompare(right),
  )) {
    result[contextKey] = Object.fromEntries(
      [...counts.entries()].sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    );
  }
  return result;
}

function increment(
  table: CountTable,
  contextKey: string,
  actionKey: string,
): void {
  const counts = table.get(contextKey) ?? new Map<string, number>();
  counts.set(actionKey, (counts.get(actionKey) ?? 0) + 1);
  table.set(contextKey, counts);
}

function totalCount(counts: CountMap): number {
  let total = 0;
  for (const count of counts.values()) {
    total += count;
  }
  return total;
}

function logProbability(
  counts: CountMap | undefined,
  actionKey: string,
  vocabularySize: number,
  smoothing: number,
): number {
  const count = counts?.get(actionKey) ?? 0;
  const total = counts ? totalCount(counts) : 0;
  return Math.log(
    (count + smoothing) /
      (total + smoothing * Math.max(1, vocabularySize)),
  );
}

function averageOr(values: readonly number[], fallback: number): number {
  return values.length > 0
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : fallback;
}

function divide(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

function normalizeOptions(
  request: RecommendationBehavioralV4TrainingStartRequest,
): RecommendationBehavioralV4TrainingOptions {
  return {
    trainFraction: normalizeNumber(
      request.trainFraction,
      'trainFraction',
      0.8,
      0.5,
      0.95,
    ),
    smoothing: normalizeNumber(
      request.smoothing,
      'smoothing',
      1,
      0.01,
      100,
    ),
    minContextObservations: normalizeInteger(
      request.minContextObservations,
      'minContextObservations',
      5,
      1,
      10_000,
    ),
    maxCandidateActions: normalizeInteger(
      request.maxCandidateActions,
      'maxCandidateActions',
      128,
      2,
      512,
    ),
    expectedSourceSha256: normalizeSha256(request.expectedSourceSha256),
  };
}

function normalizeNumber(
  value: number | undefined,
  fieldName: string,
  defaultValue: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined) {
    return defaultValue;
  }
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(
      `${fieldName} must be a finite number from ${minimum} to ${maximum}.`,
    );
  }
  return value;
}

function normalizeInteger(
  value: number | undefined,
  fieldName: string,
  defaultValue: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined) {
    return defaultValue;
  }
  if (
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error(
      `${fieldName} must be a safe integer from ${minimum} to ${maximum}.`,
    );
  }
  return value;
}

function normalizeSha256(value: string | undefined): string | undefined {
  if (value === undefined || !value.trim()) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new Error('expectedSourceSha256 must be a 64-character SHA-256.');
  }
  return normalized;
}

function validateSourceArtifacts(
  manifest: RecommendationDecisionDatasetV4Manifest,
  audit: RecommendationDecisionDatasetV4Audit,
): void {
  if (manifest.datasetVersion !== RECOMMENDATION_DECISION_DATASET_V4_VERSION) {
    throw new Error(
      `Unsupported source dataset version: ${manifest.datasetVersion}.`,
    );
  }
  if (!manifest.auditPassed || !audit.passed) {
    throw new Error('Recommendation Decision Dataset V4 did not pass audit.');
  }
  if (manifest.artifact.rowCount <= 0) {
    throw new Error('Recommendation Decision Dataset V4 contains no rows.');
  }
  if (audit.rows.exactActionEligibleCount <= 0) {
    throw new Error(
      'Recommendation Decision Dataset V4 contains no exact-action eligible rows.',
    );
  }
}

async function eachSourceRow(
  path: string,
  visitor: (
    row: RecommendationDecisionDatasetV4Row,
  ) => Promise<void> | void,
): Promise<void> {
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
      throw new Error(`Invalid JSON at source dataset line ${lineNumber}.`);
    }
    if (!isSourceRow(value)) {
      throw new Error(`Invalid V4 source row at line ${lineNumber}.`);
    }
    await visitor(value);
  }
}

function isSourceRow(
  value: unknown,
): value is RecommendationDecisionDatasetV4Row {
  if (!isRecord(value)) {
    return false;
  }
  return (
    value.datasetVersion === RECOMMENDATION_DECISION_DATASET_V4_VERSION &&
    typeof value.decisionId === 'string' &&
    typeof value.matchId === 'string' &&
    typeof value.decisionOccurredAt === 'string' &&
    Number.isSafeInteger(Number(value.heroId)) &&
    Array.isArray(value.candidateActions) &&
    isRecord(value.observedLabel) &&
    isRecord(value.trainingEligibility)
  );
}

function parseTimestamp(value: string): number {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) {
    throw new Error(`Invalid decision timestamp: ${value}.`);
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

async function readJson(path: string): Promise<Record<string, unknown> | undefined> {
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

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isErrorWithCode(
  value: unknown,
): value is Error & { code: string } {
  return isRecord(value) && typeof value.code === 'string';
}

function toNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function yieldToEventLoop(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
