import type {
  AdaptiveActionV1,
  AdaptivePlannedItemV1,
  AdaptiveScoreComponentV1,
} from './adaptive-recommendation-v1';

export const ADAPTIVE_DECISION_TRACE_VERSION_V1 = 'adaptive-decision-trace-v1' as const;

export type AdaptiveDecisionCandidateSourceV1 =
  | 'SKELETON'
  | 'BRANCH'
  | 'EXPLICIT_SITUATIONAL'
  | 'DISCOVERED'
  | 'WILDCARD';

export interface AdaptiveDecisionTraceMatchupV1 {
  score?: number;
  confidence?: number;
  reasonCodes: readonly string[];
}

export interface AdaptiveDecisionTraceCandidateV1 {
  action: AdaptiveActionV1;
  source: AdaptiveDecisionCandidateSourceV1;
  selected: boolean;
  score?: number;
  confidence?: number;
  scoreComponents: readonly AdaptiveScoreComponentV1[];
  rejectionReasonCodes: readonly string[];
  matchup: AdaptiveDecisionTraceMatchupV1;
  requiredThreshold?: number;
}

export interface AdaptiveDecisionTraceUtilityDeltaV1 {
  skeletonAdherence: number;
  coreIntegrity: number;
  branchCoherence: number;
  threatMatchup: number;
  synergy: number;
  timing: number;
  slotEfficiency: number;
  economyOpportunityCost: number;
  investmentContinuity: number;
}

export interface AdaptiveDecisionReplacementTraceV1 {
  sellItemId: number;
  buyItemId: number;
  selected: boolean;
  accepted: boolean;
  inventoryCount: number;
  maxItemCount: number;
  utilityBefore: number;
  utilityAfter: number;
  rawImprovement: number;
  matchupGain: number;
  skeletonDelta: number;
  synergyDelta: number;
  timingDelta: number;
  economicLoss: number;
  transactionPenalty: number;
  churnPenalty: number;
  netImprovement: number;
  requiredThreshold: number;
  utilityDeltas: AdaptiveDecisionTraceUtilityDeltaV1;
  reasonCodes: readonly string[];
}

export interface AdaptiveDecisionPolicySnapshotV1 {
  policyVersion: string;
  heldItemCapacity: number;
  threatWeights: {
    souls: number;
    heroDamage: number;
    killsAssists: number;
    level: number;
    deaths: number;
  };
  threatClamp: { min: number; max: number };
  shrinkK: {
    baseWpa: number;
    gameState: number;
    exactEnemy: number;
    chain: number;
    proProfile: number;
  };
  thresholds: {
    planSwitch: number;
    sellBuy: number;
    softCoreReplace: number;
    wildcardReplace: number;
    matchupConfidence: number;
  };
  recentPurchaseProtectionMs: number;
  soldItemRebuyPenaltyMs: number;
}

export interface AdaptiveDecisionTraceV1 {
  version: typeof ADAPTIVE_DECISION_TRACE_VERSION_V1;
  decisionId: string;
  stateRevision: string;
  stages: readonly (
    | 'SKELETON_BASELINE'
    | 'BRANCH_CHOICES'
    | 'MATCHUP_DISCOVERY'
    | 'WHOLE_BUILD_VALIDATION'
    | 'SELL_SOURCE_EVALUATION'
    | 'FINAL_SELECTION'
  )[];
  baseline: {
    strategyId: string;
    inventoryItemIds: readonly number[];
    recommendedBuild: readonly AdaptivePlannedItemV1[];
  };
  branchChoices: Readonly<Record<string, string>>;
  candidates: readonly AdaptiveDecisionTraceCandidateV1[];
  replacements: readonly AdaptiveDecisionReplacementTraceV1[];
  finalSelection: {
    action: AdaptiveActionV1;
    legalityRecheckChanged: boolean;
    reasonCodes: readonly string[];
  };
  policy: AdaptiveDecisionPolicySnapshotV1;
}
