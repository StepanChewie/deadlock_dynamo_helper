import type { AdaptivePlanSessionV1 } from './adaptive-transaction-plan-v1';
import type { AdaptiveDecisionTraceV1 } from './adaptive-decision-trace-v1';
import type {
  AdaptiveBuildContractViewV1,
  AdaptiveStrategySessionViewV1,
} from './adaptive-strategy-state-v1';

export const ADAPTIVE_ACTION_TYPES_V1 = [
  'BUY',
  'UPGRADE',
  'SELL',
  'REPLACE',
  'WAIT',
  'HOLD',
  'CONTINUE_CORE',
  'ABSTAIN',
] as const;

export type AdaptiveActionTypeV1 = (typeof ADAPTIVE_ACTION_TYPES_V1)[number];

export const ADAPTIVE_PLAN_STATUSES_V1 = ['OWNED', 'NEXT', 'PLANNED'] as const;
type AdaptivePlanStatusV1 = (typeof ADAPTIVE_PLAN_STATUSES_V1)[number];

const ADAPTIVE_PLAN_ACTION_STATUSES_V1 = [
  'OWNED',
  'READY',
  'BLOCKED',
  'PLANNED',
  'COMPLETED',
] as const;
export type AdaptivePlanActionStatusV1 = (typeof ADAPTIVE_PLAN_ACTION_STATUSES_V1)[number];

export const ADAPTIVE_EVIDENCE_FRESHNESS_V1 = [
  'FRESH',
  'STALE_USABLE',
  'UNAVAILABLE',
  'PATCH_MISMATCH',
] as const;
export type AdaptiveEvidenceFreshnessV1 = (typeof ADAPTIVE_EVIDENCE_FRESHNESS_V1)[number];

type AdaptiveBuildPlanChangeTypeV1 = 'KEEP' | 'INSERT' | 'SKIP' | 'SELL' | 'REPLACE' | 'MOVE';

type AdaptiveStrategyBuildStatusV1 =
  | 'IN_PROGRESS'
  | 'WAITING'
  | 'COMPLETE'
  | 'REPLAN_REQUIRED'
  | 'OUT_OF_DISTRIBUTION';

type AdaptiveStrategyCommitmentV1 = 'PROVISIONAL' | 'COMMITTED' | 'DIVERGED' | 'OOD';

interface AdaptiveStrategyProgressV1 {
  satisfiedHardGoals: number;
  totalHardGoals: number;
}

interface AdaptiveStrategyCurrentGoalV1 {
  goalId: string;
  type: string;
  reasonCodes: readonly string[];
}

interface AdaptiveStrategySlotTransitionV1 {
  targetGoalId: string;
  targetItemId?: number;
  requirement: 'NONE' | 'UPGRADE' | 'SELL_TEMPORARY' | 'REPLACE' | 'FLEX_UNLOCK' | 'BLOCKED';
  sourceItemId?: number;
  requiredUnlockedFlexSlots?: number;
  reasonCodes: readonly string[];
}

interface AdaptiveStrategySlotPlanV1 {
  currentUsedSlots: number;
  currentFlexUsed: number;
  unlockedFlexSlots?: number;
  reservedSituationalSlots: number;
  feasible: boolean;
  reasonCodes: readonly string[];
  /** Optional for persisted V1 recommendations written before strategy slot transitions were exposed. */
  futureTransitions?: readonly AdaptiveStrategySlotTransitionV1[];
}

interface AdaptiveStrategyInvestmentObjectiveV1 {
  objectiveId: string;
  type: 'weapon' | 'vitality' | 'spirit';
  state: 'LOCKED' | 'ACTIVE' | 'SATISFIED' | 'WAIVED';
  currentValue: number;
  targetValue?: number;
  distance?: number;
  reasonCodes: readonly string[];
}

interface AdaptiveStrategySituationalDecisionV1 {
  windowId: string;
  purpose: string;
  targetItemId: number;
  enemyHeroIds: readonly number[];
  enemyItemIds: readonly number[];
  confidence: number;
  reasonCodes: readonly string[];
  statisticalSupport?: number;
  slotImpact?: number;
  investmentImpact?: number;
  coreInterruptionSouls?: number;
}

interface AdaptiveRecommendationStrategyV1 {
  strategyId: string;
  commitment: AdaptiveStrategyCommitmentV1;
  selectedAtGameTimeSec?: number;
  posterior: number;
  stability?: number;
  reasonCodes: readonly string[];
  selectedBranches: Readonly<Record<string, string>>;
  committedBranches: Readonly<Record<string, string>>;
  buildStatus: AdaptiveStrategyBuildStatusV1;
  progress: AdaptiveStrategyProgressV1;
  currentGoal?: AdaptiveStrategyCurrentGoalV1;
  remainingGoalIds: readonly string[];
  /** Optional for persisted V1 recommendations written before hard investment obligations were surfaced. */
  remainingHardInvestmentObjectiveIds?: readonly string[];
  slotPlan: AdaptiveStrategySlotPlanV1;
  investmentObjectives: readonly AdaptiveStrategyInvestmentObjectiveV1[];
  situationalDecision?: AdaptiveStrategySituationalDecisionV1;
}

export interface AdaptiveActionV1 {
  actionKey: string;
  type: AdaptiveActionTypeV1;
  itemId?: number;
  sellItemId?: number;
  buyItemId?: number;
  targetItemId?: number;
  reasonCodes: readonly string[];
}

export type AdaptivePlanRequirementV1 =
  | {
      type: 'SOULS';
      requiredSouls: number;
      currentSouls?: number;
      shortfallSouls?: number;
      evidence: 'OBSERVED' | 'RECONSTRUCTED' | 'UNKNOWN';
    }
  | {
      type: 'FLEX_SLOT';
      requiredFlexSlots: number;
      unlockedFlexSlots?: number;
      evidence: 'OBSERVED' | 'RECONSTRUCTED' | 'UNKNOWN';
    }
  | {
      type: 'SELL_ITEM';
      itemId: number;
    }
  | {
      type: 'UPGRADE_COMPONENT';
      itemIds: readonly number[];
    }
  | {
      type: 'SHOP_OPPORTUNITY';
      available?: boolean;
      evidence: 'OBSERVED' | 'RECONSTRUCTED' | 'UNKNOWN';
    };

type AdaptiveSituationalPurposeV1 =
  | 'CATCH'
  | 'ANTI_CC'
  | 'CLEANSE'
  | 'ANTI_BULLET'
  | 'ANTI_SPIRIT'
  | 'ANTI_BURST'
  | 'ANTI_HEAL'
  | 'MOBILITY'
  | 'TEAM_UTILITY'
  | 'SURVIVAL';

type AdaptiveSituationalEvidenceKindV1 =
  | 'MATCHUP_STAT'
  | 'MECHANICAL_COUNTER'
  | 'ENEMY_ITEMIZATION'
  | 'LIVE_THREAT';

export interface AdaptiveSituationalEnemyTargetV1 {
  enemyHeroId: number;
  enemyHeroName?: string;
  role: 'PRIMARY' | 'SECONDARY';
  score: number;
  confidence: number;
  evidenceKinds: readonly AdaptiveSituationalEvidenceKindV1[];
  deltaWpa?: number;
  sampleSize?: number;
}

export interface AdaptiveSituationalContextV1 {
  purpose: AdaptiveSituationalPurposeV1;
  targetEnemies: readonly AdaptiveSituationalEnemyTargetV1[];
  primaryTargetEnemyHeroId?: number;
  recommendationConfidence: number;
  coreInterruption: {
    nextCoreTargetItemId?: number;
    estimatedSoulsDelay?: number;
    accepted: boolean;
  };
  reasonCodes: readonly string[];
}

export interface AdaptivePlanActionV1 {
  planActionId: string;
  sequence: number;
  status: AdaptivePlanActionStatusV1;
  action: AdaptiveActionV1;
  targetItemId?: number;
  sourceItemIds: readonly number[];
  requirements: readonly AdaptivePlanRequirementV1[];
  goalId?: string;
  groupId?: string;
  reasonCodes: readonly string[];
  situational?: AdaptiveSituationalContextV1;
}

export interface AdaptiveScoreComponentV1 {
  key: string;
  raw: number;
  normalized: number;
  confidence: number;
  weight: number;
  weighted: number;
}

interface AdaptiveScoredActionV1 {
  action: AdaptiveActionV1;
  score: number;
  confidence: number;
  components: readonly AdaptiveScoreComponentV1[];
  reasonCodes: readonly string[];
}

export interface AdaptivePlannedItemV1 {
  itemId: number;
  position: number;
  status: AdaptivePlanStatusV1;
  score: number;
  confidence: number;
  skeletonStrength: number;
  contextualSupport: number;
  reasonCodes: readonly string[];
}

interface AdaptiveBuildPlanChangeV1 {
  type: AdaptiveBuildPlanChangeTypeV1;
  itemId?: number;
  sellItemId?: number;
  buyItemId?: number;
  fromPosition?: number;
  toPosition?: number;
  reasonCodes: readonly string[];
}

interface AdaptiveEvidenceFamilyProvenanceV1 {
  dataset: string;
  freshness: AdaptiveEvidenceFreshnessV1;
  snapshotId?: string;
  contentSha256?: string;
  fetchedAt?: string;
  confidence: number;
}

interface AdaptiveEvidenceProvenanceV1 {
  rulesetVersion: string;
  catalogSha256: string;
  statlockerPatchId?: string;
  snapshotIds: readonly string[];
  families: readonly AdaptiveEvidenceFamilyProvenanceV1[];
  degradedReasons: readonly string[];
}

export interface AdaptiveRecommendationResultV1 {
  ready: boolean;
  blockers: readonly string[];
  decisionId: string;
  stateRevision: string;
  gameState: 'AHEAD' | 'EVEN' | 'BEHIND' | 'UNKNOWN';
  nextAction: AdaptiveActionV1;
  nextTargetItemId?: number;
  planActions?: readonly AdaptivePlanActionV1[];
  recommendedBuild: readonly AdaptivePlannedItemV1[];
  changes: readonly AdaptiveBuildPlanChangeV1[];
  rankedImmediateCandidates: readonly AdaptiveScoredActionV1[];
  totalScore: number;
  confidence: number;
  buildContract?: AdaptiveBuildContractViewV1;
  strategySession?: AdaptiveStrategySessionViewV1;
  scorerVersion: string;
  plannerVersion: string;
  configVersion: string;
  plannerMethod?: 'STRATEGY_FIRST' | 'LEGACY_GREEDY';
  strategy?: AdaptiveRecommendationStrategyV1;
  /** Transaction-first source of truth. Optional only for legacy/persisted V1 compatibility. */
  planSession?: AdaptivePlanSessionV1;
  /** Bounded structured decision trace for debug/replay; omitted for legacy persisted recommendations. */
  decisionTrace?: AdaptiveDecisionTraceV1;
  evidence: AdaptiveEvidenceProvenanceV1;
}