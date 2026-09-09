import { Injectable } from '@nestjs/common';
import { ADAPTIVE_POLICY_V1_CONFIG } from './statlocker-adaptive.config';
import { EnemyThreatScoreV1 } from './enemy-threat-v1.service';

export interface EnemyThreatHistoryUpdateV1 {
  matchId: string;
  scores: readonly EnemyThreatScoreV1[];
  alpha: number;
}

export interface EnemyThreatHistoryEntryV1 {
  score: EnemyThreatScoreV1;
  previousThreatMultiplier?: number;
  smoothedThreatMultiplier: number;
  alpha: number;
}

@Injectable()
export class EnemyThreatHistoryV1Service {
  private readonly byMatch = new Map<string, Map<string, number>>();

  update(input: EnemyThreatHistoryUpdateV1): readonly EnemyThreatHistoryEntryV1[] {
    assertAlpha(input.alpha);

    const history = this.byMatch.get(input.matchId) ?? new Map<string, number>();
    this.byMatch.set(input.matchId, history);

    return [...input.scores]
      .sort((a, b) => a.heroId - b.heroId || a.steamId.localeCompare(b.steamId))
      .map((score) => {
        const key = enemyKey(score);
        const currentThreatMultiplier = boundedThreatMultiplier(score.threatMultiplier);
        const previousThreatMultiplier = history.get(key);
        const smoothedThreatMultiplier = previousThreatMultiplier === undefined
          ? currentThreatMultiplier
          : boundedThreatMultiplier(
            input.alpha * currentThreatMultiplier + (1 - input.alpha) * previousThreatMultiplier,
          );

        history.set(key, smoothedThreatMultiplier);

        return {
          score,
          ...(previousThreatMultiplier === undefined ? {} : { previousThreatMultiplier }),
          smoothedThreatMultiplier,
          alpha: input.alpha,
        };
      });
  }

  clearMatch(matchId: string): void {
    this.byMatch.delete(matchId);
  }
}

function enemyKey(score: EnemyThreatScoreV1): string {
  return `${score.heroId}:${score.steamId}`;
}

function assertAlpha(alpha: number): void {
  if (!Number.isFinite(alpha) || alpha <= 0 || alpha > 1) {
    throw new Error('Enemy threat smoothing alpha must be in (0, 1]');
  }
}

function boundedThreatMultiplier(value: number): number {
  const neutral = Number.isFinite(value) ? value : 1;
  return Math.min(
    ADAPTIVE_POLICY_V1_CONFIG.threat.maxMultiplier,
    Math.max(ADAPTIVE_POLICY_V1_CONFIG.threat.minMultiplier, neutral),
  );
}
