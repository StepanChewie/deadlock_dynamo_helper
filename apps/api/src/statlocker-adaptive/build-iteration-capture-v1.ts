import { AdaptiveEvidenceSummaryV2 } from '@dynamo-lab/shared';
import { EnemyThreatScoreV1 } from './enemy-threat-v1.service';
import { BuildDecisionTraceStageEntryV2 } from './build-decision-trace-v2';

/**
 * Request-scoped carrier: the recommendation service drops the objects it
 * already holds here, the controller writes them to the history table.
 */
export class BuildIterationCaptureV1 {
  steamId?: string;
  heroId?: number;
  gameTimeSec?: number;
  capacity?: number;
  inventoryItemIds?: readonly number[];
  spendableSouls?: number;
  enemyHeroIds?: readonly number[];
  enemyThreats?: readonly EnemyThreatScoreV1[];
  archetype?: { archetypeId: string; snapshotId: string; scores: readonly { archetypeId: string; score: number; confidence: number }[] };
  evidence?: AdaptiveEvidenceSummaryV2;
  stages?: readonly BuildDecisionTraceStageEntryV2[];
}
