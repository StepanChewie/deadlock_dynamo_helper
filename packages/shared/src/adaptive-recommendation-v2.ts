export interface AdaptiveRecommendationRequestV2 {
  matchId: string;
  localSteamId?: string;
}

export type AdaptiveFullBuildActionV2 = 'BUY' | 'UPGRADE' | 'REPLACE';

export interface AdaptiveFullBuildStepV2 {
  sequence: number;
  action: AdaptiveFullBuildActionV2;
  buyItemId: number;
  sellItemId?: number;
  recipeId?: string;
  consumedItemIds: readonly number[];
  inventoryBefore: readonly number[];
  inventoryAfter: readonly number[];
  reasonCodes: readonly string[];
}

export interface AdaptiveFullBuildValidationV2 {
  valid: boolean;
  reasonCodes: readonly string[];
}

export type AdaptiveBuildFamilyRequirementV2 =
  | 'REQUIRED'
  | 'CHOICE'
  | 'OPTIONAL'
  | 'SITUATIONAL';

export type AdaptiveBuildTerminalKindV2 = 'DEFAULT_TERMINAL' | 'OPTIONAL_TERMINAL';

export interface AdaptiveDesiredFamilyStateV2 {
  familyId: number;
  requirement: AdaptiveBuildFamilyRequirementV2;
  selectedTerminalItemId: number;
  selectedTerminalKind: AdaptiveBuildTerminalKindV2;
  groupId?: string;
  score: number;
  confidence: number;
  reasonCodes: readonly string[];
}

export interface AdaptiveDesiredBuildStateV2 {
  families: readonly AdaptiveDesiredFamilyStateV2[];
  selectedChoiceFamilyIdsByGroup: Readonly<Record<string, readonly number[]>>;
  reasonCodes: readonly string[];
}

export type AdaptiveBuildFamilySatisfactionStatusV2 =
  | 'UNSATISFIED'
  | 'IN_PROGRESS'
  | 'DEFAULT_TERMINAL_SATISFIED'
  | 'OPTIONAL_TERMINAL_SATISFIED';

export interface AdaptiveBuildFamilySatisfactionV2 {
  familyId: number;
  status: AdaptiveBuildFamilySatisfactionStatusV2;
  currentItemIds: readonly number[];
  terminalItemId?: number;
}

export interface AdaptiveFullBuildSemanticValidationV2 {
  valid: boolean;
  reasonCodes: readonly string[];
  finalFamilyStates: readonly AdaptiveBuildFamilySatisfactionV2[];
}

export interface AdaptiveFullBuildPlanV2 {
  planRevision: string;
  steps: readonly AdaptiveFullBuildStepV2[];
  degradedReasons: readonly string[];
  validation: AdaptiveFullBuildValidationV2;
  desiredState?: AdaptiveDesiredBuildStateV2;
  mechanicalValidation?: AdaptiveFullBuildValidationV2;
  semanticValidation?: AdaptiveFullBuildSemanticValidationV2;
}

export type AdaptiveArchetypeSelectionModeV2 = 'VS_HERO_WPA' | 'OFFLINE_DEFAULT';

export interface AdaptiveArchetypeLockSummaryV2 {
  matchId: string;
  heroId: number;
  snapshotId: string;
  archetypeId: string;
  enemyHeroIds: readonly number[];
  selectionMode: AdaptiveArchetypeSelectionModeV2;
  lockedAt: string;
  lockedGameTimeS?: number;
  degradedReasons: readonly string[];
}

export type AdaptiveImmediateActionTypeV2 = 'BUY' | 'UPGRADE' | 'REPLACE' | 'HOLD';

export interface AdaptiveImmediateActionV2 {
  type: AdaptiveImmediateActionTypeV2;
  buyItemId?: number;
  sellItemId?: number;
  recipeId?: string;
  reasonCodes: readonly string[];
}

export interface AdaptiveEvidenceFamilyV2 {
  dataset: 'PRO_BUILD_ANALYSIS' | 'VS_HERO_WPA' | 'WPA_PATCH_DATA' | 'T4_CHAINS';
  available: boolean;
  snapshotId?: string;
  rowCount?: number;
  confidence?: number;
  reasonCodes: readonly string[];
}

export interface AdaptiveEvidenceSummaryV2 {
  rulesetVersion: string;
  catalogSha256: string;
  statlockerPatchId: string;
  sourceProfileCount: number;
  sourceProfileAccountIds: readonly string[];
  families: readonly AdaptiveEvidenceFamilyV2[];
  degradedReasons: readonly string[];
}

export interface AdaptiveRecommendationScoreSummaryV2 {
  total: number;
  confidence: number;
}

export interface AdaptiveRecommendationResultV2 {
  ready: boolean;
  blockers: readonly string[];
  decisionId: string;
  stateRevision: string;
  heroId?: number;
  lock?: AdaptiveArchetypeLockSummaryV2;
  nextAction: AdaptiveImmediateActionV2;
  fullBuild?: AdaptiveFullBuildPlanV2;
  score: AdaptiveRecommendationScoreSummaryV2;
  evidence?: AdaptiveEvidenceSummaryV2;
  degradedReasons: readonly string[];
}
