import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createHeroBuildContextualV2ValidationGrid,
  HeroBuildContextualV2Config,
  HeroBuildNextActionContextIndexSummary,
  HERO_BUILD_CONTEXTUAL_V2_MODEL_VERSION,
} from './hero-build-contextual-v2.model';
import { HeroBuildOfflineV2ContextIndex } from './hero-build-offline-evaluation-v2-context-index';
import {
  HeroBuildOfflineEvaluationDataLoaderService,
  HeroBuildOfflineLoadedHeroSample,
  chunkValues,
  isEvaluableBuildSequence,
} from './hero-build-offline-evaluation-data-loader.service';
import {
  HeroBuildOfflineEvaluationV2Model,
  HeroBuildOfflineV2PredictionResult,
} from './hero-build-offline-evaluation-v2.model';
import {
  HeroBuildOfflineV2ComparisonAccumulator,
  HeroBuildOfflineV2ComparisonSnapshot,
  buildHeroBuildOfflineV2StatisticalSummary,
  calculateMcNemarFromComparison,
} from './hero-build-offline-evaluation-v2-aggregate';
import {
  HERO_BUILD_OFFLINE_EVALUATION_DEFAULT_BATCH_SIZE,
  HERO_BUILD_OFFLINE_EVALUATION_DEFAULT_MAX_RSS_MB,
  HERO_BUILD_OFFLINE_EVALUATION_LOW_MEMORY_MODE,
  HERO_BUILD_OFFLINE_EVALUATION_MAX_BATCH_SIZE,
  HERO_BUILD_OFFLINE_EVALUATION_MAX_MAX_RSS_MB,
  HERO_BUILD_OFFLINE_EVALUATION_MIN_BATCH_SIZE,
  HERO_BUILD_OFFLINE_EVALUATION_MIN_MAX_RSS_MB,
} from './hero-build-offline-evaluation-low-memory.service';
import {
  HeroBuildOfflineModelPrediction,
  HERO_BUILD_OFFLINE_EVALUATION_GAME_TIME_BUCKET_S,
  normalizeObservedActionKey,
} from './hero-build-offline-evaluation.model';
import {
  HeroBuildEvaluationPhase,
  HeroBuildOfflineEvaluationComparison,
  HeroBuildOfflineEvaluationMatchDescriptor,
  HeroBuildOfflineEvaluationTrainingSummary,
  getHeroBuildEvaluationPhase,
} from './hero-build-offline-evaluation.service';
import {
  adjustPValuesBenjaminiHochberg,
  evaluateHeroBuildOfflineReleaseGates,
  HeroBuildOfflinePairedStatisticalSummary,
  HeroBuildOfflineReleaseGateResult,
  HeroBuildOfflineEvaluationThreeWaySplit,
  HERO_BUILD_OFFLINE_EVALUATION_V2_DEFAULT_BOOTSTRAP_ITERATIONS,
  HERO_BUILD_OFFLINE_EVALUATION_V2_DEFAULT_BOOTSTRAP_SEED,
  HERO_BUILD_OFFLINE_EVALUATION_V2_DEFAULT_TRAIN_FRACTION,
  HERO_BUILD_OFFLINE_EVALUATION_V2_DEFAULT_VALIDATION_FRACTION,
  HERO_BUILD_OFFLINE_EVALUATION_V2_MODEL_VERSION,
  splitHeroBuildEvaluationMatchesThreeWay,
} from './hero-build-offline-evaluation-v2';
import {
  HeroBuildPolicyAggregationSnapshot,
  HeroBuildTransitionAccumulator,
} from './hero-build-transition-aggregation.service';
import { RecipeAwareTimelineReconciliationService } from './recipe-aware-timeline-reconciliation.service';

export const HERO_BUILD_OFFLINE_EVALUATION_V2_PERSISTENCE_MODE =
  'CHECKPOINT_PER_HERO' as const;
export const HERO_BUILD_OFFLINE_EVALUATION_V2_CHECKPOINT_SCHEMA_VERSION = 1;
export const HERO_BUILD_OFFLINE_EVALUATION_V2_DEFAULT_MAX_MATCHES = 13_000;
export const HERO_BUILD_OFFLINE_EVALUATION_V2_MAX_MATCHES = 13_000;
export const HERO_BUILD_OFFLINE_EVALUATION_V2_DEFAULT_CHANGED_PREDICTION_LIMIT =
  100;
export const HERO_BUILD_OFFLINE_EVALUATION_V2_MAX_CHANGED_PREDICTION_LIMIT = 500;
export const HERO_BUILD_OFFLINE_EVALUATION_V2_DEFAULT_FINAL_TEST_NOT_BEFORE =
  '2026-07-17T11:46:14.000Z';
export const HERO_BUILD_OFFLINE_EVALUATION_V2_LARGE_HERO_SAMPLE_COUNT = 5_000;

const BYTES_PER_MEGABYTE = 1024 * 1024;
const DEFAULT_STORAGE_DIRECTORY = '/app/apps/api/storage/build-evaluation-v2';
const STORAGE_DIRECTORY_ENV = 'DEADLOCK_BUILD_EVALUATION_V2_STORAGE_DIR';
const AUTO_RESUME_ENV = 'DEADLOCK_BUILD_EVALUATION_V2_AUTO_RESUME';
const FINAL_TEST_NOT_BEFORE_ENV =
  'DEADLOCK_BUILD_EVALUATION_V2_FINAL_TEST_NOT_BEFORE';
const BATCH_SIZE_ENV = 'DEADLOCK_BUILD_EVALUATION_BATCH_SIZE';
const MAX_RSS_MB_ENV = 'DEADLOCK_BUILD_EVALUATION_MAX_RSS_MB';
const CHECKPOINT_FILE_NAME = 'checkpoint.json';
const VALIDATION_REPORT_FILE_NAME = 'validation-report.json';
const SELECTION_FILE_NAME = 'selection.json';
const FINAL_REPORT_FILE_NAME = 'final-report.json';

export type HeroBuildOfflineEvaluationV2RunMode =
  | 'VALIDATION_ONLY'
  | 'FINAL_TEST';
export type HeroBuildOfflineEvaluationV2RunState =
  | 'IDLE'
  | 'RUNNING'
  | 'COMPLETE'
  | 'FAILED';
export type HeroBuildOfflineEvaluationV2ProgressPhase =
  | 'PREPARING'
  | 'TRAINING'
  | 'EVALUATING_VALIDATION'
  | 'EVALUATING_FINAL_TEST'
  | 'COMPLETE';

export interface HeroBuildOfflineEvaluationV2StartRequest {
  runMode?: HeroBuildOfflineEvaluationV2RunMode;
  trainFraction?: number;
  validationFraction?: number;
  maxMatches?: number;
  changedPredictionLimit?: number;
  bootstrapIterations?: number;
  bootstrapSeed?: number;
  finalTestNotBefore?: string;
}

export interface HeroBuildOfflineEvaluationV2Options {
  runMode: HeroBuildOfflineEvaluationV2RunMode;
  trainFraction: number;
  validationFraction: number;
  maxMatches: number;
  changedPredictionLimit: number;
  bootstrapIterations: number;
  bootstrapSeed: number;
  finalTestNotBefore: string;
}

export interface HeroBuildOfflineEvaluationV2Status {
  state: HeroBuildOfflineEvaluationV2RunState;
  runMode?: HeroBuildOfflineEvaluationV2RunMode;
  phase?: HeroBuildOfflineEvaluationV2ProgressPhase;
  options?: HeroBuildOfflineEvaluationV2Options;
  startedAt?: Date;
  completedAt?: Date;
  totalMatchCount: number;
  trainMatchCount: number;
  validationMatchCount: number;
  finalTestMatchCount: number;
  processedTrainMatchCount: number;
  processedEvaluationMatchCount: number;
  evaluatedStepCount: number;
  totalHeroCount: number;
  processedHeroCount: number;
  currentHeroId?: number;
  currentConfigurationId?: string;
  validationReportAvailable: boolean;
  selectionAvailable: boolean;
  selectedConfigurationId?: string;
  finalReportAvailable: boolean;
  checkpointAvailable: boolean;
  resumedFromCheckpoint: boolean;
  persistenceMode: typeof HERO_BUILD_OFFLINE_EVALUATION_V2_PERSISTENCE_MODE;
  storageDirectory: string;
  autoResume: boolean;
  memoryMode: typeof HERO_BUILD_OFFLINE_EVALUATION_LOW_MEMORY_MODE;
  batchSize: number;
  maxRssMb: number;
  currentRssMb: number;
  peakRssMb: number;
  databaseRetryCount: number;
  databaseRetryDelayMs: number;
  error?: string;
}

export interface HeroBuildOfflineEvaluationV2SplitReport {
  strategy: 'CHRONOLOGICAL_TRAIN_VALIDATION_TEST';
  selectedMatchCount: number;
  trainMatchCount: number;
  validationMatchCount: number;
  finalTestMatchCount: number;
  trainFraction: number;
  validationFraction: number;
  trainStartTime: Date;
  trainEndTime: Date;
  validationStartTime: Date;
  validationEndTime: Date;
  finalTestStartTime: Date;
  finalTestEndTime: Date;
  finalTestNotBefore: Date;
  finalTestIsNewerThanInspectedHoldout: boolean;
  overlappingMatchCount: 0;
}

export interface HeroBuildOfflineEvaluationV2TrainingSummary
  extends HeroBuildOfflineEvaluationTrainingSummary {
  contextScopeCount: number;
  contextActionOptionCount: number;
  contextObservationCount: number;
  contextEnemyObservationCount: number;
}

export interface HeroBuildOfflineEvaluationV2DataSummary {
  sourcePlayerCount: number;
  evaluatedPlayerCount: number;
  excludedPlayerCount: number;
  evaluatedStepCount: number;
}

export interface HeroBuildOfflineEvaluationV2ChangedPredictionDiagnostic {
  matchId: number;
  matchStartTime: Date;
  playerId: number;
  heroId: number;
  phase: HeroBuildEvaluationPhase;
  gameTimeS: number;
  stateKey: string;
  enemyHeroIds: number[];
  actualActionKey: string;
  baselineActionKeys: string[];
  contextualActionKeys: string[];
  baselineTopActionKey?: string;
  contextualTopActionKey?: string;
  baselineMode: HeroBuildOfflineModelPrediction['mode'];
  contextualMode: HeroBuildOfflineModelPrediction['mode'];
  baselineCorrect: boolean;
  contextualCorrect: boolean;
  contextualImproved: boolean;
  contextualWorsened: boolean;
  configId: string;
  topContextualLogitBonus: number;
  topRosterInteractionLogOdds: number;
  topObservedEnemyCount: number;
  topEligibleEnemyCount: number;
}

export interface HeroBuildOfflineEvaluationV2HeroResult {
  heroId: number;
  comparison: HeroBuildOfflineEvaluationComparison;
  mcnemar: ReturnType<typeof calculateMcNemarFromComparison>;
  adjustedPValue?: number;
}

export interface HeroBuildOfflineEvaluationV2PhaseResult {
  phase: HeroBuildEvaluationPhase;
  comparison: HeroBuildOfflineEvaluationComparison;
}

export interface HeroBuildOfflineEvaluationV2ConfigurationReport {
  config: HeroBuildContextualV2Config;
  data: HeroBuildOfflineEvaluationV2DataSummary;
  overall: HeroBuildOfflineEvaluationComparison;
  statistics: HeroBuildOfflinePairedStatisticalSummary;
  byPhase: HeroBuildOfflineEvaluationV2PhaseResult[];
  byHero: HeroBuildOfflineEvaluationV2HeroResult[];
  changedPredictions: HeroBuildOfflineEvaluationV2ChangedPredictionDiagnostic[];
  eligibleForSelection: boolean;
  selectionViolations: string[];
}

export interface HeroBuildOfflineEvaluationV2SelectionArtifact {
  schemaVersion: 1;
  modelVersion: typeof HERO_BUILD_OFFLINE_EVALUATION_V2_MODEL_VERSION;
  contextualModelVersion: typeof HERO_BUILD_CONTEXTUAL_V2_MODEL_VERSION;
  generatedAt: Date;
  sourceWindowLastRefreshedAt?: Date;
  options: HeroBuildOfflineEvaluationV2Options;
  split: HeroBuildOfflineEvaluationThreeWaySplit;
  heroIds: number[];
  selectedConfig?: HeroBuildContextualV2Config;
  selectionReason: string;
  eligibleConfigurationCount: number;
  validationTop1DeltaPercentagePoints?: number;
  validationTop3DeltaPercentagePoints?: number;
}

export interface HeroBuildOfflineEvaluationV2ValidationReport {
  reportType: 'VALIDATION';
  modelVersion: typeof HERO_BUILD_OFFLINE_EVALUATION_V2_MODEL_VERSION;
  contextualModelVersion: typeof HERO_BUILD_CONTEXTUAL_V2_MODEL_VERSION;
  generatedAt: Date;
  sourceWindowLastRefreshedAt?: Date;
  target: 'OBSERVED_NEXT_ACTION';
  options: HeroBuildOfflineEvaluationV2Options;
  split: HeroBuildOfflineEvaluationV2SplitReport;
  training: HeroBuildOfflineEvaluationV2TrainingSummary;
  configurations: HeroBuildOfflineEvaluationV2ConfigurationReport[];
  selection: HeroBuildOfflineEvaluationV2SelectionArtifact;
  warnings: string[];
  execution: HeroBuildOfflineEvaluationV2ExecutionSummary;
}

export interface HeroBuildOfflineEvaluationV2FinalReport {
  reportType: 'FINAL_TEST';
  modelVersion: typeof HERO_BUILD_OFFLINE_EVALUATION_V2_MODEL_VERSION;
  contextualModelVersion: typeof HERO_BUILD_CONTEXTUAL_V2_MODEL_VERSION;
  generatedAt: Date;
  sourceWindowLastRefreshedAt?: Date;
  target: 'OBSERVED_NEXT_ACTION';
  options: HeroBuildOfflineEvaluationV2Options;
  split: HeroBuildOfflineEvaluationV2SplitReport;
  training: HeroBuildOfflineEvaluationV2TrainingSummary;
  selectedConfig: HeroBuildContextualV2Config;
  result: HeroBuildOfflineEvaluationV2ConfigurationReport;
  releaseGates: HeroBuildOfflineReleaseGateResult;
  releaseDecision: 'PASS' | 'FAIL';
  warnings: string[];
  execution: HeroBuildOfflineEvaluationV2ExecutionSummary;
}

export interface HeroBuildOfflineEvaluationV2ExecutionSummary {
  memoryMode: typeof HERO_BUILD_OFFLINE_EVALUATION_LOW_MEMORY_MODE;
  persistenceMode: typeof HERO_BUILD_OFFLINE_EVALUATION_V2_PERSISTENCE_MODE;
  batchSize: number;
  maxRssMb: number;
  totalHeroCount: number;
  peakRssMb: number;
  resumedFromCheckpoint: boolean;
}

interface MutableConfigurationAggregate {
  config: HeroBuildContextualV2Config;
  overall: HeroBuildOfflineV2ComparisonAccumulator;
  byPhase: Map<
    HeroBuildEvaluationPhase,
    HeroBuildOfflineV2ComparisonAccumulator
  >;
  byHero: HeroBuildOfflineEvaluationV2HeroResult[];
  changedPredictions: HeroBuildOfflineEvaluationV2ChangedPredictionDiagnostic[];
  sourcePlayerCount: number;
  evaluatedPlayerCount: number;
  excludedPlayerCount: number;
  evaluatedStepCount: number;
}

interface PersistedConfigurationAggregate {
  config: HeroBuildContextualV2Config;
  overall: HeroBuildOfflineV2ComparisonSnapshot;
  byPhase: Array<{
    phase: HeroBuildEvaluationPhase;
    snapshot: HeroBuildOfflineV2ComparisonSnapshot;
  }>;
  byHero: HeroBuildOfflineEvaluationV2HeroResult[];
  changedPredictions: PersistedChangedPredictionDiagnostic[];
  sourcePlayerCount: number;
  evaluatedPlayerCount: number;
  excludedPlayerCount: number;
  evaluatedStepCount: number;
}

interface PersistedChangedPredictionDiagnostic
  extends Omit<
    HeroBuildOfflineEvaluationV2ChangedPredictionDiagnostic,
    'matchStartTime'
  > {
  matchStartTime: string;
}

interface PersistedMatchDescriptor {
  matchId: number;
  startTime: string;
}

interface PersistedThreeWaySplit {
  strategy: 'CHRONOLOGICAL_TRAIN_VALIDATION_TEST';
  selected: PersistedMatchDescriptor[];
  train: PersistedMatchDescriptor[];
  validation: PersistedMatchDescriptor[];
  test: PersistedMatchDescriptor[];
  trainFraction: number;
  validationFraction: number;
}

interface EvaluationCheckpoint {
  schemaVersion: typeof HERO_BUILD_OFFLINE_EVALUATION_V2_CHECKPOINT_SCHEMA_VERSION;
  modelVersion: typeof HERO_BUILD_OFFLINE_EVALUATION_V2_MODEL_VERSION;
  savedAt: string;
  startedAt: string;
  runMode: HeroBuildOfflineEvaluationV2RunMode;
  options: HeroBuildOfflineEvaluationV2Options;
  sourceWindowLastRefreshedAt?: string;
  split: PersistedThreeWaySplit;
  heroIds: number[];
  nextHeroIndex: number;
  training: HeroBuildOfflineEvaluationV2TrainingSummary;
  aggregates: PersistedConfigurationAggregate[];
  peakRssMb: number;
}

@Injectable()
export class HeroBuildOfflineEvaluationV2ResilientService
  implements OnModuleInit
{
  private readonly logger = new Logger(
    HeroBuildOfflineEvaluationV2ResilientService.name,
  );
  private readonly storageDirectory =
    process.env[STORAGE_DIRECTORY_ENV]?.trim() ||
    DEFAULT_STORAGE_DIRECTORY;
  private readonly autoResume = readBooleanEnvironmentValue(
    AUTO_RESUME_ENV,
    true,
  );
  private readonly batchSize = readBoundedIntegerEnvironmentValue(
    BATCH_SIZE_ENV,
    HERO_BUILD_OFFLINE_EVALUATION_DEFAULT_BATCH_SIZE,
    HERO_BUILD_OFFLINE_EVALUATION_MIN_BATCH_SIZE,
    HERO_BUILD_OFFLINE_EVALUATION_MAX_BATCH_SIZE,
  );
  private readonly maxRssMb = readBoundedIntegerEnvironmentValue(
    MAX_RSS_MB_ENV,
    HERO_BUILD_OFFLINE_EVALUATION_DEFAULT_MAX_RSS_MB,
    HERO_BUILD_OFFLINE_EVALUATION_MIN_MAX_RSS_MB,
    HERO_BUILD_OFFLINE_EVALUATION_MAX_MAX_RSS_MB,
  );
  private readonly checkpointPath = join(
    this.storageDirectory,
    CHECKPOINT_FILE_NAME,
  );
  private readonly validationReportPath = join(
    this.storageDirectory,
    VALIDATION_REPORT_FILE_NAME,
  );
  private readonly selectionPath = join(
    this.storageDirectory,
    SELECTION_FILE_NAME,
  );
  private readonly finalReportPath = join(
    this.storageDirectory,
    FINAL_REPORT_FILE_NAME,
  );
  private runPromise?: Promise<void>;
  private validationReport?: HeroBuildOfflineEvaluationV2ValidationReport;
  private selection?: HeroBuildOfflineEvaluationV2SelectionArtifact;
  private finalReport?: HeroBuildOfflineEvaluationV2FinalReport;
  private peakRssBytes = 0;
  private status: HeroBuildOfflineEvaluationV2Status;

  constructor(
    private readonly dataLoader:
      HeroBuildOfflineEvaluationDataLoaderService,
    private readonly recipeAwareTimelineReconciliationService:
      RecipeAwareTimelineReconciliationService,
  ) {
    this.status = this.createIdleStatus();
  }

  async onModuleInit(): Promise<void> {
    await mkdir(this.storageDirectory, { recursive: true });
    const checkpoint = await this.readCheckpoint();
    if (this.autoResume && checkpoint) {
      this.restoreRunningStatus(checkpoint);
      this.launchRun(checkpoint.options, checkpoint, false);
      return;
    }

    this.selection = await this.readSelection();
    this.finalReport = await this.readFinalReport();
    this.validationReport = await this.readValidationReport();
    if (this.finalReport) {
      this.restoreCompletedStatus('FINAL_TEST', this.finalReport);
    } else if (this.validationReport) {
      this.restoreCompletedStatus(
        'VALIDATION_ONLY',
        this.validationReport,
      );
    }
  }

  async start(
    request: HeroBuildOfflineEvaluationV2StartRequest = {},
  ): Promise<HeroBuildOfflineEvaluationV2Status> {
    if (this.runPromise) {
      return this.getStatus();
    }
    let options = normalizeOptions(request);
    if (options.runMode === 'FINAL_TEST') {
      this.selection = await this.readSelection();
      if (!this.selection?.selectedConfig) {
        throw new Error(
          'Final-test evaluation requires a completed validation run with a selected non-control configuration.',
        );
      }
      options = {
        ...this.selection.options,
        runMode: 'FINAL_TEST',
        changedPredictionLimit: options.changedPredictionLimit,
        bootstrapIterations: options.bootstrapIterations,
        bootstrapSeed: options.bootstrapSeed,
        finalTestNotBefore:
          this.selection.options.finalTestNotBefore,
      };
      const existingFinalReport = await this.readFinalReport();
      if (existingFinalReport) {
        this.finalReport = existingFinalReport;
        this.restoreCompletedStatus(
          'FINAL_TEST',
          existingFinalReport,
        );
        return this.getStatus();
      }
    }

    this.peakRssBytes = 0;
    this.status = {
      ...this.createIdleStatus(),
      state: 'RUNNING',
      runMode: options.runMode,
      phase: 'PREPARING',
      options,
      startedAt: new Date(),
      selectionAvailable: this.selection !== undefined,
      selectedConfigurationId: this.selection?.selectedConfig?.id,
    };
    this.sampleMemoryUsage();
    this.launchRun(options, undefined, true);
    return this.getStatus();
  }

  getStatus(): HeroBuildOfflineEvaluationV2Status {
    return {
      ...this.status,
      options: this.status.options
        ? { ...this.status.options }
        : undefined,
      startedAt: cloneDate(this.status.startedAt),
      completedAt: cloneDate(this.status.completedAt),
      ...this.getMemoryStatus(),
    };
  }

  getValidationReport():
    | HeroBuildOfflineEvaluationV2ValidationReport
    | undefined {
    return this.validationReport;
  }

  getSelection():
    | HeroBuildOfflineEvaluationV2SelectionArtifact
    | undefined {
    return this.selection;
  }

  getFinalReport():
    | HeroBuildOfflineEvaluationV2FinalReport
    | undefined {
    return this.finalReport;
  }

  private launchRun(
    options: HeroBuildOfflineEvaluationV2Options,
    checkpoint: EvaluationCheckpoint | undefined,
    clearPersistentState: boolean,
  ): void {
    this.runPromise = this.run(
      options,
      checkpoint,
      clearPersistentState,
    )
      .then(() => {
        this.status = {
          ...this.status,
          state: 'COMPLETE',
          phase: 'COMPLETE',
          completedAt: new Date(),
          currentHeroId: undefined,
          currentConfigurationId: undefined,
          checkpointAvailable: false,
          validationReportAvailable:
            this.validationReport !== undefined,
          selectionAvailable: this.selection !== undefined,
          selectedConfigurationId:
            this.selection?.selectedConfig?.id,
          finalReportAvailable: this.finalReport !== undefined,
          error: undefined,
          ...this.getMemoryStatus(),
        };
      })
      .catch((error: unknown) => {
        const message = getErrorMessage(error);
        this.status = {
          ...this.status,
          state: 'FAILED',
          completedAt: new Date(),
          currentHeroId: undefined,
          currentConfigurationId: undefined,
          error: message,
          ...this.getMemoryStatus(),
        };
        this.logger.error(
          `Offline evaluation V2 failed: ${message}`,
        );
        throw error;
      })
      .finally(() => {
        this.runPromise = undefined;
      });
    void this.runPromise.catch(() => undefined);
  }

  private async run(
    options: HeroBuildOfflineEvaluationV2Options,
    checkpoint: EvaluationCheckpoint | undefined,
    clearPersistentState: boolean,
  ): Promise<void> {
    await mkdir(this.storageDirectory, { recursive: true });
    if (clearPersistentState) {
      if (options.runMode === 'VALIDATION_ONLY') {
        await Promise.all([
          rm(this.checkpointPath, { force: true }),
          rm(this.validationReportPath, { force: true }),
          rm(this.selectionPath, { force: true }),
          rm(this.finalReportPath, { force: true }),
        ]);
        this.validationReport = undefined;
        this.selection = undefined;
        this.finalReport = undefined;
      } else {
        await rm(this.checkpointPath, { force: true });
      }
    }

    try {
      await this.dataLoader.withDatabaseRetry(
        'refreshing timeline recipes',
        () =>
          this.recipeAwareTimelineReconciliationService.refreshRecipes(),
      );
    } catch (error) {
      this.logger.warn(
        `Using the existing recipe cache for offline evaluation V2: ${getErrorMessage(error)}`,
      );
    }

    let split: HeroBuildOfflineEvaluationThreeWaySplit;
    let heroIds: number[];
    let sourceWindowLastRefreshedAt: Date | undefined;
    let nextHeroIndex: number;
    let training: HeroBuildOfflineEvaluationV2TrainingSummary;
    let aggregates: MutableConfigurationAggregate[];

    if (checkpoint) {
      split = deserializeSplit(checkpoint.split);
      heroIds = [...checkpoint.heroIds];
      sourceWindowLastRefreshedAt = parseOptionalDate(
        checkpoint.sourceWindowLastRefreshedAt,
      );
      nextHeroIndex = checkpoint.nextHeroIndex;
      training = { ...checkpoint.training };
      aggregates = checkpoint.aggregates.map(restoreAggregate);
    } else if (options.runMode === 'FINAL_TEST') {
      const selection =
        this.selection ?? (await this.readSelection());
      if (!selection?.selectedConfig) {
        throw new Error(
          'No frozen contextual V2 configuration is available.',
        );
      }
      split = cloneThreeWaySplit(selection.split);
      heroIds = [...selection.heroIds];
      sourceWindowLastRefreshedAt = cloneDate(
        selection.sourceWindowLastRefreshedAt,
      );
      assertFinalTestCutoff(
        split,
        options.finalTestNotBefore,
      );
      nextHeroIndex = 0;
      training = createEmptyTrainingSummary();
      aggregates = [createEmptyAggregate(selection.selectedConfig)];
      await this.persistCheckpoint({
        options,
        sourceWindowLastRefreshedAt,
        split,
        heroIds,
        nextHeroIndex,
        training,
        aggregates,
      });
    } else {
      const loaded = await this.dataLoader.loadMatchDescriptors(
        options.maxMatches,
      );
      split = splitHeroBuildEvaluationMatchesThreeWay(
        loaded.descriptors,
        options.trainFraction,
        options.validationFraction,
        options.maxMatches,
      );
      assertFinalTestCutoff(
        split,
        options.finalTestNotBefore,
      );
      sourceWindowLastRefreshedAt =
        loaded.sourceLastRefreshedAt;
      heroIds = await this.dataLoader.collectHeroIds(
        split.selected,
        this.batchSize,
      );
      if (heroIds.length === 0) {
        throw new Error(
          'No valid hero players were found in the selected matches.',
        );
      }
      nextHeroIndex = 0;
      training = createEmptyTrainingSummary();
      aggregates =
        createHeroBuildContextualV2ValidationGrid().map(
          createEmptyAggregate,
        );
      await this.persistCheckpoint({
        options,
        sourceWindowLastRefreshedAt,
        split,
        heroIds,
        nextHeroIndex,
        training,
        aggregates,
      });
    }

    const evaluationDescriptors =
      options.runMode === 'VALIDATION_ONLY'
        ? split.validation
        : split.test;
    this.status = {
      ...this.status,
      totalMatchCount: split.selected.length,
      trainMatchCount: split.train.length,
      validationMatchCount: split.validation.length,
      finalTestMatchCount: split.test.length,
      totalHeroCount: heroIds.length,
      processedHeroCount: nextHeroIndex,
      evaluatedStepCount: Math.max(
        0,
        ...aggregates.map(
          (aggregate) => aggregate.evaluatedStepCount,
        ),
      ),
      checkpointAvailable: true,
      ...this.getMemoryStatus(),
    };

    for (
      let heroIndex = nextHeroIndex;
      heroIndex < heroIds.length;
      heroIndex += 1
    ) {
      const heroId = heroIds[heroIndex];
      this.status = {
        ...this.status,
        phase: 'TRAINING',
        currentHeroId: heroId,
        currentConfigurationId: undefined,
        processedTrainMatchCount: 0,
        processedEvaluationMatchCount: 0,
        ...this.getMemoryStatus(),
      };
      const transitionAccumulator =
        new HeroBuildTransitionAccumulator();
      const contextIndex = new HeroBuildOfflineV2ContextIndex();

      for (const [batchIndex, descriptors] of chunkValues(
        split.train,
        this.batchSize,
      ).entries()) {
        const loaded = await this.dataLoader.loadHeroBatch(
          heroId,
          descriptors,
          this.batchSize,
          `training V2 hero ${heroId}, batch ${batchIndex + 1}`,
        );
        for (const sample of loaded.samples) {
          transitionAccumulator.addPlayer(sample.sequence);
          contextIndex.addSequence(
            sample.sequence,
            sample.enemyHeroIds,
          );
        }
        this.status = {
          ...this.status,
          processedTrainMatchCount: Math.min(
            split.train.length,
            (batchIndex + 1) * this.batchSize,
          ),
          ...this.getMemoryStatus(),
        };
        this.assertMemoryBudget(`training V2 hero ${heroId}`);
        await yieldToEventLoop();
      }

      const policySnapshot = transitionAccumulator.build();
      addTrainingSummary(
        training,
        policySnapshot,
        contextIndex.getSummary(),
      );
      const model = new HeroBuildOfflineEvaluationV2Model(
        policySnapshot.policiesByHeroId,
        contextIndex,
        (parentItemId) =>
          this.recipeAwareTimelineReconciliationService.getComponentItemIds(
            parentItemId,
          ),
      );
      const heroAccumulators = new Map(
        aggregates.map((aggregate) => [
          aggregate.config.id,
          new HeroBuildOfflineV2ComparisonAccumulator(),
        ]),
      );
      this.status = {
        ...this.status,
        phase:
          options.runMode === 'VALIDATION_ONLY'
            ? 'EVALUATING_VALIDATION'
            : 'EVALUATING_FINAL_TEST',
        ...this.getMemoryStatus(),
      };

      for (const [batchIndex, descriptors] of chunkValues(
        evaluationDescriptors,
        this.batchSize,
      ).entries()) {
        const loaded = await this.dataLoader.loadHeroBatch(
          heroId,
          descriptors,
          this.batchSize,
          `${
            options.runMode === 'VALIDATION_ONLY'
              ? 'validating'
              : 'final testing'
          } V2 hero ${heroId}, batch ${batchIndex + 1}`,
        );
        for (const aggregate of aggregates) {
          aggregate.sourcePlayerCount += loaded.sourcePlayerCount;
        }

        for (const sample of loaded.samples) {
          if (!isEvaluableBuildSequence(sample.sequence)) {
            for (const aggregate of aggregates) {
              aggregate.excludedPlayerCount += 1;
            }
            continue;
          }
          for (const aggregate of aggregates) {
            aggregate.evaluatedPlayerCount += 1;
          }

          for (const step of sample.sequence.steps) {
            const prepared = model.prepare({
              heroId: sample.sequence.heroId,
              stateKey: step.beforeStateKey,
              gameTimeS: step.gameTimeS,
              enemyHeroIds: sample.enemyHeroIds,
            });
            const actualActionKey = normalizeObservedActionKey(
              step.actionType,
              step.itemId,
            );
            const phase = getHeroBuildEvaluationPhase(
              step.gameTimeS,
            );

            for (const aggregate of aggregates) {
              this.status.currentConfigurationId =
                aggregate.config.id;
              const result = model.predict(
                prepared,
                aggregate.config,
              );
              aggregate.overall.add(
                sample.descriptor.matchId,
                result.baseline,
                result.contextual,
                actualActionKey,
              );
              getOrCreatePhaseAccumulator(
                aggregate.byPhase,
                phase,
              ).add(
                sample.descriptor.matchId,
                result.baseline,
                result.contextual,
                actualActionKey,
              );
              heroAccumulators
                .get(aggregate.config.id)
                ?.add(
                  sample.descriptor.matchId,
                  result.baseline,
                  result.contextual,
                  actualActionKey,
                );
              if (
                result.baseline.topActionKey !==
                  result.contextual.topActionKey &&
                aggregate.changedPredictions.length <
                  options.changedPredictionLimit
              ) {
                aggregate.changedPredictions.push(
                  createChangedPredictionDiagnostic(
                    sample,
                    step.gameTimeS,
                    step.beforeStateKey,
                    phase,
                    actualActionKey,
                    aggregate.config.id,
                    result,
                  ),
                );
              }
              aggregate.evaluatedStepCount += 1;
            }
          }
        }

        this.status = {
          ...this.status,
          processedEvaluationMatchCount: Math.min(
            evaluationDescriptors.length,
            (batchIndex + 1) * this.batchSize,
          ),
          evaluatedStepCount: Math.max(
            0,
            ...aggregates.map(
              (aggregate) => aggregate.evaluatedStepCount,
            ),
          ),
          ...this.getMemoryStatus(),
        };
        this.assertMemoryBudget(`evaluating V2 hero ${heroId}`);
        await yieldToEventLoop();
      }

      for (const aggregate of aggregates) {
        const heroAccumulator = heroAccumulators.get(
          aggregate.config.id,
        );
        if (heroAccumulator) {
          const comparison =
            heroAccumulator.buildComparison();
          aggregate.byHero.push({
            heroId,
            comparison,
            mcnemar:
              calculateMcNemarFromComparison(comparison),
          });
        }
      }

      nextHeroIndex = heroIndex + 1;
      this.status = {
        ...this.status,
        processedHeroCount: nextHeroIndex,
        currentConfigurationId: undefined,
        ...this.getMemoryStatus(),
      };
      this.assertMemoryBudget(`finishing V2 hero ${heroId}`);
      await this.persistCheckpoint({
        options,
        sourceWindowLastRefreshedAt,
        split,
        heroIds,
        nextHeroIndex,
        training,
        aggregates,
      });
      await yieldToEventLoop();
    }

    if (options.runMode === 'VALIDATION_ONLY') {
      const configurationReports = aggregates.map(
        (aggregate, index) =>
          createConfigurationReport(
            aggregate,
            options.bootstrapIterations,
            options.bootstrapSeed + index * 10,
          ),
      );
      const selection = createSelectionArtifact({
        options,
        sourceWindowLastRefreshedAt,
        split,
        heroIds,
        configurationReports,
      });
      const report: HeroBuildOfflineEvaluationV2ValidationReport = {
        reportType: 'VALIDATION',
        modelVersion:
          HERO_BUILD_OFFLINE_EVALUATION_V2_MODEL_VERSION,
        contextualModelVersion:
          HERO_BUILD_CONTEXTUAL_V2_MODEL_VERSION,
        generatedAt: new Date(),
        sourceWindowLastRefreshedAt: cloneDate(
          sourceWindowLastRefreshedAt,
        ),
        target: 'OBSERVED_NEXT_ACTION',
        options: { ...options },
        split: createSplitReport(
          split,
          options.finalTestNotBefore,
        ),
        training: { ...training },
        configurations: configurationReports,
        selection,
        warnings: createValidationWarnings(selection),
        execution: this.createExecutionSummary(heroIds.length),
      };
      await Promise.all([
        this.writeJsonAtomically(
          this.validationReportPath,
          report,
        ),
        this.writeJsonAtomically(this.selectionPath, selection),
      ]);
      this.validationReport = report;
      this.selection = selection;
      this.logger.log(
        `Validation-only evaluation completed across ${heroIds.length} heroes. ` +
          `Selected configuration: ${
            selection.selectedConfig?.id ?? 'none'
          }.`,
      );
    } else {
      const aggregate = aggregates[0];
      const result = createConfigurationReport(
        aggregate,
        options.bootstrapIterations,
        options.bootstrapSeed,
      );
      const releaseGates = createReleaseGateResult(result);
      const report: HeroBuildOfflineEvaluationV2FinalReport = {
        reportType: 'FINAL_TEST',
        modelVersion:
          HERO_BUILD_OFFLINE_EVALUATION_V2_MODEL_VERSION,
        contextualModelVersion:
          HERO_BUILD_CONTEXTUAL_V2_MODEL_VERSION,
        generatedAt: new Date(),
        sourceWindowLastRefreshedAt: cloneDate(
          sourceWindowLastRefreshedAt,
        ),
        target: 'OBSERVED_NEXT_ACTION',
        options: { ...options },
        split: createSplitReport(
          split,
          options.finalTestNotBefore,
        ),
        training: { ...training },
        selectedConfig: { ...aggregate.config },
        result,
        releaseGates,
        releaseDecision: releaseGates.passed
          ? 'PASS'
          : 'FAIL',
        warnings: [
          'The final chronological test was evaluated after validation configuration selection was frozen.',
          'Accuracy measures agreement with observed player decisions, not causal proof that an item is optimal.',
        ],
        execution: this.createExecutionSummary(heroIds.length),
      };
      await this.writeJsonAtomically(
        this.finalReportPath,
        report,
      );
      this.finalReport = report;
      this.logger.log(
        `Final-test evaluation completed with decision ${report.releaseDecision}: ` +
          `top-1 delta ${result.overall.top1DeltaPercentagePoints.toFixed(4)} points.`,
      );
    }

    await rm(this.checkpointPath, { force: true });
  }

  private async persistCheckpoint(input: {
    options: HeroBuildOfflineEvaluationV2Options;
    sourceWindowLastRefreshedAt?: Date;
    split: HeroBuildOfflineEvaluationThreeWaySplit;
    heroIds: number[];
    nextHeroIndex: number;
    training: HeroBuildOfflineEvaluationV2TrainingSummary;
    aggregates: MutableConfigurationAggregate[];
  }): Promise<void> {
    const checkpoint: EvaluationCheckpoint = {
      schemaVersion:
        HERO_BUILD_OFFLINE_EVALUATION_V2_CHECKPOINT_SCHEMA_VERSION,
      modelVersion:
        HERO_BUILD_OFFLINE_EVALUATION_V2_MODEL_VERSION,
      savedAt: new Date().toISOString(),
      startedAt: (
        this.status.startedAt ?? new Date()
      ).toISOString(),
      runMode: input.options.runMode,
      options: { ...input.options },
      sourceWindowLastRefreshedAt:
        input.sourceWindowLastRefreshedAt?.toISOString(),
      split: serializeSplit(input.split),
      heroIds: [...input.heroIds],
      nextHeroIndex: input.nextHeroIndex,
      training: { ...input.training },
      aggregates: input.aggregates.map(serializeAggregate),
      peakRssMb: bytesToMegabytes(this.peakRssBytes),
    };
    await this.writeJsonAtomically(
      this.checkpointPath,
      checkpoint,
    );
    this.status = {
      ...this.status,
      checkpointAvailable: true,
    };
  }

  private async readCheckpoint(): Promise<
    EvaluationCheckpoint | undefined
  > {
    const raw = await this.readJsonFile(this.checkpointPath);
    if (!isCheckpoint(raw)) {
      return undefined;
    }
    return raw;
  }

  private async readValidationReport(): Promise<
    HeroBuildOfflineEvaluationV2ValidationReport | undefined
  > {
    const raw = await this.readJsonFile(
      this.validationReportPath,
    );
    if (!isRecord(raw) || raw.reportType !== 'VALIDATION') {
      return undefined;
    }
    return reviveValidationReport(
      raw as unknown as HeroBuildOfflineEvaluationV2ValidationReport,
    );
  }

  private async readSelection(): Promise<
    HeroBuildOfflineEvaluationV2SelectionArtifact | undefined
  > {
    const raw = await this.readJsonFile(this.selectionPath);
    if (
      !isRecord(raw) ||
      raw.modelVersion !==
        HERO_BUILD_OFFLINE_EVALUATION_V2_MODEL_VERSION
    ) {
      return undefined;
    }
    return reviveSelection(
      raw as unknown as HeroBuildOfflineEvaluationV2SelectionArtifact,
    );
  }

  private async readFinalReport(): Promise<
    HeroBuildOfflineEvaluationV2FinalReport | undefined
  > {
    const raw = await this.readJsonFile(this.finalReportPath);
    if (!isRecord(raw) || raw.reportType !== 'FINAL_TEST') {
      return undefined;
    }
    return reviveFinalReport(
      raw as unknown as HeroBuildOfflineEvaluationV2FinalReport,
    );
  }

  private async readJsonFile(
    path: string,
  ): Promise<unknown | undefined> {
    try {
      return JSON.parse(await readFile(path, 'utf8')) as unknown;
    } catch (error) {
      if (getErrorCode(error) === 'ENOENT') {
        return undefined;
      }
      this.logger.error(
        `Failed to read ${path}: ${getErrorMessage(error)}`,
      );
      return undefined;
    }
  }

  private async writeJsonAtomically(
    path: string,
    value: unknown,
  ): Promise<void> {
    const temporaryPath = `${path}.${process.pid}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(value), 'utf8');
    await rename(temporaryPath, path);
  }

  private restoreRunningStatus(
    checkpoint: EvaluationCheckpoint,
  ): void {
    this.peakRssBytes = Math.max(
      this.peakRssBytes,
      checkpoint.peakRssMb * BYTES_PER_MEGABYTE,
    );
    this.status = {
      ...this.createIdleStatus(),
      state: 'RUNNING',
      runMode: checkpoint.runMode,
      phase: 'PREPARING',
      options: { ...checkpoint.options },
      startedAt: new Date(checkpoint.startedAt),
      totalMatchCount: checkpoint.split.selected.length,
      trainMatchCount: checkpoint.split.train.length,
      validationMatchCount:
        checkpoint.split.validation.length,
      finalTestMatchCount: checkpoint.split.test.length,
      totalHeroCount: checkpoint.heroIds.length,
      processedHeroCount: checkpoint.nextHeroIndex,
      evaluatedStepCount: Math.max(
        0,
        ...checkpoint.aggregates.map(
          (aggregate) => aggregate.evaluatedStepCount,
        ),
      ),
      resumedFromCheckpoint: true,
      checkpointAvailable: true,
      ...this.getMemoryStatus(),
    };
  }

  private restoreCompletedStatus(
    runMode: HeroBuildOfflineEvaluationV2RunMode,
    report:
      | HeroBuildOfflineEvaluationV2ValidationReport
      | HeroBuildOfflineEvaluationV2FinalReport,
  ): void {
    this.peakRssBytes = Math.max(
      this.peakRssBytes,
      report.execution.peakRssMb * BYTES_PER_MEGABYTE,
    );
    this.status = {
      ...this.createIdleStatus(),
      state: 'COMPLETE',
      runMode,
      phase: 'COMPLETE',
      options: { ...report.options },
      startedAt: new Date(report.generatedAt),
      completedAt: new Date(report.generatedAt),
      totalMatchCount: report.split.selectedMatchCount,
      trainMatchCount: report.split.trainMatchCount,
      validationMatchCount:
        report.split.validationMatchCount,
      finalTestMatchCount: report.split.finalTestMatchCount,
      processedTrainMatchCount: report.split.trainMatchCount,
      processedEvaluationMatchCount:
        runMode === 'VALIDATION_ONLY'
          ? report.split.validationMatchCount
          : report.split.finalTestMatchCount,
      evaluatedStepCount:
        report.reportType === 'VALIDATION'
          ? Math.max(
              0,
              ...report.configurations.map(
                (configuration) =>
                  configuration.data.evaluatedStepCount,
              ),
            )
          : report.result.data.evaluatedStepCount,
      totalHeroCount: report.execution.totalHeroCount,
      processedHeroCount: report.execution.totalHeroCount,
      validationReportAvailable:
        this.validationReport !== undefined,
      selectionAvailable: this.selection !== undefined,
      selectedConfigurationId:
        this.selection?.selectedConfig?.id,
      finalReportAvailable: this.finalReport !== undefined,
      checkpointAvailable: false,
      ...this.getMemoryStatus(),
    };
  }

  private createExecutionSummary(
    totalHeroCount: number,
  ): HeroBuildOfflineEvaluationV2ExecutionSummary {
    return {
      memoryMode: HERO_BUILD_OFFLINE_EVALUATION_LOW_MEMORY_MODE,
      persistenceMode:
        HERO_BUILD_OFFLINE_EVALUATION_V2_PERSISTENCE_MODE,
      batchSize: this.batchSize,
      maxRssMb: this.maxRssMb,
      totalHeroCount,
      peakRssMb: round(
        bytesToMegabytes(this.peakRssBytes),
      ),
      resumedFromCheckpoint:
        this.status.resumedFromCheckpoint,
    };
  }

  private createIdleStatus(): HeroBuildOfflineEvaluationV2Status {
    const retry = this.dataLoader.getRetrySettings();
    return {
      state: 'IDLE',
      totalMatchCount: 0,
      trainMatchCount: 0,
      validationMatchCount: 0,
      finalTestMatchCount: 0,
      processedTrainMatchCount: 0,
      processedEvaluationMatchCount: 0,
      evaluatedStepCount: 0,
      totalHeroCount: 0,
      processedHeroCount: 0,
      validationReportAvailable: false,
      selectionAvailable: false,
      finalReportAvailable: false,
      checkpointAvailable: false,
      resumedFromCheckpoint: false,
      persistenceMode:
        HERO_BUILD_OFFLINE_EVALUATION_V2_PERSISTENCE_MODE,
      storageDirectory: this.storageDirectory,
      autoResume: this.autoResume,
      memoryMode: HERO_BUILD_OFFLINE_EVALUATION_LOW_MEMORY_MODE,
      batchSize: this.batchSize,
      maxRssMb: this.maxRssMb,
      currentRssMb: round(
        bytesToMegabytes(process.memoryUsage().rss),
      ),
      peakRssMb: 0,
      databaseRetryCount: retry.retryCount,
      databaseRetryDelayMs: retry.retryDelayMs,
    };
  }

  private assertMemoryBudget(context: string): void {
    const usage = this.sampleMemoryUsage();
    if (
      usage.rss <=
      this.maxRssMb * BYTES_PER_MEGABYTE
    ) {
      return;
    }
    throw new Error(
      `Offline evaluation V2 exceeded the ${this.maxRssMb} MB RSS safety limit while ` +
        `${context}. Current RSS is ${bytesToMegabytes(usage.rss).toFixed(2)} MB.`,
    );
  }

  private sampleMemoryUsage(): NodeJS.MemoryUsage {
    const usage = process.memoryUsage();
    this.peakRssBytes = Math.max(
      this.peakRssBytes,
      usage.rss,
    );
    return usage;
  }

  private getMemoryStatus(): Pick<
    HeroBuildOfflineEvaluationV2Status,
    'currentRssMb' | 'peakRssMb'
  > {
    const usage = this.sampleMemoryUsage();
    return {
      currentRssMb: round(bytesToMegabytes(usage.rss)),
      peakRssMb: round(
        bytesToMegabytes(this.peakRssBytes),
      ),
    };
  }
}

export function normalizeOptions(
  request: HeroBuildOfflineEvaluationV2StartRequest,
): HeroBuildOfflineEvaluationV2Options {
  const finalTestNotBefore =
    request.finalTestNotBefore ??
    process.env[FINAL_TEST_NOT_BEFORE_ENV]?.trim() ??
    HERO_BUILD_OFFLINE_EVALUATION_V2_DEFAULT_FINAL_TEST_NOT_BEFORE;
  const parsedCutoff = new Date(finalTestNotBefore);
  if (!Number.isFinite(parsedCutoff.getTime())) {
    throw new Error(
      'finalTestNotBefore must be a valid ISO-8601 date.',
    );
  }
  return {
    runMode: request.runMode ?? 'VALIDATION_ONLY',
    trainFraction:
      request.trainFraction ??
      HERO_BUILD_OFFLINE_EVALUATION_V2_DEFAULT_TRAIN_FRACTION,
    validationFraction:
      request.validationFraction ??
      HERO_BUILD_OFFLINE_EVALUATION_V2_DEFAULT_VALIDATION_FRACTION,
    maxMatches:
      request.maxMatches ??
      HERO_BUILD_OFFLINE_EVALUATION_V2_DEFAULT_MAX_MATCHES,
    changedPredictionLimit:
      request.changedPredictionLimit ??
      HERO_BUILD_OFFLINE_EVALUATION_V2_DEFAULT_CHANGED_PREDICTION_LIMIT,
    bootstrapIterations:
      request.bootstrapIterations ??
      HERO_BUILD_OFFLINE_EVALUATION_V2_DEFAULT_BOOTSTRAP_ITERATIONS,
    bootstrapSeed:
      request.bootstrapSeed ??
      HERO_BUILD_OFFLINE_EVALUATION_V2_DEFAULT_BOOTSTRAP_SEED,
    finalTestNotBefore: parsedCutoff.toISOString(),
  };
}

function createEmptyAggregate(
  config: HeroBuildContextualV2Config,
): MutableConfigurationAggregate {
  return {
    config: { ...config },
    overall: new HeroBuildOfflineV2ComparisonAccumulator(),
    byPhase: new Map(),
    byHero: [],
    changedPredictions: [],
    sourcePlayerCount: 0,
    evaluatedPlayerCount: 0,
    excludedPlayerCount: 0,
    evaluatedStepCount: 0,
  };
}

function serializeAggregate(
  aggregate: MutableConfigurationAggregate,
): PersistedConfigurationAggregate {
  return {
    config: { ...aggregate.config },
    overall: aggregate.overall.buildSnapshot(),
    byPhase: [...aggregate.byPhase.entries()].map(
      ([phase, accumulator]) => ({
        phase,
        snapshot: accumulator.buildSnapshot(),
      }),
    ),
    byHero: aggregate.byHero.map(cloneHeroResult),
    changedPredictions: aggregate.changedPredictions.map(
      (diagnostic) => ({
        ...diagnostic,
        matchStartTime:
          diagnostic.matchStartTime.toISOString(),
        enemyHeroIds: [...diagnostic.enemyHeroIds],
        baselineActionKeys: [
          ...diagnostic.baselineActionKeys,
        ],
        contextualActionKeys: [
          ...diagnostic.contextualActionKeys,
        ],
      }),
    ),
    sourcePlayerCount: aggregate.sourcePlayerCount,
    evaluatedPlayerCount: aggregate.evaluatedPlayerCount,
    excludedPlayerCount: aggregate.excludedPlayerCount,
    evaluatedStepCount: aggregate.evaluatedStepCount,
  };
}

function restoreAggregate(
  aggregate: PersistedConfigurationAggregate,
): MutableConfigurationAggregate {
  return {
    config: { ...aggregate.config },
    overall: new HeroBuildOfflineV2ComparisonAccumulator(
      aggregate.overall,
    ),
    byPhase: new Map(
      aggregate.byPhase.map((value) => [
        value.phase,
        new HeroBuildOfflineV2ComparisonAccumulator(
          value.snapshot,
        ),
      ]),
    ),
    byHero: aggregate.byHero.map(cloneHeroResult),
    changedPredictions: aggregate.changedPredictions.map(
      (diagnostic) => ({
        ...diagnostic,
        matchStartTime: new Date(diagnostic.matchStartTime),
        enemyHeroIds: [...diagnostic.enemyHeroIds],
        baselineActionKeys: [
          ...diagnostic.baselineActionKeys,
        ],
        contextualActionKeys: [
          ...diagnostic.contextualActionKeys,
        ],
      }),
    ),
    sourcePlayerCount: aggregate.sourcePlayerCount,
    evaluatedPlayerCount: aggregate.evaluatedPlayerCount,
    excludedPlayerCount: aggregate.excludedPlayerCount,
    evaluatedStepCount: aggregate.evaluatedStepCount,
  };
}

function createConfigurationReport(
  aggregate: MutableConfigurationAggregate,
  bootstrapIterations: number,
  bootstrapSeed: number,
): HeroBuildOfflineEvaluationV2ConfigurationReport {
  const overallSnapshot = aggregate.overall.buildSnapshot();
  const overall = overallSnapshot.comparison;
  const selectionViolations =
    createValidationSelectionViolations(
      aggregate.config,
      overall,
    );
  const byHero = applyHeroFdr(aggregate.byHero);
  return {
    config: { ...aggregate.config },
    data: {
      sourcePlayerCount: aggregate.sourcePlayerCount,
      evaluatedPlayerCount: aggregate.evaluatedPlayerCount,
      excludedPlayerCount: aggregate.excludedPlayerCount,
      evaluatedStepCount: aggregate.evaluatedStepCount,
    },
    overall,
    statistics: buildHeroBuildOfflineV2StatisticalSummary(
      overallSnapshot,
      bootstrapIterations,
      bootstrapSeed,
    ),
    byPhase: (
      ['EARLY', 'MID', 'LATE'] as HeroBuildEvaluationPhase[]
    ).map((phase) => ({
      phase,
      comparison:
        aggregate.byPhase.get(phase)?.buildComparison() ??
        new HeroBuildOfflineV2ComparisonAccumulator().buildComparison(),
    })),
    byHero,
    changedPredictions: aggregate.changedPredictions.map(
      (diagnostic) => ({
        ...diagnostic,
        matchStartTime: new Date(
          diagnostic.matchStartTime,
        ),
        enemyHeroIds: [...diagnostic.enemyHeroIds],
        baselineActionKeys: [
          ...diagnostic.baselineActionKeys,
        ],
        contextualActionKeys: [
          ...diagnostic.contextualActionKeys,
        ],
      }),
    ),
    eligibleForSelection: selectionViolations.length === 0,
    selectionViolations,
  };
}

function createValidationSelectionViolations(
  config: HeroBuildContextualV2Config,
  comparison: HeroBuildOfflineEvaluationComparison,
): string[] {
  const violations: string[] = [];
  if (config.id === 'baseline-control' || config.lambda <= 0) {
    violations.push(
      'The baseline control cannot be selected as a contextual candidate.',
    );
  }
  if (comparison.top1DeltaPercentagePoints <= 0) {
    violations.push(
      'Validation top-1 delta is not positive.',
    );
  }
  if (comparison.top3DeltaPercentagePoints < 0) {
    violations.push('Validation top-3 delta is negative.');
  }
  if (comparison.coverageDeltaPercentagePoints < -0.05) {
    violations.push(
      'Validation coverage delta is below -0.05 points.',
    );
  }
  if (
    comparison.contextualImprovedCount <=
    comparison.contextualWorsenedCount
  ) {
    violations.push(
      'Validation improvements do not exceed regressions.',
    );
  }
  return violations;
}

function createSelectionArtifact(input: {
  options: HeroBuildOfflineEvaluationV2Options;
  sourceWindowLastRefreshedAt?: Date;
  split: HeroBuildOfflineEvaluationThreeWaySplit;
  heroIds: number[];
  configurationReports: HeroBuildOfflineEvaluationV2ConfigurationReport[];
}): HeroBuildOfflineEvaluationV2SelectionArtifact {
  const eligible = input.configurationReports
    .filter((report) => report.eligibleForSelection)
    .sort(compareValidationCandidates);
  const selected = eligible[0];
  return {
    schemaVersion: 1,
    modelVersion:
      HERO_BUILD_OFFLINE_EVALUATION_V2_MODEL_VERSION,
    contextualModelVersion:
      HERO_BUILD_CONTEXTUAL_V2_MODEL_VERSION,
    generatedAt: new Date(),
    sourceWindowLastRefreshedAt: cloneDate(
      input.sourceWindowLastRefreshedAt,
    ),
    options: { ...input.options },
    split: cloneThreeWaySplit(input.split),
    heroIds: [...input.heroIds],
    selectedConfig: selected
      ? { ...selected.config }
      : undefined,
    selectionReason: selected
      ? 'Selected the eligible validation configuration with the strongest clustered top-1 lower bound, then point estimate and top-3 delta.'
      : 'No contextual configuration passed the validation safety criteria. The final test remains locked.',
    eligibleConfigurationCount: eligible.length,
    validationTop1DeltaPercentagePoints:
      selected?.overall.top1DeltaPercentagePoints,
    validationTop3DeltaPercentagePoints:
      selected?.overall.top3DeltaPercentagePoints,
  };
}

function compareValidationCandidates(
  left: HeroBuildOfflineEvaluationV2ConfigurationReport,
  right: HeroBuildOfflineEvaluationV2ConfigurationReport,
): number {
  return (
    right.statistics.top1.lower95PercentagePoints -
      left.statistics.top1.lower95PercentagePoints ||
    right.overall.top1DeltaPercentagePoints -
      left.overall.top1DeltaPercentagePoints ||
    right.overall.top3DeltaPercentagePoints -
      left.overall.top3DeltaPercentagePoints ||
    left.overall.changedTop1Count -
      right.overall.changedTop1Count ||
    left.config.id.localeCompare(right.config.id)
  );
}

function createReleaseGateResult(
  result: HeroBuildOfflineEvaluationV2ConfigurationReport,
): HeroBuildOfflineReleaseGateResult {
  const phaseDeltas = result.byPhase
    .filter(
      (group) => group.comparison.baseline.sampleCount > 0,
    )
    .map(
      (group) => group.comparison.top1DeltaPercentagePoints,
    );
  const largeHeroDeltas = result.byHero
    .filter(
      (group) =>
        group.comparison.baseline.sampleCount >=
        HERO_BUILD_OFFLINE_EVALUATION_V2_LARGE_HERO_SAMPLE_COUNT,
    )
    .map(
      (group) => group.comparison.top1DeltaPercentagePoints,
    );
  return evaluateHeroBuildOfflineReleaseGates({
    top1DeltaPercentagePoints:
      result.overall.top1DeltaPercentagePoints,
    top1Lower95PercentagePoints:
      result.statistics.top1.lower95PercentagePoints,
    top3DeltaPercentagePoints:
      result.overall.top3DeltaPercentagePoints,
    top3Lower95PercentagePoints:
      result.statistics.top3.lower95PercentagePoints,
    coverageDeltaPercentagePoints:
      result.overall.coverageDeltaPercentagePoints,
    improvedCount: result.overall.contextualImprovedCount,
    worsenedCount: result.overall.contextualWorsenedCount,
    worstPhaseTop1DeltaPercentagePoints:
      phaseDeltas.length > 0 ? Math.min(...phaseDeltas) : 0,
    worstLargeHeroTop1DeltaPercentagePoints:
      largeHeroDeltas.length > 0
        ? Math.min(...largeHeroDeltas)
        : 0,
  });
}

function applyHeroFdr(
  groups: readonly HeroBuildOfflineEvaluationV2HeroResult[],
): HeroBuildOfflineEvaluationV2HeroResult[] {
  const adjusted = new Map<number, number>(
    adjustPValuesBenjaminiHochberg(
      groups.map((group) => ({
        key: group.heroId,
        pValue: group.mcnemar.approximateTwoSidedPValue,
      })),
    ).map((value) => [value.key, value.adjustedPValue]),
  );
  return groups
    .map((group) => ({
      ...cloneHeroResult(group),
      adjustedPValue: adjusted.get(group.heroId),
    }))
    .sort((left, right) => left.heroId - right.heroId);
}

function createChangedPredictionDiagnostic(
  sample: HeroBuildOfflineLoadedHeroSample,
  gameTimeS: number,
  stateKey: string,
  phase: HeroBuildEvaluationPhase,
  actualActionKey: string,
  configId: string,
  result: HeroBuildOfflineV2PredictionResult,
): HeroBuildOfflineEvaluationV2ChangedPredictionDiagnostic {
  const topAction = result.rerank.actions[0];
  const baselineCorrect =
    result.baseline.topActionKey === actualActionKey;
  const contextualCorrect =
    result.contextual.topActionKey === actualActionKey;
  return {
    matchId: sample.descriptor.matchId,
    matchStartTime: new Date(sample.descriptor.startTime),
    playerId: sample.player.id,
    heroId: sample.sequence.heroId,
    phase,
    gameTimeS,
    stateKey,
    enemyHeroIds: [...sample.enemyHeroIds],
    actualActionKey,
    baselineActionKeys: [...result.baseline.actionKeys],
    contextualActionKeys: [...result.contextual.actionKeys],
    baselineTopActionKey: result.baseline.topActionKey,
    contextualTopActionKey: result.contextual.topActionKey,
    baselineMode: result.baseline.mode,
    contextualMode: result.contextual.mode,
    baselineCorrect,
    contextualCorrect,
    contextualImproved:
      !baselineCorrect && contextualCorrect,
    contextualWorsened:
      baselineCorrect && !contextualCorrect,
    configId,
    topContextualLogitBonus:
      topAction?.contextualLogitBonus ?? 0,
    topRosterInteractionLogOdds:
      topAction?.rosterInteractionLogOdds ?? 0,
    topObservedEnemyCount:
      topAction?.observedEnemyCount ?? 0,
    topEligibleEnemyCount:
      topAction?.eligibleEnemyCount ?? 0,
  };
}

function getOrCreatePhaseAccumulator(
  map: Map<
    HeroBuildEvaluationPhase,
    HeroBuildOfflineV2ComparisonAccumulator
  >,
  phase: HeroBuildEvaluationPhase,
): HeroBuildOfflineV2ComparisonAccumulator {
  const existing = map.get(phase);
  if (existing) {
    return existing;
  }
  const created = new HeroBuildOfflineV2ComparisonAccumulator();
  map.set(phase, created);
  return created;
}

function addTrainingSummary(
  target: HeroBuildOfflineEvaluationV2TrainingSummary,
  policy: HeroBuildPolicyAggregationSnapshot,
  context: HeroBuildNextActionContextIndexSummary,
): void {
  target.sourcePlayerCount += policy.sourcePlayerCount;
  target.includedPlayerCount += policy.includedPlayerCount;
  target.excludedPlayerCount += policy.excludedPlayerCount;
  target.heroCount += policy.heroCount;
  target.stateCount += policy.stateCount;
  target.transitionCount += policy.transitionCount;
  target.actionOptionCount += policy.actionOptionCount;
  target.matchupHeroCount += policy.heroCount;
  target.matchupStateCount += context.scopeCount;
  target.matchupActionCount += context.actionOptionCount;
  target.matchupObservationCount += context.observationCount;
  target.contextScopeCount += context.scopeCount;
  target.contextActionOptionCount +=
    context.actionOptionCount;
  target.contextObservationCount += context.observationCount;
  target.contextEnemyObservationCount +=
    context.enemyObservationCount;
}

function createEmptyTrainingSummary(): HeroBuildOfflineEvaluationV2TrainingSummary {
  return {
    sourcePlayerCount: 0,
    includedPlayerCount: 0,
    excludedPlayerCount: 0,
    heroCount: 0,
    stateCount: 0,
    transitionCount: 0,
    actionOptionCount: 0,
    matchupHeroCount: 0,
    matchupStateCount: 0,
    matchupActionCount: 0,
    matchupObservationCount: 0,
    contextScopeCount: 0,
    contextActionOptionCount: 0,
    contextObservationCount: 0,
    contextEnemyObservationCount: 0,
  };
}

function assertFinalTestCutoff(
  split: HeroBuildOfflineEvaluationThreeWaySplit,
  finalTestNotBefore: string,
): void {
  const cutoff = new Date(finalTestNotBefore);
  const firstFinalTestMatch = split.test[0];
  if (
    !firstFinalTestMatch ||
    firstFinalTestMatch.startTime <= cutoff
  ) {
    throw new Error(
      `The untouched final-test window must start after ${cutoff.toISOString()}. ` +
        'Collect newer matches or reduce maxMatches before tuning Contextual V2.',
    );
  }
}

function createSplitReport(
  split: HeroBuildOfflineEvaluationThreeWaySplit,
  finalTestNotBefore: string,
): HeroBuildOfflineEvaluationV2SplitReport {
  return {
    strategy: 'CHRONOLOGICAL_TRAIN_VALIDATION_TEST',
    selectedMatchCount: split.selected.length,
    trainMatchCount: split.train.length,
    validationMatchCount: split.validation.length,
    finalTestMatchCount: split.test.length,
    trainFraction: split.trainFraction,
    validationFraction: split.validationFraction,
    trainStartTime: new Date(split.train[0].startTime),
    trainEndTime: new Date(
      split.train[split.train.length - 1].startTime,
    ),
    validationStartTime: new Date(
      split.validation[0].startTime,
    ),
    validationEndTime: new Date(
      split.validation[split.validation.length - 1].startTime,
    ),
    finalTestStartTime: new Date(split.test[0].startTime),
    finalTestEndTime: new Date(
      split.test[split.test.length - 1].startTime,
    ),
    finalTestNotBefore: new Date(finalTestNotBefore),
    finalTestIsNewerThanInspectedHoldout:
      split.test[0].startTime > new Date(finalTestNotBefore),
    overlappingMatchCount: 0,
  };
}

function serializeSplit(
  split: HeroBuildOfflineEvaluationThreeWaySplit,
): PersistedThreeWaySplit {
  return {
    strategy: split.strategy,
    selected: split.selected.map(serializeDescriptor),
    train: split.train.map(serializeDescriptor),
    validation: split.validation.map(serializeDescriptor),
    test: split.test.map(serializeDescriptor),
    trainFraction: split.trainFraction,
    validationFraction: split.validationFraction,
  };
}

function deserializeSplit(
  split: PersistedThreeWaySplit,
): HeroBuildOfflineEvaluationThreeWaySplit {
  return {
    strategy: split.strategy,
    selected: split.selected.map(deserializeDescriptor),
    train: split.train.map(deserializeDescriptor),
    validation: split.validation.map(deserializeDescriptor),
    test: split.test.map(deserializeDescriptor),
    trainFraction: split.trainFraction,
    validationFraction: split.validationFraction,
  };
}

function cloneThreeWaySplit(
  split: HeroBuildOfflineEvaluationThreeWaySplit,
): HeroBuildOfflineEvaluationThreeWaySplit {
  return {
    strategy: split.strategy,
    selected: split.selected.map(cloneDescriptor),
    train: split.train.map(cloneDescriptor),
    validation: split.validation.map(cloneDescriptor),
    test: split.test.map(cloneDescriptor),
    trainFraction: split.trainFraction,
    validationFraction: split.validationFraction,
  };
}

function serializeDescriptor(
  descriptor: HeroBuildOfflineEvaluationMatchDescriptor,
): PersistedMatchDescriptor {
  return {
    matchId: descriptor.matchId,
    startTime: descriptor.startTime.toISOString(),
  };
}

function deserializeDescriptor(
  descriptor: PersistedMatchDescriptor,
): HeroBuildOfflineEvaluationMatchDescriptor {
  return {
    matchId: descriptor.matchId,
    startTime: new Date(descriptor.startTime),
  };
}

function cloneDescriptor(
  descriptor: HeroBuildOfflineEvaluationMatchDescriptor,
): HeroBuildOfflineEvaluationMatchDescriptor {
  return {
    matchId: descriptor.matchId,
    startTime: new Date(descriptor.startTime),
  };
}

function cloneHeroResult(
  result: HeroBuildOfflineEvaluationV2HeroResult,
): HeroBuildOfflineEvaluationV2HeroResult {
  return {
    heroId: result.heroId,
    comparison: {
      ...result.comparison,
      baseline: { ...result.comparison.baseline },
      contextual: { ...result.comparison.contextual },
    },
    mcnemar: { ...result.mcnemar },
    adjustedPValue: result.adjustedPValue,
  };
}

function createValidationWarnings(
  selection: HeroBuildOfflineEvaluationV2SelectionArtifact,
): string[] {
  const warnings = [
    'Hyperparameters were compared only on the chronological validation window.',
    'The reserved final-test descriptors were not evaluated during validation.',
    'Accuracy measures agreement with observed player decisions, not causal proof that an item is optimal.',
  ];
  if (!selection.selectedConfig) {
    warnings.push(
      'No configuration passed validation safety criteria, so final-test execution is locked.',
    );
  }
  return warnings;
}

function reviveSelection(
  value: HeroBuildOfflineEvaluationV2SelectionArtifact,
): HeroBuildOfflineEvaluationV2SelectionArtifact {
  return {
    ...value,
    generatedAt: new Date(value.generatedAt),
    sourceWindowLastRefreshedAt:
      value.sourceWindowLastRefreshedAt
        ? new Date(value.sourceWindowLastRefreshedAt)
        : undefined,
    options: { ...value.options },
    split: reviveThreeWaySplit(value.split),
    heroIds: [...value.heroIds],
    selectedConfig: value.selectedConfig
      ? { ...value.selectedConfig }
      : undefined,
  };
}

function reviveValidationReport(
  value: HeroBuildOfflineEvaluationV2ValidationReport,
): HeroBuildOfflineEvaluationV2ValidationReport {
  return {
    ...value,
    generatedAt: new Date(value.generatedAt),
    sourceWindowLastRefreshedAt:
      value.sourceWindowLastRefreshedAt
        ? new Date(value.sourceWindowLastRefreshedAt)
        : undefined,
    split: reviveSplitReport(value.split),
    selection: reviveSelection(value.selection),
    configurations: value.configurations.map(
      reviveConfigurationReport,
    ),
  };
}

function reviveFinalReport(
  value: HeroBuildOfflineEvaluationV2FinalReport,
): HeroBuildOfflineEvaluationV2FinalReport {
  return {
    ...value,
    generatedAt: new Date(value.generatedAt),
    sourceWindowLastRefreshedAt:
      value.sourceWindowLastRefreshedAt
        ? new Date(value.sourceWindowLastRefreshedAt)
        : undefined,
    split: reviveSplitReport(value.split),
    selectedConfig: { ...value.selectedConfig },
    result: reviveConfigurationReport(value.result),
  };
}

function reviveConfigurationReport(
  value: HeroBuildOfflineEvaluationV2ConfigurationReport,
): HeroBuildOfflineEvaluationV2ConfigurationReport {
  return {
    ...value,
    config: { ...value.config },
    changedPredictions: value.changedPredictions.map(
      (diagnostic) => ({
        ...diagnostic,
        matchStartTime: new Date(
          diagnostic.matchStartTime,
        ),
        enemyHeroIds: [...diagnostic.enemyHeroIds],
        baselineActionKeys: [
          ...diagnostic.baselineActionKeys,
        ],
        contextualActionKeys: [
          ...diagnostic.contextualActionKeys,
        ],
      }),
    ),
  };
}

function reviveThreeWaySplit(
  value: HeroBuildOfflineEvaluationThreeWaySplit,
): HeroBuildOfflineEvaluationThreeWaySplit {
  return {
    ...value,
    selected: value.selected.map((descriptor) => ({
      ...descriptor,
      startTime: new Date(descriptor.startTime),
    })),
    train: value.train.map((descriptor) => ({
      ...descriptor,
      startTime: new Date(descriptor.startTime),
    })),
    validation: value.validation.map((descriptor) => ({
      ...descriptor,
      startTime: new Date(descriptor.startTime),
    })),
    test: value.test.map((descriptor) => ({
      ...descriptor,
      startTime: new Date(descriptor.startTime),
    })),
  };
}

function reviveSplitReport(
  value: HeroBuildOfflineEvaluationV2SplitReport,
): HeroBuildOfflineEvaluationV2SplitReport {
  return {
    ...value,
    trainStartTime: new Date(value.trainStartTime),
    trainEndTime: new Date(value.trainEndTime),
    validationStartTime: new Date(value.validationStartTime),
    validationEndTime: new Date(value.validationEndTime),
    finalTestStartTime: new Date(value.finalTestStartTime),
    finalTestEndTime: new Date(value.finalTestEndTime),
    finalTestNotBefore: new Date(value.finalTestNotBefore),
  };
}

function isCheckpoint(
  value: unknown,
): value is EvaluationCheckpoint {
  return (
    isRecord(value) &&
    value.schemaVersion ===
      HERO_BUILD_OFFLINE_EVALUATION_V2_CHECKPOINT_SCHEMA_VERSION &&
    value.modelVersion ===
      HERO_BUILD_OFFLINE_EVALUATION_V2_MODEL_VERSION &&
    (value.runMode === 'VALIDATION_ONLY' ||
      value.runMode === 'FINAL_TEST') &&
    Array.isArray(value.heroIds) &&
    Array.isArray(value.aggregates)
  );
}

function isRecord(
  value: unknown,
): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value)
  );
}

function parseOptionalDate(
  value: string | undefined,
): Date | undefined {
  if (!value) {
    return undefined;
  }
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : undefined;
}

function cloneDate(value: Date | undefined): Date | undefined {
  return value ? new Date(value) : undefined;
}

function bytesToMegabytes(bytes: number): number {
  return bytes / BYTES_PER_MEGABYTE;
}

function readBooleanEnvironmentValue(
  name: string,
  defaultValue: boolean,
): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (raw === 'true' || raw === '1' || raw === 'yes') {
    return true;
  }
  if (raw === 'false' || raw === '0' || raw === 'no') {
    return false;
  }
  return defaultValue;
}

function readBoundedIntegerEnvironmentValue(
  name: string,
  defaultValue: number,
  minimum: number,
  maximum: number,
): number {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= maximum
    ? value
    : defaultValue;
}

function getErrorCode(error: unknown): string | undefined {
  if (!isRecord(error)) {
    return undefined;
  }
  return typeof error.code === 'string'
    ? error.code
    : undefined;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
