import {
  expandInventoryStateKey,
  HeroBuildOfflineModelPrediction,
  HERO_BUILD_OFFLINE_EVALUATION_GAME_TIME_BUCKET_S,
} from './hero-build-offline-evaluation.model';
import {
  HeroBuildContextualV2ActionEvaluation,
  HeroBuildContextualV2Config,
  HeroBuildContextualV2RerankResult,
  rerankHeroBuildActionsV2,
} from './hero-build-contextual-v2.model';
import { HeroBuildOfflineV2ContextIndex } from './hero-build-offline-evaluation-v2-context-index';
import {
  HERO_BUILD_DEFAULT_RECOMMENDATION_LIMIT,
  HERO_BUILD_MAX_BACKOFF_DISTANCE,
  HERO_BUILD_MAX_BACKOFF_STATES,
  HERO_BUILD_MIN_EXACT_OBSERVATIONS,
  HeroBuildRecommendationAction,
  HeroBuildRecommendationResponse,
  parseInventoryStateKey,
  recommendFromPolicy,
} from './hero-build-recommendation.service';
import type {
  HeroBuildPolicy,
  HeroBuildPolicyState,
} from './hero-build-transition-aggregation.service';

const MAX_PREPARED_PREDICTION_CACHE_ENTRIES = 100_000;

interface ParsedPolicyState {
  state: HeroBuildPolicyState;
  itemCounts: ReadonlyMap<number, number>;
}

export interface HeroBuildOfflineV2PredictionInput {
  heroId: number;
  stateKey: string;
  gameTimeS: number;
  enemyHeroIds: number[];
}

export interface HeroBuildOfflineV2PreparedPrediction {
  input: HeroBuildOfflineV2PredictionInput;
  baselineResponse: HeroBuildRecommendationResponse;
  baseline: HeroBuildOfflineModelPrediction;
  evaluationsByActionKey: ReadonlyMap<
    string,
    HeroBuildContextualV2ActionEvaluation
  >;
}

export interface HeroBuildOfflineV2PredictionResult {
  baseline: HeroBuildOfflineModelPrediction;
  contextual: HeroBuildOfflineModelPrediction;
  rerank: HeroBuildContextualV2RerankResult;
}

export class HeroBuildOfflineEvaluationV2Model {
  private readonly parsedStatesByHeroId = new Map<number, ParsedPolicyState[]>();
  private readonly preparedCache = new Map<
    string,
    HeroBuildOfflineV2PreparedPrediction
  >();

  constructor(
    private readonly policiesByHeroId: ReadonlyMap<number, HeroBuildPolicy>,
    private readonly contextIndex: HeroBuildOfflineV2ContextIndex,
    private readonly recipeResolver: (parentItemId: number) => readonly number[],
    private readonly visibleLimit = HERO_BUILD_DEFAULT_RECOMMENDATION_LIMIT,
  ) {
    for (const [heroId, policy] of policiesByHeroId) {
      const states = [...policy.statesByKey.values()]
        .map((state) => ({
          state,
          itemCounts: parseInventoryStateKey(state.stateKey),
        }))
        .filter(
          (
            value,
          ): value is {
            state: HeroBuildPolicyState;
            itemCounts: ReadonlyMap<number, number>;
          } => value.itemCounts !== undefined,
        );
      this.parsedStatesByHeroId.set(heroId, states);
    }
  }

  prepare(
    input: HeroBuildOfflineV2PredictionInput,
  ): HeroBuildOfflineV2PreparedPrediction {
    const gameTimeBucket = Math.max(
      0,
      Math.floor(
        input.gameTimeS / HERO_BUILD_OFFLINE_EVALUATION_GAME_TIME_BUCKET_S,
      ),
    );
    const enemyHeroIds = normalizeHeroIds(input.enemyHeroIds);
    const cacheKey = [
      input.heroId,
      input.stateKey,
      gameTimeBucket,
      enemyHeroIds.join(','),
    ].join('|');
    const cached = this.preparedCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const policy = this.policiesByHeroId.get(input.heroId);
    const parsedStates = this.parsedStatesByHeroId.get(input.heroId);
    const itemIds = expandInventoryStateKey(input.stateKey);
    if (!policy || !parsedStates || !itemIds) {
      const empty = createEmptyPreparedPrediction(input, enemyHeroIds);
      this.setPreparedCache(cacheKey, empty);
      return empty;
    }

    const normalizedGameTimeS =
      gameTimeBucket * HERO_BUILD_OFFLINE_EVALUATION_GAME_TIME_BUCKET_S;
    const baselineResponse = recommendFromPolicy(
      {
        heroId: input.heroId,
        itemIds,
        gameTimeS: normalizedGameTimeS,
        limit: this.visibleLimit,
      },
      input.stateKey,
      policy,
      parsedStates,
      this.recipeResolver,
      {
        minExactObservations: HERO_BUILD_MIN_EXACT_OBSERVATIONS,
        maxBackoffDistance: HERO_BUILD_MAX_BACKOFF_DISTANCE,
        maxBackoffStates: HERO_BUILD_MAX_BACKOFF_STATES,
        limit: this.visibleLimit,
      },
    );
    const baseActions = [
      baselineResponse.action,
      ...baselineResponse.alternatives,
    ];
    const evaluationsByActionKey = new Map<
      string,
      HeroBuildContextualV2ActionEvaluation
    >();
    for (const action of baseActions) {
      if (
        action.type === 'HOLD' ||
        action.sourceActionType === undefined ||
        action.itemId === undefined
      ) {
        continue;
      }
      evaluationsByActionKey.set(
        action.actionKey,
        this.contextIndex.evaluate({
          stateKey: action.matchedStateKey,
          actionKey: action.actionKey,
          gameTimeS: normalizedGameTimeS,
          enemyValveHeroIds: enemyHeroIds,
        }),
      );
    }
    const prepared: HeroBuildOfflineV2PreparedPrediction = {
      input: {
        ...input,
        gameTimeS: normalizedGameTimeS,
        enemyHeroIds,
      },
      baselineResponse,
      baseline: createPrediction(
        baseActions,
        baselineResponse.mode,
        this.visibleLimit,
      ),
      evaluationsByActionKey,
    };
    this.setPreparedCache(cacheKey, prepared);
    return prepared;
  }

  predict(
    prepared: HeroBuildOfflineV2PreparedPrediction,
    config: HeroBuildContextualV2Config,
  ): HeroBuildOfflineV2PredictionResult {
    const baseActions = [
      prepared.baselineResponse.action,
      ...prepared.baselineResponse.alternatives,
    ];
    const rerank = rerankHeroBuildActionsV2(
      baseActions,
      prepared.evaluationsByActionKey,
      config,
    );
    return {
      baseline: prepared.baseline,
      contextual: createPrediction(
        rerank.actions,
        prepared.baselineResponse.mode,
        this.visibleLimit,
      ),
      rerank,
    };
  }

  private setPreparedCache(
    key: string,
    value: HeroBuildOfflineV2PreparedPrediction,
  ): void {
    if (this.preparedCache.size >= MAX_PREPARED_PREDICTION_CACHE_ENTRIES) {
      this.preparedCache.clear();
    }
    this.preparedCache.set(key, value);
  }
}

function createEmptyPreparedPrediction(
  input: HeroBuildOfflineV2PredictionInput,
  enemyHeroIds: number[],
): HeroBuildOfflineV2PreparedPrediction {
  const holdAction: HeroBuildRecommendationAction = {
    type: 'HOLD',
    actionKey: 'HOLD',
    historicalCount: 0,
    historicalProbability: 0,
    averageGameTimeS: input.gameTimeS,
    matchedStateKey: input.stateKey,
    matchedStateObservationCount: 0,
    stateDistance: 0,
    missingItemCount: 0,
    extraItemCount: 0,
    matchedBySubset: false,
    predictedStateKey: input.stateKey,
    score: 0,
    confidence: 0,
  };
  const baselineResponse: HeroBuildRecommendationResponse = {
    mode: 'NO_MATCH',
    heroId: input.heroId,
    requestedStateKey: input.stateKey,
    gameTimeS: input.gameTimeS,
    observationCount: 0,
    candidateStateCount: 0,
    action: holdAction,
    alternatives: [],
    noMatchReason: 'HERO_POLICY_NOT_FOUND',
  };
  return {
    input: { ...input, enemyHeroIds },
    baselineResponse,
    baseline: createPrediction([holdAction], 'NO_MATCH', 5),
    evaluationsByActionKey: new Map(),
  };
}

function createPrediction(
  actions: readonly HeroBuildRecommendationAction[],
  mode: HeroBuildRecommendationResponse['mode'],
  visibleLimit: number,
): HeroBuildOfflineModelPrediction {
  const visibleActions = actions
    .filter((action) => action.type !== 'HOLD')
    .slice(0, visibleLimit);
  const topAction = visibleActions[0];
  const contextualTopAction = actions.find(
    (action) => action.actionKey === topAction?.actionKey,
  ) as
    | (HeroBuildRecommendationAction & {
        wasPromotedByContext?: boolean;
        contextualLogitBonus?: number;
      })
    | undefined;
  return {
    covered: topAction !== undefined,
    mode,
    actionKeys: visibleActions.map((action) => action.actionKey),
    topActionKey: topAction?.actionKey,
    matchedStateKey: topAction?.matchedStateKey,
    stateDistance: topAction?.stateDistance,
    matchupPromoted: contextualTopAction?.wasPromotedByContext ?? false,
    matchupInserted: false,
    isSituational:
      Math.abs(contextualTopAction?.contextualLogitBonus ?? 0) > 0,
  };
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
