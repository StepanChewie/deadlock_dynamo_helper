import { Injectable } from '@nestjs/common';
import { AdaptiveDecisionStateV1 } from './adaptive-decision-state-v1.service';
import { EnemyThreatV1Service } from './enemy-threat-v1.service';
import { StatlockerEvidenceBundleV1 } from './statlocker-evidence.service';
import { StatlockerVsHeroWpaRepositoryV1Service } from './statlocker-vs-hero-wpa-repository-v1.service';
import {
  EnemyThreatWeightV1,
  ThreatWeightedMatchupScoreV1,
  ThreatWeightedMatchupV1Service,
} from './threat-weighted-matchup-v1.service';

export type DraftMatchupDegradedReasonV1 = 'RELATIONAL_WPA_QUERY_FAILED';

export interface DraftMatchupEvidenceBundleV1 extends StatlockerEvidenceBundleV1 {
  draftMatchupSnapshotId?: string;
  draftMatchupByItemId: Readonly<Record<string, ThreatWeightedMatchupScoreV1>>;
  draftEnemyThreats: readonly EnemyThreatWeightV1[];
  draftMatchupDegradedReason?: DraftMatchupDegradedReasonV1;
}

@Injectable()
export class DraftMatchupEvidenceV1Service {
  constructor(
    private readonly repository: StatlockerVsHeroWpaRepositoryV1Service,
    private readonly enemyThreat: EnemyThreatV1Service,
    private readonly matchup: ThreatWeightedMatchupV1Service,
  ) {}

  async enrich(
    evidence: StatlockerEvidenceBundleV1,
    decision: AdaptiveDecisionStateV1,
  ): Promise<DraftMatchupEvidenceBundleV1> {
    const enemyHeroIds = [...new Set(decision.enemyHeroIds.filter((heroId) => Number.isInteger(heroId)))]
      .sort((a, b) => a - b);
    const threatScores = this.enemyThreat.scoreEnemies(decision.enemyLiveStates);
    const draftEnemyThreats = threatWeights(threatScores);

    try {
      const rows = await this.repository.findActive({
        statlockerPatchId: evidence.statlockerPatchId,
        rulesetVersion: evidence.rulesetVersion,
        catalogSha256: evidence.catalogSha256,
        ourHeroId: decision.state.heroId,
        enemyHeroIds,
      });
      const itemIds = [...new Set(rows
        .map((row) => Number(row.itemId))
        .filter((itemId) => Number.isSafeInteger(itemId) && itemId > 0))]
        .sort((a, b) => a - b);
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

      const snapshotIds = [...new Set(rows.map((row) => row.snapshotId).filter(Boolean))].sort();
      return {
        ...evidence,
        ...(snapshotIds.length === 1 ? { draftMatchupSnapshotId: snapshotIds[0] } : {}),
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

function threatWeights(
  scores: readonly { heroId: number; threatMultiplier: number }[],
): EnemyThreatWeightV1[] {
  const byHeroId = new Map<number, number>();
  for (const score of scores) {
    if (!Number.isInteger(score.heroId) || byHeroId.has(score.heroId)) continue;
    byHeroId.set(score.heroId, score.threatMultiplier);
  }
  return [...byHeroId.entries()]
    .map(([heroId, threatMultiplier]) => ({ heroId, threatMultiplier }))
    .sort((a, b) => a.heroId - b.heroId);
}
