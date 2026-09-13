import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Hero } from './entities/hero.entity';
import { Item } from './entities/item.entity';
import { canonicalHeroId, heroIdAliases } from './hero-id-aliases';
import {
  HeroBuildRecommendationAction,
  HeroBuildRecommendationMatchupSignal,
  HeroBuildRecommendationResponse,
} from './hero-build-recommendation.service';

export type HeroBuildPresentationEvidenceLevel = 'OBSERVED' | 'INFERRED';
export type HeroBuildPresentationExplanationCode =
  | 'EXACT_STATE_EVIDENCE'
  | 'SUBSET_STATE_EVIDENCE'
  | 'DIRECTIONAL_STATE_INFERENCE'
  | 'CONTEXTUAL_V3_MODEL'
  | 'RECOMMENDATION_VALUE_V6_MODEL'
  | 'NO_HERO_POLICY'
  | 'NO_NEARBY_STATE'
  | 'NO_LEGAL_ACTION';

export interface HeroBuildPresentedItem {
  itemId: number;
  name: string;
  className: string;
  slotType: string;
  cost: number;
  tier: number;
}

export interface HeroBuildPresentationExplanation {
  code: HeroBuildPresentationExplanationCode;
  evidenceLevel: HeroBuildPresentationEvidenceLevel;
  text: string;
}

export interface HeroBuildPresentedMatchupSignal
  extends HeroBuildRecommendationMatchupSignal {
  heroName: string;
}

export type HeroBuildPresentedAction = Omit<
  HeroBuildRecommendationAction,
  'matchupSignals'
> & {
  label: string;
  confidencePercent: number;
  historicalProbabilityPercent: number;
  typicalGameTimeLabel: string;
  item?: HeroBuildPresentedItem;
  situationalAgainstHeroName?: string;
  matchupSignals?: HeroBuildPresentedMatchupSignal[];
  explanation: HeroBuildPresentationExplanation;
};

export interface HeroBuildItemMetadataSummary {
  requestedCount: number;
  resolvedCount: number;
  missingItemIds: number[];
}

export type HeroBuildPresentedRecommendation<
  T extends HeroBuildRecommendationResponse = HeroBuildRecommendationResponse,
> = Omit<T, 'action' | 'alternatives'> & {
  action: HeroBuildPresentedAction;
  alternatives: HeroBuildPresentedAction[];
  itemMetadata: HeroBuildItemMetadataSummary;
};

export interface HeroBuildPresentationItemSource {
  itemId: number;
  name: string;
  className: string;
  itemSlotType: string;
  cost: number;
  itemTier: number;
}

export interface HeroBuildPresentationHeroSource {
  heroId: number;
  name: string;
}

@Injectable()
export class HeroBuildRecommendationPresentationService {
  constructor(
    @InjectRepository(Item)
    private readonly itemRepository: Repository<Item>,
    @InjectRepository(Hero)
    private readonly heroRepository: Repository<Hero>,
  ) {}

  async present<T extends HeroBuildRecommendationResponse>(
    response: T,
  ): Promise<HeroBuildPresentedRecommendation<T>> {
    const itemIds = collectRecommendationItemIds(response);
    const heroIds = collectSituationalHeroLookupIds(response);
    const [items, heroes] = await Promise.all([
      itemIds.length > 0
        ? this.itemRepository.find({ where: { itemId: In(itemIds) } })
        : Promise.resolve([]),
      heroIds.length > 0
        ? this.heroRepository.find({ where: { heroId: In(heroIds) } })
        : Promise.resolve([]),
    ]);

    return presentHeroBuildRecommendation(response, items, heroes);
  }
}

export function presentHeroBuildRecommendation<T extends HeroBuildRecommendationResponse>(
  response: T,
  items: readonly HeroBuildPresentationItemSource[],
  heroes: readonly HeroBuildPresentationHeroSource[] = [],
): HeroBuildPresentedRecommendation<T> {
  const itemById = new Map<number, HeroBuildPresentedItem>();
  for (const item of items) {
    const itemId = Number(item.itemId);
    if (!Number.isSafeInteger(itemId) || itemId <= 0) {
      continue;
    }
    itemById.set(itemId, {
      itemId,
      name: item.name,
      className: item.className,
      slotType: item.itemSlotType,
      cost: item.cost,
      tier: item.itemTier,
    });
  }

  const heroNameByCanonicalId = new Map<number, string>();
  for (const hero of heroes) {
    const heroId = Number(hero.heroId);
    const name = typeof hero.name === 'string' ? hero.name.trim() : '';
    if (!Number.isSafeInteger(heroId) || heroId <= 0 || !name) {
      continue;
    }
    heroNameByCanonicalId.set(canonicalHeroId(heroId), name);
  }

  const itemIds = collectRecommendationItemIds(response);
  const missingItemIds = itemIds.filter((itemId) => !itemById.has(itemId));

  return {
    ...response,
    action: presentAction(response.action, response, itemById, heroNameByCanonicalId),
    alternatives: response.alternatives.map((action) =>
      presentAction(action, response, itemById, heroNameByCanonicalId),
    ),
    itemMetadata: {
      requestedCount: itemIds.length,
      resolvedCount: itemIds.length - missingItemIds.length,
      missingItemIds,
    },
  };
}

function presentAction(
  action: HeroBuildRecommendationAction,
  response: HeroBuildRecommendationResponse,
  itemById: ReadonlyMap<number, HeroBuildPresentedItem>,
  heroNameByCanonicalId: ReadonlyMap<number, string>,
): HeroBuildPresentedAction {
  const item = action.itemId ? itemById.get(action.itemId) : undefined;
  const situationalAgainstHeroId = getSituationalAgainstHeroId(action);
  const situationalAgainstHeroName = situationalAgainstHeroId === undefined
    ? undefined
    : heroNameByCanonicalId.get(canonicalHeroId(situationalAgainstHeroId));
  const matchupSignals = action.matchupSignals?.map((signal) => ({
    ...signal,
    heroName:
      heroNameByCanonicalId.get(canonicalHeroId(signal.heroId)) ??
      `Hero ${signal.heroId}`,
  }));

  return {
    ...action,
    label: createActionLabel(action, item),
    confidencePercent: toPercent(action.confidence),
    historicalProbabilityPercent: toPercent(action.historicalProbability),
    typicalGameTimeLabel: formatGameTime(action.averageGameTimeS),
    item,
    situationalAgainstHeroName,
    matchupSignals,
    explanation: createExplanation(action, response),
  };
}

function createActionLabel(
  action: HeroBuildRecommendationAction,
  item: HeroBuildPresentedItem | undefined,
): string {
  if (action.type === 'HOLD') {
    return 'Hold current build';
  }

  const itemLabel = item?.name ?? `Item ${action.itemId}`;
  const verb = action.type === 'BUY'
    ? 'Buy'
    : action.type === 'UPGRADE'
      ? 'Upgrade to'
      : 'Sell';
  return `${verb} ${itemLabel}`;
}

function createExplanation(
  action: HeroBuildRecommendationAction,
  response: HeroBuildRecommendationResponse,
): HeroBuildPresentationExplanation {
  if (action.type === 'HOLD') {
    if (response.noMatchReason === 'HERO_POLICY_NOT_FOUND') {
      return {
        code: 'NO_HERO_POLICY',
        evidenceLevel: 'INFERRED',
        text: 'No build policy data is available for this hero.',
      };
    }
    if (response.noMatchReason === 'NO_NEARBY_STATE') {
      return {
        code: 'NO_NEARBY_STATE',
        evidenceLevel: 'INFERRED',
        text: 'No sufficiently nearby historical inventory state was found.',
      };
    }
    return {
      code: 'NO_LEGAL_ACTION',
      evidenceLevel: 'INFERRED',
      text: 'Historical candidates exist, but none produce a legal action for the current inventory.',
    };
  }

  const probability = toPercent(action.historicalProbability);
  const typicalTime = formatGameTime(action.averageGameTimeS);
  const contextualV3 = response as HeroBuildRecommendationResponse & {
    recommendationModel?: string;
    buildArchetypeId?: string;
    contextualFeatures?: {
      phase?: string;
      alliedHeroIds?: number[];
      enemyHeroIds?: number[];
      previousActionCount?: number;
      archetypeApplied?: boolean;
    };
  };
  if (contextualV3.recommendationModel === 'RECOMMENDATION_VALUE_V6') {
    const model = contextualV3 as typeof contextualV3 & {
      modelVersion?: string;
      candidateId?: string;
    };
    return {
      code: 'RECOMMENDATION_VALUE_V6_MODEL',
      evidenceLevel: 'INFERRED',
      text:
        `Recommendation Value V6 ranked this action with model ${model.modelVersion ?? 'UNKNOWN'} ` +
        `(candidate ${model.candidateId ?? 'UNKNOWN'}).`,
    };
  }

  if (contextualV3.recommendationModel === 'CONTEXTUAL_V3') {
    const features = contextualV3.contextualFeatures;
    return {
      code: 'CONTEXTUAL_V3_MODEL',
      evidenceLevel: 'INFERRED',
      text:
        `Contextual V3 ranked this action for ${features?.phase ?? 'UNKNOWN'} phase ` +
        `using ${features?.alliedHeroIds?.length ?? 0} allies, ` +
        `${features?.enemyHeroIds?.length ?? 0} enemies, and ` +
        `${features?.previousActionCount ?? 0} observed build actions ` +
        `(archetype ${contextualV3.buildArchetypeId ?? 'UNKNOWN'}).`,
    };
  }

  if (response.mode === 'EXACT') {
    return {
      code: 'EXACT_STATE_EVIDENCE',
      evidenceLevel: 'OBSERVED',
      text: `Observed ${action.historicalCount} times from this exact inventory state (${probability}% of transitions), usually around ${typicalTime}.`,
    };
  }

  if (action.matchedBySubset) {
    return {
      code: 'SUBSET_STATE_EVIDENCE',
      evidenceLevel: 'INFERRED',
      text: `Observed ${action.historicalCount} times from a subset inventory state with ${action.extraItemCount} extra current item(s) (${probability}% of transitions), usually around ${typicalTime}.`,
    };
  }

  return {
    code: 'DIRECTIONAL_STATE_INFERENCE',
    evidenceLevel: 'INFERRED',
    text: `Inferred from a nearby inventory state missing ${action.missingItemCount} item(s); observed ${action.historicalCount} times (${probability}% of transitions), usually around ${typicalTime}.`,
  };
}

function collectRecommendationItemIds(
  response: HeroBuildRecommendationResponse,
): number[] {
  const itemIds = [response.action, ...response.alternatives]
    .map((action) => action.itemId)
    .filter((itemId): itemId is number =>
      Number.isSafeInteger(itemId) && Number(itemId) > 0,
    );
  return [...new Set(itemIds)].sort((left, right) => left - right);
}

function collectSituationalHeroLookupIds(
  response: HeroBuildRecommendationResponse,
): number[] {
  const heroIds = [response.action, ...response.alternatives]
    .flatMap((action) => [
      getSituationalAgainstHeroId(action),
      ...(action.matchupSignals ?? []).map((signal) => signal.heroId),
    ])
    .filter((heroId): heroId is number => heroId !== undefined)
    .flatMap((heroId) => heroIdAliases(heroId));
  return [...new Set(heroIds)].sort((left, right) => left - right);
}

function getSituationalAgainstHeroId(
  action: HeroBuildRecommendationAction,
): number | undefined {
  const value = Number(
    (action as HeroBuildRecommendationAction & {
      situationalAgainstHeroId?: number;
    }).situationalAgainstHeroId,
  );
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function toPercent(value: number): number {
  return Math.round(value * 10_000) / 100;
}

function formatGameTime(value: number): string {
  const totalSeconds = Math.max(0, Math.round(value));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}
