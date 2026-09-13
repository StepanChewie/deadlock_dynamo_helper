import { Injectable, Optional } from '@nestjs/common';
import type { HeroBuildContextualRecommendationRequest } from './contextual-hero-build-recommendation.service';
import { HeroBuildContextualV3LiveService } from './hero-build-contextual-v3-live.service';
import { canonicalHeroId } from './hero-id-aliases';
import {
  HeroBuildRecommendationService,
  type HeroBuildRecommendationAction,
  type HeroBuildRecommendationResponse,
} from './hero-build-recommendation.service';
import { HeroBuildTransitionAggregationService } from './hero-build-transition-aggregation.service';
import { LiveMatchStateService } from './live-match-state.service';
import { ProductionHeroBuildRecommendationService } from './production-hero-build-recommendation.service';
import { RecommendationValueV6LiveService } from './recommendation-value-v6-live.service';
import { RecipeAwareTimelineReconciliationService } from './recipe-aware-timeline-reconciliation.service';

export type ProductionRecommendationRankingMode =
  | 'VALUE_V6'
  | 'CANDIDATE_GENERATOR_FALLBACK';

@Injectable()
export class ProductionSafeHeroBuildRecommendationService extends ProductionHeroBuildRecommendationService {
  private readonly fallbackGenerator: HeroBuildRecommendationService;

  constructor(
    transitionService: HeroBuildTransitionAggregationService,
    recipeService: RecipeAwareTimelineReconciliationService,
    contextualV3LiveService: HeroBuildContextualV3LiveService,
    @Optional()
    recommendationValueV6LiveService?: RecommendationValueV6LiveService,
    @Optional()
    liveMatchStateService?: LiveMatchStateService,
  ) {
    super(
      transitionService,
      recipeService,
      contextualV3LiveService,
      recommendationValueV6LiveService,
      liveMatchStateService,
    );
    this.fallbackGenerator = new HeroBuildRecommendationService(
      transitionService,
      recipeService,
    );
  }

  override async recommend(
    request: HeroBuildContextualRecommendationRequest,
  ): Promise<HeroBuildRecommendationResponse> {
    try {
      const response = await super.recommend(request);
      return {
        ...response,
        rankingMode: 'VALUE_V6',
        rankingSource: 'RECOMMENDATION_VALUE_V6',
      } as HeroBuildRecommendationResponse;
    } catch (error) {
      const reason = v6FallbackReason(error);
      if (!reason) {
        throw error;
      }

      const canonicalRequest = canonicalizeRequest(request);
      const baseline = await this.fallbackGenerator.recommend(canonicalRequest);
      return {
        ...baseline,
        heroId: request.heroId,
        action: markCandidateGeneratorEvidence(baseline.action),
        alternatives: baseline.alternatives.map(markCandidateGeneratorEvidence),
        recommendationModel: 'PRO_BUILD_CANDIDATE_GENERATOR',
        rankingMode: 'CANDIDATE_GENERATOR_FALLBACK',
        rankingSource: 'CANDIDATE_GENERATOR',
        fallbackReason: reason,
        rolloutMode: 'PRODUCTION',
      } as HeroBuildRecommendationResponse;
    }
  }
}

function canonicalizeRequest(
  request: HeroBuildContextualRecommendationRequest,
): HeroBuildContextualRecommendationRequest {
  return {
    ...request,
    heroId: canonicalHeroId(request.heroId),
    itemIds: [...request.itemIds],
    alliedHeroIds: request.alliedHeroIds
      ? [...request.alliedHeroIds]
      : undefined,
    enemyHeroIds: request.enemyHeroIds
      ? [...request.enemyHeroIds]
      : undefined,
    previousActionKeys: request.previousActionKeys
      ? [...request.previousActionKeys]
      : undefined,
  };
}

function markCandidateGeneratorEvidence(
  action: HeroBuildRecommendationAction,
): HeroBuildRecommendationAction & {
  confidenceSemantic: 'CANDIDATE_GENERATOR_EVIDENCE';
} {
  return {
    ...action,
    confidenceSemantic: 'CANDIDATE_GENERATOR_EVIDENCE',
  };
}

function v6FallbackReason(error: unknown): string | undefined {
  const message = error instanceof Error ? error.message : String(error);
  const exclusivePrefix =
    'Recommendation Value V6 did not produce an exclusive ranking: ';
  if (message.includes(exclusivePrefix)) {
    return message
      .slice(message.indexOf(exclusivePrefix) + exclusivePrefix.length)
      .replace(/\.$/, '');
  }
  if (
    message.includes('Recommendation Value V6 service is unavailable') ||
    message.includes('Recommendation Value V6 must be enabled')
  ) {
    return 'V6_SERVICE_UNAVAILABLE';
  }
  return undefined;
}
