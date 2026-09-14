export type LiveBuildTraversalState =
  | 'WAITING_FOR_BACKEND'
  | 'WAITING_FOR_LOCAL_PLAYER'
  | 'WAITING_FOR_HERO'
  | 'REFRESHING'
  | 'READY'
  | 'ERROR';

export interface LiveBuildRecommendationItem {
  itemId: number;
  name: string;
  className: string;
  slotType: string;
  cost: number;
  tier: number;
}

export interface LiveBuildRecommendationExplanation {
  code: string;
  evidenceLevel: 'OBSERVED' | 'INFERRED';
  text: string;
}

export interface LiveBuildRecommendationMatchupSignal {
  heroId: number;
  heroName: string;
  direction: 'POSITIVE' | 'NEGATIVE';
  scoreContribution: number;
  contextualPurchaseLiftPercent: number;
  observationCount: number;
}

export interface LiveBuildRecommendationAction {
  type: 'BUY' | 'UPGRADE' | 'SELL' | 'HOLD';
  itemId?: number;
  actionKey: string;
  label: string;
  confidencePercent: number;
  historicalProbabilityPercent: number;
  typicalGameTimeLabel: string;
  item?: LiveBuildRecommendationItem;
  explanation: LiveBuildRecommendationExplanation;
  baseScore?: number;
  contextualScore?: number;
  baseRank?: number;
  contextualRank?: number;
  wasInBaseBuild?: boolean;
  isSituational?: boolean;
  wasPromotedByMatchup?: boolean;
  wasInsertedByMatchup?: boolean;
  situationalAgainstHeroId?: number;
  situationalInteractionOddsRatio?: number;
  situationalLower95OddsRatio?: number;
  matchupObservationCount?: number;
  matchupSignals?: LiveBuildRecommendationMatchupSignal[];
  confidenceSemantic?: 'CANDIDATE_GENERATOR_EVIDENCE';
  valueV6?: {
    rankingModel: 'RECOMMENDATION_VALUE_V6';
    baselineRank: number;
    modelRank?: number;
    actionUtility: number;
    actionAdvantage: number;
    directSupportedActionKeyCount: number;
    totalSupportedActionKeyCount: number;
    supportType: 'DIRECT_ACTION' | 'GENERIC_ONLY' | 'UNSUPPORTED';
  };
}

export interface LiveBuildRecommendationPayload {
  mode: 'EXACT' | 'BACKOFF' | 'NO_MATCH';
  action: LiveBuildRecommendationAction;
  alternatives: LiveBuildRecommendationAction[];
  recommendationModel?:
    | 'RECOMMENDATION_VALUE_V6'
    | 'PRO_BUILD_CANDIDATE_GENERATOR';
  rankingMode?: 'VALUE_V6' | 'CANDIDATE_GENERATOR_FALLBACK';
  rankingSource?: 'RECOMMENDATION_VALUE_V6' | 'CANDIDATE_GENERATOR';
  fallbackReason?: string;
  modelVersion?: string;
  modelSha256?: string;
  candidateId?: string;
  rolloutMode?: 'PRODUCTION';
  buildArchetypeId?: string;
  contextualFeatures?: {
    phase: 'EARLY' | 'MID' | 'LATE';
    alliedHeroIds: number[];
    enemyHeroIds: number[];
    previousActionCount: number;
    archetypeApplied: boolean;
  };
}

export interface LiveBuildRecommendationSnapshot {
  state: LiveBuildTraversalState;
  matchId: string;
  steamId?: string;
  heroId?: number;
  itemIds: number[];
  alliedHeroIds?: number[];
  enemyHeroIds?: number[];
  previousActionKeys?: string[];
  inventoryStateKey?: string;
  gameTimeS?: number;
  timeBucket?: number;
  traversalKey?: string;
  decisionId?: string;
  isStale: boolean;
  recommendation?: LiveBuildRecommendationPayload;
  refreshCount: number;
  cacheHitCount: number;
  discardedResultCount: number;
  lastObservedAt: string;
  lastStartedAt?: string;
  lastUpdatedAt?: string;
  lastError?: string;
}
