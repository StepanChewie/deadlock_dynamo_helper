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
  RECOMMENDATION_DECISION_DATASET_V5_VERSION,
} from './recommendation-decision-dataset-v5.service';
import {
  selectRecommendationOfflineThreeWaySplit,
  type RecommendationOfflineMatchDescriptor,
} from './recommendation-offline-split';
import {
  RECOMMENDATION_VALUE_V6_MODEL_VERSION,
  createRecommendationValueV6MetricsAccumulator,
  createRecommendationValueV6Model,
  finalizeRecommendationValueV6Metrics,
  observeRecommendationValueV6Prediction,
  predictRecommendationValueV6,
  selectRecommendationValueV6ActionScale,
  serializeRecommendationValueV6Model,
  updateRecommendationValueV6Model,
  type RecommendationValueV6Metrics,
  type RecommendationValueV6Model,
  type RecommendationValueV6ModelOptions,
  type RecommendationValueV6Prediction,
  type RecommendationValueV6SourceRow,
} from './recommendation-value-v6-model';
import {
  buildRecommendationValueV6ActionKeys,
  buildRecommendationValueV6StateKeys,
} from './recommendation-value-v6-features';
export { classifyRecommendationValueV6TeamEconomy } from './recommendation-value-v6-features';

export const RECOMMENDATION_VALUE_V6_TRAINING_SCHEMA_VERSION = 1;

const DEFAULT_SOURCE_DIRECTORY =
  '/app/apps/api/storage/recommendation-decision-dataset-v5';
const DEFAULT_OUTPUT_DIRECTORY =
  '/app/apps/api/storage/recommendation-value-v6-training';
const SOURCE_DIRECTORY_ENV = 'DEADLOCK_RECOMMENDATION_VALUE_V6_SOURCE_DIR';
const OUTPUT_DIRECTORY_ENV = 'DEADLOCK_RECOMMENDATION_VALUE_V6_TRAINING_DIR';
const BUFFER_LIMIT_BYTES = 1024 * 1024;
const WEIGHT_TOLERANCE = 1e-6;
const DEFAULT_ACTION_SCALES = [0, 0.25, 0.5, 0.75, 1];
const HORIZONS = ['3m', '5m', '10m'] as const;

export interface RecommendationValueV6TrainingStartRequest {
  trainFraction?: number;
  tuningFraction?: number;
  statePriorStrength?: number;
  actionPriorStrength?: number;
  minimumObservations?: number;
  maximumAbsoluteStateResidual?: number;
  maximumAbsoluteActionResidual?: number;
  actionResidualScales?: number[];
  finalOutcomeWeight?: number;
  expectedSourceSha256?: string;
}

export interface RecommendationValueV6TrainingOptions
  extends RecommendationValueV6ModelOptions {
  trainFraction: number;
  tuningFraction: number;
  actionResidualScales: number[];
  finalOutcomeWeight: number;
  expectedSourceSha256?: string;
}

export type RecommendationValueV6TrainingState =
  | 'IDLE'
  | 'RUNNING'
  | 'COMPLETE'
  | 'FAILED';

export type RecommendationValueV6TrainingPhase =
  | 'PREPARING'
  | 'SPLITTING'
  | 'TRAINING'
  | 'TUNING'
  | 'EVALUATING'
  | 'FINALIZING'
  | 'COMPLETE';

export interface RecommendationValueV6TrainingStatus {
  state: RecommendationValueV6TrainingState;
  phase: RecommendationValueV6TrainingPhase;
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
  options?: RecommendationValueV6TrainingOptions;
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

interface RankingAccumulator {
  decisionWeight: number;
  pairWeight: number;
  correctlyOrderedPairWeight: number;
  ndcgWeight: number;
  regretWeight: number;
  confidentWeight: number;
  candidateSetWeight: number;
}

interface RankingMetrics {
  pairwiseObservedActionAccuracy: number;
  observedActionNdcg: number;
  averageObservedActionRegret: number;
  confidentSeparationRate: number;
  candidateSetCoverage: number;
}

interface EvaluationPass extends PassMetrics {
  metrics: RecommendationValueV6Metrics;
  ranking: RankingMetrics;
}

interface TuningPass extends PassMetrics {
  selection: ReturnType<typeof selectRecommendationValueV6ActionScale>;
  candidates: Array<{
    actionResidualScale: number;
    tuningLoss: number;
    metrics: RecommendationValueV6Metrics;
    ranking: RankingMetrics;
  }>;
}

interface TrainingArtifacts {
  predictionEvaluation: string;
  model: string;
  evaluation: string;
  audit: string;
  manifest: string;
}

interface SourceArtifacts {
  manifest: Record<string, unknown>;
  audit: Record<string, unknown>;
  sha256: string;
  upstreamDatasetV4Sha256: string;
  rowCount: number;
}

@Injectable()
export class RecommendationValueV6TrainingService implements OnModuleInit {
  private readonly logger = new Logger(
    RecommendationValueV6TrainingService.name,
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
    const [manifest, audit, evaluation, model] = await Promise.all([
      readJson(this.paths.manifest),
      readJson(this.paths.audit),
      readJson(this.paths.evaluation),
      readJson(this.paths.model),
    ]);
    this.manifest = manifest;
    this.audit = audit;
    this.evaluation = evaluation;
    this.modelArtifact = model;
    if (manifest && audit && evaluation && model) {
      const source = record(audit.source);
      const split = record(audit.split);
      this.status = {
        ...this.createIdleStatus(),
        state: 'COMPLETE',
        phase: 'COMPLETE',
        sourceRowCount: numeric(source.sourceRowCount),
        eligibleSourceRowCount: numeric(source.eligibleSourceRowCount),
        excludedSourceRowCount: numeric(source.excludedSourceRowCount),
        sourceMatchCount: numeric(source.eligibleMatchCount),
        trainMatchCount: numeric(split.trainMatchCount),
        tuningMatchCount: numeric(split.tuningMatchCount),
        testMatchCount: numeric(split.testMatchCount),
        trainRowCount: numeric(split.trainRowCount),
        tuningRowCount: numeric(split.tuningRowCount),
        testRowCount: numeric(split.testRowCount),
        completedAt: text(manifest.generatedAt),
        manifestAvailable: true,
        auditAvailable: true,
        evaluationAvailable: true,
        modelAvailable: true,
      };
    }
  }

  async start(
    request: RecommendationValueV6TrainingStartRequest = {},
  ): Promise<RecommendationValueV6TrainingStatus> {
    if (this.status.state === 'RUNNING') {
      throw new Error('Recommendation Value V6 training is already running.');
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

  getStatus(): RecommendationValueV6TrainingStatus {
    return clone(this.status);
  }

  getManifest(): Record<string, unknown> | undefined {
    return this.manifest ? clone(this.manifest) : undefined;
  }

  getAudit(): Record<string, unknown> | undefined {
    return this.audit ? clone(this.audit) : undefined;
  }

  getEvaluation(): Record<string, unknown> | undefined {
    return this.evaluation ? clone(this.evaluation) : undefined;
  }

  getModel(): Record<string, unknown> | undefined {
    return this.modelArtifact ? clone(this.modelArtifact) : undefined;
  }

  private async run(options: RecommendationValueV6TrainingOptions): Promise<void> {
    try {
      const source = await this.loadSourceArtifacts(options);
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
        sourceRowCount: source.rowCount,
      };

      this.status = {
        ...this.status,
        phase: 'SPLITTING',
        currentPass: 1,
      };
      const sourceSummary = await this.collectSourceSummary(options);
      validateSourceSummary(sourceSummary, source.rowCount);
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
      const model = createRecommendationValueV6Model();
      const training = await this.trainModel(
        model,
        options,
        splitRuntime.trainMatchIds,
        sourceSummary.eligibleDecisionCountsByMatch,
      );
      assertWeightMatchesSplit(
        'training',
        training.totalWeight,
        splitRuntime.trainMatchIds.size,
      );
      this.status = { ...this.status, trainRowCount: training.rowCount };

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
      this.status = { ...this.status, tuningRowCount: tuning.rowCount };

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
      this.status = { ...this.status, testRowCount: test.rowCount };

      this.status = {
        ...this.status,
        phase: 'FINALIZING',
        processedRowCount: sourceSummary.sourceRowCount,
      };
      const generatedAt = new Date().toISOString();
      const releaseGate = buildReleaseGate(test, tuning.selection.actionResidualScale);
      const modelArtifact = {
        schemaVersion: RECOMMENDATION_VALUE_V6_TRAINING_SCHEMA_VERSION,
        modelVersion: RECOMMENDATION_VALUE_V6_MODEL_VERSION,
        generatedAt,
        modelKind: 'OBSERVATIONAL_STATE_ACTION_ADVANTAGE',
        target: 'SHORT_HORIZON_UTILITY_WITH_FINAL_OUTCOME_AUXILIARY',
        weighting: 'EQUAL_TOTAL_WEIGHT_PER_MATCH',
        combination: 'STATE_VALUE_PLUS_TUNED_ACTION_ADVANTAGE',
        actionResidualScale: tuning.selection.actionResidualScale,
        options: modelOptions(options),
        targetComposition: {
          finalOutcomeWeight: options.finalOutcomeWeight,
          shortHorizonWeight: 1 - options.finalOutcomeWeight,
          horizons: [...HORIZONS],
        },
        counts: serializeRecommendationValueV6Model(
          model,
          options.minimumObservations,
        ),
      };
      const evaluation = {
        schemaVersion: RECOMMENDATION_VALUE_V6_TRAINING_SCHEMA_VERSION,
        modelVersion: RECOMMENDATION_VALUE_V6_MODEL_VERSION,
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
          metrics: test.metrics,
          ranking: test.ranking,
        },
        releaseGate,
        interpretation: {
          causal: false,
          allowedUse:
            'Offline ranking diagnostics, shadow evaluation, and later propensity-corrected policy evaluation.',
          prohibitedUse:
            'Do not interpret observational action advantage as causal treatment effect or authorize live rollout.',
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
        schemaVersion: RECOMMENDATION_VALUE_V6_TRAINING_SCHEMA_VERSION,
        modelVersion: RECOMMENDATION_VALUE_V6_MODEL_VERSION,
        generatedAt,
        passed: true,
        source: {
          datasetVersion: source.manifest.datasetVersion,
          upstreamDatasetV4Sha256: source.upstreamDatasetV4Sha256,
          expectedSha256: options.expectedSourceSha256,
          actualSha256: source.sha256,
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
          trainRowCount: training.rowCount,
          tuningRowCount: tuning.rowCount,
          testRowCount: test.rowCount,
          overlapCount: 0,
        },
        weighting: {
          strategy: 'EQUAL_TOTAL_WEIGHT_PER_MATCH',
          trainTotalWeight: training.totalWeight,
          tuningTotalWeight: tuning.totalWeight,
          testTotalWeight: test.totalWeight,
          expectedTrainTotalWeight: splitRuntime.trainMatchIds.size,
          expectedTuningTotalWeight: splitRuntime.tuningMatchIds.size,
          expectedTestTotalWeight: splitRuntime.testMatchIds.size,
        },
        leakage: {
          featureCutoff: 'DECISION_TIME',
          shortHorizonOutcomesUsedOnlyAsTargets: true,
          finalOutcomeUsedOnlyAsAuxiliaryTarget: true,
          testUsedForTuning: false,
          actionResidualScaleSelectedOn: 'TUNING_ONLY',
          chronologicalMatchSplit: true,
          causalInterpretationAllowed: false,
          productionRolloutAuthorized: false,
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
        schemaVersion: RECOMMENDATION_VALUE_V6_TRAINING_SCHEMA_VERSION,
        modelVersion: RECOMMENDATION_VALUE_V6_MODEL_VERSION,
        generatedAt,
        source: {
          datasetVersion: source.manifest.datasetVersion,
          artifactSha256: source.sha256,
          upstreamDatasetV4Sha256: source.upstreamDatasetV4Sha256,
          sourceRowCount: sourceSummary.sourceRowCount,
          eligibleRowCount: sourceSummary.eligibleSourceRowCount,
        },
        split: {
          descriptorSha256: splitRuntime.descriptorSha256,
          trainFraction: options.trainFraction,
          tuningFraction: options.tuningFraction,
          testFraction: 1 - options.trainFraction - options.tuningFraction,
          trainMatchCount: splitRuntime.trainMatchIds.size,
          tuningMatchCount: splitRuntime.tuningMatchIds.size,
          testMatchCount: splitRuntime.testMatchIds.size,
          trainRowCount: training.rowCount,
          tuningRowCount: tuning.rowCount,
          testRowCount: test.rowCount,
        },
        training: {
          modelKind: 'OBSERVATIONAL_STATE_ACTION_ADVANTAGE',
          target: 'SHORT_HORIZON_UTILITY_WITH_FINAL_OUTCOME_AUXILIARY',
          weighting: 'EQUAL_TOTAL_WEIGHT_PER_MATCH',
          actionResidualScale: tuning.selection.actionResidualScale,
          actionResidualScaleSelectedOn: 'TUNING_ONLY',
          causalInterpretationAllowed: false,
          productionRolloutAuthorized: false,
          options,
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
        `Recommendation Value V6 completed with ${test.rowCount} untouched test decisions.`,
      );
    } catch (error) {
      const message = errorMessage(error);
      this.status = {
        ...this.status,
        state: 'FAILED',
        error: message,
      };
      this.logger.error(`Recommendation Value V6 failed: ${message}`);
    }
  }

  private async loadSourceArtifacts(
    options: RecommendationValueV6TrainingOptions,
  ): Promise<SourceArtifacts> {
    const manifest = await requiredJson(this.sourceManifestPath);
    const audit = await requiredJson(this.sourceAuditPath);
    if (manifest.datasetVersion !== RECOMMENDATION_DECISION_DATASET_V5_VERSION) {
      throw new Error('Recommendation Value V6 requires Dataset V5.3.');
    }
    if (audit.passed !== true) {
      throw new Error('Recommendation Dataset V5.3 did not pass its audit.');
    }
    const upstreamDatasetV4Sha256 = requiredSha(
      record(manifest.source).sha256,
    );
    const artifact = record(manifest.artifact);
    const expectedSha256 = requiredSha(artifact.sha256);
    const actualSha256 = await hashFile(this.sourceDatasetPath);
    if (expectedSha256 !== actualSha256) {
      throw new Error(
        `Recommendation Dataset V5.3 artifact hash mismatch: ${actualSha256} versus ${expectedSha256}.`,
      );
    }
    if (
      options.expectedSourceSha256 &&
      options.expectedSourceSha256 !== actualSha256
    ) {
      throw new Error(
        `Source SHA-256 mismatch: expected ${options.expectedSourceSha256}, received ${actualSha256}.`,
      );
    }
    return {
      manifest,
      audit,
      sha256: actualSha256,
      upstreamDatasetV4Sha256,
      rowCount: numeric(artifact.rowCount),
    };
  }

  private async collectSourceSummary(
    options: RecommendationValueV6TrainingOptions,
  ): Promise<SourcePassSummary> {
    const matches = new Map<string, RecommendationOfflineMatchDescriptor>();
    const eligibleDecisionCountsByMatch = new Map<string, number>();
    const decisionIds = new Set<string>();
    let sourceRowCount = 0;
    let eligibleSourceRowCount = 0;
    let excludedSourceRowCount = 0;
    let duplicateEligibleDecisionCount = 0;
    await eachSourceRow(this.sourceDatasetPath, async (row) => {
      sourceRowCount += 1;
      const prepared = prepareRecommendationValueV6Row(row, options);
      if (!prepared) {
        excludedSourceRowCount += 1;
      } else {
        eligibleSourceRowCount += 1;
        if (decisionIds.has(prepared.decisionId)) {
          duplicateEligibleDecisionCount += 1;
        }
        decisionIds.add(prepared.decisionId);
        const identity = record(row.identity);
        const firstObservedAt = requiredText(identity.decisionOccurredAt);
        const existing = matches.get(prepared.matchId);
        if (
          !existing ||
          Date.parse(firstObservedAt) < Date.parse(existing.firstObservedAt)
        ) {
          matches.set(prepared.matchId, {
            matchId: prepared.matchId,
            firstObservedAt,
          });
        }
        eligibleDecisionCountsByMatch.set(
          prepared.matchId,
          (eligibleDecisionCountsByMatch.get(prepared.matchId) ?? 0) + 1,
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
    model: RecommendationValueV6Model,
    options: RecommendationValueV6TrainingOptions,
    matchIds: ReadonlySet<string>,
    decisionCountsByMatch: ReadonlyMap<string, number>,
  ): Promise<PassMetrics> {
    let processed = 0;
    let rowCount = 0;
    let totalWeight = 0;
    await eachSourceRow(this.sourceDatasetPath, async (row) => {
      processed += 1;
      const prepared = prepareRecommendationValueV6Row(row, options);
      if (prepared && matchIds.has(prepared.matchId)) {
        const weight = matchWeight(prepared.matchId, decisionCountsByMatch);
        updateRecommendationValueV6Model(model, prepared, weight);
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
    model: RecommendationValueV6Model,
    options: RecommendationValueV6TrainingOptions,
    matchIds: ReadonlySet<string>,
    decisionCountsByMatch: ReadonlyMap<string, number>,
  ): Promise<TuningPass> {
    const states = new Map<
      number,
      {
        metrics: ReturnType<typeof createRecommendationValueV6MetricsAccumulator>;
        ranking: RankingAccumulator;
      }
    >(
      options.actionResidualScales.map((scale) => [
        scale,
        {
          metrics: createRecommendationValueV6MetricsAccumulator(),
          ranking: emptyRankingAccumulator(),
        },
      ]),
    );
    let processed = 0;
    let rowCount = 0;
    let totalWeight = 0;
    await eachSourceRow(this.sourceDatasetPath, async (row) => {
      processed += 1;
      const prepared = prepareRecommendationValueV6Row(row, options);
      if (prepared && matchIds.has(prepared.matchId)) {
        const weight = matchWeight(prepared.matchId, decisionCountsByMatch);
        rowCount += 1;
        totalWeight += weight;
        for (const [scale, state] of states) {
          const candidatePredictions = predictCandidates(
            model,
            prepared,
            modelOptions(options),
            scale,
          );
          const observed = observedPrediction(prepared, candidatePredictions);
          observeRecommendationValueV6Prediction(
            state.metrics,
            prepared,
            observed,
            candidatePredictions,
            weight,
          );
          observeRanking(
            state.ranking,
            prepared,
            candidatePredictions,
            weight,
          );
        }
      }
      if (processed % 10_000 === 0) {
        this.status = { ...this.status, processedRowCount: processed };
        await tick();
      }
    });
    const candidates = [...states.entries()].map(([scale, state]) => {
      const metrics = finalizeRecommendationValueV6Metrics(state.metrics);
      const ranking = finalizeRanking(state.ranking);
      return {
        actionResidualScale: scale,
        tuningLoss: tuningLoss(metrics, ranking),
        metrics,
        ranking,
      };
    });
    const selection = selectRecommendationValueV6ActionScale(
      candidates.map((candidate) => ({
        actionResidualScale: candidate.actionResidualScale,
        tuningLoss: candidate.tuningLoss,
      })),
    );
    return { rowCount, totalWeight, selection, candidates };
  }

  private async evaluateTest(
    model: RecommendationValueV6Model,
    options: RecommendationValueV6TrainingOptions,
    actionResidualScale: number,
    matchIds: ReadonlySet<string>,
    decisionCountsByMatch: ReadonlyMap<string, number>,
  ): Promise<EvaluationPass> {
    const metricsAccumulator = createRecommendationValueV6MetricsAccumulator();
    const rankingAccumulator = emptyRankingAccumulator();
    const partialPath = `${this.paths.predictionEvaluation}.partial`;
    const writer = await LineWriter.create(partialPath);
    let processed = 0;
    let rowCount = 0;
    let totalWeight = 0;
    try {
      await eachSourceRow(this.sourceDatasetPath, async (row) => {
        processed += 1;
        const prepared = prepareRecommendationValueV6Row(row, options);
        if (prepared && matchIds.has(prepared.matchId)) {
          const weight = matchWeight(prepared.matchId, decisionCountsByMatch);
          const candidatePredictions = predictCandidates(
            model,
            prepared,
            modelOptions(options),
            actionResidualScale,
          );
          const observed = observedPrediction(prepared, candidatePredictions);
          observeRecommendationValueV6Prediction(
            metricsAccumulator,
            prepared,
            observed,
            candidatePredictions,
            weight,
          );
          observeRanking(
            rankingAccumulator,
            prepared,
            candidatePredictions,
            weight,
          );
          const ranking = sortedCandidates(candidatePredictions);
          await writer.write({
            schemaVersion: RECOMMENDATION_VALUE_V6_TRAINING_SCHEMA_VERSION,
            modelVersion: RECOMMENDATION_VALUE_V6_MODEL_VERSION,
            decisionId: prepared.decisionId,
            matchId: prepared.matchId,
            playerWon: prepared.playerWon,
            targetUtility: prepared.targetUtility,
            targetComponents: prepared.targetComponents,
            matchWeight: weight,
            observedActionKey: prepared.observedActionKey,
            stateUtility: observed.stateUtility,
            observedActionUtility: observed.actionUtility,
            observedActionAdvantage: observed.actionAdvantage,
            stateWinProbability: observed.stateWinProbability,
            observedActionWinProbability: observed.actionWinProbability,
            supportedStateKeyCount: observed.supportedStateKeyCount,
            supportedActionKeyCount: observed.supportedActionKeyCount,
            candidateRanking: ranking.map((entry, index) => ({
              rank: index + 1,
              actionKey: entry.actionKey,
              actionUtility: entry.prediction.actionUtility,
              actionAdvantage: entry.prediction.actionAdvantage,
              actionWinProbability: entry.prediction.actionWinProbability,
              supportedActionKeyCount:
                entry.prediction.supportedActionKeyCount,
            })),
          });
          rowCount += 1;
          totalWeight += weight;
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
      metrics: finalizeRecommendationValueV6Metrics(metricsAccumulator),
      ranking: finalizeRanking(rankingAccumulator),
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

  private createIdleStatus(): RecommendationValueV6TrainingStatus {
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

export function prepareRecommendationValueV6Row(
  value: Record<string, unknown>,
  options: Pick<RecommendationValueV6TrainingOptions, 'finalOutcomeWeight'>,
): RecommendationValueV6SourceRow | undefined {
  if (value.datasetVersion !== RECOMMENDATION_DECISION_DATASET_V5_VERSION) {
    return undefined;
  }
  const identity = record(value.identity);
  const state = record(value.stateBeforeAction);
  const observedAction = record(value.observedAction);
  const trajectory = record(value.trajectory);
  const features = record(value.itemAndBuildFeatures);
  const finalOutcome = record(value.finalOutcome);
  const eligibility = record(value.trainingEligibility);
  const observedActionKey = text(observedAction.actionKey);
  const playerWon = boolean(finalOutcome.playerWon);
  if (
    eligibility.exactAction !== true ||
    eligibility.finalOutcome !== true ||
    finalOutcome.available !== true ||
    finalOutcome.conflicting === true ||
    observedActionKey === undefined ||
    playerWon === undefined
  ) {
    return undefined;
  }
  const matchId = text(identity.matchId);
  const decisionId = text(value.decisionId);
  const heroId = numeric(identity.heroId || state.heroId);
  const timeBucket = numeric(state.timeBucket);
  const inventoryStateKey = text(state.inventoryStateKey) ?? 'UNKNOWN';
  if (!matchId || !decisionId || heroId <= 0) {
    return undefined;
  }
  const candidateRows = records(state.candidateActions);
  const featureCandidates = new Map(
    records(features.candidates).map((candidate) => [
      text(candidate.actionKey) ?? '',
      candidate,
    ]),
  );
  const candidateActionKeys = uniqueStrings([
    ...candidateRows.map((candidate) => text(candidate.actionKey)),
    observedActionKey,
  ]);
  if (candidateActionKeys.length === 0) {
    return undefined;
  }
  const previousActions = strings(trajectory.fullPreviousActionKeys);
  const teamId = text(identity.teamId) ?? String(numeric(identity.teamId));
  const inventory = record(features.inventory);
  const timeline = record(state.playerTimelineSnapshot);
  const teamEconomy = record(state.teamEconomy);
  const stateKeys = buildRecommendationValueV6StateKeys({
    heroId,
    teamId: teamId || 'UNKNOWN',
    timeBucket,
    inventoryStateKey,
    previousActionKeys: previousActions,
    alliedHeroIds: numbers(state.alliedHeroIds),
    enemyHeroIds: numbers(state.enemyHeroIds),
    inventoryTotalCost: numeric(inventory.totalCost),
    inventoryHighestTier: numeric(inventory.highestTier),
    playerNetWorth:
      timeline.available === true ? numeric(timeline.netWorth) : undefined,
    playerKills:
      timeline.available === true ? numeric(timeline.kills) : undefined,
    playerDeaths:
      timeline.available === true ? numeric(timeline.deaths) : undefined,
    playerAssists:
      timeline.available === true ? numeric(timeline.assists) : undefined,
    teamNetWorthDelta:
      teamEconomy.available === true
        ? numeric(teamEconomy.netWorthDelta)
        : undefined,
    teamRelativeNetWorthDelta:
      teamEconomy.available === true
        ? numeric(teamEconomy.relativeNetWorthDelta)
        : undefined,
    playerNetWorthRankInTeam:
      numeric(teamEconomy.playerNetWorthRankInTeam) > 0
        ? numeric(teamEconomy.playerNetWorthRankInTeam)
        : undefined,
    playerNetWorthShare:
      teamEconomy.available === true
        ? numeric(teamEconomy.playerNetWorthShare)
        : undefined,
  });
  const teamEconomyBand = stateKeys
    .find((key) => key.startsWith(`TEAM_ECONOMY_BAND:${heroId}|`))
    ?.split('|')[1];
  const buildSharedActionKeys = (
    actionKey: string,
    feature: Record<string, unknown>,
  ): string[] => {
    const item = record(feature.item);
    return buildRecommendationValueV6ActionKeys({
      heroId,
      timeBucket,
      inventoryStateKey,
      previousActionKeys: previousActions,
      teamEconomyBand:
        teamEconomyBand === 'FAR_BEHIND' ||
        teamEconomyBand === 'BEHIND' ||
        teamEconomyBand === 'EVEN' ||
        teamEconomyBand === 'AHEAD' ||
        teamEconomyBand === 'FAR_AHEAD'
          ? teamEconomyBand
          : undefined,
      actionKey,
      slotType: text(item.slotType),
      tier: numeric(item.tier),
      cost: numeric(item.cost),
      isActiveItem: item.isActiveItem === true,
      tags: strings(item.tags),
      interactionKeys: strings(feature.interactionKeys),
    });
  };
  const observedFeature =
    featureCandidates.get(observedActionKey) ?? record(features.observedAction);
  const actionKeys = buildSharedActionKeys(observedActionKey, observedFeature);
  const candidateActions = candidateActionKeys.map((actionKey) => ({
    actionKey,
    actionKeys: buildSharedActionKeys(
      actionKey,
      featureCandidates.get(actionKey) ?? {},
    ),
  }));
  const finalUtility = playerWon ? 1 : -1;
  const shortHorizon = computeRecommendationValueV6ShortHorizonUtility(value);
  const targetUtility = shortHorizon
    ? clamp(
        options.finalOutcomeWeight * finalUtility +
          (1 - options.finalOutcomeWeight) * shortHorizon.utility,
        -1,
        1,
      )
    : finalUtility;
  return {
    decisionId,
    matchId,
    playerWon,
    targetUtility,
    targetComponents: {
      finalOutcome: finalUtility,
      shortHorizonUtility: shortHorizon?.utility,
      shortHorizonCount: shortHorizon?.count ?? 0,
    },
    stateKeys,
    actionKeys,
    observedActionKey,
    candidateActions,
  };
}

export function computeRecommendationValueV6ShortHorizonUtility(
  value: Record<string, unknown>,
): { utility: number; count: number } | undefined {
  const shortHorizon = record(value.shortHorizonOutcomes);
  const windows = record(shortHorizon.windows);
  const values: Array<{ utility: number; weight: number }> = [];
  for (const horizon of HORIZONS) {
    const window = record(windows[horizon]);
    if (window.available !== true) {
      continue;
    }
    const utility = clamp(
      numeric(window.killsDelta) * 0.12 +
        numeric(window.assistsDelta) * 0.05 +
        numeric(window.killParticipationDelta) * 0.04 -
        numeric(window.deathsDelta) * 0.18 +
        numeric(window.netWorthDelta) / 10_000 +
        numeric(window.heroDamageDelta) / 25_000 +
        numeric(window.enemyObjectiveLossCount) * 0.12 -
        numeric(window.ownObjectiveLossCount) * 0.12 +
        (window.survived === true ? 0.05 : 0),
      -1,
      1,
    );
    values.push({ utility, weight: horizonWeight(horizon) });
  }
  if (values.length === 0) {
    return undefined;
  }
  const totalWeight = values.reduce((sum, entry) => sum + entry.weight, 0);
  return {
    utility:
      values.reduce((sum, entry) => sum + entry.utility * entry.weight, 0) /
      totalWeight,
    count: values.length,
  };
}

function predictCandidates(
  model: RecommendationValueV6Model,
  row: RecommendationValueV6SourceRow,
  options: RecommendationValueV6ModelOptions,
  scale: number,
): Array<{ actionKey: string; prediction: RecommendationValueV6Prediction }> {
  return row.candidateActions.map((candidate) => ({
    actionKey: candidate.actionKey,
    prediction: predictRecommendationValueV6(
      model,
      { stateKeys: row.stateKeys, actionKeys: candidate.actionKeys },
      options,
      scale,
    ),
  }));
}

function observedPrediction(
  row: RecommendationValueV6SourceRow,
  predictions: Array<{
    actionKey: string;
    prediction: RecommendationValueV6Prediction;
  }>,
): RecommendationValueV6Prediction {
  const result = predictions.find(
    (entry) => entry.actionKey === row.observedActionKey,
  )?.prediction;
  if (!result) {
    throw new Error(
      `Observed action ${row.observedActionKey} is missing from candidate predictions.`,
    );
  }
  return result;
}

function sortedCandidates(
  predictions: Array<{
    actionKey: string;
    prediction: RecommendationValueV6Prediction;
  }>,
): Array<{ actionKey: string; prediction: RecommendationValueV6Prediction }> {
  return [...predictions].sort(
    (left, right) =>
      right.prediction.actionAdvantage - left.prediction.actionAdvantage ||
      left.actionKey.localeCompare(right.actionKey),
  );
}

function emptyRankingAccumulator(): RankingAccumulator {
  return {
    decisionWeight: 0,
    pairWeight: 0,
    correctlyOrderedPairWeight: 0,
    ndcgWeight: 0,
    regretWeight: 0,
    confidentWeight: 0,
    candidateSetWeight: 0,
  };
}

function observeRanking(
  accumulator: RankingAccumulator,
  row: RecommendationValueV6SourceRow,
  predictions: Array<{
    actionKey: string;
    prediction: RecommendationValueV6Prediction;
  }>,
  weight: number,
): void {
  const ranking = sortedCandidates(predictions);
  const observedIndex = ranking.findIndex(
    (entry) => entry.actionKey === row.observedActionKey,
  );
  if (observedIndex < 0) {
    return;
  }
  accumulator.decisionWeight += weight;
  accumulator.candidateSetWeight += ranking.length >= 2 ? weight : 0;
  accumulator.ndcgWeight += weight / Math.log2(observedIndex + 2);
  accumulator.regretWeight +=
    weight *
    Math.max(
      0,
      ranking[0].prediction.actionAdvantage -
        ranking[observedIndex].prediction.actionAdvantage,
    );
  if (ranking.length >= 2) {
    const separation =
      ranking[0].prediction.actionAdvantage -
      ranking[1].prediction.actionAdvantage;
    accumulator.confidentWeight += separation >= 0.01 ? weight : 0;
  }
  for (let index = 0; index < ranking.length; index += 1) {
    if (index === observedIndex) {
      continue;
    }
    accumulator.pairWeight += weight;
    accumulator.correctlyOrderedPairWeight += observedIndex < index ? weight : 0;
  }
}

function finalizeRanking(accumulator: RankingAccumulator): RankingMetrics {
  const decisionWeight = Math.max(accumulator.decisionWeight, Number.EPSILON);
  const pairWeight = Math.max(accumulator.pairWeight, Number.EPSILON);
  return {
    pairwiseObservedActionAccuracy:
      accumulator.correctlyOrderedPairWeight / pairWeight,
    observedActionNdcg: accumulator.ndcgWeight / decisionWeight,
    averageObservedActionRegret: accumulator.regretWeight / decisionWeight,
    confidentSeparationRate: accumulator.confidentWeight / decisionWeight,
    candidateSetCoverage: accumulator.candidateSetWeight / decisionWeight,
  };
}

function tuningLoss(
  metrics: RecommendationValueV6Metrics,
  ranking: RankingMetrics,
): number {
  return (
    metrics.actionRmse +
    metrics.actionLogLoss * 0.1 +
    Math.max(0, -metrics.utilityRmseImprovement) * 2 +
    Math.max(0, -metrics.logLossImprovement) * 0.25 +
    ranking.averageObservedActionRegret * 0.05 -
    ranking.observedActionNdcg * 0.005
  );
}

function buildReleaseGate(
  test: EvaluationPass,
  actionResidualScale: number,
): { passed: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (test.metrics.matchCount < 100) {
    reasons.push('Untouched test contains fewer than 100 matches.');
  }
  if (actionResidualScale <= 0) {
    reasons.push('Tuning selected a zero action-advantage scale.');
  }
  if (test.metrics.utilityRmseImprovement < 0) {
    reasons.push('Action-conditioned utility RMSE is worse than state-only.');
  }
  if (test.metrics.logLossImprovement < -0.001) {
    reasons.push('Action-conditioned win log-loss degrades by more than 0.001.');
  }
  if (test.metrics.actionSupportCoverage < 0.3) {
    reasons.push('Action-context weighted support coverage is below 30%.');
  }
  if (test.metrics.shortHorizonCoverage < 0.2) {
    reasons.push('Short-horizon target coverage is below 20%.');
  }
  if (test.ranking.candidateSetCoverage < 0.5) {
    reasons.push('Fewer than 50% of weighted decisions contain two candidates.');
  }
  if (test.ranking.confidentSeparationRate <= 0) {
    reasons.push('The model never separates the top two candidates by 0.01 utility.');
  }
  return { passed: reasons.length === 0, reasons };
}

function normalizeOptions(
  request: RecommendationValueV6TrainingStartRequest,
): RecommendationValueV6TrainingOptions {
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
    statePriorStrength: nonNegativeNumber(
      request.statePriorStrength ?? 100,
      'statePriorStrength',
    ),
    actionPriorStrength: nonNegativeNumber(
      request.actionPriorStrength ?? 100,
      'actionPriorStrength',
    ),
    minimumObservations: positiveInteger(
      request.minimumObservations ?? 20,
      'minimumObservations',
    ),
    maximumAbsoluteStateResidual: positiveNumber(
      request.maximumAbsoluteStateResidual ?? 1,
      'maximumAbsoluteStateResidual',
    ),
    maximumAbsoluteActionResidual: positiveNumber(
      request.maximumAbsoluteActionResidual ?? 1,
      'maximumAbsoluteActionResidual',
    ),
    actionResidualScales: normalizeScales(
      request.actionResidualScales ?? DEFAULT_ACTION_SCALES,
    ),
    finalOutcomeWeight: boundedNumber(
      request.finalOutcomeWeight ?? 0.25,
      0,
      1,
      'finalOutcomeWeight',
    ),
    expectedSourceSha256: normalizeSha(request.expectedSourceSha256),
  };
}

function modelOptions(
  options: RecommendationValueV6TrainingOptions,
): RecommendationValueV6ModelOptions {
  return {
    statePriorStrength: options.statePriorStrength,
    actionPriorStrength: options.actionPriorStrength,
    minimumObservations: options.minimumObservations,
    maximumAbsoluteStateResidual: options.maximumAbsoluteStateResidual,
    maximumAbsoluteActionResidual: options.maximumAbsoluteActionResidual,
  };
}

function validateSourceSummary(
  summary: SourcePassSummary,
  expectedRowCount: number,
): void {
  if (summary.sourceRowCount !== expectedRowCount) {
    throw new Error('Recommendation Dataset V5.3 row count does not match manifest.');
  }
  if (summary.duplicateEligibleDecisionCount > 0) {
    throw new Error('Value V6 source contains duplicate eligible decision IDs.');
  }
  if (summary.matches.length < 3) {
    throw new Error('Value V6 requires at least three eligible matches.');
  }
}

function matchWeight(
  matchId: string,
  decisionCountsByMatch: ReadonlyMap<string, number>,
): number {
  const count = decisionCountsByMatch.get(matchId) ?? 0;
  if (count <= 0) {
    throw new Error(`Value V6 match ${matchId} has no eligible decision count.`);
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
      `Value V6 ${splitName} weight ${actualWeight} does not match ${expectedMatchCount} matches.`,
    );
  }
}

function horizonWeight(horizon: (typeof HORIZONS)[number]): number {
  if (horizon === '3m') {
    return 1;
  }
  if (horizon === '5m') {
    return 0.75;
  }
  return 0.5;
}

function normalizeScales(values: readonly number[]): number[] {
  const result = [...new Set(values)].sort((left, right) => left - right);
  if (
    result.length === 0 ||
    result.some((value) => !Number.isFinite(value) || value < 0)
  ) {
    throw new Error('actionResidualScales must contain finite non-negative values.');
  }
  return result;
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

function positiveInteger(value: number, fieldName: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${fieldName} must be a positive safe integer.`);
  }
  return value;
}

function boundedNumber(
  value: number,
  minimum: number,
  maximum: number,
  fieldName: string,
): number {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${fieldName} must be between ${minimum} and ${maximum}.`);
  }
  return value;
}

function normalizeSha(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new Error(
      'expectedSourceSha256 must be a 64-character hexadecimal SHA-256.',
    );
  }
  return normalized;
}

async function eachSourceRow(
  path: string,
  visit: (row: Record<string, unknown>) => Promise<void>,
): Promise<void> {
  const input = createReadStream(path, { encoding: 'utf8' });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      await visit(JSON.parse(line) as Record<string, unknown>);
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

async function requiredJson(path: string): Promise<Record<string, unknown>> {
  const value = await readJson(path);
  if (!value) {
    throw new Error(`Required JSON artifact is missing: ${path}.`);
  }
  return value;
}

async function readJson(
  path: string,
): Promise<Record<string, unknown> | undefined> {
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

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(record) : [];
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

function numbers(value: unknown): number[] {
  return Array.isArray(value)
    ? value.filter(
        (entry): entry is number =>
          typeof entry === 'number' && Number.isFinite(entry),
      )
    : [];
}

function text(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
}

function requiredText(value: unknown): string {
  const result = text(value);
  if (!result) {
    throw new Error('Required text value is missing.');
  }
  return result;
}

function requiredSha(value: unknown): string {
  const result = requiredText(value).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(result)) {
    throw new Error('Required SHA-256 value is invalid.');
  }
  return result;
}

function numeric(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function boolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function uniqueStrings(values: readonly (string | undefined)[]): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function bucket(value: number, width: number): number {
  return Math.floor(value / width);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function tick(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
