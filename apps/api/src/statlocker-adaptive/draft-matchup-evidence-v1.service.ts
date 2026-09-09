import { Injectable } from '@nestjs/common';
import { AdaptiveDecisionStateV1 } from './adaptive-decision-state-v1.service';
import { EnemyThreatHistoryV1Service } from './enemy-threat-history-v1.service';
import { EnemyThreatScoreV1, EnemyThreatV1Service } from './enemy-threat-v1.service';
import { ADAPTIVE_POLICY_V1_CONFIG } from './statlocker-adaptive.config';
import { StatlockerEvidenceBundleV1 } from './statlocker-evidence.service';
import {
  StatlockerVsHeroWpaRepositoryV1Service,
} from './statlocker-vs-hero-wpa-repository-v1.service';
import {
  ThreatWeightedMatchupScoreV1,
  ThreatWeightedMatchupV1Service,
} from './threat-weighted-matchup-v1.service';

export interface DraftEnemyThreatV1 {
  heroId: number;
  threatMultiplier: number;
}

export interface DraftMatchupEvidenceBundleV1 extends StatlockerEvidenceBundleV1 {
  draftMatchupSnapshotId?: string;
  draftMatchupByItemId: Readonly<Record<string, ThreatWeightedMatchupScoreV1>>;
  draftEnemyThreats: readonly DraftEnemyThreatV1[];
  draftMatchupDegradedReason?: 'RELATIONAL_WPA_QUERY_FAILED';
}

@Injectable()
export class DraftMatchupEvidenceV1Service {
  constructor(
    private readonly repository: StatlockerVsHeroWpaRepositoryV1Service,
    private readonly enemyThreat: EnemyThreatV1Service,
    private readonly matchup: ThreatWeightedMatchupV1Service,
    private readonly enemyThreatHistory: EnemyThreatHistoryV1Service,
  ) {}

  async enrich(
    evidence: StatlockerEvidenceBundleV1,
    decision: AdaptiveDecisionStateV1,
  ): Promise<DraftMatchupEvidenceBundleV1> {
    const enemyHeroIds = [...new Set(decision.enemyHeroIds)].sort((a, b) => a - b);
    const threatScores = this.enemyThreat.scoreEnemies(decision.enemyLiveStates);
    const smoothedThreat = this.enemyThreatHistory.update({
      matchId: decision.state.matchId,
      scores: threatScores,
      alpha: ADAPTIVE_POLICY_V1_CONFIG.threat.smoothingAlpha,
    });
    const draftEnemyThreats = smoothedThreatWeights(smoothedThreat);

    try {
      const rows = await this.repository.findActive({
        statlockerPatchId: evidence.statlockerPatchId,
        rulesetVersion: evidence.rulesetVersion,
        catalogSha256: evidence.catalogSha256,
        ourHeroId: decision.state.heroId,
        enemyHeroIds,
      });
      const itemIds = [...new Set(rows.map((row) => row.itemId))].sort((a, b) => a - b);
      const draftMatchupByItemId: Record<string, ThreatWeightedMatchupScoreV1> = {};
      for (const itemId of itemIds) {
        draftMatchupByItemId[String(itemId)] = this.matchup.scoreItem({
          ourHeroId: decision.state.heroId,
          itemId,
          enemyHeroIds,
          rows,
          enemyThreats: draftEnemyThreats,
        });
      }

      return {
        ...evidence,
        ...(rows[0]?.snapshotId ? { draftMatchupSnapshotId: rows[0].snapshotId } : {}),
        draftMatchupByItemId,
        draftEnemyThreats,
      };
    } catch {
      return {
        ...evidence,
        draftMatchupByItemId: {},
        draftEnemyThreats,
        draftMatchupDegradedReason: 'RELATIONAL_WPA_QUERY_FAILED',
      };
    }
  }
}

function smoothedThreatWeights(
  entries: ReturnType<EnemyThreatHistoryV1Service['update']>,
): DraftEnemyThreatV1[] {
  const byHero = new Map<number, number[]>();
  for (const entry of entries) {
    const current = byHero.get(entry.score.heroId) ?? [];
    current.push(entry.smoothedThreatMultiplier);
    byHero.set(entry.score.heroId, current);
  }
  return [...byHero.entries()]
    .map(([heroId, values]) => ({
      heroId,
      threatMultiplier: values.reduce((sum, value) => sum + value, 0) / values.length,
    }))
    .sort((a, b) => a.heroId - b.heroId);
}

export function threatWeights(
  scores: readonly EnemyThreatScoreV1[],
): DraftEnemyThreatV1[] {
  const byHero = new Map<number, number[]>();
  for (const score of scores) {
    const current = byHero.get(score.heroId) ?? [];
    current.push(score.threatMultiplier);
    byHero.set(score.heroId, current);
  }
  return [...byHero.entries()]
    .map(([heroId, values]) => ({
      heroId,
      threatMultiplier: values.reduce((sum, value) => sum + value, 0) / values.length,
    }))
    .sort((a, b) => a.heroId - b.heroId);
}
