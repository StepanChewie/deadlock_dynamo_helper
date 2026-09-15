import { Injectable } from '@nestjs/common';
import {
  RecommendationCandidate,
  RecommendationItemGraph,
} from '@dynamo-lab/build-domain';
import {
  BuildArchetypeRoleV2,
  BuildArchetypeV2,
} from './build-archetype-v2';
import type { BuildDecisionTraceSinkV2 } from './build-decision-trace-v2';
import {
  BuildItemUtilityV2Service,
  BuildTransitionCostV2,
} from './build-item-utility-v2.service';
import { EnemyThreatScoreV1 } from './enemy-threat-v1.service';
import type { ResolvedFullBuildPlanV2 } from './full-build-plan-v2';
import {
  FullBuildInventoryUtilityV2,
  FullBuildTransitionValueV2Service,
  replacementImprovementThreshold,
} from './full-build-transition-value-v2.service';
import type { MatchupCandidateV2 } from './matchup-candidate-discovery-v2.service';
import {
  StatlockerT4ChainsV1,
  StatlockerWpaPatchDataV1,
} from './statlocker-adaptive.types';
import { STATLOCKER_BUILD_V2_CONFIG } from './statlocker-build-v2.config';
import { StatlockerVsHeroWpaAggregateSourceV1 } from './statlocker-vs-hero-wpa-repository-v1.service';

export type { FullBuildInventoryUtilityV2 } from './full-build-transition-value-v2.service';

export interface FullBuildRecentPurchaseV2 {
  itemId: number;
  ageSec: number;
}

export interface FullBuildResolverV2Input {
  heroId: number;
  archetype: BuildArchetypeV2;
  itemGraph: RecommendationItemGraph;
  gameTimeSec: number;
  currentInventoryItemIds: readonly number[];
  candidates: readonly RecommendationCandidate[];
  enemyHeroIds: readonly number[];
  enemyThreats: readonly EnemyThreatScoreV1[];
  vsHeroRows: readonly StatlockerVsHeroWpaAggregateSourceV1[];
  wpaPatchData?: StatlockerWpaPatchDataV1;
  t4Chains?: StatlockerT4ChainsV1;
  recentPurchases?: readonly FullBuildRecentPurchaseV2[];
  previousActionId?: string;
  transitionCostsByActionId?: ReadonlyMap<string, Partial<BuildTransitionCostV2>>;
}

export interface FullBuildLifetimeResolverV2Input {
  matchId: string;
  stateRevision: string;
  heroId: number;
  rulesetId: string;
  archetype: BuildArchetypeV2;
  itemGraph: RecommendationItemGraph;
  capacity: number;
  gameTimeSec: number;
  currentInventoryItemIds: readonly number[];
  enemyHeroIds: readonly number[];
  enemyThreats: readonly EnemyThreatScoreV1[];
  vsHeroRows: readonly StatlockerVsHeroWpaAggregateSourceV1[];
  wpaPatchData?: StatlockerWpaPatchDataV1;
  t4Chains?: StatlockerT4ChainsV1;
  recentPurchases?: readonly FullBuildRecentPurchaseV2[];
  outsideCandidates?: readonly MatchupCandidateV2[];
  maxSteps?: number;
  trace?: BuildDecisionTraceSinkV2;
}

export interface FullBuildTransitionEvaluationV2 {
  actionId: string;
  candidate: RecommendationCandidate;
  currentWholeUtility: number;
  resultingWholeUtility: number;
  marginalGain: number;
  confidence: number;
  requiredImprovement: number;
  accepted: boolean;
  reasonCodes: readonly string[];
  currentState: FullBuildInventoryUtilityV2;
  resultingState: FullBuildInventoryUtilityV2;
}

export interface FullBuildResolutionV2 {
  selected?: FullBuildTransitionEvaluationV2;
  evaluations: readonly FullBuildTransitionEvaluationV2[];
  selectionReasonCodes: readonly string[];
}

@Injectable()
export class FullBuildResolverV2Service {
  constructor(
    itemUtility: BuildItemUtilityV2Service,
    private readonly transitionValue: FullBuildTransitionValueV2Service = new FullBuildTransitionValueV2Service(itemUtility),
  ) {}

  resolve(input: FullBuildLifetimeResolverV2Input): ResolvedFullBuildPlanV2;
  resolve(input: FullBuildResolverV2Input): FullBuildResolutionV2;
  resolve(
    input: FullBuildLifetimeResolverV2Input | FullBuildResolverV2Input,
  ): ResolvedFullBuildPlanV2 | FullBuildResolutionV2 {
    if (isLifetimeInput(input)) {
      throw new Error('Full build resolver v2 lifetime planning requires family-first resolver');
    }
    return this.evaluateTransitions(input);
  }

  evaluateTransitions(input: FullBuildResolverV2Input): FullBuildResolutionV2 {
    validateTransitionInput(input);
    const currentState = this.transitionValue.scoreCurrentInventory({
      heroId: input.heroId,
      archetype: input.archetype,
      itemGraph: input.itemGraph,
      gameTimeSec: input.gameTimeSec,
      currentInventoryItemIds: input.currentInventoryItemIds,
      enemyHeroIds: input.enemyHeroIds,
      enemyThreats: input.enemyThreats,
      vsHeroRows: input.vsHeroRows,
      wpaPatchData: input.wpaPatchData,
      t4Chains: input.t4Chains,
    });
    const evaluations = dedupeCandidates(input.candidates)
      .map((candidate) => this.evaluateCandidate(candidate, currentState, input))
      .sort(compareEvaluations);
    const accepted = evaluations.filter((evaluation) => evaluation.accepted);
    if (accepted.length === 0) {
      return {
        evaluations,
        selectionReasonCodes: ['NO_ACCEPTED_TRANSITION'],
      };
    }

    const best = accepted[0];
    const previous = input.previousActionId
      ? accepted.find((evaluation) => evaluation.actionId === input.previousActionId)
      : undefined;
    if (!previous || previous.actionId === best.actionId) {
      return {
        selected: best,
        evaluations,
        selectionReasonCodes: ['BEST_MARGINAL_WHOLE_INVENTORY_UTILITY'],
      };
    }

    const improvement = roundUtility(best.marginalGain - previous.marginalGain);
    if (improvement < STATLOCKER_BUILD_V2_CONFIG.fullBuildResolver.minPlanSwitchImprovement) {
      return {
        selected: previous,
        evaluations,
        selectionReasonCodes: ['PLAN_HYSTERESIS_HELD'],
      };
    }

    return {
      selected: best,
      evaluations,
      selectionReasonCodes: ['PLAN_HYSTERESIS_SWITCHED'],
    };
  }

  private evaluateCandidate(
    candidate: RecommendationCandidate,
    currentState: FullBuildInventoryUtilityV2,
    input: FullBuildResolverV2Input,
  ): FullBuildTransitionEvaluationV2 {
    const reasonCodes: string[] = ['WHOLE_INVENTORY_UTILITY_EVALUATED'];
    const action = candidate.action;
    const strategic = action.type === 'BUY_ITEM' ||
      action.type === 'UPGRADE_ITEM' ||
      action.type === 'REPLACE_ITEM';
    const legalStrategic = candidate.feasible && candidate.recommendationEligible && strategic;
    if (!legalStrategic) reasonCodes.push('CANDIDATE_NOT_LEGAL_STRATEGIC_TRANSITION');

    const targetItemId = strategicTargetItemId(candidate);
    const transition = input.transitionCostsByActionId?.get(candidate.actionId);
    const resultingState = targetItemId === undefined
      ? currentState
      : this.transitionValue.scoreResultingInventory({
          heroId: input.heroId,
          archetype: input.archetype,
          itemGraph: input.itemGraph,
          gameTimeSec: input.gameTimeSec,
          currentInventoryItemIds: input.currentInventoryItemIds,
          resultingInventoryItemIds: candidate.resultingItemIds,
          targetItemId,
          enemyHeroIds: input.enemyHeroIds,
          enemyThreats: input.enemyThreats,
          vsHeroRows: input.vsHeroRows,
          wpaPatchData: input.wpaPatchData,
          t4Chains: input.t4Chains,
          transition,
        });
    const marginalGain = roundUtility(resultingState.total - currentState.total);
    const soldRole = action.type === 'REPLACE_ITEM'
      ? archetypeRoleForItem(action.sellItemId, input.archetype, input.itemGraph)
      : undefined;
    const requiredImprovement = requiredImprovementFor(candidate, soldRole);
    const recentPurchaseProtected = action.type === 'REPLACE_ITEM' &&
      isRecentPurchaseProtected(action.sellItemId, input.recentPurchases ?? []);
    const gainBelowThreshold = marginalGain < requiredImprovement;

    if (recentPurchaseProtected) reasonCodes.push('RECENT_PURCHASE_PROTECTED');
    if (soldRole === 'CORE') reasonCodes.push('CORE_REPLACEMENT_HIGHER_THRESHOLD');
    if (gainBelowThreshold) reasonCodes.push('MARGINAL_GAIN_BELOW_THRESHOLD');

    const accepted = legalStrategic && !recentPurchaseProtected && !gainBelowThreshold;
    if (accepted) reasonCodes.push('MARGINAL_GAIN_ACCEPTED');
    return {
      actionId: candidate.actionId,
      candidate,
      currentWholeUtility: currentState.total,
      resultingWholeUtility: resultingState.total,
      marginalGain,
      confidence: resultingState.confidence,
      requiredImprovement,
      accepted,
      reasonCodes,
      currentState,
      resultingState,
    };
  }
}

function isLifetimeInput(
  input: FullBuildLifetimeResolverV2Input | FullBuildResolverV2Input,
): input is FullBuildLifetimeResolverV2Input {
  return 'matchId' in input;
}

function strategicTargetItemId(candidate: RecommendationCandidate): number | undefined {
  const action = candidate.action;
  if (action.type === 'BUY_ITEM' || action.type === 'UPGRADE_ITEM') return action.itemId;
  if (action.type === 'REPLACE_ITEM') return action.buyItemId;
  return undefined;
}

function requiredImprovementFor(
  candidate: RecommendationCandidate,
  soldRole: BuildArchetypeRoleV2 | undefined,
): number {
  const config = STATLOCKER_BUILD_V2_CONFIG.fullBuildResolver;
  if (candidate.action.type !== 'REPLACE_ITEM') return config.buyMinImprovement;
  return replacementImprovementThreshold(soldRole);
}

export function archetypeRoleForFullBuildItemV2(
  itemId: number,
  archetype: BuildArchetypeV2,
  itemGraph: RecommendationItemGraph,
): BuildArchetypeRoleV2 | undefined {
  return archetypeRoleForItem(itemId, archetype, itemGraph);
}

function archetypeRoleForItem(
  itemId: number,
  archetype: BuildArchetypeV2,
  itemGraph: RecommendationItemGraph,
): BuildArchetypeRoleV2 | undefined {
  const roles: BuildArchetypeRoleV2[] = [];
  for (const item of archetype.items) {
    if (
      item.itemId === itemId ||
      itemGraph.getTransitiveComponentIds(item.itemId).includes(itemId) ||
      itemGraph.getTransitiveUpgradeIds(item.itemId).includes(itemId)
    ) roles.push(item.role);
  }
  return roles.sort((left, right) => roleRank(right) - roleRank(left))[0];
}

function roleRank(role: BuildArchetypeRoleV2): number {
  if (role === 'CORE') return 4;
  if (role === 'FREQUENT') return 3;
  if (role === 'SITUATIONAL') return 2;
  return 1;
}

function isRecentPurchaseProtected(
  itemId: number,
  recentPurchases: readonly FullBuildRecentPurchaseV2[],
): boolean {
  const protectionS = STATLOCKER_BUILD_V2_CONFIG.fullBuildResolver.recentPurchaseProtectionS;
  return recentPurchases.some((purchase) =>
    purchase.itemId === itemId &&
    Number.isFinite(purchase.ageSec) &&
    purchase.ageSec >= 0 &&
    purchase.ageSec < protectionS,
  );
}

function dedupeCandidates(
  candidates: readonly RecommendationCandidate[],
): RecommendationCandidate[] {
  const byActionId = new Map<string, RecommendationCandidate>();
  for (const candidate of candidates) {
    if (!byActionId.has(candidate.actionId)) byActionId.set(candidate.actionId, candidate);
  }
  return [...byActionId.values()].sort((left, right) => left.actionId.localeCompare(right.actionId));
}

function compareEvaluations(
  left: FullBuildTransitionEvaluationV2,
  right: FullBuildTransitionEvaluationV2,
): number {
  if (left.accepted !== right.accepted) return left.accepted ? -1 : 1;
  return right.marginalGain - left.marginalGain ||
    right.resultingWholeUtility - left.resultingWholeUtility ||
    right.confidence - left.confidence ||
    left.actionId.localeCompare(right.actionId);
}

function validateTransitionInput(input: FullBuildResolverV2Input): void {
  if (!Number.isInteger(input.heroId) || input.heroId <= 0) {
    throw new Error('Full build resolver v2: heroId must be a positive integer');
  }
  if (input.archetype.heroId !== input.heroId) {
    throw new Error('Full build resolver v2: archetype hero identity mismatch');
  }
  if (!Number.isFinite(input.gameTimeSec) || input.gameTimeSec < 0) {
    throw new Error('Full build resolver v2: gameTimeSec must be non-negative');
  }
  for (const itemId of input.currentInventoryItemIds) {
    if (!input.itemGraph.getItem(itemId)) {
      throw new Error(`Full build resolver v2: current inventory item ${itemId} is not in the catalog`);
    }
  }
}

function roundUtility(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 1_000_000) / 1_000_000;
}
