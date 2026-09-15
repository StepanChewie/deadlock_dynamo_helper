import { AdaptiveEvidenceFreshnessV1 } from '@dynamo-lab/shared';

export type StatlockerDatasetV1 =
  | 'WPA_PATCH_DATA'
  | 'VS_HERO_WPA'
  | 'T4_CHAINS'
  | 'HERO_LEADERBOARD'
  | 'PRO_BUILD_ANALYSIS'
  | 'WPA_FILTERED_ITEMS'
  | 'CONSENSUS_SKELETON';

export interface StatlockerPatchControlV1 {
  currentMinorPatchId: string;
  availableMinorPatchIds: readonly string[];
}

export interface StatlockerGameStateWpaV1 {
  ahead?: number;
  even?: number;
  behind?: number;
}

export interface StatlockerPurchaseTimingV1 {
  medianPurchaseSec?: number;
  earlyWpa?: number;
  midWpa?: number;
  lateWpa?: number;
}

export interface StatlockerWpaItemV1 {
  heroId: number;
  itemId: number;
  meanWpa: number;
  sampleSize: number;
  wpaConfidence?: number;
  gameState: StatlockerGameStateWpaV1;
  purchaseTiming: StatlockerPurchaseTimingV1;
  laneWpa?: number;
  postLaneWpa?: number;
  enemyComposition?: Readonly<Record<string, number>>;
  ownBuild?: Readonly<Record<string, number>>;
}

export interface StatlockerWpaPatchDataV1 {
  patchId: string;
  items: readonly StatlockerWpaItemV1[];
}

export interface StatlockerHeroItemLifecycleV1 {
  heroId: number;
  itemId: number;
  generalWpa: number;
  averagePurchaseTimeS: number;
  sampleSize?: number;
}

export interface StatlockerVsHeroItemV1 {
  itemId: number;
  deltaWpa: number;
  count: number;
}

export interface StatlockerVsHeroSliceV1 {
  heroId: number;
  enemyHeroId: number;
  items: readonly StatlockerVsHeroItemV1[];
}

export interface StatlockerVsHeroWpaV1 {
  slices: readonly StatlockerVsHeroSliceV1[];
}

export interface StatlockerT4ChainV1 {
  heroId: number;
  itemIds: readonly number[];
  sampleSize: number;
  meanWpa?: number;
}

export interface StatlockerT4ChainsV1 {
  chains: readonly StatlockerT4ChainV1[];
}

export interface StatlockerLeaderboardProfileV1 {
  accountId: string;
  heroId: number;
  rank: number;
  playerName?: string;
}

export interface StatlockerHeroLeaderboardV1 {
  heroId: number;
  profiles: readonly StatlockerLeaderboardProfileV1[];
}

export type StatlockerFrequencyTierV1 = 'CORE' | 'FREQUENT' | 'SOMETIMES' | 'FLEX';
export type ConsensusBuildPhaseV1 = 'EARLY' | 'MID' | 'LATE';
export type ConsensusBuildGroupTypeV1 = 'REQUIRED' | 'CHOICE' | 'OPTIONAL';

export interface StatlockerProItemRelationshipV1 {
  itemId: number;
  strength: number;
}

export interface StatlockerProBuildExplicitGroupV1 {
  type: ConsensusBuildGroupTypeV1;
  groupKey: string;
  minSelect: number;
  maxSelect: number;
}

export interface StatlockerProBuildItemV1 {
  itemId: number;
  purchaseRate: number;
  medianBuyTimeS: number;
  frequencyTier: StatlockerFrequencyTierV1;
  phase: ConsensusBuildPhaseV1;
  relationships: readonly StatlockerProItemRelationshipV1[];
  explicitGroup?: StatlockerProBuildExplicitGroupV1;
}

export interface StatlockerProBuildAnalysisV1 {
  accountId: string;
  heroId: number;
  items: readonly StatlockerProBuildItemV1[];
}

export interface StatlockerWpaFilteredItemsV1 {
  heroId: number;
  items: readonly StatlockerHeroItemLifecycleV1[];
}

export interface ConsensusSkeletonComponentV1 {
  coverage: number;
  purchaseRate: number;
  frequencyTier: number;
  orderConsistency: number;
  relationship: number;
}

export interface ConsensusSkeletonItemV1 {
  itemId: number;
  medianBuyTimeS: number;
  strength: number;
  tier: StatlockerFrequencyTierV1;
  components: ConsensusSkeletonComponentV1;
}

export interface ConsensusBuildCandidateV1 {
  itemId: number;
  strength: number;
  coverage: number;
  purchaseRate: number;
  medianBuyTimeS: number;
  timingSpreadS: number;
  sourceProfileCount: number;
  frequencyTier: StatlockerFrequencyTierV1;
  rushEvidence: boolean;
}

export interface ConsensusBuildGroupV1 {
  groupId: string;
  phase: ConsensusBuildPhaseV1;
  type: ConsensusBuildGroupTypeV1;
  minSelect: number;
  maxSelect: number;
  candidates: readonly ConsensusBuildCandidateV1[];
  confidence: number;
  inferred: boolean;
}

export interface ConsensusSkeletonV1 {
  heroId: number;
  profileCount: number;
  groups: readonly ConsensusBuildGroupV1[];
  /** Legacy read-only compatibility for scorer/integration call sites during the in-place migration. */
  items?: readonly ConsensusSkeletonItemV1[];
}

export interface BuiltConsensusSkeletonV1 extends ConsensusSkeletonV1 {
  items: readonly ConsensusSkeletonItemV1[];
}

export type StatlockerNormalizedPayloadV1 =
  | StatlockerWpaPatchDataV1
  | StatlockerVsHeroWpaV1
  | StatlockerT4ChainsV1
  | StatlockerHeroLeaderboardV1
  | StatlockerProBuildAnalysisV1
  | StatlockerWpaFilteredItemsV1
  | ConsensusSkeletonV1;

export interface StatlockerNormalizedDatasetV1<
  TPayload extends StatlockerNormalizedPayloadV1 = StatlockerNormalizedPayloadV1,
> {
  dataset: StatlockerDatasetV1;
  scopeKey: string;
  statlockerPatchId: string;
  contentSha256: string;
  payload: TPayload;
}

export interface StatlockerEvidenceFamilyV1<
  TPayload extends StatlockerNormalizedPayloadV1 = StatlockerNormalizedPayloadV1,
> {
  dataset: StatlockerDatasetV1;
  scopeKey: string;
  freshness: AdaptiveEvidenceFreshnessV1;
  confidence: number;
  snapshotId?: string;
  contentSha256?: string;
  fetchedAt?: string;
  payload?: TPayload;
}
