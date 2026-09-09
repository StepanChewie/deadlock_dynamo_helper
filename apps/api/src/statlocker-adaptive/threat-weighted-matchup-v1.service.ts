import { Injectable } from '@nestjs/common';
import { ADAPTIVE_POLICY_V1_CONFIG } from './statlocker-adaptive.config';
import {
  StatlockerVsHeroWpaAggregateSourceV1,
  aggregateStatlockerVsHeroWpaRowsV1,
} from './statlocker-vs-hero-wpa-repository-v1.service';

export interface EnemyThreatWeightV1 {
  heroId: number;
  threatMultiplier: number;
}

export interface ThreatWeightedMatchupInputV1 {
  ourHeroId: number;
  itemId: number;
  enemyHeroIds: readonly number[];
  rows: readonly StatlockerVsHeroWpaAggregateSourceV1[];
  enemyThreats: readonly EnemyThreatWeightV1[];
}

export interface ThreatWeightedMatchupContributionV1 {
  enemyHeroId: number;
  rawDeltaWpa: number;
  count: number;
  sampleConfidence: number;
  effectiveDeltaWpa: number;
  normalizedEffectiveDelta: number;
  threatMultiplier: number;
  weightedContribution: number;
}

export interface ThreatWeightedMatchupScoreV1 {
  raw: number;
  normalized: number;
  confidence: number;
  coverage: number;
  usedCount: number;
  contributions: readonly ThreatWeightedMatchupContributionV1[];
}

const WPA_NORMALIZATION_SCALE_V1 = 0.15;

@Injectable()
export class ThreatWeightedMatchupV1Service {
  scoreItem(input: ThreatWeightedMatchupInputV1): ThreatWeightedMatchupScoreV1 {
    const enemyHeroIds = [...new Set(input.enemyHeroIds.filter((heroId) => Number.isInteger(heroId)))]
      .sort((a, b) => a - b);
    if (enemyHeroIds.length === 0) return emptyScore();

    const enemySet = new Set(enemyHeroIds);
    const threatByHeroId = threatWeights(enemyHeroIds, input.enemyThreats);
    const totalThreatWeight = enemyHeroIds
      .reduce((sum, enemyHeroId) => sum + (threatByHeroId.get(enemyHeroId) ?? 1), 0);
    if (totalThreatWeight <= 0) return emptyScore();

    const shrinkK = ADAPTIVE_POLICY_V1_CONFIG.shrinkK.exactEnemy;
    const contributions = aggregateStatlockerVsHeroWpaRowsV1(input.rows)
      .filter((row) =>
        row.heroId === input.ourHeroId &&
        row.itemId === input.itemId &&
        enemySet.has(row.enemyHeroId),
      )
      .map((row): ThreatWeightedMatchupContributionV1 => {
        const sampleConfidence = shrinkConfidence(row.count, shrinkK);
        const effectiveDeltaWpa = finiteOrZero(row.deltaWpa * sampleConfidence);
        const normalizedEffectiveDelta = normalizeWpa(effectiveDeltaWpa);
        const threatMultiplier = threatByHeroId.get(row.enemyHeroId) ?? 1;
        return {
          enemyHeroId: row.enemyHeroId,
          rawDeltaWpa: row.deltaWpa,
          count: row.count,
          sampleConfidence,
          effectiveDeltaWpa,
          normalizedEffectiveDelta,
          threatMultiplier,
          weightedContribution: normalizedEffectiveDelta * threatMultiplier,
        };
      })
      .sort((a, b) => a.enemyHeroId - b.enemyHeroId);

    if (contributions.length === 0) return emptyScore();

    const evidenceThreatWeight = contributions
      .reduce((sum, entry) => sum + entry.threatMultiplier, 0);
    const raw = contributions.reduce(
      (sum, entry) => sum + entry.effectiveDeltaWpa * entry.threatMultiplier,
      0,
    ) / totalThreatWeight;
    const normalized = contributions.reduce(
      (sum, entry) => sum + entry.weightedContribution,
      0,
    ) / totalThreatWeight;
    const confidence = contributions.reduce(
      (sum, entry) => sum + entry.sampleConfidence * entry.threatMultiplier,
      0,
    ) / totalThreatWeight;

    return {
      raw: finiteOrZero(raw),
      normalized: clamp(normalized, -1, 1),
      confidence: clamp(confidence, 0, 1),
      coverage: clamp(evidenceThreatWeight / totalThreatWeight, 0, 1),
      usedCount: contributions.length,
      contributions,
    };
  }
}

function threatWeights(
  enemyHeroIds: readonly number[],
  supplied: readonly EnemyThreatWeightV1[],
): Map<number, number> {
  const allowed = new Set(enemyHeroIds);
  const values = new Map<number, number>();
  for (const entry of supplied) {
    if (!allowed.has(entry.heroId) || values.has(entry.heroId)) continue;
    values.set(entry.heroId, boundedThreat(entry.threatMultiplier));
  }
  for (const enemyHeroId of enemyHeroIds) {
    if (!values.has(enemyHeroId)) values.set(enemyHeroId, 1);
  }
  return values;
}

function boundedThreat(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return clamp(
    value,
    ADAPTIVE_POLICY_V1_CONFIG.threat.minMultiplier,
    ADAPTIVE_POLICY_V1_CONFIG.threat.maxMultiplier,
  );
}

function shrinkConfidence(sampleSize: number, k: number): number {
  if (!Number.isFinite(sampleSize) || sampleSize <= 0 || !Number.isFinite(k) || k < 0) return 0;
  return clamp(sampleSize / (sampleSize + k), 0, 1);
}

function normalizeWpa(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return clamp(Math.tanh(value / WPA_NORMALIZATION_SCALE_V1), -1, 1);
}

function emptyScore(): ThreatWeightedMatchupScoreV1 {
  return {
    raw: 0,
    normalized: 0,
    confidence: 0,
    coverage: 0,
    usedCount: 0,
    contributions: [],
  };
}

function finiteOrZero(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
