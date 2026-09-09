import { Injectable } from '@nestjs/common';
import {
  RecommendationDecisionState,
  RecommendationItemGraph,
  UpgradeExecutionResolutionV1,
  resolveUpgradeExecutionPathV1,
} from '@deadlock-live-probe/build-domain';
import {
  AdaptiveEvidenceScorerV1Service,
  AdaptiveItemScoreContextV1,
  AdaptiveItemScoreV1,
} from './adaptive-evidence-scorer-v1.service';
import {
  AdaptiveInvestmentStateV1,
  RecommendationEconomyRulesV1,
  deriveAdaptiveInvestmentStateV1,
} from './adaptive-economy-v1';
import { ADAPTIVE_POLICY_V1_CONFIG } from './statlocker-adaptive.config';
import { ConsensusBuildGroupV1 } from './statlocker-adaptive.types';

export interface AdaptiveChoiceStateV1 {
  groupId: string;
  selectedItemIds: readonly number[];
  committedItemIds: readonly number[];
  selectedItemId?: number;
  committedItemId?: number;
  committed: boolean;
  confidence: number;
  externallyDiverged: boolean;
}

export interface AdaptiveChoiceResolutionContextV1 {
  scorerContext: AdaptiveItemScoreContextV1;
  itemGraph: RecommendationItemGraph;
  ownedItemIds: readonly number[];
  decisionState?: RecommendationDecisionState;
  investment?: AdaptiveInvestmentStateV1;
  economyRules?: RecommendationEconomyRulesV1;
  previousSelectedItemIds?: readonly number[];
  previousCommittedItemIds?: readonly number[];
  previousSelectedItemId?: number;
  previousCommittedItemId?: number;
}

export interface AdaptiveChoiceReplacementOptionV1 {
  groupId: string;
  targetItemId: number;
  replacedItemId: number;
  sellEvidenceItemIds: readonly number[];
  supportItemIds: readonly number[];
  replacedSupportItemIds: readonly number[];
  contextualImprovement: number;
}

export interface AdaptiveResolvedChoiceV1 extends AdaptiveChoiceStateV1 {
  scores: readonly AdaptiveItemScoreV1[];
  replacementOptions: readonly AdaptiveChoiceReplacementOptionV1[];
}

@Injectable()
export class AdaptiveChoiceResolverV1Service {
  constructor(private readonly scorer: AdaptiveEvidenceScorerV1Service) {}

  reconstructChoiceState(
    group: ConsensusBuildGroupV1,
    ownedItemIds: readonly number[],
    itemGraph: RecommendationItemGraph,
    previousCommittedItemId?: number,
  ): AdaptiveChoiceStateV1 {
    return reconstructChoiceStateV1(group, ownedItemIds, itemGraph, previousCommittedItemId);
  }

  resolveChoice(
    group: ConsensusBuildGroupV1,
    context: AdaptiveChoiceResolutionContextV1,
  ): AdaptiveResolvedChoiceV1 {
    if (group.type !== 'CHOICE') throw new Error(`Group ${group.groupId} is not a CHOICE group`);
    const previousCommittedItemIds = normalizeChoiceIds(
      context.previousCommittedItemIds ?? optionalSingleton(context.previousCommittedItemId),
      group,
    );
    const previousSelectedItemIds = normalizeChoiceIds(
      context.previousSelectedItemIds ?? optionalSingleton(context.previousSelectedItemId),
      group,
    );
    const reconstructed = reconstructChoiceStateV1(
      group,
      context.ownedItemIds,
      context.itemGraph,
      previousCommittedItemIds,
    );
    const scores = group.candidates
      .map((candidate) => this.scorer.scoreItem(
        candidate.itemId,
        choiceScorerContextV1(candidate.itemId, context),
      ))
      .sort(compareScores);

    if (reconstructed.externallyDiverged) {
      const selectedItemIds = previousSelectedItemIds.length > 0
        ? previousSelectedItemIds
        : reconstructed.committedItemIds;
      return withChoiceCompatibility({
        ...reconstructed,
        selectedItemIds,
        scores,
        replacementOptions: [],
      });
    }

    const requiredCount = requiredChoiceCount(group);
    const committedItemIds = reconstructed.committedItemIds.slice(0, group.maxSelect);
    const remainingCount = Math.max(0, requiredCount - committedItemIds.length);
    const previousUncommitted = new Set(
      previousSelectedItemIds.filter((itemId) => !committedItemIds.includes(itemId)),
    );
    const available = scores
      .filter((entry) => !committedItemIds.includes(entry.itemId))
      .sort((a, b) => {
        const adjustedA = a.score + (previousUncommitted.has(a.itemId) ? ADAPTIVE_POLICY_V1_CONFIG.choice.switchMinImprovement : 0);
        const adjustedB = b.score + (previousUncommitted.has(b.itemId) ? ADAPTIVE_POLICY_V1_CONFIG.choice.switchMinImprovement : 0);
        return adjustedB - adjustedA || compareScores(a, b);
      });
    const selectedItemIds = [
      ...committedItemIds,
      ...available.slice(0, remainingCount).map((entry) => entry.itemId),
    ];
    const selectedScores = selectedItemIds
      .map((itemId) => scores.find((entry) => entry.itemId === itemId))
      .filter((entry): entry is AdaptiveItemScoreV1 => entry !== undefined);
    const confidence = selectedScores.length === 0
      ? reconstructed.confidence
      : selectedScores.reduce((sum, entry) => sum + entry.confidence, 0) / selectedScores.length;
    const replacementOptions = buildCommittedReplacementOptionsV1(
      group,
      selectedItemIds,
      committedItemIds,
      scores,
      context.ownedItemIds,
      context.itemGraph,
    );

    return withChoiceCompatibility({
      ...reconstructed,
      selectedItemIds,
      committedItemIds,
      committed: committedItemIds.length > 0,
      confidence,
      scores,
      replacementOptions,
    });
  }
}

export function reconstructChoiceStateV1(
  group: ConsensusBuildGroupV1,
  ownedItemIds: readonly number[],
  itemGraph: RecommendationItemGraph,
  previousCommittedItemIdsOrId?: readonly number[] | number,
): AdaptiveChoiceStateV1 {
  const owned = new Set(ownedItemIds);
  const alternativeIds = group.candidates.map((candidate) => candidate.itemId).sort((a, b) => a - b);
  const previousCommittedItemIds = normalizeLegacyChoiceIds(previousCommittedItemIdsOrId, group);
  const ownedTargets = alternativeIds.filter((itemId) => itemGraph.isTargetSatisfied(itemId, owned));

  const closures = new Map<number, ReadonlySet<number>>();
  const componentOwners = new Map<number, number>();
  for (const itemId of alternativeIds) {
    const closure = componentClosureV1(itemId, itemGraph);
    closures.set(itemId, closure);
    for (const componentId of closure) componentOwners.set(componentId, (componentOwners.get(componentId) ?? 0) + 1);
  }

  const investedBranches = alternativeIds.filter((itemId) => {
    const closure = closures.get(itemId) ?? new Set<number>();
    for (const componentId of closure) {
      if ((componentOwners.get(componentId) ?? 0) === 1 && owned.has(componentId)) return true;
    }
    return false;
  });
  const evidencedItemIds = uniqueNumbers([...ownedTargets, ...investedBranches]).sort((a, b) => a - b);

  if (evidencedItemIds.length > group.maxSelect) {
    const validPrevious = previousCommittedItemIds.filter((itemId) => evidencedItemIds.includes(itemId));
    if (validPrevious.length > 0 && validPrevious.length <= group.maxSelect) {
      return withChoiceCompatibility({
        groupId: group.groupId,
        selectedItemIds: validPrevious,
        committedItemIds: validPrevious,
        committed: true,
        confidence: 1,
        externallyDiverged: false,
      });
    }
    return withChoiceCompatibility({
      groupId: group.groupId,
      selectedItemIds: evidencedItemIds,
      committedItemIds: evidencedItemIds,
      committed: false,
      confidence: 0,
      externallyDiverged: true,
    });
  }

  return withChoiceCompatibility({
    groupId: group.groupId,
    selectedItemIds: evidencedItemIds,
    committedItemIds: evidencedItemIds,
    committed: evidencedItemIds.length > 0,
    confidence: evidencedItemIds.length > 0 ? 1 : 0,
    externallyDiverged: false,
  });
}

export function componentClosureV1(itemId: number, itemGraph: RecommendationItemGraph): ReadonlySet<number> {
  return new Set(itemGraph.getTransitiveComponentIds(itemId));
}

export function choiceBranchCommitmentEvidenceItemIdsV1(
  group: ConsensusBuildGroupV1,
  targetItemId: number,
  ownedItemIds: readonly number[],
  itemGraph: RecommendationItemGraph,
): readonly number[] {
  const owned = new Set(ownedItemIds);
  const result: number[] = [...itemGraph.getSatisfyingOwnedItemIds(targetItemId, owned)];

  const closures = new Map<number, ReadonlySet<number>>();
  const componentOwners = new Map<number, number>();
  for (const candidate of group.candidates) {
    const closure = componentClosureV1(candidate.itemId, itemGraph);
    closures.set(candidate.itemId, closure);
    for (const componentId of closure) componentOwners.set(componentId, (componentOwners.get(componentId) ?? 0) + 1);
  }
  for (const componentId of closures.get(targetItemId) ?? []) {
    if ((componentOwners.get(componentId) ?? 0) === 1 && owned.has(componentId)) result.push(componentId);
  }
  return uniqueNumbers(result).sort((a, b) => a - b);
}

function buildCommittedReplacementOptionsV1(
  group: ConsensusBuildGroupV1,
  selectedItemIds: readonly number[],
  committedItemIds: readonly number[],
  scores: readonly AdaptiveItemScoreV1[],
  ownedItemIds: readonly number[],
  itemGraph: RecommendationItemGraph,
): readonly AdaptiveChoiceReplacementOptionV1[] {
  if (committedItemIds.length === 0) return [];
  const selected = new Set(selectedItemIds);
  const scoreByItemId = new Map(scores.map((entry) => [entry.itemId, entry.score]));
  const options: AdaptiveChoiceReplacementOptionV1[] = [];

  for (const candidate of group.candidates) {
    if (selected.has(candidate.itemId)) continue;
    const targetScore = scoreByItemId.get(candidate.itemId);
    if (targetScore === undefined) continue;

    for (const replacedItemId of committedItemIds) {
      const replacedScore = scoreByItemId.get(replacedItemId);
      if (replacedScore === undefined) continue;
      const contextualImprovement = targetScore - replacedScore;
      if (contextualImprovement < ADAPTIVE_POLICY_V1_CONFIG.choice.committedReplaceMinImprovement) continue;
      const sellEvidenceItemIds = choiceBranchCommitmentEvidenceItemIdsV1(
        group,
        replacedItemId,
        ownedItemIds,
        itemGraph,
      );
      if (sellEvidenceItemIds.length === 0) continue;
      // Ancestor scores cannot justify liquidating an owned higher upgrade.
      if (sellEvidenceItemIds.some((itemId) => itemGraph.isComponentAncestor(replacedItemId, itemId))) continue;
      options.push({
        groupId: group.groupId,
        targetItemId: candidate.itemId,
        replacedItemId,
        sellEvidenceItemIds,
        supportItemIds: uniqueNumbers([
          candidate.itemId,
          ...componentClosureV1(candidate.itemId, itemGraph),
        ]).sort((a, b) => a - b),
        replacedSupportItemIds: uniqueNumbers([
          replacedItemId,
          ...componentClosureV1(replacedItemId, itemGraph),
        ]).sort((a, b) => a - b),
        contextualImprovement,
      });
    }
  }

  return options
    .sort((a, b) =>
      b.contextualImprovement - a.contextualImprovement ||
      a.targetItemId - b.targetItemId ||
      a.replacedItemId - b.replacedItemId,
    )
    .slice(0, Math.max(1, group.maxSelect));
}

function choiceScorerContextV1(
  itemId: number,
  context: AdaptiveChoiceResolutionContextV1,
): AdaptiveItemScoreContextV1 {
  const decisionState = context.decisionState;
  if (!decisionState) return context.scorerContext;

  const resolution = resolveUpgradeExecutionPathV1(decisionState, itemId, context.itemGraph);
  const economyPenalty = choiceEconomyPenaltyV1(resolution, decisionState);
  const investmentDelta = choiceInvestmentDeltaV1(resolution, context);
  if (economyPenalty === undefined && investmentDelta === undefined) return context.scorerContext;

  return {
    ...context.scorerContext,
    transactionPenalty: economyPenalty === undefined
      ? context.scorerContext.transactionPenalty
      : clamp01((context.scorerContext.transactionPenalty ?? 0) + economyPenalty),
    investmentDelta: investmentDelta ?? context.scorerContext.investmentDelta,
  };
}

function choiceEconomyPenaltyV1(
  resolution: UpgradeExecutionResolutionV1,
  decisionState: RecommendationDecisionState,
): number | undefined {
  const cost = executionSoulsCostV1(resolution);
  const spendable = decisionState.economy.spendableSouls;
  if (cost === undefined || spendable.evidence === 'UNKNOWN' || spendable.value === undefined ||
      !Number.isFinite(spendable.value) || spendable.value < 0) {
    return undefined;
  }
  if (cost <= spendable.value) return 0;
  return clamp01((cost - spendable.value) / Math.max(1, cost));
}

function executionSoulsCostV1(resolution: UpgradeExecutionResolutionV1): number | undefined {
  if (resolution.kind === 'EXACT_OWNED') return 0;
  if (resolution.kind === 'DIRECT_BUY' || resolution.kind === 'DIRECT_UPGRADE' || resolution.kind === 'MULTI_STEP_UPGRADE') {
    return resolution.soulsCost;
  }
  return undefined;
}

function choiceInvestmentDeltaV1(
  resolution: UpgradeExecutionResolutionV1,
  context: AdaptiveChoiceResolutionContextV1,
): AdaptiveItemScoreContextV1['investmentDelta'] | undefined {
  if (!context.decisionState || !context.investment || !context.economyRules ||
      context.investment.evidence === 'UNKNOWN') {
    return undefined;
  }
  const projectedItemIds = projectChoiceItemIdsV1(
    resolution,
    [...context.decisionState.inventory.heldByItemId.keys()],
  );
  if (!projectedItemIds) return undefined;
  const projectedInvestment = deriveAdaptiveInvestmentStateV1(
    projectedItemIds,
    context.itemGraph,
    context.economyRules,
  );
  return deriveChoiceInvestmentScoreDeltaV1(context.investment, projectedInvestment);
}

function projectChoiceItemIdsV1(
  resolution: UpgradeExecutionResolutionV1,
  ownedItemIds: readonly number[],
): readonly number[] | undefined {
  const owned = new Set(ownedItemIds);
  if (resolution.kind === 'NOT_EXECUTABLE') return undefined;
  if (resolution.kind === 'EXACT_OWNED') return [...owned].sort((a, b) => a - b);

  if (resolution.kind === 'DIRECT_BUY') {
    owned.add(resolution.targetItemId);
    return [...owned].sort((a, b) => a - b);
  }

  for (const sourceItemId of resolution.sourceItemIds) owned.delete(sourceItemId);
  owned.add(resolution.kind === 'DIRECT_UPGRADE' ? resolution.targetItemId : resolution.nextTargetItemId);
  return [...owned].sort((a, b) => a - b);
}

function deriveChoiceInvestmentScoreDeltaV1(
  before: AdaptiveInvestmentStateV1,
  after: AdaptiveInvestmentStateV1,
): NonNullable<AdaptiveItemScoreContextV1['investmentDelta']> {
  if (before.evidence === 'UNKNOWN' || after.evidence === 'UNKNOWN') {
    return {
      evidence: 'UNKNOWN',
      breakpointsCrossed: 0,
      distanceReducedSouls: 0,
      achievedBreakpointsLost: 0,
    };
  }

  let breakpointsCrossed = 0;
  let distanceReducedSouls = 0;
  let achievedBreakpointsLost = 0;
  for (const type of ['weapon', 'vitality', 'spirit'] as const) {
    const previous = before.tracks[type];
    const next = after.tracks[type];
    const previousAchieved = previous.achievedBreakpoint ?? 0;
    const nextAchieved = next.achievedBreakpoint ?? 0;
    if (nextAchieved > previousAchieved) breakpointsCrossed += 1;
    if (nextAchieved < previousAchieved) achievedBreakpointsLost += 1;
    if (previous.nextBreakpoint !== undefined && previous.nextBreakpoint === next.nextBreakpoint) {
      distanceReducedSouls += Math.max(
        0,
        (previous.soulsToNextBreakpoint ?? 0) - (next.soulsToNextBreakpoint ?? 0),
      );
    }
  }
  return {
    evidence: 'RECONSTRUCTED',
    breakpointsCrossed,
    distanceReducedSouls,
    achievedBreakpointsLost,
  };
}

function requiredChoiceCount(group: ConsensusBuildGroupV1): number {
  const maxSelect = Math.max(1, Math.min(group.maxSelect, group.candidates.length));
  return Math.max(1, Math.min(maxSelect, group.minSelect));
}

function normalizeChoiceIds(
  itemIds: readonly number[],
  group: ConsensusBuildGroupV1,
): number[] {
  const allowed = new Set(group.candidates.map((candidate) => candidate.itemId));
  return uniqueNumbers(itemIds.filter((itemId) => allowed.has(itemId))).sort((a, b) => a - b);
}

function normalizeLegacyChoiceIds(
  itemIdsOrId: readonly number[] | number | undefined,
  group: ConsensusBuildGroupV1,
): number[] {
  if (typeof itemIdsOrId === 'number') return normalizeChoiceIds([itemIdsOrId], group);
  if (itemIdsOrId === undefined) return [];
  return normalizeChoiceIds(itemIdsOrId, group);
}

function optionalSingleton(value: number | undefined): number[] {
  return value === undefined ? [] : [value];
}

function compareScores(a: AdaptiveItemScoreV1, b: AdaptiveItemScoreV1): number {
  return b.score - a.score || b.confidence - a.confidence || a.itemId - b.itemId;
}

function withChoiceCompatibility<T extends Omit<AdaptiveChoiceStateV1, 'selectedItemId' | 'committedItemId'>>(
  state: T,
): T & AdaptiveChoiceStateV1 {
  return {
    ...state,
    selectedItemId: state.selectedItemIds[0],
    committedItemId: state.committed ? state.committedItemIds[0] : undefined,
  };
}

function uniqueNumbers(values: readonly number[]): number[] {
  return [...new Set(values)];
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}
