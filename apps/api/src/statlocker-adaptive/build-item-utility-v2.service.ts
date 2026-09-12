import { Injectable } from '@nestjs/common';
import { BuildArchetypeItemV2, BuildArchetypeV2, BuildPhaseV2 } from './build-archetype-v2';
import { EnemyThreatScoreV1 } from './enemy-threat-v1.service';
import {
  StatlockerT4ChainsV1,
  StatlockerWpaPatchDataV1,
} from './statlocker-adaptive.types';
import { STATLOCKER_BUILD_V2_CONFIG } from './statlocker-build-v2.config';
import { StatlockerVsHeroWpaAggregateSourceV1 } from './statlocker-vs-hero-wpa-repository-v1.service';
import { ThreatWeightedMatchupV1Service } from './threat-weighted-matchup-v1.service';

export interface BuildScoreContributionV2 {
  key: string;
  raw: number;
  normalized: number;
  confidence: number;
  weight: number;
  weighted: number;
}

export interface BuildScoreLayerV2 {
  raw: number;
  normalized: number;
  confidence: number;
  weighted: number;
  contributions: readonly BuildScoreContributionV2[];
}

export interface BuildTransitionCostV2 {
  transactionPenalty: number;
  churnPenalty: number;
  recentPurchasePenalty: number;
  replacementPenalty: number;
}

export interface BuildItemUtilityV2Input {
  heroId: number;
  itemId: number;
  archetype: BuildArchetypeV2;
  gameTimeSec: number;
  ownedItemIds: readonly number[];
  projectedItemIds: readonly number[];
  enemyHeroIds: readonly number[];
  enemyThreats: readonly EnemyThreatScoreV1[];
  vsHeroRows: readonly StatlockerVsHeroWpaAggregateSourceV1[];
  wpaPatchData?: StatlockerWpaPatchDataV1;
  t4Chains?: StatlockerT4ChainsV1;
  transition?: Partial<BuildTransitionCostV2>;
}

export interface BuildItemUtilityV2 {
  itemId: number;
  total: number;
  confidence: number;
  layers: {
    structure: BuildScoreLayerV2;
    matchup: BuildScoreLayerV2;
    progression: BuildScoreLayerV2;
    transition: BuildScoreLayerV2;
  };
  reasonCodes: readonly string[];
}

const PHASE_INDEX: Readonly<Record<BuildPhaseV2, number>> = {
  EARLY: 0,
  MID: 1,
  LATE: 2,
};

@Injectable()
export class BuildItemUtilityV2Service {
  constructor(private readonly matchup: ThreatWeightedMatchupV1Service) {}

  scoreItem(input: BuildItemUtilityV2Input): BuildItemUtilityV2 {
    validateInput(input);
    const reasonCodes = new Set<string>();
    const item = input.archetype.items.find((entry) => entry.itemId === input.itemId);
    const structure = scoreStructure(item, reasonCodes);
    const matchup = this.scoreMatchup(input, reasonCodes);
    const progression = scoreProgression(input, item, reasonCodes);
    const transition = scoreTransition(input.transition);
    const total = finiteOrZero(
      structure.weighted + matchup.weighted + progression.weighted + transition.weighted,
    );
    const confidence = clamp01(
      (structure.confidence + matchup.confidence + progression.confidence) / 3,
    );

    return {
      itemId: input.itemId,
      total,
      confidence,
      layers: { structure, matchup, progression, transition },
      reasonCodes: [...reasonCodes].sort(),
    };
  }

  private scoreMatchup(
    input: BuildItemUtilityV2Input,
    reasonCodes: Set<string>,
  ): BuildScoreLayerV2 {
    const config = STATLOCKER_BUILD_V2_CONFIG.itemUtility;
    const exact = this.matchup.scoreItem({
      ourHeroId: input.heroId,
      itemId: input.itemId,
      enemyHeroIds: input.enemyHeroIds,
      rows: input.vsHeroRows,
      enemyThreats: input.enemyThreats.map((enemy) => ({
        heroId: enemy.heroId,
        threatMultiplier: enemy.threatMultiplier,
      })),
    });
    const base = input.wpaPatchData?.items.find((entry) =>
      entry.heroId === input.heroId && entry.itemId === input.itemId,
    );
    const baseConfidence = base
      ? shrinkConfidence(base.sampleSize, config.baseWpaSamplePrior) * clamp01(base.wpaConfidence ?? 1)
      : 0;

    const contributions = [
      contribution(
        'exactEnemyWpa',
        exact.raw,
        exact.normalized,
        exact.confidence,
        config.matchupWeights.exactEnemy,
      ),
      contribution(
        'baseWpa',
        base?.meanWpa ?? 0,
        normalizeWpa(base?.meanWpa ?? 0),
        baseConfidence,
        config.matchupWeights.baseWpa,
      ),
    ];

    if (exact.confidence <= 0 && baseConfidence <= 0) {
      reasonCodes.add('MATCHUP_WPA_UNAVAILABLE');
    } else if (exact.confidence <= 0) {
      reasonCodes.add('MATCHUP_EXACT_WPA_UNAVAILABLE');
    }

    return layer(contributions, config.layerWeights.matchup);
  }
}

function scoreStructure(
  item: BuildArchetypeItemV2 | undefined,
  reasonCodes: Set<string>,
): BuildScoreLayerV2 {
  const config = STATLOCKER_BUILD_V2_CONFIG.itemUtility;
  if (!item) {
    reasonCodes.add('STRUCTURE_OUTSIDE_ARCHETYPE');
    return layer([
      contribution(
        'outsideArchetypePrior',
        config.outsideArchetypePrior,
        clamp11(config.outsideArchetypePrior),
        1,
        1,
      ),
    ], config.layerWeights.structure);
  }

  reasonCodes.add(`STRUCTURE_ARCHETYPE_${item.role}`);
  const weights = config.structureWeights;
  return layer([
    contribution('role', config.rolePriors[item.role], config.rolePriors[item.role], 1, weights.role),
    contribution(
      'structuralPriority',
      item.structuralPriority,
      clamp11(item.structuralPriority),
      1,
      weights.structuralPriority,
    ),
    contribution(
      'profileCoverage',
      item.profileCoverage,
      clamp11(item.profileCoverage),
      1,
      weights.profileCoverage,
    ),
    contribution(
      'purchaseRate',
      item.purchaseRate,
      clamp11(item.purchaseRate),
      1,
      weights.purchaseRate,
    ),
  ], config.layerWeights.structure);
}

function scoreProgression(
  input: BuildItemUtilityV2Input,
  item: BuildArchetypeItemV2 | undefined,
  reasonCodes: Set<string>,
): BuildScoreLayerV2 {
  const config = STATLOCKER_BUILD_V2_CONFIG.itemUtility;
  const weights = config.progressionWeights;
  const held = new Set([...input.ownedItemIds, ...input.projectedItemIds]);
  const contributions: BuildScoreContributionV2[] = [];

  if (item) {
    const timingDistance = Math.abs(input.gameTimeSec - item.timing.medianBuyTimeS);
    const timing = clamp11(2 * Math.exp(-timingDistance / Math.max(1, config.timingScaleS)) - 1);
    contributions.push(contribution(
      'timing',
      input.gameTimeSec - item.timing.medianBuyTimeS,
      timing,
      1,
      weights.timing,
    ));

    const currentPhase = phaseAt(input.gameTimeSec);
    const phaseDistance = Math.abs(PHASE_INDEX[currentPhase] - PHASE_INDEX[item.timing.phase]);
    const phaseFit = phaseDistance === 0 ? 1 : phaseDistance === 1 ? 0 : -1;
    contributions.push(contribution('phase', phaseDistance, phaseFit, 1, weights.phase));
  } else {
    contributions.push(contribution('timing', 0, 0, 0, weights.timing));
    contributions.push(contribution('phase', 0, 0, 0, weights.phase));
  }

  const predecessorEdges = input.archetype.orderEdges.filter((edge) => edge.afterItemId === input.itemId);
  if (predecessorEdges.length > 0) {
    const satisfied = predecessorEdges.filter((edge) => held.has(edge.beforeItemId));
    const orderFit = satisfied.length / predecessorEdges.length;
    const orderConfidence = predecessorEdges.reduce((sum, edge) => sum + clamp01(edge.confidence), 0)
      / predecessorEdges.length;
    contributions.push(contribution('order', orderFit, orderFit, orderConfidence, weights.order));
    if (satisfied.length < predecessorEdges.length) reasonCodes.add('PROGRESSION_PREDECESSOR_BLOCKED');
  } else {
    contributions.push(contribution('order', 0, 0, 0, weights.order));
  }

  const relationshipValues = input.archetype.relationships
    .filter((relationship) => relationship.leftItemId === input.itemId || relationship.rightItemId === input.itemId)
    .filter((relationship) => {
      const other = relationship.leftItemId === input.itemId
        ? relationship.rightItemId
        : relationship.leftItemId;
      return held.has(other);
    })
    .map((relationship) => clamp01(relationship.strength));
  if (relationshipValues.length > 0) {
    const relationship = average(relationshipValues);
    contributions.push(contribution('relationship', relationship, relationship, 1, weights.relationship));
  } else {
    contributions.push(contribution('relationship', 0, 0, 0, weights.relationship));
  }

  if (!input.t4Chains) {
    reasonCodes.add('PROGRESSION_T4_UNAVAILABLE');
    contributions.push(contribution('t4Chain', 0, 0, 0, weights.chain));
  } else {
    const chains = input.t4Chains.chains
      .filter((chain) =>
        chain.heroId === input.heroId &&
        chain.itemIds.length >= 2 &&
        chain.itemIds[chain.itemIds.length - 1] === input.itemId &&
        chain.itemIds.slice(0, -1).every((itemId) => held.has(itemId)),
      )
      .map((chain) => ({
        raw: chain.meanWpa ?? 0.05,
        normalized: chain.meanWpa === undefined ? 0.35 : normalizeWpa(chain.meanWpa),
        confidence: shrinkConfidence(chain.sampleSize, config.chainSamplePrior),
        sampleSize: chain.sampleSize,
      }))
      .sort((a, b) =>
        b.confidence * Math.abs(b.normalized) - a.confidence * Math.abs(a.normalized) ||
        b.sampleSize - a.sampleSize,
      );
    const chain = chains[0];
    contributions.push(contribution(
      't4Chain',
      chain?.raw ?? 0,
      chain?.normalized ?? 0,
      chain?.confidence ?? 0,
      weights.chain,
    ));
  }

  return layer(contributions, config.layerWeights.progression);
}

function scoreTransition(
  transition: Partial<BuildTransitionCostV2> | undefined,
): BuildScoreLayerV2 {
  const config = STATLOCKER_BUILD_V2_CONFIG.itemUtility;
  const weights = config.transitionPenaltyWeights;
  return layer([
    penaltyContribution('transaction', transition?.transactionPenalty ?? 0, weights.transaction),
    penaltyContribution('churn', transition?.churnPenalty ?? 0, weights.churn),
    penaltyContribution('recentPurchase', transition?.recentPurchasePenalty ?? 0, weights.recentPurchase),
    penaltyContribution('replacement', transition?.replacementPenalty ?? 0, weights.replacement),
  ], config.layerWeights.transition);
}

function penaltyContribution(key: string, value: number, weight: number): BuildScoreContributionV2 {
  const penalty = clamp01(value);
  return contribution(key, penalty, -penalty, 1, weight);
}

function contribution(
  key: string,
  raw: number,
  normalized: number,
  confidence: number,
  weight: number,
): BuildScoreContributionV2 {
  const safeRaw = finiteOrZero(raw);
  const safeNormalized = clamp11(normalized);
  const safeConfidence = clamp01(confidence);
  const safeWeight = Number.isFinite(weight) ? Math.max(0, weight) : 0;
  return {
    key,
    raw: safeRaw,
    normalized: safeNormalized,
    confidence: safeConfidence,
    weight: safeWeight,
    weighted: safeNormalized * safeConfidence * safeWeight,
  };
}

function layer(
  contributions: readonly BuildScoreContributionV2[],
  layerWeight: number,
): BuildScoreLayerV2 {
  const weightMass = contributions.reduce((sum, entry) => sum + entry.weight, 0);
  if (weightMass <= 0) {
    return { raw: 0, normalized: 0, confidence: 0, weighted: 0, contributions };
  }
  const raw = contributions.reduce((sum, entry) => sum + entry.raw * entry.weight, 0) / weightMass;
  const normalized = clamp11(
    contributions.reduce((sum, entry) => sum + entry.normalized * entry.confidence * entry.weight, 0)
      / weightMass,
  );
  const confidence = clamp01(
    contributions.reduce((sum, entry) => sum + entry.confidence * entry.weight, 0) / weightMass,
  );
  const safeLayerWeight = Number.isFinite(layerWeight) ? Math.max(0, layerWeight) : 0;
  return {
    raw: finiteOrZero(raw),
    normalized,
    confidence,
    weighted: normalized * safeLayerWeight,
    contributions,
  };
}

function phaseAt(gameTimeSec: number): BuildPhaseV2 {
  const config = STATLOCKER_BUILD_V2_CONFIG.itemUtility;
  if (gameTimeSec >= config.phaseLateMinTimeS) return 'LATE';
  if (gameTimeSec >= config.phaseMidMinTimeS) return 'MID';
  return 'EARLY';
}

function normalizeWpa(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return clamp11(Math.tanh(value / Math.max(0.000001, STATLOCKER_BUILD_V2_CONFIG.itemUtility.wpaNormalizationScale)));
}

function shrinkConfidence(sampleSize: number, prior: number): number {
  if (!Number.isFinite(sampleSize) || sampleSize <= 0 || !Number.isFinite(prior) || prior < 0) return 0;
  return clamp01(sampleSize / (sampleSize + prior));
}

function average(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function validateInput(input: BuildItemUtilityV2Input): void {
  if (!Number.isInteger(input.heroId) || input.heroId <= 0) {
    throw new Error('Build item utility v2: heroId must be a positive integer');
  }
  if (!Number.isInteger(input.itemId) || input.itemId <= 0) {
    throw new Error('Build item utility v2: itemId must be a positive integer');
  }
  if (input.archetype.heroId !== input.heroId) {
    throw new Error('Build item utility v2: archetype hero identity mismatch');
  }
  if (!Number.isFinite(input.gameTimeSec) || input.gameTimeSec < 0) {
    throw new Error('Build item utility v2: gameTimeSec must be non-negative');
  }
}

function finiteOrZero(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
}

function clamp11(value: number): number {
  return Math.min(1, Math.max(-1, Number.isFinite(value) ? value : 0));
}
