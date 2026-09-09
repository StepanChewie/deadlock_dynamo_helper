import { Injectable } from '@nestjs/common';
import {
  DEFAULT_RECOMMENDATION_CANDIDATE_RULES,
  RecommendationCandidate,
  RecommendationCandidateGeneratorRules,
  RecommendationItemGraph,
  generateRecommendationCandidates,
  resolveUpgradeExecutionPathV1,
} from '@deadlock-live-probe/build-domain';
import {
  AdaptiveActionV1,
  AdaptiveBuildPlanChangeV1,
  AdaptivePlannedItemV1,
  AdaptiveRecommendationResultV1,
  AdaptiveScoredActionV1,
  AdaptiveScoreComponentV1,
} from '@deadlock-live-probe/shared';
import {
  AdaptiveChoiceReplacementOptionV1,
  AdaptiveChoiceResolverV1Service,
  choiceBranchCommitmentEvidenceItemIdsV1,
  componentClosureV1,
  reconstructChoiceStateV1,
} from './adaptive-choice-resolver-v1.service';
import { AdaptiveDecisionStateV1 } from './adaptive-decision-state-v1.service';
import {
  AdaptiveEvidenceScorerV1Service,
  AdaptiveItemScoreContextV1,
  AdaptiveItemScoreV1,
} from './adaptive-evidence-scorer-v1.service';
import { AdaptivePhaseEligibilityV1Service, groupCompletedV1 } from './adaptive-phase-eligibility-v1.service';
import {
  AdaptivePlannerNodeV1,
  ProjectPlannerCandidateResultV1,
  createAdaptivePlannerNodeV1,
  projectPlannerCandidateV1,
  refreshPlannerChoiceStateV1,
} from './adaptive-planner-transition-v1';
import { ADAPTIVE_POLICY_V1_CONFIG } from './statlocker-adaptive.config';
import { StatlockerEvidenceBundleV1 } from './statlocker-evidence.service';
import {
  AdaptiveGameStateV1,
  classifyAdaptiveGameStateV1,
  computeAdaptiveGameStateBlendV1,
  computeSoulDeltaV1,
} from './adaptive-game-state';
import {
  ConsensusBuildGroupV1,
  ConsensusSkeletonV1,
} from './statlocker-adaptive.types';
import {
  findConsensusCandidateV1,
  findConsensusGroupByItemV1,
  phaseOrderV1,
} from './structured-build-v1';
import { AdaptiveRecommendationObservabilityV1Service } from './adaptive-recommendation-observability-v1.service';
import {
  BuildContractExecutionStateV1,
  BuildContractV1,
  BuildSituationalWindowStateV1,
  BuildSlotReservationV1,
  compileBuildContractV1,
  createOutOfDistributionBuildContractV1,
} from './build-contract-v1';
import {
  BuildStrategyGoalV1,
  BuildStrategySpecV1,
  compileStructuredConsensusStrategyV1,
  filterRecommendationCandidatesForActiveGoalsV1,
  resolveActiveBuildStrategyGoalsV1,
} from './build-strategy-v1';

export interface AdaptiveBuildPlannerInputV1 {
  decision: AdaptiveDecisionStateV1;
  evidence: StatlockerEvidenceBundleV1;
  previousResult?: Pick<
    AdaptiveRecommendationResultV1,
    'recommendedBuild' | 'totalScore' | 'nextAction' | 'confidence'
  >;
  recentPurchasedItemIds?: readonly number[];
  recentSoldItemIds?: readonly number[];
  situationalWindowStates?: readonly BuildSituationalWindowStateV1[];
  suppressObservability?: boolean;
}

export interface AdaptiveBuildPlannerResultV1 {
  gameState: AdaptiveGameStateV1;
  nextAction: AdaptiveActionV1;
  recommendedBuild: readonly AdaptivePlannedItemV1[];
  changes: readonly AdaptiveBuildPlanChangeV1[];
  rankedImmediateCandidates: readonly AdaptiveScoredActionV1[];
  totalScore: number;
  confidence: number;
  buildContract: BuildContractV1;
  plannerVersion: 'adaptive-build-planner-v1';
}

interface SemanticPlanV1 {
  selectedFinalItemIds: ReadonlySet<number>;
  futurePlannedFinalItemIds: ReadonlySet<number>;
  activeTargetItemIds: ReadonlySet<number>;
  targetItemIds: ReadonlySet<number>;
  futureOwnersByTargetItemId: ReadonlyMap<number, readonly number[]>;
  supportOwnersByItemId: ReadonlyMap<number, readonly number[]>;
  selectedChoiceItemIdsByGroup: ReadonlyMap<string, readonly number[]>;
  committedChoiceItemIdsByGroup: ReadonlyMap<string, readonly number[]>;
  committedChoiceEvidenceItemIds: ReadonlySet<number>;
  choiceReplacementOptions: readonly AdaptiveChoiceReplacementOptionV1[];
  completedGroupIds: ReadonlySet<string>;
  externallyDivergedGroupIds: ReadonlySet<string>;
  orderByItemId: ReadonlyMap<number, number>;
}

interface ScoredPlannerCandidateV1 {
  candidate: RecommendationCandidate;
  score: number;
  confidence: number;
  components: readonly AdaptiveScoreComponentV1[];
  adaptive: AdaptiveScoredActionV1;
  projected: ProjectPlannerCandidateResultV1;
}

@Injectable()
export class AdaptiveBuildPlannerV1Service {
  readonly version = 'adaptive-build-planner-v1' as const;
  private readonly phaseEligibility: AdaptivePhaseEligibilityV1Service;
  private readonly choiceResolver: AdaptiveChoiceResolverV1Service;

  constructor(
    private readonly scorer: AdaptiveEvidenceScorerV1Service,
    phaseEligibility?: AdaptivePhaseEligibilityV1Service,
    choiceResolver?: AdaptiveChoiceResolverV1Service,
    private readonly observability?: AdaptiveRecommendationObservabilityV1Service,
  ) {
    this.phaseEligibility = phaseEligibility ?? new AdaptivePhaseEligibilityV1Service();
    this.choiceResolver = choiceResolver ?? new AdaptiveChoiceResolverV1Service(scorer);
  }

  plan(input: AdaptiveBuildPlannerInputV1): AdaptiveBuildPlannerResultV1 {
    const config = ADAPTIVE_POLICY_V1_CONFIG;
    const skeleton = asStructuredSkeleton(
      input.evidence.byDataset.CONSENSUS_SKELETON.payload,
      input.decision.state.heroId,
    );
    const soulDelta = computeSoulDeltaV1(input.decision.ourTeamSouls, input.decision.enemyTeamSouls);
    const gameState = classifyAdaptiveGameStateV1(
      input.decision.ourTeamSouls,
      input.decision.enemyTeamSouls,
      config.gameStateThreshold,
    );
    const gameStateBlend = soulDelta === undefined
      ? { ahead: 0, even: 0, behind: 0 }
      : computeAdaptiveGameStateBlendV1(soulDelta, config.gameStateThreshold, config.gameStateBlendWidth);
    const ownedItemIds = [...input.decision.state.inventory.heldByItemId.keys()].sort((a, b) => a - b);
    const owned = new Set(ownedItemIds);
    const baseScorerContext: AdaptiveItemScoreContextV1 = {
      heroId: input.decision.state.heroId,
      enemyHeroIds: input.decision.enemyHeroIds,
      gameTimeSec: input.decision.state.gameTimeSec,
      gameStateBlend,
      ownedItemIds,
      plannedPrefixItemIds: [],
      evidence: input.evidence,
    };

    if (!skeleton) {
      return {
        gameState,
        nextAction: {
          actionKey: 'WAIT',
          type: 'WAIT',
          reasonCodes: ['STRUCTURED_SKELETON_UNAVAILABLE'],
        },
        recommendedBuild: ownedItemIds.map((itemId, index) => ({
          itemId,
          position: index + 1,
          status: 'OWNED',
          score: 0,
          confidence: 0,
          skeletonStrength: 0,
          contextualSupport: 0,
          reasonCodes: ['OWNED_ITEM'],
        })),
        changes: buildPlanChanges(input.previousResult?.recommendedBuild ?? [], []),
        rankedImmediateCandidates: [],
        totalScore: 0,
        confidence: 0,
        buildContract: createOutOfDistributionBuildContractV1(['STRUCTURED_SKELETON_UNAVAILABLE']),
        plannerVersion: this.version,
      };
    }

    const strategy = compileStructuredConsensusStrategyV1({
      skeleton,
      itemGraph: input.decision.itemGraph,
      rulesetId: input.decision.rulesetId,
      situationalWindows: (input.situationalWindowStates ?? []).map((window) => ({
        windowId: window.windowId,
        targetItemIds: window.targetItemIds,
      })),
    });
    const semantic = this.resolveSemanticPlan(
      input,
      skeleton,
      gameState,
      baseScorerContext,
      owned,
    );
    const initialNode = createAdaptivePlannerNodeV1({
      decisionState: input.decision.state,
      slots: input.decision.slots,
      investment: input.decision.investment,
      selectedChoiceItemIdsByGroup: semantic.selectedChoiceItemIdsByGroup,
      committedChoiceItemIdsByGroup: semantic.committedChoiceItemIdsByGroup,
      completedGroupIds: semantic.completedGroupIds,
    });
    const recentPurchased = new Set(input.recentPurchasedItemIds ?? []);
    const recentSold = new Set(input.recentSoldItemIds ?? []);
    const immediate = this.evaluateNodeCandidates(
      input,
      skeleton,
      strategy,
      semantic,
      initialNode,
      baseScorerContext,
      recentPurchased,
      recentSold,
    );
    const bestNode = this.searchBestPath(
      input,
      skeleton,
      strategy,
      semantic,
      initialNode,
      baseScorerContext,
      recentPurchased,
      recentSold,
    );
    const firstCandidate = bestNode.actions[0] ?? immediate[0]?.candidate;
    const candidateNextTarget = firstCandidate ? candidateTargetItemId(firstCandidate) : undefined;
    const proposedBuild = this.buildRecommendedBuild(
      input,
      skeleton,
      semantic,
      bestNode,
      baseScorerContext,
      recentSold,
      candidateNextTarget,
    );
    const actualNextTarget = firstPlannedItem(proposedBuild);
    const rawProposedAction = firstCandidate
      ? mapCandidateAction(firstCandidate, actualNextTarget, skeleton)
      : semanticNoTransactionAction('WAIT', undefined, actualNextTarget, skeleton);
    const proposedContract = compilePlannerBuildContractV1(
      input,
      skeleton,
      strategy,
      semantic,
      bestNode,
      proposedBuild,
      rawProposedAction,
    );
    const proposedAction = proposedContract.status === 'REPLAN_REQUIRED' && isAdaptiveTransactionAction(rawProposedAction)
      ? {
          actionKey: 'HOLD:BUILD_CONTRACT_REPLAN_REQUIRED',
          type: 'HOLD' as const,
          targetItemId: actualNextTarget,
          reasonCodes: ['BUILD_CONTRACT_REPLAN_REQUIRED', ...proposedContract.replanReasonCodes],
        }
      : rawProposedAction;
    const proposedScore = bestNode.utility;
    const proposedConfidence = bestNode.actions.length > 0
      ? clamp01(bestNode.confidenceSum / bestNode.actions.length)
      : aggregateImmediateConfidence(immediate);
    const postCommitReplacement = proposedAction.type === 'REPLACE' &&
      semantic.choiceReplacementOptions.some((option) => choiceReplacementStarted(option, bestNode));
    if (postCommitReplacement && !input.suppressObservability) this.observability?.recordPostCommitReplacement();

    const previous = input.previousResult;
    const preservePrevious = Boolean(
      previous &&
      this.previousPlanStillValid(previous.recommendedBuild, owned, semantic, immediate) &&
      proposedScore - previous.totalScore < config.minPlanSwitchImprovement,
    );
    if (preservePrevious && previous) {
      const preservedBuild = rebasePlanAgainstOwnedInventory(previous.recommendedBuild, ownedItemIds);
      const preservedTarget = firstPlannedItem(preservedBuild);
      const hold = semanticNoTransactionAction('HOLD', undefined, preservedTarget, skeleton);
      const buildContract = compilePlannerBuildContractV1(
        input,
        skeleton,
        strategy,
        semantic,
        bestNode,
        preservedBuild,
        hold,
      );
      return {
        gameState,
        nextAction: hold,
        recommendedBuild: preservedBuild,
        changes: buildPlanChanges(previous.recommendedBuild, preservedBuild),
        rankedImmediateCandidates: immediate.map((entry) => entry.adaptive),
        totalScore: previous.totalScore,
        confidence: Math.min(previous.confidence, proposedConfidence || previous.confidence),
        buildContract,
        plannerVersion: this.version,
      };
    }

    return {
      gameState,
      nextAction: proposedAction,
      recommendedBuild: proposedBuild,
      changes: buildPlanChanges(previous?.recommendedBuild ?? [], proposedBuild),
      rankedImmediateCandidates: immediate.map((entry) => entry.adaptive),
      totalScore: proposedScore,
      confidence: clamp01(Math.max(proposedConfidence, immediate[0]?.confidence ?? 0) * evidenceConfidenceFactor(input.evidence)),
      buildContract: proposedContract,
      plannerVersion: this.version,
    };
  }

  private resolveSemanticPlan(
    input: AdaptiveBuildPlannerInputV1,
    skeleton: ConsensusSkeletonV1,
    gameState: AdaptiveGameStateV1,
    scorerContext: AdaptiveItemScoreContextV1,
    owned: ReadonlySet<number>,
  ): SemanticPlanV1 {
    const completedGroupIds = new Set<string>();
    for (const group of skeleton.groups) {
      if (groupCompletedV1(group, owned, input.decision.itemGraph)) completedGroupIds.add(group.groupId);
    }

    const selectedChoiceItemIdsByGroup = new Map<string, readonly number[]>();
    const committedChoiceItemIdsByGroup = new Map<string, readonly number[]>();
    const committedChoiceEvidenceItemIds = new Set<number>();
    const replacementOptionsByGroup = new Map<string, readonly AdaptiveChoiceReplacementOptionV1[]>();
    const externallyDivergedGroupIds = new Set<string>();
    for (const group of skeleton.groups.filter((entry) => entry.type === 'CHOICE')) {
      const eligibility = this.phaseEligibility.evaluateGroup(group, {
        skeleton,
        ownedItemIds: owned,
        completedGroupIds,
        gameTimeSec: input.decision.state.gameTimeSec,
        gameState,
        investment: input.decision.investment,
        itemGraph: input.decision.itemGraph,
      });
      const mayUseContextualScoring = eligibility === 'ELIGIBLE' || eligibility === 'COMPLETED';
      const previousSelectedItemIds = previousSelectedChoiceItems(input.previousResult?.recommendedBuild, group);
      const resolved = mayUseContextualScoring
        ? this.choiceResolver.resolveChoice(group, {
            scorerContext,
            itemGraph: input.decision.itemGraph,
            ownedItemIds: [...owned],
            previousSelectedItemIds,
          })
        : undefined;
      const reconstructed = resolved ?? reconstructChoiceStateV1(
        group,
        [...owned],
        input.decision.itemGraph,
      );
      const selectedItemIds = resolved?.selectedItemIds ?? reconstructed.selectedItemIds;
      const committedItemIds = resolved?.committedItemIds ?? reconstructed.committedItemIds;
      const replacementOptions = resolved?.replacementOptions ?? [];
      const externallyDiverged = resolved?.externallyDiverged ?? reconstructed.externallyDiverged;

      if (selectedItemIds.length > 0) selectedChoiceItemIdsByGroup.set(group.groupId, selectedItemIds);
      if (committedItemIds.length > 0) {
        committedChoiceItemIdsByGroup.set(group.groupId, committedItemIds);
        for (const committedItemId of committedItemIds) {
          for (const evidenceItemId of choiceBranchCommitmentEvidenceItemIdsV1(
            group,
            committedItemId,
            [...owned],
            input.decision.itemGraph,
          )) {
            committedChoiceEvidenceItemIds.add(evidenceItemId);
          }
        }
      }
      if (replacementOptions.length > 0) replacementOptionsByGroup.set(group.groupId, replacementOptions);
      if (externallyDiverged) {
        externallyDivergedGroupIds.add(group.groupId);
        if (!input.suppressObservability) {
          this.observability?.recordChoiceGroupViolationPrevented();
          this.observability?.recordExternallyDivergedChoiceState();
        }
      }
    }

    const selectedFinalItemIds = new Set<number>();
    const enabledReplacementOptions: AdaptiveChoiceReplacementOptionV1[] = [];
    const orderByItemId = new Map<number, number>();
    skeleton.groups.forEach((group, groupIndex) => {
      group.candidates.forEach((candidate, candidateIndex) => {
        orderByItemId.set(candidate.itemId, groupIndex * 100 + candidateIndex);
      });
    });
    const openSituationalTargets = openSituationalTargetIds(input.situationalWindowStates ?? []);

    for (const group of skeleton.groups) {
      const eligibility = this.phaseEligibility.evaluateGroup(group, {
        skeleton,
        ownedItemIds: owned,
        completedGroupIds,
        gameTimeSec: input.decision.state.gameTimeSec,
        gameState,
        investment: input.decision.investment,
        itemGraph: input.decision.itemGraph,
      });

      if (group.type === 'OPTIONAL') {
        const allowed = group.candidates.filter((candidate) => openSituationalTargets.has(candidate.itemId));
        if (allowed.length === 0) continue;
        const activated = allowed
          .map((candidate) => ({
            itemId: candidate.itemId,
            score: this.scorer.scoreItem(candidate.itemId, scorerContext).score,
          }))
          .filter((entry) => entry.score >= ADAPTIVE_POLICY_V1_CONFIG.optionalActivationMinScore)
          .sort((a, b) => b.score - a.score || a.itemId - b.itemId)
          .slice(0, Math.max(1, group.maxSelect));
        for (const entry of activated) selectedFinalItemIds.add(entry.itemId);
        continue;
      }

      if (eligibility === 'COMPLETED') {
        if (group.type === 'CHOICE') {
          for (const selected of selectedChoiceItemIdsByGroup.get(group.groupId) ?? []) {
            if (input.decision.itemGraph.isTargetSatisfied(selected, owned)) selectedFinalItemIds.add(selected);
          }
          enabledReplacementOptions.push(...(replacementOptionsByGroup.get(group.groupId) ?? []));
        } else {
          for (const candidate of group.candidates) {
            if (input.decision.itemGraph.isTargetSatisfied(candidate.itemId, owned)) selectedFinalItemIds.add(candidate.itemId);
          }
        }
        continue;
      }
      if (eligibility !== 'ELIGIBLE') {
        if (eligibility === 'NOT_YET_ELIGIBLE' && group.phase !== 'EARLY') {
          if (!input.suppressObservability) this.observability?.recordPhaseViolationPrevented();
        }
        continue;
      }

      if (group.type === 'CHOICE') {
        for (const selected of selectedChoiceItemIdsByGroup.get(group.groupId) ?? []) {
          selectedFinalItemIds.add(selected);
        }
        enabledReplacementOptions.push(...(replacementOptionsByGroup.get(group.groupId) ?? []));
        continue;
      }

      const satisfiedCandidates = group.candidates
        .filter((candidate) => input.decision.itemGraph.isTargetSatisfied(candidate.itemId, owned))
        .map((candidate) => candidate.itemId);
      for (const itemId of satisfiedCandidates) selectedFinalItemIds.add(itemId);
      const needed = Math.max(0, Math.max(1, group.minSelect) - satisfiedCandidates.length);
      const selected = group.candidates
        .filter((candidate) => !input.decision.itemGraph.isTargetSatisfied(candidate.itemId, owned))
        .map((candidate) => ({
          itemId: candidate.itemId,
          score: this.scorer.scoreItem(candidate.itemId, scorerContext).score,
        }))
        .sort((a, b) => b.score - a.score || a.itemId - b.itemId)
        .slice(0, needed);
      for (const entry of selected) selectedFinalItemIds.add(entry.itemId);
    }

    const targetItemIds = new Set<number>();
    const supportOwners = new Map<number, Set<number>>();
    for (const finalItemId of selectedFinalItemIds) {
      if (!input.decision.itemGraph.isTargetSatisfied(finalItemId, owned)) targetItemIds.add(finalItemId);
      for (const componentId of componentClosureV1(finalItemId, input.decision.itemGraph)) {
        if (input.decision.itemGraph.isTargetSatisfied(componentId, owned)) continue;
        targetItemIds.add(componentId);
        const owners = supportOwners.get(componentId) ?? new Set<number>();
        owners.add(finalItemId);
        supportOwners.set(componentId, owners);
      }
    }
    for (const option of enabledReplacementOptions) {
      for (const supportItemId of option.supportItemIds) {
        if (input.decision.itemGraph.isTargetSatisfied(supportItemId, owned)) continue;
        const owners = supportOwners.get(supportItemId) ?? new Set<number>();
        owners.add(option.targetItemId);
        supportOwners.set(supportItemId, owners);
      }
    }

    const futurePlannedFinalItemIds = this.selectNearFutureRequiredTargets(
      input,
      skeleton,
      gameState,
      owned,
      completedGroupIds,
      targetItemIds,
      selectedChoiceItemIdsByGroup,
    );
    const activeTargetItemIds = new Set(targetItemIds);
    const futureOwners = new Map<number, Set<number>>();
    for (const finalItemId of futurePlannedFinalItemIds) {
      if (!input.decision.itemGraph.isTargetSatisfied(finalItemId, owned)) targetItemIds.add(finalItemId);
      futureOwners.set(finalItemId, new Set([finalItemId]));
      for (const componentId of componentClosureV1(finalItemId, input.decision.itemGraph)) {
        if (input.decision.itemGraph.isTargetSatisfied(componentId, owned)) continue;
        targetItemIds.add(componentId);
        const futureTargetOwners = futureOwners.get(componentId) ?? new Set<number>();
        futureTargetOwners.add(finalItemId);
        futureOwners.set(componentId, futureTargetOwners);
        const owners = supportOwners.get(componentId) ?? new Set<number>();
        owners.add(finalItemId);
        supportOwners.set(componentId, owners);
      }
    }

    return {
      selectedFinalItemIds,
      futurePlannedFinalItemIds,
      activeTargetItemIds,
      targetItemIds,
      futureOwnersByTargetItemId: new Map(
        [...futureOwners.entries()].map(([itemId, owners]) => [itemId, [...owners].sort((a, b) => a - b)]),
      ),
      supportOwnersByItemId: new Map(
        [...supportOwners.entries()].map(([itemId, owners]) => [itemId, [...owners].sort((a, b) => a - b)]),
      ),
      selectedChoiceItemIdsByGroup,
      committedChoiceItemIdsByGroup,
      committedChoiceEvidenceItemIds,
      choiceReplacementOptions: enabledReplacementOptions.sort(compareReplacementOptions),
      completedGroupIds,
      externallyDivergedGroupIds,
      orderByItemId,
    };
  }

  private selectNearFutureRequiredTargets(
    input: AdaptiveBuildPlannerInputV1,
    skeleton: ConsensusSkeletonV1,
    gameState: AdaptiveGameStateV1,
    owned: ReadonlySet<number>,
    completedGroupIds: ReadonlySet<string>,
    activeTargetItemIds: ReadonlySet<number>,
    selectedChoiceItemIdsByGroup: ReadonlyMap<string, readonly number[]>,
  ): ReadonlySet<number> {
    let remainingDepth = ADAPTIVE_POLICY_V1_CONFIG.planningDepth - activeTargetItemIds.size;
    if (remainingDepth <= 0) return new Set<number>();

    const futureRequired = skeleton.groups.filter((group) => {
      if (group.type !== 'REQUIRED' && group.type !== 'CHOICE') return false;
      return this.phaseEligibility.evaluateGroup(group, {
        skeleton,
        ownedItemIds: owned,
        completedGroupIds,
        gameTimeSec: input.decision.state.gameTimeSec,
        gameState,
        investment: input.decision.investment,
        itemGraph: input.decision.itemGraph,
      }) === 'NOT_YET_ELIGIBLE';
    });
    if (futureRequired.length === 0) return new Set<number>();

    const nextPhaseOrder = Math.min(...futureRequired.map((group) => phaseOrderV1(group.phase)));
    const result = new Set<number>();
    for (const group of futureRequired.filter((entry) => phaseOrderV1(entry.phase) === nextPhaseOrder)) {
      const selectedChoiceItemIds = group.type === 'CHOICE'
        ? selectedChoiceItemIdsByGroup.get(group.groupId) ?? []
        : [];
      if (group.type === 'CHOICE' && selectedChoiceItemIds.length === 0) continue;
      const satisfiedCount = group.candidates.filter((candidate) =>
        input.decision.itemGraph.isTargetSatisfied(candidate.itemId, owned)
      ).length;
      let needed = group.type === 'CHOICE'
        ? selectedChoiceItemIds.filter((itemId) =>
            !input.decision.itemGraph.isTargetSatisfied(itemId, owned)
          ).length
        : Math.max(0, Math.max(1, group.minSelect) - satisfiedCount);
      if (needed === 0) continue;

      const selectedChoiceSet = new Set(selectedChoiceItemIds);
      const ranked = group.candidates
        .filter((candidate) => !input.decision.itemGraph.isTargetSatisfied(candidate.itemId, owned))
        .filter((candidate) => group.type !== 'CHOICE' || selectedChoiceSet.has(candidate.itemId))
        .map((candidate) => ({ itemId: candidate.itemId, strength: candidate.strength }))
        .sort((a, b) => b.strength - a.strength || a.itemId - b.itemId);
      const staged: Array<{ itemId: number; steps: number }> = [];
      let stagedDepth = 0;
      for (const entry of ranked) {
        if (needed <= 0) break;
        const stepIds = uniqueNumbers([
          entry.itemId,
          ...componentClosureV1(entry.itemId, input.decision.itemGraph),
        ]).filter((itemId) => !input.decision.itemGraph.isTargetSatisfied(itemId, owned));
        const steps = Math.max(1, stepIds.length);
        if (stagedDepth + steps > remainingDepth) continue;
        staged.push({ itemId: entry.itemId, steps });
        stagedDepth += steps;
        needed -= 1;
      }
      if (needed > 0) break;
      for (const entry of staged) result.add(entry.itemId);
      remainingDepth -= stagedDepth;
      if (remainingDepth <= 0) break;
    }
    return result;
  }

  private searchBestPath(
    input: AdaptiveBuildPlannerInputV1,
    skeleton: ConsensusSkeletonV1,
    strategy: BuildStrategySpecV1,
    semantic: SemanticPlanV1,
    initialNode: AdaptivePlannerNodeV1,
    baseScorerContext: AdaptiveItemScoreContextV1,
    recentPurchased: ReadonlySet<number>,
    recentSold: ReadonlySet<number>,
  ): AdaptivePlannerNodeV1 {
    const config = ADAPTIVE_POLICY_V1_CONFIG;
    let beam: AdaptivePlannerNodeV1[] = [initialNode];
    let best = initialNode;

    for (let depth = 0; depth < config.planningDepth; depth += 1) {
      const expanded: AdaptivePlannerNodeV1[] = [];
      for (const node of beam) {
        if (node.actions[node.actions.length - 1]?.action.type === 'WAIT_SAVE') continue;
        const scored = this.evaluateNodeCandidates(
          input,
          skeleton,
          strategy,
          semantic,
          node,
          baseScorerContext,
          recentPurchased,
          recentSold,
        );
        for (const entry of scored) {
          const refreshed = this.refreshChoiceCommitments(entry.projected.node, skeleton, input);
          const utility = node.utility + entry.score * Math.pow(config.futureDiscount, node.actions.length);
          expanded.push({
            ...refreshed,
            utility,
            confidenceSum: node.confidenceSum + entry.confidence,
          });
        }
      }
      if (expanded.length === 0) break;
      beam = dedupePlannerNodes(expanded)
        .sort(comparePlannerNodes)
        .slice(0, config.beamWidth);
      const candidateBest = beam[0];
      if (candidateBest && comparePlannerNodes(candidateBest, best) < 0) best = candidateBest;
    }

    return best.actions.length > 0 ? best : beam.find((node) => node.actions.length > 0) ?? best;
  }

  private evaluateNodeCandidates(
    input: AdaptiveBuildPlannerInputV1,
    skeleton: ConsensusSkeletonV1,
    strategy: BuildStrategySpecV1,
    semantic: SemanticPlanV1,
    node: AdaptivePlannerNodeV1,
    baseScorerContext: AdaptiveItemScoreContextV1,
    recentPurchased: ReadonlySet<number>,
    recentSold: ReadonlySet<number>,
  ): ScoredPlannerCandidateV1[] {
    const rules = generatorRulesForNode(node);
    const contract = compileBuildContractV1({
      skeleton,
      itemGraph: input.decision.itemGraph,
      ownedItemIds: [...node.decisionState.inventory.heldByItemId.keys()],
      executionState: 'ACTIONABLE',
      committedChoiceItemIdsByGroup: node.committedChoiceItemIdsByGroup,
      strategyId: strategy.strategyId,
      situationalWindowStates: input.situationalWindowStates ?? [],
    });
    const activeGoals = strategyGoalsEligibleForScoringV1(
      resolveActiveBuildStrategyGoalsV1(strategy, contract),
      semantic,
      input.decision.itemGraph,
    );
    const capacityExitItemIds = new Set(node.decisionState.inventory.heldByItemId.keys());
    const candidates = filterRecommendationCandidatesForActiveGoalsV1(
      generateRecommendationCandidates({
        state: node.decisionState,
        itemGraph: input.decision.itemGraph,
        rules,
      }),
      activeGoals,
      input.decision.itemGraph,
      { capacityExitItemIds, protectedGoals: strategy.goals },
    )
      .filter((candidate) => candidate.feasible)
      .filter((candidate) => candidate.recommendationEligible)
      .filter((candidate) => !candidateTargetAlreadySatisfied(candidate, node, input.decision.itemGraph))
      .filter((candidate) => candidateTouchesSemanticTargets(candidate, semantic, node, skeleton))
      .filter((candidate) => !isProtectedSell(candidate, recentPurchased))
      .filter((candidate) =>
        !sellsSelectedFinal(candidate, semantic.selectedFinalItemIds, input.decision.itemGraph) ||
        startsChoiceReplacement(candidate, semantic.choiceReplacementOptions, node),
      )
      .filter((candidate) =>
        !sellsProtectedChoiceEvidence(candidate, semantic.committedChoiceEvidenceItemIds) ||
        startsChoiceReplacement(candidate, semantic.choiceReplacementOptions, node),
      );

    return candidates
      .map((candidate) => this.scorePlannerCandidate(
        input,
        skeleton,
        semantic,
        node,
        candidate,
        baseScorerContext,
        recentSold,
      ))
      .sort((a, b) => b.score - a.score || b.confidence - a.confidence || a.candidate.actionId.localeCompare(b.candidate.actionId));
  }

  private scorePlannerCandidate(
    input: AdaptiveBuildPlannerInputV1,
    skeleton: ConsensusSkeletonV1,
    semantic: SemanticPlanV1,
    node: AdaptivePlannerNodeV1,
    candidate: RecommendationCandidate,
    baseScorerContext: AdaptiveItemScoreContextV1,
    recentSold: ReadonlySet<number>,
  ): ScoredPlannerCandidateV1 {
    const projected = projectPlannerCandidateV1({
      node,
      candidate,
      graph: input.decision.itemGraph,
      economyRules: input.decision.economyRules,
      skeleton,
    });
    const targetItemId = candidateTargetItemId(candidate);
    const plannedPrefixItemIds = node.actions
      .map(candidateTargetItemId)
      .filter((itemId): itemId is number => itemId !== undefined);
    const ownedItemIds = [...node.decisionState.inventory.heldByItemId.keys()].sort((a, b) => a - b);
    let score = 0;
    let confidence = 0;
    let components: readonly AdaptiveScoreComponentV1[] = [];
    if (targetItemId !== undefined) {
      const targetScore = this.scoreSemanticTarget(
        targetItemId,
        semantic,
        {
          ...baseScorerContext,
          ownedItemIds,
          plannedPrefixItemIds,
          transactionPenalty: transactionPenaltyFor(candidate),
          churnPenalty: recentSold.has(targetItemId) ? 0.75 : 0,
          investmentDelta: projected.investmentDelta,
          slotDelta: projected.slotDelta,
        },
      );
      score = targetScore.score;
      confidence = targetScore.confidence;
      components = targetScore.components;

      if (candidate.action.type === 'WAIT_SAVE') score *= 0.12;
      if (candidate.action.type === 'REPLACE_ITEM') {
        const sold = this.scorer.scoreItem(candidate.action.sellItemId, {
          ...baseScorerContext,
          ownedItemIds,
          plannedPrefixItemIds,
          transactionPenalty: 0,
          churnPenalty: 0,
        });
        score -= Math.max(0, sold.score) * 0.55 + ADAPTIVE_POLICY_V1_CONFIG.coreReplaceMinImprovement;
        confidence = Math.min(confidence, sold.confidence || confidence);
      }
    } else if (candidate.action.type === 'SELL_ITEM') {
      const sold = this.scorer.scoreItem(candidate.action.itemId, {
        ...baseScorerContext,
        ownedItemIds,
        plannedPrefixItemIds,
        transactionPenalty: 0,
        churnPenalty: 0,
      });
      score = -(
        Math.max(0, sold.score) * 0.55 +
        ADAPTIVE_POLICY_V1_CONFIG.sellMinImprovement +
        projected.investmentDelta.achievedBreakpointsLost * ADAPTIVE_POLICY_V1_CONFIG.investment.achievedBreakpointDropPenalty
      );
      confidence = sold.confidence;
    }

    const adaptiveAction = mapCandidateAction(candidate, targetItemId, skeleton);
    return {
      candidate,
      score,
      confidence,
      components,
      projected,
      adaptive: {
        action: adaptiveAction,
        score,
        confidence,
        components,
        reasonCodes: immediateReasonCodes(candidate, components),
      },
    };
  }

  private scoreSemanticTarget(
    targetItemId: number,
    semantic: SemanticPlanV1,
    context: AdaptiveItemScoreContextV1,
  ): AdaptiveItemScoreV1 {
    if (semantic.selectedFinalItemIds.has(targetItemId)) {
      return this.scorer.scoreItem(targetItemId, context);
    }

    const owners = semantic.supportOwnersByItemId.get(targetItemId) ?? [];
    const ownerScores = owners
      .map((itemId) => this.scorer.scoreItem(itemId, context))
      .sort((a, b) => b.score - a.score || b.confidence - a.confidence || a.itemId - b.itemId);
    const best = ownerScores[0];
    if (!best) return this.scorer.scoreItem(targetItemId, context);
    return {
      ...best,
      itemId: targetItemId,
      score: best.score * 0.65 + 0.25,
      confidence: best.confidence,
    };
  }

  private refreshChoiceCommitments(
    node: AdaptivePlannerNodeV1,
    skeleton: ConsensusSkeletonV1,
    input: AdaptiveBuildPlannerInputV1,
  ): AdaptivePlannerNodeV1 {
    return refreshPlannerChoiceStateV1(node, skeleton, input.decision.itemGraph);
  }

  private buildRecommendedBuild(
    input: AdaptiveBuildPlannerInputV1,
    skeleton: ConsensusSkeletonV1,
    semantic: SemanticPlanV1,
    node: AdaptivePlannerNodeV1,
    baseScorerContext: AdaptiveItemScoreContextV1,
    recentSold: ReadonlySet<number>,
    preferredNextTarget: number | undefined,
  ): readonly AdaptivePlannedItemV1[] {
    const ownedItemIds = [...input.decision.state.inventory.heldByItemId.keys()].sort((a, b) =>
      (semantic.orderByItemId.get(a) ?? Number.MAX_SAFE_INTEGER) -
        (semantic.orderByItemId.get(b) ?? Number.MAX_SAFE_INTEGER) ||
      a - b,
    );
    const actionTargets = node.actions
      .map(candidateTargetItemId)
      .filter((itemId): itemId is number => itemId !== undefined);
    const startedReplacements = semantic.choiceReplacementOptions.filter((option) =>
      choiceReplacementStarted(option, node),
    );
    const replacedFinalItemIds = new Set(startedReplacements.map((option) => option.replacedItemId));
    const replacementTargetItemIds = startedReplacements.map((option) => option.targetItemId);
    const futureFinals = uniqueNumbers([
      ...semantic.selectedFinalItemIds,
      ...semantic.futurePlannedFinalItemIds,
      ...replacementTargetItemIds,
    ])
      .filter((itemId) => !input.decision.itemGraph.isTargetSatisfied(itemId, ownedItemIds))
      .filter((itemId) => !replacedFinalItemIds.has(itemId))
      .sort((a, b) =>
        (semantic.orderByItemId.get(a) ?? Number.MAX_SAFE_INTEGER) -
          (semantic.orderByItemId.get(b) ?? Number.MAX_SAFE_INTEGER) ||
        a - b,
      );
    const ordered = uniqueNumbers([...ownedItemIds, ...actionTargets, ...futureFinals])
      .filter((itemId) =>
        ownedItemIds.includes(itemId) ||
        !input.decision.itemGraph.isTargetSatisfied(itemId, ownedItemIds),
      );
    const firstUnowned = ordered.find((itemId) => !ownedItemIds.includes(itemId));
    const nextTarget = preferredNextTarget !== undefined && ordered.includes(preferredNextTarget)
      ? preferredNextTarget
      : firstUnowned;

    return ordered.map((itemId, index) => {
      const score = semantic.selectedFinalItemIds.has(itemId)
        ? this.scorer.scoreItem(itemId, {
            ...baseScorerContext,
            plannedPrefixItemIds: ordered.slice(ownedItemIds.length, index),
            transactionPenalty: 0,
            churnPenalty: recentSold.has(itemId) ? 0.75 : 0,
          })
        : this.scoreSemanticTarget(itemId, semantic, {
            ...baseScorerContext,
            plannedPrefixItemIds: ordered.slice(ownedItemIds.length, index),
            transactionPenalty: 0,
            churnPenalty: recentSold.has(itemId) ? 0.75 : 0,
          });
      const candidate = findConsensusCandidateV1(skeleton, itemId);
      const group = findConsensusGroupByItemV1(skeleton, itemId);
      const skeletonWeighted = score.components.find((component) => component.key === 'skeletonPrior')?.weighted ?? 0;
      const status: AdaptivePlannedItemV1['status'] = ownedItemIds.includes(itemId)
        ? 'OWNED'
        : itemId === nextTarget
          ? 'NEXT'
          : 'PLANNED';
      return {
        itemId,
        position: index + 1,
        status,
        score: score.score,
        confidence: score.confidence,
        skeletonStrength: candidate?.strength ?? 0,
        contextualSupport: score.score - skeletonWeighted,
        reasonCodes: plannedReasonCodes(score, group, candidate === undefined),
      };
    });
  }

  private previousPlanStillValid(
    previousBuild: readonly AdaptivePlannedItemV1[],
    owned: ReadonlySet<number>,
    semantic: SemanticPlanV1,
    immediate: readonly ScoredPlannerCandidateV1[],
  ): boolean {
    if (semantic.externallyDivergedGroupIds.size > 0) return false;
    const replacementAllowed = semantic.choiceReplacementOptions.flatMap((option) => option.supportItemIds);
    const allowed = new Set<number>([
      ...owned,
      ...semantic.selectedFinalItemIds,
      ...semantic.futurePlannedFinalItemIds,
      ...semantic.targetItemIds,
      ...replacementAllowed,
    ]);
    if (!previousBuild.every((item) => allowed.has(item.itemId))) return false;

    const previousNext = [...previousBuild]
      .sort((a, b) => a.position - b.position || a.itemId - b.itemId)
      .find((item) => item.status === 'NEXT' && !owned.has(item.itemId));
    if (!previousNext) return true;

    const hasMissingSupport = [...semantic.supportOwnersByItemId.entries()].some(([componentId, owners]) =>
      !owned.has(componentId) && owners.includes(previousNext.itemId),
    );
    if (hasMissingSupport) return false;

    return immediate.some((entry) => candidateTargetItemId(entry.candidate) === previousNext.itemId);
  }
}

function generatorRulesForNode(node: AdaptivePlannerNodeV1): RecommendationCandidateGeneratorRules {
  return {
    ...DEFAULT_RECOMMENDATION_CANDIDATE_RULES,
    baseSlots: node.slots.baseSlots,
    baseSlotsByType: node.slots.baseSlotsByType,
    maxFlexSlots: node.slots.maxFlexSlots,
    unlockedFlexSlots: node.slots.unlockedFlexSlots,
    flexCapacityEvidence: node.slots.flexEvidence,
    maxActiveItems: node.slots.maxActiveItems,
  };
}

function strategyGoalsEligibleForScoringV1(
  goals: readonly BuildStrategyGoalV1[],
  semantic: SemanticPlanV1,
  graph: RecommendationItemGraph,
): readonly BuildStrategyGoalV1[] {
  return goals.filter((goal) => {
    if (goal.type === 'TERMINAL') return true;
    return goal.targetItemIds.some((targetItemId) =>
      semantic.activeTargetItemIds.has(targetItemId) ||
      graph.getTransitiveComponentIds(targetItemId).some((componentId) => semantic.activeTargetItemIds.has(componentId)),
    );
  });
}

function compilePlannerBuildContractV1(
  input: AdaptiveBuildPlannerInputV1,
  skeleton: ConsensusSkeletonV1,
  strategy: BuildStrategySpecV1,
  semantic: SemanticPlanV1,
  node: AdaptivePlannerNodeV1,
  build: readonly AdaptivePlannedItemV1[],
  action: AdaptiveActionV1,
): BuildContractV1 {
  const actualOwnedItemIds = [...input.decision.state.inventory.heldByItemId.keys()].sort((a, b) => a - b);
  const baseContract = compileBuildContractV1({
    skeleton,
    itemGraph: input.decision.itemGraph,
    ownedItemIds: actualOwnedItemIds,
    executionState: executionStateForAction(action),
    committedChoiceItemIdsByGroup: node.committedChoiceItemIdsByGroup,
    strategyId: strategy.strategyId,
    situationalWindowStates: input.situationalWindowStates ?? [],
  });
  const futureGoalTargetItemIdsByGoal = plannedMandatoryTargetsByGoalV1(
    skeleton,
    semantic,
    build,
    input.decision.itemGraph,
    actualOwnedItemIds,
  );
  const slotReservations = derivePlannerSlotReservationsV1(
    input,
    semantic,
    node,
    baseContract,
    futureGoalTargetItemIdsByGoal,
  );

  return compileBuildContractV1({
    skeleton,
    itemGraph: input.decision.itemGraph,
    ownedItemIds: actualOwnedItemIds,
    executionState: executionStateForAction(action),
    committedChoiceItemIdsByGroup: node.committedChoiceItemIdsByGroup,
    strategyId: strategy.strategyId,
    situationalWindowStates: input.situationalWindowStates ?? [],
    futureGoalTargetItemIdsByGoal,
    slotReservations,
  });
}

function plannedMandatoryTargetsByGoalV1(
  skeleton: ConsensusSkeletonV1,
  semantic: SemanticPlanV1,
  build: readonly AdaptivePlannedItemV1[],
  graph: RecommendationItemGraph,
  ownedItemIds: readonly number[],
): ReadonlyMap<string, readonly number[]> {
  const planned = new Set(build.filter((item) => item.status !== 'OWNED').map((item) => item.itemId));
  const selectedFinals = new Set([...semantic.selectedFinalItemIds, ...semantic.futurePlannedFinalItemIds]);
  const result = new Map<string, readonly number[]>();

  for (const group of skeleton.groups) {
    if (group.type === 'OPTIONAL') continue;
    const selectedChoice = new Set(semantic.selectedChoiceItemIdsByGroup.get(group.groupId) ?? []);
    const targetItemIds = group.candidates
      .map((candidate) => candidate.itemId)
      .filter((itemId) => group.type !== 'CHOICE' || selectedChoice.has(itemId))
      .filter((itemId) => selectedFinals.has(itemId) || planned.has(itemId))
      .filter((itemId) => !graph.isTargetSatisfied(itemId, ownedItemIds));
    if (targetItemIds.length > 0) result.set(group.groupId, uniqueNumbers(targetItemIds).sort((a, b) => a - b));
  }
  return result;
}

function derivePlannerSlotReservationsV1(
  input: AdaptiveBuildPlannerInputV1,
  semantic: SemanticPlanV1,
  node: AdaptivePlannerNodeV1,
  baseContract: BuildContractV1,
  futureTargets: ReadonlyMap<string, readonly number[]>,
): readonly BuildSlotReservationV1[] {
  const graph = input.decision.itemGraph;
  const slots = input.decision.slots;
  const freeBaseByType = { ...slots.freeBaseByType };
  let freeFlex = slots.flexEvidence === 'UNKNOWN' ? undefined : slots.freeFlexSlots;
  let availableActive = slots.mechanicsEvidence === 'UNKNOWN'
    ? undefined
    : Math.max(0, slots.maxActiveItems - slots.usedActiveItems);
  const reservations: BuildSlotReservationV1[] = [];
  const temporarySellable = [...baseContract.temporaryItemIds]
    .filter((itemId) => graph.getItem(itemId)?.sellTransition !== undefined)
    .sort((a, b) => a - b);

  for (const [goalId, targetItemIds] of futureTargets) {
    for (const targetItemId of targetItemIds) {
      const target = graph.getItem(targetItemId);
      if (!target) continue;
      const actionPath = node.actions.find((candidate) => candidateServesFinalTargetV1(candidate, targetItemId, graph));
      if (actionPath?.action.type === 'UPGRADE_ITEM') {
        reservations.push({
          goalId,
          targetItemId,
          state: 'LOCKED_BY_UPGRADE_COMPRESSION',
          reasonCodes: ['UPGRADE_CONSUMES_COMPONENT'],
        });
        continue;
      }
      if (actionPath?.action.type === 'REPLACE_ITEM') {
        reservations.push({
          goalId,
          targetItemId,
          state: 'LOCKED_BY_SELL',
          reasonCodes: ['EXPLICIT_REPLACE_CAPACITY_PATH'],
        });
        continue;
      }
      if (actionPath?.action.type === 'BUY_ITEM') {
        reservations.push({
          goalId,
          targetItemId,
          state: 'READY',
          reasonCodes: ['PLANNER_LEGAL_BUY_CAPACITY_PATH'],
        });
        reserveActiveCapacity(target.active, availableActive, (value) => { availableActive = value; });
        continue;
      }

      const upgradeResolution = resolveUpgradeExecutionPathV1(input.decision.state, targetItemId, graph);
      if (upgradeResolution.kind === 'DIRECT_UPGRADE' || upgradeResolution.kind === 'MULTI_STEP_UPGRADE') {
        reservations.push({
          goalId,
          targetItemId,
          state: 'LOCKED_BY_UPGRADE_COMPRESSION',
          reasonCodes: ['UPGRADE_CONSUMES_COMPONENT'],
        });
        continue;
      }

      const replacementOption = semantic.choiceReplacementOptions.find((option) => option.targetItemId === targetItemId);
      if (replacementOption) {
        reservations.push({
          goalId,
          targetItemId,
          state: 'LOCKED_BY_SELL',
          reasonCodes: ['EXPLICIT_REPLACE_CAPACITY_PATH'],
        });
        continue;
      }

      if (slots.mechanicsEvidence !== 'UNKNOWN' && canReserveActiveCapacity(target.active, availableActive)) {
        if (freeBaseByType[target.slotType] > 0) {
          freeBaseByType[target.slotType] -= 1;
          if (target.active && availableActive !== undefined) availableActive -= 1;
          reservations.push({
            goalId,
            targetItemId,
            state: 'READY',
            reasonCodes: ['BASE_SLOT_CAPACITY_RESERVED'],
          });
          continue;
        }
        if (freeFlex !== undefined && freeFlex > 0) {
          freeFlex -= 1;
          if (target.active && availableActive !== undefined) availableActive -= 1;
          reservations.push({
            goalId,
            targetItemId,
            state: 'READY',
            reasonCodes: ['VERIFIED_FLEX_CAPACITY_RESERVED'],
          });
          continue;
        }
      }

      const plannedSell = node.actions.find((candidate) => candidate.action.type === 'SELL_ITEM');
      if (plannedSell) {
        reservations.push({
          goalId,
          targetItemId,
          state: 'LOCKED_BY_SELL',
          reasonCodes: ['PLANNED_SELL_CAPACITY_PATH'],
        });
        continue;
      }
      if (temporarySellable.length > 0) {
        reservations.push({
          goalId,
          targetItemId,
          state: 'LOCKED_BY_SELL',
          reasonCodes: ['TEMPORARY_ITEM_SELL_CAPACITY_PATH'],
        });
      }
    }
  }
  return reservations;
}

function candidateServesFinalTargetV1(
  candidate: RecommendationCandidate,
  finalTargetItemId: number,
  graph: RecommendationItemGraph,
): boolean {
  const targetItemId = candidateTargetItemId(candidate);
  if (targetItemId === undefined) return false;
  return targetItemId === finalTargetItemId || graph.isComponentAncestor(targetItemId, finalTargetItemId);
}

function canReserveActiveCapacity(active: boolean, availableActive: number | undefined): boolean {
  return !active || (availableActive !== undefined && availableActive > 0);
}

function reserveActiveCapacity(
  active: boolean,
  availableActive: number | undefined,
  set: (value: number | undefined) => void,
): void {
  if (active && availableActive !== undefined) set(Math.max(0, availableActive - 1));
}

function executionStateForAction(action: AdaptiveActionV1): BuildContractExecutionStateV1 {
  if (action.type === 'HOLD') return 'HOLD';
  if (action.type === 'WAIT' || action.type === 'CONTINUE_CORE' || action.type === 'ABSTAIN') return 'WAITING';
  return 'ACTIONABLE';
}

function openSituationalTargetIds(
  windows: readonly BuildSituationalWindowStateV1[],
): ReadonlySet<number> {
  return new Set(
    windows
      .filter((window) => window.state === 'OPEN')
      .flatMap((window) => window.targetItemIds),
  );
}

function isAdaptiveTransactionAction(action: AdaptiveActionV1): boolean {
  return action.type === 'BUY' || action.type === 'UPGRADE' || action.type === 'SELL' || action.type === 'REPLACE';
}

function candidateTargetAlreadySatisfied(
  candidate: RecommendationCandidate,
  node: AdaptivePlannerNodeV1,
  graph: RecommendationItemGraph,
): boolean {
  const targetItemId = candidateTargetItemId(candidate);
  if (targetItemId === undefined) return false;
  return graph.isTargetSatisfied(targetItemId, node.decisionState.inventory.heldByItemId.keys());
}

function candidateTouchesSemanticTargets(
  candidate: RecommendationCandidate,
  semantic: SemanticPlanV1,
  node: AdaptivePlannerNodeV1,
  skeleton: ConsensusSkeletonV1,
): boolean {
  const startedReplacements = semantic.choiceReplacementOptions.filter((option) =>
    choiceReplacementStarted(option, node),
  );
  if (
    (
      candidateTouchesTargets(candidate, semantic.activeTargetItemIds) ||
      candidateTouchesReadyFutureTarget(candidate, semantic, node, skeleton)
    ) &&
    !startedReplacements.some((option) => candidateTouchesReplacedBranch(candidate, option))
  ) {
    return true;
  }

  for (const option of semantic.choiceReplacementOptions) {
    const started = choiceReplacementStarted(option, node);
    if (!started && candidateStartsReplacementOption(candidate, option, node)) return true;
    if (!started) continue;

    if (!choiceReplacementDivested(option, node)) {
      if (candidateContinuesReplacementDivest(candidate, option, node)) return true;
      continue;
    }

    if (candidateTouchesReplacementSupport(candidate, option)) return true;
  }
  return false;
}

function candidateTouchesReadyFutureTarget(
  candidate: RecommendationCandidate,
  semantic: SemanticPlanV1,
  node: AdaptivePlannerNodeV1,
  skeleton: ConsensusSkeletonV1,
): boolean {
  if (candidate.action.type === 'SELL_ITEM') {
    return [...semantic.futurePlannedFinalItemIds].some((itemId) =>
      futureOwnerReadyAtNode(itemId, node, skeleton),
    );
  }
  if (candidate.action.type === 'WAIT_SAVE' && candidate.action.targetItemId === undefined) {
    return semantic.futurePlannedFinalItemIds.size > 0;
  }
  const targetItemId = candidateTargetItemId(candidate);
  if (targetItemId === undefined) return false;
  return (semantic.futureOwnersByTargetItemId.get(targetItemId) ?? []).some((itemId) =>
    futureOwnerReadyAtNode(itemId, node, skeleton),
  );
}

function futureOwnerReadyAtNode(
  futureItemId: number,
  node: AdaptivePlannerNodeV1,
  skeleton: ConsensusSkeletonV1,
): boolean {
  const group = findConsensusGroupByItemV1(skeleton, futureItemId);
  if (!group) return false;
  const targetPhaseOrder = phaseOrderV1(group.phase);
  return skeleton.groups
    .filter((candidate) => candidate.type === 'REQUIRED' && phaseOrderV1(candidate.phase) < targetPhaseOrder)
    .every((candidate) => node.completedGroupIds.has(candidate.groupId));
}

function candidateTouchesTargets(
  candidate: RecommendationCandidate,
  targets: ReadonlySet<number>,
): boolean {
  if (candidate.action.type === 'SELL_ITEM') return targets.size > 0;
  if (candidate.action.type === 'WAIT_SAVE') {
    return candidate.action.targetItemId === undefined || targets.has(candidate.action.targetItemId);
  }
  const target = candidateTargetItemId(candidate);
  return target !== undefined && targets.has(target);
}

function candidateStartsReplacementOption(
  candidate: RecommendationCandidate,
  option: AdaptiveChoiceReplacementOptionV1,
  node: AdaptivePlannerNodeV1,
): boolean {
  const heldEvidence = heldReplacementEvidence(option, node);
  if (heldEvidence.length === 0) return false;
  if (candidate.action.type === 'SELL_ITEM') return heldEvidence.includes(candidate.action.itemId);
  if (candidate.action.type !== 'REPLACE_ITEM') return false;
  return heldEvidence.length === 1 &&
    candidate.action.sellItemId === heldEvidence[0] &&
    option.supportItemIds.includes(candidate.action.buyItemId);
}

function candidateContinuesReplacementDivest(
  candidate: RecommendationCandidate,
  option: AdaptiveChoiceReplacementOptionV1,
  node: AdaptivePlannerNodeV1,
): boolean {
  const heldEvidence = heldReplacementEvidence(option, node);
  if (heldEvidence.length === 0) return false;
  if (candidate.action.type === 'SELL_ITEM') return heldEvidence.includes(candidate.action.itemId);
  if (candidate.action.type !== 'REPLACE_ITEM') return false;
  return heldEvidence.length === 1 &&
    candidate.action.sellItemId === heldEvidence[0] &&
    option.supportItemIds.includes(candidate.action.buyItemId);
}

function candidateTouchesReplacementSupport(
  candidate: RecommendationCandidate,
  option: AdaptiveChoiceReplacementOptionV1,
): boolean {
  if (candidate.action.type === 'WAIT_SAVE') {
    return candidate.action.targetItemId === undefined ||
      (candidate.action.targetItemId !== undefined && option.supportItemIds.includes(candidate.action.targetItemId));
  }
  const targetItemId = candidateTargetItemId(candidate);
  if (targetItemId === undefined) return false;
  return option.supportItemIds.includes(targetItemId);
}

function candidateTouchesReplacedBranch(
  candidate: RecommendationCandidate,
  option: AdaptiveChoiceReplacementOptionV1,
): boolean {
  const targetItemId = candidateTargetItemId(candidate);
  return targetItemId !== undefined && option.replacedSupportItemIds.includes(targetItemId);
}

function startsChoiceReplacement(
  candidate: RecommendationCandidate,
  options: readonly AdaptiveChoiceReplacementOptionV1[],
  node: AdaptivePlannerNodeV1,
): boolean {
  return options.some((option) =>
    candidateStartsReplacementOption(candidate, option, node) ||
    (choiceReplacementStarted(option, node) && candidateContinuesReplacementDivest(candidate, option, node)),
  );
}

function choiceReplacementStarted(
  option: AdaptiveChoiceReplacementOptionV1,
  node: AdaptivePlannerNodeV1,
): boolean {
  return node.actions.some((candidate) => {
    if (candidate.action.type === 'SELL_ITEM') return option.sellEvidenceItemIds.includes(candidate.action.itemId);
    if (candidate.action.type === 'REPLACE_ITEM') return option.sellEvidenceItemIds.includes(candidate.action.sellItemId);
    return false;
  });
}

function choiceReplacementDivested(
  option: AdaptiveChoiceReplacementOptionV1,
  node: AdaptivePlannerNodeV1,
): boolean {
  return heldReplacementEvidence(option, node).length === 0;
}

function heldReplacementEvidence(
  option: AdaptiveChoiceReplacementOptionV1,
  node: AdaptivePlannerNodeV1,
): number[] {
  return option.sellEvidenceItemIds.filter((itemId) => node.decisionState.inventory.heldByItemId.has(itemId));
}

function compareReplacementOptions(
  a: AdaptiveChoiceReplacementOptionV1,
  b: AdaptiveChoiceReplacementOptionV1,
): number {
  return b.contextualImprovement - a.contextualImprovement ||
    a.groupId.localeCompare(b.groupId) ||
    a.targetItemId - b.targetItemId ||
    a.replacedItemId - b.replacedItemId;
}

function candidateTargetItemId(candidate: RecommendationCandidate): number | undefined {
  const action = candidate.action;
  if (action.type === 'BUY_ITEM' || action.type === 'UPGRADE_ITEM') return action.itemId;
  if (action.type === 'REPLACE_ITEM') return action.buyItemId;
  if (action.type === 'WAIT_SAVE') return action.targetItemId;
  return undefined;
}

function transactionPenaltyFor(candidate: RecommendationCandidate): number {
  if (candidate.action.type === 'UPGRADE_ITEM') return 0.04;
  if (candidate.action.type === 'BUY_ITEM') return 0.08;
  if (candidate.action.type === 'REPLACE_ITEM') return 0.18;
  return 0;
}

function isProtectedSell(candidate: RecommendationCandidate, recentPurchased: ReadonlySet<number>): boolean {
  if (candidate.action.type === 'SELL_ITEM') return recentPurchased.has(candidate.action.itemId);
  if (candidate.action.type === 'REPLACE_ITEM') return recentPurchased.has(candidate.action.sellItemId);
  return false;
}

function sellsSelectedFinal(
  candidate: RecommendationCandidate,
  selectedFinals: ReadonlySet<number>,
  itemGraph: RecommendationItemGraph,
): boolean {
  const soldItemId = candidate.action.type === 'SELL_ITEM' ? candidate.action.itemId
    : candidate.action.type === 'REPLACE_ITEM' ? candidate.action.sellItemId : undefined;
  if (soldItemId === undefined) return false;
  return [...selectedFinals].some((itemId) => itemGraph.isTargetSatisfied(itemId, [soldItemId]));
}

function sellsProtectedChoiceEvidence(
  candidate: RecommendationCandidate,
  protectedItemIds: ReadonlySet<number>,
): boolean {
  if (candidate.action.type === 'SELL_ITEM') return protectedItemIds.has(candidate.action.itemId);
  if (candidate.action.type === 'REPLACE_ITEM') return protectedItemIds.has(candidate.action.sellItemId);
  return false;
}

function previousSelectedChoiceItems(
  previousBuild: readonly AdaptivePlannedItemV1[] | undefined,
  group: ConsensusBuildGroupV1,
): number[] {
  if (!previousBuild) return [];
  const candidates = new Set(group.candidates.map((candidate) => candidate.itemId));
  return uniqueNumbers(
    [...previousBuild]
      .sort((a, b) => a.position - b.position || a.itemId - b.itemId)
      .filter((item) => candidates.has(item.itemId))
      .map((item) => item.itemId),
  ).slice(0, Math.max(1, group.maxSelect));
}

function dedupePlannerNodes(nodes: readonly AdaptivePlannerNodeV1[]): AdaptivePlannerNodeV1[] {
  const byKey = new Map<string, AdaptivePlannerNodeV1>();
  for (const node of nodes) {
    const key = plannerNodeKey(node);
    const existing = byKey.get(key);
    if (!existing || comparePlannerNodes(node, existing) < 0) byKey.set(key, node);
  }
  return [...byKey.values()];
}

export function plannerNodeKey(node: AdaptivePlannerNodeV1): string {
  const inventory = [...node.decisionState.inventory.heldByItemId.keys()].sort((a, b) => a - b);
  const wallet = node.decisionState.economy.spendableSouls.value ?? 'UNKNOWN';
  const selected = serializeChoiceItemIdsByGroup(node.selectedChoiceItemIdsByGroup);
  const committed = serializeChoiceItemIdsByGroup(node.committedChoiceItemIdsByGroup);
  const completed = [...node.completedGroupIds].sort();
  return JSON.stringify([inventory, wallet, selected, committed, completed]);
}

function serializeChoiceItemIdsByGroup(values: ReadonlyMap<string, readonly number[]>): readonly (readonly [string, readonly number[]])[] {
  return [...values.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([groupId, itemIds]) => [groupId, [...new Set(itemIds)].sort((a, b) => a - b)] as const);
}

function comparePlannerNodes(a: AdaptivePlannerNodeV1, b: AdaptivePlannerNodeV1): number {
  if (a.utility !== b.utility) return b.utility - a.utility;
  if (a.confidenceSum !== b.confidenceSum) return b.confidenceSum - a.confidenceSum;
  return compareStringSequences(
    a.actions.map((candidate) => candidate.actionId),
    b.actions.map((candidate) => candidate.actionId),
  );
}

function compareStringSequences(a: readonly string[], b: readonly string[]): number {
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const compare = a[index].localeCompare(b[index]);
    if (compare !== 0) return compare;
  }
  return a.length - b.length;
}

function mapCandidateAction(
  candidate: RecommendationCandidate,
  targetOverride: number | undefined,
  skeleton: ConsensusSkeletonV1,
): AdaptiveActionV1 {
  const action = candidate.action;
  if (action.type === 'BUY_ITEM') {
    return {
      actionKey: candidate.actionId,
      type: 'BUY',
      itemId: action.itemId,
      targetItemId: action.itemId,
      reasonCodes: [...candidate.reasons],
    };
  }
  if (action.type === 'UPGRADE_ITEM') {
    return {
      actionKey: candidate.actionId,
      type: 'UPGRADE',
      itemId: action.itemId,
      targetItemId: action.itemId,
      reasonCodes: [...candidate.reasons],
    };
  }
  if (action.type === 'REPLACE_ITEM') {
    return {
      actionKey: candidate.actionId,
      type: 'REPLACE',
      sellItemId: action.sellItemId,
      buyItemId: action.buyItemId,
      targetItemId: action.buyItemId,
      reasonCodes: [...candidate.reasons],
    };
  }
  if (action.type === 'SELL_ITEM') {
    return {
      actionKey: candidate.actionId,
      type: 'SELL',
      itemId: action.itemId,
      sellItemId: action.itemId,
      targetItemId: targetOverride,
      reasonCodes: [...candidate.reasons],
    };
  }
  return semanticNoTransactionAction(
    isRequiredTarget(targetOverride, skeleton) ? 'CONTINUE_CORE' : 'WAIT',
    candidate,
    targetOverride ?? action.targetItemId,
    skeleton,
  );
}

function semanticNoTransactionAction(
  type: 'WAIT' | 'HOLD' | 'CONTINUE_CORE',
  candidate: RecommendationCandidate | undefined,
  targetItemId: number | undefined,
  _skeleton: ConsensusSkeletonV1,
): AdaptiveActionV1 {
  return {
    actionKey: candidate?.actionId ?? type,
    type,
    targetItemId,
    reasonCodes: type === 'HOLD'
      ? ['PLAN_HYSTERESIS']
      : type === 'CONTINUE_CORE'
        ? ['STRUCTURED_REQUIRED_TARGET_PENDING']
        : ['NO_LEGAL_TRANSACTION_SELECTED'],
  };
}

function isRequiredTarget(itemId: number | undefined, skeleton: ConsensusSkeletonV1): boolean {
  if (itemId === undefined) return false;
  return findConsensusGroupByItemV1(skeleton, itemId)?.type === 'REQUIRED';
}

function immediateReasonCodes(
  candidate: RecommendationCandidate,
  components: readonly AdaptiveScoreComponentV1[],
): readonly string[] {
  const positive = components
    .filter((component) => component.weighted > 0.05)
    .sort((a, b) => b.weighted - a.weighted || a.key.localeCompare(b.key))
    .slice(0, 3)
    .map((component) => component.key);
  return [...new Set([...candidate.reasons, ...positive])];
}

function plannedReasonCodes(
  score: AdaptiveItemScoreV1,
  group: ConsensusBuildGroupV1 | undefined,
  supportOnly: boolean,
): readonly string[] {
  const reasons: string[] = [];
  if (supportOnly) reasons.push('UPGRADE_COMPONENT');
  if (group) {
    reasons.push(`BUILD_${group.type}`);
    reasons.push(`PHASE_${group.phase}`);
  }
  const positive = score.components
    .filter((component) => component.weighted > 0.05)
    .sort((a, b) => b.weighted - a.weighted || a.key.localeCompare(b.key))
    .slice(0, 3)
    .map((component) => component.key);
  return [...new Set([...reasons, ...positive])];
}

function firstPlannedItem(build: readonly AdaptivePlannedItemV1[]): number | undefined {
  return build.find((item) => item.status === 'NEXT')?.itemId;
}

function rebasePlanAgainstOwnedInventory(
  build: readonly AdaptivePlannedItemV1[],
  ownedItemIds: readonly number[],
): readonly AdaptivePlannedItemV1[] {
  const owned = new Set(ownedItemIds);
  let nextAssigned = false;
  return build.map((item, index) => {
    let status: AdaptivePlannedItemV1['status'];
    if (owned.has(item.itemId)) {
      status = 'OWNED';
    } else if (!nextAssigned) {
      status = 'NEXT';
      nextAssigned = true;
    } else {
      status = 'PLANNED';
    }
    return { ...item, position: index + 1, status };
  });
}

function buildPlanChanges(
  previous: readonly AdaptivePlannedItemV1[],
  next: readonly AdaptivePlannedItemV1[],
): readonly AdaptiveBuildPlanChangeV1[] {
  const previousPosition = new Map(previous.map((item) => [item.itemId, item.position]));
  const nextIds = new Set(next.map((item) => item.itemId));
  const changes: AdaptiveBuildPlanChangeV1[] = [];
  for (const item of next) {
    const oldPosition = previousPosition.get(item.itemId);
    if (oldPosition === undefined) {
      changes.push({ type: 'INSERT', itemId: item.itemId, toPosition: item.position, reasonCodes: ['PLAN_TARGET_ADDED'] });
    } else if (oldPosition === item.position) {
      changes.push({ type: 'KEEP', itemId: item.itemId, fromPosition: oldPosition, toPosition: item.position, reasonCodes: ['PLAN_TARGET_STABLE'] });
    } else {
      changes.push({ type: 'MOVE', itemId: item.itemId, fromPosition: oldPosition, toPosition: item.position, reasonCodes: ['PLAN_TARGET_REORDERED'] });
    }
  }
  for (const item of previous) {
    if (!nextIds.has(item.itemId)) {
      changes.push({ type: 'SKIP', itemId: item.itemId, fromPosition: item.position, reasonCodes: ['PLAN_TARGET_REMOVED'] });
    }
  }
  return changes.sort((a, b) =>
    (a.toPosition ?? Number.MAX_SAFE_INTEGER) - (b.toPosition ?? Number.MAX_SAFE_INTEGER) ||
    (a.fromPosition ?? Number.MAX_SAFE_INTEGER) - (b.fromPosition ?? Number.MAX_SAFE_INTEGER) ||
    (a.itemId ?? 0) - (b.itemId ?? 0),
  );
}

function aggregateImmediateConfidence(scored: readonly ScoredPlannerCandidateV1[]): number {
  if (scored.length === 0) return 0;
  return scored.slice(0, 3).reduce((sum, entry) => sum + entry.confidence, 0) / Math.min(3, scored.length);
}

function evidenceConfidenceFactor(evidence: StatlockerEvidenceBundleV1): number {
  const usable = evidence.families.filter((family) => family.payload !== undefined);
  if (usable.length === 0) return 0.25;
  return clamp01(usable.reduce((sum, family) => sum + family.confidence, 0) / usable.length);
}

function uniqueNumbers(values: readonly number[]): number[] {
  const seen = new Set<number>();
  const result: number[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function asStructuredSkeleton(value: unknown, heroId: number): ConsensusSkeletonV1 | undefined {
  if (!isRecord(value) || value.heroId !== heroId || !Array.isArray(value.groups)) return undefined;
  return value as unknown as ConsensusSkeletonV1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}
