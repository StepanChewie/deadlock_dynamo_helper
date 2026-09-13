import { Injectable, Logger, Optional, ServiceUnavailableException } from '@nestjs/common';
import type {
  MinimalMatchState,
  MinimalPlayerState,
} from '@deadlock-live-probe/shared';
import type { HeroBuildContextualRecommendationRequest } from './contextual-hero-build-recommendation.service';
import {
  ContextualV3LiveRecommendationResponse,
  ContextualV3LiveStatus,
  HeroBuildContextualV3LiveService,
} from './hero-build-contextual-v3-live.service';
import {
  canonicalHeroId,
  resolveRecommendationValueV6HeroId,
} from './hero-id-aliases';
import {
  HeroBuildRecommendationResponse,
  HeroBuildRecommendationService,
} from './hero-build-recommendation.service';
import {
  createInventoryStateKeyFromItemIds,
  HeroBuildTransitionAggregationService,
} from './hero-build-transition-aggregation.service';
import { LiveMatchStateService } from './live-match-state.service';
import { RecipeAwareTimelineReconciliationService } from './recipe-aware-timeline-reconciliation.service';
import {
  RecommendationValueV6LiveService,
  type RecommendationValueV6LiveContext,
  type RecommendationValueV6LiveResponse,
} from './recommendation-value-v6-live.service';

const MODE_ENV = 'DEADLOCK_CONTEXTUAL_V3_LIVE_MODE';
const SHADOW_SAMPLE_RATE_ENV = 'DEADLOCK_CONTEXTUAL_V3_SHADOW_SAMPLE_RATE';
const SHADOW_MAX_IN_FLIGHT_ENV = 'DEADLOCK_CONTEXTUAL_V3_SHADOW_MAX_IN_FLIGHT';
const DEFAULT_SHADOW_SAMPLE_RATE = 1;
const DEFAULT_SHADOW_MAX_IN_FLIGHT = 2;
const VALUE_V6_TIME_BUCKET_SECONDS = 120;

export type ContextualV3LiveMode = 'BASELINE' | 'SHADOW' | 'PRODUCTION';

export interface ContextualV3ProductionStatus {
  mode: ContextualV3LiveMode;
  model: ContextualV3LiveStatus;
  requestCount: number;
  contextualResponseCount: number;
  baselineResponseCount: number;
  fallbackCount: number;
  modelOnly: boolean;
  fallbackEnabled: boolean;
  modelErrorCount: number;
  shadowScheduledCount: number;
  shadowCompletedCount: number;
  shadowInFlight: number;
  lastFallbackAt?: string;
  lastFallbackError?: string;
  lastModelErrorAt?: string;
  lastModelError?: string;
}

interface ContextualV3ShadowLog {
  event: 'hero_build_contextual_v3_shadow';
  heroId: number;
  canonicalHeroId: number;
  gameTimeS: number;
  alliedHeroIds: number[];
  enemyHeroIds: number[];
  previousActionCount: number;
  modelVersion: string;
  modelSha256: string;
  buildArchetypeId: string;
  baselineTopActionKey: string;
  contextualTopActionKey: string;
  baselineTop3ActionKeys: string[];
  contextualTop3ActionKeys: string[];
  changedTop1: boolean;
  changedTop3: boolean;
  elapsedMs: number;
}

@Injectable()
export class ProductionHeroBuildRecommendationService extends HeroBuildRecommendationService {
  private readonly logger = new Logger(
    ProductionHeroBuildRecommendationService.name,
  );
  private readonly mode = readMode();
  private readonly shadowSampleRate = readBoundedNumberEnvironmentValue(
    SHADOW_SAMPLE_RATE_ENV,
    DEFAULT_SHADOW_SAMPLE_RATE,
    0,
    1,
  );
  private readonly shadowMaxInFlight = readBoundedIntegerEnvironmentValue(
    SHADOW_MAX_IN_FLIGHT_ENV,
    DEFAULT_SHADOW_MAX_IN_FLIGHT,
    1,
    32,
  );

  private requestCount = 0;
  private contextualResponseCount = 0;
  private baselineResponseCount = 0;
  private fallbackCount = 0;
  private modelErrorCount = 0;
  private shadowScheduledCount = 0;
  private shadowCompletedCount = 0;
  private shadowInFlight = 0;
  private lastFallbackAt?: string;
  private lastFallbackError?: string;
  private lastModelErrorAt?: string;
  private lastModelError?: string;

  constructor(
    heroBuildTransitionAggregationService: HeroBuildTransitionAggregationService,
    recipeAwareTimelineReconciliationService: RecipeAwareTimelineReconciliationService,
    private readonly contextualV3LiveService: HeroBuildContextualV3LiveService,
    @Optional()
    private readonly recommendationValueV6LiveService?: RecommendationValueV6LiveService,
    @Optional()
    private readonly liveMatchStateService?: LiveMatchStateService,
  ) {
    super(
      heroBuildTransitionAggregationService,
      recipeAwareTimelineReconciliationService,
    );
  }

  getStatus(): ContextualV3ProductionStatus {
    return {
      mode: this.mode,
      model: this.contextualV3LiveService.getStatus(),
      requestCount: this.requestCount,
      contextualResponseCount: this.contextualResponseCount,
      baselineResponseCount: this.baselineResponseCount,
      fallbackCount: this.fallbackCount,
      modelOnly: this.mode === 'PRODUCTION',
      fallbackEnabled: this.mode !== 'PRODUCTION',
      modelErrorCount: this.modelErrorCount,
      shadowScheduledCount: this.shadowScheduledCount,
      shadowCompletedCount: this.shadowCompletedCount,
      shadowInFlight: this.shadowInFlight,
      lastFallbackAt: this.lastFallbackAt,
      lastFallbackError: this.lastFallbackError,
      lastModelErrorAt: this.lastModelErrorAt,
      lastModelError: this.lastModelError,
    };
  }

  override async recommend(
    request: HeroBuildContextualRecommendationRequest,
  ): Promise<HeroBuildRecommendationResponse> {
    this.requestCount += 1;
    const requestedHeroId = request.heroId;
    const canonicalRequest = createCanonicalRequest(request);
    const valueV6Request = createRecommendationValueV6Request(
      canonicalRequest,
    );
    const canonicalCandidates = await super.recommend(canonicalRequest);
    const candidates: HeroBuildRecommendationResponse = {
      ...canonicalCandidates,
      heroId: requestedHeroId,
    };

    if (!this.recommendationValueV6LiveService) {
      throw new ServiceUnavailableException(
        'Recommendation Value V6 service is unavailable.',
      );
    }
    if (this.recommendationValueV6LiveService.getMode() !== 'CANARY') {
      throw new ServiceUnavailableException(
        'Recommendation Value V6 must be enabled in CANARY mode for exclusive production ranking.',
      );
    }

    const valueV6Context =
      this.resolveRecommendationValueV6LiveContext(valueV6Request);
    const response = await this.recommendationValueV6LiveService.apply(
      valueV6Request,
      candidates,
      valueV6Context,
    );
    const experiment = (response as RecommendationValueV6LiveResponse)
      .recommendationExperiment;

    if (
      experiment?.source !== 'VALUE_V6_CANARY' ||
      !experiment.candidateId ||
      !experiment.modelVersion ||
      !experiment.modelSha256
    ) {
      const reason = experiment?.fallbackReason ?? 'V6_RANKING_UNAVAILABLE';
      this.modelErrorCount += 1;
      this.lastModelErrorAt = new Date().toISOString();
      this.lastModelError = reason;
      throw new ServiceUnavailableException(
        `Recommendation Value V6 did not produce an exclusive ranking: ${reason}.`,
      );
    }

    const exclusiveResponse: HeroBuildRecommendationResponse & {
      recommendationModel: 'RECOMMENDATION_VALUE_V6';
      modelVersion: string;
      modelSha256: string;
      candidateId: string;
      rolloutMode: 'PRODUCTION';
    } = {
      ...response,
      recommendationModel: 'RECOMMENDATION_VALUE_V6',
      modelVersion: experiment.modelVersion,
      modelSha256: experiment.modelSha256,
      candidateId: experiment.candidateId,
      rolloutMode: 'PRODUCTION',
    };
    return exclusiveResponse;
  }

  private async recommendCurrentProduction(
    canonicalRequest: HeroBuildContextualRecommendationRequest,
    requestedHeroId: number,
  ): Promise<HeroBuildRecommendationResponse> {
    if (this.mode === 'PRODUCTION') {
      try {
        const contextual = this.contextualV3LiveService.recommend(canonicalRequest);
        this.contextualResponseCount += 1;
        return {
          ...contextual,
          heroId: requestedHeroId,
        };
      } catch (error) {
        this.recordModelError(error);
        throw error;
      }
    }

    const canonicalBaseline = await super.recommend(canonicalRequest);
    const baseline: HeroBuildRecommendationResponse = {
      ...canonicalBaseline,
      heroId: requestedHeroId,
    };

    if (this.mode === 'BASELINE') {
      this.baselineResponseCount += 1;
      return baseline;
    }

    this.baselineResponseCount += 1;
    this.scheduleContextualShadow(
      canonicalRequest,
      requestedHeroId,
      baseline,
    );
    return baseline;
  }

  private resolveRecommendationValueV6LiveContext(
    request: HeroBuildContextualRecommendationRequest,
  ): RecommendationValueV6LiveContext {
    if (!this.liveMatchStateService) {
      return createRequestOnlyRecommendationValueV6Context(request);
    }
    const requestedHeroId = canonicalHeroId(request.heroId);
    const states = this.liveMatchStateService
      .getAllStates()
      .sort(
        (left, right) =>
          Date.parse(right.lastUpdatedAt) - Date.parse(left.lastUpdatedAt),
      );

    for (const state of states) {
      const localEntry = Object.entries(state.playersBySteamId).find(
        ([, player]) =>
          player.isLocal === true &&
          Number.isSafeInteger(player.heroId) &&
          canonicalHeroId(Number(player.heroId)) === requestedHeroId,
      );
      if (!localEntry) {
        continue;
      }
      const [steamId, localPlayer] = localEntry;
      return createRecommendationValueV6LiveContext(
        request,
        state,
        localPlayer,
        steamId,
      );
    }

    return createRequestOnlyRecommendationValueV6Context(request);
  }

  private scheduleContextualShadow(
    request: HeroBuildContextualRecommendationRequest,
    requestedHeroId: number,
    baseline: HeroBuildRecommendationResponse,
  ): void {
    if (
      this.shadowSampleRate <= 0 ||
      this.shadowInFlight >= this.shadowMaxInFlight ||
      Math.random() >= this.shadowSampleRate
    ) {
      return;
    }

    this.shadowInFlight += 1;
    this.shadowScheduledCount += 1;
    const startedAt = Date.now();
    void Promise.resolve()
      .then(() => this.contextualV3LiveService.recommend(request, baseline))
      .then((contextual) => {
        this.shadowCompletedCount += 1;
        const log = createContextualV3ShadowLog(
          request,
          requestedHeroId,
          baseline,
          contextual,
          Date.now() - startedAt,
        );
        if (log.changedTop1 || log.changedTop3) {
          this.logger.log(JSON.stringify(log));
        }
      })
      .catch((error: unknown) => {
        this.recordFallback(error);
        this.logger.warn(
          `Contextual V3 shadow evaluation failed: ${getErrorMessage(error)}`,
        );
      })
      .finally(() => {
        this.shadowInFlight -= 1;
      });
  }

  private recordFallback(error: unknown): void {
    const message = getErrorMessage(error);
    this.fallbackCount += 1;
    this.lastFallbackAt = new Date().toISOString();
    this.lastFallbackError = message;
    this.logger.warn(`Contextual V3 shadow evaluation failed: ${message}`);
  }

  private recordModelError(error: unknown): void {
    const message = getErrorMessage(error);
    this.modelErrorCount += 1;
    this.lastModelErrorAt = new Date().toISOString();
    this.lastModelError = message;
    this.logger.error(`Contextual V3 model-only request failed: ${message}`);
  }
}

function createRecommendationValueV6LiveContext(
  request: HeroBuildContextualRecommendationRequest,
  state: MinimalMatchState,
  localPlayer: MinimalPlayerState,
  localSteamId: string,
): RecommendationValueV6LiveContext {
  const teamId = normalizeTeamId(localPlayer.teamId);
  const players = Object.values(state.playersBySteamId);
  const alliedHeroIds = teamId === undefined
    ? [...(request.alliedHeroIds ?? [])]
    : uniquePositiveIntegers(
        players
          .filter(
            (player) =>
              player.steamId !== localPlayer.steamId &&
              player.teamId === teamId,
          )
          .map((player) => player.heroId),
      );
  const enemyHeroIds = teamId === undefined
    ? [...(request.enemyHeroIds ?? [])]
    : uniquePositiveIntegers(
        players
          .filter(
            (player) =>
              player.teamId !== undefined && player.teamId !== teamId,
          )
          .map((player) => player.heroId),
      );
  const ownTeamPlayers = teamId === undefined
    ? []
    : players.filter((player) => player.teamId === teamId);
  const enemyTeamPlayers = teamId === undefined
    ? []
    : players.filter(
        (player) =>
          player.teamId !== undefined && player.teamId !== teamId,
      );
  const ownTeamNetWorth = sumAvailableSouls(ownTeamPlayers);
  const enemyTeamNetWorth = sumAvailableSouls(enemyTeamPlayers);
  const teamEconomyAvailable =
    ownTeamNetWorth !== undefined && enemyTeamNetWorth !== undefined;
  const teamNetWorthDelta = teamEconomyAvailable
    ? ownTeamNetWorth - enemyTeamNetWorth
    : undefined;
  const combinedNetWorth = teamEconomyAvailable
    ? ownTeamNetWorth + enemyTeamNetWorth
    : 0;
  const playerNetWorth = finiteNumber(localPlayer.souls);
  const rankedOwnTeam = ownTeamPlayers
    .filter((player) => finiteNumber(player.souls) !== undefined)
    .sort(
      (left, right) =>
        Number(right.souls) - Number(left.souls) ||
        Number(left.heroId ?? 0) - Number(right.heroId ?? 0) ||
        left.steamId.localeCompare(right.steamId),
    );
  const playerRank = rankedOwnTeam.findIndex(
    (player) => player.steamId === localPlayer.steamId,
  );

  return {
    matchId: state.matchId,
    localSteamId: localPlayer.steamId || localSteamId,
    heroId: request.heroId,
    teamId,
    gameTimeS: request.gameTimeS,
    timeBucket: Math.floor(
      request.gameTimeS / VALUE_V6_TIME_BUCKET_SECONDS,
    ),
    itemIds: [...request.itemIds],
    inventoryStateKey: createInventoryStateKeyFromItemIds(request.itemIds),
    previousActionKeys: [...(request.previousActionKeys ?? [])],
    alliedHeroIds,
    enemyHeroIds,
    playerNetWorth,
    playerKills: finiteNumber(localPlayer.kills),
    playerDeaths: finiteNumber(localPlayer.deaths),
    playerAssists: finiteNumber(localPlayer.assists),
    teamNetWorthDelta,
    teamRelativeNetWorthDelta:
      teamNetWorthDelta !== undefined && combinedNetWorth > 0
        ? teamNetWorthDelta / combinedNetWorth
        : undefined,
    playerNetWorthRankInTeam: playerRank >= 0 ? playerRank + 1 : undefined,
    playerNetWorthShare:
      playerNetWorth !== undefined &&
      ownTeamNetWorth !== undefined &&
      ownTeamNetWorth > 0
        ? playerNetWorth / ownTeamNetWorth
        : undefined,
  };
}

function createRequestOnlyRecommendationValueV6Context(
  request: HeroBuildContextualRecommendationRequest,
): RecommendationValueV6LiveContext {
  return {
    heroId: request.heroId,
    gameTimeS: request.gameTimeS,
    timeBucket: Math.floor(
      request.gameTimeS / VALUE_V6_TIME_BUCKET_SECONDS,
    ),
    itemIds: [...request.itemIds],
    inventoryStateKey: createInventoryStateKeyFromItemIds(request.itemIds),
    previousActionKeys: [...(request.previousActionKeys ?? [])],
    alliedHeroIds: [...(request.alliedHeroIds ?? [])],
    enemyHeroIds: [...(request.enemyHeroIds ?? [])],
  };
}

function sumAvailableSouls(
  players: readonly MinimalPlayerState[],
): number | undefined {
  if (players.length === 0) {
    return undefined;
  }
  let total = 0;
  for (const player of players) {
    const value = finiteNumber(player.souls);
    if (value === undefined) {
      return undefined;
    }
    total += value;
  }
  return total;
}

function finiteNumber(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function normalizeTeamId(value: number | undefined): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= 0
    ? Number(value)
    : undefined;
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

function createCanonicalRequest(
  request: HeroBuildContextualRecommendationRequest,
): HeroBuildContextualRecommendationRequest {
  return {
    ...request,
    heroId: canonicalHeroId(request.heroId),
    itemIds: [...request.itemIds],
    enemyHeroIds: request.enemyHeroIds
      ? [...request.enemyHeroIds]
      : undefined,
    alliedHeroIds: request.alliedHeroIds
      ? [...request.alliedHeroIds]
      : undefined,
    previousActionKeys: request.previousActionKeys
      ? [...request.previousActionKeys]
      : undefined,
  };
}

function createRecommendationValueV6Request(
  canonicalRequest: HeroBuildContextualRecommendationRequest,
): HeroBuildContextualRecommendationRequest {
  return {
    ...canonicalRequest,
    heroId: resolveRecommendationValueV6HeroId(
      canonicalRequest.heroId,
    ),
  };
}

function createContextualV3ShadowLog(
  request: HeroBuildContextualRecommendationRequest,
  requestedHeroId: number,
  baseline: HeroBuildRecommendationResponse,
  contextual: ContextualV3LiveRecommendationResponse,
  elapsedMs: number,
): ContextualV3ShadowLog {
  const baselineActionKeys = [
    baseline.action.actionKey,
    ...baseline.alternatives.map((action) => action.actionKey),
  ];
  const contextualActionKeys = [
    contextual.action.actionKey,
    ...contextual.alternatives.map((action) => action.actionKey),
  ];
  const baselineTop3ActionKeys = baselineActionKeys.slice(0, 3);
  const contextualTop3ActionKeys = contextualActionKeys.slice(0, 3);

  return {
    event: 'hero_build_contextual_v3_shadow',
    heroId: requestedHeroId,
    canonicalHeroId: request.heroId,
    gameTimeS: request.gameTimeS,
    alliedHeroIds: [...(request.alliedHeroIds ?? [])],
    enemyHeroIds: [...(request.enemyHeroIds ?? [])],
    previousActionCount: request.previousActionKeys?.length ?? 0,
    modelVersion: contextual.modelVersion,
    modelSha256: contextual.modelSha256,
    buildArchetypeId: contextual.buildArchetypeId,
    baselineTopActionKey: baseline.action.actionKey,
    contextualTopActionKey: contextual.action.actionKey,
    baselineTop3ActionKeys,
    contextualTop3ActionKeys,
    changedTop1: baseline.action.actionKey !== contextual.action.actionKey,
    changedTop3: !sameValues(baselineTop3ActionKeys, contextualTop3ActionKeys),
    elapsedMs,
  };
}

function readMode(): ContextualV3LiveMode {
  const value = process.env[MODE_ENV]?.trim().toUpperCase();
  if (value === 'BASELINE' || value === 'SHADOW' || value === 'PRODUCTION') {
    return value;
  }
  return 'BASELINE';
}

function sameValues(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function readBoundedNumberEnvironmentValue(
  name: string,
  defaultValue: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number(process.env[name]);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    return defaultValue;
  }
  return parsed;
}

function readBoundedIntegerEnvironmentValue(
  name: string,
  defaultValue: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number(process.env[name]);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    return defaultValue;
  }
  return parsed;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
