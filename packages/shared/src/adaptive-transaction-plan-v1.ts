const ADAPTIVE_PLAN_SESSION_STATES_V1 = [
  'ACTIVE',
  'WAITING',
  'REPLAN_REQUIRED',
  'COMPLETE',
] as const;

type AdaptivePlanSessionStateV1 = (typeof ADAPTIVE_PLAN_SESSION_STATES_V1)[number];

const ADAPTIVE_PLAN_STEP_STATES_V1 = [
  'LOCKED',
  'BLOCKED',
  'READY',
  'NEXT',
  'IN_PROGRESS',
  'COMPLETED',
  'INVALIDATED',
  'SKIPPED',
] as const;

type AdaptivePlanStepStateV1 = (typeof ADAPTIVE_PLAN_STEP_STATES_V1)[number];

const ADAPTIVE_PLAN_STEP_KINDS_V1 = ['TRANSACTION', 'BARRIER'] as const;
type AdaptivePlanStepKindV1 = (typeof ADAPTIVE_PLAN_STEP_KINDS_V1)[number];

const ADAPTIVE_PLAN_TRANSACTION_TYPES_V1 = ['BUY', 'UPGRADE', 'SELL_AND_BUY'] as const;

const ADAPTIVE_PLAN_BARRIER_TYPES_V1 = [
  'WAIT_FOR_GOLD',
  'WAIT_FOR_FLEX',
  'WAIT_FOR_SHOP',
  'WAIT_FOR_PREREQUISITE',
] as const;

type AdaptivePlanStepBlockReasonV1 =
  | 'PREREQUISITE_NOT_SATISFIED'
  | 'INSUFFICIENT_GOLD'
  | 'INSUFFICIENT_FLEX'
  | 'SHOP_UNAVAILABLE'
  | 'UNKNOWN_AFFORDABILITY'
  | 'UNKNOWN_FLEX_CAPACITY'
  | 'UNKNOWN_SELL_TRANSITION'
  | 'UNREACHABLE_TARGET'
  | 'PLAN_VALIDATION_FAILED';

export interface AdaptivePlanProjectionV1 {
  inventoryItemIds: readonly number[];
  spendableSouls?: number;
  usedByType: Readonly<Record<'weapon' | 'vitality' | 'spirit', number>>;
  flexUsed: number;
  unlockedFlexSlots?: number;
  activeItemsUsed: number;
}

type AdaptivePlannedTransactionV1 =
  | {
      type: 'BUY';
      buyItemId: number;
    }
  | {
      type: 'UPGRADE';
      buyItemId: number;
      consumedItemIds: readonly number[];
      recipeId?: string;
    }
  | {
      type: 'SELL_AND_BUY';
      sellItemId: number;
      buyItemId: number;
    };

type AdaptivePlanBarrierV1 =
  | {
      type: 'WAIT_FOR_GOLD';
      targetItemId: number;
      requiredSouls: number;
    }
  | {
      type: 'WAIT_FOR_FLEX';
      targetItemId: number;
      requiredUnlockedFlexSlots: number;
    }
  | {
      type: 'WAIT_FOR_SHOP';
      targetItemId: number;
    }
  | {
      type: 'WAIT_FOR_PREREQUISITE';
      prerequisiteGoalId: string;
      targetItemId?: number;
    };

export interface AdaptivePlanStepV1 {
  stepId: string;
  goalId: string;
  kind: AdaptivePlanStepKindV1;
  state: AdaptivePlanStepStateV1;
  action?: AdaptivePlannedTransactionV1;
  barrier?: AdaptivePlanBarrierV1;
  prerequisiteStepIds: readonly string[];
  blockingReasons: readonly AdaptivePlanStepBlockReasonV1[];
  projectedBefore: AdaptivePlanProjectionV1;
  projectedAfter?: AdaptivePlanProjectionV1;
  reasonCodes: readonly string[];
}

export interface AdaptivePlanSessionV1 {
  planSessionId: string;
  strategyId: string;
  revision: number;
  createdAtGameTimeSec: number;
  updatedAtGameTimeSec: number;
  state: AdaptivePlanSessionStateV1;
  steps: readonly AdaptivePlanStepV1[];
  nextStepId?: string;
  reasonCodes: readonly string[];
}
