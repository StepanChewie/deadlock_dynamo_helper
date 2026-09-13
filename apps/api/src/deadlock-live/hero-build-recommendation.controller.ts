import {
  BadRequestException,
  Body,
  Controller,
  Inject,
  Post,
} from '@nestjs/common';
import { canonicalHeroId } from './hero-id-aliases';
import type { HeroBuildContextualRecommendationRequest } from './contextual-hero-build-recommendation.service';
import { deriveContextualV3PreviousActionKeys } from './contextual-v3-live-context';
import {
  filterHeroBuildRecommendationAlternatives,
  HERO_BUILD_DEFAULT_MIN_ALTERNATIVE_CONFIDENCE,
  HERO_BUILD_DEFAULT_MIN_ALTERNATIVE_HISTORICAL_COUNT,
  HERO_BUILD_MAX_MIN_ALTERNATIVE_HISTORICAL_COUNT,
  HeroBuildAlternativeFilterOptions,
} from './hero-build-recommendation-alternative-filter';
import { HeroBuildRecommendationPresentationService } from './hero-build-recommendation-presentation.service';
import {
  HERO_BUILD_DEFAULT_RECOMMENDATION_LIMIT,
  HERO_BUILD_MAX_RECOMMENDATION_LIMIT,
  HeroBuildRecommendationService,
} from './hero-build-recommendation.service';
import { preferUpgradeOverComponentSell } from './hero-build-upgrade-preference';
import { LiveMatchStateService } from './live-match-state.service';
import { ProductionHeroBuildRecommendationService } from './production-hero-build-recommendation.service';
import { RecipeAwareTimelineReconciliationService } from './recipe-aware-timeline-reconciliation.service';

export class RecommendHeroBuildDto {
  heroId!: number;
  itemIds!: number[];
  gameTimeS!: number;
  enemyHeroIds?: number[];
  alliedHeroIds?: number[];
  previousActionKeys?: string[];
  limit?: number;
  minAlternativeHistoricalCount?: number;
  minAlternativeConfidence?: number;
}

interface ValidatedRecommendHeroBuildRequest {
  recommendationRequest: HeroBuildContextualRecommendationRequest;
  alternativeFilter: HeroBuildAlternativeFilterOptions;
}

interface ResolvedLiveRecommendationContext {
  alliedHeroIds: number[];
  enemyHeroIds: number[];
  previousActionKeys: string[];
}

@Controller('deadlock/analysis/build-recommendation')
export class HeroBuildRecommendationController {
  constructor(
    @Inject(ProductionHeroBuildRecommendationService)
    private readonly heroBuildRecommendationService: HeroBuildRecommendationService,
    private readonly heroBuildRecommendationPresentationService:
      HeroBuildRecommendationPresentationService,
    private readonly liveMatchStateService: LiveMatchStateService,
    private readonly recipeAwareTimelineReconciliationService:
      RecipeAwareTimelineReconciliationService,
  ) {}

  @Post()
  async recommend(@Body() dto: RecommendHeroBuildDto) {
    const validated = validateRequest(dto);
    const liveContext = this.resolveLiveContext(
      validated.recommendationRequest.heroId,
    );
    const contextualRequest: HeroBuildContextualRecommendationRequest = {
      ...validated.recommendationRequest,
      enemyHeroIds:
        validated.recommendationRequest.enemyHeroIds ??
        liveContext.enemyHeroIds,
      alliedHeroIds:
        validated.recommendationRequest.alliedHeroIds ??
        liveContext.alliedHeroIds,
      previousActionKeys:
        validated.recommendationRequest.previousActionKeys ??
        liveContext.previousActionKeys,
      limit: HERO_BUILD_MAX_RECOMMENDATION_LIMIT,
    };
    const response = await this.heroBuildRecommendationService.recommend(
      contextualRequest,
    );
    const filtered = filterHeroBuildRecommendationAlternatives(
      response,
      validated.alternativeFilter,
    );
    const preferred = preferUpgradeOverComponentSell(
      filtered,
      contextualRequest.itemIds,
    );

    return this.heroBuildRecommendationPresentationService.present(preferred);
  }

  private resolveLiveContext(heroId: number): ResolvedLiveRecommendationContext {
    const canonicalRequestedHeroId = canonicalHeroId(heroId);
    const states = this.liveMatchStateService
      .getAllStates()
      .sort(
        (left, right) =>
          Date.parse(right.lastUpdatedAt) - Date.parse(left.lastUpdatedAt),
      );

    for (const state of states) {
      const entries = Object.entries(state.playersBySteamId);
      const localEntry = entries.find(
        ([, player]) =>
          player.isLocal === true &&
          Number.isSafeInteger(player.heroId) &&
          canonicalHeroId(Number(player.heroId)) === canonicalRequestedHeroId,
      );
      if (!localEntry || localEntry[1].teamId === undefined) {
        continue;
      }

      const [localPlayerId, localPlayer] = localEntry;
      const alliedHeroIds = [...new Set(
        entries
          .filter(
            ([playerId, player]) =>
              playerId !== localPlayerId &&
              player.teamId === localPlayer.teamId &&
              Number.isSafeInteger(player.heroId) &&
              Number(player.heroId) > 0,
          )
          .map(([, player]) => Number(player.heroId)),
      )].sort((left, right) => left - right);
      const enemyHeroIds = [...new Set(
        entries
          .filter(
            ([, player]) =>
              player.teamId !== undefined &&
              player.teamId !== localPlayer.teamId &&
              Number.isSafeInteger(player.heroId) &&
              Number(player.heroId) > 0,
          )
          .map(([, player]) => Number(player.heroId)),
      )].sort((left, right) => left - right);
      const inventorySnapshots = this.liveMatchStateService
        .getSnapshots(state.matchId)
        .map((snapshot) => snapshot.playersBySteamId[localPlayerId]?.itemIds)
        .filter((itemIds): itemIds is number[] => Array.isArray(itemIds));
      inventorySnapshots.push(localPlayer.items.map((item) => item.id));
      const previousActionKeys = deriveContextualV3PreviousActionKeys(
        inventorySnapshots,
        (parentItemId) =>
          this.recipeAwareTimelineReconciliationService.getComponentItemIds(
            parentItemId,
          ),
      );

      return { alliedHeroIds, enemyHeroIds, previousActionKeys };
    }

    return {
      alliedHeroIds: [],
      enemyHeroIds: [],
      previousActionKeys: [],
    };
  }
}

function validateRequest(dto: RecommendHeroBuildDto): ValidatedRecommendHeroBuildRequest {
  if (!Number.isSafeInteger(dto?.heroId) || dto.heroId <= 0) {
    throw new BadRequestException('heroId must be a positive safe integer.');
  }
  if (!Array.isArray(dto.itemIds)) {
    throw new BadRequestException('itemIds must be an array.');
  }
  for (const itemId of dto.itemIds) {
    if (!Number.isSafeInteger(itemId) || itemId <= 0) {
      throw new BadRequestException('Every itemIds value must be a positive safe integer.');
    }
  }
  if (!Number.isSafeInteger(dto.gameTimeS) || dto.gameTimeS < 0) {
    throw new BadRequestException('gameTimeS must be a non-negative safe integer.');
  }
  if (
    dto.limit !== undefined &&
    (!Number.isSafeInteger(dto.limit) ||
      dto.limit <= 0 ||
      dto.limit > HERO_BUILD_MAX_RECOMMENDATION_LIMIT)
  ) {
    throw new BadRequestException(
      `limit must be a positive safe integer not exceeding ${HERO_BUILD_MAX_RECOMMENDATION_LIMIT}.`,
    );
  }
  if (
    dto.minAlternativeHistoricalCount !== undefined &&
    (!Number.isSafeInteger(dto.minAlternativeHistoricalCount) ||
      dto.minAlternativeHistoricalCount < 0 ||
      dto.minAlternativeHistoricalCount >
        HERO_BUILD_MAX_MIN_ALTERNATIVE_HISTORICAL_COUNT)
  ) {
    throw new BadRequestException(
      `minAlternativeHistoricalCount must be a non-negative safe integer not exceeding ${HERO_BUILD_MAX_MIN_ALTERNATIVE_HISTORICAL_COUNT}.`,
    );
  }
  if (
    dto.minAlternativeConfidence !== undefined &&
    (!Number.isFinite(dto.minAlternativeConfidence) ||
      dto.minAlternativeConfidence < 0 ||
      dto.minAlternativeConfidence > 1)
  ) {
    throw new BadRequestException(
      'minAlternativeConfidence must be a finite number between 0 and 1.',
    );
  }

  const enemyHeroIds = validateHeroIds(dto.enemyHeroIds, 'enemyHeroIds');
  const alliedHeroIds = validateHeroIds(dto.alliedHeroIds, 'alliedHeroIds');
  const previousActionKeys = validatePreviousActionKeys(dto.previousActionKeys);

  return {
    recommendationRequest: {
      heroId: dto.heroId,
      itemIds: [...dto.itemIds],
      gameTimeS: dto.gameTimeS,
      enemyHeroIds,
      alliedHeroIds,
      previousActionKeys,
    },
    alternativeFilter: {
      limit: dto.limit ?? HERO_BUILD_DEFAULT_RECOMMENDATION_LIMIT,
      minHistoricalCount:
        dto.minAlternativeHistoricalCount ??
        HERO_BUILD_DEFAULT_MIN_ALTERNATIVE_HISTORICAL_COUNT,
      minConfidence:
        dto.minAlternativeConfidence ??
        HERO_BUILD_DEFAULT_MIN_ALTERNATIVE_CONFIDENCE,
    },
  };
}

function validateHeroIds(
  value: number[] | undefined,
  fieldName: 'enemyHeroIds' | 'alliedHeroIds',
): number[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new BadRequestException(`${fieldName} must be an array.`);
  }

  for (const heroId of value) {
    if (!Number.isSafeInteger(heroId) || heroId <= 0) {
      throw new BadRequestException(
        `Every ${fieldName} value must be a positive safe integer.`,
      );
    }
  }

  return [...new Set(value)].sort((left, right) => left - right);
}

function validatePreviousActionKeys(
  value: string[] | undefined,
): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new BadRequestException('previousActionKeys must be an array.');
  }
  if (value.length > 64) {
    throw new BadRequestException('previousActionKeys must contain at most 64 values.');
  }

  for (const actionKey of value) {
    if (
      typeof actionKey !== 'string' ||
      !/^(BUY|REBUY|UPGRADE|SELL):[1-9][0-9]*$/.test(actionKey)
    ) {
      throw new BadRequestException(
        'Every previousActionKeys value must be a valid item action key.',
      );
    }
  }

  return [...value];
}
