import { AdaptiveArchetypeLockSummaryV2 } from './adaptive-recommendation-v2';

export interface AdaptiveSituationalTargetV2 {
  enemyHeroId: number;
  deltaWpa: number;
  count: number;
}

export interface AdaptiveSituationalItemV2 {
  itemId: number;
  score: number;
  confidence: number;
  coverage: number;
  against: readonly AdaptiveSituationalTargetV2[];
}

export interface AdaptiveSituationalResultV2 {
  /** Discriminator: the client narrows on this instead of guessing from shape. */
  mode: 'situational';
  ready: boolean;
  blockers: readonly string[];
  decisionId: string;
  stateRevision: string;
  heroId?: number;
  lock?: AdaptiveArchetypeLockSummaryV2;
  situationalItems: readonly AdaptiveSituationalItemV2[];
  degradedReasons: readonly string[];
}
