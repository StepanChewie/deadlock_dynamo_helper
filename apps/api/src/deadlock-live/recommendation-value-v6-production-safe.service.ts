import { Injectable, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
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
  RecommendationValueV6LiveService,
  type LoadedRecommendationValueV6Model,
  type RecommendationExperimentMetadata,
  type RecommendationValueV6LiveContext,
  type RecommendationValueV6LiveResponse,
} from './recommendation-value-v6-live.service';
import {
  predictRecommendationValueV6,
  type RecommendationValueV6Prediction,
} from './recommendation-value-v6-model';
import { RecommendationValueV6TelemetryService } from './recommendation-value-v6-telemetry.service';

const LIVE_TIME_BUCKET_SECONDS = 120;

export type RecommendationValueV6SupportType =
  | 'DIRECT_ACTION'
  | 'GENERIC_ONLY'
  | 'UNSUPPORTED';

export interface RecommendationValueV6PresentedDiagnostics {
  rankingModel: 'RECOMMENDATION_VALUE_V6';
  baselineRank: number;
  modelRank?: number;
  actionUtility: number;
  actionAdvantage: number;
  directSupportedActionKeyCount: number;
  totalSupportedActionKeyCount: number;
  supportType: RecommendationValueV6SupportType;
}

interface CandidateMetadata {
  cost?: number;
  tier?: number;
  slotType?: string;
}

interface CandidateScore {
  action: HeroBuildRecommendationAction;
  baselineRank: number;
  prediction: RecommendationValueV6Prediction;
  supported: boolean;
  directSupportedActionKeyCount: number;
  supportType: RecommendationValueV6SupportType;
}

interface Evaluation {
  response: RecommendationValueV6LiveResponse;
  metadata: RecommendationExperimentMetadata;
  candidateScores: CandidateScore[];
  displayedActionKeys: string[];
  context: RecommendationValueV6LiveContext;
}

interface LiveServiceInternals {
  loaded?: LoadedRecommendationValueV6Model;
  minimumSeparation: number;
  requestCount: number;
  canaryResponseCount: number;
  baselineResponseCount: number;
  unsupportedCount: number;
  modelErrorCount: number;
  lastModelError?: string;
  recordFallback: (reason: string) => void;
  logEvaluation: (
    baseline: HeroBuildRecommendationResponse,
    evaluation: Evaluation,
    mode: 'SHADOW' | 'CANARY',
    elapsedMs: number,
  ) => void;
}

@Injectable()
export class RecommendationValueV6ProductionSafeService extends RecommendationValueV6LiveService {
  constructor(
    @InjectRepository(Item)
    private readonly productionItemRepository: Repository<Item>,
    @Optional()
    telemetryService?: RecommendationValueV6TelemetryService,
  ) {
    super(productionItemRepository, telemetryService);
  }

  override async apply(
    request: HeroBuildContextualRecommendationRequest,
    baseline: HeroBuildRecommendationResponse,
    resolvedContext?: RecommendationValueV6LiveContext,
  ): Promise<HeroBuildRecommendationResponse> {
    if (this.getMode() !== 'CANARY') {
      return super.apply(request, baseline, resolvedContext);
    }

    const internals = this as unknown as LiveServiceInternals;
    internals.requestCount += 1;
    const startedAt = Date.now();

    try {
      const evaluation = await this.evaluateProductionSafe(
        request,
        baseline,
        resolvedContext,
      );
      if (evaluation.metadata.source === 'VALUE_V6_CANARY') {
        internals.canaryResponseCount += 1;
      } else {
        internals.baselineResponseCount += 1;
        internals.recordFallback(
          evaluation.metadata.fallbackReason ?? 'UNSPECIFIED_FALLBACK',
        );
      }
      internals.logEvaluation(
        baseline,
        evaluation,
        'CANARY',
        Date.now() - startedAt,
      );
      return evaluation.response;
    } catch (error) {
      const message = errorMessage(error);
      internals.modelErrorCount += 1;
      internals.lastModelError = message;
      internals.baselineResponseCount += 1;
      internals.recordFallback(`MODEL_ERROR:${message}`);
      const context = mergeLiveContext(request, resolvedContext, new Map());
      const evaluation = fallbackEvaluation(
        baseline,
        internals.loaded,
        'MODEL_ERROR',
        context,
      );
      internals.logEvaluation(
        baseline,
        evaluation,
        'CANARY',
        Date.now() - startedAt,
      );
      return evaluation.response;
    }
  }

  private async evaluateProductionSafe(
    request: HeroBuildContextualRecommendationRequest,
    baseline: HeroBuildRecommendationResponse,
    resolvedContext?: RecommendationValueV6LiveContext,
  ): Promise<Evaluation> {
    const internals = this as unknown as LiveServiceInternals;
    const loaded = internals.loaded;
    if (!loaded || this.getStatus().model.state !== 'READY') {
      return fallbackEvaluation(
        baseline,
        loaded,
        'MODEL_NOT_READY',
        mergeLiveContext(request, resolvedContext, new Map()),
      );
    }

    const candidates = deduplicateCandidates(baseline);
    if (candidates.length < 2) {
      internals.unsupportedCount += 1;
      return fallbackEvaluation(
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
      ? await this.productionItemRepository.find({
          where: { itemId: In(itemIds) },
        })
      : [];
    const itemById = new Map(items.map((item) => [Number(item.itemId), item]));
    const context = mergeLiveContext(request, resolvedContext, itemById);
    const stateKeys = buildRecommendationValueV6StateKeys(context);
    const teamEconomyBand = resolveTeamEconomyBand(context);

    const scores = candidates.map((candidate): CandidateScore => {
      const metadata = candidateMetadata(candidate.action, itemById);
      const actionKeys = buildRecommendationValueV6ActionKeys({
        heroId: context.heroId,
        timeBucket: context.timeBucket,
        inventoryStateKey: context.inventoryStateKey,
        previousActionKeys: context.previousActionKeys,
        teamEconomyBand,
        actionKey: candidate.action.actionKey,
        slotType: metadata.slotType,
        tier: metadata.tier,
        cost: metadata.cost,
      });
      const prediction = predictRecommendationValueV6(
        loaded.model,
        { stateKeys, actionKeys },
        loaded.options,
        loaded.actionResidualScale,
      );
      const directSupportedActionKeyCount =
        countRecommendationValueV6DirectActionSupport(
          loaded,
          actionKeys,
        );
      const supportType = recommendationValueV6SupportType(
        directSupportedActionKeyCount,
        prediction.supportedActionKeyCount,
      );
      return {
        ...candidate,
        prediction,
        supported: directSupportedActionKeyCount > 0,
        directSupportedActionKeyCount,
        supportType,
      };
    });

    const supported = scores
      .filter((candidate) => candidate.supported)
      .sort(compareCandidateScores);

    if (supported.length < 2) {
      internals.unsupportedCount += 1;
      return fallbackEvaluation(
        baseline,
        loaded,
        'INSUFFICIENT_DIRECTLY_SUPPORTED_CANDIDATES',
        context,
        supported.length,
        scores,
      );
    }

    const topSeparation =
      supported[0].prediction.actionAdvantage -
      supported[1].prediction.actionAdvantage;
    if (topSeparation < internals.minimumSeparation) {
      internals.unsupportedCount += 1;
      return fallbackEvaluation(
        baseline,
        loaded,
        'LOW_TOP_SEPARATION',
        context,
        supported.length,
        scores,
        topSeparation,
      );
    }

    const unsupported = scores
      .filter((candidate) => !candidate.supported)
      .sort((left, right) => left.baselineRank - right.baselineRank);
    const ranking = [...supported, ...unsupported];
    const decorated = ranking.map((candidate, modelRank) =>
      decorateAction(candidate, modelRank + 1),
    );
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
      response: {
        ...baseline,
        action: decorated[0],
        alternatives: decorated.slice(1),
        recommendationExperiment: metadata,
        rankingMode: 'VALUE_V6',
        rankingSource: 'RECOMMENDATION_VALUE_V6',
        valueV6DirectSupportedCandidateCount: supported.length,
      } as RecommendationValueV6LiveResponse,
      metadata,
      candidateScores: scores,
      displayedActionKeys,
      context,
    };
  }
}

export function isRecommendationValueV6DirectActionKey(key: string): boolean {
  return (
    key.startsWith('HERO_TIME_ACTION:') ||
    key.startsWith('HERO_TIME_INVENTORY_ACTION:') ||
    key.startsWith('HERO_TIME_PREVIOUS_ACTION:') ||
    key.startsWith('HERO_TEAM_ECONOMY_ACTION:')
  );
}

export function countRecommendationValueV6DirectActionSupport(
  loaded: LoadedRecommendationValueV6Model,
  actionKeys: readonly string[],
): number {
  return [...new Set(actionKeys)]
    .filter(isRecommendationValueV6DirectActionKey)
    .filter((key) => {
      const count = loaded.model.action.get(key);
      return (
        count !== undefined &&
        count.observations >= loaded.options.minimumObservations
      );
    }).length;
}

export function recommendationValueV6SupportType(
  directSupportedActionKeyCount: number,
  totalSupportedActionKeyCount: number,
): RecommendationValueV6SupportType {
  if (directSupportedActionKeyCount > 0) {
    return 'DIRECT_ACTION';
  }
  if (totalSupportedActionKeyCount > 0) {
    return 'GENERIC_ONLY';
  }
  return 'UNSUPPORTED';
}

function decorateAction(
  candidate: CandidateScore,
  modelRank: number,
): HeroBuildRecommendationAction & {
  valueV6: RecommendationValueV6PresentedDiagnostics;
  confidenceSemantic: 'CANDIDATE_GENERATOR_EVIDENCE';
} {
  return {
    ...candidate.action,
    confidenceSemantic: 'CANDIDATE_GENERATOR_EVIDENCE',
    valueV6: {
      rankingModel: 'RECOMMENDATION_VALUE_V6',
      baselineRank: candidate.baselineRank + 1,
      modelRank,
      actionUtility: candidate.prediction.actionUtility,
      actionAdvantage: candidate.prediction.actionAdvantage,
      directSupportedActionKeyCount:
        candidate.directSupportedActionKeyCount,
      totalSupportedActionKeyCount:
        candidate.prediction.supportedActionKeyCount,
      supportType: candidate.supportType,
    },
  };
}

function fallbackEvaluation(
  baseline: HeroBuildRecommendationResponse,
  loaded: LoadedRecommendationValueV6Model | undefined,
  fallbackReason: string,
  context: RecommendationValueV6LiveContext,
  supportedCandidateCount?: number,
  candidateScores: CandidateScore[] = [],
  topSeparation?: number,
): Evaluation {
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
    response: {
      ...baseline,
      recommendationExperiment: metadata,
    },
    metadata,
    candidateScores,
    displayedActionKeys: actionKeys(baseline),
    context,
  };
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
    request.itemIds.length > 0 &&
    inventoryItems.length === request.itemIds.length;

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
    alliedHeroIds: [
      ...(request.alliedHeroIds ?? resolvedContext?.alliedHeroIds ?? []),
    ],
    enemyHeroIds: [
      ...(request.enemyHeroIds ?? resolvedContext?.enemyHeroIds ?? []),
    ],
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

function candidateMetadata(
  action: HeroBuildRecommendationAction,
  itemById: ReadonlyMap<number, Item>,
): CandidateMetadata {
  const item = action.itemId ? itemById.get(action.itemId) : undefined;
  return {
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
  left: CandidateScore,
  right: CandidateScore,
): number {
  return (
    right.prediction.actionAdvantage - left.prediction.actionAdvantage ||
    left.baselineRank - right.baselineRank ||
    left.action.actionKey.localeCompare(right.action.actionKey)
  );
}

function actionKeys(response: HeroBuildRecommendationResponse): string[] {
  return [
    response.action.actionKey,
    ...response.alternatives.map((action) => action.actionKey),
  ];
}

function uniquePositiveIntegers(
  values: readonly (number | undefined)[],
): number[] {
  return [
    ...new Set(
      values.filter(
        (value): value is number =>
          Number.isSafeInteger(value) && Number(value) > 0,
      ),
    ),
  ].sort((left, right) => left - right);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
