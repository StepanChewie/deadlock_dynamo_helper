import { SellMatchupProtectionV1Config } from './statlocker-build-v2.config';
import { StatlockerVsHeroWpaAggregateSourceV1 } from './statlocker-vs-hero-wpa-repository-v1.service';

export const FULL_BUILD_MATCHUP_PROTECTION_MAX_ENEMIES_V1 = 5;

export interface FullBuildMatchupProtectionV1Input {
  ourHeroId: number;
  itemId: number;
  enemyHeroIds: readonly number[];
  rows: readonly StatlockerVsHeroWpaAggregateSourceV1[];
}

export interface FullBuildMatchupProtectionV1Result {
  teamWpaPct: number;
  confidence: number;
  coveredEnemyHeroIds: readonly number[];
  protected: boolean;
  reasonCodes: readonly string[];
}

/**
 * Aggregates Statlocker vs-hero WPA evidence across the full (up to five)
 * enemy team and decides whether an item earns sell protection. Pure: rows
 * are passed in and thresholds come only from the SellMatchupProtectionV1Config
 * union supplied by the caller.
 */
export class FullBuildMatchupProtectionV1Service {
  evaluate(
    input: FullBuildMatchupProtectionV1Input,
    config: SellMatchupProtectionV1Config,
  ): FullBuildMatchupProtectionV1Result {
    // De-duplicate preserving first occurrence, then cap at five: coverage is
    // measured against exactly these requested enemies.
    const requestedEnemyHeroIds = [
      ...new Set(input.enemyHeroIds),
    ].slice(0, FULL_BUILD_MATCHUP_PROTECTION_MAX_ENEMIES_V1);
    const requestedSet = new Set(requestedEnemyHeroIds);

    // Keep only rows for this hero-item-enemy triple. Rows may repeat per
    // enemy, so merge them per enemy first; that keeps every row weight
    // bounded by 1 regardless of how raw counts scale.
    const mergedByEnemy = new Map<number, { count: number; weightedDeltaWpa: number }>();
    for (const row of input.rows) {
      if (row.heroId !== input.ourHeroId) continue;
      if (row.itemId !== input.itemId) continue;
      if (!requestedSet.has(row.enemyHeroId)) continue;
      if (!Number.isFinite(row.count) || row.count <= 0) continue;
      if (!Number.isFinite(row.deltaWpa)) continue;
      const merged = mergedByEnemy.get(row.enemyHeroId) ?? {
        count: 0,
        weightedDeltaWpa: 0,
      };
      merged.count += row.count;
      merged.weightedDeltaWpa += row.deltaWpa * row.count;
      mergedByEnemy.set(row.enemyHeroId, merged);
    }

    const coveredRows = [...mergedByEnemy.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([enemyHeroId, merged]) => ({
        enemyHeroId,
        deltaWpa: merged.weightedDeltaWpa / merged.count,
        rowWeight: merged.count / (merged.count + config.shrinkK),
      }));

    let sumRowWeight = 0;
    let weightedWpaSum = 0;
    for (const covered of coveredRows) {
      sumRowWeight += covered.rowWeight;
      weightedWpaSum += covered.deltaWpa * covered.rowWeight;
    }

    const coverage = requestedEnemyHeroIds.length === 0
      ? 0
      : coveredRows.length / requestedEnemyHeroIds.length;
    const meanEvidenceStrength = coveredRows.length === 0
      ? 0
      : sumRowWeight / coveredRows.length;
    const teamWpaPct = sumRowWeight === 0 ? 0 : weightedWpaSum / sumRowWeight;
    const confidence = coverage * meanEvidenceStrength;
    const coveredEnemyHeroIds = coveredRows.map((covered) => covered.enemyHeroId);

    if (!config.enabled) {
      return {
        teamWpaPct,
        confidence,
        coveredEnemyHeroIds,
        protected: false,
        reasonCodes: ['MATCHUP_PROTECTION_UNCALIBRATED'],
      };
    }

    // No requested enemies: nothing to protect against and not an evidence
    // failure, so no insufficiency code.
    if (requestedEnemyHeroIds.length === 0) {
      return {
        teamWpaPct,
        confidence,
        coveredEnemyHeroIds,
        protected: false,
        reasonCodes: [],
      };
    }

    const reasonCodes: string[] = [];
    if (confidence < config.minConfidence) {
      reasonCodes.push('INSUFFICIENT_MATCHUP_EVIDENCE');
    }
    const protectedResult = reasonCodes.length === 0 && teamWpaPct >= config.minTeamWpaPct;
    if (protectedResult) {
      reasonCodes.push('MATCHUP_PROTECTED');
    }

    return {
      teamWpaPct,
      confidence,
      coveredEnemyHeroIds,
      protected: protectedResult,
      reasonCodes,
    };
  }
}
