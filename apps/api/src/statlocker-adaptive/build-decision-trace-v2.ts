import { ResolvedFullBuildPlanV2 } from './full-build-plan-v2';

export type BuildDecisionTraceStageV2 =
  | 'SOURCE'
  | 'ARCHETYPE_MINING'
  | 'ARCHETYPE_QUALITY_GATE'
  | 'ARCHETYPE_SELECTION'
  | 'LIVE_CONTEXT'
  | 'CANDIDATE_DISCOVERY'
  | 'CHOICE_RESOLUTION'
  | 'ITEM_SCORING'
  | 'DESIRED_STATE'
  | 'PLAN_SEARCH'
  | 'REPLACEMENT_SEARCH'
  | 'SEMANTIC_VALIDATION'
  | 'FINAL_PLAN';

export type BuildDecisionTraceDispositionV2 =
  | 'INFO'
  | 'SELECTED'
  | 'REJECTED'
  | 'SUPPRESSED_BY_HYSTERESIS';

export interface BuildTraceScoreLayersV2 {
  structure: number;
  matchup: number;
  progression: number;
  transition: number;
}

export interface BuildTraceCandidateV2 {
  candidateId: string;
  itemId?: number;
  archetypeId?: string;
  score?: number;
  confidence?: number;
  coverage?: number;
  sampleCount?: number;
  disposition: BuildDecisionTraceDispositionV2;
  reasonCodes: readonly string[];
}

export interface BuildSourceTracePayloadV2 {
  heroId: number;
  statlockerPatchId?: string;
  profileAccountIds: readonly string[];
  profileCount: number;
  wpaRowCount?: number;
  t4Available?: boolean;
}

export interface BuildArchetypeMiningTracePayloadV2 {
  candidates: readonly {
    candidateId: string;
    profileAccountIds: readonly string[];
    support: number;
    coherence: number;
    separation: number;
    disposition: BuildDecisionTraceDispositionV2;
    reasonCodes: readonly string[];
  }[];
}

export interface BuildArchetypeQualityGateTracePayloadV2 {
  results: readonly {
    archetypeId: string;
    accepted: boolean;
    reasonCodes: readonly string[];
  }[];
}

export interface BuildArchetypeSelectionTracePayloadV2 {
  enemyHeroIds: readonly number[];
  wpaQueryCount: number;
  candidates: readonly BuildTraceCandidateV2[];
  selectedArchetypeId?: string;
  fallbackUsed: boolean;
}

export interface BuildLiveContextTracePayloadV2 {
  gameTimeSec: number;
  inventoryItemIds: readonly number[];
  capacity: number;
  enemyThreats: readonly {
    heroId: number;
    threatMultiplier: number;
    completeness: number;
    reasonCodes: readonly string[];
  }[];
}

export interface BuildCandidateDiscoveryTracePayloadV2 {
  candidates: readonly (BuildTraceCandidateV2 & {
    insideLockedArchetype: boolean;
  })[];
}

export interface BuildChoiceResolutionTracePayloadV2 {
  groups: readonly {
    groupId: string;
    minSelect: number;
    maxSelect: number;
    candidates: readonly BuildTraceCandidateV2[];
    selectedItemIds: readonly number[];
  }[];
}

export interface BuildItemScoringTracePayloadV2 {
  items: readonly {
    itemId: number;
    total: number;
    confidence: number;
    layers: BuildTraceScoreLayersV2;
    reasonCodes: readonly string[];
  }[];
}

export interface BuildDesiredStateTracePayloadV2 {
  families: readonly {
    familyId: number;
    requirement: 'REQUIRED' | 'CHOICE' | 'OPTIONAL' | 'SITUATIONAL';
    groupId?: string;
    selectedTerminalItemId: number;
    selectedTerminalKind: 'DEFAULT_TERMINAL' | 'OPTIONAL_TERMINAL';
    score: number;
    confidence: number;
    reasonCodes: readonly string[];
    sourceProfiles?: readonly {
      accountId: string;
      playerName?: string;
    }[];
  }[];
  selectedChoiceFamilyIdsByGroup: Readonly<Record<string, readonly number[]>>;
  reasonCodes: readonly string[];
}

export interface BuildPlanSearchTracePayloadV2 {
  branches: readonly {
    sequence: number;
    targetItemId: number;
    action?: 'BUY' | 'UPGRADE' | 'REPLACE';
    score?: number;
    disposition: BuildDecisionTraceDispositionV2;
    reasonCodes: readonly string[];
  }[];
  hysteresis?: {
    action: 'KEEP_PREVIOUS' | 'SWITCH_TO_CANDIDATE';
    improvement: number;
    requiredImprovement: number;
    reasonCodes: readonly string[];
  };
}

export interface BuildReplacementSearchTracePayloadV2 {
  targetItemId: number;
  candidates: readonly {
    sellItemId: number;
    buyItemId: number;
    marginalGain: number;
    requiredImprovement: number;
    disposition: BuildDecisionTraceDispositionV2;
    reasonCodes: readonly string[];
  }[];
}

export interface BuildSemanticValidationTracePayloadV2 {
  valid: boolean;
  reasonCodes: readonly string[];
  finalFamilyStates: readonly {
    familyId: number;
    status: string;
    currentItemIds: readonly number[];
    terminalItemId?: number;
  }[];
}

export interface BuildFinalPlanTracePayloadV2 {
  planRevision: string;
  stepCount: number;
  degradedReasons: readonly string[];
  valid: boolean;
  validationReasonCodes: readonly string[];
}

interface BuildDecisionTraceStageBaseV2 {
  reasonCodes: readonly string[];
}

export type BuildDecisionTraceStageEntryV2 =
  | (BuildDecisionTraceStageBaseV2 & { stage: 'SOURCE'; payload: BuildSourceTracePayloadV2 })
  | (BuildDecisionTraceStageBaseV2 & { stage: 'ARCHETYPE_MINING'; payload: BuildArchetypeMiningTracePayloadV2 })
  | (BuildDecisionTraceStageBaseV2 & { stage: 'ARCHETYPE_QUALITY_GATE'; payload: BuildArchetypeQualityGateTracePayloadV2 })
  | (BuildDecisionTraceStageBaseV2 & { stage: 'ARCHETYPE_SELECTION'; payload: BuildArchetypeSelectionTracePayloadV2 })
  | (BuildDecisionTraceStageBaseV2 & { stage: 'LIVE_CONTEXT'; payload: BuildLiveContextTracePayloadV2 })
  | (BuildDecisionTraceStageBaseV2 & { stage: 'CANDIDATE_DISCOVERY'; payload: BuildCandidateDiscoveryTracePayloadV2 })
  | (BuildDecisionTraceStageBaseV2 & { stage: 'CHOICE_RESOLUTION'; payload: BuildChoiceResolutionTracePayloadV2 })
  | (BuildDecisionTraceStageBaseV2 & { stage: 'ITEM_SCORING'; payload: BuildItemScoringTracePayloadV2 })
  | (BuildDecisionTraceStageBaseV2 & { stage: 'DESIRED_STATE'; payload: BuildDesiredStateTracePayloadV2 })
  | (BuildDecisionTraceStageBaseV2 & { stage: 'PLAN_SEARCH'; payload: BuildPlanSearchTracePayloadV2 })
  | (BuildDecisionTraceStageBaseV2 & { stage: 'REPLACEMENT_SEARCH'; payload: BuildReplacementSearchTracePayloadV2 })
  | (BuildDecisionTraceStageBaseV2 & { stage: 'SEMANTIC_VALIDATION'; payload: BuildSemanticValidationTracePayloadV2 })
  | (BuildDecisionTraceStageBaseV2 & { stage: 'FINAL_PLAN'; payload: BuildFinalPlanTracePayloadV2 });

export interface BuildDecisionTraceV2 {
  matchId: string;
  steamId: string;
  revision: number;
  stateRevision: string;
  generatedAt: string;
  stages: readonly BuildDecisionTraceStageEntryV2[];
  finalPlan?: ResolvedFullBuildPlanV2;
}

export interface BuildDecisionTraceSinkV2 {
  record(entry: BuildDecisionTraceStageEntryV2): void;
}

export class BuildDecisionTraceCollectorV2 implements BuildDecisionTraceSinkV2 {
  private readonly entries: BuildDecisionTraceStageEntryV2[] = [];

  record(entry: BuildDecisionTraceStageEntryV2): void {
    this.entries.push(deepFreeze(copyStageEntry(entry)));
  }

  stages(): readonly BuildDecisionTraceStageEntryV2[] {
    return [...this.entries];
  }
}

function copyStageEntry(entry: BuildDecisionTraceStageEntryV2): BuildDecisionTraceStageEntryV2 {
  return JSON.parse(JSON.stringify(entry)) as BuildDecisionTraceStageEntryV2;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}