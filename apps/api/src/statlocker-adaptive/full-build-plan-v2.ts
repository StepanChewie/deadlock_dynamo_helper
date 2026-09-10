export type FullBuildActionV2 = 'BUY' | 'UPGRADE' | 'REPLACE';

export type FullBuildTransitionIntentV2 =
  | {
      action: 'BUY';
      buyItemId: number;
      reasonCodes: readonly string[];
    }
  | {
      action: 'UPGRADE';
      buyItemId: number;
      recipeId: string;
      reasonCodes: readonly string[];
    }
  | {
      action: 'REPLACE';
      sellItemId: number;
      buyItemId: number;
      reasonCodes: readonly string[];
    };

export interface FullBuildStepV2 {
  sequence: number;
  action: FullBuildActionV2;
  buyItemId: number;
  sellItemId?: number;
  recipeId?: string;
  consumedItemIds: readonly number[];
  inventoryBefore: readonly number[];
  inventoryAfter: readonly number[];
  reasonCodes: readonly string[];
}

export interface FullBuildValidationV2 {
  valid: boolean;
  reasonCodes: readonly string[];
}

export interface FullBuildInventorySimulationV2 {
  steps: readonly FullBuildStepV2[];
  finalInventoryItemIds: readonly number[];
  validation: FullBuildValidationV2;
}

export interface ResolvedFullBuildPlanV2 {
  planRevision: string;
  matchId: string;
  heroId: number;
  archetypeId: string;
  stateRevision: string;
  steps: readonly FullBuildStepV2[];
  degradedReasons: readonly string[];
  validation: FullBuildValidationV2;
}
