import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { In, Repository } from 'typeorm';
import {
  CanonicalBuildSequenceService,
  CanonicalPlayerBuildSequence,
} from './canonical-build-sequence.service';
import { MatchPlayerItem } from './entities/match-player-item.entity';
import { MatchPlayer } from './entities/match-player.entity';
import { Match } from './entities/match.entity';
import {
  HeroBuildOfflineEvaluationModel,
  HeroBuildOfflineMatchupIndex,
  HeroBuildOfflineModelPrediction,
  HERO_BUILD_OFFLINE_EVALUATION_GAME_TIME_BUCKET_S,
  HERO_BUILD_OFFLINE_EVALUATION_MODEL_VERSION,
  normalizeObservedActionKey,
} from './hero-build-offline-evaluation.model';
import {
  HERO_BUILD_OFFLINE_EVALUATION_DEFAULT_BATCH_SIZE,
  HERO_BUILD_OFFLINE_EVALUATION_DEFAULT_MAX_RSS_MB,
  HERO_BUILD_OFFLINE_EVALUATION_LOW_MEMORY_MODE,
  HERO_BUILD_OFFLINE_EVALUATION_MAX_BATCH_SIZE,
  HERO_BUILD_OFFLINE_EVALUATION_MAX_MAX_RSS_MB,
  HERO_BUILD_OFFLINE_EVALUATION_MIN_BATCH_SIZE,
  HERO_BUILD_OFFLINE_EVALUATION_MIN_MAX_RSS_MB,
  HeroBuildOfflineEvaluationLowMemoryReport,
  HeroBuildOfflineEvaluationLowMemoryStatus,
  chunkValues,
} from './hero-build-offline-evaluation-low-memory.service';
import {
  HeroBuildEvaluationOutcome,
  HeroBuildEvaluationPhase,
  HeroBuildOfflineEvaluationComparison,
  HeroBuildOfflineEvaluationErrorExample,
  HeroBuildOfflineEvaluationHeroGroup,
  HeroBuildOfflineEvaluationHeroPhaseGroup,
  HeroBuildOfflineEvaluationMatchDescriptor,
  HeroBuildOfflineEvaluationMatchSplit,
  HeroBuildOfflineEvaluationMetrics,
  HeroBuildOfflineEvaluationOptions,
  HeroBuildOfflineEvaluationOutcomeGroup,
  HeroBuildOfflineEvaluationPhaseGroup,
  HeroBuildOfflineEvaluationStartRequest,
  HeroBuildOfflineEvaluationTrainingSummary,
  getHeroBuildEvaluationPhase,
  normalizeHeroBuildOfflineEvaluationOptions,
  splitHeroBuildEvaluationMatches,
} from './hero-build-offline-evaluation.service';
import {
  HeroBuildPolicyAggregationSnapshot,
  HeroBuildTransitionAccumulator,
} from './hero-build-transition-aggregation.service';
import { InventoryTimelineReplayService } from './inventory-timeline-replay.service';
import { MatchTimelineNormalizationService } from './match-timeline-normalization.service';
import {
  RecentMatchItemSnapshot,
  RecentMatchPlayerSnapshot,
} from './recent-matches-window.service';
import { RecipeAwareTimelineReconciliationService } from './recipe-aware-timeline-reconciliation.service';

export const HERO_BUILD_OFFLINE_EVALUATION_PERSISTENCE_MODE =
  'CHECKPOINT_PER_HERO' as const;
export const HERO_BUILD_OFFLINE_EVALUATION_CHECKPOINT_SCHEMA_VERSION = 1;

const BYTES_PER_MEGABYTE = 1024 * 1024;
const DEFAULT_STORAGE_DIRECTORY = '/app/apps/api/storage/build-evaluation';
const DEFAULT_DATABASE_RETRY_COUNT = 5;
const DEFAULT_DATABASE_RETRY_DELAY_MS = 500;
const CHECKPOINT_FILE_NAME = 'checkpoint.json';
const REPORT_FILE_NAME = 'report.json';
const BATCH_SIZE_ENV = 'DEADLOCK_BUILD_EVALUATION_BATCH_SIZE';
const MAX_RSS_MB_ENV = 'DEADLOCK_BUILD_EVALUATION_MAX_RSS_MB';
const STORAGE_DIRECTORY_ENV = 'DEADLOCK_BUILD_EVALUATION_STORAGE_DIR';
const AUTO_RESUME_ENV = 'DEADLOCK_BUILD_EVALUATION_AUTO_RESUME';
const DATABASE_RETRY_COUNT_ENV = 'DEADLOCK_BUILD_EVALUATION_DB_RETRY_COUNT';
const DATABASE_RETRY_DELAY_MS_ENV = 'DEADLOCK_BUILD_EVALUATION_DB_RETRY_DELAY_MS';

export interface HeroBuildOfflineEvaluationResilientStatus
  extends HeroBuildOfflineEvaluationLowMemoryStatus {
  persistenceMode: typeof HERO_BUILD_OFFLINE_EVALUATION_PERSISTENCE_MODE;
  storageDirectory: string;
  autoResume: boolean;
  resumedFromCheckpoint: boolean;
  checkpointAvailable: boolean;
  databaseRetryCount: number;
  databaseRetryDelayMs: number;
}

interface LoadedMatchDescriptors {
  descriptors: HeroBuildOfflineEvaluationMatchDescriptor[];
  sourceLastRefreshedAt?: Date;
}

interface LoadedHeroSample {
  descriptor: HeroBuildOfflineEvaluationMatchDescriptor;
  player: RecentMatchPlayerSnapshot;
  sequence: CanonicalPlayerBuildSequence;
  enemyHeroIds: number[];
}

interface LoadedHeroBatch {
  sourcePlayerCount: number;
  samples: LoadedHeroSample[];
}

interface MutableTrainingSummary extends HeroBuildOfflineEvaluationTrainingSummary {}

interface EvaluationAggregateState {
  training: MutableTrainingSummary;
  overall: ComparisonAccumulator;
  byHero: HeroBuildOfflineEvaluationHeroGroup[];
  byPhase: Map<HeroBuildEvaluationPhase, ComparisonAccumulator>;
  byHeroPhase: HeroBuildOfflineEvaluationHeroPhaseGroup[];
  byOutcome: Map<HeroBuildEvaluationOutcome, ComparisonAccumulator>;
  errorExamples: HeroBuildOfflineEvaluationErrorExample[];
  sourceTestPlayerCount: number;
  evaluatedPlayerCount: number;
  excludedTestPlayerCount: number;
  evaluatedStepCount: number;
}

interface PersistedMatchDescriptor {
  matchId: number;
  startTime: string;
}

interface PersistedErrorExample
  extends Omit<HeroBuildOfflineEvaluationErrorExample, 'matchStartTime'> {
  matchStartTime: string;
}

interface EvaluationCheckpoint {
  schemaVersion: typeof HERO_BUILD_OFFLINE_EVALUATION_CHECKPOINT_SCHEMA_VERSION;
  modelVersion: typeof HERO_BUILD_OFFLINE_EVALUATION_MODEL_VERSION;
  savedAt: string;
  startedAt: string;
  options: HeroBuildOfflineEvaluationOptions;
  sourceWindowLastRefreshedAt?: string;
  split: {
    selected: PersistedMatchDescriptor[];
    train: PersistedMatchDescriptor[];
    test: PersistedMatchDescriptor[];
  };
  heroIds: number[];
  nextHeroIndex: number;
  training: HeroBuildOfflineEvaluationTrainingSummary;
  sourceTestPlayerCount: number;
  evaluatedPlayerCount: number;
  excludedTestPlayerCount: number;
  evaluatedStepCount: number;
  overall: HeroBuildOfflineEvaluationComparison;
  byHero: HeroBuildOfflineEvaluationHeroGroup[];
  byPhase: HeroBuildOfflineEvaluationPhaseGroup[];
  byHeroPhase: HeroBuildOfflineEvaluationHeroPhaseGroup[];
  byOutcome: HeroBuildOfflineEvaluationOutcomeGroup[];
  errorExamples: PersistedErrorExample[];
  peakRssMb: number;
}

@Injectable()
export class HeroBuildOfflineEvaluationResilientService implements OnModuleInit {
  private readonly logger = new Logger(
    HeroBuildOfflineEvaluationResilientService.name,
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
  private readonly storageDirectory =
    process.env[STORAGE_DIRECTORY_ENV]?.trim() || DEFAULT_STORAGE_DIRECTORY;
  private readonly autoResume = readBooleanEnvironmentValue(AUTO_RESUME_ENV, true);
  private readonly databaseRetryCount = readBoundedIntegerEnvironmentValue(
    DATABASE_RETRY_COUNT_ENV,
    DEFAULT_DATABASE_RETRY_COUNT,
    0,
    20,
  );
  private readonly databaseRetryDelayMs = readBoundedIntegerEnvironmentValue(
    DATABASE_RETRY_DELAY_MS_ENV,
    DEFAULT_DATABASE_RETRY_DELAY_MS,
    50,
    10_000,
  );
  private readonly checkpointPath = join(
    this.storageDirectory,
    CHECKPOINT_FILE_NAME,
  );
  private readonly reportPath = join(this.storageDirectory, REPORT_FILE_NAME);
  private runPromise?: Promise<HeroBuildOfflineEvaluationLowMemoryReport>;
  private report?: HeroBuildOfflineEvaluationLowMemoryReport;
  private peakRssBytes = 0;
  private status: HeroBuildOfflineEvaluationResilientStatus;

  constructor(
    @InjectRepository(Match)
    private readonly matchRepository: Repository<Match>,
    @InjectRepository(MatchPlayer)
    private readonly matchPlayerRepository: Repository<MatchPlayer>,
    @InjectRepository(MatchPlayerItem)
    private readonly matchPlayerItemRepository: Repository<MatchPlayerItem>,
    private readonly matchTimelineNormalizationService: MatchTimelineNormalizationService,
    private readonly inventoryTimelineReplayService: InventoryTimelineReplayService,
    private readonly canonicalBuildSequenceService: CanonicalBuildSequenceService,
    private readonly recipeAwareTimelineReconciliationService:
      RecipeAwareTimelineReconciliationService,
  ) {
    this.status = this.createIdleStatus();
  }

  async onModuleInit(): Promise<void> {
    await mkdir(this.storageDirectory, { recursive: true });

    const report = await this.readPersistedReport();
    if (report) {
      this.restoreCompletedReport(report);
      return;
    }

    if (!this.autoResume) {
      return;
    }

    const checkpoint = await this.readCheckpoint();
    if (!checkpoint) {
      return;
    }

    this.peakRssBytes = Math.max(
      this.peakRssBytes,
      checkpoint.peakRssMb * BYTES_PER_MEGABYTE,
    );
    this.status = {
      ...this.createIdleStatus(),
      state: 'RUNNING',
      phase: 'PREPARING',
      options: { ...checkpoint.options },
      startedAt: new Date(checkpoint.startedAt),
      totalMatchCount: checkpoint.split.selected.length,
      trainMatchCount: checkpoint.split.train.length,
      testMatchCount: checkpoint.split.test.length,
      evaluatedStepCount: checkpoint.evaluatedStepCount,
      totalHeroCount: checkpoint.heroIds.length,
      processedHeroCount: checkpoint.nextHeroIndex,
      resumedFromCheckpoint: true,
      checkpointAvailable: true,
      ...this.getMemoryStatus(),
    };
    this.logger.warn(
      `Resuming offline evaluation from hero ${checkpoint.nextHeroIndex + 1} of ` +
        `${checkpoint.heroIds.length}.`,
    );
    this.launchRun(checkpoint.options, checkpoint, false);
  }

  start(
    request: HeroBuildOfflineEvaluationStartRequest = {},
  ): HeroBuildOfflineEvaluationResilientStatus {
    if (this.runPromise) {
      return this.getStatus();
    }

    const options = normalizeHeroBuildOfflineEvaluationOptions(request);
    this.report = undefined;
    this.peakRssBytes = 0;
    this.status = {
      ...this.createIdleStatus(),
      state: 'RUNNING',
      phase: 'PREPARING',
      options,
      startedAt: new Date(),
    };
    this.sampleMemoryUsage();
    this.launchRun(options, undefined, true);
    return this.getStatus();
  }

  getStatus(): HeroBuildOfflineEvaluationResilientStatus {
    return {
      ...this.status,
      options: this.status.options ? { ...this.status.options } : undefined,
      startedAt: cloneDate(this.status.startedAt),
      completedAt: cloneDate(this.status.completedAt),
      ...this.getMemoryStatus(),
    };
  }

  getReport(): HeroBuildOfflineEvaluationLowMemoryReport | undefined {
    return this.report;
  }

  private launchRun(
    options: HeroBuildOfflineEvaluationOptions,
    checkpoint: EvaluationCheckpoint | undefined,
    clearPersistentState: boolean,
  ): void {
    this.runPromise = this.run(options, checkpoint, clearPersistentState)
      .then(async (report) => {
        await this.writeJsonAtomically(this.reportPath, report);
        await rm(this.checkpointPath, { force: true });
        this.report = report;
        this.status = {
          ...this.status,
          state: 'COMPLETE',
          phase: 'COMPLETE',
          completedAt: new Date(),
          currentHeroId: undefined,
          processedTrainMatchCount: this.status.trainMatchCount,
          processedTestMatchCount: this.status.testMatchCount,
          reportAvailable: true,
          checkpointAvailable: false,
          error: undefined,
          ...this.getMemoryStatus(),
        };
        return report;
      })
      .catch((error: unknown) => {
        const message = getErrorMessage(error);
        this.status = {
          ...this.status,
          state: 'FAILED',
          completedAt: new Date(),
          currentHeroId: undefined,
          reportAvailable: false,
          error: message,
          ...this.getMemoryStatus(),
        };
        this.logger.error(`Resilient offline build evaluation failed: ${message}`);
        throw error;
      })
      .finally(() => {
        this.runPromise = undefined;
      });
    void this.runPromise.catch(() => undefined);
  }

  private async run(
    options: HeroBuildOfflineEvaluationOptions,
    checkpoint: EvaluationCheckpoint | undefined,
    clearPersistentState: boolean,
  ): Promise<HeroBuildOfflineEvaluationLowMemoryReport> {
    await mkdir(this.storageDirectory, { recursive: true });
    if (clearPersistentState) {
      await Promise.all([
        rm(this.checkpointPath, { force: true }),
        rm(this.reportPath, { force: true }),
      ]);
    }

    try {
      await this.withDatabaseRetry('refreshing timeline recipes', () =>
        this.recipeAwareTimelineReconciliationService.refreshRecipes(),
      );
    } catch (error) {
      this.logger.warn(
        `Using the existing recipe cache for offline evaluation: ${getErrorMessage(error)}`,
      );
    }

    let split: HeroBuildOfflineEvaluationMatchSplit;
    let heroIds: number[];
    let sourceWindowLastRefreshedAt: Date | undefined;
    let nextHeroIndex: number;
    let aggregate: EvaluationAggregateState;

    if (checkpoint) {
      split = deserializeSplit(checkpoint.split);
      heroIds = [...checkpoint.heroIds];
      sourceWindowLastRefreshedAt = parseOptionalDate(
        checkpoint.sourceWindowLastRefreshedAt,
      );
      nextHeroIndex = checkpoint.nextHeroIndex;
      aggregate = restoreAggregateState(checkpoint);
    } else {
      const loadedDescriptors = await this.loadMatchDescriptors(options.maxMatches);
      split = splitHeroBuildEvaluationMatches(
        loadedDescriptors.descriptors,
        options.trainFraction,
        options.maxMatches,
      );
      if (split.train.length === 0 || split.test.length === 0) {
        throw new Error(
          'Offline evaluation requires at least two historical matches.',
        );
      }

      sourceWindowLastRefreshedAt = loadedDescriptors.sourceLastRefreshedAt;
      this.status = {
        ...this.status,
        totalMatchCount: split.selected.length,
        trainMatchCount: split.train.length,
        testMatchCount: split.test.length,
        ...this.getMemoryStatus(),
      };
      this.assertMemoryBudget('loading match descriptors');

      heroIds = await this.collectHeroIds(split.selected);
      if (heroIds.length === 0) {
        throw new Error('No valid hero players were found in the selected matches.');
      }
      nextHeroIndex = 0;
      aggregate = createEmptyAggregateState();
      this.status = {
        ...this.status,
        totalHeroCount: heroIds.length,
        ...this.getMemoryStatus(),
      };
      await this.persistCheckpoint({
        options,
        sourceWindowLastRefreshedAt,
        split,
        heroIds,
        nextHeroIndex,
        aggregate,
      });
    }

    this.status = {
      ...this.status,
      totalMatchCount: split.selected.length,
      trainMatchCount: split.train.length,
      testMatchCount: split.test.length,
      totalHeroCount: heroIds.length,
      processedHeroCount: nextHeroIndex,
      evaluatedStepCount: aggregate.evaluatedStepCount,
      ...this.getMemoryStatus(),
    };

    for (let heroIndex = nextHeroIndex; heroIndex < heroIds.length; heroIndex += 1) {
      const heroId = heroIds[heroIndex];
      this.status = {
        ...this.status,
        phase: 'TRAINING',
        currentHeroId: heroId,
        processedTrainMatchCount: 0,
        processedTestMatchCount: 0,
        ...this.getMemoryStatus(),
      };

      const transitionAccumulator = new HeroBuildTransitionAccumulator();
      const matchupIndex = new HeroBuildOfflineMatchupIndex();

      for (const [batchIndex, descriptors] of chunkValues(
        split.train,
        this.batchSize,
      ).entries()) {
        const loaded = await this.loadHeroBatch(
          heroId,
          descriptors,
          `training hero ${heroId}, batch ${batchIndex + 1}`,
        );
        for (const sample of loaded.samples) {
          transitionAccumulator.addPlayer(sample.sequence);
          matchupIndex.addSequence(
            sample.sequence,
            sample.player.won,
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
        this.assertMemoryBudget(`training hero ${heroId}`);
        await yieldToEventLoop();
      }

      const policySnapshot = transitionAccumulator.build();
      addTrainingSummary(aggregate.training, policySnapshot, matchupIndex);
      const heroAccumulator = new ComparisonAccumulator();
      const heroPhaseAccumulators = new Map<
        HeroBuildEvaluationPhase,
        ComparisonAccumulator
      >();

      this.status = {
        ...this.status,
        phase: 'EVALUATING',
        ...this.getMemoryStatus(),
      };

      for (const [batchIndex, descriptors] of chunkValues(
        split.test,
        this.batchSize,
      ).entries()) {
        const loaded = await this.loadHeroBatch(
          heroId,
          descriptors,
          `evaluating hero ${heroId}, batch ${batchIndex + 1}`,
        );
        aggregate.sourceTestPlayerCount += loaded.sourcePlayerCount;
        const model = new HeroBuildOfflineEvaluationModel(
          policySnapshot.policiesByHeroId,
          matchupIndex,
          (parentItemId) =>
            this.recipeAwareTimelineReconciliationService.getComponentItemIds(
              parentItemId,
            ),
        );

        for (const sample of loaded.samples) {
          if (!isEvaluableSequence(sample.sequence)) {
            aggregate.excludedTestPlayerCount += 1;
            continue;
          }

          aggregate.evaluatedPlayerCount += 1;
          for (const step of sample.sequence.steps) {
            const predictions = model.predict({
              heroId: sample.sequence.heroId,
              stateKey: step.beforeStateKey,
              gameTimeS: step.gameTimeS,
              enemyHeroIds: sample.enemyHeroIds,
            });
            const actualActionKey = normalizeObservedActionKey(
              step.actionType,
              step.itemId,
            );
            const phase = getHeroBuildEvaluationPhase(step.gameTimeS);
            const outcome: HeroBuildEvaluationOutcome = sample.player.won
              ? 'WIN'
              : 'LOSS';

            aggregate.overall.add(
              predictions.baseline,
              predictions.contextual,
              actualActionKey,
            );
            heroAccumulator.add(
              predictions.baseline,
              predictions.contextual,
              actualActionKey,
            );
            getOrCreate(aggregate.byPhase, phase).add(
              predictions.baseline,
              predictions.contextual,
              actualActionKey,
            );
            getOrCreate(heroPhaseAccumulators, phase).add(
              predictions.baseline,
              predictions.contextual,
              actualActionKey,
            );
            getOrCreate(aggregate.byOutcome, outcome).add(
              predictions.baseline,
              predictions.contextual,
              actualActionKey,
            );

            if (
              aggregate.errorExamples.length < options.errorExampleLimit &&
              (predictions.baseline.topActionKey !== actualActionKey ||
                predictions.contextual.topActionKey !== actualActionKey)
            ) {
              aggregate.errorExamples.push(
                createErrorExample(
                  sample,
                  step.gameTimeS,
                  step.beforeStateKey,
                  phase,
                  actualActionKey,
                  predictions.baseline,
                  predictions.contextual,
                ),
              );
            }

            aggregate.evaluatedStepCount += 1;
          }
        }

        this.status = {
          ...this.status,
          processedTestMatchCount: Math.min(
            split.test.length,
            (batchIndex + 1) * this.batchSize,
          ),
          evaluatedStepCount: aggregate.evaluatedStepCount,
          ...this.getMemoryStatus(),
        };
        this.assertMemoryBudget(`evaluating hero ${heroId}`);
        await yieldToEventLoop();
      }

      aggregate.byHero.push({
        heroId,
        comparison: heroAccumulator.build(),
      });
      for (const [phase, accumulator] of heroPhaseAccumulators) {
        aggregate.byHeroPhase.push({
          heroId,
          phase,
          comparison: accumulator.build(),
        });
      }

      nextHeroIndex = heroIndex + 1;
      this.status = {
        ...this.status,
        processedHeroCount: nextHeroIndex,
        ...this.getMemoryStatus(),
      };
      this.assertMemoryBudget(`finishing hero ${heroId}`);
      await this.persistCheckpoint({
        options,
        sourceWindowLastRefreshedAt,
        split,
        heroIds,
        nextHeroIndex,
        aggregate,
      });
      await yieldToEventLoop();
    }

    const report = createLowMemoryReport({
      options,
      sourceWindowLastRefreshedAt,
      split,
      training: aggregate.training,
      sourceTestPlayerCount: aggregate.sourceTestPlayerCount,
      evaluatedPlayerCount: aggregate.evaluatedPlayerCount,
      excludedTestPlayerCount: aggregate.excludedTestPlayerCount,
      evaluatedStepCount: aggregate.evaluatedStepCount,
      overall: aggregate.overall,
      byHero: aggregate.byHero,
      byPhase: aggregate.byPhase,
      byHeroPhase: aggregate.byHeroPhase,
      byOutcome: aggregate.byOutcome,
      errorExamples: aggregate.errorExamples,
      batchSize: this.batchSize,
      maxRssMb: this.maxRssMb,
      totalHeroCount: heroIds.length,
      peakRssMb: bytesToMegabytes(this.peakRssBytes),
    });

    this.logger.log(
      `Resilient evaluation processed ${report.test.evaluatedStepCount} held-out ` +
        `steps across ${report.execution.totalHeroCount} heroes with peak RSS ` +
        `${report.execution.peakRssMb.toFixed(2)} MB: baseline top-1 ` +
        `${report.overall.baseline.top1AccuracyPercent.toFixed(2)}%, contextual ` +
        `${report.overall.contextual.top1AccuracyPercent.toFixed(2)}%.`,
    );

    return report;
  }

  private async loadMatchDescriptors(
    maxMatches: number,
  ): Promise<LoadedMatchDescriptors> {
    const matches = await this.withDatabaseRetry('loading match descriptors', () =>
      this.matchRepository.find({
        order: { startTime: 'DESC', matchId: 'DESC' },
        take: maxMatches,
      }),
    );
    const descriptors = matches
      .map((match) => ({
        matchId: Number(match.matchId),
        startTime: new Date(match.startTime),
      }))
      .filter(
        (descriptor) =>
          Number.isSafeInteger(descriptor.matchId) &&
          descriptor.matchId > 0 &&
          Number.isFinite(descriptor.startTime.getTime()),
      );
    const refreshedTimes = matches
      .map((match) => match.crawledAt?.getTime())
      .filter((value): value is number => Number.isFinite(value));

    this.sampleMemoryUsage();
    return {
      descriptors,
      sourceLastRefreshedAt:
        refreshedTimes.length > 0
          ? new Date(Math.max(...refreshedTimes))
          : undefined,
    };
  }

  private async collectHeroIds(
    descriptors: readonly HeroBuildOfflineEvaluationMatchDescriptor[],
  ): Promise<number[]> {
    const heroIds = new Set<number>();
    const batches = chunkValues(descriptors, this.batchSize);

    for (const [index, batch] of batches.entries()) {
      const players = await this.withDatabaseRetry(
        `collecting hero ids, batch ${index + 1}`,
        () =>
          this.matchPlayerRepository.find({
            where: {
              matchId: In(batch.map((descriptor) => descriptor.matchId)),
            },
          }),
      );
      for (const player of players) {
        const heroId = Number(player.heroId);
        if (Number.isSafeInteger(heroId) && heroId > 0) {
          heroIds.add(heroId);
        }
      }

      this.assertMemoryBudget('collecting hero ids');
      await yieldToEventLoop();
    }

    return [...heroIds].sort((left, right) => left - right);
  }

  private async loadHeroBatch(
    heroId: number,
    descriptors: readonly HeroBuildOfflineEvaluationMatchDescriptor[],
    context: string,
  ): Promise<LoadedHeroBatch> {
    if (descriptors.length === 0) {
      return { sourcePlayerCount: 0, samples: [] };
    }

    const descriptorByMatchId = new Map(
      descriptors.map((descriptor) => [descriptor.matchId, descriptor]),
    );
    const matchIds = descriptors.map((descriptor) => descriptor.matchId);
    const requestedPlayers = await this.withDatabaseRetry(
      `${context}: loading requested players`,
      () =>
        this.matchPlayerRepository.find({
          where: { matchId: In(matchIds), heroId },
        }),
    );
    if (requestedPlayers.length === 0) {
      this.sampleMemoryUsage();
      return { sourcePlayerCount: 0, samples: [] };
    }

    const relevantMatchIds = [
      ...new Set(requestedPlayers.map((player) => Number(player.matchId))),
    ];
    const roster = await this.withDatabaseRetry(`${context}: loading rosters`, () =>
      this.matchPlayerRepository.find({
        where: { matchId: In(relevantMatchIds) },
      }),
    );
    const rosterByMatchId = groupBy(roster, (player) => Number(player.matchId));
    const itemRows: MatchPlayerItem[] = [];
    for (const [itemBatchIndex, playerIdBatch] of chunkValues(
      requestedPlayers.map((player) => Number(player.id)),
      this.batchSize * 4,
    ).entries()) {
      itemRows.push(
        ...(await this.withDatabaseRetry(
          `${context}: loading item rows, batch ${itemBatchIndex + 1}`,
          () =>
            this.matchPlayerItemRepository.find({
              where: { matchPlayerId: In(playerIdBatch) },
            }),
        )),
      );
    }
    const itemsByPlayerId = groupBy(
      itemRows,
      (item) => Number(item.matchPlayerId),
    );

    const samples: LoadedHeroSample[] = [];
    for (const player of requestedPlayers) {
      const matchId = Number(player.matchId);
      const descriptor = descriptorByMatchId.get(matchId);
      if (!descriptor) {
        continue;
      }

      const snapshot = toRecentMatchPlayerSnapshot(
        player,
        itemsByPlayerId.get(Number(player.id)) ?? [],
      );
      const sequence = this.preparePlayer(snapshot);
      const enemyHeroIds = normalizeHeroIds(
        (rosterByMatchId.get(matchId) ?? [])
          .filter((candidate) => Number(candidate.team) !== snapshot.team)
          .map((candidate) => Number(candidate.heroId)),
      );
      samples.push({ descriptor, player: snapshot, sequence, enemyHeroIds });
    }

    this.sampleMemoryUsage();
    return { sourcePlayerCount: requestedPlayers.length, samples };
  }

  private preparePlayer(
    player: RecentMatchPlayerSnapshot,
  ): CanonicalPlayerBuildSequence {
    const timeline = this.matchTimelineNormalizationService.normalizePlayer(player);
    const replay = this.inventoryTimelineReplayService.replayPlayer(timeline);
    return this.canonicalBuildSequenceService.canonicalizePlayer(replay);
  }

  private async withDatabaseRetry<T>(
    context: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        if (
          attempt >= this.databaseRetryCount ||
          !isTransientDatabaseError(error)
        ) {
          throw error;
        }

        const delayMs = Math.min(
          this.databaseRetryDelayMs * 2 ** attempt,
          10_000,
        );
        this.logger.warn(
          `Transient PostgreSQL failure while ${context}; retry ` +
            `${attempt + 1}/${this.databaseRetryCount} in ${delayMs} ms: ` +
            getErrorMessage(error),
        );
        await delay(delayMs);
      }
    }
  }

  private async persistCheckpoint(input: {
    options: HeroBuildOfflineEvaluationOptions;
    sourceWindowLastRefreshedAt?: Date;
    split: HeroBuildOfflineEvaluationMatchSplit;
    heroIds: number[];
    nextHeroIndex: number;
    aggregate: EvaluationAggregateState;
  }): Promise<void> {
    const checkpoint: EvaluationCheckpoint = {
      schemaVersion: HERO_BUILD_OFFLINE_EVALUATION_CHECKPOINT_SCHEMA_VERSION,
      modelVersion: HERO_BUILD_OFFLINE_EVALUATION_MODEL_VERSION,
      savedAt: new Date().toISOString(),
      startedAt: (this.status.startedAt ?? new Date()).toISOString(),
      options: { ...input.options },
      sourceWindowLastRefreshedAt:
        input.sourceWindowLastRefreshedAt?.toISOString(),
      split: serializeSplit(input.split),
      heroIds: [...input.heroIds],
      nextHeroIndex: input.nextHeroIndex,
      training: { ...input.aggregate.training },
      sourceTestPlayerCount: input.aggregate.sourceTestPlayerCount,
      evaluatedPlayerCount: input.aggregate.evaluatedPlayerCount,
      excludedTestPlayerCount: input.aggregate.excludedTestPlayerCount,
      evaluatedStepCount: input.aggregate.evaluatedStepCount,
      overall: input.aggregate.overall.build(),
      byHero: input.aggregate.byHero.map(cloneHeroGroup),
      byPhase: buildPhaseGroups(input.aggregate.byPhase),
      byHeroPhase: input.aggregate.byHeroPhase.map(cloneHeroPhaseGroup),
      byOutcome: buildOutcomeGroups(input.aggregate.byOutcome),
      errorExamples: input.aggregate.errorExamples.map(serializeErrorExample),
      peakRssMb: bytesToMegabytes(this.peakRssBytes),
    };

    await this.writeJsonAtomically(this.checkpointPath, checkpoint);
    this.status = {
      ...this.status,
      checkpointAvailable: true,
    };
  }

  private async readCheckpoint(): Promise<EvaluationCheckpoint | undefined> {
    const raw = await this.readJsonFile(this.checkpointPath);
    if (!isEvaluationCheckpoint(raw)) {
      if (raw !== undefined) {
        this.logger.error(
          `Ignoring incompatible evaluation checkpoint at ${this.checkpointPath}.`,
        );
      }
      return undefined;
    }
    return raw;
  }

  private async readPersistedReport(): Promise<
    HeroBuildOfflineEvaluationLowMemoryReport | undefined
  > {
    const raw = await this.readJsonFile(this.reportPath);
    return deserializeReport(raw);
  }

  private async readJsonFile(path: string): Promise<unknown | undefined> {
    try {
      return JSON.parse(await readFile(path, 'utf8')) as unknown;
    } catch (error) {
      if (getErrorCode(error) === 'ENOENT') {
        return undefined;
      }
      this.logger.error(`Failed to read ${path}: ${getErrorMessage(error)}`);
      return undefined;
    }
  }

  private async writeJsonAtomically(path: string, value: unknown): Promise<void> {
    const temporaryPath = `${path}.${process.pid}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(value), 'utf8');
    await rename(temporaryPath, path);
  }

  private restoreCompletedReport(
    report: HeroBuildOfflineEvaluationLowMemoryReport,
  ): void {
    this.report = report;
    this.peakRssBytes = Math.max(
      this.peakRssBytes,
      report.execution.peakRssMb * BYTES_PER_MEGABYTE,
    );
    this.status = {
      ...this.createIdleStatus(),
      state: 'COMPLETE',
      phase: 'COMPLETE',
      options: { ...report.options },
      startedAt: new Date(report.generatedAt),
      completedAt: new Date(report.generatedAt),
      totalMatchCount: report.split.selectedMatchCount,
      trainMatchCount: report.split.trainMatchCount,
      testMatchCount: report.split.testMatchCount,
      processedTrainMatchCount: report.split.trainMatchCount,
      processedTestMatchCount: report.split.testMatchCount,
      evaluatedStepCount: report.test.evaluatedStepCount,
      reportAvailable: true,
      totalHeroCount: report.execution.totalHeroCount,
      processedHeroCount: report.execution.totalHeroCount,
      checkpointAvailable: false,
      ...this.getMemoryStatus(),
    };
    this.logger.log(`Restored completed evaluation report from ${this.reportPath}.`);
  }

  private assertMemoryBudget(context: string): void {
    const usage = this.sampleMemoryUsage();
    if (usage.rss <= this.maxRssMb * BYTES_PER_MEGABYTE) {
      return;
    }

    throw new Error(
      `Offline evaluation exceeded the ${this.maxRssMb} MB RSS safety limit while ` +
        `${context}. Current RSS is ${bytesToMegabytes(usage.rss).toFixed(2)} MB. ` +
        `Lower ${BATCH_SIZE_ENV} or raise ${MAX_RSS_MB_ENV} only when the server has ` +
        `enough free memory.`,
    );
  }

  private sampleMemoryUsage(): NodeJS.MemoryUsage {
    const usage = process.memoryUsage();
    this.peakRssBytes = Math.max(this.peakRssBytes, usage.rss);
    return usage;
  }

  private getMemoryStatus(): Pick<
    HeroBuildOfflineEvaluationResilientStatus,
    'currentRssMb' | 'peakRssMb'
  > {
    const usage = this.sampleMemoryUsage();
    return {
      currentRssMb: round(bytesToMegabytes(usage.rss)),
      peakRssMb: round(bytesToMegabytes(this.peakRssBytes)),
    };
  }

  private createIdleStatus(): HeroBuildOfflineEvaluationResilientStatus {
    return {
      state: 'IDLE',
      totalMatchCount: 0,
      trainMatchCount: 0,
      testMatchCount: 0,
      processedTrainMatchCount: 0,
      processedTestMatchCount: 0,
      evaluatedStepCount: 0,
      reportAvailable: false,
      memoryMode: HERO_BUILD_OFFLINE_EVALUATION_LOW_MEMORY_MODE,
      batchSize: this.batchSize,
      maxRssMb: this.maxRssMb,
      totalHeroCount: 0,
      processedHeroCount: 0,
      currentRssMb: round(bytesToMegabytes(process.memoryUsage().rss)),
      peakRssMb: 0,
      persistenceMode: HERO_BUILD_OFFLINE_EVALUATION_PERSISTENCE_MODE,
      storageDirectory: this.storageDirectory,
      autoResume: this.autoResume,
      resumedFromCheckpoint: false,
      checkpointAvailable: false,
      databaseRetryCount: this.databaseRetryCount,
      databaseRetryDelayMs: this.databaseRetryDelayMs,
    };
  }
}

class PredictionMetricsAccumulator {
  private sampleCount = 0;
  private coveredCount = 0;
  private top1Count = 0;
  private top3Count = 0;
  private exactModeCount = 0;
  private backoffModeCount = 0;
  private noMatchCount = 0;

  constructor(metrics?: HeroBuildOfflineEvaluationMetrics) {
    if (!metrics) {
      return;
    }
    this.sampleCount = metrics.sampleCount;
    this.coveredCount = metrics.coveredCount;
    this.top1Count = metrics.top1Count;
    this.top3Count = metrics.top3Count;
    this.exactModeCount = metrics.exactModeCount;
    this.backoffModeCount = metrics.backoffModeCount;
    this.noMatchCount = metrics.noMatchCount;
  }

  add(prediction: HeroBuildOfflineModelPrediction, actualActionKey: string): void {
    this.sampleCount += 1;
    if (prediction.covered) {
      this.coveredCount += 1;
    }
    if (prediction.topActionKey === actualActionKey) {
      this.top1Count += 1;
    }
    if (prediction.actionKeys.slice(0, 3).includes(actualActionKey)) {
      this.top3Count += 1;
    }

    if (prediction.mode === 'EXACT') {
      this.exactModeCount += 1;
    } else if (prediction.mode === 'BACKOFF') {
      this.backoffModeCount += 1;
    } else {
      this.noMatchCount += 1;
    }
  }

  build(): HeroBuildOfflineEvaluationMetrics {
    const coverage = ratio(this.coveredCount, this.sampleCount);
    const top1Accuracy = ratio(this.top1Count, this.sampleCount);
    const top3Accuracy = ratio(this.top3Count, this.sampleCount);
    const top1AccuracyWhenCovered = ratio(this.top1Count, this.coveredCount);
    const top3AccuracyWhenCovered = ratio(this.top3Count, this.coveredCount);

    return {
      sampleCount: this.sampleCount,
      coveredCount: this.coveredCount,
      coverage,
      coveragePercent: toPercent(coverage),
      top1Count: this.top1Count,
      top1Accuracy,
      top1AccuracyPercent: toPercent(top1Accuracy),
      top1AccuracyWhenCovered,
      top1AccuracyWhenCoveredPercent: toPercent(top1AccuracyWhenCovered),
      top3Count: this.top3Count,
      top3Accuracy,
      top3AccuracyPercent: toPercent(top3Accuracy),
      top3AccuracyWhenCovered,
      top3AccuracyWhenCoveredPercent: toPercent(top3AccuracyWhenCovered),
      exactModeCount: this.exactModeCount,
      backoffModeCount: this.backoffModeCount,
      noMatchCount: this.noMatchCount,
    };
  }
}

class ComparisonAccumulator {
  private readonly baseline: PredictionMetricsAccumulator;
  private readonly contextual: PredictionMetricsAccumulator;
  private changedTop1Count = 0;
  private contextualImprovedCount = 0;
  private contextualWorsenedCount = 0;
  private bothTop1CorrectCount = 0;
  private bothTop1WrongCount = 0;

  constructor(comparison?: HeroBuildOfflineEvaluationComparison) {
    this.baseline = new PredictionMetricsAccumulator(comparison?.baseline);
    this.contextual = new PredictionMetricsAccumulator(comparison?.contextual);
    if (!comparison) {
      return;
    }
    this.changedTop1Count = comparison.changedTop1Count;
    this.contextualImprovedCount = comparison.contextualImprovedCount;
    this.contextualWorsenedCount = comparison.contextualWorsenedCount;
    this.bothTop1CorrectCount = comparison.bothTop1CorrectCount;
    this.bothTop1WrongCount = comparison.bothTop1WrongCount;
  }

  add(
    baseline: HeroBuildOfflineModelPrediction,
    contextual: HeroBuildOfflineModelPrediction,
    actualActionKey: string,
  ): void {
    this.baseline.add(baseline, actualActionKey);
    this.contextual.add(contextual, actualActionKey);

    const baselineCorrect = baseline.topActionKey === actualActionKey;
    const contextualCorrect = contextual.topActionKey === actualActionKey;
    if (baseline.topActionKey !== contextual.topActionKey) {
      this.changedTop1Count += 1;
    }
    if (!baselineCorrect && contextualCorrect) {
      this.contextualImprovedCount += 1;
    } else if (baselineCorrect && !contextualCorrect) {
      this.contextualWorsenedCount += 1;
    } else if (baselineCorrect && contextualCorrect) {
      this.bothTop1CorrectCount += 1;
    } else {
      this.bothTop1WrongCount += 1;
    }
  }

  build(): HeroBuildOfflineEvaluationComparison {
    const baseline = this.baseline.build();
    const contextual = this.contextual.build();
    return {
      baseline,
      contextual,
      coverageDeltaPercentagePoints: round(
        contextual.coveragePercent - baseline.coveragePercent,
      ),
      top1DeltaPercentagePoints: round(
        contextual.top1AccuracyPercent - baseline.top1AccuracyPercent,
      ),
      top3DeltaPercentagePoints: round(
        contextual.top3AccuracyPercent - baseline.top3AccuracyPercent,
      ),
      changedTop1Count: this.changedTop1Count,
      contextualImprovedCount: this.contextualImprovedCount,
      contextualWorsenedCount: this.contextualWorsenedCount,
      bothTop1CorrectCount: this.bothTop1CorrectCount,
      bothTop1WrongCount: this.bothTop1WrongCount,
    };
  }
}

function createLowMemoryReport(input: {
  options: HeroBuildOfflineEvaluationOptions;
  sourceWindowLastRefreshedAt?: Date;
  split: HeroBuildOfflineEvaluationMatchSplit;
  training: HeroBuildOfflineEvaluationTrainingSummary;
  sourceTestPlayerCount: number;
  evaluatedPlayerCount: number;
  excludedTestPlayerCount: number;
  evaluatedStepCount: number;
  overall: ComparisonAccumulator;
  byHero: HeroBuildOfflineEvaluationHeroGroup[];
  byPhase: Map<HeroBuildEvaluationPhase, ComparisonAccumulator>;
  byHeroPhase: HeroBuildOfflineEvaluationHeroPhaseGroup[];
  byOutcome: Map<HeroBuildEvaluationOutcome, ComparisonAccumulator>;
  errorExamples: HeroBuildOfflineEvaluationErrorExample[];
  batchSize: number;
  maxRssMb: number;
  totalHeroCount: number;
  peakRssMb: number;
}): HeroBuildOfflineEvaluationLowMemoryReport {
  const overall = input.overall.build();
  const warnings = [
    'Accuracy measures agreement with held-out historical player decisions, not causal proof that an item is optimal.',
    'Contextual reranking uses only training-match outcomes and enemy rosters; test matches are never included in policy or matchup statistics.',
    'The evaluator streams database rows in bounded batches and releases each hero model before processing the next hero.',
    'A durable checkpoint is written after every completed hero and the final report is persisted to disk.',
  ];
  if (input.evaluatedStepCount < 1_000) {
    warnings.push(
      `Only ${input.evaluatedStepCount} held-out steps were evaluated; per-hero and matchup conclusions may be unstable.`,
    );
  }
  if (input.training.matchupObservationCount === 0) {
    warnings.push(
      'No matchup observations were available for contextual reranking.',
    );
  }

  return {
    modelVersion: HERO_BUILD_OFFLINE_EVALUATION_MODEL_VERSION,
    generatedAt: new Date(),
    sourceWindowLastRefreshedAt: cloneDate(input.sourceWindowLastRefreshedAt),
    target: 'OBSERVED_NEXT_ACTION',
    targetInterpretation:
      'The target is the next canonical BUY, UPGRADE, SELL, or REBUY observed in a newer held-out match.',
    heroIdNamespace: 'VALVE_API',
    gameTimeBucketS: HERO_BUILD_OFFLINE_EVALUATION_GAME_TIME_BUCKET_S,
    options: { ...input.options },
    split: createSplitReport(input.split, input.options.trainFraction),
    training: { ...input.training },
    test: {
      sourcePlayerCount: input.sourceTestPlayerCount,
      evaluatedPlayerCount: input.evaluatedPlayerCount,
      excludedPlayerCount: input.excludedTestPlayerCount,
      evaluatedStepCount: input.evaluatedStepCount,
    },
    overall,
    byHero: [...input.byHero].sort((left, right) =>
      compareGroups(
        left.comparison,
        right.comparison,
        left.heroId,
        right.heroId,
      ),
    ),
    byPhase: buildPhaseGroups(input.byPhase),
    byHeroPhase: [...input.byHeroPhase].sort((left, right) => {
      if (left.heroId !== right.heroId) {
        return left.heroId - right.heroId;
      }
      return phaseOrder(left.phase) - phaseOrder(right.phase);
    }),
    byOutcome: buildOutcomeGroups(input.byOutcome),
    errorExamples: input.errorExamples,
    warnings,
    execution: {
      memoryMode: HERO_BUILD_OFFLINE_EVALUATION_LOW_MEMORY_MODE,
      batchSize: input.batchSize,
      maxRssMb: input.maxRssMb,
      totalHeroCount: input.totalHeroCount,
      peakRssMb: round(input.peakRssMb),
    },
  };
}

function createEmptyAggregateState(): EvaluationAggregateState {
  return {
    training: createEmptyTrainingSummary(),
    overall: new ComparisonAccumulator(),
    byHero: [],
    byPhase: new Map(),
    byHeroPhase: [],
    byOutcome: new Map(),
    errorExamples: [],
    sourceTestPlayerCount: 0,
    evaluatedPlayerCount: 0,
    excludedTestPlayerCount: 0,
    evaluatedStepCount: 0,
  };
}

function restoreAggregateState(
  checkpoint: EvaluationCheckpoint,
): EvaluationAggregateState {
  return {
    training: { ...checkpoint.training },
    overall: new ComparisonAccumulator(checkpoint.overall),
    byHero: checkpoint.byHero.map(cloneHeroGroup),
    byPhase: new Map(
      checkpoint.byPhase.map((group) => [
        group.phase,
        new ComparisonAccumulator(group.comparison),
      ]),
    ),
    byHeroPhase: checkpoint.byHeroPhase.map(cloneHeroPhaseGroup),
    byOutcome: new Map(
      checkpoint.byOutcome.map((group) => [
        group.outcome,
        new ComparisonAccumulator(group.comparison),
      ]),
    ),
    errorExamples: checkpoint.errorExamples.map(deserializeErrorExample),
    sourceTestPlayerCount: checkpoint.sourceTestPlayerCount,
    evaluatedPlayerCount: checkpoint.evaluatedPlayerCount,
    excludedTestPlayerCount: checkpoint.excludedTestPlayerCount,
    evaluatedStepCount: checkpoint.evaluatedStepCount,
  };
}

function addTrainingSummary(
  target: MutableTrainingSummary,
  policySnapshot: HeroBuildPolicyAggregationSnapshot,
  matchupIndex: HeroBuildOfflineMatchupIndex,
): void {
  const matchupSummary = matchupIndex.getSummary();
  target.sourcePlayerCount += policySnapshot.sourcePlayerCount;
  target.includedPlayerCount += policySnapshot.includedPlayerCount;
  target.excludedPlayerCount += policySnapshot.excludedPlayerCount;
  target.heroCount += policySnapshot.heroCount;
  target.stateCount += policySnapshot.stateCount;
  target.transitionCount += policySnapshot.transitionCount;
  target.actionOptionCount += policySnapshot.actionOptionCount;
  target.matchupHeroCount += matchupSummary.heroCount;
  target.matchupStateCount += matchupSummary.stateCount;
  target.matchupActionCount += matchupSummary.actionCount;
  target.matchupObservationCount += matchupSummary.observationCount;
}

function createEmptyTrainingSummary(): MutableTrainingSummary {
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
  };
}

function createSplitReport(
  split: HeroBuildOfflineEvaluationMatchSplit,
  trainFraction: number,
): HeroBuildOfflineEvaluationLowMemoryReport['split'] {
  const trainFirst = split.train[0];
  const trainLast = split.train[split.train.length - 1];
  const testFirst = split.test[0];
  const testLast = split.test[split.test.length - 1];

  return {
    strategy: 'CHRONOLOGICAL_MATCH_HOLDOUT',
    selectedMatchCount: split.selected.length,
    trainMatchCount: split.train.length,
    testMatchCount: split.test.length,
    trainFraction,
    trainStartTime: new Date(trainFirst.startTime),
    trainEndTime: new Date(trainLast.startTime),
    testStartTime: new Date(testFirst.startTime),
    testEndTime: new Date(testLast.startTime),
    overlappingMatchCount: 0,
  };
}

function createErrorExample(
  sample: LoadedHeroSample,
  gameTimeS: number,
  beforeStateKey: string,
  phase: HeroBuildEvaluationPhase,
  actualActionKey: string,
  baseline: HeroBuildOfflineModelPrediction,
  contextual: HeroBuildOfflineModelPrediction,
): HeroBuildOfflineEvaluationErrorExample {
  const baselineCorrect = baseline.topActionKey === actualActionKey;
  const contextualCorrect = contextual.topActionKey === actualActionKey;
  return {
    matchId: sample.descriptor.matchId,
    matchStartTime: new Date(sample.descriptor.startTime),
    playerId: sample.player.id,
    heroId: sample.sequence.heroId,
    won: sample.player.won,
    phase,
    gameTimeS,
    beforeStateKey,
    enemyHeroIds: [...sample.enemyHeroIds],
    actualActionKey,
    baselineActionKeys: [...baseline.actionKeys],
    contextualActionKeys: [...contextual.actionKeys],
    baselineMode: baseline.mode,
    contextualMode: contextual.mode,
    contextualChangedTop1: baseline.topActionKey !== contextual.topActionKey,
    contextualImproved: !baselineCorrect && contextualCorrect,
    contextualWorsened: baselineCorrect && !contextualCorrect,
    contextualMatchupPromoted: contextual.matchupPromoted,
    contextualMatchupInserted: contextual.matchupInserted,
    contextualSituationalAgainstHeroId: contextual.situationalAgainstHeroId,
    contextualSituationalLower95OddsRatio:
      contextual.situationalLower95OddsRatio,
  };
}

function toRecentMatchPlayerSnapshot(
  player: MatchPlayer,
  items: readonly MatchPlayerItem[],
): RecentMatchPlayerSnapshot {
  return {
    id: Number(player.id),
    matchId: Number(player.matchId),
    heroId: Number(player.heroId),
    team: toFiniteNumber(player.team),
    won: Boolean(player.won),
    kills: toFiniteNumber(player.kills),
    deaths: toFiniteNumber(player.deaths),
    assists: toFiniteNumber(player.assists),
    netWorth: toFiniteNumber(player.netWorth),
    itemPurchases: items.map(toRecentMatchItemSnapshot),
    skillUpgrades: [],
  };
}

function toRecentMatchItemSnapshot(
  item: MatchPlayerItem,
): RecentMatchItemSnapshot {
  return {
    id: Number(item.id),
    itemId: Number(item.itemId),
    purchaseTimeS: toOptionalFiniteNumber(item.purchaseTimeS),
    soldTimeS: toOptionalFiniteNumber(item.soldTimeS),
    upgradeId: toOptionalFiniteNumber(item.upgradeId),
    flags: toOptionalFiniteNumber(item.flags),
    imbuedAbilityId: toOptionalFiniteNumber(item.imbuedAbilityId),
    upgradeInfo: toOptionalFiniteNumber(item.upgradeInfo),
    slotOrder: toOptionalFiniteNumber(item.slotOrder),
  };
}

function isEvaluableSequence(sequence: CanonicalPlayerBuildSequence): boolean {
  return (
    Number.isSafeInteger(sequence.heroId) &&
    sequence.heroId > 0 &&
    sequence.replayDiagnosticCount === 0 &&
    sequence.steps.length > 0
  );
}

function getOrCreate<K>(
  map: Map<K, ComparisonAccumulator>,
  key: K,
): ComparisonAccumulator {
  const existing = map.get(key);
  if (existing) {
    return existing;
  }
  const created = new ComparisonAccumulator();
  map.set(key, created);
  return created;
}

function groupBy<T, K>(
  values: readonly T[],
  keyOf: (value: T) => K,
): Map<K, T[]> {
  const groups = new Map<K, T[]>();
  for (const value of values) {
    const key = keyOf(value);
    const group = groups.get(key) ?? [];
    group.push(value);
    groups.set(key, group);
  }
  return groups;
}

function buildPhaseGroups(
  values: Map<HeroBuildEvaluationPhase, ComparisonAccumulator>,
): HeroBuildOfflineEvaluationPhaseGroup[] {
  return (['EARLY', 'MID', 'LATE'] as HeroBuildEvaluationPhase[]).map(
    (phase) => ({
      phase,
      comparison:
        values.get(phase)?.build() ?? new ComparisonAccumulator().build(),
    }),
  );
}

function buildOutcomeGroups(
  values: Map<HeroBuildEvaluationOutcome, ComparisonAccumulator>,
): HeroBuildOfflineEvaluationOutcomeGroup[] {
  return (['WIN', 'LOSS'] as HeroBuildEvaluationOutcome[]).map((outcome) => ({
    outcome,
    comparison:
      values.get(outcome)?.build() ?? new ComparisonAccumulator().build(),
  }));
}

function serializeSplit(split: HeroBuildOfflineEvaluationMatchSplit): {
  selected: PersistedMatchDescriptor[];
  train: PersistedMatchDescriptor[];
  test: PersistedMatchDescriptor[];
} {
  return {
    selected: split.selected.map(serializeDescriptor),
    train: split.train.map(serializeDescriptor),
    test: split.test.map(serializeDescriptor),
  };
}

function deserializeSplit(
  split: EvaluationCheckpoint['split'],
): HeroBuildOfflineEvaluationMatchSplit {
  return {
    selected: split.selected.map(deserializeDescriptor),
    train: split.train.map(deserializeDescriptor),
    test: split.test.map(deserializeDescriptor),
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

function serializeErrorExample(
  example: HeroBuildOfflineEvaluationErrorExample,
): PersistedErrorExample {
  return {
    ...example,
    enemyHeroIds: [...example.enemyHeroIds],
    baselineActionKeys: [...example.baselineActionKeys],
    contextualActionKeys: [...example.contextualActionKeys],
    matchStartTime: example.matchStartTime.toISOString(),
  };
}

function deserializeErrorExample(
  example: PersistedErrorExample,
): HeroBuildOfflineEvaluationErrorExample {
  return {
    ...example,
    enemyHeroIds: [...example.enemyHeroIds],
    baselineActionKeys: [...example.baselineActionKeys],
    contextualActionKeys: [...example.contextualActionKeys],
    matchStartTime: new Date(example.matchStartTime),
  };
}

function cloneHeroGroup(
  group: HeroBuildOfflineEvaluationHeroGroup,
): HeroBuildOfflineEvaluationHeroGroup {
  return {
    heroId: group.heroId,
    comparison: cloneComparison(group.comparison),
  };
}

function cloneHeroPhaseGroup(
  group: HeroBuildOfflineEvaluationHeroPhaseGroup,
): HeroBuildOfflineEvaluationHeroPhaseGroup {
  return {
    heroId: group.heroId,
    phase: group.phase,
    comparison: cloneComparison(group.comparison),
  };
}

function cloneComparison(
  comparison: HeroBuildOfflineEvaluationComparison,
): HeroBuildOfflineEvaluationComparison {
  return {
    ...comparison,
    baseline: { ...comparison.baseline },
    contextual: { ...comparison.contextual },
  };
}

function deserializeReport(
  raw: unknown,
): HeroBuildOfflineEvaluationLowMemoryReport | undefined {
  if (!isRecord(raw) || raw.modelVersion !== HERO_BUILD_OFFLINE_EVALUATION_MODEL_VERSION) {
    return undefined;
  }

  const report = raw as unknown as HeroBuildOfflineEvaluationLowMemoryReport;
  const generatedAt = new Date(String(report.generatedAt));
  if (!Number.isFinite(generatedAt.getTime())) {
    return undefined;
  }

  return {
    ...report,
    generatedAt,
    sourceWindowLastRefreshedAt: parseOptionalDate(
      report.sourceWindowLastRefreshedAt,
    ),
    split: {
      ...report.split,
      trainStartTime: new Date(report.split.trainStartTime),
      trainEndTime: new Date(report.split.trainEndTime),
      testStartTime: new Date(report.split.testStartTime),
      testEndTime: new Date(report.split.testEndTime),
    },
    errorExamples: report.errorExamples.map((example) => ({
      ...example,
      matchStartTime: new Date(example.matchStartTime),
    })),
  };
}

function isEvaluationCheckpoint(value: unknown): value is EvaluationCheckpoint {
  if (!isRecord(value)) {
    return false;
  }
  const nextHeroIndex = value.nextHeroIndex;
  if (
    value.schemaVersion !==
      HERO_BUILD_OFFLINE_EVALUATION_CHECKPOINT_SCHEMA_VERSION ||
    value.modelVersion !== HERO_BUILD_OFFLINE_EVALUATION_MODEL_VERSION ||
    !Array.isArray(value.heroIds) ||
    typeof nextHeroIndex !== 'number' ||
    !Number.isSafeInteger(nextHeroIndex) ||
    !isRecord(value.split) ||
    !Array.isArray(value.split.selected) ||
    !Array.isArray(value.split.train) ||
    !Array.isArray(value.split.test)
  ) {
    return false;
  }
  return (
    nextHeroIndex >= 0 &&
    nextHeroIndex <= value.heroIds.length &&
    isRecord(value.options) &&
    isRecord(value.training) &&
    isRecord(value.overall) &&
    Array.isArray(value.byHero) &&
    Array.isArray(value.byPhase) &&
    Array.isArray(value.byHeroPhase) &&
    Array.isArray(value.byOutcome) &&
    Array.isArray(value.errorExamples) &&
    typeof value.startedAt === 'string'
  );
}

export function isTransientDatabaseError(error: unknown): boolean {
  const code = getErrorCode(error);
  if (
    code &&
    [
      'ECONNRESET',
      'ECONNREFUSED',
      'EPIPE',
      'ETIMEDOUT',
      'ENETRESET',
      'ENETUNREACH',
      '57P01',
      '57P02',
      '57P03',
      '08000',
      '08003',
      '08006',
      '08P01',
    ].includes(code)
  ) {
    return true;
  }

  const message = getErrorMessage(error).toLowerCase();
  return [
    'connection terminated unexpectedly',
    'connection terminated',
    'connection reset by peer',
    'client has already been released',
    'the database system is starting up',
    'the database system is shutting down',
  ].some((candidate) => message.includes(candidate));
}

function getErrorCode(error: unknown): string | undefined {
  if (!isRecord(error)) {
    return undefined;
  }
  if (typeof error.code === 'string') {
    return error.code;
  }
  if (isRecord(error.driverError) && typeof error.driverError.code === 'string') {
    return error.driverError.code;
  }
  return undefined;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseOptionalDate(value: unknown): Date | undefined {
  if (value === undefined) {
    return undefined;
  }
  const date = new Date(String(value));
  return Number.isFinite(date.getTime()) ? date : undefined;
}

function normalizeHeroIds(heroIds: readonly number[]): number[] {
  return [
    ...new Set(
      heroIds.filter(
        (heroId) => Number.isSafeInteger(heroId) && heroId > 0,
      ),
    ),
  ].sort((left, right) => left - right);
}

function compareGroups(
  left: HeroBuildOfflineEvaluationComparison,
  right: HeroBuildOfflineEvaluationComparison,
  leftId: number,
  rightId: number,
): number {
  if (left.baseline.sampleCount !== right.baseline.sampleCount) {
    return right.baseline.sampleCount - left.baseline.sampleCount;
  }
  return leftId - rightId;
}

function phaseOrder(phase: HeroBuildEvaluationPhase): number {
  if (phase === 'EARLY') return 0;
  if (phase === 'MID') return 1;
  return 2;
}

function ratio(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

function toPercent(value: number): number {
  return round(value * 100);
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function bytesToMegabytes(value: number): number {
  return value / BYTES_PER_MEGABYTE;
}

function toFiniteNumber(value: unknown): number {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : 0;
}

function toOptionalFiniteNumber(value: unknown): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : undefined;
}

function readBoundedIntegerEnvironmentValue(
  name: string,
  defaultValue: number,
  minimum: number,
  maximum: number,
): number {
  const rawValue = process.env[name];
  if (rawValue === undefined || rawValue.trim().length === 0) {
    return defaultValue;
  }
  const parsed = Number(rawValue);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    return defaultValue;
  }
  return parsed;
}

function readBooleanEnvironmentValue(name: string, defaultValue: boolean): boolean {
  const rawValue = process.env[name]?.trim().toLowerCase();
  if (rawValue === 'true') {
    return true;
  }
  if (rawValue === 'false') {
    return false;
  }
  return defaultValue;
}

function cloneDate(value: Date | undefined): Date | undefined {
  return value ? new Date(value) : undefined;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
