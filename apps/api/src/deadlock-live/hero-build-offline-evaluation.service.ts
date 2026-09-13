import { Injectable, Logger } from '@nestjs/common';
import {
  CanonicalBuildSequenceService,
  CanonicalPlayerBuildSequence,
} from './canonical-build-sequence.service';
import {
  HeroBuildOfflineEvaluationModel,
  HeroBuildOfflineMatchupIndex,
  HeroBuildOfflineModelPrediction,
  HERO_BUILD_OFFLINE_EVALUATION_GAME_TIME_BUCKET_S,
  HERO_BUILD_OFFLINE_EVALUATION_MODEL_VERSION,
  normalizeObservedActionKey,
} from './hero-build-offline-evaluation.model';
import {
  HeroBuildTransitionAccumulator,
  HeroBuildPolicyAggregationSnapshot,
} from './hero-build-transition-aggregation.service';
import { InventoryTimelineReplayService } from './inventory-timeline-replay.service';
import { MatchTimelineNormalizationService } from './match-timeline-normalization.service';
import {
  RecentMatchPlayerSnapshot,
  RecentMatchSnapshot,
  RecentMatchesWindowService,
} from './recent-matches-window.service';
import { RecipeAwareTimelineReconciliationService } from './recipe-aware-timeline-reconciliation.service';

export const HERO_BUILD_OFFLINE_EVALUATION_DEFAULT_TRAIN_FRACTION = 0.8;
export const HERO_BUILD_OFFLINE_EVALUATION_DEFAULT_MAX_MATCHES = 10_000;
export const HERO_BUILD_OFFLINE_EVALUATION_MAX_MATCHES = 10_000;
export const HERO_BUILD_OFFLINE_EVALUATION_DEFAULT_ERROR_EXAMPLE_LIMIT = 100;
export const HERO_BUILD_OFFLINE_EVALUATION_MAX_ERROR_EXAMPLE_LIMIT = 500;
export const HERO_BUILD_OFFLINE_EVALUATION_YIELD_INTERVAL = 25;

export type HeroBuildEvaluationPhase = 'EARLY' | 'MID' | 'LATE';
export type HeroBuildEvaluationOutcome = 'WIN' | 'LOSS';
export type HeroBuildOfflineEvaluationRunState =
  | 'IDLE'
  | 'RUNNING'
  | 'COMPLETE'
  | 'FAILED';
export type HeroBuildOfflineEvaluationProgressPhase =
  | 'PREPARING'
  | 'TRAINING'
  | 'EVALUATING'
  | 'COMPLETE';

export interface HeroBuildOfflineEvaluationOptions {
  trainFraction: number;
  maxMatches: number;
  errorExampleLimit: number;
}

export interface HeroBuildOfflineEvaluationStartRequest {
  trainFraction?: number;
  maxMatches?: number;
  errorExampleLimit?: number;
}

export interface HeroBuildOfflineEvaluationMetrics {
  sampleCount: number;
  coveredCount: number;
  coverage: number;
  coveragePercent: number;
  top1Count: number;
  top1Accuracy: number;
  top1AccuracyPercent: number;
  top1AccuracyWhenCovered: number;
  top1AccuracyWhenCoveredPercent: number;
  top3Count: number;
  top3Accuracy: number;
  top3AccuracyPercent: number;
  top3AccuracyWhenCovered: number;
  top3AccuracyWhenCoveredPercent: number;
  exactModeCount: number;
  backoffModeCount: number;
  noMatchCount: number;
}

export interface HeroBuildOfflineEvaluationComparison {
  baseline: HeroBuildOfflineEvaluationMetrics;
  contextual: HeroBuildOfflineEvaluationMetrics;
  coverageDeltaPercentagePoints: number;
  top1DeltaPercentagePoints: number;
  top3DeltaPercentagePoints: number;
  changedTop1Count: number;
  contextualImprovedCount: number;
  contextualWorsenedCount: number;
  bothTop1CorrectCount: number;
  bothTop1WrongCount: number;
}

export interface HeroBuildOfflineEvaluationHeroGroup {
  heroId: number;
  comparison: HeroBuildOfflineEvaluationComparison;
}

export interface HeroBuildOfflineEvaluationPhaseGroup {
  phase: HeroBuildEvaluationPhase;
  comparison: HeroBuildOfflineEvaluationComparison;
}

export interface HeroBuildOfflineEvaluationHeroPhaseGroup {
  heroId: number;
  phase: HeroBuildEvaluationPhase;
  comparison: HeroBuildOfflineEvaluationComparison;
}

export interface HeroBuildOfflineEvaluationOutcomeGroup {
  outcome: HeroBuildEvaluationOutcome;
  comparison: HeroBuildOfflineEvaluationComparison;
}

export interface HeroBuildOfflineEvaluationErrorExample {
  matchId: number;
  matchStartTime: Date;
  playerId: number;
  heroId: number;
  won: boolean;
  phase: HeroBuildEvaluationPhase;
  gameTimeS: number;
  beforeStateKey: string;
  enemyHeroIds: number[];
  actualActionKey: string;
  baselineActionKeys: string[];
  contextualActionKeys: string[];
  baselineMode: HeroBuildOfflineModelPrediction['mode'];
  contextualMode: HeroBuildOfflineModelPrediction['mode'];
  contextualChangedTop1: boolean;
  contextualImproved: boolean;
  contextualWorsened: boolean;
  contextualMatchupPromoted: boolean;
  contextualMatchupInserted: boolean;
  contextualSituationalAgainstHeroId?: number;
  contextualSituationalLower95OddsRatio?: number;
}

export interface HeroBuildOfflineEvaluationSplit {
  strategy: 'CHRONOLOGICAL_MATCH_HOLDOUT';
  selectedMatchCount: number;
  trainMatchCount: number;
  testMatchCount: number;
  trainFraction: number;
  trainStartTime: Date;
  trainEndTime: Date;
  testStartTime: Date;
  testEndTime: Date;
  overlappingMatchCount: 0;
}

export interface HeroBuildOfflineEvaluationTrainingSummary {
  sourcePlayerCount: number;
  includedPlayerCount: number;
  excludedPlayerCount: number;
  heroCount: number;
  stateCount: number;
  transitionCount: number;
  actionOptionCount: number;
  matchupHeroCount: number;
  matchupStateCount: number;
  matchupActionCount: number;
  matchupObservationCount: number;
}

export interface HeroBuildOfflineEvaluationTestSummary {
  sourcePlayerCount: number;
  evaluatedPlayerCount: number;
  excludedPlayerCount: number;
  evaluatedStepCount: number;
}

export interface HeroBuildOfflineEvaluationReport {
  modelVersion: typeof HERO_BUILD_OFFLINE_EVALUATION_MODEL_VERSION;
  generatedAt: Date;
  sourceWindowLastRefreshedAt?: Date;
  target: 'OBSERVED_NEXT_ACTION';
  targetInterpretation: string;
  heroIdNamespace: 'VALVE_API';
  gameTimeBucketS: number;
  options: HeroBuildOfflineEvaluationOptions;
  split: HeroBuildOfflineEvaluationSplit;
  training: HeroBuildOfflineEvaluationTrainingSummary;
  test: HeroBuildOfflineEvaluationTestSummary;
  overall: HeroBuildOfflineEvaluationComparison;
  byHero: HeroBuildOfflineEvaluationHeroGroup[];
  byPhase: HeroBuildOfflineEvaluationPhaseGroup[];
  byHeroPhase: HeroBuildOfflineEvaluationHeroPhaseGroup[];
  byOutcome: HeroBuildOfflineEvaluationOutcomeGroup[];
  errorExamples: HeroBuildOfflineEvaluationErrorExample[];
  warnings: string[];
}

export interface HeroBuildOfflineEvaluationStatus {
  state: HeroBuildOfflineEvaluationRunState;
  phase?: HeroBuildOfflineEvaluationProgressPhase;
  options?: HeroBuildOfflineEvaluationOptions;
  startedAt?: Date;
  completedAt?: Date;
  totalMatchCount: number;
  trainMatchCount: number;
  testMatchCount: number;
  processedTrainMatchCount: number;
  processedTestMatchCount: number;
  evaluatedStepCount: number;
  reportAvailable: boolean;
  error?: string;
}

export interface HeroBuildOfflineEvaluationMatchDescriptor {
  matchId: number;
  startTime: Date;
}

export interface HeroBuildOfflineEvaluationMatchSplit {
  selected: HeroBuildOfflineEvaluationMatchDescriptor[];
  train: HeroBuildOfflineEvaluationMatchDescriptor[];
  test: HeroBuildOfflineEvaluationMatchDescriptor[];
}

interface EvaluationSampleContext {
  match: RecentMatchSnapshot;
  player: RecentMatchPlayerSnapshot;
  sequence: CanonicalPlayerBuildSequence;
  enemyHeroIds: number[];
}

@Injectable()
export class HeroBuildOfflineEvaluationService {
  private readonly logger = new Logger(HeroBuildOfflineEvaluationService.name);
  private runPromise?: Promise<HeroBuildOfflineEvaluationReport>;
  private report?: HeroBuildOfflineEvaluationReport;
  private status: HeroBuildOfflineEvaluationStatus = createIdleStatus();

  constructor(
    private readonly recentMatchesWindowService: RecentMatchesWindowService,
    private readonly matchTimelineNormalizationService: MatchTimelineNormalizationService,
    private readonly inventoryTimelineReplayService: InventoryTimelineReplayService,
    private readonly canonicalBuildSequenceService: CanonicalBuildSequenceService,
    private readonly recipeAwareTimelineReconciliationService:
      RecipeAwareTimelineReconciliationService,
  ) {}

  start(
    request: HeroBuildOfflineEvaluationStartRequest = {},
  ): HeroBuildOfflineEvaluationStatus {
    if (this.runPromise) {
      return this.getStatus();
    }

    const options = normalizeHeroBuildOfflineEvaluationOptions(request);
    const startedAt = new Date();
    this.report = undefined;
    this.status = {
      state: 'RUNNING',
      phase: 'PREPARING',
      options,
      startedAt,
      totalMatchCount: 0,
      trainMatchCount: 0,
      testMatchCount: 0,
      processedTrainMatchCount: 0,
      processedTestMatchCount: 0,
      evaluatedStepCount: 0,
      reportAvailable: false,
    };

    this.runPromise = this.run(options)
      .then((report) => {
        this.report = report;
        this.status = {
          ...this.status,
          state: 'COMPLETE',
          phase: 'COMPLETE',
          completedAt: new Date(),
          reportAvailable: true,
          error: undefined,
        };
        return report;
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.status = {
          ...this.status,
          state: 'FAILED',
          completedAt: new Date(),
          reportAvailable: false,
          error: message,
        };
        this.logger.error(`Offline build evaluation failed: ${message}`);
        throw error;
      })
      .finally(() => {
        this.runPromise = undefined;
      });
    void this.runPromise.catch(() => undefined);

    return this.getStatus();
  }

  getStatus(): HeroBuildOfflineEvaluationStatus {
    return {
      ...this.status,
      options: this.status.options ? { ...this.status.options } : undefined,
      startedAt: cloneDate(this.status.startedAt),
      completedAt: cloneDate(this.status.completedAt),
    };
  }

  getReport(): HeroBuildOfflineEvaluationReport | undefined {
    return this.report;
  }

  private async run(
    options: HeroBuildOfflineEvaluationOptions,
  ): Promise<HeroBuildOfflineEvaluationReport> {
    let sourceStatus = this.recentMatchesWindowService.getStatus();
    if (!sourceStatus.lastRefreshedAt) {
      sourceStatus = await this.recentMatchesWindowService.refresh();
    }

    try {
      await this.recipeAwareTimelineReconciliationService.refreshRecipes();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Using the existing recipe cache for offline evaluation: ${message}`);
    }

    const descriptors = await this.getMatchDescriptors();
    const split = splitHeroBuildEvaluationMatches(
      descriptors,
      options.trainFraction,
      options.maxMatches,
    );
    if (split.train.length === 0 || split.test.length === 0) {
      throw new Error('Offline evaluation requires at least two historical matches.');
    }

    this.status = {
      ...this.status,
      phase: 'TRAINING',
      totalMatchCount: split.selected.length,
      trainMatchCount: split.train.length,
      testMatchCount: split.test.length,
    };

    const transitionAccumulator = new HeroBuildTransitionAccumulator();
    const matchupIndex = new HeroBuildOfflineMatchupIndex();

    for (const [index, descriptor] of split.train.entries()) {
      const match = this.recentMatchesWindowService.getMatch(descriptor.matchId);
      if (match) {
        const sequences = this.prepareMatch(match);
        const playersById = new Map(match.players.map((player) => [player.id, player]));
        for (const sequence of sequences) {
          transitionAccumulator.addPlayer(sequence);
          const player = playersById.get(sequence.playerId);
          if (!player) {
            continue;
          }
          matchupIndex.addSequence(
            sequence,
            player.won,
            getEnemyHeroIds(match, player),
          );
        }
      }

      this.status = {
        ...this.status,
        processedTrainMatchCount: index + 1,
      };
      if ((index + 1) % HERO_BUILD_OFFLINE_EVALUATION_YIELD_INTERVAL === 0) {
        await yieldToEventLoop();
      }
    }

    const policySnapshot = transitionAccumulator.build();
    const model = new HeroBuildOfflineEvaluationModel(
      policySnapshot.policiesByHeroId,
      matchupIndex,
      (parentItemId) =>
        this.recipeAwareTimelineReconciliationService.getComponentItemIds(parentItemId),
    );
    const overall = new ComparisonAccumulator();
    const byHero = new Map<number, ComparisonAccumulator>();
    const byPhase = new Map<HeroBuildEvaluationPhase, ComparisonAccumulator>();
    const byHeroPhase = new Map<string, ComparisonAccumulator>();
    const byOutcome = new Map<HeroBuildEvaluationOutcome, ComparisonAccumulator>();
    const errorExamples: HeroBuildOfflineEvaluationErrorExample[] = [];
    let sourceTestPlayerCount = 0;
    let evaluatedPlayerCount = 0;
    let excludedTestPlayerCount = 0;
    let evaluatedStepCount = 0;

    this.status = {
      ...this.status,
      phase: 'EVALUATING',
    };

    for (const [index, descriptor] of split.test.entries()) {
      const match = this.recentMatchesWindowService.getMatch(descriptor.matchId);
      if (match) {
        const sequences = this.prepareMatch(match);
        const playersById = new Map(match.players.map((player) => [player.id, player]));
        sourceTestPlayerCount += sequences.length;

        for (const sequence of sequences) {
          const player = playersById.get(sequence.playerId);
          if (!player || !isEvaluableSequence(sequence)) {
            excludedTestPlayerCount += 1;
            continue;
          }

          evaluatedPlayerCount += 1;
          const context: EvaluationSampleContext = {
            match,
            player,
            sequence,
            enemyHeroIds: getEnemyHeroIds(match, player),
          };
          for (const step of sequence.steps) {
            const predictions = model.predict({
              heroId: sequence.heroId,
              stateKey: step.beforeStateKey,
              gameTimeS: step.gameTimeS,
              enemyHeroIds: context.enemyHeroIds,
            });
            const actualActionKey = normalizeObservedActionKey(
              step.actionType,
              step.itemId,
            );
            const phase = getHeroBuildEvaluationPhase(step.gameTimeS);
            const outcome: HeroBuildEvaluationOutcome = player.won ? 'WIN' : 'LOSS';

            overall.add(predictions.baseline, predictions.contextual, actualActionKey);
            getOrCreate(byHero, sequence.heroId).add(
              predictions.baseline,
              predictions.contextual,
              actualActionKey,
            );
            getOrCreate(byPhase, phase).add(
              predictions.baseline,
              predictions.contextual,
              actualActionKey,
            );
            getOrCreate(byHeroPhase, `${sequence.heroId}:${phase}`).add(
              predictions.baseline,
              predictions.contextual,
              actualActionKey,
            );
            getOrCreate(byOutcome, outcome).add(
              predictions.baseline,
              predictions.contextual,
              actualActionKey,
            );

            if (
              errorExamples.length < options.errorExampleLimit &&
              (predictions.baseline.topActionKey !== actualActionKey ||
                predictions.contextual.topActionKey !== actualActionKey)
            ) {
              errorExamples.push(
                createErrorExample(
                  context,
                  step.gameTimeS,
                  step.beforeStateKey,
                  phase,
                  actualActionKey,
                  predictions.baseline,
                  predictions.contextual,
                ),
              );
            }

            evaluatedStepCount += 1;
          }
        }
      }

      this.status = {
        ...this.status,
        processedTestMatchCount: index + 1,
        evaluatedStepCount,
      };
      if ((index + 1) % HERO_BUILD_OFFLINE_EVALUATION_YIELD_INTERVAL === 0) {
        await yieldToEventLoop();
      }
    }

    const report = createReport({
      options,
      sourceWindowLastRefreshedAt: sourceStatus.lastRefreshedAt,
      split,
      policySnapshot,
      matchupIndex,
      sourceTestPlayerCount,
      evaluatedPlayerCount,
      excludedTestPlayerCount,
      evaluatedStepCount,
      overall,
      byHero,
      byPhase,
      byHeroPhase,
      byOutcome,
      errorExamples,
    });

    this.logger.log(
      `Evaluated ${report.test.evaluatedStepCount} held-out build steps from ` +
        `${report.split.testMatchCount} matches: baseline top-1 ` +
        `${report.overall.baseline.top1AccuracyPercent.toFixed(2)}%, contextual ` +
        `${report.overall.contextual.top1AccuracyPercent.toFixed(2)}%.`,
    );

    return report;
  }

  private async getMatchDescriptors(): Promise<
    HeroBuildOfflineEvaluationMatchDescriptor[]
  > {
    const descriptors: HeroBuildOfflineEvaluationMatchDescriptor[] = [];
    const matchIds = this.recentMatchesWindowService.getMatchIds();
    for (const [index, matchId] of matchIds.entries()) {
      const match = this.recentMatchesWindowService.getMatch(matchId);
      if (match) {
        descriptors.push({ matchId, startTime: new Date(match.startTime) });
      }
      if ((index + 1) % HERO_BUILD_OFFLINE_EVALUATION_YIELD_INTERVAL === 0) {
        await yieldToEventLoop();
      }
    }
    return descriptors;
  }

  private prepareMatch(match: RecentMatchSnapshot): CanonicalPlayerBuildSequence[] {
    const timelines = this.matchTimelineNormalizationService.normalizeMatch(match);
    const replay = this.inventoryTimelineReplayService.replayMatch(timelines);
    return this.canonicalBuildSequenceService.canonicalizeMatch(replay).players;
  }
}

export function normalizeHeroBuildOfflineEvaluationOptions(
  request: HeroBuildOfflineEvaluationStartRequest,
): HeroBuildOfflineEvaluationOptions {
  return {
    trainFraction:
      request.trainFraction ?? HERO_BUILD_OFFLINE_EVALUATION_DEFAULT_TRAIN_FRACTION,
    maxMatches:
      request.maxMatches ?? HERO_BUILD_OFFLINE_EVALUATION_DEFAULT_MAX_MATCHES,
    errorExampleLimit:
      request.errorExampleLimit ??
      HERO_BUILD_OFFLINE_EVALUATION_DEFAULT_ERROR_EXAMPLE_LIMIT,
  };
}

export function splitHeroBuildEvaluationMatches(
  descriptors: readonly HeroBuildOfflineEvaluationMatchDescriptor[],
  trainFraction: number,
  maxMatches: number,
): HeroBuildOfflineEvaluationMatchSplit {
  const sorted = [...descriptors].sort((left, right) => {
    const timeDifference = left.startTime.getTime() - right.startTime.getTime();
    return timeDifference !== 0 ? timeDifference : left.matchId - right.matchId;
  });
  const selected = sorted.slice(Math.max(0, sorted.length - maxMatches));
  if (selected.length < 2) {
    return { selected, train: [], test: [] };
  }

  const splitIndex = Math.max(
    1,
    Math.min(selected.length - 1, Math.floor(selected.length * trainFraction)),
  );
  return {
    selected,
    train: selected.slice(0, splitIndex),
    test: selected.slice(splitIndex),
  };
}

export function getHeroBuildEvaluationPhase(gameTimeS: number): HeroBuildEvaluationPhase {
  if (gameTimeS < 10 * 60) {
    return 'EARLY';
  }
  if (gameTimeS < 20 * 60) {
    return 'MID';
  }
  return 'LATE';
}

class PredictionMetricsAccumulator {
  private sampleCount = 0;
  private coveredCount = 0;
  private top1Count = 0;
  private top3Count = 0;
  private exactModeCount = 0;
  private backoffModeCount = 0;
  private noMatchCount = 0;

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
  private readonly baseline = new PredictionMetricsAccumulator();
  private readonly contextual = new PredictionMetricsAccumulator();
  private changedTop1Count = 0;
  private contextualImprovedCount = 0;
  private contextualWorsenedCount = 0;
  private bothTop1CorrectCount = 0;
  private bothTop1WrongCount = 0;

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

function createReport(input: {
  options: HeroBuildOfflineEvaluationOptions;
  sourceWindowLastRefreshedAt?: Date;
  split: HeroBuildOfflineEvaluationMatchSplit;
  policySnapshot: HeroBuildPolicyAggregationSnapshot;
  matchupIndex: HeroBuildOfflineMatchupIndex;
  sourceTestPlayerCount: number;
  evaluatedPlayerCount: number;
  excludedTestPlayerCount: number;
  evaluatedStepCount: number;
  overall: ComparisonAccumulator;
  byHero: Map<number, ComparisonAccumulator>;
  byPhase: Map<HeroBuildEvaluationPhase, ComparisonAccumulator>;
  byHeroPhase: Map<string, ComparisonAccumulator>;
  byOutcome: Map<HeroBuildEvaluationOutcome, ComparisonAccumulator>;
  errorExamples: HeroBuildOfflineEvaluationErrorExample[];
}): HeroBuildOfflineEvaluationReport {
  const matchupSummary = input.matchupIndex.getSummary();
  const overall = input.overall.build();
  const warnings = [
    'Accuracy measures agreement with held-out historical player decisions, not causal proof that an item is optimal.',
    'Contextual reranking uses only training-match outcomes and enemy rosters; test matches are never included in policy or matchup statistics.',
  ];
  if (input.evaluatedStepCount < 1_000) {
    warnings.push(
      `Only ${input.evaluatedStepCount} held-out steps were evaluated; per-hero and matchup conclusions may be unstable.`,
    );
  }
  if (matchupSummary.observationCount === 0) {
    warnings.push('No matchup observations were available for contextual reranking.');
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
    training: {
      sourcePlayerCount: input.policySnapshot.sourcePlayerCount,
      includedPlayerCount: input.policySnapshot.includedPlayerCount,
      excludedPlayerCount: input.policySnapshot.excludedPlayerCount,
      heroCount: input.policySnapshot.heroCount,
      stateCount: input.policySnapshot.stateCount,
      transitionCount: input.policySnapshot.transitionCount,
      actionOptionCount: input.policySnapshot.actionOptionCount,
      matchupHeroCount: matchupSummary.heroCount,
      matchupStateCount: matchupSummary.stateCount,
      matchupActionCount: matchupSummary.actionCount,
      matchupObservationCount: matchupSummary.observationCount,
    },
    test: {
      sourcePlayerCount: input.sourceTestPlayerCount,
      evaluatedPlayerCount: input.evaluatedPlayerCount,
      excludedPlayerCount: input.excludedTestPlayerCount,
      evaluatedStepCount: input.evaluatedStepCount,
    },
    overall,
    byHero: [...input.byHero.entries()]
      .map(([heroId, accumulator]) => ({
        heroId,
        comparison: accumulator.build(),
      }))
      .sort((left, right) =>
        compareGroups(left.comparison, right.comparison, left.heroId, right.heroId),
      ),
    byPhase: (['EARLY', 'MID', 'LATE'] as HeroBuildEvaluationPhase[])
      .map((phase) => ({
        phase,
        comparison: input.byPhase.get(phase)?.build() ?? new ComparisonAccumulator().build(),
      })),
    byHeroPhase: [...input.byHeroPhase.entries()]
      .map(([key, accumulator]) => {
        const [heroId, phase] = key.split(':');
        return {
          heroId: Number(heroId),
          phase: phase as HeroBuildEvaluationPhase,
          comparison: accumulator.build(),
        };
      })
      .sort((left, right) => {
        if (left.heroId !== right.heroId) {
          return left.heroId - right.heroId;
        }
        return phaseOrder(left.phase) - phaseOrder(right.phase);
      }),
    byOutcome: (['WIN', 'LOSS'] as HeroBuildEvaluationOutcome[]).map((outcome) => ({
      outcome,
      comparison:
        input.byOutcome.get(outcome)?.build() ?? new ComparisonAccumulator().build(),
    })),
    errorExamples: input.errorExamples,
    warnings,
  };
}

function createSplitReport(
  split: HeroBuildOfflineEvaluationMatchSplit,
  trainFraction: number,
): HeroBuildOfflineEvaluationSplit {
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
  context: EvaluationSampleContext,
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
    matchId: context.match.matchId,
    matchStartTime: new Date(context.match.startTime),
    playerId: context.player.id,
    heroId: context.sequence.heroId,
    won: context.player.won,
    phase,
    gameTimeS,
    beforeStateKey,
    enemyHeroIds: [...context.enemyHeroIds],
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

function getEnemyHeroIds(
  match: RecentMatchSnapshot,
  player: RecentMatchPlayerSnapshot,
): number[] {
  return [...new Set(
    match.players
      .filter((candidate) => candidate.team !== player.team)
      .map((candidate) => candidate.heroId)
      .filter((heroId) => Number.isSafeInteger(heroId) && heroId > 0),
  )].sort((left, right) => left - right);
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

function createIdleStatus(): HeroBuildOfflineEvaluationStatus {
  return {
    state: 'IDLE',
    totalMatchCount: 0,
    trainMatchCount: 0,
    testMatchCount: 0,
    processedTrainMatchCount: 0,
    processedTestMatchCount: 0,
    evaluatedStepCount: 0,
    reportAvailable: false,
  };
}

function cloneDate(value: Date | undefined): Date | undefined {
  return value ? new Date(value) : undefined;
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
