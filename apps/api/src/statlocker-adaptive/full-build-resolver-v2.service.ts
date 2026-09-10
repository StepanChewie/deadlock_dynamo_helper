import { createHash } from 'crypto';
import { Injectable } from '@nestjs/common';
import {
  RecommendationCandidate,
  RecommendationItemGraph,
} from '@deadlock-live-probe/build-domain';
import {
  BuildArchetypeGroupV2,
  BuildArchetypeRoleV2,
  BuildArchetypeV2,
} from './build-archetype-v2';
import {
  BuildDecisionTraceSinkV2,
  BuildReplacementSearchTracePayloadV2,
} from './build-decision-trace-v2';
import {
  BuildItemUtilityV2,
  BuildItemUtilityV2Service,
  BuildTransitionCostV2,
} from './build-item-utility-v2.service';
import { EnemyThreatScoreV1 } from './enemy-threat-v1.service';
import {
  FullBuildTransitionIntentV2,
  ResolvedFullBuildPlanV2,
} from './full-build-plan-v2';
import { simulateFullBuildInventoryV2 } from './full-build-inventory-simulator-v2';
import type { MatchupCandidateV2 } from './matchup-candidate-discovery-v2.service';
import {
  StatlockerT4ChainsV1,
  StatlockerWpaPatchDataV1,
} from './statlocker-adaptive.types';
import { STATLOCKER_BUILD_V2_CONFIG } from './statlocker-build-v2.config';
import { StatlockerVsHeroWpaAggregateSourceV1 } from './statlocker-vs-hero-wpa-repository-v1.service';

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

export interface FullBuildInventoryUtilityV2 {
  total: number;
  confidence: number;
  itemUtilities: readonly BuildItemUtilityV2[];
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

interface LifetimeSemanticOptionV2 {
  targetItemId: number;
  group?: BuildArchetypeGroupV2;
  utility: BuildItemUtilityV2;
  outsideReasonCodes?: readonly string[];
}

interface LifetimePlanningStateV2 {
  inventoryItemIds: number[];
  completedSemanticItemIds: Set<number>;
  groupSelections: Map<string, Set<number>>;
  actions: FullBuildTransitionIntentV2[];
}

interface LifetimeReplacementOptionV2 {
  sellItemId: number;
  action: FullBuildTransitionIntentV2;
  resultingState: FullBuildInventoryUtilityV2;
  marginalGain: number;
  requiredImprovement: number;
  soldRole?: BuildArchetypeRoleV2;
}

@Injectable()
export class FullBuildResolverV2Service {
  constructor(private readonly itemUtility: BuildItemUtilityV2Service) {}

  resolve(input: FullBuildLifetimeResolverV2Input): ResolvedFullBuildPlanV2;
  resolve(input: FullBuildResolverV2Input): FullBuildResolutionV2;
  resolve(
    input: FullBuildLifetimeResolverV2Input | FullBuildResolverV2Input,
  ): ResolvedFullBuildPlanV2 | FullBuildResolutionV2 {
    if (isLifetimeInput(input)) return this.resolveLifetime(input);
    return this.evaluateTransitions(input);
  }

  evaluateTransitions(input: FullBuildResolverV2Input): FullBuildResolutionV2 {
    validateTransitionInput(input);
    const currentState = this.scoreInventory(input.currentInventoryItemIds, input);
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

  private resolveLifetime(input: FullBuildLifetimeResolverV2Input): ResolvedFullBuildPlanV2 {
    validateLifetimeInput(input);
    const outsideCandidates = dedupeOutsideCandidates(input.outsideCandidates ?? []);
    const state = initializeLifetimeState(input);
    const semanticTargetCount = input.archetype.items.length + outsideCandidates.length;
    const maxSteps = input.maxSteps ?? Math.max(32, semanticTargetCount * 4);
    const degradedReasons = new Set<string>();
    if (input.vsHeroRows.length === 0) degradedReasons.add('MATCHUP_WPA_UNAVAILABLE');
    if (!input.t4Chains) degradedReasons.add('T4_CHAINS_UNAVAILABLE');

    input.trace?.record({
      stage: 'LIVE_CONTEXT',
      reasonCodes: [],
      payload: {
        gameTimeSec: input.gameTimeSec,
        inventoryItemIds: [...input.currentInventoryItemIds],
        capacity: input.capacity,
        enemyThreats: input.enemyThreats.map((enemy) => ({
          heroId: enemy.heroId,
          threatMultiplier: enemy.threatMultiplier,
          completeness: enemy.completeness,
          reasonCodes: [...enemy.reasonCodes],
        })),
      },
    });

    if (outsideCandidates.length > 0) {
      input.trace?.record({
        stage: 'CANDIDATE_DISCOVERY',
        reasonCodes: [],
        payload: {
          candidates: outsideCandidates.map((candidate) => ({
            candidateId: `outside:${candidate.targetItemId}`,
            itemId: candidate.targetItemId,
            score: candidate.utility.total,
            confidence: candidate.matchup.confidence,
            coverage: candidate.matchup.coverage,
            disposition: 'INFO',
            reasonCodes: [...candidate.reasonCodes],
            insideLockedArchetype: false,
          })),
        },
      });
    }

    for (let iteration = 0; iteration < maxSteps; iteration += 1) {
      const options = this.readySemanticOptions(input, state, outsideCandidates);
      if (options.length === 0) break;
      const rankedOptions = [...options].sort(compareLifetimeOptions);
      const selected = rankedOptions[0];
      const action = this.transitionForSemanticTarget(input, state, selected);

      if (selected.group) {
        const groupOptions = rankedOptions.filter((option) => option.group?.groupId === selected.group?.groupId);
        input.trace?.record({
          stage: 'CHOICE_RESOLUTION',
          reasonCodes: [],
          payload: {
            groups: [{
              groupId: selected.group.groupId,
              minSelect: selected.group.minSelect,
              maxSelect: selected.group.maxSelect,
              candidates: groupOptions.map((option) => ({
                candidateId: `item:${option.targetItemId}`,
                itemId: option.targetItemId,
                score: option.utility.total,
                confidence: option.utility.confidence,
                disposition: option.targetItemId === selected.targetItemId ? 'SELECTED' : 'REJECTED',
                reasonCodes: optionReasonCodes(option),
              })),
              selectedItemIds: [selected.targetItemId],
            }],
          },
        });
      }

      input.trace?.record({
        stage: 'PLAN_SEARCH',
        reasonCodes: action ? [] : ['LIFETIME_PROGRESS_BLOCKED'],
        payload: {
          branches: rankedOptions.map((option) => ({
            sequence: iteration + 1,
            targetItemId: option.targetItemId,
            ...(option.targetItemId === selected.targetItemId && action ? { action: action.action } : {}),
            score: option.utility.total,
            disposition: option.targetItemId === selected.targetItemId
              ? action ? 'SELECTED' : 'REJECTED'
              : 'REJECTED',
            reasonCodes: option.targetItemId === selected.targetItemId
              ? [...optionReasonCodes(option), ...(action?.reasonCodes ?? [])]
              : [...optionReasonCodes(option), 'LOWER_PLAN_BRANCH_UTILITY'],
          })),
        },
      });

      if (!action) {
        degradedReasons.add('LIFETIME_PROGRESS_BLOCKED');
        break;
      }

      const simulation = simulateFullBuildInventoryV2({
        rulesetId: input.rulesetId,
        itemGraph: input.itemGraph,
        capacity: input.capacity,
        initialInventoryItemIds: state.inventoryItemIds,
        actions: [action],
      });
      const simulatedStep = simulation.steps[0];
      state.actions.push(action);
      state.inventoryItemIds = [...simulation.finalInventoryItemIds];

      const semanticReached = input.itemGraph.isTargetSatisfied(
        selected.targetItemId,
        state.inventoryItemIds,
      );
      if (semanticReached) {
        state.completedSemanticItemIds.add(selected.targetItemId);
        if (selected.group) {
          const selections = state.groupSelections.get(selected.group.groupId) ?? new Set<number>();
          selections.add(selected.targetItemId);
          state.groupSelections.set(selected.group.groupId, selections);
        }
      }

      if (!simulatedStep) {
        degradedReasons.add('LIFETIME_SIMULATION_EMPTY');
        break;
      }
    }

    const finalSimulation = simulateFullBuildInventoryV2({
      rulesetId: input.rulesetId,
      itemGraph: input.itemGraph,
      capacity: input.capacity,
      initialInventoryItemIds: input.currentInventoryItemIds,
      actions: state.actions,
    });
    const planRevision = lifetimePlanRevision(input, state.actions);
    const plan: ResolvedFullBuildPlanV2 = {
      planRevision,
      matchId: input.matchId,
      heroId: input.heroId,
      archetypeId: input.archetype.archetypeId,
      stateRevision: input.stateRevision,
      steps: finalSimulation.steps,
      degradedReasons: [...degradedReasons].sort(),
      validation: finalSimulation.validation,
    };
    input.trace?.record({
      stage: 'FINAL_PLAN',
      reasonCodes: [...plan.validation.reasonCodes],
      payload: {
        planRevision: plan.planRevision,
        stepCount: plan.steps.length,
        degradedReasons: [...plan.degradedReasons],
        valid: plan.validation.valid,
        validationReasonCodes: [...plan.validation.reasonCodes],
      },
    });
    return plan;
  }

  private readySemanticOptions(
    input: FullBuildLifetimeResolverV2Input,
    state: LifetimePlanningStateV2,
    outsideCandidates: readonly MatchupCandidateV2[],
  ): LifetimeSemanticOptionV2[] {
    const groupsByItemId = groupByCandidateItemId(input.archetype.groups);
    const options: LifetimeSemanticOptionV2[] = [];

    for (const item of input.archetype.items) {
      if (state.completedSemanticItemIds.has(item.itemId)) continue;
      const group = groupsByItemId.get(item.itemId);
      if (group && groupSatisfied(group, state.groupSelections)) continue;
      if (!hardPredecessorsSatisfied(item.itemId, input.archetype, state)) continue;
      if (input.itemGraph.isTargetSatisfied(item.itemId, state.inventoryItemIds)) {
        state.completedSemanticItemIds.add(item.itemId);
        if (group) {
          const selections = state.groupSelections.get(group.groupId) ?? new Set<number>();
          selections.add(item.itemId);
          state.groupSelections.set(group.groupId, selections);
        }
        continue;
      }

      const utility = this.scoreLifetimeTarget(item.itemId, input, state);
      options.push({ targetItemId: item.itemId, group, utility });
    }

    const archetypeItemIds = new Set(input.archetype.items.map((item) => item.itemId));
    for (const candidate of outsideCandidates) {
      const itemId = candidate.targetItemId;
      if (archetypeItemIds.has(itemId) || state.completedSemanticItemIds.has(itemId)) continue;
      if (!input.itemGraph.getItem(itemId)) continue;
      if (input.itemGraph.isTargetSatisfied(itemId, state.inventoryItemIds)) {
        state.completedSemanticItemIds.add(itemId);
        continue;
      }
      options.push({
        targetItemId: itemId,
        utility: this.scoreLifetimeTarget(itemId, input, state),
        outsideReasonCodes: candidate.reasonCodes,
      });
    }

    if (options.length > 0) {
      input.trace?.record({
        stage: 'ITEM_SCORING',
        reasonCodes: [],
        payload: {
          items: options.map((option) => ({
            itemId: option.targetItemId,
            total: option.utility.total,
            confidence: option.utility.confidence,
            layers: {
              structure: option.utility.layers.structure.weighted,
              matchup: option.utility.layers.matchup.weighted,
              progression: option.utility.layers.progression.weighted,
              transition: option.utility.layers.transition.weighted,
            },
            reasonCodes: optionReasonCodes(option),
          })),
        },
      });
    }

    return options;
  }

  private scoreLifetimeTarget(
    itemId: number,
    input: FullBuildLifetimeResolverV2Input,
    state: LifetimePlanningStateV2,
  ): BuildItemUtilityV2 {
    return this.itemUtility.scoreItem({
      heroId: input.heroId,
      itemId,
      archetype: input.archetype,
      gameTimeSec: input.gameTimeSec,
      ownedItemIds: state.inventoryItemIds,
      projectedItemIds: [],
      enemyHeroIds: input.enemyHeroIds,
      enemyThreats: input.enemyThreats,
      vsHeroRows: input.vsHeroRows,
      wpaPatchData: input.wpaPatchData,
      t4Chains: input.t4Chains,
    });
  }

  private transitionForSemanticTarget(
    input: FullBuildLifetimeResolverV2Input,
    state: LifetimePlanningStateV2,
    selected: LifetimeSemanticOptionV2,
  ): FullBuildTransitionIntentV2 | undefined {
    const item = input.itemGraph.getItem(selected.targetItemId);
    if (!item) return undefined;
    const reasonCodes = selected.outsideReasonCodes
      ? uniqueStrings([
          ...selected.outsideReasonCodes,
          'MATCHUP_DISCOVERY_OUTSIDE_ARCHETYPE',
          'OUTSIDE_ARCHETYPE_CANDIDATE_READY',
        ])
      : [
          selected.group ? 'CHOICE_SELECTED' : 'ARCHETYPE_PROGRESSION',
          'SEMANTIC_PARTIAL_ORDER_READY',
        ];

    const executableRecipe = item.upgradeRecipes.find((recipe) =>
      recipe.consumedItemIds.every((componentItemId) => state.inventoryItemIds.includes(componentItemId)),
    );
    if (executableRecipe) {
      return {
        action: 'UPGRADE',
        buyItemId: selected.targetItemId,
        recipeId: executableRecipe.recipeId,
        reasonCodes,
      };
    }

    if (item.directPurchaseCost !== undefined) {
      if (state.inventoryItemIds.length < input.capacity) {
        return {
          action: 'BUY',
          buyItemId: selected.targetItemId,
          reasonCodes,
        };
      }
      return this.replacementForSemanticTarget(input, state, selected, reasonCodes);
    }

    const componentItemId = firstMissingPurchasableComponent(
      selected.targetItemId,
      state.inventoryItemIds,
      input.itemGraph,
      input.rulesetId,
    );
    if (componentItemId !== undefined && state.inventoryItemIds.length < input.capacity) {
      return {
        action: 'BUY',
        buyItemId: componentItemId,
        reasonCodes: [...reasonCodes, 'PREPARE_UPGRADE'],
      };
    }

    return undefined;
  }

  private replacementForSemanticTarget(
    input: FullBuildLifetimeResolverV2Input,
    state: LifetimePlanningStateV2,
    selected: LifetimeSemanticOptionV2,
    baseReasonCodes: readonly string[],
  ): FullBuildTransitionIntentV2 | undefined {
    const currentState = this.scoreLifetimeInventory(state.inventoryItemIds, input);
    const options: LifetimeReplacementOptionV2[] = [];
    const traceCandidates: Array<BuildReplacementSearchTracePayloadV2['candidates'][number]> = [];

    for (const sellItemId of [...new Set(state.inventoryItemIds)].sort((a, b) => a - b)) {
      const soldItem = input.itemGraph.getItem(sellItemId);
      if (!soldItem?.sellTransition) continue;

      const soldRole = archetypeRoleForItem(sellItemId, input.archetype, input.itemGraph);
      const requiredImprovement = lifetimeReplacementThreshold(soldRole);
      if (isRecentPurchaseProtected(sellItemId, input.recentPurchases ?? [])) {
        traceCandidates.push({
          sellItemId,
          buyItemId: selected.targetItemId,
          marginalGain: 0,
          requiredImprovement,
          disposition: 'REJECTED',
          reasonCodes: [
            'RECENT_PURCHASE_PROTECTED',
            ...(soldRole === 'CORE' ? ['CORE_REPLACEMENT_HIGHER_THRESHOLD'] : []),
          ],
        });
        continue;
      }

      const action: FullBuildTransitionIntentV2 = {
        action: 'REPLACE',
        sellItemId,
        buyItemId: selected.targetItemId,
        reasonCodes: [
          ...baseReasonCodes,
          'WHOLE_INVENTORY_REPLACEMENT_SELECTED',
          ...(soldRole === 'CORE' ? ['CORE_REPLACEMENT_HIGHER_THRESHOLD'] : []),
        ],
      };

      let resultingInventory: readonly number[];
      try {
        resultingInventory = simulateFullBuildInventoryV2({
          rulesetId: input.rulesetId,
          itemGraph: input.itemGraph,
          capacity: input.capacity,
          initialInventoryItemIds: state.inventoryItemIds,
          actions: [action],
        }).finalInventoryItemIds;
      } catch {
        traceCandidates.push({
          sellItemId,
          buyItemId: selected.targetItemId,
          marginalGain: 0,
          requiredImprovement,
          disposition: 'REJECTED',
          reasonCodes: ['MECHANICS_REJECTED'],
        });
        continue;
      }

      const resultingState = this.scoreLifetimeInventory(
        resultingInventory,
        input,
        selected.targetItemId,
        { replacementPenalty: 1 },
      );
      const marginalGain = roundUtility(resultingState.total - currentState.total);
      if (marginalGain < requiredImprovement) {
        traceCandidates.push({
          sellItemId,
          buyItemId: selected.targetItemId,
          marginalGain,
          requiredImprovement,
          disposition: 'REJECTED',
          reasonCodes: [
            'MARGINAL_GAIN_BELOW_THRESHOLD',
            ...(soldRole === 'CORE' ? ['CORE_REPLACEMENT_HIGHER_THRESHOLD'] : []),
          ],
        });
        continue;
      }
      options.push({
        sellItemId,
        action,
        resultingState,
        marginalGain,
        requiredImprovement,
        soldRole,
      });
      traceCandidates.push({
        sellItemId,
        buyItemId: selected.targetItemId,
        marginalGain,
        requiredImprovement,
        disposition: 'REJECTED',
        reasonCodes: [
          'MARGINAL_GAIN_ACCEPTED',
          ...(soldRole === 'CORE' ? ['CORE_REPLACEMENT_HIGHER_THRESHOLD'] : []),
        ],
      });
    }

    const ranked = options.sort(compareLifetimeReplacements);
    const winner = ranked[0];
    input.trace?.record({
      stage: 'REPLACEMENT_SEARCH',
      reasonCodes: winner ? [] : ['NO_ACCEPTED_REPLACEMENT'],
      payload: {
        targetItemId: selected.targetItemId,
        candidates: traceCandidates.map((candidate) => {
          if (!winner || candidate.sellItemId !== winner.sellItemId) return candidate;
          return {
            ...candidate,
            disposition: 'SELECTED',
            reasonCodes: [...candidate.reasonCodes, 'WHOLE_INVENTORY_REPLACEMENT_SELECTED'],
          };
        }),
      },
    });
    return winner?.action;
  }

  private scoreLifetimeInventory(
    itemIds: readonly number[],
    input: FullBuildLifetimeResolverV2Input,
    transitionTargetItemId?: number,
    transition?: Partial<BuildTransitionCostV2>,
  ): FullBuildInventoryUtilityV2 {
    const normalizedItemIds = [...itemIds].sort((a, b) => a - b);
    const itemUtilities: BuildItemUtilityV2[] = [];
    let transitionApplied = false;
    for (const itemId of normalizedItemIds) {
      const applyTransition = !transitionApplied && itemId === transitionTargetItemId;
      const utility = this.itemUtility.scoreItem({
        heroId: input.heroId,
        itemId,
        archetype: input.archetype,
        gameTimeSec: input.gameTimeSec,
        ownedItemIds: normalizedItemIds,
        projectedItemIds: [],
        enemyHeroIds: input.enemyHeroIds,
        enemyThreats: input.enemyThreats,
        vsHeroRows: input.vsHeroRows,
        wpaPatchData: input.wpaPatchData,
        t4Chains: input.t4Chains,
        ...(applyTransition && transition ? { transition } : {}),
      });
      if (applyTransition) transitionApplied = true;
      itemUtilities.push(utility);
    }
    return {
      total: roundUtility(itemUtilities.reduce((sum, utility) => sum + utility.total, 0)),
      confidence: itemUtilities.length === 0
        ? 0
        : roundUtility(
            itemUtilities.reduce((sum, utility) => sum + utility.confidence, 0) / itemUtilities.length,
          ),
      itemUtilities,
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
      : this.scoreInventory(candidate.resultingItemIds, input, targetItemId, transition);
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

  private scoreInventory(
    itemIds: readonly number[],
    input: FullBuildResolverV2Input,
    transitionTargetItemId?: number,
    transition?: Partial<BuildTransitionCostV2>,
  ): FullBuildInventoryUtilityV2 {
    const normalizedItemIds = [...itemIds].sort((a, b) => a - b);
    const itemUtilities: BuildItemUtilityV2[] = [];
    let transitionApplied = false;
    for (const itemId of normalizedItemIds) {
      const applyTransition = !transitionApplied && itemId === transitionTargetItemId;
      const utility = this.itemUtility.scoreItem({
        heroId: input.heroId,
        itemId,
        archetype: input.archetype,
        gameTimeSec: input.gameTimeSec,
        ownedItemIds: normalizedItemIds,
        projectedItemIds: [],
        enemyHeroIds: input.enemyHeroIds,
        enemyThreats: input.enemyThreats,
        vsHeroRows: input.vsHeroRows,
        wpaPatchData: input.wpaPatchData,
        t4Chains: input.t4Chains,
        ...(applyTransition && transition ? { transition } : {}),
      });
      if (applyTransition) transitionApplied = true;
      itemUtilities.push(utility);
    }

    return {
      total: roundUtility(itemUtilities.reduce((sum, utility) => sum + utility.total, 0)),
      confidence: itemUtilities.length === 0
        ? 0
        : roundUtility(
            itemUtilities.reduce((sum, utility) => sum + utility.confidence, 0) / itemUtilities.length,
          ),
      itemUtilities,
    };
  }
}

function initializeLifetimeState(input: FullBuildLifetimeResolverV2Input): LifetimePlanningStateV2 {
  const completedSemanticItemIds = new Set<number>();
  const groupSelections = new Map<string, Set<number>>();
  const groupsByItemId = groupByCandidateItemId(input.archetype.groups);
  for (const item of input.archetype.items) {
    if (!input.itemGraph.isTargetSatisfied(item.itemId, input.currentInventoryItemIds)) continue;
    completedSemanticItemIds.add(item.itemId);
    const group = groupsByItemId.get(item.itemId);
    if (!group) continue;
    const selections = groupSelections.get(group.groupId) ?? new Set<number>();
    selections.add(item.itemId);
    groupSelections.set(group.groupId, selections);
  }
  return {
    inventoryItemIds: [...input.currentInventoryItemIds].sort((a, b) => a - b),
    completedSemanticItemIds,
    groupSelections,
    actions: [],
  };
}

function groupByCandidateItemId(
  groups: readonly BuildArchetypeGroupV2[],
): Map<number, BuildArchetypeGroupV2> {
  const result = new Map<number, BuildArchetypeGroupV2>();
  for (const group of groups) {
    for (const itemId of group.candidateItemIds) {
      if (!result.has(itemId)) result.set(itemId, group);
    }
  }
  return result;
}

function groupSatisfied(
  group: BuildArchetypeGroupV2,
  selections: ReadonlyMap<string, Set<number>>,
): boolean {
  const selected = selections.get(group.groupId)?.size ?? 0;
  if (group.type === 'OPTIONAL' && group.minSelect === 0) return selected > 0;
  return selected >= group.minSelect;
}

function hardPredecessorsSatisfied(
  itemId: number,
  archetype: BuildArchetypeV2,
  state: LifetimePlanningStateV2,
): boolean {
  const groupsByItemId = groupByCandidateItemId(archetype.groups);
  const predecessors = archetype.orderEdges.filter((edge) =>
    edge.afterItemId === itemId && edge.strength === 'HARD',
  );
  return predecessors.every((edge) => {
    if (state.completedSemanticItemIds.has(edge.beforeItemId)) return true;
    const predecessorGroup = groupsByItemId.get(edge.beforeItemId);
    return predecessorGroup ? groupSatisfied(predecessorGroup, state.groupSelections) : false;
  });
}

function firstMissingPurchasableComponent(
  targetItemId: number,
  inventoryItemIds: readonly number[],
  itemGraph: RecommendationItemGraph,
  rulesetId: string,
): number | undefined {
  const target = itemGraph.getItem(targetItemId);
  if (!target) return undefined;
  const candidates = itemGraph.getTransitiveComponentIds(targetItemId)
    .filter((itemId) => !itemGraph.isTargetSatisfied(itemId, inventoryItemIds))
    .map((itemId) => itemGraph.getItem(itemId))
    .filter((item): item is NonNullable<ReturnType<RecommendationItemGraph['getItem']>> =>
      item !== undefined &&
      item.directPurchaseCost !== undefined &&
      item.availableRulesetIds.includes(rulesetId),
    )
    .sort((left, right) =>
      (left.directPurchaseCost ?? 0) - (right.directPurchaseCost ?? 0) || left.itemId - right.itemId,
    );
  return candidates[0]?.itemId;
}

function compareLifetimeOptions(left: LifetimeSemanticOptionV2, right: LifetimeSemanticOptionV2): number {
  return right.utility.total - left.utility.total ||
    right.utility.confidence - left.utility.confidence ||
    left.targetItemId - right.targetItemId;
}

function compareLifetimeReplacements(
  left: LifetimeReplacementOptionV2,
  right: LifetimeReplacementOptionV2,
): number {
  return right.resultingState.total - left.resultingState.total ||
    right.marginalGain - left.marginalGain ||
    right.resultingState.confidence - left.resultingState.confidence ||
    left.sellItemId - right.sellItemId;
}

function lifetimeReplacementThreshold(soldRole: BuildArchetypeRoleV2 | undefined): number {
  const config = STATLOCKER_BUILD_V2_CONFIG.fullBuildResolver;
  return soldRole === 'CORE'
    ? config.coreReplacementMinImprovement
    : config.replacementMinImprovement;
}

function lifetimePlanRevision(
  input: FullBuildLifetimeResolverV2Input,
  actions: readonly FullBuildTransitionIntentV2[],
): string {
  const semantic = actions.map((action) =>
    action.action === 'REPLACE'
      ? `${action.action}:${action.sellItemId}->${action.buyItemId}`
      : `${action.action}:${action.buyItemId}`,
  );
  return createHash('sha256')
    .update(JSON.stringify({
      matchId: input.matchId,
      stateRevision: input.stateRevision,
      archetypeId: input.archetype.archetypeId,
      semantic,
    }))
    .digest('hex')
    .slice(0, 24);
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
  if (soldRole === 'CORE') return config.coreReplacementMinImprovement;
  return config.replacementMinImprovement;
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

function dedupeOutsideCandidates(candidates: readonly MatchupCandidateV2[]): MatchupCandidateV2[] {
  const byTarget = new Map<number, MatchupCandidateV2>();
  for (const candidate of candidates) {
    const existing = byTarget.get(candidate.targetItemId);
    if (!existing || compareOutsideCandidates(candidate, existing) < 0) {
      byTarget.set(candidate.targetItemId, candidate);
    }
  }
  return [...byTarget.values()].sort((left, right) => left.targetItemId - right.targetItemId);
}

function compareOutsideCandidates(left: MatchupCandidateV2, right: MatchupCandidateV2): number {
  return right.utility.total - left.utility.total ||
    right.matchup.confidence - left.matchup.confidence ||
    right.matchup.coverage - left.matchup.coverage ||
    left.targetItemId - right.targetItemId;
}

function optionReasonCodes(option: LifetimeSemanticOptionV2): string[] {
  return uniqueStrings([
    ...option.utility.reasonCodes,
    ...(option.outsideReasonCodes ?? []),
  ]);
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
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

function validateLifetimeInput(input: FullBuildLifetimeResolverV2Input): void {
  if (!input.matchId) throw new Error('Full build resolver v2: matchId is required');
  if (!input.stateRevision) throw new Error('Full build resolver v2: stateRevision is required');
  if (!input.rulesetId) throw new Error('Full build resolver v2: rulesetId is required');
  if (!Number.isInteger(input.capacity) || input.capacity <= 0) {
    throw new Error('Full build resolver v2: capacity must be a positive integer');
  }
  if (input.maxSteps !== undefined && (!Number.isInteger(input.maxSteps) || input.maxSteps <= 0)) {
    throw new Error('Full build resolver v2: maxSteps must be a positive integer');
  }
  for (const candidate of input.outsideCandidates ?? []) {
    if (candidate.source !== 'STATLOCKER_VS_HERO_WPA') {
      throw new Error('Full build resolver v2: outside candidate must be Statlocker-backed');
    }
    if (!input.itemGraph.getItem(candidate.targetItemId)) {
      throw new Error(`Full build resolver v2: outside candidate item ${candidate.targetItemId} is not in the catalog`);
    }
  }
  validateTransitionInput({
    heroId: input.heroId,
    archetype: input.archetype,
    itemGraph: input.itemGraph,
    gameTimeSec: input.gameTimeSec,
    currentInventoryItemIds: input.currentInventoryItemIds,
    candidates: [],
    enemyHeroIds: input.enemyHeroIds,
    enemyThreats: input.enemyThreats,
    vsHeroRows: input.vsHeroRows,
    wpaPatchData: input.wpaPatchData,
    t4Chains: input.t4Chains,
    recentPurchases: input.recentPurchases,
  });
}

function roundUtility(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 1_000_000) / 1_000_000;
}
