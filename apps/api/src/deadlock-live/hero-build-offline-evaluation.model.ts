import type { CanonicalPlayerBuildSequence } from './canonical-build-sequence.service';
import {
  applyConservativeMatchupOdds,
  ContextualHeroBuildRecommendationAction,
  HERO_BUILD_CONTEXTUAL_CANDIDATE_LIMIT,
  mergeContextualRecommendationCandidatePool,
  rankContextualActions,
} from './contextual-hero-build-recommendation.service';
import {
  calculateGraphMatchupInteraction,
  GraphMatchupEvidence,
  GraphOutcomeSample,
  GRAPH_MATCHUP_MODEL_VERSION,
} from './hero-build-matchup-statistics.service';
import {
  HERO_BUILD_DEFAULT_RECOMMENDATION_LIMIT,
  HERO_BUILD_MAX_BACKOFF_DISTANCE,
  HERO_BUILD_MAX_BACKOFF_STATES,
  HERO_BUILD_MIN_EXACT_OBSERVATIONS,
  HeroBuildRecommendationAction,
  HeroBuildRecommendationMode,
  HeroBuildRecommendationResponse,
  parseInventoryStateKey,
  recommendFromPolicy,
} from './hero-build-recommendation.service';
import type {
  HeroBuildPolicy,
  HeroBuildPolicyState,
} from './hero-build-transition-aggregation.service';

export const HERO_BUILD_OFFLINE_EVALUATION_MODEL_VERSION =
  'HERO_BUILD_CHRONOLOGICAL_HOLDOUT_V1';
export const HERO_BUILD_OFFLINE_EVALUATION_GAME_TIME_BUCKET_S = 30;
const HERO_BUILD_OFFLINE_EVALUATION_MAX_CACHE_ENTRIES = 100_000;

interface MutableOutcomeSample extends GraphOutcomeSample {}

interface MutableOfflineActionStats extends MutableOutcomeSample {
  byEnemyHeroId: Map<number, MutableOutcomeSample>;
}

interface MutableOfflineStateStats extends MutableOutcomeSample {
  byEnemyHeroId: Map<number, MutableOutcomeSample>;
  actionsByKey: Map<string, MutableOfflineActionStats>;
}

interface ParsedPolicyState {
  state: HeroBuildPolicyState;
  itemCounts: ReadonlyMap<number, number>;
}

export interface OfflineMatchupIndexSummary {
  heroCount: number;
  stateCount: number;
  actionCount: number;
  observationCount: number;
}

export interface HeroBuildOfflinePredictionInput {
  heroId: number;
  stateKey: string;
  gameTimeS: number;
  enemyHeroIds: number[];
}

export interface HeroBuildOfflineModelPrediction {
  covered: boolean;
  mode: HeroBuildRecommendationMode;
  actionKeys: string[];
  topActionKey?: string;
  matchedStateKey?: string;
  stateDistance?: number;
  matchupPromoted: boolean;
  matchupInserted: boolean;
  isSituational: boolean;
  situationalAgainstHeroId?: number;
  situationalLower95OddsRatio?: number;
}

export interface HeroBuildOfflinePredictionPair {
  baseline: HeroBuildOfflineModelPrediction;
  contextual: HeroBuildOfflineModelPrediction;
}

export type HeroBuildRecipeResolver = (parentItemId: number) => readonly number[];

export class HeroBuildOfflineMatchupIndex {
  private readonly statesByHeroId = new Map<
    number,
    Map<string, MutableOfflineStateStats>
  >();

  addSequence(
    sequence: CanonicalPlayerBuildSequence,
    won: boolean,
    enemyHeroIds: readonly number[],
  ): void {
    if (
      !Number.isSafeInteger(sequence.heroId) ||
      sequence.heroId <= 0 ||
      sequence.replayDiagnosticCount > 0 ||
      sequence.steps.length === 0
    ) {
      return;
    }

    const normalizedEnemyHeroIds = normalizeHeroIds(enemyHeroIds);
    const states = this.statesByHeroId.get(sequence.heroId) ?? new Map();

    for (const step of sequence.steps) {
      const state = states.get(step.beforeStateKey) ?? createStateStats();
      incrementSample(state, won);
      incrementEnemySamples(state.byEnemyHeroId, normalizedEnemyHeroIds, won);

      const action = state.actionsByKey.get(step.actionKey) ?? createActionStats();
      incrementSample(action, won);
      incrementEnemySamples(action.byEnemyHeroId, normalizedEnemyHeroIds, won);

      state.actionsByKey.set(step.actionKey, action);
      states.set(step.beforeStateKey, state);
    }

    this.statesByHeroId.set(sequence.heroId, states);
  }

  evaluate(
    heroId: number,
    stateKey: string,
    actionKey: string,
    enemyHeroIds: readonly number[],
  ): GraphMatchupEvidence[] {
    const state = this.statesByHeroId.get(heroId)?.get(stateKey);
    const action = state?.actionsByKey.get(actionKey);
    if (!state || !action) {
      return [];
    }

    const otherActionsTotal = subtractSamples(state, action);
    return normalizeHeroIds(enemyHeroIds)
      .map((enemyHeroId) => {
        const stateAgainst = state.byEnemyHeroId.get(enemyHeroId) ?? emptySample();
        const actionAgainst = action.byEnemyHeroId.get(enemyHeroId) ?? emptySample();
        const otherActionsAgainst = subtractSamples(stateAgainst, actionAgainst);
        const stateWithoutEnemy = subtractSamples(state, stateAgainst);
        const actionWithoutEnemy = subtractSamples(action, actionAgainst);
        const otherActionsWithoutEnemy = subtractSamples(
          otherActionsTotal,
          otherActionsAgainst,
        );

        return calculateGraphMatchupInteraction({
          enemyHeroId,
          actionAgainst,
          otherActionsAgainst,
          actionWithoutEnemy,
          otherActionsWithoutEnemy,
        });
      })
      .filter((value): value is GraphMatchupEvidence => value !== undefined)
      .sort(compareEvidence);
  }

  getSummary(): OfflineMatchupIndexSummary {
    let stateCount = 0;
    let actionCount = 0;
    let observationCount = 0;

    for (const states of this.statesByHeroId.values()) {
      stateCount += states.size;
      for (const state of states.values()) {
        actionCount += state.actionsByKey.size;
        observationCount += state.matches;
      }
    }

    return {
      heroCount: this.statesByHeroId.size,
      stateCount,
      actionCount,
      observationCount,
    };
  }
}

interface CachedBasePrediction {
  response: HeroBuildRecommendationResponse;
  baseline: HeroBuildOfflineModelPrediction;
  candidatePool: ReturnType<typeof mergeContextualRecommendationCandidatePool>;
}

export class HeroBuildOfflineEvaluationModel {
  private readonly parsedStatesByHeroId = new Map<number, ParsedPolicyState[]>();
  private readonly basePredictionCache = new Map<string, CachedBasePrediction>();
  private readonly contextualPredictionCache = new Map<
    string,
    HeroBuildOfflineModelPrediction
  >();

  constructor(
    private readonly policiesByHeroId: ReadonlyMap<number, HeroBuildPolicy>,
    private readonly matchupIndex: HeroBuildOfflineMatchupIndex,
    private readonly recipeResolver: HeroBuildRecipeResolver,
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

  predict(input: HeroBuildOfflinePredictionInput): HeroBuildOfflinePredictionPair {
    const policy = this.policiesByHeroId.get(input.heroId);
    const parsedStates = this.parsedStatesByHeroId.get(input.heroId);
    const itemIds = expandInventoryStateKey(input.stateKey);

    if (!policy || !parsedStates || !itemIds) {
      const prediction = createEmptyPrediction();
      return { baseline: prediction, contextual: { ...prediction } };
    }

    const gameTimeBucket = Math.max(
      0,
      Math.floor(input.gameTimeS / HERO_BUILD_OFFLINE_EVALUATION_GAME_TIME_BUCKET_S),
    );
    const normalizedGameTimeS =
      gameTimeBucket * HERO_BUILD_OFFLINE_EVALUATION_GAME_TIME_BUCKET_S;
    const baseCacheKey = `${input.heroId}|${input.stateKey}|${gameTimeBucket}`;
    let cachedBase = this.basePredictionCache.get(baseCacheKey);

    if (!cachedBase) {
      const request = {
        heroId: input.heroId,
        itemIds,
        gameTimeS: normalizedGameTimeS,
        limit: HERO_BUILD_CONTEXTUAL_CANDIDATE_LIMIT,
      };
      const commonOptions = {
        maxBackoffDistance: HERO_BUILD_MAX_BACKOFF_DISTANCE,
        maxBackoffStates: HERO_BUILD_MAX_BACKOFF_STATES,
        limit: HERO_BUILD_CONTEXTUAL_CANDIDATE_LIMIT,
      };
      const baseResponse = recommendFromPolicy(
        request,
        input.stateKey,
        policy,
        parsedStates,
        this.recipeResolver,
        {
          ...commonOptions,
          minExactObservations: HERO_BUILD_MIN_EXACT_OBSERVATIONS,
        },
      );
      const nearbyResponse = recommendFromPolicy(
        request,
        input.stateKey,
        policy,
        parsedStates,
        this.recipeResolver,
        {
          ...commonOptions,
          minExactObservations: Number.MAX_SAFE_INTEGER,
        },
      );
      cachedBase = {
        response: baseResponse,
        baseline: createPredictionFromBaseResponse(baseResponse, this.visibleLimit),
        candidatePool: mergeContextualRecommendationCandidatePool(
          [baseResponse.action, ...baseResponse.alternatives],
          [nearbyResponse.action, ...nearbyResponse.alternatives],
          HERO_BUILD_CONTEXTUAL_CANDIDATE_LIMIT,
        ),
      };
      setBoundedCache(this.basePredictionCache, baseCacheKey, cachedBase);
    }

    const normalizedEnemyHeroIds = normalizeHeroIds(input.enemyHeroIds);
    const contextualCacheKey = `${baseCacheKey}|${normalizedEnemyHeroIds.join(',')}`;
    let contextual = this.contextualPredictionCache.get(contextualCacheKey);
    if (!contextual) {
      const contextualActions = cachedBase.candidatePool.map((candidate) =>
        this.contextualizeAction(
          input.heroId,
          normalizedEnemyHeroIds,
          candidate.action,
          candidate.baseRank,
          candidate.wasInBaseBuild,
        ),
      );
      const rankedContextualActions = rankContextualActions(
        contextualActions,
        this.visibleLimit,
      );
      contextual = createPredictionFromContextualActions(
        rankedContextualActions,
        cachedBase.response.mode,
        this.visibleLimit,
      );
      setBoundedCache(
        this.contextualPredictionCache,
        contextualCacheKey,
        contextual,
      );
    }

    return { baseline: cachedBase.baseline, contextual };
  }

  private contextualizeAction(
    heroId: number,
    enemyHeroIds: readonly number[],
    action: HeroBuildRecommendationAction,
    baseRank: number,
    wasInBaseBuild: boolean,
  ): ContextualHeroBuildRecommendationAction {
    if (
      action.type === 'HOLD' ||
      action.itemId === undefined ||
      action.sourceActionType === undefined ||
      enemyHeroIds.length === 0
    ) {
      return createUnchangedContextualAction(action, baseRank, wasInBaseBuild);
    }

    const evidence = this.matchupIndex.evaluate(
      heroId,
      action.matchedStateKey,
      `${action.sourceActionType}:${action.itemId}`,
      enemyHeroIds,
    );
    const bestEvidence = evidence[0];
    const conservativeInteractionLogOdds = Math.max(
      0,
      bestEvidence?.lower95InteractionLogOddsRatio ?? 0,
    );
    const contextualScore = applyConservativeMatchupOdds(
      action.score,
      conservativeInteractionLogOdds,
    );

    return {
      ...action,
      score: contextualScore,
      baseScore: action.score,
      contextualScore,
      baseRank,
      contextualRank: baseRank,
      wasInBaseBuild,
      isSituational: conservativeInteractionLogOdds > 0,
      wasPromotedByMatchup: false,
      wasInsertedByMatchup: false,
      situationalAgainstHeroId:
        conservativeInteractionLogOdds > 0 ? bestEvidence?.enemyHeroId : undefined,
      situationalInteractionOddsRatio:
        conservativeInteractionLogOdds > 0
          ? bestEvidence?.interactionOddsRatio
          : undefined,
      situationalLower95OddsRatio:
        conservativeInteractionLogOdds > 0
          ? bestEvidence?.lower95InteractionOddsRatio
          : undefined,
      matchupObservationCount: bestEvidence?.matchupObservationCount ?? 0,
      matchupModelVersion: GRAPH_MATCHUP_MODEL_VERSION,
      matchupEvidence: evidence,
    };
  }
}

export function normalizeObservedActionKey(
  actionType: CanonicalPlayerBuildSequence['steps'][number]['actionType'],
  itemId: number,
): string {
  const normalizedActionType = actionType === 'REBUY' ? 'BUY' : actionType;
  return `${normalizedActionType}:${itemId}`;
}

export function expandInventoryStateKey(stateKey: string): number[] | undefined {
  const itemCounts = parseInventoryStateKey(stateKey);
  if (!itemCounts) {
    return undefined;
  }

  const itemIds: number[] = [];
  for (const [itemId, count] of itemCounts) {
    for (let index = 0; index < count; index += 1) {
      itemIds.push(itemId);
    }
  }
  return itemIds.sort((left, right) => left - right);
}

function createPredictionFromBaseResponse(
  response: HeroBuildRecommendationResponse,
  visibleLimit: number,
): HeroBuildOfflineModelPrediction {
  const actions = [response.action, ...response.alternatives]
    .filter((action) => action.type !== 'HOLD')
    .slice(0, visibleLimit);
  const topAction = actions[0];
  return {
    covered: topAction !== undefined,
    mode: response.mode,
    actionKeys: actions.map((action) => action.actionKey),
    topActionKey: topAction?.actionKey,
    matchedStateKey: topAction?.matchedStateKey,
    stateDistance: topAction?.stateDistance,
    matchupPromoted: false,
    matchupInserted: false,
    isSituational: false,
  };
}

function createPredictionFromContextualActions(
  actions: readonly ContextualHeroBuildRecommendationAction[],
  baseMode: HeroBuildRecommendationMode,
  visibleLimit: number,
): HeroBuildOfflineModelPrediction {
  const visibleActions = actions
    .filter((action) => action.type !== 'HOLD')
    .slice(0, visibleLimit);
  const topAction = visibleActions[0];
  const covered = topAction !== undefined;
  const mode = covered && baseMode === 'NO_MATCH' ? 'BACKOFF' : baseMode;

  return {
    covered,
    mode,
    actionKeys: visibleActions.map((action) => action.actionKey),
    topActionKey: topAction?.actionKey,
    matchedStateKey: topAction?.matchedStateKey,
    stateDistance: topAction?.stateDistance,
    matchupPromoted: Boolean(topAction?.wasPromotedByMatchup),
    matchupInserted: Boolean(topAction?.wasInsertedByMatchup),
    isSituational: Boolean(topAction?.isSituational),
    situationalAgainstHeroId: topAction?.situationalAgainstHeroId,
    situationalLower95OddsRatio: topAction?.situationalLower95OddsRatio,
  };
}

function createUnchangedContextualAction(
  action: HeroBuildRecommendationAction,
  baseRank: number,
  wasInBaseBuild: boolean,
): ContextualHeroBuildRecommendationAction {
  return {
    ...action,
    baseScore: action.score,
    contextualScore: action.score,
    baseRank,
    contextualRank: baseRank,
    wasInBaseBuild,
    isSituational: false,
    wasPromotedByMatchup: false,
    wasInsertedByMatchup: false,
    matchupObservationCount: 0,
    matchupModelVersion: GRAPH_MATCHUP_MODEL_VERSION,
    matchupEvidence: [],
  };
}

function createEmptyPrediction(): HeroBuildOfflineModelPrediction {
  return {
    covered: false,
    mode: 'NO_MATCH',
    actionKeys: [],
    matchupPromoted: false,
    matchupInserted: false,
    isSituational: false,
  };
}

function setBoundedCache<K, V>(cache: Map<K, V>, key: K, value: V): void {
  if (cache.size >= HERO_BUILD_OFFLINE_EVALUATION_MAX_CACHE_ENTRIES) {
    cache.clear();
  }
  cache.set(key, value);
}

function createStateStats(): MutableOfflineStateStats {
  return {
    matches: 0,
    wins: 0,
    byEnemyHeroId: new Map(),
    actionsByKey: new Map(),
  };
}

function createActionStats(): MutableOfflineActionStats {
  return {
    matches: 0,
    wins: 0,
    byEnemyHeroId: new Map(),
  };
}

function incrementSample(sample: MutableOutcomeSample, won: boolean): void {
  sample.matches += 1;
  if (won) {
    sample.wins += 1;
  }
}

function incrementEnemySamples(
  samplesByEnemyHeroId: Map<number, MutableOutcomeSample>,
  enemyHeroIds: readonly number[],
  won: boolean,
): void {
  for (const enemyHeroId of enemyHeroIds) {
    const sample = samplesByEnemyHeroId.get(enemyHeroId) ?? emptySample();
    incrementSample(sample, won);
    samplesByEnemyHeroId.set(enemyHeroId, sample);
  }
}

function subtractSamples(
  total: GraphOutcomeSample,
  subset: GraphOutcomeSample,
): GraphOutcomeSample {
  return {
    matches: Math.max(0, total.matches - subset.matches),
    wins: Math.max(0, total.wins - subset.wins),
  };
}

function emptySample(): MutableOutcomeSample {
  return { matches: 0, wins: 0 };
}

function normalizeHeroIds(heroIds: readonly number[]): number[] {
  return [...new Set(
    heroIds.filter((heroId) => Number.isSafeInteger(heroId) && heroId > 0),
  )].sort((left, right) => left - right);
}

function compareEvidence(
  left: GraphMatchupEvidence,
  right: GraphMatchupEvidence,
): number {
  if (
    left.lower95InteractionLogOddsRatio !==
    right.lower95InteractionLogOddsRatio
  ) {
    return (
      right.lower95InteractionLogOddsRatio -
      left.lower95InteractionLogOddsRatio
    );
  }
  if (left.interactionLogOddsRatio !== right.interactionLogOddsRatio) {
    return right.interactionLogOddsRatio - left.interactionLogOddsRatio;
  }
  return right.matchupObservationCount - left.matchupObservationCount;
}
