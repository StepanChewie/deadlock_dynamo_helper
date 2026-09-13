import { Injectable } from '@nestjs/common';
import {
  applyInventoryMultisetAction,
  createInventoryMultiset,
  createInventoryStateKeyFromMultiset,
  parseInventoryStateKey,
  type InventoryMultiset,
} from './inventory-multiset-action-engine';
import {
  createInventoryStateKeyFromItemIds,
  HeroBuildPolicy,
  HeroBuildPolicyNextAction,
  HeroBuildPolicyState,
  HeroBuildTransitionAggregationService,
} from './hero-build-transition-aggregation.service';
import { RecipeAwareTimelineReconciliationService } from './recipe-aware-timeline-reconciliation.service';

export const HERO_BUILD_MIN_EXACT_OBSERVATIONS = 3;
export const HERO_BUILD_MAX_BACKOFF_DISTANCE = 4;
export const HERO_BUILD_MAX_BACKOFF_STATES = 64;
export const HERO_BUILD_DEFAULT_RECOMMENDATION_LIMIT = 5;
export const HERO_BUILD_MAX_RECOMMENDATION_LIMIT = 20;

const SUPPORT_SMOOTHING = 5;
const TIME_DISTANCE_SCALE_S = 600;
const MISSING_ITEM_DISTANCE_WEIGHT = 4;

export type HeroBuildRecommendationMode = 'EXACT' | 'BACKOFF' | 'NO_MATCH';
export type HeroBuildRecommendationActionType = 'BUY' | 'UPGRADE' | 'SELL' | 'HOLD';
export type HeroBuildRecommendationNoMatchReason =
  | 'HERO_POLICY_NOT_FOUND'
  | 'NO_NEARBY_STATE'
  | 'NO_LEGAL_ACTION';
export type HeroBuildRecommendationBackoffReason =
  | 'SUBSET_STATE'
  | 'DIRECTIONAL_FALLBACK';

export interface HeroBuildRecommendationRequest {
  heroId: number;
  itemIds: number[];
  gameTimeS: number;
  limit?: number;
}

export type HeroBuildRecommendationMatchupDirection = 'POSITIVE' | 'NEGATIVE';

export interface HeroBuildRecommendationMatchupSignal {
  heroId: number;
  direction: HeroBuildRecommendationMatchupDirection;
  scoreContribution: number;
  contextualPurchaseLiftPercent: number;
  observationCount: number;
}

export interface HeroBuildRecommendationAction {
  type: HeroBuildRecommendationActionType;
  sourceActionType?: HeroBuildPolicyNextAction['actionType'];
  itemId?: number;
  actionKey: string;
  historicalCount: number;
  historicalProbability: number;
  averageGameTimeS: number;
  matchedStateKey: string;
  matchedStateObservationCount: number;
  stateDistance: number;
  missingItemCount: number;
  extraItemCount: number;
  matchedBySubset: boolean;
  currentOwnedCount?: number;
  observedOwnedCountLimit?: number;
  matchupSignals?: HeroBuildRecommendationMatchupSignal[];
  predictedStateKey: string;
  score: number;
  confidence: number;
}

export interface HeroBuildRecommendationResponse {
  mode: HeroBuildRecommendationMode;
  heroId: number;
  requestedStateKey: string;
  gameTimeS: number;
  matchedStateKey?: string;
  stateDistance?: number;
  missingItemCount?: number;
  extraItemCount?: number;
  matchedBySubset?: boolean;
  observationCount: number;
  candidateStateCount: number;
  action: HeroBuildRecommendationAction;
  alternatives: HeroBuildRecommendationAction[];
  backoffReason?: HeroBuildRecommendationBackoffReason;
  noMatchReason?: HeroBuildRecommendationNoMatchReason;
  policyLastRefreshedAt?: Date;
}

export interface HeroBuildRecommendationOptions {
  minExactObservations: number;
  maxBackoffDistance: number;
  maxBackoffStates: number;
  limit: number;
}

export interface DirectionalInventoryDistance {
  distance: number;
  missingItemCount: number;
  extraItemCount: number;
  matchedBySubset: boolean;
}

export type HeroBuildRecipeResolver = (parentItemId: number) => readonly number[];

type InventoryItemCounts = InventoryMultiset;

interface ParsedPolicyState {
  state: HeroBuildPolicyState;
  itemCounts: InventoryItemCounts;
}

interface StateCandidate extends ParsedPolicyState, DirectionalInventoryDistance {
  quality: number;
}

interface CachedHeroPolicyStates {
  policyVersionMs: number;
  states: ParsedPolicyState[];
}

interface ResolvedLegalAction {
  type: Exclude<HeroBuildRecommendationActionType, 'HOLD'>;
  predictedItemCounts: Map<number, number>;
  currentOwnedCount?: number;
  observedOwnedCountLimit?: number;
}

@Injectable()
export class HeroBuildRecommendationService {
  private readonly parsedStatesByHeroId = new Map<number, CachedHeroPolicyStates>();

  constructor(
    private readonly heroBuildTransitionAggregationService: HeroBuildTransitionAggregationService,
    private readonly recipeAwareTimelineReconciliationService: RecipeAwareTimelineReconciliationService,
  ) {}

  async recommend(
    request: HeroBuildRecommendationRequest,
  ): Promise<HeroBuildRecommendationResponse> {
    await this.heroBuildTransitionAggregationService.ensureReady(request.heroId);

    const policyStatus = this.heroBuildTransitionAggregationService.getStatus();
    const policy = this.heroBuildTransitionAggregationService.getHeroPolicy(request.heroId);
    const requestedStateKey = createInventoryStateKeyFromItemIds(request.itemIds);
    const policyVersionMs = policyStatus.lastRefreshedAt?.getTime() ?? 0;

    if (!policy) {
      return createNoMatchResponse(
        request,
        requestedStateKey,
        'HERO_POLICY_NOT_FOUND',
        0,
        policyStatus.lastRefreshedAt,
      );
    }

    const parsedStates = this.getParsedStates(request.heroId, policy, policyVersionMs);
    const response = recommendFromPolicy(
      request,
      requestedStateKey,
      policy,
      parsedStates,
      (parentItemId) =>
        this.recipeAwareTimelineReconciliationService.getComponentItemIds(parentItemId),
      {
        minExactObservations: HERO_BUILD_MIN_EXACT_OBSERVATIONS,
        maxBackoffDistance: HERO_BUILD_MAX_BACKOFF_DISTANCE,
        maxBackoffStates: HERO_BUILD_MAX_BACKOFF_STATES,
        limit: normalizeRecommendationLimit(request.limit),
      },
    );

    return {
      ...response,
      policyLastRefreshedAt: cloneDate(policyStatus.lastRefreshedAt),
    };
  }

  private getParsedStates(
    heroId: number,
    policy: HeroBuildPolicy,
    policyVersionMs: number,
  ): ParsedPolicyState[] {
    const cached = this.parsedStatesByHeroId.get(heroId);
    if (cached?.policyVersionMs === policyVersionMs) {
      return cached.states;
    }

    const states: ParsedPolicyState[] = [];
    for (const state of policy.statesByKey.values()) {
      const itemCounts = parseInventoryStateKey(state.stateKey);
      if (itemCounts) {
        states.push({ state, itemCounts });
      }
    }

    this.parsedStatesByHeroId.set(heroId, { policyVersionMs, states });
    return states;
  }
}

export function recommendFromPolicy(
  request: HeroBuildRecommendationRequest,
  requestedStateKey: string,
  policy: HeroBuildPolicy,
  parsedStates: readonly ParsedPolicyState[],
  recipeResolver: HeroBuildRecipeResolver,
  options: HeroBuildRecommendationOptions,
): HeroBuildRecommendationResponse {
  const requestedItemCounts = createItemCounts(request.itemIds);
  const exactState = policy.statesByKey.get(requestedStateKey);

  if (exactState && exactState.observationCount >= options.minExactObservations) {
    const exactActions = rankActions(
      [createStateCandidate(exactState, requestedItemCounts, requestedItemCounts)],
      requestedItemCounts,
      request.gameTimeS,
      recipeResolver,
    );

    if (exactActions.length > 0) {
      return createMatchedResponse(
        'EXACT',
        request,
        requestedStateKey,
        1,
        exactActions,
        options.limit,
      );
    }
  }

  const nearbyCandidates = parsedStates
    .map((parsedState) =>
      createStateCandidate(parsedState.state, parsedState.itemCounts, requestedItemCounts),
    )
    .filter((candidate) => candidate.distance <= options.maxBackoffDistance);

  if (nearbyCandidates.length === 0) {
    return createNoMatchResponse(
      request,
      requestedStateKey,
      'NO_NEARBY_STATE',
      0,
    );
  }

  const subsetCandidates = nearbyCandidates
    .filter((candidate) => candidate.matchedBySubset)
    .sort(compareStateCandidates)
    .slice(0, options.maxBackoffStates);
  const subsetActions = rankActions(
    subsetCandidates,
    requestedItemCounts,
    request.gameTimeS,
    recipeResolver,
  );

  if (subsetActions.length > 0) {
    return createMatchedResponse(
      'BACKOFF',
      request,
      requestedStateKey,
      subsetCandidates.length,
      subsetActions,
      options.limit,
      'SUBSET_STATE',
    );
  }

  const directionalCandidates = nearbyCandidates
    .filter((candidate) => !candidate.matchedBySubset)
    .sort(compareStateCandidates)
    .slice(0, options.maxBackoffStates);
  const directionalActions = rankActions(
    directionalCandidates,
    requestedItemCounts,
    request.gameTimeS,
    recipeResolver,
  );

  if (directionalActions.length > 0) {
    return createMatchedResponse(
      'BACKOFF',
      request,
      requestedStateKey,
      directionalCandidates.length,
      directionalActions,
      options.limit,
      'DIRECTIONAL_FALLBACK',
    );
  }

  return createNoMatchResponse(
    request,
    requestedStateKey,
    'NO_LEGAL_ACTION',
    nearbyCandidates.length,
  );
}

export { parseInventoryStateKey };

export function calculateDirectionalInventoryDistance(
  current: InventoryItemCounts,
  historical: InventoryItemCounts,
): DirectionalInventoryDistance {
  const itemIds = new Set<number>([...current.keys(), ...historical.keys()]);
  let missingItemCount = 0;
  let extraItemCount = 0;

  for (const itemId of itemIds) {
    const currentCount = current.get(itemId) ?? 0;
    const historicalCount = historical.get(itemId) ?? 0;
    if (historicalCount > currentCount) {
      missingItemCount += historicalCount - currentCount;
    } else if (currentCount > historicalCount) {
      extraItemCount += currentCount - historicalCount;
    }
  }

  return {
    distance: missingItemCount + extraItemCount,
    missingItemCount,
    extraItemCount,
    matchedBySubset: missingItemCount === 0,
  };
}

export function calculateInventoryMultisetDistance(
  left: InventoryItemCounts,
  right: InventoryItemCounts,
): number {
  return calculateDirectionalInventoryDistance(left, right).distance;
}

export function normalizeRecommendationLimit(value: number | undefined): number {
  if (value === undefined) {
    return HERO_BUILD_DEFAULT_RECOMMENDATION_LIMIT;
  }
  return Math.min(value, HERO_BUILD_MAX_RECOMMENDATION_LIMIT);
}

function createStateCandidate(
  state: HeroBuildPolicyState,
  itemCounts: InventoryItemCounts,
  requestedItemCounts: InventoryItemCounts,
): StateCandidate {
  const directionalDistance = calculateDirectionalInventoryDistance(
    requestedItemCounts,
    itemCounts,
  );

  return {
    state,
    itemCounts,
    ...directionalDistance,
    quality: calculateStateQuality(
      state.observationCount,
      directionalDistance.missingItemCount,
      directionalDistance.extraItemCount,
    ),
  };
}

function rankActions(
  candidates: readonly StateCandidate[],
  requestedItemCounts: InventoryItemCounts,
  gameTimeS: number,
  recipeResolver: HeroBuildRecipeResolver,
): HeroBuildRecommendationAction[] {
  const bestByActionKey = new Map<string, HeroBuildRecommendationAction>();

  for (const candidate of candidates) {
    for (const historicalAction of candidate.state.nextActions) {
      const action = createRecommendationAction(
        historicalAction,
        candidate,
        requestedItemCounts,
        gameTimeS,
        recipeResolver,
      );
      if (!action) {
        continue;
      }

      const existing = bestByActionKey.get(action.actionKey);
      if (!existing || compareRecommendationActions(action, existing) < 0) {
        bestByActionKey.set(action.actionKey, action);
      }
    }
  }

  return [...bestByActionKey.values()].sort(compareRecommendationActions);
}

function createRecommendationAction(
  historicalAction: HeroBuildPolicyNextAction,
  candidate: StateCandidate,
  requestedItemCounts: InventoryItemCounts,
  gameTimeS: number,
  recipeResolver: HeroBuildRecipeResolver,
): HeroBuildRecommendationAction | undefined {
  const resolved = resolveLegalAction(
    historicalAction,
    candidate.itemCounts,
    requestedItemCounts,
    recipeResolver,
  );
  if (!resolved) {
    return undefined;
  }

  const support = candidate.state.observationCount /
    (candidate.state.observationCount + SUPPORT_SMOOTHING);
  const timeDifferenceS = Math.abs(gameTimeS - historicalAction.averageGameTimeS);
  const timeFit = 1 / (1 + timeDifferenceS / TIME_DISTANCE_SCALE_S);
  const directionalDistance =
    candidate.extraItemCount + candidate.missingItemCount * MISSING_ITEM_DISTANCE_WEIGHT;
  const distanceFit = 1 / (1 + directionalDistance);
  const score = clampProbability(
    historicalAction.probability *
      (0.55 + 0.45 * support) *
      distanceFit *
      (0.7 + 0.3 * timeFit),
  );

  return {
    type: resolved.type,
    sourceActionType: historicalAction.actionType,
    itemId: historicalAction.itemId,
    actionKey: `${resolved.type}:${historicalAction.itemId}`,
    historicalCount: historicalAction.count,
    historicalProbability: historicalAction.probability,
    averageGameTimeS: historicalAction.averageGameTimeS,
    matchedStateKey: candidate.state.stateKey,
    matchedStateObservationCount: candidate.state.observationCount,
    stateDistance: candidate.distance,
    missingItemCount: candidate.missingItemCount,
    extraItemCount: candidate.extraItemCount,
    matchedBySubset: candidate.matchedBySubset,
    currentOwnedCount: resolved.currentOwnedCount,
    observedOwnedCountLimit: resolved.observedOwnedCountLimit,
    predictedStateKey: createStateKeyFromCounts(resolved.predictedItemCounts),
    score,
    confidence: score,
  };
}

function resolveLegalAction(
  historicalAction: HeroBuildPolicyNextAction,
  matchedItemCounts: InventoryItemCounts,
  requestedItemCounts: InventoryItemCounts,
  recipeResolver: HeroBuildRecipeResolver,
): ResolvedLegalAction | undefined {
  if (historicalAction.actionType === 'BUY' || historicalAction.actionType === 'REBUY') {
    const currentOwnedCount = requestedItemCounts.get(historicalAction.itemId) ?? 0;
    const observedOwnedCountLimit = resolveObservedOwnedCountLimit(
      historicalAction,
      matchedItemCounts,
    );
    const applied = applyInventoryMultisetAction(requestedItemCounts, {
      type: historicalAction.actionType,
      itemId: historicalAction.itemId,
      maxOwnedCount: observedOwnedCountLimit,
    });
    if (!applied.legal) {
      return undefined;
    }
    return {
      type: 'BUY',
      predictedItemCounts: applied.nextItemCounts,
      currentOwnedCount,
      observedOwnedCountLimit,
    };
  }

  if (historicalAction.actionType === 'SELL') {
    const applied = applyInventoryMultisetAction(requestedItemCounts, {
      type: 'SELL',
      itemId: historicalAction.itemId,
    });
    return applied.legal
      ? { type: 'SELL', predictedItemCounts: applied.nextItemCounts }
      : undefined;
  }

  const applied = applyInventoryMultisetAction(requestedItemCounts, {
    type: 'UPGRADE',
    itemId: historicalAction.itemId,
    componentItemIds: recipeResolver(historicalAction.itemId),
  });
  return applied.legal
    ? { type: 'UPGRADE', predictedItemCounts: applied.nextItemCounts }
    : undefined;
}

export function resolveObservedOwnedCountLimit(
  historicalAction: HeroBuildPolicyNextAction,
  matchedItemCounts: InventoryItemCounts,
): number {
  const matchedOwnedCount = matchedItemCounts.get(historicalAction.itemId) ?? 0;
  let observedOwnedCountLimit = matchedOwnedCount + 1;

  for (const afterState of historicalAction.afterStates) {
    const afterItemCounts = parseInventoryStateKey(afterState.afterStateKey);
    if (!afterItemCounts) {
      continue;
    }
    observedOwnedCountLimit = Math.max(
      observedOwnedCountLimit,
      afterItemCounts.get(historicalAction.itemId) ?? 0,
    );
  }

  return observedOwnedCountLimit;
}

function createMatchedResponse(
  mode: Exclude<HeroBuildRecommendationMode, 'NO_MATCH'>,
  request: HeroBuildRecommendationRequest,
  requestedStateKey: string,
  candidateStateCount: number,
  rankedActions: readonly HeroBuildRecommendationAction[],
  limit: number,
  backoffReason?: HeroBuildRecommendationBackoffReason,
): HeroBuildRecommendationResponse {
  const selected = rankedActions.slice(0, limit);
  const action = selected[0];

  return {
    mode,
    heroId: request.heroId,
    requestedStateKey,
    gameTimeS: request.gameTimeS,
    matchedStateKey: action.matchedStateKey,
    stateDistance: action.stateDistance,
    missingItemCount: action.missingItemCount,
    extraItemCount: action.extraItemCount,
    matchedBySubset: action.matchedBySubset,
    observationCount: action.matchedStateObservationCount,
    candidateStateCount,
    action: { ...action },
    alternatives: selected.slice(1).map((alternative) => ({ ...alternative })),
    backoffReason,
  };
}

function createNoMatchResponse(
  request: HeroBuildRecommendationRequest,
  requestedStateKey: string,
  noMatchReason: HeroBuildRecommendationNoMatchReason,
  candidateStateCount: number,
  policyLastRefreshedAt?: Date,
): HeroBuildRecommendationResponse {
  return {
    mode: 'NO_MATCH',
    heroId: request.heroId,
    requestedStateKey,
    gameTimeS: request.gameTimeS,
    observationCount: 0,
    candidateStateCount,
    action: {
      type: 'HOLD',
      actionKey: 'HOLD',
      historicalCount: 0,
      historicalProbability: 0,
      averageGameTimeS: request.gameTimeS,
      matchedStateKey: requestedStateKey,
      matchedStateObservationCount: 0,
      stateDistance: 0,
      missingItemCount: 0,
      extraItemCount: 0,
      matchedBySubset: true,
      predictedStateKey: requestedStateKey,
      score: 0,
      confidence: 0,
    },
    alternatives: [],
    noMatchReason,
    policyLastRefreshedAt: cloneDate(policyLastRefreshedAt),
  };
}

function createItemCounts(itemIds: readonly number[]): Map<number, number> {
  return createInventoryMultiset(itemIds);
}

function createStateKeyFromCounts(itemCounts: InventoryItemCounts): string {
  return createInventoryStateKeyFromMultiset(itemCounts);
}

function calculateStateQuality(
  observationCount: number,
  missingItemCount: number,
  extraItemCount: number,
): number {
  const support = observationCount / (observationCount + SUPPORT_SMOOTHING);
  const directionalDistance =
    extraItemCount + missingItemCount * MISSING_ITEM_DISTANCE_WEIGHT;
  return support / (1 + directionalDistance);
}

function compareStateCandidates(left: StateCandidate, right: StateCandidate): number {
  if (left.missingItemCount !== right.missingItemCount) {
    return left.missingItemCount - right.missingItemCount;
  }
  if (left.extraItemCount !== right.extraItemCount) {
    return left.extraItemCount - right.extraItemCount;
  }
  if (left.quality !== right.quality) {
    return right.quality - left.quality;
  }
  if (left.state.observationCount !== right.state.observationCount) {
    return right.state.observationCount - left.state.observationCount;
  }
  return left.state.stateKey.localeCompare(right.state.stateKey);
}

function compareRecommendationActions(
  left: HeroBuildRecommendationAction,
  right: HeroBuildRecommendationAction,
): number {
  if (left.score !== right.score) {
    return right.score - left.score;
  }
  if (left.historicalCount !== right.historicalCount) {
    return right.historicalCount - left.historicalCount;
  }
  if (left.missingItemCount !== right.missingItemCount) {
    return left.missingItemCount - right.missingItemCount;
  }
  if (left.extraItemCount !== right.extraItemCount) {
    return left.extraItemCount - right.extraItemCount;
  }
  if (left.matchedStateObservationCount !== right.matchedStateObservationCount) {
    return right.matchedStateObservationCount - left.matchedStateObservationCount;
  }
  return left.actionKey.localeCompare(right.actionKey);
}

function clampProbability(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function cloneDate(value: Date | undefined): Date | undefined {
  return value ? new Date(value) : undefined;
}
