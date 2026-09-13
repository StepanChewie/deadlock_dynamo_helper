import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { In, Repository } from 'typeorm';
import type { HeroBuildContextualRecommendationRequest } from './contextual-hero-build-recommendation.service';
import { Item } from './entities/item.entity';
import type {
  HeroBuildRecommendationAction,
  HeroBuildRecommendationResponse,
} from './hero-build-recommendation.service';
import { createInventoryStateKeyFromItemIds } from './hero-build-transition-aggregation.service';
import {
  buildRecommendationValueV6ActionKeys,
  buildRecommendationValueV6StateKeys,
  classifyRecommendationValueV6TeamEconomy,
  type RecommendationValueV6TeamEconomyBand,
} from './recommendation-value-v6-features';
import {
  RECOMMENDATION_VALUE_V6_MODEL_VERSION,
  predictRecommendationValueV6,
  type RecommendationValueV6Count,
  type RecommendationValueV6Model,
  type RecommendationValueV6ModelOptions,
  type RecommendationValueV6Prediction,
} from './recommendation-value-v6-model';
import {
  RecommendationValueV6TelemetryService,
  type RecommendationValueV6CandidateDecisionScore,
} from './recommendation-value-v6-telemetry.service';

const MODEL_DIR_ENV = 'DEADLOCK_RECOMMENDATION_VALUE_V6_LIVE_MODEL_DIR';
const EXPECTED_SHA_ENV =
  'DEADLOCK_RECOMMENDATION_VALUE_V6_LIVE_EXPECTED_MODEL_SHA256';
const MODE_ENV = 'DEADLOCK_RECOMMENDATION_VALUE_V6_LIVE_MODE';
const MIN_SEPARATION_ENV =
  'DEADLOCK_RECOMMENDATION_VALUE_V6_CANARY_MIN_SEPARATION';
const DEFAULT_MIN_SEPARATION = 0.001;
const LIVE_TIME_BUCKET_SECONDS = 120;
const EXPECTED_MODEL_KIND = 'OBSERVATIONAL_STATE_ACTION_ADVANTAGE';
const EXPECTED_PROMOTION_USAGE = 'GLOBAL_CANARY_OPERATOR_OVERRIDE';
const CANDIDATE_GENERATOR_VERSION =
  'PRODUCTION_HERO_BUILD_RECOMMENDER_251660F';
const STATE_FEATURE_VERSION = 'RECOMMENDATION_VALUE_V6_FEATURE_KEYS_1';
const BASELINE_MODEL_VERSION = 'CURRENT_PRODUCTION_RECOMMENDER';
const POLICY_VERSION = 'RECOMMENDATION_VALUE_V6_GLOBAL_CANARY_1';
const CATALOG_VERSION = 'CURRENT_ITEMS_TABLE';

export type RecommendationValueV6LiveMode = 'DISABLED' | 'SHADOW' | 'CANARY';
export type RecommendationValueV6LiveModelState =
  | 'DISABLED'
  | 'READY'
  | 'FAILED';

export interface RecommendationValueV6LiveContext {
  matchId?: string;
  localSteamId?: string;
  heroId: number;
  teamId?: number;
  gameTimeS: number;
  timeBucket: number;
  itemIds: number[];
  inventoryStateKey: string;
  previousActionKeys: string[];
  alliedHeroIds: number[];
  enemyHeroIds: number[];
  inventoryTotalCost?: number;
  inventoryHighestTier?: number;
  playerNetWorth?: number;
  playerKills?: number;
  playerDeaths?: number;
  playerAssists?: number;
  teamNetWorthDelta?: number;
  teamRelativeNetWorthDelta?: number;
  playerNetWorthRankInTeam?: number;
  playerNetWorthShare?: number;
}

export interface RecommendationExperimentMetadata {
  source: 'BASELINE' | 'VALUE_V6_CANARY';
  candidateId?: string;
  modelVersion?: string;
  modelSha256?: string;
  fallbackReason?: string;
  topSeparation?: number;
  supportedCandidateCount?: number;
}

export type RecommendationValueV6LiveResponse =
  HeroBuildRecommendationResponse & {
    recommendationExperiment?: RecommendationExperimentMetadata;
  };

export interface RecommendationValueV6ModelStatus {
  state: RecommendationValueV6LiveModelState;
  candidateId?: string;
  modelVersion?: string;
  modelSha256?: string;
  loadedAt?: string;
  stateKeyCount: number;
  actionKeyCount: number;
  lastError?: string;
}

export interface RecommendationValueV6LiveStatus {
  mode: RecommendationValueV6LiveMode;
  rolloutScope: 'ALL_USERS';
  model: RecommendationValueV6ModelStatus;
  allowlistCount: 0;
  requestCount: number;
  shadowEvaluationCount: number;
  canaryResponseCount: number;
  baselineResponseCount: number;
  fallbackCount: number;
  unsupportedCount: number;
  modelErrorCount: number;
  lastFallbackReason?: string;
  lastModelError?: string;
}

export interface LoadedRecommendationValueV6Model {
  candidateId: string;
  modelVersion: typeof RECOMMENDATION_VALUE_V6_MODEL_VERSION;
  modelSha256: string;
  loadedAt: string;
  model: RecommendationValueV6Model;
  options: RecommendationValueV6ModelOptions;
  actionResidualScale: number;
}

interface RecommendationValueV6CandidateMetadata {
  itemId?: number;
  cost?: number;
  tier?: number;
  slotType?: string;
  isActiveItem?: boolean;
  tags?: string[];
  interactionKeys?: string[];
}

interface RecommendationValueV6CandidateScore {
  action: HeroBuildRecommendationAction;
  baselineRank: number;
  prediction: RecommendationValueV6Prediction;
  supported: boolean;
}

interface RecommendationValueV6Evaluation {
  response: RecommendationValueV6LiveResponse;
  metadata: RecommendationExperimentMetadata;
  candidateScores: RecommendationValueV6CandidateScore[];
  displayedActionKeys: string[];
  context: RecommendationValueV6LiveContext;
}

@Injectable()
export class RecommendationValueV6LiveService implements OnModuleInit {
  private readonly logger = new Logger(RecommendationValueV6LiveService.name);
  private readonly mode = readMode();
  private readonly minimumSeparation = readMinimumSeparation();
  private loaded?: LoadedRecommendationValueV6Model;
  private modelStatus: RecommendationValueV6ModelStatus = {
    state: this.mode === 'DISABLED' ? 'DISABLED' : 'FAILED',
    stateKeyCount: 0,
    actionKeyCount: 0,
  };
  private requestCount = 0;
  private shadowEvaluationCount = 0;
  private canaryResponseCount = 0;
  private baselineResponseCount = 0;
  private fallbackCount = 0;
  private unsupportedCount = 0;
  private modelErrorCount = 0;
  private lastFallbackReason?: string;
  private lastModelError?: string;

  constructor(
    @InjectRepository(Item)
    private readonly itemRepository: Repository<Item>,
    @Optional()
    private readonly telemetryService?: RecommendationValueV6TelemetryService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (this.mode === 'DISABLED') {
      return;
    }
    try {
      this.loaded = await loadRecommendationValueV6ModelFromEnvironment();
      this.modelStatus = {
        state: 'READY',
        candidateId: this.loaded.candidateId,
        modelVersion: this.loaded.modelVersion,
        modelSha256: this.loaded.modelSha256,
        loadedAt: this.loaded.loadedAt,
        stateKeyCount: this.loaded.model.state.size,
        actionKeyCount: this.loaded.model.action.size,
      };
      this.logger.log(
        `Recommendation Value V6 ${this.loaded.candidateId} loaded with SHA ${this.loaded.modelSha256}.`,
      );
    } catch (error) {
      const message = getErrorMessage(error);
      this.loaded = undefined;
      this.modelStatus = {
        state: 'FAILED',
        stateKeyCount: 0,
        actionKeyCount: 0,
        lastError: message,
      };
      this.lastModelError = message;
      this.modelErrorCount += 1;
      this.logger.error(`Recommendation Value V6 failed closed: ${message}`);
    }
  }

  getMode(): RecommendationValueV6LiveMode {
    return this.mode;
  }

  getStatus(): RecommendationValueV6LiveStatus {
    return {
      mode: this.mode,
      rolloutScope: 'ALL_USERS',
      model: { ...this.modelStatus },
      allowlistCount: 0,
      requestCount: this.requestCount,
      shadowEvaluationCount: this.shadowEvaluationCount,
      canaryResponseCount: this.canaryResponseCount,
      baselineResponseCount: this.baselineResponseCount,
      fallbackCount: this.fallbackCount,
      unsupportedCount: this.unsupportedCount,
      modelErrorCount: this.modelErrorCount,
      lastFallbackReason: this.lastFallbackReason,
      lastModelError: this.lastModelError,
    };
  }

  async apply(
    request: HeroBuildContextualRecommendationRequest,
    baseline: HeroBuildRecommendationResponse,
    resolvedContext?: RecommendationValueV6LiveContext,
  ): Promise<HeroBuildRecommendationResponse> {
    this.requestCount += 1;
    if (this.mode === 'DISABLED') {
      this.baselineResponseCount += 1;
      return baseline;
    }

    if (this.mode === 'SHADOW') {
      this.baselineResponseCount += 1;
      const shadowResponse = withExperimentMetadata(baseline, {
        source: 'BASELINE',
        candidateId: this.loaded?.candidateId,
        modelVersion: this.loaded?.modelVersion,
        modelSha256: this.loaded?.modelSha256,
        fallbackReason: 'SHADOW_ONLY',
      });
      void this.evaluateShadow(request, baseline, resolvedContext);
      return shadowResponse;
    }

    const startedAt = Date.now();
    try {
      const evaluation = await this.evaluate(
        request,
        baseline,
        resolvedContext,
      );
      if (evaluation.metadata.source === 'VALUE_V6_CANARY') {
        this.canaryResponseCount += 1;
      } else {
        this.baselineResponseCount += 1;
        this.recordFallback(
          evaluation.metadata.fallbackReason ?? 'UNSPECIFIED_FALLBACK',
        );
      }
      this.logEvaluation(
        baseline,
        evaluation,
        'CANARY',
        Date.now() - startedAt,
      );
      return evaluation.response;
    } catch (error) {
      const message = getErrorMessage(error);
      this.modelErrorCount += 1;
      this.lastModelError = message;
      this.baselineResponseCount += 1;
      this.recordFallback(`MODEL_ERROR:${message}`);
      const context = mergeLiveContext(request, resolvedContext, new Map());
      const evaluation = createFallbackEvaluation(
        baseline,
        this.loaded,
        'MODEL_ERROR',
        context,
      );
      this.logEvaluation(
        baseline,
        evaluation,
        'CANARY',
        Date.now() - startedAt,
      );
      this.logger.warn(
        `Recommendation Value V6 request failed and returned baseline: ${message}`,
      );
      return evaluation.response;
    }
  }

  private async evaluateShadow(
    request: HeroBuildContextualRecommendationRequest,
    baseline: HeroBuildRecommendationResponse,
    resolvedContext?: RecommendationValueV6LiveContext,
  ): Promise<void> {
    const startedAt = Date.now();
    try {
      const evaluation = await this.evaluate(
        request,
        baseline,
        resolvedContext,
      );
      this.shadowEvaluationCount += 1;
      if (evaluation.metadata.fallbackReason) {
        this.recordFallback(evaluation.metadata.fallbackReason);
      }
      this.logEvaluation(
        baseline,
        {
          ...evaluation,
          displayedActionKeys: actionKeys(baseline),
        },
        'SHADOW',
        Date.now() - startedAt,
      );
    } catch (error) {
      const message = getErrorMessage(error);
      this.modelErrorCount += 1;
      this.lastModelError = message;
      this.recordFallback(`MODEL_ERROR:${message}`);
      const context = mergeLiveContext(request, resolvedContext, new Map());
      this.logEvaluation(
        baseline,
        createFallbackEvaluation(
          baseline,
          this.loaded,
          'MODEL_ERROR',
          context,
        ),
        'SHADOW',
        Date.now() - startedAt,
      );
      this.logger.warn(`Recommendation Value V6 shadow failed: ${message}`);
    }
  }

  private async evaluate(
    request: HeroBuildContextualRecommendationRequest,
    baseline: HeroBuildRecommendationResponse,
    resolvedContext?: RecommendationValueV6LiveContext,
  ): Promise<RecommendationValueV6Evaluation> {
    const loaded = this.loaded;
    if (!loaded || this.modelStatus.state !== 'READY') {
      return createFallbackEvaluation(
        baseline,
        loaded,
        'MODEL_NOT_READY',
        mergeLiveContext(request, resolvedContext, new Map()),
      );
    }

    const candidates = deduplicateCandidates(baseline);
    if (candidates.length < 2) {
      this.unsupportedCount += 1;
      return createFallbackEvaluation(
        baseline,
        loaded,
        'INSUFFICIENT_BASELINE_CANDIDATES',
        mergeLiveContext(request, resolvedContext, new Map()),
        candidates.length,
      );
    }

    const itemIds = uniquePositiveIntegers([
      ...request.itemIds,
      ...candidates.map((candidate) => candidate.action.itemId),
    ]);
    const items = itemIds.length
      ? await this.itemRepository.find({ where: { itemId: In(itemIds) } })
      : [];
    const itemById = new Map(items.map((item) => [Number(item.itemId), item]));
    const context = mergeLiveContext(request, resolvedContext, itemById);
    const stateKeys = buildRecommendationValueV6StateKeys(context);
    const teamEconomyBand = resolveTeamEconomyBand(context);
    const scores = candidates.map((candidate) => {
      const metadata = buildCandidateMetadata(candidate.action, itemById);
      const actionKeysForCandidate = buildRecommendationValueV6ActionKeys({
        heroId: context.heroId,
        timeBucket: context.timeBucket,
        inventoryStateKey: context.inventoryStateKey,
        previousActionKeys: context.previousActionKeys,
        teamEconomyBand,
        actionKey: candidate.action.actionKey,
        slotType: metadata.slotType,
        tier: metadata.tier,
        cost: metadata.cost,
        isActiveItem: metadata.isActiveItem,
        tags: metadata.tags,
        interactionKeys: metadata.interactionKeys,
      });
      const prediction = predictRecommendationValueV6(
        loaded.model,
        { stateKeys, actionKeys: actionKeysForCandidate },
        loaded.options,
        loaded.actionResidualScale,
      );
      return {
        ...candidate,
        prediction,
        supported: prediction.supportedActionKeyCount >= 1,
      };
    });
    const supported = scores
      .filter((candidate) => candidate.supported)
      .sort(compareCandidateScores);

    if (supported.length < 2) {
      this.unsupportedCount += 1;
      return createFallbackEvaluation(
        baseline,
        loaded,
        'INSUFFICIENT_SUPPORTED_CANDIDATES',
        context,
        supported.length,
        scores,
      );
    }

    const topSeparation =
      supported[0].prediction.actionAdvantage -
      supported[1].prediction.actionAdvantage;
    if (topSeparation < this.minimumSeparation) {
      this.unsupportedCount += 1;
      return createFallbackEvaluation(
        baseline,
        loaded,
        'LOW_TOP_SEPARATION',
        context,
        supported.length,
        scores,
        topSeparation,
      );
    }

    const ranking = rerankSupportedCandidatesInBaselineSlots(scores, supported);
    const displayedActionKeys = ranking.map(
      (candidate) => candidate.action.actionKey,
    );
    const metadata: RecommendationExperimentMetadata = {
      source: 'VALUE_V6_CANARY',
      candidateId: loaded.candidateId,
      modelVersion: loaded.modelVersion,
      modelSha256: loaded.modelSha256,
      topSeparation,
      supportedCandidateCount: supported.length,
    };
    return {
      response: withExperimentMetadata(
        {
          ...baseline,
          action: ranking[0].action,
          alternatives: ranking.slice(1).map((candidate) => candidate.action),
        },
        metadata,
      ),
      metadata,
      candidateScores: scores,
      displayedActionKeys,
      context,
    };
  }

  private recordFallback(reason: string): void {
    this.fallbackCount += 1;
    this.lastFallbackReason = reason;
  }

  private logEvaluation(
    baseline: HeroBuildRecommendationResponse,
    evaluation: RecommendationValueV6Evaluation,
    mode: 'SHADOW' | 'CANARY',
    elapsedMs: number,
  ): void {
    const decisionId = randomUUID();
    const baselineRanking = actionKeys(baseline);
    const challengerRanking = [...evaluation.candidateScores]
      .filter((candidate) => candidate.supported)
      .sort(compareCandidateScores)
      .map((candidate) => candidate.action.actionKey);
    const baselineScores = baselineRanking.map(
      (actionKey, rank): RecommendationValueV6CandidateDecisionScore => ({
        actionKey,
        score: findAction(baseline, actionKey)?.score ?? 0,
        rank: rank + 1,
        supported:
          evaluation.candidateScores.find(
            (candidate) => candidate.action.actionKey === actionKey,
          )?.supported ?? false,
      }),
    );
    const challengerScores = evaluation.candidateScores.map(
      (candidate): RecommendationValueV6CandidateDecisionScore => ({
        actionKey: candidate.action.actionKey,
        score: candidate.prediction.actionAdvantage,
        rank: challengerRanking.indexOf(candidate.action.actionKey) + 1,
        supported: candidate.supported,
        actionUtility: candidate.prediction.actionUtility,
        actionAdvantage: candidate.prediction.actionAdvantage,
        supportedStateKeyCount:
          candidate.prediction.supportedStateKeyCount,
        supportedActionKeyCount:
          candidate.prediction.supportedActionKeyCount,
      }),
    );
    const log = {
      event: 'recommendation_value_v6_live_decision',
      decisionId,
      matchId: evaluation.context.matchId ?? 'UNRESOLVED',
      localIdentityReference: stableIdentityReference(
        evaluation.context.localSteamId,
      ),
      gameTimeSeconds: evaluation.context.gameTimeS,
      candidateSet: baselineRanking,
      baselineRanking,
      v6Ranking: challengerRanking,
      displayedRanking: evaluation.displayedActionKeys,
      modelVersion: this.loaded?.modelVersion,
      modelSha256: this.loaded?.modelSha256,
      candidateId: this.loaded?.candidateId,
      mode,
      supportCounts: challengerScores.map((candidate) => ({
        actionKey: candidate.actionKey,
        supportedStateKeyCount: candidate.supportedStateKeyCount,
        supportedActionKeyCount: candidate.supportedActionKeyCount,
      })),
      topSeparation: evaluation.metadata.topSeparation,
      fallbackReason: evaluation.metadata.fallbackReason,
      elapsedMs,
      dataSource: 'USER_LIVE',
      eligibleForProModelTraining: false,
    };
    this.logger.log(JSON.stringify(log));
    this.telemetryService?.recordEvaluation({
      decisionId,
      matchId: evaluation.context.matchId ?? 'UNRESOLVED',
      localSteamId: evaluation.context.localSteamId,
      gameTimeSeconds: evaluation.context.gameTimeS,
      candidateGeneratorVersion: CANDIDATE_GENERATOR_VERSION,
      catalogVersion: CATALOG_VERSION,
      stateFeatureVersion: STATE_FEATURE_VERSION,
      baselineModelVersion: BASELINE_MODEL_VERSION,
      challengerModelVersion: this.loaded?.modelVersion,
      challengerModelSha256: this.loaded?.modelSha256,
      candidateId: this.loaded?.candidateId,
      policyVersion: POLICY_VERSION,
      rolloutMode: mode,
      candidateActionKeys: baselineRanking,
      baselineScores,
      challengerScores,
      displayedActionKeys: evaluation.displayedActionKeys,
      topSeparation: evaluation.metadata.topSeparation,
      supportedCandidateCount: evaluation.metadata.supportedCandidateCount,
      fallbackReason: evaluation.metadata.fallbackReason,
      elapsedMs,
    });
  }
}

export async function loadRecommendationValueV6Model(
  modelDirectory: string,
  expectedModelSha256: string,
): Promise<LoadedRecommendationValueV6Model> {
  const normalizedExpectedSha = normalizeSha(expectedModelSha256);
  const [modelText, manifestText, auditText, promotionText] = await Promise.all([
    readFile(join(modelDirectory, 'model.json'), 'utf8'),
    readFile(join(modelDirectory, 'manifest.json'), 'utf8'),
    readFile(join(modelDirectory, 'audit.json'), 'utf8'),
    readFile(join(modelDirectory, 'promotion.json'), 'utf8'),
  ]);
  const actualSha = createHash('sha256').update(modelText).digest('hex');
  if (actualSha !== normalizedExpectedSha) {
    throw new Error(
      `Recommendation Value V6 model SHA mismatch: expected ${normalizedExpectedSha}, received ${actualSha}.`,
    );
  }

  const modelArtifact = parseRecord(modelText, 'model.json');
  const manifest = parseRecord(manifestText, 'manifest.json');
  const audit = parseRecord(auditText, 'audit.json');
  const promotion = parseRecord(promotionText, 'promotion.json');
  if (audit.passed !== true) {
    throw new Error('Recommendation Value V6 audit did not pass.');
  }
  if (
    modelArtifact.modelVersion !== RECOMMENDATION_VALUE_V6_MODEL_VERSION ||
    manifest.modelVersion !== RECOMMENDATION_VALUE_V6_MODEL_VERSION
  ) {
    throw new Error('Recommendation Value V6 model version is invalid.');
  }
  if (modelArtifact.modelKind !== EXPECTED_MODEL_KIND) {
    throw new Error('Recommendation Value V6 model kind is invalid.');
  }
  if (modelArtifact.actionResidualScale !== 1) {
    throw new Error('Recommendation Value V6 actionResidualScale must equal 1.');
  }
  const targetComposition = record(modelArtifact.targetComposition);
  if (
    targetComposition.finalOutcomeWeight !== 0 ||
    targetComposition.shortHorizonWeight !== 1 ||
    targetComposition.requireShortHorizonTarget !== true
  ) {
    throw new Error('Recommendation Value V6 target composition is invalid.');
  }
  if (normalizeSha(promotion.modelSha256) !== actualSha) {
    throw new Error('Recommendation Value V6 promotion SHA does not match model.json.');
  }
  if (
    promotion.usage !== EXPECTED_PROMOTION_USAGE ||
    promotion.productionRolloutAuthorized !== true ||
    promotion.rolloutScope !== 'ALL_USERS'
  ) {
    throw new Error('Recommendation Value V6 promotion does not authorize the global canary.');
  }
  const candidateId = requiredText(
    promotion.candidateId,
    'promotion candidateId',
  );
  const options = parseModelOptions(record(modelArtifact.options));
  const counts = record(modelArtifact.counts);
  if (counts.version !== RECOMMENDATION_VALUE_V6_MODEL_VERSION) {
    throw new Error('Recommendation Value V6 serialized counts version is invalid.');
  }
  const model: RecommendationValueV6Model = Object.freeze({
    version: RECOMMENDATION_VALUE_V6_MODEL_VERSION,
    global: freezeCount(record(counts.global), 'global'),
    state: deserializeCounts(record(counts.state), 'state'),
    action: deserializeCounts(record(counts.action), 'action'),
  });
  if (model.global.totalWeight <= 0) {
    throw new Error('Recommendation Value V6 global training weight is empty.');
  }

  return Object.freeze({
    candidateId,
    modelVersion: RECOMMENDATION_VALUE_V6_MODEL_VERSION,
    modelSha256: actualSha,
    loadedAt: new Date().toISOString(),
    model,
    options: Object.freeze({ ...options }),
    actionResidualScale: 1,
  });
}

function loadRecommendationValueV6ModelFromEnvironment(): Promise<LoadedRecommendationValueV6Model> {
  const modelDirectory = process.env[MODEL_DIR_ENV]?.trim();
  const expectedSha = process.env[EXPECTED_SHA_ENV]?.trim();
  if (!modelDirectory) {
    throw new Error(`${MODEL_DIR_ENV} is required.`);
  }
  if (!expectedSha) {
    throw new Error(`${EXPECTED_SHA_ENV} is required.`);
  }
  return loadRecommendationValueV6Model(modelDirectory, expectedSha);
}

function mergeLiveContext(
  request: HeroBuildContextualRecommendationRequest,
  resolvedContext: RecommendationValueV6LiveContext | undefined,
  itemById: ReadonlyMap<number, Item>,
): RecommendationValueV6LiveContext {
  const inventoryItems = request.itemIds
    .map((itemId) => itemById.get(itemId))
    .filter((item): item is Item => item !== undefined);
  const inventoryMetadataComplete =
    request.itemIds.length > 0 && inventoryItems.length === request.itemIds.length;
  return {
    matchId: resolvedContext?.matchId,
    localSteamId: resolvedContext?.localSteamId,
    heroId: request.heroId,
    teamId: resolvedContext?.teamId,
    gameTimeS: request.gameTimeS,
    timeBucket: Math.floor(request.gameTimeS / LIVE_TIME_BUCKET_SECONDS),
    itemIds: [...request.itemIds],
    inventoryStateKey: createInventoryStateKeyFromItemIds(request.itemIds),
    previousActionKeys: [...(request.previousActionKeys ?? [])],
    alliedHeroIds: [...(request.alliedHeroIds ?? resolvedContext?.alliedHeroIds ?? [])],
    enemyHeroIds: [...(request.enemyHeroIds ?? resolvedContext?.enemyHeroIds ?? [])],
    inventoryTotalCost:
      resolvedContext?.inventoryTotalCost ??
      (inventoryMetadataComplete
        ? inventoryItems.reduce((sum, item) => sum + item.cost, 0)
        : request.itemIds.length === 0
          ? 0
          : undefined),
    inventoryHighestTier:
      resolvedContext?.inventoryHighestTier ??
      (inventoryMetadataComplete
        ? inventoryItems.reduce(
            (highest, item) => Math.max(highest, item.itemTier),
            0,
          )
        : request.itemIds.length === 0
          ? 0
          : undefined),
    playerNetWorth: resolvedContext?.playerNetWorth,
    playerKills: resolvedContext?.playerKills,
    playerDeaths: resolvedContext?.playerDeaths,
    playerAssists: resolvedContext?.playerAssists,
    teamNetWorthDelta: resolvedContext?.teamNetWorthDelta,
    teamRelativeNetWorthDelta: resolvedContext?.teamRelativeNetWorthDelta,
    playerNetWorthRankInTeam: resolvedContext?.playerNetWorthRankInTeam,
    playerNetWorthShare: resolvedContext?.playerNetWorthShare,
  };
}

function buildCandidateMetadata(
  action: HeroBuildRecommendationAction,
  itemById: ReadonlyMap<number, Item>,
): RecommendationValueV6CandidateMetadata {
  const item = action.itemId ? itemById.get(action.itemId) : undefined;
  return {
    itemId: action.itemId,
    cost: item?.cost,
    tier: item?.itemTier,
    slotType: item?.itemSlotType,
  };
}

function resolveTeamEconomyBand(
  context: RecommendationValueV6LiveContext,
): RecommendationValueV6TeamEconomyBand | undefined {
  return context.teamRelativeNetWorthDelta === undefined
    ? undefined
    : classifyRecommendationValueV6TeamEconomy(
        context.teamRelativeNetWorthDelta,
      );
}

function deduplicateCandidates(
  baseline: HeroBuildRecommendationResponse,
): Array<{ action: HeroBuildRecommendationAction; baselineRank: number }> {
  const result: Array<{
    action: HeroBuildRecommendationAction;
    baselineRank: number;
  }> = [];
  const seen = new Set<string>();
  for (const [baselineRank, action] of [
    baseline.action,
    ...baseline.alternatives,
  ].entries()) {
    if (!seen.has(action.actionKey)) {
      seen.add(action.actionKey);
      result.push({ action, baselineRank });
    }
  }
  return result;
}

function compareCandidateScores(
  left: RecommendationValueV6CandidateScore,
  right: RecommendationValueV6CandidateScore,
): number {
  return (
    right.prediction.actionAdvantage - left.prediction.actionAdvantage ||
    left.baselineRank - right.baselineRank ||
    left.action.actionKey.localeCompare(right.action.actionKey)
  );
}

function rerankSupportedCandidatesInBaselineSlots(
  scores: readonly RecommendationValueV6CandidateScore[],
  supportedRanking: readonly RecommendationValueV6CandidateScore[],
): RecommendationValueV6CandidateScore[] {
  let supportedIndex = 0;
  return [...scores]
    .sort((left, right) => left.baselineRank - right.baselineRank)
    .map((candidate) => {
      if (!candidate.supported) {
        return candidate;
      }
      const replacement = supportedRanking[supportedIndex];
      supportedIndex += 1;
      return replacement;
    });
}

function createFallbackEvaluation(
  baseline: HeroBuildRecommendationResponse,
  loaded: LoadedRecommendationValueV6Model | undefined,
  fallbackReason: string,
  context: RecommendationValueV6LiveContext,
  supportedCandidateCount?: number,
  candidateScores: RecommendationValueV6CandidateScore[] = [],
  topSeparation?: number,
): RecommendationValueV6Evaluation {
  const metadata: RecommendationExperimentMetadata = {
    source: 'BASELINE',
    candidateId: loaded?.candidateId,
    modelVersion: loaded?.modelVersion,
    modelSha256: loaded?.modelSha256,
    fallbackReason,
    topSeparation,
    supportedCandidateCount,
  };
  return {
    response: withExperimentMetadata(baseline, metadata),
    metadata,
    candidateScores,
    displayedActionKeys: actionKeys(baseline),
    context,
  };
}

function withExperimentMetadata(
  response: HeroBuildRecommendationResponse,
  metadata: RecommendationExperimentMetadata,
): RecommendationValueV6LiveResponse {
  return {
    ...response,
    recommendationExperiment: metadata,
  };
}

function actionKeys(response: HeroBuildRecommendationResponse): string[] {
  return [
    response.action.actionKey,
    ...response.alternatives.map((action) => action.actionKey),
  ];
}

function findAction(
  response: HeroBuildRecommendationResponse,
  actionKey: string,
): HeroBuildRecommendationAction | undefined {
  return [response.action, ...response.alternatives].find(
    (action) => action.actionKey === actionKey,
  );
}

function deserializeCounts(
  value: Record<string, unknown>,
  label: string,
): Map<string, RecommendationValueV6Count> {
  const result = new Map<string, RecommendationValueV6Count>();
  for (const [key, count] of Object.entries(value)) {
    if (!key) {
      throw new Error(`Recommendation Value V6 ${label} key is empty.`);
    }
    result.set(key, freezeCount(record(count), `${label}:${key}`));
  }
  return result;
}

function freezeCount(
  value: Record<string, unknown>,
  label: string,
): RecommendationValueV6Count {
  const count: RecommendationValueV6Count = {
    utilitySum: requiredFinite(value.utilitySum, `${label}.utilitySum`),
    utilitySquaredSum: requiredFinite(
      value.utilitySquaredSum,
      `${label}.utilitySquaredSum`,
    ),
    winWeight: requiredFinite(value.winWeight, `${label}.winWeight`),
    totalWeight: requiredFinite(value.totalWeight, `${label}.totalWeight`),
    observations: requiredNonNegativeInteger(
      value.observations,
      `${label}.observations`,
    ),
  };
  return Object.freeze(count);
}

function parseModelOptions(
  value: Record<string, unknown>,
): RecommendationValueV6ModelOptions {
  return {
    statePriorStrength: requiredNonNegativeFinite(
      value.statePriorStrength,
      'statePriorStrength',
    ),
    actionPriorStrength: requiredNonNegativeFinite(
      value.actionPriorStrength,
      'actionPriorStrength',
    ),
    minimumObservations: requiredPositiveInteger(
      value.minimumObservations,
      'minimumObservations',
    ),
    maximumAbsoluteStateResidual: requiredPositiveFinite(
      value.maximumAbsoluteStateResidual,
      'maximumAbsoluteStateResidual',
    ),
    maximumAbsoluteActionResidual: requiredPositiveFinite(
      value.maximumAbsoluteActionResidual,
      'maximumAbsoluteActionResidual',
    ),
  };
}

function parseRecord(text: string, label: string): Record<string, unknown> {
  try {
    return record(JSON.parse(text));
  } catch (error) {
    throw new Error(`${label} is invalid JSON: ${getErrorMessage(error)}`);
  }
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} is required.`);
  }
  return value.trim();
}

function normalizeSha(value: unknown): string {
  const sha = requiredText(value, 'SHA-256').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sha)) {
    throw new Error('SHA-256 must be a 64-character hexadecimal value.');
  }
  return sha;
}

function requiredFinite(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${label} must be finite.`);
  }
  return value;
}

function requiredNonNegativeFinite(value: unknown, label: string): number {
  const result = requiredFinite(value, label);
  if (result < 0) {
    throw new Error(`${label} must be non-negative.`);
  }
  return result;
}

function requiredPositiveFinite(value: unknown, label: string): number {
  const result = requiredFinite(value, label);
  if (result <= 0) {
    throw new Error(`${label} must be positive.`);
  }
  return result;
}

function requiredPositiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new Error(`${label} must be a positive safe integer.`);
  }
  return Number(value);
}

function requiredNonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`${label} must be a non-negative safe integer.`);
  }
  return Number(value);
}

function uniquePositiveIntegers(
  values: readonly (number | undefined)[],
): number[] {
  return [...new Set(
    values.filter(
      (value): value is number =>
        Number.isSafeInteger(value) && Number(value) > 0,
    ),
  )].sort((left, right) => left - right);
}

function readMode(): RecommendationValueV6LiveMode {
  const value = process.env[MODE_ENV]?.trim().toUpperCase();
  if (value === 'SHADOW' || value === 'CANARY') {
    return value;
  }
  return 'DISABLED';
}

function readMinimumSeparation(): number {
  const value = Number(process.env[MIN_SEPARATION_ENV]);
  return Number.isFinite(value) && value >= 0
    ? value
    : DEFAULT_MIN_SEPARATION;
}

function stableIdentityReference(steamId: string | undefined): string {
  if (!steamId) {
    return 'UNRESOLVED';
  }
  return createHash('sha256').update(steamId).digest('hex').slice(0, 24);
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
