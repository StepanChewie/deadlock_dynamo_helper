import { Injectable } from '@nestjs/common';
import {
  createDefaultHeroBuildContextualV2Config,
  HeroBuildContextualV2Action,
  HeroBuildContextualV2ActionEvaluation,
  HeroBuildContextualV2Config,
  HERO_BUILD_CONTEXTUAL_V2_MODEL_VERSION,
  rerankHeroBuildActionsV2,
} from './hero-build-contextual-v2.model';
import type { HeroBuildContextualRecommendationRequest } from './contextual-hero-build-recommendation.service';
import { canonicalHeroId } from './hero-id-aliases';
import {
  HeroBuildRecommendationAction,
  HeroBuildRecommendationResponse,
} from './hero-build-recommendation.service';
import { HeroBuildNextActionContextStatisticsService } from './hero-build-next-action-context-statistics.service';

const MIN_ACTION_OBSERVATIONS_ENV =
  'DEADLOCK_CONTEXTUAL_V2_MIN_ACTION_OBSERVATIONS';
const MIN_CONTEXT_OBSERVATIONS_ENV =
  'DEADLOCK_CONTEXTUAL_V2_MIN_CONTEXT_OBSERVATIONS';
const SHRINKAGE_STRENGTH_ENV = 'DEADLOCK_CONTEXTUAL_V2_SHRINKAGE_STRENGTH';
const LAMBDA_ENV = 'DEADLOCK_CONTEXTUAL_V2_LAMBDA';
const MAX_LOGIT_BONUS_ENV = 'DEADLOCK_CONTEXTUAL_V2_MAX_LOGIT_BONUS';

export type HeroBuildContextualV2RecommendationResponse = Omit<
  HeroBuildRecommendationResponse,
  'action' | 'alternatives'
> & {
  enemyHeroIds: number[];
  modelVersion: typeof HERO_BUILD_CONTEXTUAL_V2_MODEL_VERSION;
  config: HeroBuildContextualV2Config;
  evaluatedCandidateCount: number;
  promotedCandidateCount: number;
  changedTop1: boolean;
  changedTop3: boolean;
  action: HeroBuildContextualV2Action;
  alternatives: HeroBuildContextualV2Action[];
};

@Injectable()
export class ContextualHeroBuildRecommendationV2Service {
  private readonly config = readConfigFromEnvironment();

  constructor(
    private readonly contextStatisticsService:
      HeroBuildNextActionContextStatisticsService,
  ) {}

  async rerank(
    request: HeroBuildContextualRecommendationRequest,
    baseline: HeroBuildRecommendationResponse,
  ): Promise<HeroBuildContextualV2RecommendationResponse> {
    const canonicalRequest = {
      ...request,
      heroId: canonicalHeroId(request.heroId),
      itemIds: [...request.itemIds],
      enemyHeroIds: [...(request.enemyHeroIds ?? [])],
    };
    const baselineActions = [baseline.action, ...baseline.alternatives];
    const candidates = baselineActions
      .filter(
        (action) =>
          action.type !== 'HOLD' &&
          action.sourceActionType !== undefined &&
          action.itemId !== undefined,
      )
      .slice(0, this.config.candidateLimit)
      .map((action) => ({
        actionKey: action.actionKey,
        stateKey: action.matchedStateKey,
      }));
    const evaluations =
      canonicalRequest.enemyHeroIds.length > 0 && candidates.length > 0
        ? await this.contextStatisticsService.evaluateMany({
            heroId: canonicalRequest.heroId,
            gameTimeS: canonicalRequest.gameTimeS,
            enemyHeroIds: canonicalRequest.enemyHeroIds,
            candidates,
          })
        : new Map<string, HeroBuildContextualV2ActionEvaluation>();
    const reranked = rerankHeroBuildActionsV2(
      baselineActions,
      evaluations,
      this.config,
    );
    const rankedActionKeys = new Set(
      reranked.actions.map((action) => action.actionKey),
    );
    const remaining = baselineActions
      .filter((action) => !rankedActionKeys.has(action.actionKey))
      .map((action, index) =>
        createUnchangedAction(
          action,
          reranked.actions.length + index + 1,
          this.config,
        ),
      );
    const actions = [...reranked.actions, ...remaining];
    if (actions.length === 0) {
      actions.push(createUnchangedAction(baseline.action, 1, this.config));
    }
    const action = actions[0];

    return {
      ...baseline,
      matchedStateKey: action.matchedStateKey,
      stateDistance: action.stateDistance,
      missingItemCount: action.missingItemCount,
      extraItemCount: action.extraItemCount,
      matchedBySubset: action.matchedBySubset,
      observationCount: action.matchedStateObservationCount,
      enemyHeroIds: [...canonicalRequest.enemyHeroIds],
      modelVersion: HERO_BUILD_CONTEXTUAL_V2_MODEL_VERSION,
      config: { ...this.config },
      evaluatedCandidateCount: reranked.evaluatedCandidateCount,
      promotedCandidateCount: reranked.promotedCandidateCount,
      changedTop1: baseline.action.actionKey !== action.actionKey,
      changedTop3: reranked.changedTop3,
      action,
      alternatives: actions.slice(1),
    };
  }
}

function createUnchangedAction(
  action: HeroBuildRecommendationAction,
  rank: number,
  config: HeroBuildContextualV2Config,
): HeroBuildContextualV2Action {
  return {
    ...action,
    baseScore: action.score,
    contextualScore: action.score,
    baseRank: rank,
    contextualRank: rank,
    contextualLogitBonus: 0,
    rosterInteractionLogOdds: 0,
    observedEnemyCount: 0,
    eligibleEnemyCount: 0,
    wasPromotedByContext: false,
    modelVersion: HERO_BUILD_CONTEXTUAL_V2_MODEL_VERSION,
    configId: config.id,
    enemySignals: [],
    contextEvidence: [],
  };
}

function readConfigFromEnvironment(): HeroBuildContextualV2Config {
  const defaults = createDefaultHeroBuildContextualV2Config();
  const minimumActionObservations = readBoundedIntegerEnvironmentValue(
    MIN_ACTION_OBSERVATIONS_ENV,
    defaults.minimumActionObservations,
    1,
    10_000,
  );
  const minimumContextObservations = readBoundedIntegerEnvironmentValue(
    MIN_CONTEXT_OBSERVATIONS_ENV,
    defaults.minimumContextObservations,
    1,
    100_000,
  );
  const shrinkageStrength = readBoundedNumberEnvironmentValue(
    SHRINKAGE_STRENGTH_ENV,
    defaults.shrinkageStrength,
    1,
    100_000,
  );
  const lambda = readBoundedNumberEnvironmentValue(
    LAMBDA_ENV,
    defaults.lambda,
    0,
    1,
  );
  const maximumLogitBonus = readBoundedNumberEnvironmentValue(
    MAX_LOGIT_BONUS_ENV,
    defaults.maximumLogitBonus,
    0,
    1,
  );
  return {
    ...defaults,
    id: [
      'v2-live',
      `l${formatConfigNumber(lambda)}`,
      `a${minimumActionObservations}`,
      `c${minimumContextObservations}`,
      `s${formatConfigNumber(shrinkageStrength)}`,
    ].join('-'),
    minimumActionObservations,
    minimumContextObservations,
    shrinkageStrength,
    lambda,
    maximumLogitBonus,
  };
}

function readBoundedIntegerEnvironmentValue(
  name: string,
  defaultValue: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number(process.env[name]);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : defaultValue;
}

function readBoundedNumberEnvironmentValue(
  name: string,
  defaultValue: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : defaultValue;
}

function formatConfigNumber(value: number): string {
  return String(value).replace('.', 'p');
}
