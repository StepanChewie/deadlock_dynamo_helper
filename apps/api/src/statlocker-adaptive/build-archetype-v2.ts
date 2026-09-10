import {
  ConsensusBuildGroupTypeV1,
  ConsensusBuildPhaseV1,
  StatlockerFrequencyTierV1,
} from './statlocker-adaptive.types';

export type BuildArchetypeRoleV2 = 'CORE' | 'FREQUENT' | 'SITUATIONAL' | 'FLEX';
export type BuildArchetypeGroupTypeV2 = ConsensusBuildGroupTypeV1;
export type BuildPhaseV2 = ConsensusBuildPhaseV1;

export interface StatlockerBuildProfileItemV2 {
  itemId: number;
  familyId: number;
  purchaseRate: number;
  medianBuyTimeS: number;
  frequencyTier: StatlockerFrequencyTierV1;
  phase: BuildPhaseV2;
  relationships: readonly { itemId: number; strength: number }[];
  explicitGroup?: {
    type: BuildArchetypeGroupTypeV2;
    groupKey: string;
    minSelect: number;
    maxSelect: number;
  };
}

export interface StatlockerBuildProfileV2 {
  accountId: string;
  heroId: number;
  leaderboardRank?: number;
  items: readonly StatlockerBuildProfileItemV2[];
}

export interface BuildArchetypeItemV2 {
  itemId: number;
  familyId: number;
  role: BuildArchetypeRoleV2;
  sourceProfileCount: number;
  profileCoverage: number;
  purchaseRate: number;
  timing: {
    medianBuyTimeS: number;
    spreadS: number;
    phase: BuildPhaseV2;
  };
  structuralPriority: number;
}

export interface BuildArchetypeGroupV2 {
  groupId: string;
  type: BuildArchetypeGroupTypeV2;
  candidateItemIds: readonly number[];
  minSelect: number;
  maxSelect: number;
  source: 'STATLOCKER_EXPLICIT' | 'INFERRED_CONSENSUS';
  confidence: number;
}

export interface BuildOrderEdgeV2 {
  beforeItemId: number;
  afterItemId: number;
  confidence: number;
  sourceProfileCount: number;
  strength: 'HARD' | 'SOFT';
}

export interface BuildArchetypeRelationshipV2 {
  leftItemId: number;
  rightItemId: number;
  strength: number;
  sourceProfileCount: number;
}

export interface BuildArchetypeQualityV2 {
  support: number;
  coherence: number;
  separation: number;
  sourceProfileCount: number;
}

export interface BuildArchetypeV2 {
  archetypeId: string;
  heroId: number;
  sourceProfileAccountIds: readonly string[];
  items: readonly BuildArchetypeItemV2[];
  groups: readonly BuildArchetypeGroupV2[];
  orderEdges: readonly BuildOrderEdgeV2[];
  relationships: readonly BuildArchetypeRelationshipV2[];
  quality: BuildArchetypeQualityV2;
}

export interface BuildArchetypeSnapshotV2 {
  snapshotId: string;
  heroId: number;
  rulesetVersion: string;
  catalogSha256: string;
  statlockerPatchId: string;
  generatedAt: string;
  sourceProfileAccountIds: readonly string[];
  archetypes: readonly BuildArchetypeV2[];
}
