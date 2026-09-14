type AdaptiveBuildStatusV1 =
  | 'IN_PROGRESS'
  | 'WAITING'
  | 'COMPLETE'
  | 'REPLAN_REQUIRED'
  | 'OUT_OF_DISTRIBUTION';

type AdaptiveStrategySessionStateV1 =
  | 'PROVISIONAL'
  | 'COMMITTED'
  | 'DIVERGED'
  | 'OUT_OF_DISTRIBUTION';

export interface AdaptiveBuildContractViewV1 {
  strategyId?: string;
  status: AdaptiveBuildStatusV1;
  currentGoalId?: string;
  completedGoalIds: readonly string[];
  remainingGoalIds: readonly string[];
  committedChoices: readonly {
    groupId: string;
    itemIds: readonly number[];
  }[];
  temporaryItemIds: readonly number[];
  slotReservations: readonly {
    goalId: string;
    targetItemId: number;
    state: 'READY' | 'LOCKED_BY_FLEX' | 'LOCKED_BY_SELL' | 'LOCKED_BY_UPGRADE_COMPRESSION' | 'BLOCKED';
    reasonCodes: readonly string[];
  }[];
  situationalWindowStates: readonly {
    windowId: string;
    state: 'CLOSED' | 'OPEN' | 'RESOLVED';
    targetItemIds: readonly number[];
    reasonCodes: readonly string[];
  }[];
  replanReasonCodes: readonly string[];
}

export interface AdaptiveStrategySessionViewV1 {
  state: AdaptiveStrategySessionStateV1;
  strategyId?: string;
  strategyPosterior?: number;
  heroId: number;
  rulesetId: string;
  catalogSha256: string;
  committedAtDecisionId?: string;
  divergenceCount: number;
  lastTransitionReasonCodes: readonly string[];
}
