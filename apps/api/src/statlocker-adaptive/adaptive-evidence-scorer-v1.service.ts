import { Injectable } from '@nestjs/common';
import { FactEvidence } from '@deadlock-live-probe/build-domain';
import { AdaptiveScoreComponentV1 } from '@deadlock-live-probe/shared';
import { ADAPTIVE_POLICY_V1_CONFIG } from './statlocker-adaptive.config';
import {
  ConsensusSkeletonV1,
  StatlockerT4ChainsV1,
  StatlockerVsHeroSliceV1,
  StatlockerWpaItemV1,
  StatlockerWpaPatchDataV1,
} from './statlocker-adaptive.types';
import { StatlockerEvidenceBundleV1 } from './statlocker-evidence.service';
import { AdaptiveGameStateBlendV1 } from './adaptive-game-state';
import { findConsensusCandidateV1 } from './structured-build-v1';
import { ThreatWeightedMatchupScoreV1 } from './threat-weighted-matchup-v1.service';

export interface AdaptiveInvestmentDeltaV1 {
  evidence: FactEvidence;
  breakpointsCrossed: number;
  distanceReducedSouls: number;
  achievedBreakpointsLost: number;
}

export interface AdaptiveSlotDeltaV1 {
  flexUsedBefore: number;
  flexUsedAfter: number;
  slotsFreed: number;
}

export interface AdaptiveItemScoreContextV1 {
  heroId: number;
  enemyHeroIds: readonly number[];
  gameTimeSec: number;
  gameStateBlend: AdaptiveGameStateBlendV1;
  ownedItemIds: readonly number[];
  plannedPrefixItemIds: readonly number[];
  evidence: StatlockerEvidenceBundleV1;
  enemyCompositionKey?: string;
  ownBuildArchetype?: string;
  transactionPenalty?: number;
  churnPenalty?: number;
  investmentDelta?: AdaptiveInvestmentDeltaV1;
  slotDelta?: AdaptiveSlotDeltaV1;
}

export interface AdaptiveItemScoreV1 {
  itemId: number;
  score: number;
  confidence: number;
  completeness: number;
  components: readonly AdaptiveScoreComponentV1[];
  version: 'adaptive-evidence-scorer-v1';
}

export interface ExactEnemyContributionV1 {
  enemyHeroId: number;
  deltaWpa: number;
  sampleSize: number;
  confidence: number;
  normalized: number;
  priority: number;
}

export interface ExactEnemyAggregateV1 {
  raw: number;
  normalized: number;
  confidence: number;
  usedCount: number;
  contributions: readonly ExactEnemyContributionV1[];
}

interface EvidenceWithDraftMatchupV1 extends StatlockerEvidenceBundleV1 {
  draftMatchupByItemId?: Readonly<Record<string, ThreatWeightedMatchupScoreV1>>;
}

@Injectable()
export class AdaptiveEvidenceScorerV1Service {
  readonly version = 'adaptive-evidence-scorer-v1' as const;

  scoreItem(itemId: number, context: AdaptiveItemScoreContextV1): AdaptiveItemScoreV1 {
    const config = ADAPTIVE_POLICY_V1_CONFIG;
    const wpaFamily = context.evidence.byDataset.WPA_PATCH_DATA;
    const chainFamily = context.evidence.byDataset.T4_CHAINS;
    const skeletonFamily = context.evidence.byDataset.CONSENSUS_SKELETON;
    const wpa = asWpaPatchData(wpaFamily.payload)?.items.find(
      (entry) => entry.heroId === context.heroId && entry.itemId === itemId,
    );
    const skeleton = asSkeleton(skeletonFamily.payload, context.heroId);
    const structuredCandidate = findConsensusCandidateV1(skeleton, itemId);
    const skeletonStrength = structuredCandidate?.strength;
    const skeletonMedianBuyTimeS = structuredCandidate?.medianBuyTimeS;
    const components: AdaptiveScoreComponentV1[] = [];

    components.push(makeComponent(
      'skeletonPrior',
      skeletonStrength ?? 0,
      skeletonStrength === undefined ? 0 : skeletonStrength * 2 - 1,
      skeletonStrength === undefined ? 0 : skeletonFamily.confidence,
      config.weights.skeletonPrior,
    ));

    const baseConfidence = wpa
      ? shrinkConfidenceV1(wpa.sampleSize, config.shrinkK.baseWpa) * clamp01(wpa.wpaConfidence ?? 1) * wpaFamily.confidence
      : 0;
    components.push(makeComponent(
      'baseWpa',
      wpa?.meanWpa ?? 0,
      normalizeWpa(wpa?.meanWpa ?? 0),
      baseConfidence,
      config.weights.baseWpa,
    ));

    const gameStateRaw = wpa ? blendedGameStateWpa(wpa, context.gameStateBlend) : 0;
    const gameStateConfidence = wpa
      ? shrinkConfidenceV1(wpa.sampleSize, config.shrinkK.gameState) * wpaFamily.confidence
      : 0;
    components.push(makeComponent(
      'gameStateFit',
      gameStateRaw,
      normalizeWpa(gameStateRaw),
      gameStateConfidence,
      config.weights.gameStateFit,
    ));

    const draftMatchup = draftMatchupForItemV1(context.evidence, itemId);
    components.push(makeComponent(
      'draftMatchupFit',
      draftMatchup?.raw ?? 0,
      draftMatchup?.normalized ?? 0,
      draftMatchup?.confidence ?? 0,
      config.weights.exactEnemyFit,
    ));

    const enemyCompositionRaw = optionalBreakdownValue(wpa?.enemyComposition, context.enemyCompositionKey);
    components.push(makeComponent(
      'enemyCompositionFit',
      enemyCompositionRaw ?? 0,
      normalizeWpa(enemyCompositionRaw ?? 0),
      enemyCompositionRaw === undefined ? 0 : baseConfidence,
      config.weights.enemyCompositionFit,
    ));

    const ownBuildRaw = optionalBreakdownValue(wpa?.ownBuild, context.ownBuildArchetype);
    components.push(makeComponent(
      'ownBuildFit',
      ownBuildRaw ?? 0,
      normalizeWpa(ownBuildRaw ?? 0),
      ownBuildRaw === undefined ? 0 : baseConfidence,
      config.weights.ownBuildFit,
    ));

    const medianPurchaseSec = wpa?.purchaseTiming.medianPurchaseSec ?? skeletonMedianBuyTimeS;
    const timingNormalized = medianPurchaseSec === undefined
      ? 0
      : clamp11(2 * Math.exp(-Math.abs(context.gameTimeSec - medianPurchaseSec) / 900) - 1);
    components.push(makeComponent(
      'timingFit',
      medianPurchaseSec === undefined ? 0 : context.gameTimeSec - medianPurchaseSec,
      timingNormalized,
      medianPurchaseSec === undefined ? 0 : Math.max(baseConfidence, skeletonStrength === undefined ? 0 : skeletonFamily.confidence),
      config.weights.timingFit,
    ));

    const laneRaw = context.gameTimeSec <= 600 ? wpa?.laneWpa : wpa?.postLaneWpa;
    components.push(makeComponent(
      'laneFit',
      laneRaw ?? 0,
      normalizeWpa(laneRaw ?? 0),
      laneRaw === undefined ? 0 : baseConfidence,
      config.weights.laneFit,
    ));

    const chain = scoreChainFit(
      asT4Chains(chainFamily.payload),
      context.heroId,
      itemId,
      [...context.ownedItemIds, ...context.plannedPrefixItemIds],
      config.shrinkK.chain,
    );
    components.push(makeComponent(
      'chainFit',
      chain.raw,
      chain.normalized,
      chain.confidence * chainFamily.confidence,
      config.weights.chainFit,
    ));

    components.push(makeComponent(
      'skeletonDeviation',
      skeletonStrength === undefined ? 1 : 0,
      skeleton && skeletonStrength === undefined ? -1 : 0,
      skeleton ? skeletonFamily.confidence : 0,
      config.weights.skeletonDeviation,
    ));

    const investment = investmentUtilityV1(context.investmentDelta);
    components.push(makeComponent(
      'investmentUtility',
      investment,
      investment,
      context.investmentDelta?.evidence === 'UNKNOWN' || context.investmentDelta === undefined ? 0 : 1,
      config.weights.investmentUtility,
    ));

    const slotEfficiency = slotEfficiencyV1(context.slotDelta);
    components.push(makeComponent(
      'slotEfficiency',
      slotEfficiency,
      slotEfficiency,
      context.slotDelta === undefined ? 0 : 1,
      config.weights.slotEfficiency,
    ));

    components.push(makeComponent(
      'transaction',
      clamp01(context.transactionPenalty ?? 0),
      -clamp01(context.transactionPenalty ?? 0),
      1,
      config.weights.transaction,
    ));
    components.push(makeComponent(
      'churn',
      clamp01(context.churnPenalty ?? 0),
      -clamp01(context.churnPenalty ?? 0),
      1,
      config.weights.churn,
    ));

    const score = components.reduce((sum, component) => sum + component.weighted, 0);
    const evidenceComponents = components.filter((component) =>
      component.key !== 'transaction' &&
      component.key !== 'churn' &&
      !(component.key === 'investmentUtility' && context.investmentDelta === undefined) &&
      !(component.key === 'slotEfficiency' && context.slotDelta === undefined),
    );
    const present = evidenceComponents.filter((component) => component.confidence > 0);
    const completeness = evidenceComponents.length === 0 ? 0 : present.length / evidenceComponents.length;
    const meanConfidence = present.length === 0
      ? 0
      : present.reduce((sum, component) => sum + component.confidence, 0) / present.length;
    const coherence = signalCoherence(present);
    const confidence = clamp01(meanConfidence * completeness * (0.6 + 0.4 * coherence));

    return {
      itemId,
      score,
      confidence,
      completeness,
      components,
      version: this.version,
    };
  }
}

export function investmentUtilityV1(delta: AdaptiveInvestmentDeltaV1 | undefined): number {
  if (!delta || delta.evidence === 'UNKNOWN') return 0;
  const config = ADAPTIVE_POLICY_V1_CONFIG.investment;
  const nearProgress = clamp01(
    Math.max(0, delta.distanceReducedSouls) / Math.max(1, config.nearBreakpointMaxSouls),
  );
  return clamp11(
    Math.max(0, delta.breakpointsCrossed) * config.crossingBonus +
    nearProgress * config.nearBreakpointBonus -
    Math.max(0, delta.achievedBreakpointsLost) * config.achievedBreakpointDropPenalty,
  );
}

export function slotEfficiencyV1(delta: AdaptiveSlotDeltaV1 | undefined): number {
  if (!delta) return 0;
  const flexRelief = delta.flexUsedBefore - delta.flexUsedAfter;
  return clamp11(flexRelief * 0.35 + Math.max(0, delta.slotsFreed) * 0.20);
}

export function shrinkConfidenceV1(sampleSize: number, k: number): number {
  if (!Number.isFinite(sampleSize) || sampleSize <= 0 || !Number.isFinite(k) || k < 0) return 0;
  return clamp01(sampleSize / (sampleSize + k));
}

export function aggregateExactEnemyEvidenceV1(
  slices: readonly StatlockerVsHeroSliceV1[],
  heroId: number,
  itemId: number,
  enemyHeroIds: readonly number[],
  maxMatchups: number,
  shrinkK: number,
): ExactEnemyAggregateV1 {
  const enemySet = new Set(enemyHeroIds);
  const contributions: ExactEnemyContributionV1[] = slices
    .filter((slice) => slice.heroId === heroId && enemySet.has(slice.enemyHeroId))
    .map((slice) => {
      const item = slice.items.find((entry) => entry.itemId === itemId);
      if (!item) return undefined;
      const confidence = shrinkConfidenceV1(item.count, shrinkK);
      const normalized = normalizeWpa(item.deltaWpa);
      return {
        enemyHeroId: slice.enemyHeroId,
        deltaWpa: item.deltaWpa,
        sampleSize: item.count,
        normalized,
        confidence,
        priority: Math.abs(normalized * confidence),
      };
    })
    .filter((entry): entry is ExactEnemyContributionV1 => entry !== undefined)
    .sort((a, b) => b.priority - a.priority || b.confidence - a.confidence || a.enemyHeroId - b.enemyHeroId)
    .slice(0, Math.max(0, Math.floor(maxMatchups)));

  if (contributions.length === 0) {
    return { raw: 0, normalized: 0, confidence: 0, usedCount: 0, contributions: [] };
  }
  const confidenceSum = contributions.reduce((sum, entry) => sum + entry.confidence, 0);
  if (confidenceSum <= 0) {
    return { raw: 0, normalized: 0, confidence: 0, usedCount: contributions.length, contributions };
  }
  return {
    raw: contributions.reduce((sum, entry) => sum + entry.deltaWpa * entry.confidence, 0) / confidenceSum,
    normalized: clamp11(
      contributions.reduce((sum, entry) => sum + entry.normalized * entry.confidence, 0) / confidenceSum,
    ),
    confidence: clamp01(confidenceSum / contributions.length),
    usedCount: contributions.length,
    contributions,
  };
}

export function exactEnemySlicesFromEvidenceV1(value: unknown): readonly StatlockerVsHeroSliceV1[] {
  return asExactSlices(value);
}

function draftMatchupForItemV1(
  evidence: StatlockerEvidenceBundleV1,
  itemId: number,
): ThreatWeightedMatchupScoreV1 | undefined {
  return (evidence as EvidenceWithDraftMatchupV1).draftMatchupByItemId?.[String(itemId)];
}

function scoreChainFit(
  chains: StatlockerT4ChainsV1 | undefined,
  heroId: number,
  itemId: number,
  prefixItemIds: readonly number[],
  shrinkK: number,
): { raw: number; normalized: number; confidence: number } {
  if (!chains) return { raw: 0, normalized: 0, confidence: 0 };
  const prefix = new Set(prefixItemIds);
  const matches = chains.chains
    .filter((chain) =>
      chain.heroId === heroId &&
      chain.itemIds[chain.itemIds.length - 1] === itemId &&
      chain.itemIds.slice(0, -1).every((chainItemId) => prefix.has(chainItemId)),
    )
    .map((chain) => ({
      raw: chain.meanWpa ?? 0.05,
      normalized: chain.meanWpa === undefined ? 0.35 : normalizeWpa(chain.meanWpa),
      confidence: shrinkConfidenceV1(chain.sampleSize, shrinkK),
      sampleSize: chain.sampleSize,
    }))
    .sort((a, b) => b.confidence * Math.abs(b.normalized) - a.confidence * Math.abs(a.normalized) || b.sampleSize - a.sampleSize);
  const best = matches[0];
  return best ?? { raw: 0, normalized: 0, confidence: 0 };
}

function blendedGameStateWpa(item: StatlockerWpaItemV1, blend: AdaptiveGameStateBlendV1): number {
  const ahead = item.gameState.ahead ?? 0;
  const even = item.gameState.even ?? 0;
  const behind = item.gameState.behind ?? 0;
  return ahead * clamp01(blend.ahead) + even * clamp01(blend.even) + behind * clamp01(blend.behind);
}

function optionalBreakdownValue(
  values: Readonly<Record<string, number>> | undefined,
  key: string | undefined,
): number | undefined {
  if (!values || !key) return undefined;
  const value = values[key];
  return Number.isFinite(value) ? value : undefined;
}

function makeComponent(
  key: string,
  raw: number,
  normalized: number,
  confidence: number,
  weight: number,
): AdaptiveScoreComponentV1 {
  const bounded = clamp11(normalized);
  const boundedConfidence = clamp01(confidence);
  return {
    key,
    raw: Number.isFinite(raw) ? raw : 0,
    normalized: bounded,
    confidence: boundedConfidence,
    weight,
    weighted: bounded * boundedConfidence * weight,
  };
}

function signalCoherence(components: readonly AdaptiveScoreComponentV1[]): number {
  const strong = components.filter((component) => component.confidence >= 0.35 && Math.abs(component.normalized) >= 0.1);
  if (strong.length <= 1) return 1;
  const signed = strong.reduce((sum, component) => sum + component.normalized * component.confidence, 0);
  const absolute = strong.reduce((sum, component) => sum + Math.abs(component.normalized) * component.confidence, 0);
  return absolute <= 0 ? 1 : clamp01(Math.abs(signed) / absolute);
}

function normalizeWpa(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return clamp11(Math.tanh(value / 0.15));
}

function asWpaPatchData(value: unknown): StatlockerWpaPatchDataV1 | undefined {
  if (!isRecord(value) || typeof value.patchId !== 'string' || !Array.isArray(value.items)) return undefined;
  return value as unknown as StatlockerWpaPatchDataV1;
}

function asExactSlices(value: unknown): readonly StatlockerVsHeroSliceV1[] {
  if (!isRecord(value) || !Array.isArray(value.slices)) return [];
  return value.slices as unknown as readonly StatlockerVsHeroSliceV1[];
}

function asT4Chains(value: unknown): StatlockerT4ChainsV1 | undefined {
  if (!isRecord(value) || !Array.isArray(value.chains)) return undefined;
  return value as unknown as StatlockerT4ChainsV1;
}

function asSkeleton(value: unknown, heroId: number): ConsensusSkeletonV1 | undefined {
  if (!isRecord(value) || value.heroId !== heroId) return undefined;
  if (!Array.isArray(value.groups)) return undefined;
  return value as unknown as ConsensusSkeletonV1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function clamp11(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-1, Math.min(1, value));
}
