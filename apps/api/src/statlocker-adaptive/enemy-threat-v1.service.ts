import { Injectable } from '@nestjs/common';
import { AdaptiveEnemyLiveStateV1 } from './adaptive-decision-state-v1.service';
import { ADAPTIVE_POLICY_V1_CONFIG } from './statlocker-adaptive.config';

export type EnemyThreatReasonCodeV1 =
  | 'NO_LIVE_THREAT_SIGNALS'
  | 'PARTIAL_LIVE_THREAT_SIGNALS'
  | 'THREAT_CLAMPED_LOW'
  | 'THREAT_CLAMPED_HIGH';

export interface EnemyThreatComponentV1 {
  rawValue?: number;
  teamMean?: number;
  relativeValue?: number;
  weight: number;
  contribution: number;
  observed: boolean;
}

export interface EnemyThreatComponentsV1 {
  souls: EnemyThreatComponentV1;
  heroDamage: EnemyThreatComponentV1;
  killsAssists: EnemyThreatComponentV1;
  level: EnemyThreatComponentV1;
  deaths: EnemyThreatComponentV1;
}

export interface EnemyThreatScoreV1 {
  steamId: string;
  heroId: number;
  heroName?: string;
  rawThreatScore: number;
  threatMultiplier: number;
  completeness: number;
  components: EnemyThreatComponentsV1;
  reasonCodes: readonly EnemyThreatReasonCodeV1[];
}

type ThreatSignalKeyV1 = keyof EnemyThreatComponentsV1;

type PreparedEnemyThreatSignalsV1 = {
  enemy: AdaptiveEnemyLiveStateV1;
  values: Record<ThreatSignalKeyV1, number | undefined>;
};

@Injectable()
export class EnemyThreatV1Service {
  scoreEnemies(enemies: readonly AdaptiveEnemyLiveStateV1[]): readonly EnemyThreatScoreV1[] {
    const config = ADAPTIVE_POLICY_V1_CONFIG.threat;
    const prepared = [...enemies]
      .map((enemy) => ({
        enemy,
        values: {
          souls: finiteNonNegative(enemy.souls),
          heroDamage: finiteNonNegative(enemy.heroDamage),
          killsAssists: killsAssistsValue(enemy),
          level: finiteNonNegative(enemy.level),
          deaths: finiteNonNegative(enemy.deaths),
        },
      }))
      .sort((a, b) => a.enemy.heroId - b.enemy.heroId || a.enemy.steamId.localeCompare(b.enemy.steamId));

    const means = {
      souls: observedMean(prepared, 'souls'),
      heroDamage: observedMean(prepared, 'heroDamage'),
      killsAssists: observedMean(prepared, 'killsAssists'),
      level: observedMean(prepared, 'level'),
      deaths: observedMean(prepared, 'deaths'),
    } satisfies Record<ThreatSignalKeyV1, number | undefined>;

    const weights = config.weights;
    const totalWeight = Object.values(weights).reduce((sum, weight) => sum + Math.abs(weight), 0);

    return prepared.map(({ enemy, values }) => {
      const components: EnemyThreatComponentsV1 = {
        souls: component(values.souls, means.souls, weights.souls),
        heroDamage: component(values.heroDamage, means.heroDamage, weights.heroDamage),
        killsAssists: component(values.killsAssists, means.killsAssists, weights.killsAssists),
        level: component(values.level, means.level, weights.level),
        deaths: component(values.deaths, means.deaths, weights.deaths),
      };
      const observedWeight = (Object.values(components) as EnemyThreatComponentV1[])
        .reduce((sum, entry) => sum + (entry.observed ? Math.abs(entry.weight) : 0), 0);
      const completeness = totalWeight > 0 ? clamp01(observedWeight / totalWeight) : 0;
      const contribution = (Object.values(components) as EnemyThreatComponentV1[])
        .reduce((sum, entry) => sum + entry.contribution, 0);
      const rawThreatScore = finiteOrNeutral(1 + contribution);
      const threatMultiplier = clamp(rawThreatScore, config.minMultiplier, config.maxMultiplier);
      const reasonCodes: EnemyThreatReasonCodeV1[] = [];

      if (completeness === 0) reasonCodes.push('NO_LIVE_THREAT_SIGNALS');
      else if (completeness < 1) reasonCodes.push('PARTIAL_LIVE_THREAT_SIGNALS');
      if (rawThreatScore < config.minMultiplier) reasonCodes.push('THREAT_CLAMPED_LOW');
      if (rawThreatScore > config.maxMultiplier) reasonCodes.push('THREAT_CLAMPED_HIGH');

      return {
        steamId: enemy.steamId,
        heroId: enemy.heroId,
        ...(enemy.heroName ? { heroName: enemy.heroName } : {}),
        rawThreatScore,
        threatMultiplier,
        completeness,
        components,
        reasonCodes,
      };
    });
  }
}

function killsAssistsValue(enemy: AdaptiveEnemyLiveStateV1): number | undefined {
  const kills = finiteNonNegative(enemy.kills);
  const assists = finiteNonNegative(enemy.assists);
  if (kills === undefined || assists === undefined) return undefined;
  return kills + assists;
}

function observedMean(
  prepared: readonly PreparedEnemyThreatSignalsV1[],
  key: ThreatSignalKeyV1,
): number | undefined {
  const values = prepared
    .map((entry) => entry.values[key])
    .filter((value): value is number => value !== undefined);
  if (values.length === 0) return undefined;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Number.isFinite(mean) ? mean : undefined;
}

function component(
  rawValue: number | undefined,
  teamMean: number | undefined,
  weight: number,
): EnemyThreatComponentV1 {
  if (rawValue === undefined) {
    return {
      ...(teamMean === undefined ? {} : { teamMean }),
      weight,
      contribution: 0,
      observed: false,
    };
  }

  const relativeValue = teamMean !== undefined && teamMean > 0
    ? finiteOrNeutral(rawValue / teamMean)
    : 1;
  const contribution = finiteOrZero(weight * (relativeValue - 1));
  return {
    rawValue,
    ...(teamMean === undefined ? {} : { teamMean }),
    relativeValue,
    weight,
    contribution,
    observed: true,
  };
}

function finiteNonNegative(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function finiteOrNeutral(value: number): number {
  return Number.isFinite(value) ? value : 1;
}

function finiteOrZero(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
