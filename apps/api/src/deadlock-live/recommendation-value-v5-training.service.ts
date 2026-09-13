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
import {
  selectRecommendationOfflineThreeWaySplit,
  type RecommendationOfflineMatchDescriptor,
} from './recommendation-offline-split';
import {
  RECOMMENDATION_VALUE_V5_MODEL_VERSION,
  createRecommendationValueV5MetricsAccumulator,
  createRecommendationValueV5Model,
  finalizeRecommendationValueV5Metrics,
  normalizeRecommendationValueV5Scales,
  observeRecommendationValueV5Prediction,
  predictRecommendationValueV5,
  selectRecommendationValueV5ActionResidualScale,
  serializeRecommendationValueV5Model,
  updateRecommendationValueV5Model,
  type RecommendationValueV5Metrics,
  type RecommendationValueV5MetricsAccumulator,
  type RecommendationValueV5Model,
  type RecommendationValueV5ModelOptions,
  type RecommendationValueV5SourceRow,
} from './recommendation-value-v5-model';

export const RECOMMENDATION_VALUE_V5_TRAINING_SCHEMA_VERSION = 1;

const DEFAULT_SOURCE_DIRECTORY =
  '/app/apps/api/storage/recommendation-decision-dataset-v4';
const DEFAULT_OUTPUT_DIRECTORY =
  '/app/apps/api/storage/recommendation-value-v5-training';
const SOURCE_DIRECTORY_ENV = 'DEADLOCK_RECOMMENDATION_VALUE_V5_SOURCE_DIR';
const OUTPUT_DIRECTORY_ENV = 'DEADLOCK_RECOMMENDATION_VALUE_V5_TRAINING_DIR';
const BUFFER_LIMIT_BYTES = 1024 * 1024;
const PREVIOUS_ACTION_TAIL_SIZE = 4;
const WEIGHT_TOLERANCE = 1e-6;

export interface RecommendationValueV5TrainingStartRequest {
  trainFraction?: number;
  tuningFraction?: number;
  statePriorStrength?: number;
  actionPriorStrength?: number;
  minimumEffectiveObservations?: number;
  maximumAbsoluteStateLogitResidual?: number;
  maximumAbsoluteActionLogitResidual?: number;
  actionResidualScales?: number[];
  expectedSourceSha256?: string;
}

export interface RecommendationValueV5TrainingOptions
  extends RecommendationValueV5ModelOptions {
  trainFraction: number;
  tuningFraction: number;
  actionResidualScales: number[];
  expectedSourceSha256?: string;
}

export type RecommendationValueV5TrainingState =
  | 'IDLE'
  | 'RUNNING'
  | 'COMPLETE'
  | 'FAILED';

export type RecommendationValueV5TrainingPhase =
  | 'PREPARING'
  | 'SPLITTING'
  | 'TRAINING'
  | 'TUNING'
  | 'EVALUATING'
  | 'FINALIZING'
  | 'COMPLETE';

export interface RecommendationValueV5TrainingStatus {
  state: RecommendationValueV5TrainingState;
  phase: RecommendationValueV5TrainingPhase;
  currentPass: number;
  totalPasses: number;
  sourceRowCount: number;
  eligibleSourceRowCount: number;
  excludedSourceRowCount: number;
  processedRowCount: number;
  sourceMatchCount: number;
  trainMatchCount: number;
  tuningMatchCount: number;
  testMatchCount: number;
  trainRowCount: number;
  tuningRowCount: number;
  testRowCount: number;
  outputDirectory: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  options?: RecommendationValueV5TrainingOptions;
  manifestAvailable: boolean;
  auditAvailable: boolean;
  evaluationAvailable: boolean;
  modelAvailable: boolean;
}

interface SourcePassSummary {
  sourceRowCount: number;
  eligibleSourceRowCount: number;
  excludedSourceRowCount: number;
  duplicateEligibleDecisionCount: number;
  matches: RecommendationOfflineMatchDescriptor[];
  eligibleDecisionCountsByMatch: Map<string, number>;
}

interface SplitRuntime {
  trainMatchIds: Set<string>;
  tuningMatchIds: Set<string>;
  testMatchIds: Set<string>;
  descriptorSha256: string;
}

interface PassMetrics {
  rowCount: number;
  totalWeight: number;
}

interface TestPassMetrics extends PassMetrics {
  stateOnly: RecommendationValueV5Metrics;
  actionConditioned: RecommendationValueV5Metrics;
  supportedStateWeight: number;
  supportedActionWeight: number;
}

interface TrainingArtifacts {
  predictionEvaluation: string;
  model: string;
  evaluation: string;
  audit: string;
  manifest: string;
}

@Injectable()
export class RecommendationValueV5TrainingService implements OnModuleInit {
  private readonly logger = new Logger(
    RecommendationValueV5TrainingService.name,
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
        tuningMatchCount: toNumber(split.tuningMatchCount),
        testMatchCount: toNumber(split.testMatchCount),
        trainRowCount: toNumber(split.trainRowCount),
        tuningRowCount: toNumber(split.tuningRowCount),
        testRowCount: toNumber(split.testRowCount),
        completedAt: String(this.manifest.generatedAt ?? ''),
        manifestAvailable: true,
        auditAvailable: true,
        evaluationAvailable: true,
        modelAvailable: true,
      };
    }
  }

  async start(
    request: RecommendationValueV5TrainingStartRequest = {},
  ): Promise<RecommendationValueV5TrainingStatus> {
    if (this.status.state === 'RUNNING') {
      throw new Error('Recommendation Value V5 training is already running.');
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

  getStatus(): RecommendationValueV5TrainingStatus {
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

  private async run(options: RecommendationValueV5TrainingOptions): Promise<void> {
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
      const sourceSummary = await this.collectSourceSummary();
      validateSourceSummary(sourceSummary, sourceManifest, sourceAudit);
      const split = selectRecommendationOfflineThreeWaySplit(
        sourceSummary.matches,
        options,
      );
      const splitRuntime: SplitRuntime = {
        trainMatchIds: new Set(split.train.map((value) => value.matchId)),
        tuningMatchIds: new Set(split.tuning.map((value) => value.matchId)),
        testMatchIds: new Set(split.test.map((value) => value.matchId)),
        descriptorSha256: split.descriptorSha256,
      };
      this.status = {
        ...this.status,
        sourceRowCount: sourceSummary.sourceRowCount,
        eligibleSourceRowCount: sourceSummary.eligibleSourceRowCount,
        excludedSourceRowCount: sourceSummary.excludedSourceRowCount,
        processedRowCount: sourceSummary.sourceRowCount,
        sourceMatchCount: sourceSummary.matches.length,
        trainMatchCount: splitRuntime.trainMatchIds.size,
        tuningMatchCount: splitRuntime.tuningMatchIds.size,
        testMatchCount: splitRuntime.testMatchIds.size,
      };

      this.status = {
        ...this.status,
        phase: 'TRAINING',
        currentPass: 2,
        processedRowCount: 0,
      };
      const model = createRecommendationValueV5Model();
      const trainMetrics = await this.trainModel(
        model,
        splitRuntime.trainMatchIds,
        sourceSummary.eligibleDecisionCountsByMatch,
      );
      assertWeightMatchesSplit(
        'training',
        trainMetrics.totalWeight,
        splitRuntime.trainMatchIds.size,
      );
      this.status = {
        ...this.status,
        trainRowCount: trainMetrics.rowCount,
      };

      this.status = {
        ...this.status,
        phase: 'TUNING',
        currentPass: 3,
        processedRowCount: 0,
      };
      const tuning = await this.tuneActionResidualScale(
        model,
        options,
        splitRuntime.tuningMatchIds,
        sourceSummary.eligibleDecisionCountsByMatch,
      );
      assertWeightMatchesSplit(
        'tuning',
        tuning.totalWeight,
        splitRuntime.tuningMatchIds.size,
      );
      this.status = {
        ...this.status,
        tuningRowCount: tuning.rowCount,
      };

      this.status = {
        ...this.status,
        phase: 'EVALUATING',
        currentPass: 4,
        processedRowCount: 0,
      };
      const test = await this.evaluateTest(
        model,
        options,
        tuning.selection.actionResidualScale,
        splitRuntime.testMatchIds,
        sourceSummary.eligibleDecisionCountsByMatch,
      );
      assertWeightMatchesSplit(
        'test',
        test.totalWeight,
        splitRuntime.testMatchIds.size,
      );
      this.status = {
        ...this.status,
        testRowCount: test.rowCount,
      };

      this.status = {
        ...this.status,
        phase: 'FINALIZING',
        processedRowCount: sourceSummary.sourceRowCount,
      };
      const generatedAt = new Date().toISOString();
      const releaseGate = buildReleaseGate(test, tuning.selection.actionResidualScale);
      const modelArtifact = {
        schemaVersion: RECOMMENDATION_VALUE_V5_TRAINING_SCHEMA_VERSION,
        modelVersion: RECOMMENDATION_VALUE_V5_MODEL_VERSION,
        generatedAt,
        modelKind: 'OBSERVATIONAL_WIN_PROBABILITY',
        target: 'PLAYER_WON',
        causalInterpretationAllowed: false,
        weighting: 'EQUAL_TOTAL_WEIGHT_PER_MATCH',
        combination: 'STATE_PLUS_TUNED_ACTION_LOGIT_RESIDUAL',
        actionResidualScale: tuning.selection.actionResidualScale,
        options: modelOptions(options),
        counts: serializeRecommendationValueV5Model(
          model,
          options.minimumEffectiveObservations,
        ),
      };
      const evaluation = {
        schemaVersion: RECOMMENDATION_VALUE_V5_TRAINING_SCHEMA_VERSION,
        modelVersion: RECOMMENDATION_VALUE_V5_MODEL_VERSION,
        generatedAt,
        split: 'UNTOUCHED_CHRONOLOGICAL_TEST',
        weighting: 'EQUAL_TOTAL_WEIGHT_PER_MATCH',
        tuning: {
          matchCount: splitRuntime.tuningMatchIds.size,
          decisionCount: tuning.rowCount,
          selection: tuning.selection,
          candidates: tuning.candidates,
        },
        test: {
          matchCount: splitRuntime.testMatchIds.size,
          decisionCount: test.rowCount,
          stateOnly: test.stateOnly,
          actionConditioned: test.actionConditioned,
          deltas: {
            logLossImprovement:
              test.stateOnly.logLoss - test.actionConditioned.logLoss,
            brierScoreImprovement:
              test.stateOnly.brierScore - test.actionConditioned.brierScore,
            accuracyImprovement:
              test.actionConditioned.accuracy - test.stateOnly.accuracy,
          },
          support: {
            stateWeightCoverage:
              test.supportedStateWeight / test.actionConditioned.totalWeight,
            actionWeightCoverage:
              test.supportedActionWeight / test.actionConditioned.totalWeight,
          },
        },
        releaseGate,
        interpretation: {
          causal: false,
          allowedUse:
            'Offline observational diagnostics and future policy-evaluation inputs only.',
          prohibitedUse:
            'Do not interpret action residuals as causal treatment effects.',
        },
      };
      await atomicJson(this.paths.model, modelArtifact);
      await atomicJson(this.paths.evaluation, evaluation);
      const predictionStat = await stat(this.paths.predictionEvaluation);
      const modelStat = await stat(this.paths.model);
      const evaluationStat = await stat(this.paths.evaluation);
      const predictionSha256 = await hashFile(this.paths.predictionEvaluation);
      const modelSha256 = await hashFile(this.paths.model);
      const evaluationSha256 = await hashFile(this.paths.evaluation);
      const audit = {
        schemaVersion: RECOMMENDATION_VALUE_V5_TRAINING_SCHEMA_VERSION,
        modelVersion: RECOMMENDATION_VALUE_V5_MODEL_VERSION,
        generatedAt,
        passed: true,
        source: {
          datasetVersion: sourceManifest.datasetVersion,
          expectedSha256: options.expectedSourceSha256,
          actualSha256: sourceSha256,
          sourceRowCount: sourceSummary.sourceRowCount,
          eligibleSourceRowCount: sourceSummary.eligibleSourceRowCount,
          excludedSourceRowCount: sourceSummary.excludedSourceRowCount,
          eligibleMatchCount: sourceSummary.matches.length,
          duplicateEligibleDecisionCount:
            sourceSummary.duplicateEligibleDecisionCount,
        },
        split: {
          descriptorSha256: splitRuntime.descriptorSha256,
          strategy: 'CHRONOLOGICAL_MATCH_LEVEL_70_15_15',
          trainMatchCount: splitRuntime.trainMatchIds.size,
          tuningMatchCount: splitRuntime.tuningMatchIds.size,
          testMatchCount: splitRuntime.testMatchIds.size,
          trainRowCount: trainMetrics.rowCount,
          tuningRowCount: tuning.rowCount,
          testRowCount: test.rowCount,
          overlapCount: 0,
        },
        weighting: {
          strategy: 'EQUAL_TOTAL_WEIGHT_PER_MATCH',
          trainTotalWeight: trainMetrics.totalWeight,
          tuningTotalWeight: tuning.totalWeight,
          testTotalWeight: test.totalWeight,
          expectedTrainTotalWeight: splitRuntime.trainMatchIds.size,
          expectedTuningTotalWeight: splitRuntime.tuningMatchIds.size,
          expectedTestTotalWeight: splitRuntime.testMatchIds.size,
        },
        leakage: {
          featureCutoff: 'DECISION_SERVED_TIME',
          outcomeFieldUsedAsFeature: false,
          testUsedForTuning: false,
          actionResidualScaleSelectedOn: 'TUNING_ONLY',
          causalInterpretationAllowed: false,
          forbiddenFieldsPresent: [],
        },
        artifacts: {
          predictionEvaluation: {
            byteLength: predictionStat.size,
            sha256: predictionSha256,
          },
          model: { byteLength: modelStat.size, sha256: modelSha256 },
          evaluation: {
            byteLength: evaluationStat.size,
            sha256: evaluationSha256,
          },
        },
        warnings: releaseGate.passed ? [] : releaseGate.reasons,
      };
      await atomicJson(this.paths.audit, audit);
      const auditStat = await stat(this.paths.audit);
      const auditSha256 = await hashFile(this.paths.audit);
      const manifest = {
        schemaVersion: RECOMMENDATION_VALUE_V5_TRAINING_SCHEMA_VERSION,
        modelVersion: RECOMMENDATION_VALUE_V5_MODEL_VERSION,
        generatedAt,
        source: {
          datasetVersion: sourceManifest.datasetVersion,
          artifactSha256: sourceSha256,
          sourceRowCount: sourceSummary.sourceRowCount,
          outcomeEligibleRowCount: sourceSummary.eligibleSourceRowCount,
        },
        split: {
          descriptorSha256: splitRuntime.descriptorSha256,
          trainFraction: options.trainFraction,
          tuningFraction: options.tuningFraction,
          testFraction: 1 - options.trainFraction - options.tuningFraction,
          trainMatchCount: splitRuntime.trainMatchIds.size,
          tuningMatchCount: splitRuntime.tuningMatchIds.size,
          testMatchCount: splitRuntime.testMatchIds.size,
          trainRowCount: trainMetrics.rowCount,
          tuningRowCount: tuning.rowCount,
          testRowCount: test.rowCount,
        },
        training: {
          modelKind: 'OBSERVATIONAL_WIN_PROBABILITY',
          target: 'PLAYER_WON',
          weighting: 'EQUAL_TOTAL_WEIGHT_PER_MATCH',
          actionResidualScale: tuning.selection.actionResidualScale,
          actionResidualScaleSelectedOn: 'TUNING_ONLY',
          causalInterpretationAllowed: false,
          options: modelOptions(options),
        },
        artifacts: {
          predictionEvaluation: {
            format: 'NDJSON',
            fileName: 'prediction-evaluation.ndjson',
            byteLength: predictionStat.size,
            sha256: predictionSha256,
            rowCount: test.rowCount,
          },
          model: {
            format: 'JSON',
            fileName: 'model.json',
            byteLength: modelStat.size,
            sha256: modelSha256,
          },
          evaluation: {
            format: 'JSON',
            fileName: 'evaluation.json',
            byteLength: evaluationStat.size,
            sha256: evaluationSha256,
          },
          audit: {
            format: 'JSON',
            fileName: 'audit.json',
            byteLength: auditStat.size,
            sha256: auditSha256,
          },
        },
        releaseGatePassed: releaseGate.passed,
        warnings: releaseGate.passed ? [] : releaseGate.reasons,
      };
      await atomicJson(this.paths.manifest, manifest);

      this.modelArtifact = modelArtifact;
      this.evaluation = evaluation;
      this.audit = audit;
      this.manifest = manifest;
      this.status = {
        ...this.status,
        state: 'COMPLETE',
        phase: 'COMPLETE',
        currentPass: 4,
        processedRowCount: sourceSummary.sourceRowCount,
        completedAt: generatedAt,
        manifestAvailable: true,
        auditAvailable: true,
        evaluationAvailable: true,
        modelAvailable: true,
      };
      this.logger.log(
        `Recommendation Value V5 completed with ${test.rowCount} untouched test decisions.`,
      );
    } catch (error) {
      const message = getErrorMessage(error);
      this.status = {
        ...this.status,
        state: 'FAILED',
        error: message,
      };
      this.logger.error(`Recommendation Value V5 failed: ${message}`);
    }
  }

  private async collectSourceSummary(): Promise<SourcePassSummary> {
    const matches = new Map<string, RecommendationOfflineMatchDescriptor>();
    const eligibleDecisionCountsByMatch = new Map<string, number>();
    const decisionIds = new Set<string>();
    let sourceRowCount = 0;
    let eligibleSourceRowCount = 0;
    let excludedSourceRowCount = 0;
    let duplicateEligibleDecisionCount = 0;
    await eachSourceRow(this.sourceDatasetPath, async (row) => {
      sourceRowCount += 1;
      if (!isOutcomeEligible(row)) {
        excludedSourceRowCount += 1;
      } else {
        eligibleSourceRowCount += 1;
        if (decisionIds.has(row.decisionId)) {
          duplicateEligibleDecisionCount += 1;
        }
        decisionIds.add(row.decisionId);
        const existing = matches.get(row.matchId);
        if (
          !existing ||
          Date.parse(row.decisionOccurredAt) < Date.parse(existing.firstObservedAt)
        ) {
          matches.set(row.matchId, {
            matchId: row.matchId,
            firstObservedAt: row.decisionOccurredAt,
          });
        }
        eligibleDecisionCountsByMatch.set(
          row.matchId,
          (eligibleDecisionCountsByMatch.get(row.matchId) ?? 0) + 1,
        );
      }
      if (sourceRowCount % 10_000 === 0) {
        this.status = { ...this.status, processedRowCount: sourceRowCount };
        await tick();
      }
    });
    return {
      sourceRowCount,
      eligibleSourceRowCount,
      excludedSourceRowCount,
      duplicateEligibleDecisionCount,
      matches: [...matches.values()],
      eligibleDecisionCountsByMatch,
    };
  }

  private async trainModel(
    model: RecommendationValueV5Model,
    trainMatchIds: ReadonlySet<string>,
    decisionCountsByMatch: ReadonlyMap<string, number>,
  ): Promise<PassMetrics> {
    let processed = 0;
    let rowCount = 0;
    let totalWeight = 0;
    await eachSourceRow(this.sourceDatasetPath, async (row) => {
      processed += 1;
      if (isOutcomeEligible(row) && trainMatchIds.has(row.matchId)) {
        const prepared = prepareRecommendationValueV5Row(row);
        const weight = matchWeight(row.matchId, decisionCountsByMatch);
        updateRecommendationValueV5Model(model, prepared, weight);
        rowCount += 1;
        totalWeight += weight;
      }
      if (processed % 10_000 === 0) {
        this.status = { ...this.status, processedRowCount: processed };
        await tick();
      }
    });
    return { rowCount, totalWeight };
  }

  private async tuneActionResidualScale(
    model: RecommendationValueV5Model,
    options: RecommendationValueV5TrainingOptions,
    tuningMatchIds: ReadonlySet<string>,
    decisionCountsByMatch: ReadonlyMap<string, number>,
  ): Promise<{
    rowCount: number;
    totalWeight: number;
    selection: ReturnType<typeof selectRecommendationValueV5ActionResidualScale>;
    candidates: Array<{
      actionResidualScale: number;
      metrics: RecommendationValueV5Metrics;
    }>;
  }> {
    const accumulators = new Map<
      number,
      RecommendationValueV5MetricsAccumulator
    >(
      options.actionResidualScales.map((scale) => [
        scale,
        createRecommendationValueV5MetricsAccumulator(),
      ]),
    );
    let processed = 0;
    let rowCount = 0;
    let totalWeight = 0;
    await eachSourceRow(this.sourceDatasetPath, async (row) => {
      processed += 1;
      if (isOutcomeEligible(row) && tuningMatchIds.has(row.matchId)) {
        const prepared = prepareRecommendationValueV5Row(row);
        const weight = matchWeight(row.matchId, decisionCountsByMatch);
        rowCount += 1;
        totalWeight += weight;
        for (const [scale, accumulator] of accumulators) {
          const prediction = predictRecommendationValueV5(
            model,
            prepared,
            modelOptions(options),
            scale,
          ).actionProbability;
          observeRecommendationValueV5Prediction(
            accumulator,
            prepared,
            prediction,
            weight,
          );
        }
      }
      if (processed % 10_000 === 0) {
        this.status = { ...this.status, processedRowCount: processed };
        await tick();
      }
    });
    const candidates = [...accumulators.entries()].map(
      ([actionResidualScale, accumulator]) => ({
        actionResidualScale,
        metrics: finalizeRecommendationValueV5Metrics(accumulator),
      }),
    );
    const selection = selectRecommendationValueV5ActionResidualScale(
      candidates.map((candidate) => ({
        actionResidualScale: candidate.actionResidualScale,
        tuningLogLoss: candidate.metrics.logLoss,
      })),
    );
    return { rowCount, totalWeight, selection, candidates };
  }

  private async evaluateTest(
    model: RecommendationValueV5Model,
    options: RecommendationValueV5TrainingOptions,
    actionResidualScale: number,
    testMatchIds: ReadonlySet<string>,
    decisionCountsByMatch: ReadonlyMap<string, number>,
  ): Promise<TestPassMetrics> {
    const stateAccumulator = createRecommendationValueV5MetricsAccumulator();
    const actionAccumulator = createRecommendationValueV5MetricsAccumulator();
    const partialPath = `${this.paths.predictionEvaluation}.partial`;
    const writer = await LineWriter.create(partialPath);
    let processed = 0;
    let rowCount = 0;
    let totalWeight = 0;
    let supportedStateWeight = 0;
    let supportedActionWeight = 0;
    try {
      await eachSourceRow(this.sourceDatasetPath, async (row) => {
        processed += 1;
        if (isOutcomeEligible(row) && testMatchIds.has(row.matchId)) {
          const prepared = prepareRecommendationValueV5Row(row);
          const weight = matchWeight(row.matchId, decisionCountsByMatch);
          const prediction = predictRecommendationValueV5(
            model,
            prepared,
            modelOptions(options),
            actionResidualScale,
          );
          observeRecommendationValueV5Prediction(
            stateAccumulator,
            prepared,
            prediction.stateProbability,
            weight,
          );
          observeRecommendationValueV5Prediction(
            actionAccumulator,
            prepared,
            prediction.actionProbability,
            weight,
          );
          supportedStateWeight +=
            prediction.supportedStateKeyCount > 0 ? weight : 0;
          supportedActionWeight +=
            prediction.supportedActionKeyCount > 0 ? weight : 0;
          rowCount += 1;
          totalWeight += weight;
          await writer.write({
            schemaVersion: RECOMMENDATION_VALUE_V5_TRAINING_SCHEMA_VERSION,
            modelVersion: RECOMMENDATION_VALUE_V5_MODEL_VERSION,
            decisionId: row.decisionId,
            matchId: row.matchId,
            playerWon: row.outcomeLabel.playerWon,
            matchWeight: weight,
            stateProbability: prediction.stateProbability,
            actionProbability: prediction.actionProbability,
            stateLogitResidual: prediction.stateLogitResidual,
            actionLogitResidual: prediction.actionLogitResidual,
            supportedStateKeyCount: prediction.supportedStateKeyCount,
            supportedActionKeyCount: prediction.supportedActionKeyCount,
          });
        }
        if (processed % 10_000 === 0) {
          this.status = { ...this.status, processedRowCount: processed };
          await tick();
        }
      });
      await writer.close();
      await rename(partialPath, this.paths.predictionEvaluation);
    } catch (error) {
      await writer.abort();
      await rm(partialPath, { force: true });
      throw error;
    }
    return {
      rowCount,
      totalWeight,
      stateOnly: finalizeRecommendationValueV5Metrics(stateAccumulator),
      actionConditioned: finalizeRecommendationValueV5Metrics(actionAccumulator),
      supportedStateWeight,
      supportedActionWeight,
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

  private createIdleStatus(): RecommendationValueV5TrainingStatus {
    return {
      state: 'IDLE',
      phase: 'PREPARING',
      currentPass: 0,
      totalPasses: 4,
      sourceRowCount: 0,
      eligibleSourceRowCount: 0,
      excludedSourceRowCount: 0,
      processedRowCount: 0,
      sourceMatchCount: 0,
      trainMatchCount: 0,
      tuningMatchCount: 0,
      testMatchCount: 0,
      trainRowCount: 0,
      tuningRowCount: 0,
      testRowCount: 0,
      outputDirectory: this.outputDirectory,
      manifestAvailable: false,
      auditAvailable: false,
      evaluationAvailable: false,
      modelAvailable: false,
    };
  }
}

export function prepareRecommendationValueV5Row(
  row: RecommendationDecisionDatasetV4Row,
): RecommendationValueV5SourceRow {
  if (!isOutcomeEligible(row) || typeof row.outcomeLabel.playerWon !== 'boolean') {
    throw new Error(`Recommendation decision ${row.decisionId} is not outcome eligible.`);
  }
  const baseKey = `${row.heroId}|${row.timeBucket}`;
  const teamKey = row.teamId ?? 'UNKNOWN_TEAM';
  const previousTail = row.previousActionKeys
    .slice(-PREVIOUS_ACTION_TAIL_SIZE)
    .join('>') || 'EMPTY';
  const stateKeys = [
    `HERO:${row.heroId}`,
    `HERO_TIME:${baseKey}`,
    `HERO_TEAM_TIME:${baseKey}|${teamKey}`,
    `HERO_TIME_INVENTORY:${baseKey}|${row.inventoryStateKey}`,
    `HERO_TIME_PREVIOUS:${baseKey}|${previousTail}`,
    ...row.alliedHeroIds.map((heroId) => `ALLY:${baseKey}|${heroId}`),
    ...row.enemyHeroIds.map((heroId) => `ENEMY:${baseKey}|${heroId}`),
  ];
  const action = row.servedActionKey;
  const actionKeys = [
    `HERO_TIME_ACTION:${baseKey}|${action}`,
    `HERO_TIME_INVENTORY_ACTION:${baseKey}|${row.inventoryStateKey}|${action}`,
    `HERO_TIME_PREVIOUS_ACTION:${baseKey}|${previousTail}|${action}`,
    ...row.alliedHeroIds.map(
      (heroId) => `ALLY_ACTION:${baseKey}|${heroId}|${action}`,
    ),
    ...row.enemyHeroIds.map(
      (heroId) => `ENEMY_ACTION:${baseKey}|${heroId}|${action}`,
    ),
  ];
  return {
    decisionId: row.decisionId,
    matchId: row.matchId,
    playerWon: row.outcomeLabel.playerWon,
    stateKeys,
    actionKeys,
  };
}

function isOutcomeEligible(row: RecommendationDecisionDatasetV4Row): boolean {
  return Boolean(
    row.trainingEligibility.outcome &&
      row.outcomeLabel.available &&
      !row.outcomeLabel.conflicting &&
      typeof row.outcomeLabel.playerWon === 'boolean',
  );
}

function normalizeOptions(
  request: RecommendationValueV5TrainingStartRequest,
): RecommendationValueV5TrainingOptions {
  const trainFraction = request.trainFraction ?? 0.7;
  const tuningFraction = request.tuningFraction ?? 0.15;
  validateFraction(trainFraction, 'trainFraction');
  validateFraction(tuningFraction, 'tuningFraction');
  if (trainFraction + tuningFraction >= 1) {
    throw new Error('trainFraction plus tuningFraction must be less than one.');
  }
  return {
    trainFraction,
    tuningFraction,
    statePriorStrength: positiveNumber(
      request.statePriorStrength ?? 100,
      'statePriorStrength',
    ),
    actionPriorStrength: positiveNumber(
      request.actionPriorStrength ?? 100,
      'actionPriorStrength',
    ),
    minimumEffectiveObservations: nonNegativeNumber(
      request.minimumEffectiveObservations ?? 20,
      'minimumEffectiveObservations',
    ),
    maximumAbsoluteStateLogitResidual: nonNegativeNumber(
      request.maximumAbsoluteStateLogitResidual ?? 1.5,
      'maximumAbsoluteStateLogitResidual',
    ),
    maximumAbsoluteActionLogitResidual: nonNegativeNumber(
      request.maximumAbsoluteActionLogitResidual ?? 1.5,
      'maximumAbsoluteActionLogitResidual',
    ),
    actionResidualScales: normalizeRecommendationValueV5Scales(
      request.actionResidualScales ?? [0, 0.25, 0.5, 0.75, 1],
    ),
    expectedSourceSha256: normalizeSha(request.expectedSourceSha256),
  };
}

function modelOptions(
  options: RecommendationValueV5TrainingOptions,
): RecommendationValueV5ModelOptions {
  return {
    statePriorStrength: options.statePriorStrength,
    actionPriorStrength: options.actionPriorStrength,
    minimumEffectiveObservations: options.minimumEffectiveObservations,
    maximumAbsoluteStateLogitResidual:
      options.maximumAbsoluteStateLogitResidual,
    maximumAbsoluteActionLogitResidual:
      options.maximumAbsoluteActionLogitResidual,
  };
}

function validateFraction(value: number, fieldName: string): void {
  if (!Number.isFinite(value) || value <= 0 || value >= 1) {
    throw new Error(`${fieldName} must be greater than zero and less than one.`);
  }
}

function positiveNumber(value: number, fieldName: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${fieldName} must be a finite number greater than zero.`);
  }
  return value;
}

function nonNegativeNumber(value: number, fieldName: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${fieldName} must be a finite non-negative number.`);
  }
  return value;
}

function normalizeSha(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new Error('expectedSourceSha256 must be a 64-character hexadecimal SHA-256.');
  }
  return normalized;
}

function validateSourceArtifacts(
  manifest: RecommendationDecisionDatasetV4Manifest,
  audit: RecommendationDecisionDatasetV4Audit,
): void {
  if (manifest.datasetVersion !== RECOMMENDATION_DECISION_DATASET_V4_VERSION) {
    throw new Error('Unsupported Recommendation Decision Dataset V4 version.');
  }
  if (!manifest.auditPassed || !audit.passed) {
    throw new Error('Recommendation Decision Dataset V4 did not pass its audit.');
  }
}

function validateSourceSummary(
  summary: SourcePassSummary,
  manifest: RecommendationDecisionDatasetV4Manifest,
  audit: RecommendationDecisionDatasetV4Audit,
): void {
  if (summary.sourceRowCount !== manifest.artifact.rowCount) {
    throw new Error('Recommendation Decision Dataset V4 row count does not match its manifest.');
  }
  if (summary.eligibleSourceRowCount !== audit.rows.outcomeEligibleCount) {
    throw new Error('Outcome-eligible row count does not match the source audit.');
  }
  if (summary.duplicateEligibleDecisionCount > 0) {
    throw new Error('The outcome-eligible source subset contains duplicate decision IDs.');
  }
  if (summary.matches.length < 3) {
    throw new Error('Value V5 requires at least three outcome-eligible matches.');
  }
}

function matchWeight(
  matchId: string,
  decisionCountsByMatch: ReadonlyMap<string, number>,
): number {
  const count = decisionCountsByMatch.get(matchId) ?? 0;
  if (count <= 0) {
    throw new Error(`Value V5 match ${matchId} has no eligible decision count.`);
  }
  return 1 / count;
}

function assertWeightMatchesSplit(
  splitName: string,
  actualWeight: number,
  expectedMatchCount: number,
): void {
  if (Math.abs(actualWeight - expectedMatchCount) > WEIGHT_TOLERANCE) {
    throw new Error(
      `Value V5 ${splitName} weight ${actualWeight} does not match ${expectedMatchCount} matches.`,
    );
  }
}

function buildReleaseGate(
  test: TestPassMetrics,
  actionResidualScale: number,
): { passed: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const logLossImprovement =
    test.stateOnly.logLoss - test.actionConditioned.logLoss;
  const brierImprovement =
    test.stateOnly.brierScore - test.actionConditioned.brierScore;
  const actionCoverage =
    test.supportedActionWeight / test.actionConditioned.totalWeight;
  if (test.actionConditioned.matchCount < 100) {
    reasons.push('Untouched test contains fewer than 100 matches.');
  }
  if (
    test.actionConditioned.positiveWeight <= 0 ||
    test.actionConditioned.negativeWeight <= 0
  ) {
    reasons.push('Untouched test must contain both wins and losses.');
  }
  if (actionResidualScale <= 0) {
    reasons.push('Tuning selected a zero action-residual scale.');
  }
  if (logLossImprovement < 0.0005) {
    reasons.push(
      'Action-conditioned log-loss improvement over state-only is below 0.0005.',
    );
  }
  if (brierImprovement < 0) {
    reasons.push('Action-conditioned Brier score is worse than state-only.');
  }
  if (actionCoverage < 0.5) {
    reasons.push('Action-context weighted support coverage is below 50%.');
  }
  return { passed: reasons.length === 0, reasons };
}

async function eachSourceRow(
  path: string,
  visit: (row: RecommendationDecisionDatasetV4Row) => Promise<void>,
): Promise<void> {
  const input = createReadStream(path, { encoding: 'utf8' });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      await visit(JSON.parse(line) as RecommendationDecisionDatasetV4Row);
    }
  } finally {
    lines.close();
    input.destroy();
  }
}

class LineWriter {
  private buffer = '';

  private constructor(
    private readonly handle: FileHandle,
    private readonly path: string,
  ) {}

  static async create(path: string): Promise<LineWriter> {
    return new LineWriter(await open(path, 'w'), path);
  }

  async write(value: unknown): Promise<void> {
    this.buffer += `${JSON.stringify(value)}\n`;
    if (Buffer.byteLength(this.buffer, 'utf8') >= BUFFER_LIMIT_BYTES) {
      await this.flush();
    }
  }

  async close(): Promise<void> {
    await this.flush();
    await this.handle.sync();
    await this.handle.close();
  }

  async abort(): Promise<void> {
    try {
      await this.handle.close();
    } catch {
      return;
    }
  }

  private async flush(): Promise<void> {
    if (!this.buffer) {
      return;
    }
    await this.handle.write(this.buffer, undefined, 'utf8');
    this.buffer = '';
  }
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  const partialPath = `${path}.partial`;
  await writeFile(partialPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(partialPath, path);
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  const input = createReadStream(path);
  for await (const chunk of input) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

async function requiredJson<T>(path: string): Promise<T> {
  const value = await readJson(path);
  if (!value) {
    throw new Error(`Required JSON artifact is missing: ${path}.`);
  }
  return value as T;
}

async function readJson(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  } catch (error) {
    if (isMissingFile(error)) {
      return undefined;
    }
    throw error;
  }
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : {};
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

async function tick(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
