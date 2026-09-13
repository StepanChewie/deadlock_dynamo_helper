import { Injectable, Logger, Optional } from '@nestjs/common';
import { MinimalMatchState, MinimalPlayerState } from '@deadlock-live-probe/shared';
import type { HeroBuildContextualRecommendationRequest } from './contextual-hero-build-recommendation.service';
import {
  filterHeroBuildRecommendationAlternatives,
  HERO_BUILD_DEFAULT_MIN_ALTERNATIVE_CONFIDENCE,
  HERO_BUILD_DEFAULT_MIN_ALTERNATIVE_HISTORICAL_COUNT,
  HeroBuildRecommendationWithAlternativeFilter,
} from './hero-build-recommendation-alternative-filter';
import { HeroBuildRecommendationOwnershipFilterService } from './hero-build-recommendation-ownership-filter.service';
import {
  HeroBuildPresentedRecommendation,
  HeroBuildRecommendationPresentationService,
} from './hero-build-recommendation-presentation.service';
import {
  HERO_BUILD_MAX_RECOMMENDATION_LIMIT,
  HeroBuildRecommendationResponse,
  HeroBuildRecommendationService,
} from './hero-build-recommendation.service';
import {
  deriveContextualV3PreviousActionKeys,
  deriveContextualV3PreviousActions,
} from './contextual-v3-live-context';
import { createInventoryStateKeyFromItemIds } from './hero-build-transition-aggregation.service';
import { RecipeAwareTimelineReconciliationService } from './recipe-aware-timeline-reconciliation.service';
import { RecommendationDecisionTelemetryService } from './recommendation-decision-telemetry.service';

export const LIVE_BUILD_RECOMMENDATION_TIME_BUCKET_S = 120;
export const LIVE_BUILD_RECOMMENDATION_LIMIT = 5;
export const LIVE_BUILD_RECOMMENDATION_MAX_TRACKED_MATCHES = 32;
export const LIVE_BUILD_RECOMMENDATION_TIMEOUT_MS = 30_000;

export type LiveBuildRecommendationTraversalState =
  | 'WAITING_FOR_LOCAL_PLAYER'
  | 'WAITING_FOR_HERO'
  | 'REFRESHING'
  | 'READY'
  | 'ERROR';

export type LiveBuildPresentedRecommendation = HeroBuildPresentedRecommendation<
  HeroBuildRecommendationWithAlternativeFilter
>;

export interface LiveBuildRecommendationTraversalInput {
  matchId: string;
  steamId: string;
  heroId: number;
  teamId?: number;
  itemIds: number[];
  alliedHeroIds: number[];
  enemyHeroIds: number[];
  previousActionKeys: string[];
  inventoryStateKey: string;
  gameTimeS: number;
  timeBucket: number;
  traversalKey: string;
}

export interface LiveBuildRecommendationTraversalSnapshot {
  state: LiveBuildRecommendationTraversalState;
  matchId: string;
  steamId?: string;
  heroId?: number;
  teamId?: number;
  itemIds: number[];
  alliedHeroIds: number[];
  enemyHeroIds: number[];
  previousActionKeys: string[];
  inventoryStateKey?: string;
  gameTimeS?: number;
  timeBucket?: number;
  traversalKey?: string;
  decisionId?: string;
  isStale: boolean;
  recommendation?: LiveBuildPresentedRecommendation;
  refreshCount: number;
  cacheHitCount: number;
  discardedResultCount: number;
  lastObservedAt: string;
  lastStartedAt?: string;
  lastUpdatedAt?: string;
  lastError?: string;
}

export interface LiveBuildRecommendationTraversalStatus {
  timeBucketSeconds: number;
  maximumTrackedMatches: number;
  trackedMatchCount: number;
  readyCount: number;
  refreshingCount: number;
  waitingCount: number;
  errorCount: number;
  totalRefreshCount: number;
  totalCacheHitCount: number;
  totalDiscardedResultCount: number;
}

interface TraversalRuntime {
  matchId: string;
  desiredInput?: LiveBuildRecommendationTraversalInput;
  resolvedKey?: string;
  lastAttemptedKey?: string;
  worker?: Promise<void>;
  lastObservedAtMs: number;
  inventorySnapshots: number[][];
  pendingDecisionId?: string;
  pendingDecisionTraversalKey?: string;
  snapshot: LiveBuildRecommendationTraversalSnapshot;
}

@Injectable()
export class LiveBuildRecommendationTraversalService {
  private readonly logger = new Logger(LiveBuildRecommendationTraversalService.name);
  private readonly runtimes = new Map<string, TraversalRuntime>();

  constructor(
    private readonly heroBuildRecommendationService: HeroBuildRecommendationService,
    private readonly heroBuildRecommendationPresentationService:
      HeroBuildRecommendationPresentationService,
    private readonly heroBuildRecommendationOwnershipFilterService:
      HeroBuildRecommendationOwnershipFilterService,
    private readonly recipeAwareTimelineReconciliationService:
      RecipeAwareTimelineReconciliationService,
    @Optional()
    private readonly recommendationDecisionTelemetryService?:
      RecommendationDecisionTelemetryService,
  ) {}

  observeState(state: MinimalMatchState | undefined): void {
    if (!state || !state.matchId || state.matchId === 'unknown') {
      return;
    }

    const observedAt = new Date();
    const runtime = this.getOrCreateRuntime(state.matchId, observedAt);
    runtime.lastObservedAtMs = observedAt.getTime();
    runtime.snapshot.lastObservedAt = observedAt.toISOString();
    this.evictOldRuntimes();

    const localPlayer = findLocalPlayer(state);
    if (!localPlayer) {
      this.setWaitingState(runtime, 'WAITING_FOR_LOCAL_PLAYER', observedAt);
      return;
    }

    if (!Number.isSafeInteger(localPlayer.heroId) || Number(localPlayer.heroId) <= 0) {
      this.setWaitingState(runtime, 'WAITING_FOR_HERO', observedAt, localPlayer.steamId);
      return;
    }

    const currentItemIds = localPlayer.items
      .map((item) => Number(item.id))
      .filter((itemId) => Number.isSafeInteger(itemId) && itemId > 0)
      .sort((left, right) => left - right);
    const previousSnapshot =
      runtime.inventorySnapshots[runtime.inventorySnapshots.length - 1];
    const inventoryChanged = Boolean(
      previousSnapshot &&
        !sameNumberArrays(previousSnapshot, currentItemIds),
    );
    if (inventoryChanged && previousSnapshot) {
      this.recordObservedAction(
        runtime,
        state,
        localPlayer,
        previousSnapshot,
        currentItemIds,
      );
    }
    if (!previousSnapshot || inventoryChanged) {
      runtime.inventorySnapshots.push(currentItemIds);
      if (runtime.inventorySnapshots.length > 128) {
        runtime.inventorySnapshots.shift();
      }
    }
    const previousActionKeys = deriveContextualV3PreviousActionKeys(
      runtime.inventorySnapshots,
      (parentItemId) =>
        this.recipeAwareTimelineReconciliationService.getComponentItemIds(
          parentItemId,
        ),
    );
    const input = createTraversalInput(state, localPlayer, previousActionKeys);
    if (
      runtime.desiredInput?.traversalKey === input.traversalKey ||
      runtime.lastAttemptedKey === input.traversalKey
    ) {
      runtime.snapshot.cacheHitCount += 1;
      return;
    }

    const recommendationInventoryChanged =
      runtime.snapshot.inventoryStateKey !== undefined &&
      runtime.snapshot.inventoryStateKey !== input.inventoryStateKey;
    const optimisticRecommendation =
      recommendationInventoryChanged && runtime.snapshot.recommendation
        ? createOptimisticRecommendation(
            runtime.snapshot.recommendation,
            input,
            this.heroBuildRecommendationOwnershipFilterService,
          )
        : runtime.snapshot.recommendation;

    runtime.desiredInput = input;
    runtime.snapshot = {
      ...runtime.snapshot,
      state: optimisticRecommendation ? 'READY' : 'REFRESHING',
      matchId: input.matchId,
      steamId: input.steamId,
      heroId: input.heroId,
      teamId: input.teamId,
      itemIds: [...input.itemIds],
      alliedHeroIds: [...input.alliedHeroIds],
      enemyHeroIds: [...input.enemyHeroIds],
      previousActionKeys: [...input.previousActionKeys],
      inventoryStateKey: input.inventoryStateKey,
      gameTimeS: input.gameTimeS,
      timeBucket: input.timeBucket,
      traversalKey: input.traversalKey,
      isStale:
        optimisticRecommendation !== undefined &&
        runtime.resolvedKey !== input.traversalKey,
      recommendation: optimisticRecommendation,
      lastError: undefined,
    };

    this.startWorker(runtime);
  }

  getMatchSnapshot(matchId: string): LiveBuildRecommendationTraversalSnapshot | undefined {
    const snapshot = this.runtimes.get(matchId)?.snapshot;
    return snapshot ? cloneSnapshot(snapshot) : undefined;
  }

  getAllSnapshots(): LiveBuildRecommendationTraversalSnapshot[] {
    return [...this.runtimes.values()]
      .sort((left, right) => right.lastObservedAtMs - left.lastObservedAtMs)
      .map((runtime) => cloneSnapshot(runtime.snapshot));
  }

  getStatus(): LiveBuildRecommendationTraversalStatus {
    const snapshots = [...this.runtimes.values()].map((runtime) => runtime.snapshot);
    return {
      timeBucketSeconds: LIVE_BUILD_RECOMMENDATION_TIME_BUCKET_S,
      maximumTrackedMatches: LIVE_BUILD_RECOMMENDATION_MAX_TRACKED_MATCHES,
      trackedMatchCount: snapshots.length,
      readyCount: snapshots.filter((snapshot) => snapshot.state === 'READY').length,
      refreshingCount: snapshots.filter((snapshot) => snapshot.state === 'REFRESHING').length,
      waitingCount: snapshots.filter(
        (snapshot) =>
          snapshot.state === 'WAITING_FOR_LOCAL_PLAYER' ||
          snapshot.state === 'WAITING_FOR_HERO',
      ).length,
      errorCount: snapshots.filter((snapshot) => snapshot.state === 'ERROR').length,
      totalRefreshCount: snapshots.reduce((total, snapshot) => total + snapshot.refreshCount, 0),
      totalCacheHitCount: snapshots.reduce((total, snapshot) => total + snapshot.cacheHitCount, 0),
      totalDiscardedResultCount: snapshots.reduce(
        (total, snapshot) => total + snapshot.discardedResultCount,
        0,
      ),
    };
  }

  async waitForIdle(matchId: string): Promise<void> {
    while (this.runtimes.get(matchId)?.worker) {
      await this.runtimes.get(matchId)?.worker;
    }
  }

  private getOrCreateRuntime(matchId: string, observedAt: Date): TraversalRuntime {
    const existing = this.runtimes.get(matchId);
    if (existing) {
      return existing;
    }

    const runtime: TraversalRuntime = {
      matchId,
      lastObservedAtMs: observedAt.getTime(),
      inventorySnapshots: [],
      snapshot: {
        state: 'WAITING_FOR_LOCAL_PLAYER',
        matchId,
        itemIds: [],
        alliedHeroIds: [],
        enemyHeroIds: [],
        previousActionKeys: [],
        isStale: false,
        refreshCount: 0,
        cacheHitCount: 0,
        discardedResultCount: 0,
        lastObservedAt: observedAt.toISOString(),
      },
    };
    this.runtimes.set(matchId, runtime);
    return runtime;
  }

  private setWaitingState(
    runtime: TraversalRuntime,
    state: Extract<
      LiveBuildRecommendationTraversalState,
      'WAITING_FOR_LOCAL_PLAYER' | 'WAITING_FOR_HERO'
    >,
    observedAt: Date,
    steamId?: string,
  ): void {
    if (runtime.snapshot.recommendation) {
      runtime.snapshot = {
        ...runtime.snapshot,
        state: 'READY',
        isStale: true,
        lastObservedAt: observedAt.toISOString(),
        lastError: undefined,
      };
      return;
    }

    runtime.desiredInput = undefined;
    runtime.resolvedKey = undefined;
    runtime.lastAttemptedKey = undefined;
    runtime.snapshot = {
      state,
      matchId: runtime.matchId,
      steamId,
      itemIds: [],
      alliedHeroIds: [],
      enemyHeroIds: [],
      previousActionKeys: [],
      isStale: false,
      refreshCount: runtime.snapshot.refreshCount,
      cacheHitCount: runtime.snapshot.cacheHitCount,
      discardedResultCount: runtime.snapshot.discardedResultCount,
      lastObservedAt: observedAt.toISOString(),
    };
  }

  private startWorker(runtime: TraversalRuntime): void {
    if (runtime.worker) {
      return;
    }

    runtime.worker = this.processRuntime(runtime).finally(() => {
      runtime.worker = undefined;
      this.evictOldRuntimes();
      if (
        runtime.desiredInput &&
        runtime.desiredInput.traversalKey !== runtime.lastAttemptedKey
      ) {
        this.startWorker(runtime);
      }
    });
  }

  private async processRuntime(runtime: TraversalRuntime): Promise<void> {
    while (
      runtime.desiredInput &&
      runtime.desiredInput.traversalKey !== runtime.lastAttemptedKey
    ) {
      const input = runtime.desiredInput;
      const startedAt = Date.now();
      runtime.lastAttemptedKey = input.traversalKey;
      runtime.snapshot.state = runtime.snapshot.recommendation ? 'READY' : 'REFRESHING';
      runtime.snapshot.isStale = runtime.snapshot.recommendation !== undefined;
      runtime.snapshot.lastStartedAt = new Date().toISOString();
      runtime.snapshot.lastError = undefined;

      try {
        const recommendationRequest: HeroBuildContextualRecommendationRequest = {
          heroId: input.heroId,
          itemIds: [...input.itemIds],
          alliedHeroIds: [...input.alliedHeroIds],
          enemyHeroIds: [...input.enemyHeroIds],
          previousActionKeys: [...input.previousActionKeys],
          gameTimeS: input.gameTimeS,
          limit: HERO_BUILD_MAX_RECOMMENDATION_LIMIT,
        };
        const recommendation = await withTimeout(
          this.heroBuildRecommendationService.recommend(recommendationRequest),
          LIVE_BUILD_RECOMMENDATION_TIMEOUT_MS,
        );
        const filtered = filterHeroBuildRecommendationAlternatives(recommendation, {
          limit: LIVE_BUILD_RECOMMENDATION_LIMIT,
          minHistoricalCount: HERO_BUILD_DEFAULT_MIN_ALTERNATIVE_HISTORICAL_COUNT,
          minConfidence: HERO_BUILD_DEFAULT_MIN_ALTERNATIVE_CONFIDENCE,
        });

        if (runtime.desiredInput?.traversalKey !== input.traversalKey) {
          runtime.snapshot.discardedResultCount += 1;
          continue;
        }

        const presented = await this.heroBuildRecommendationPresentationService.present(filtered);

        if (runtime.desiredInput?.traversalKey !== input.traversalKey) {
          runtime.snapshot.discardedResultCount += 1;
          continue;
        }

        const decisionId = this.recordServedDecision(
          runtime,
          input,
          recommendation,
          Date.now() - startedAt,
        );
        runtime.resolvedKey = input.traversalKey;
        runtime.snapshot = {
          ...runtime.snapshot,
          state: 'READY',
          matchId: input.matchId,
          steamId: input.steamId,
          heroId: input.heroId,
          teamId: input.teamId,
          itemIds: [...input.itemIds],
          alliedHeroIds: [...input.alliedHeroIds],
          enemyHeroIds: [...input.enemyHeroIds],
          previousActionKeys: [...input.previousActionKeys],
          inventoryStateKey: input.inventoryStateKey,
          gameTimeS: input.gameTimeS,
          timeBucket: input.timeBucket,
          traversalKey: input.traversalKey,
          decisionId,
          isStale: false,
          recommendation: presented,
          refreshCount: runtime.snapshot.refreshCount + 1,
          lastUpdatedAt: new Date().toISOString(),
          lastError: undefined,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (runtime.desiredInput?.traversalKey !== input.traversalKey) {
          runtime.snapshot.discardedResultCount += 1;
          continue;
        }
        this.recommendationDecisionTelemetryService?.recordModelError({
          context: input,
          error,
          elapsedMs: Date.now() - startedAt,
        });
        runtime.snapshot = {
          ...runtime.snapshot,
          state: 'ERROR',
          isStale: runtime.snapshot.recommendation !== undefined,
          lastUpdatedAt: new Date().toISOString(),
          lastError: message,
        };
        if (message === createRecommendationTimeoutMessage()) {
          runtime.desiredInput = undefined;
          runtime.lastAttemptedKey = undefined;
        }
        this.logger.warn(
          `Live build recommendation traversal failed for match ${input.matchId}: ${message}`,
        );
      }
    }
  }

  private recordObservedAction(
    runtime: TraversalRuntime,
    state: MinimalMatchState,
    localPlayer: MinimalPlayerState,
    previousItemIds: readonly number[],
    currentItemIds: readonly number[],
  ): void {
    const decisionId = runtime.pendingDecisionId;
    const telemetry = this.recommendationDecisionTelemetryService;
    if (!decisionId || !telemetry) {
      return;
    }
    const reconstruction = deriveContextualV3PreviousActions(
      [previousItemIds, currentItemIds],
      (parentItemId) =>
        this.recipeAwareTimelineReconciliationService.getComponentItemIds(
          parentItemId,
        ),
    );
    telemetry.recordObservedAction({
      decisionId,
      matchId: state.matchId,
      steamId: localPlayer.steamId,
      heroId: Number(localPlayer.heroId),
      teamId: normalizeTeamId(localPlayer.teamId),
      observedActionKeys: reconstruction.actionKeys,
      observedInventoryStateKey:
        createInventoryStateKeyFromItemIds(currentItemIds),
      observedAtGameTimeS: normalizeGameTime(state.gameTimeSec),
      reconstructionConfidence: reconstruction.confidence,
    });
    runtime.pendingDecisionId = undefined;
    runtime.pendingDecisionTraversalKey = undefined;
  }

  private recordServedDecision(
    runtime: TraversalRuntime,
    input: LiveBuildRecommendationTraversalInput,
    recommendation: HeroBuildRecommendationResponse,
    elapsedMs: number,
  ): string | undefined {
    const telemetry = this.recommendationDecisionTelemetryService;
    if (!telemetry) {
      return undefined;
    }
    if (
      runtime.pendingDecisionId &&
      runtime.pendingDecisionTraversalKey &&
      runtime.pendingDecisionTraversalKey !== input.traversalKey
    ) {
      telemetry.recordDecisionSuperseded({
        decisionId: runtime.pendingDecisionId,
        matchId: input.matchId,
        steamId: input.steamId,
        traversalKey: runtime.pendingDecisionTraversalKey,
        reason: 'NEW_DECISION_SERVED',
      });
    }
    const decisionId = telemetry.recordDecision({
      context: input,
      recommendation,
      elapsedMs,
    });
    runtime.pendingDecisionId = decisionId;
    runtime.pendingDecisionTraversalKey = input.traversalKey;
    return decisionId;
  }

  private supersedePendingDecision(
    runtime: TraversalRuntime,
    reason: 'RUNTIME_EVICTED',
  ): void {
    if (
      !runtime.pendingDecisionId ||
      !runtime.pendingDecisionTraversalKey ||
      !this.recommendationDecisionTelemetryService
    ) {
      return;
    }
    this.recommendationDecisionTelemetryService.recordDecisionSuperseded({
      decisionId: runtime.pendingDecisionId,
      matchId: runtime.matchId,
      steamId: runtime.snapshot.steamId ?? '',
      traversalKey: runtime.pendingDecisionTraversalKey,
      reason,
    });
    runtime.pendingDecisionId = undefined;
    runtime.pendingDecisionTraversalKey = undefined;
  }

  private evictOldRuntimes(): void {
    if (this.runtimes.size <= LIVE_BUILD_RECOMMENDATION_MAX_TRACKED_MATCHES) {
      return;
    }

    const removable = [...this.runtimes.values()]
      .filter((runtime) => !runtime.worker)
      .sort((left, right) => left.lastObservedAtMs - right.lastObservedAtMs);
    while (
      this.runtimes.size > LIVE_BUILD_RECOMMENDATION_MAX_TRACKED_MATCHES &&
      removable.length > 0
    ) {
      const runtime = removable.shift();
      if (runtime) {
        this.supersedePendingDecision(runtime, 'RUNTIME_EVICTED');
        this.runtimes.delete(runtime.matchId);
      }
    }
  }
}

export function createTraversalInput(
  state: MinimalMatchState,
  localPlayer: MinimalPlayerState,
  previousActionKeys: readonly string[] = [],
): LiveBuildRecommendationTraversalInput {
  const heroId = Number(localPlayer.heroId);
  const teamId = normalizeTeamId(localPlayer.teamId);
  const itemIds = localPlayer.items
    .map((item) => Number(item.id))
    .filter((itemId) => Number.isSafeInteger(itemId) && itemId > 0)
    .sort((left, right) => left - right);
  const alliedHeroIds = localPlayer.teamId === undefined
    ? []
    : [...new Set(
        Object.values(state.playersBySteamId)
          .filter(
            (player) =>
              player.steamId !== localPlayer.steamId &&
              player.teamId === localPlayer.teamId &&
              Number.isSafeInteger(player.heroId) &&
              Number(player.heroId) > 0,
          )
          .map((player) => Number(player.heroId)),
      )].sort((left, right) => left - right);
  const enemyHeroIds = localPlayer.teamId === undefined
    ? []
    : [...new Set(
        Object.values(state.playersBySteamId)
          .filter(
            (player) =>
              player.teamId !== undefined &&
              player.teamId !== localPlayer.teamId &&
              Number.isSafeInteger(player.heroId) &&
              Number(player.heroId) > 0,
          )
          .map((player) => Number(player.heroId)),
      )].sort((left, right) => left - right);
  const inventoryStateKey = createInventoryStateKeyFromItemIds(itemIds);
  const gameTimeS = Number.isFinite(state.gameTimeSec)
    ? Math.max(0, Math.floor(Number(state.gameTimeSec)))
    : 0;
  const timeBucket = Math.floor(gameTimeS / LIVE_BUILD_RECOMMENDATION_TIME_BUCKET_S);
  const traversalKey = [
    state.matchId,
    localPlayer.steamId,
    heroId,
    inventoryStateKey,
    alliedHeroIds.join(','),
    enemyHeroIds.join(','),
    previousActionKeys.join(','),
    timeBucket,
  ].join(':');

  return {
    matchId: state.matchId,
    steamId: localPlayer.steamId,
    heroId,
    teamId,
    itemIds,
    alliedHeroIds,
    enemyHeroIds,
    previousActionKeys: [...previousActionKeys],
    inventoryStateKey,
    gameTimeS,
    timeBucket,
    traversalKey,
  };
}

function createOptimisticRecommendation(
  recommendation: LiveBuildPresentedRecommendation,
  input: LiveBuildRecommendationTraversalInput,
  ownershipFilterService: HeroBuildRecommendationOwnershipFilterService,
): LiveBuildPresentedRecommendation {
  const legalActions = [recommendation.action, ...recommendation.alternatives].filter((action) =>
    ownershipFilterService.isActionLegalForState(action, input.inventoryStateKey),
  );

  if (legalActions.length === 0) {
    return {
      ...recommendation,
      mode: 'NO_MATCH',
      requestedStateKey: input.inventoryStateKey,
      gameTimeS: input.gameTimeS,
      action: createOptimisticHoldAction(recommendation.action, input),
      alternatives: [],
      noMatchReason: 'NO_LEGAL_ACTION',
    };
  }

  const action = legalActions[0];
  return {
    ...recommendation,
    requestedStateKey: input.inventoryStateKey,
    gameTimeS: input.gameTimeS,
    matchedStateKey: action.matchedStateKey,
    stateDistance: action.stateDistance,
    missingItemCount: action.missingItemCount,
    extraItemCount: action.extraItemCount,
    matchedBySubset: action.matchedBySubset,
    observationCount: action.matchedStateObservationCount,
    action: { ...action },
    alternatives: legalActions.slice(1).map((alternative) => ({ ...alternative })),
  };
}

function createOptimisticHoldAction(
  previousAction: LiveBuildPresentedRecommendation['action'],
  input: LiveBuildRecommendationTraversalInput,
): LiveBuildPresentedRecommendation['action'] {
  return {
    ...previousAction,
    type: 'HOLD',
    itemId: undefined,
    actionKey: 'HOLD',
    label: 'Recalculating next item',
    confidencePercent: 0,
    historicalProbabilityPercent: 0,
    typicalGameTimeLabel: formatGameTime(input.gameTimeS),
    item: undefined,
    historicalCount: 0,
    historicalProbability: 0,
    averageGameTimeS: input.gameTimeS,
    matchedStateKey: input.inventoryStateKey,
    matchedStateObservationCount: 0,
    stateDistance: 0,
    missingItemCount: 0,
    extraItemCount: 0,
    matchedBySubset: true,
    currentOwnedCount: undefined,
    observedOwnedCountLimit: undefined,
    predictedStateKey: input.inventoryStateKey,
    score: 0,
    confidence: 0,
    explanation: {
      code: 'NO_LEGAL_ACTION',
      evidenceLevel: 'INFERRED',
      text: 'The purchased item was detected. Recalculating the next build action.',
    },
  };
}

function normalizeGameTime(value: number | undefined): number {
  return Number.isFinite(value)
    ? Math.max(0, Math.floor(Number(value)))
    : 0;
}

function normalizeTeamId(value: number | undefined): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= 0
    ? Number(value)
    : undefined;
}

function formatGameTime(value: number): string {
  const totalSeconds = Math.max(0, Math.round(value));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function findLocalPlayer(state: MinimalMatchState): MinimalPlayerState | undefined {
  return Object.values(state.playersBySteamId)
    .filter((player) => player.isLocal === true)
    .sort((left, right) => left.steamId.localeCompare(right.steamId))[0];
}

function cloneSnapshot(
  snapshot: LiveBuildRecommendationTraversalSnapshot,
): LiveBuildRecommendationTraversalSnapshot {
  return {
    ...snapshot,
    itemIds: [...snapshot.itemIds],
    alliedHeroIds: [...snapshot.alliedHeroIds],
    enemyHeroIds: [...snapshot.enemyHeroIds],
    previousActionKeys: [...snapshot.previousActionKeys],
    recommendation: snapshot.recommendation
      ? {
          ...snapshot.recommendation,
          action: { ...snapshot.recommendation.action },
          alternatives: snapshot.recommendation.alternatives.map((action) => ({ ...action })),
          itemMetadata: {
            ...snapshot.recommendation.itemMetadata,
            missingItemIds: [...snapshot.recommendation.itemMetadata.missingItemIds],
          },
          alternativeFilter: { ...snapshot.recommendation.alternativeFilter },
        }
      : undefined,
  };
}


function createRecommendationTimeoutMessage(): string {
  return `Recommendation Value V6 candidate generation timed out after ${LIVE_BUILD_RECOMMENDATION_TIMEOUT_MS} ms.`;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(createRecommendationTimeoutMessage()));
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function sameNumberArrays(left: readonly number[], right: readonly number[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}
