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
import {
  RECOMMENDATION_DECISION_DATASET_V4_VERSION,
  type RecommendationDecisionDatasetV4Audit,
  type RecommendationDecisionDatasetV4Manifest,
  type RecommendationDecisionDatasetV4Row,
} from './recommendation-decision-dataset-v4.service';

export const RECOMMENDATION_VALUE_V4_TRAINING_SCHEMA_VERSION = 1;
export const RECOMMENDATION_VALUE_V4_MODEL_VERSION =
  'RECOMMENDATION_VALUE_V4_CONTEXTUAL_LOGIT_RESIDUAL_2' as const;

const DEFAULT_SOURCE_DIRECTORY =
  '/app/apps/api/storage/recommendation-decision-dataset-v4';
const DEFAULT_OUTPUT_DIRECTORY =
  '/app/apps/api/storage/recommendation-value-v4-training';
const SOURCE_DIRECTORY_ENV = 'DEADLOCK_RECOMMENDATION_VALUE_V4_SOURCE_DIR';
const OUTPUT_DIRECTORY_ENV = 'DEADLOCK_RECOMMENDATION_VALUE_V4_TRAINING_DIR';
const BUFFER_LIMIT_BYTES = 1024 * 1024;
const PREVIOUS_ACTION_TAIL_SIZE = 4;
const EPSILON = 1e-9;

export interface RecommendationValueV4TrainingStartRequest {
  trainFraction?: number;
  priorStrength?: number;
  minContextObservations?: number;
  calibrationBinCount?: number;
  expectedSourceSha256?: string;
}

export interface RecommendationValueV4TrainingOptions {
  trainFraction: number;
  priorStrength: number;
  minContextObservations: number;
  calibrationBinCount: number;
  expectedSourceSha256?: string;
}

export type RecommendationValueV4TrainingState =
  | 'IDLE'
  | 'RUNNING'
  | 'COMPLETE'
  | 'FAILED';

export type RecommendationValueV4TrainingPhase =
  | 'PREPARING'
  | 'SPLITTING'
  | 'TRAINING'
  | 'EVALUATING'
  | 'FINALIZING'
  | 'COMPLETE';

export interface RecommendationValueV4TrainingStatus {
  state: RecommendationValueV4TrainingState;
  phase: RecommendationValueV4TrainingPhase;
  currentPass: number;
  totalPasses: number;
  sourceRowCount: number;
  eligibleSourceRowCount: number;
  excludedSourceRowCount: number;
  processedRowCount: number;
  sourceMatchCount: number;
  trainMatchCount: number;
  validationMatchCount: number;
  trainRowCount: number;
  validationRowCount: number;
  outputDirectory: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  options?: RecommendationValueV4TrainingOptions;
  manifestAvailable: boolean;
  auditAvailable: boolean;
  evaluationAvailable: boolean;
  modelAvailable: boolean;
}

export interface RecommendationValueV4MatchDescriptor {
  matchId: string;
  firstDecisionOccurredAt: string;
}

export interface RecommendationValueV4ChronologicalSplit {
  train: RecommendationValueV4MatchDescriptor[];
  validation: RecommendationValueV4MatchDescriptor[];
}

export interface RecommendationValueV4PreparedRow {
  schemaVersion: typeof RECOMMENDATION_VALUE_V4_TRAINING_SCHEMA_VERSION;
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
    actionKey: string;
  };
  target: {
    playerWon: boolean;
  };
}

interface BinaryCount {
  wins: number;
  total: number;
}

type BinaryCountTable = Map<string, BinaryCount>;

interface RecommendationValueV4Model {
  global: BinaryCount;
  hero: BinaryCountTable;
  heroTime: BinaryCountTable;
  heroTeamTime: BinaryCountTable;
  heroTimeInventory: BinaryCountTable;
  heroTimePreviousTail: BinaryCountTable;
  ally: BinaryCountTable;
  enemy: BinaryCountTable;
  heroTimeAction: BinaryCountTable;
  heroTimeInventoryAction: BinaryCountTable;
  heroTimePreviousTailAction: BinaryCountTable;
  allyAction: BinaryCountTable;
  enemyAction: BinaryCountTable;
}

interface SourcePassSummary {
  sourceRows: number;
  eligibleRows: number;
  excludedRows: number;
  duplicateEligibleDecisionCount: number;
  conflictingEligibleMatchOutcomeCount: number;
  matches: RecommendationValueV4MatchDescriptor[];
}

interface PredictionObservation {
  probability: number;
  outcome: boolean;
  matchId: string;
}

interface FinalizedProbabilityMetrics {
  evaluatedDecisionCount: number;
  evaluatedMatchCount: number;
  positiveDecisionCount: number;
  negativeDecisionCount: number;
  logLoss: number;
  brierScore: number;
  accuracy: number;
  averagePrediction: number;
  observedWinRate: number;
  rocAuc: number;
  calibration: {
    binCount: number;
    expectedCalibrationError: number;
    maximumCalibrationGap: number;
    bins: Array<{
      lowerBound: number;
      upperBound: number;
      decisionCount: number;
      averagePrediction: number;
      observedWinRate: number;
      absoluteGap: number;
    }>;
  };
}

interface TrainingArtifacts {
  train: string;
  validation: string;
  predictionEvaluation: string;
  model: string;
  evaluation: string;
  audit: string;
  manifest: string;
}

@Injectable()
export class RecommendationValueV4TrainingService implements OnModuleInit {
  private readonly logger = new Logger(
    RecommendationValueV4TrainingService.name,
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
    predictionEvaluation: join(
      this.outputDirectory,
      'prediction-evaluation.ndjson',
    ),
    model: join(this.outputDirectory, 'model.json'),
    evaluation: join(this.outputDirectory, 'evaluation.json'),
    audit: join(this.outputDirectory, 'audit.json'),
    manifest: join(this.outputDirectory, 'manifest.json'),
  };
  private status = this.createIdleStatus();
  private manifest?: Record<string, unknown>;
  private audit?: Record<string, unknown>;
  private evaluation?: Record<string, unknown>;
  private modelArtifact?: Record<string, unknown>;
  private runPromise: Promise<void> = Promise.resolve();

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
        sourceMatchCount: toNumber(source.eligibleMatchCount),
        trainMatchCount: toNumber(split.trainMatchCount),
        validationMatchCount: toNumber(split.validationMatchCount),
        trainRowCount: toNumber(split.trainRowCount),
        validationRowCount: toNumber(split.validationRowCount),
        completedAt: String(this.manifest.generatedAt ?? ''),
        manifestAvailable: true,
        auditAvailable: true,
        evaluationAvailable: true,
        modelAvailable: true,
      };
    }
  }

  async start(
    request: RecommendationValueV4TrainingStartRequest = {},
  ): Promise<RecommendationValueV4TrainingStatus> {
    if (this.status.state === 'RUNNING') {
      throw new Error('Recommendation Value V4 training is already running.');
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

  getStatus(): RecommendationValueV4TrainingStatus {
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

  private async run(options: RecommendationValueV4TrainingOptions): Promise<void> {
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
      if (passSummary.eligibleRows !== sourceAudit.rows.outcomeEligibleCount) {
        throw new Error(
          'Outcome-eligible row count does not match the source audit.',
        );
      }
      if (passSummary.duplicateEligibleDecisionCount > 0) {
        throw new Error(
          'The outcome-eligible source subset contains duplicate decision IDs.',
        );
      }
      if (passSummary.conflictingEligibleMatchOutcomeCount > 0) {
        throw new Error(
          'The outcome-eligible source subset contains conflicting outcomes for one player within a match.',
        );
      }
      const split = selectRecommendationValueV4ChronologicalSplit(
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
      let processedTrainingRows = 0;
      try {
        await eachSourceRow(this.sourceDatasetPath, async (row) => {
          processedTrainingRows += 1;
          if (!isRecommendationValueV4OutcomeEligibleRow(row)) {
            return;
          }
          if (trainMatchIds.has(row.matchId)) {
            const prepared = prepareRecommendationValueV4Row(row);
            updateModel(model, prepared);
            await trainWriter.write(prepared);
            trainRows += 1;
          } else if (!validationMatchIds.has(row.matchId)) {
            throw new Error(`Match ${row.matchId} was not assigned to a split.`);
          }
          if (processedTrainingRows % 1_000 === 0) {
            this.status = {
              ...this.status,
              processedRowCount: processedTrainingRows,
              trainRowCount: trainRows,
            };
          }
          if (processedTrainingRows % 10_000 === 0) {
            await yieldToEventLoop();
          }
        });
      } finally {
        await trainWriter.close();
      }
      await promote(this.paths.train);
      if (trainRows <= 0 || model.global.total <= 0) {
        throw new Error('Recommendation Value V4 training split contains no rows.');
      }

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
      const predictionWriter = await LineWriter.create(
        `${this.paths.predictionEvaluation}.partial`,
      );
      const globalObservations: PredictionObservation[] = [];
      const heroTimeObservations: PredictionObservation[] = [];
      const valueObservations: PredictionObservation[] = [];
      let validationRows = 0;
      let processedEvaluationRows = 0;
      try {
        await eachSourceRow(this.sourceDatasetPath, async (row) => {
          processedEvaluationRows += 1;
          if (
            !isRecommendationValueV4OutcomeEligibleRow(row) ||
            !validationMatchIds.has(row.matchId)
          ) {
            return;
          }
          const prepared = prepareRecommendationValueV4Row(row);
          const globalProbability = predictGlobal(model);
          const heroTimeProbability = predictHeroTime(
            model,
            prepared,
            options,
          );
          const valueProbability = predictValue(model, prepared, options);
          const outcome = prepared.target.playerWon;
          globalObservations.push({
            probability: globalProbability,
            outcome,
            matchId: prepared.matchId,
          });
          heroTimeObservations.push({
            probability: heroTimeProbability,
            outcome,
            matchId: prepared.matchId,
          });
          valueObservations.push({
            probability: valueProbability,
            outcome,
            matchId: prepared.matchId,
          });
          await validationWriter.write(prepared);
          await predictionWriter.write({
            schemaVersion: RECOMMENDATION_VALUE_V4_TRAINING_SCHEMA_VERSION,
            decisionId: prepared.decisionId,
            matchId: prepared.matchId,
            actionKey: prepared.features.actionKey,
            playerWon: outcome,
            globalProbability,
            heroTimeProbability,
            valueProbability,
          });
          validationRows += 1;
          if (processedEvaluationRows % 1_000 === 0) {
            this.status = {
              ...this.status,
              processedRowCount: processedEvaluationRows,
              validationRowCount: validationRows,
            };
          }
          if (processedEvaluationRows % 10_000 === 0) {
            await yieldToEventLoop();
          }
        });
      } finally {
        await Promise.all([
          validationWriter.close(),
          predictionWriter.close(),
        ]);
      }
      await Promise.all([
        promote(this.paths.validation),
        promote(this.paths.predictionEvaluation),
      ]);
      if (trainRows + validationRows !== passSummary.eligibleRows) {
        throw new Error(
          'Train and validation rows do not cover the outcome-eligible source subset.',
        );
      }

      const generatedAt = new Date().toISOString();
      const serializedModel = {
        schemaVersion: RECOMMENDATION_VALUE_V4_TRAINING_SCHEMA_VERSION,
        modelVersion: RECOMMENDATION_VALUE_V4_MODEL_VERSION,
        generatedAt,
        modelKind: 'OBSERVATIONAL_WIN_PROBABILITY',
        target: 'PLAYER_WON',
        featureCutoff: 'DECISION_SERVED_TIME_PLUS_HYPOTHETICAL_ACTION',
        causalInterpretationAllowed: false,
        options,
        combination: 'SHRUNK_CONTEXT_LOGIT_RESIDUALS',
        maximumAbsoluteLogitResidual: 1.5,
        weights: {
          heroTeamTime: 0.7,
          inventory: 0.35,
          previousActionTail: 0.2,
          alliedRosterAverage: 0.12,
          enemyRosterAverage: 0.18,
          heroTimeAction: 0.45,
          inventoryAction: 0.2,
          previousActionTailAction: 0.12,
          alliedRosterActionAverage: 0.05,
          enemyRosterActionAverage: 0.08,
        },
        counts: serializeModel(model, options.minContextObservations),
      };
      const evaluation = buildEvaluation({
        globalObservations,
        heroTimeObservations,
        valueObservations,
        validationMatchCount: validationMatchIds.size,
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
        'actionKey',
      ];
      const forbiddenFields = [
        'playerWon',
        'outcomeLabel',
        'observedInventoryStateKey',
        'observedAtGameTimeS',
        'observationDelayS',
        'servedActionKey',
        'candidateActions',
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
          `${passSummary.excludedRows} source rows were excluded because they were not outcome eligible.`,
        );
      }
      if (validationMatchIds.size < 20) {
        warnings.push('Validation contains fewer than 20 matches.');
      }
      if (!releaseGate.passed) {
        warnings.push(
          'The validation release gate failed; the value model must not be used for policy selection.',
        );
      }
      warnings.push(
        'The value model is observational and must not be interpreted as a causal action uplift estimate.',
      );
      const audit = {
        schemaVersion: RECOMMENDATION_VALUE_V4_TRAINING_SCHEMA_VERSION,
        generatedAt,
        passed:
          sourceAudit.passed &&
          passSummary.sourceRows === sourceManifest.artifact.rowCount &&
          passSummary.eligibleRows === sourceAudit.rows.outcomeEligibleCount &&
          trainRows + validationRows === passSummary.eligibleRows &&
          passSummary.duplicateEligibleDecisionCount === 0 &&
          passSummary.conflictingEligibleMatchOutcomeCount === 0 &&
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
          conflictingEligibleMatchOutcomeCount:
            passSummary.conflictingEligibleMatchOutcomeCount,
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
        leakage: {
          featureCutoff: 'DECISION_SERVED_TIME_PLUS_HYPOTHETICAL_ACTION',
          featureFields,
          forbiddenFields,
          forbiddenFieldsPresent,
          targetFields: ['target.playerWon'],
          actionField: 'features.actionKey',
          causalInterpretationAllowed: false,
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
        `Recommendation Value V4 training completed: ${trainRows} train rows, ` +
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
      this.logger.error(`Recommendation Value V4 training failed: ${message}`);
    }
  }

  private async collectSplitDescriptors(): Promise<SourcePassSummary> {
    const matches = new Map<string, RecommendationValueV4MatchDescriptor>();
    const outcomesByMatchPlayer = new Map<string, boolean>();
    const eligibleDecisionIds = new Set<string>();
    let sourceRows = 0;
    let eligibleRows = 0;
    let duplicateEligibleDecisionCount = 0;
    let conflictingEligibleMatchOutcomeCount = 0;
    await eachSourceRow(this.sourceDatasetPath, async (row) => {
      sourceRows += 1;
      if (!isRecommendationValueV4OutcomeEligibleRow(row)) {
        return;
      }
      eligibleRows += 1;
      if (eligibleDecisionIds.has(row.decisionId)) {
        duplicateEligibleDecisionCount += 1;
      }
      eligibleDecisionIds.add(row.decisionId);
      const outcome = Boolean(row.outcomeLabel.playerWon);
      const matchPlayerKey = `${row.matchId}\u0000${row.steamId}\u0000${row.teamId ?? 'UNKNOWN_TEAM'}`;
      const existingOutcome = outcomesByMatchPlayer.get(matchPlayerKey);
      if (existingOutcome !== undefined && existingOutcome !== outcome) {
        conflictingEligibleMatchOutcomeCount += 1;
      } else {
        outcomesByMatchPlayer.set(matchPlayerKey, outcome);
      }
      const existing = matches.get(row.matchId);
      if (
        !existing ||
        parseTimestamp(row.decisionOccurredAt) <
          parseTimestamp(existing.firstDecisionOccurredAt)
      ) {
        matches.set(row.matchId, {
          matchId: row.matchId,
          firstDecisionOccurredAt: row.decisionOccurredAt,
        });
      }
      if (sourceRows % 10_000 === 0) {
        this.status = { ...this.status, processedRowCount: sourceRows };
        await yieldToEventLoop();
      }
    });
    return {
      sourceRows,
      eligibleRows,
      excludedRows: sourceRows - eligibleRows,
      duplicateEligibleDecisionCount,
      conflictingEligibleMatchOutcomeCount,
      matches: [...matches.values()],
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

  private createIdleStatus(): RecommendationValueV4TrainingStatus {
    return {
      state: 'IDLE',
      phase: 'PREPARING',
      currentPass: 0,
      totalPasses: 3,
      sourceRowCount: 0,
      eligibleSourceRowCount: 0,
      excludedSourceRowCount: 0,
      processedRowCount: 0,
      sourceMatchCount: 0,
      trainMatchCount: 0,
      validationMatchCount: 0,
      trainRowCount: 0,
      validationRowCount: 0,
      outputDirectory: this.outputDirectory,
      manifestAvailable: false,
      auditAvailable: false,
      evaluationAvailable: false,
      modelAvailable: false,
    };
  }
}

export function selectRecommendationValueV4ChronologicalSplit(
  descriptors: readonly RecommendationValueV4MatchDescriptor[],
  trainFraction: number,
): RecommendationValueV4ChronologicalSplit {
  if (descriptors.length < 2) {
    throw new Error('At least two outcome-eligible matches are required.');
  }
  if (!Number.isFinite(trainFraction) || trainFraction <= 0 || trainFraction >= 1) {
    throw new Error('trainFraction must be greater than zero and less than one.');
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

export function isRecommendationValueV4OutcomeEligibleRow(
  row: RecommendationDecisionDatasetV4Row,
): boolean {
  return Boolean(
    row.trainingEligibility.exactAction &&
      row.trainingEligibility.outcome &&
      row.observedLabel.reconstructionConfidence === 'EXACT_SINGLE_ACTION' &&
      typeof row.observedLabel.exactActionKey === 'string' &&
      row.observedLabel.exactActionKey.trim() &&
      row.outcomeLabel.available &&
      !row.outcomeLabel.conflicting &&
      typeof row.outcomeLabel.playerWon === 'boolean',
  );
}

export function prepareRecommendationValueV4Row(
  row: RecommendationDecisionDatasetV4Row,
): RecommendationValueV4PreparedRow {
  if (!isRecommendationValueV4OutcomeEligibleRow(row)) {
    throw new Error(`Decision ${row.decisionId} is not outcome eligible.`);
  }
  const actionKey = row.observedLabel.exactActionKey?.trim() ?? '';
  return {
    schemaVersion: RECOMMENDATION_VALUE_V4_TRAINING_SCHEMA_VERSION,
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
      actionKey,
    },
    target: {
      playerWon: Boolean(row.outcomeLabel.playerWon),
    },
  };
}

function createPreviousActionTailKey(actionKeys: readonly string[]): string {
  const values = actionKeys
    .slice(-PREVIOUS_ACTION_TAIL_SIZE)
    .map((value) => value.trim())
    .filter(Boolean);
  return values.length > 0 ? values.join('>') : 'EMPTY';
}

function createModel(): RecommendationValueV4Model {
  return {
    global: { wins: 0, total: 0 },
    hero: new Map(),
    heroTime: new Map(),
    heroTeamTime: new Map(),
    heroTimeInventory: new Map(),
    heroTimePreviousTail: new Map(),
    ally: new Map(),
    enemy: new Map(),
    heroTimeAction: new Map(),
    heroTimeInventoryAction: new Map(),
    heroTimePreviousTailAction: new Map(),
    allyAction: new Map(),
    enemyAction: new Map(),
  };
}

function updateModel(
  model: RecommendationValueV4Model,
  row: RecommendationValueV4PreparedRow,
): void {
  const features = row.features;
  const won = row.target.playerWon;
  incrementBinaryCount(model.global, won);
  const heroKey = String(features.heroId);
  const baseKey = `${features.heroId}|${features.timeBucket}`;
  const teamKey = `${baseKey}|${features.teamId ?? 'UNKNOWN_TEAM'}`;
  const actionKey = features.actionKey;
  incrementBinaryTable(model.hero, heroKey, won);
  incrementBinaryTable(model.heroTime, baseKey, won);
  incrementBinaryTable(model.heroTeamTime, teamKey, won);
  incrementBinaryTable(
    model.heroTimeInventory,
    `${baseKey}|${features.inventoryStateKey}`,
    won,
  );
  incrementBinaryTable(
    model.heroTimePreviousTail,
    `${baseKey}|${features.previousActionTailKey}`,
    won,
  );
  for (const allyHeroId of features.alliedHeroIds) {
    incrementBinaryTable(model.ally, `${baseKey}|${allyHeroId}`, won);
  }
  for (const enemyHeroId of features.enemyHeroIds) {
    incrementBinaryTable(model.enemy, `${baseKey}|${enemyHeroId}`, won);
  }
  incrementBinaryTable(model.heroTimeAction, `${baseKey}|${actionKey}`, won);
  incrementBinaryTable(
    model.heroTimeInventoryAction,
    `${baseKey}|${features.inventoryStateKey}|${actionKey}`,
    won,
  );
  incrementBinaryTable(
    model.heroTimePreviousTailAction,
    `${baseKey}|${features.previousActionTailKey}|${actionKey}`,
    won,
  );
  for (const allyHeroId of features.alliedHeroIds) {
    incrementBinaryTable(
      model.allyAction,
      `${baseKey}|${allyHeroId}|${actionKey}`,
      won,
    );
  }
  for (const enemyHeroId of features.enemyHeroIds) {
    incrementBinaryTable(
      model.enemyAction,
      `${baseKey}|${enemyHeroId}|${actionKey}`,
      won,
    );
  }
}

function predictGlobal(model: RecommendationValueV4Model): number {
  return clampProbability(
    (model.global.wins + 1) / (model.global.total + 2),
  );
}

function predictHeroTime(
  model: RecommendationValueV4Model,
  row: RecommendationValueV4PreparedRow,
  options: RecommendationValueV4TrainingOptions,
): number {
  const globalProbability = predictGlobal(model);
  const heroProbability = posteriorProbability(
    model.hero.get(String(row.features.heroId)),
    globalProbability,
    options.priorStrength,
  );
  const heroTimeCount = model.heroTime.get(
    `${row.features.heroId}|${row.features.timeBucket}`,
  );
  return hasMinimumObservations(
    heroTimeCount,
    options.minContextObservations,
  )
    ? posteriorProbability(
        heroTimeCount,
        heroProbability,
        options.priorStrength,
      )
    : heroProbability;
}

function predictValue(
  model: RecommendationValueV4Model,
  row: RecommendationValueV4PreparedRow,
  options: RecommendationValueV4TrainingOptions,
): number {
  const features = row.features;
  const baseKey = `${features.heroId}|${features.timeBucket}`;
  const base = predictHeroTime(model, row, options);
  const baseLogit = probabilityLogit(base);
  let residual = 0;
  const addResidual = (
    count: BinaryCount | undefined,
    weight: number,
  ): void => {
    if (!hasMinimumObservations(count, options.minContextObservations)) {
      return;
    }
    const probability = posteriorProbability(
      count,
      base,
      options.priorStrength,
    );
    residual += weight * (probabilityLogit(probability) - baseLogit);
  };
  const addAverageResidual = (
    counts: readonly (BinaryCount | undefined)[],
    weight: number,
  ): void => {
    const deltas = counts
      .filter((count) =>
        hasMinimumObservations(count, options.minContextObservations),
      )
      .map((count) =>
        probabilityLogit(
          posteriorProbability(count, base, options.priorStrength),
        ) - baseLogit,
      );
    if (deltas.length > 0) {
      residual += weight * average(deltas);
    }
  };

  addResidual(
    model.heroTeamTime.get(
      `${baseKey}|${features.teamId ?? 'UNKNOWN_TEAM'}`,
    ),
    0.7,
  );
  addResidual(
    model.heroTimeInventory.get(`${baseKey}|${features.inventoryStateKey}`),
    0.35,
  );
  addResidual(
    model.heroTimePreviousTail.get(
      `${baseKey}|${features.previousActionTailKey}`,
    ),
    0.2,
  );
  addAverageResidual(
    features.alliedHeroIds.map((heroId) =>
      model.ally.get(`${baseKey}|${heroId}`),
    ),
    0.12,
  );
  addAverageResidual(
    features.enemyHeroIds.map((heroId) =>
      model.enemy.get(`${baseKey}|${heroId}`),
    ),
    0.18,
  );
  addResidual(
    model.heroTimeAction.get(`${baseKey}|${features.actionKey}`),
    0.45,
  );
  addResidual(
    model.heroTimeInventoryAction.get(
      `${baseKey}|${features.inventoryStateKey}|${features.actionKey}`,
    ),
    0.2,
  );
  addResidual(
    model.heroTimePreviousTailAction.get(
      `${baseKey}|${features.previousActionTailKey}|${features.actionKey}`,
    ),
    0.12,
  );
  addAverageResidual(
    features.alliedHeroIds.map((heroId) =>
      model.allyAction.get(`${baseKey}|${heroId}|${features.actionKey}`),
    ),
    0.05,
  );
  addAverageResidual(
    features.enemyHeroIds.map((heroId) =>
      model.enemyAction.get(`${baseKey}|${heroId}|${features.actionKey}`),
    ),
    0.08,
  );

  return clampProbability(
    probabilityFromLogit(baseLogit + clamp(residual, -1.5, 1.5)),
  );
}

function probabilityLogit(probability: number): number {
  const normalized = clampProbability(probability);
  return Math.log(normalized / (1 - normalized));
}

function probabilityFromLogit(value: number): number {
  if (value >= 0) {
    const exponent = Math.exp(-value);
    return 1 / (1 + exponent);
  }
  const exponent = Math.exp(value);
  return exponent / (1 + exponent);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function posteriorProbability(
  count: BinaryCount | undefined,
  priorProbability: number,
  priorStrength: number,
): number {
  if (!count || count.total <= 0) {
    return clampProbability(priorProbability);
  }
  return clampProbability(
    (count.wins + priorStrength * priorProbability) /
      (count.total + priorStrength),
  );
}

function hasMinimumObservations(
  count: BinaryCount | undefined,
  minimum: number,
): count is BinaryCount {
  return Boolean(count && count.total >= minimum);
}

function incrementBinaryTable(
  table: BinaryCountTable,
  key: string,
  won: boolean,
): void {
  const count = table.get(key) ?? { wins: 0, total: 0 };
  incrementBinaryCount(count, won);
  table.set(key, count);
}

function incrementBinaryCount(count: BinaryCount, won: boolean): void {
  count.total += 1;
  count.wins += won ? 1 : 0;
}

function serializeModel(
  model: RecommendationValueV4Model,
  minimumObservations: number,
): Record<string, unknown> {
  return {
    global: { ...model.global },
    hero: serializeBinaryTable(model.hero, minimumObservations),
    heroTime: serializeBinaryTable(model.heroTime, minimumObservations),
    heroTeamTime: serializeBinaryTable(
      model.heroTeamTime,
      minimumObservations,
    ),
    heroTimeInventory: serializeBinaryTable(
      model.heroTimeInventory,
      minimumObservations,
    ),
    heroTimePreviousTail: serializeBinaryTable(
      model.heroTimePreviousTail,
      minimumObservations,
    ),
    ally: serializeBinaryTable(model.ally, minimumObservations),
    enemy: serializeBinaryTable(model.enemy, minimumObservations),
    heroTimeAction: serializeBinaryTable(
      model.heroTimeAction,
      minimumObservations,
    ),
    heroTimeInventoryAction: serializeBinaryTable(
      model.heroTimeInventoryAction,
      minimumObservations,
    ),
    heroTimePreviousTailAction: serializeBinaryTable(
      model.heroTimePreviousTailAction,
      minimumObservations,
    ),
    allyAction: serializeBinaryTable(
      model.allyAction,
      minimumObservations,
    ),
    enemyAction: serializeBinaryTable(
      model.enemyAction,
      minimumObservations,
    ),
  };
}

function serializeBinaryTable(
  table: BinaryCountTable,
  minimumObservations: number,
): Record<string, BinaryCount> {
  return Object.fromEntries(
    [...table.entries()]
      .filter(([, count]) => count.total >= minimumObservations)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, count]) => [key, { ...count }]),
  );
}

function buildEvaluation(input: {
  globalObservations: PredictionObservation[];
  heroTimeObservations: PredictionObservation[];
  valueObservations: PredictionObservation[];
  validationMatchCount: number;
  options: RecommendationValueV4TrainingOptions;
  generatedAt: string;
}): Record<string, unknown> {
  const global = finalizeProbabilityMetrics(
    input.globalObservations,
    input.options.calibrationBinCount,
  );
  const heroTime = finalizeProbabilityMetrics(
    input.heroTimeObservations,
    input.options.calibrationBinCount,
  );
  const value = finalizeProbabilityMetrics(
    input.valueObservations,
    input.options.calibrationBinCount,
  );
  const bestBaselineLogLoss = Math.min(global.logLoss, heroTime.logLoss);
  const bestBaselineBrierScore = Math.min(
    global.brierScore,
    heroTime.brierScore,
  );
  const deltas = {
    logLossVsGlobal: global.logLoss - value.logLoss,
    logLossVsHeroTime: heroTime.logLoss - value.logLoss,
    logLossVsBestBaseline: bestBaselineLogLoss - value.logLoss,
    brierScoreVsBestBaseline: bestBaselineBrierScore - value.brierScore,
    rocAucVsHeroTime: value.rocAuc - heroTime.rocAuc,
  };
  const reasons: string[] = [];
  if (value.evaluatedDecisionCount < 100) {
    reasons.push('Validation contains fewer than 100 outcome decisions.');
  }
  if (input.validationMatchCount < 20) {
    reasons.push('Validation contains fewer than 20 matches.');
  }
  if (value.positiveDecisionCount <= 0 || value.negativeDecisionCount <= 0) {
    reasons.push('Validation must contain both wins and losses.');
  }
  if (deltas.logLossVsBestBaseline < 0.001) {
    reasons.push(
      'Value-model log-loss improvement over the best baseline is below 0.001.',
    );
  }
  if (deltas.brierScoreVsBestBaseline < 0) {
    reasons.push(
      'Value-model Brier score is worse than the best baseline.',
    );
  }
  if (value.rocAuc < 0.52) {
    reasons.push('Value-model ROC AUC is below 0.52.');
  }
  if (value.calibration.expectedCalibrationError > 0.15) {
    reasons.push('Value-model expected calibration error exceeds 0.15.');
  }
  return {
    schemaVersion: RECOMMENDATION_VALUE_V4_TRAINING_SCHEMA_VERSION,
    modelVersion: RECOMMENDATION_VALUE_V4_MODEL_VERSION,
    generatedAt: input.generatedAt,
    split: 'VALIDATION',
    modelKind: 'OBSERVATIONAL_WIN_PROBABILITY',
    target: 'PLAYER_WON',
    validationDecisionCount: value.evaluatedDecisionCount,
    validationMatchCount: input.validationMatchCount,
    globalBaseline: global,
    heroTimeBaseline: heroTime,
    valueModel: value,
    deltas,
    releaseGate: {
      minimumValidationDecisionCount: 100,
      minimumValidationMatchCount: 20,
      requiresBothOutcomeClasses: true,
      minimumLogLossImprovementVsBestBaseline: 0.001,
      minimumBrierScoreImprovementVsBestBaseline: 0,
      minimumRocAuc: 0.52,
      maximumExpectedCalibrationError: 0.15,
      passed: reasons.length === 0,
      reasons,
    },
    interpretation: {
      causal: false,
      statement:
        'Predictions estimate observational win probability conditional on recorded context and action. They do not estimate causal action uplift.',
    },
  };
}

function finalizeProbabilityMetrics(
  observations: readonly PredictionObservation[],
  calibrationBinCount: number,
): FinalizedProbabilityMetrics {
  const evaluatedMatchCount = new Set(
    observations.map((observation) => observation.matchId),
  ).size;
  let positiveDecisionCount = 0;
  let logLossSum = 0;
  let brierSum = 0;
  let correctCount = 0;
  let predictionSum = 0;
  for (const observation of observations) {
    const outcome = observation.outcome ? 1 : 0;
    const probability = clampProbability(observation.probability);
    positiveDecisionCount += outcome;
    predictionSum += probability;
    logLossSum += -(
      outcome * Math.log(probability) +
      (1 - outcome) * Math.log(1 - probability)
    );
    brierSum += (probability - outcome) ** 2;
    correctCount += (probability >= 0.5) === observation.outcome ? 1 : 0;
  }
  const count = observations.length;
  return {
    evaluatedDecisionCount: count,
    evaluatedMatchCount,
    positiveDecisionCount,
    negativeDecisionCount: count - positiveDecisionCount,
    logLoss: divide(logLossSum, count),
    brierScore: divide(brierSum, count),
    accuracy: divide(correctCount, count),
    averagePrediction: divide(predictionSum, count),
    observedWinRate: divide(positiveDecisionCount, count),
    rocAuc: calculateRocAuc(observations),
    calibration: calculateCalibration(observations, calibrationBinCount),
  };
}

function calculateRocAuc(
  observations: readonly PredictionObservation[],
): number {
  const positives = observations.filter((value) => value.outcome).length;
  const negatives = observations.length - positives;
  if (positives <= 0 || negatives <= 0) {
    return 0.5;
  }
  const sorted = [...observations].sort(
    (left, right) =>
      left.probability - right.probability ||
      Number(left.outcome) - Number(right.outcome),
  );
  let rank = 1;
  let positiveRankSum = 0;
  let index = 0;
  while (index < sorted.length) {
    let end = index + 1;
    while (
      end < sorted.length &&
      sorted[end].probability === sorted[index].probability
    ) {
      end += 1;
    }
    const averageRank = (rank + (rank + end - index - 1)) / 2;
    for (let cursor = index; cursor < end; cursor += 1) {
      if (sorted[cursor].outcome) {
        positiveRankSum += averageRank;
      }
    }
    rank += end - index;
    index = end;
  }
  return (
    (positiveRankSum - (positives * (positives + 1)) / 2) /
    (positives * negatives)
  );
}

function calculateCalibration(
  observations: readonly PredictionObservation[],
  binCount: number,
): FinalizedProbabilityMetrics['calibration'] {
  const bins = Array.from({ length: binCount }, (_, index) => ({
    lowerBound: index / binCount,
    upperBound: (index + 1) / binCount,
    decisionCount: 0,
    predictionSum: 0,
    outcomeSum: 0,
  }));
  for (const observation of observations) {
    const probability = clampProbability(observation.probability);
    const binIndex = Math.min(
      binCount - 1,
      Math.floor(probability * binCount),
    );
    const bin = bins[binIndex];
    bin.decisionCount += 1;
    bin.predictionSum += probability;
    bin.outcomeSum += observation.outcome ? 1 : 0;
  }
  let expectedCalibrationError = 0;
  let maximumCalibrationGap = 0;
  const finalizedBins = bins.map((bin) => {
    const averagePrediction = divide(bin.predictionSum, bin.decisionCount);
    const observedWinRate = divide(bin.outcomeSum, bin.decisionCount);
    const absoluteGap =
      bin.decisionCount > 0
        ? Math.abs(averagePrediction - observedWinRate)
        : 0;
    expectedCalibrationError +=
      divide(bin.decisionCount, observations.length) * absoluteGap;
    maximumCalibrationGap = Math.max(maximumCalibrationGap, absoluteGap);
    return {
      lowerBound: bin.lowerBound,
      upperBound: bin.upperBound,
      decisionCount: bin.decisionCount,
      averagePrediction,
      observedWinRate,
      absoluteGap,
    };
  });
  return {
    binCount,
    expectedCalibrationError,
    maximumCalibrationGap,
    bins: finalizedBins,
  };
}

async function buildManifest(input: {
  sourceManifest: RecommendationDecisionDatasetV4Manifest;
  sourceDirectory: string;
  sourceSha256: string;
  options: RecommendationValueV4TrainingOptions;
  split: RecommendationValueV4ChronologicalSplit;
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
    schemaVersion: RECOMMENDATION_VALUE_V4_TRAINING_SCHEMA_VERSION,
    modelVersion: RECOMMENDATION_VALUE_V4_MODEL_VERSION,
    generatedAt: input.generatedAt,
    source: {
      datasetVersion: input.sourceManifest.datasetVersion,
      directory: input.sourceDirectory,
      artifactSha256: input.sourceSha256,
      sourceRowCount: input.sourceManifest.artifact.rowCount,
      outcomeEligibleRowCount: input.eligibleRows,
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
      target: 'PLAYER_WON',
      eligibility: 'trainingEligibility.outcome === true',
      modelKind: 'OBSERVATIONAL_WIN_PROBABILITY',
      causalInterpretationAllowed: false,
      actionFeature: 'observedLabel.exactActionKey',
      options: input.options,
    },
    artifacts,
    evaluationSummary: {
      valueModel: input.evaluation.valueModel,
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

function normalizeOptions(
  request: RecommendationValueV4TrainingStartRequest,
): RecommendationValueV4TrainingOptions {
  return {
    trainFraction: normalizeNumber(
      request.trainFraction,
      'trainFraction',
      0.8,
      0.5,
      0.95,
    ),
    priorStrength: normalizeNumber(
      request.priorStrength,
      'priorStrength',
      100,
      0.1,
      10_000,
    ),
    minContextObservations: normalizeInteger(
      request.minContextObservations,
      'minContextObservations',
      20,
      1,
      100_000,
    ),
    calibrationBinCount: normalizeInteger(
      request.calibrationBinCount,
      'calibrationBinCount',
      10,
      2,
      100,
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
  if (audit.rows.outcomeEligibleCount <= 0) {
    throw new Error(
      'Recommendation Decision Dataset V4 contains no outcome-eligible rows.',
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
    isRecord(value.observedLabel) &&
    isRecord(value.outcomeLabel) &&
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

function clampProbability(value: number): number {
  return Math.min(1 - EPSILON, Math.max(EPSILON, value));
}

function average(values: readonly number[]): number {
  return values.length > 0
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : 0;
}

function divide(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isErrorWithCode(value: unknown): value is { code: string } {
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
