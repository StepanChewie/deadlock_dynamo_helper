import { Injectable } from '@nestjs/common';
import {
  RecommendationItemGraph,
  recommendationSlotUsageFor,
} from '@deadlock-live-probe/build-domain';
import {
  AdaptiveSlotStateV1,
  candidateGeneratorRulesFromSlotStateV1,
} from './adaptive-economy-v1';
import {
  BuildContractV1,
  BuildSlotPlanTransitionV1,
  BuildSlotPlanV1,
  BuildStrategySpecV1,
} from './build-strategy-v1';

export interface BuildSlotPlannerV1Input {
  strategy: BuildStrategySpecV1;
  contract: BuildContractV1;
  itemGraph: RecommendationItemGraph;
  ownedItemIds: readonly number[];
  slots: AdaptiveSlotStateV1;
}

@Injectable()
export class BuildSlotPlannerV1Service {
  plan(input: BuildSlotPlannerV1Input): BuildSlotPlanV1 {
    const owned = new Set(input.ownedItemIds);
    const goalById = new Map(input.strategy.goals.map((goal) => [goal.goalId, goal]));
    const transitions: BuildSlotPlanTransitionV1[] = [];
    const reasonCodes: string[] = [];
    let feasible = true;

    const goalsToPlan = input.contract.remainingHardGoalIds.length > 0
      ? input.contract.remainingHardGoalIds
      : input.strategy.goals
          .filter((goal) => {
            const state = input.contract.goalStates[goal.goalId];
            return state !== 'SATISFIED' && state !== 'SKIPPED' && state !== 'WAIVED';
          })
          .map((goal) => goal.goalId);

    for (const goalId of goalsToPlan) {
      const goal = goalById.get(goalId);
      if (!goal || input.contract.goalStates[goalId] === 'SKIPPED') continue;
      const targetItemId = goal.targetItemIds.find((itemId) => !input.itemGraph.isTargetSatisfied(itemId, owned));
      if (targetItemId === undefined) continue;
      const transition = this.transitionForTarget(input, goalId, targetItemId);
      transitions.push(transition);
      if (transition.requirement === 'BLOCKED') feasible = false;
    }

    if (transitions.some((entry) => entry.requirement === 'FLEX_UNLOCK')) reasonCodes.push('FUTURE_GOAL_REQUIRES_FLEX_UNLOCK');
    if (transitions.some((entry) => entry.requirement === 'SELL_TEMPORARY')) reasonCodes.push('TEMPORARY_ITEM_EXIT_REQUIRED');
    if (transitions.some((entry) => entry.requirement === 'UPGRADE')) reasonCodes.push('UPGRADE_COMPRESSES_SLOT_PATH');
    if (transitions.some((entry) => entry.requirement === 'REPLACE')) reasonCodes.push('EXPLICIT_REPLACEMENT_PATH_REQUIRED');
    if (!feasible) reasonCodes.push('NO_SLOT_FEASIBLE_PATH');

    return {
      currentUsedSlots: input.slots.usedSlots,
      currentFlexUsed: input.slots.usedFlexSlots,
      unlockedFlexSlots: input.slots.unlockedFlexSlots,
      reservedSituationalSlots: input.strategy.slotPolicy.reservedSituationalSlots,
      futureTransitions: transitions,
      feasible,
      reasonCodes: [...new Set(reasonCodes)].sort(),
    };
  }

  public transitionForTarget(
    input: BuildSlotPlannerV1Input,
    goalId: string,
    targetItemId: number,
  ): BuildSlotPlanTransitionV1 {
    const target = input.itemGraph.getItem(targetItemId);
    if (!target) {
      return {
        targetGoalId: goalId,
        targetItemId,
        requirement: 'BLOCKED',
        reasonCodes: ['TARGET_ITEM_UNKNOWN', 'NO_SLOT_EXIT_PATH'],
      };
    }

    const owned = new Set(input.ownedItemIds);
    const upgradeRecipe = target.upgradeRecipes.find((recipe) =>
      recipe.consumedItemIds.length > 0 && recipe.consumedItemIds.every((itemId) => owned.has(itemId)),
    );
    if (upgradeRecipe) {
      const consumedItemIds = new Set(upgradeRecipe.consumedItemIds);
      const projectedItemIds = [
        ...input.ownedItemIds.filter((itemId) => !consumedItemIds.has(itemId)),
        targetItemId,
      ];
      if (this.canFit(projectedItemIds, input)) {
        return {
          targetGoalId: goalId,
          targetItemId,
          requirement: 'UPGRADE',
          sourceItemId: upgradeRecipe.consumedItemIds[0],
          reasonCodes: ['OWNED_COMPONENT_REUSED'],
        };
      }
    }

    if (this.canFit([...input.ownedItemIds, targetItemId], input)) {
      return {
        targetGoalId: goalId,
        targetItemId,
        requirement: 'NONE',
        reasonCodes: ['CURRENT_CAPACITY_SUFFICIENT'],
      };
    }

    for (const temporaryItemId of input.contract.temporaryItemIds) {
      if (!owned.has(temporaryItemId)) continue;
      const afterExit = input.ownedItemIds.filter((itemId) => itemId !== temporaryItemId);
      if (this.canFit([...afterExit, targetItemId], input)) {
        return {
          targetGoalId: goalId,
          targetItemId,
          requirement: 'SELL_TEMPORARY',
          sourceItemId: temporaryItemId,
          reasonCodes: ['TEMPORARY_ITEM_FREES_REQUIRED_SLOT'],
        };
      }
    }

    const currentUnlocked = input.slots.unlockedFlexSlots ?? input.slots.provedFlexLowerBound;
    const requiredFlex = requiredFlexAfterAdd(input.ownedItemIds, targetItemId, input);
    if (requiredFlex > 0 && requiredFlex <= input.slots.maxFlexSlots &&
      (currentUnlocked === undefined || requiredFlex > currentUnlocked)) {
      return {
        targetGoalId: goalId,
        targetItemId,
        requirement: 'FLEX_UNLOCK',
        requiredUnlockedFlexSlots: requiredFlex,
        reasonCodes: currentUnlocked === undefined
          ? ['FLEX_CAPACITY_UNKNOWN', 'TARGET_REQUIRES_FLEX']
          : ['TARGET_LOCKED_UNTIL_FLEX_UNLOCK'],
      };
    }

    const replacementSource = findReplacementSource(input, targetItemId, (itemIds) => this.canFit(itemIds, input));
    if (replacementSource !== undefined) {
      return {
        targetGoalId: goalId,
        targetItemId,
        requirement: 'REPLACE',
        sourceItemId: replacementSource,
        reasonCodes: ['NON_MANDATORY_ITEM_REPLACEMENT_PATH'],
      };
    }

    return {
      targetGoalId: goalId,
      targetItemId,
      requirement: 'BLOCKED',
      reasonCodes: ['NO_SLOT_EXIT_PATH'],
    };
  }

  public canFit(itemIds: readonly number[], input: BuildSlotPlannerV1Input): boolean {
    const rules = candidateGeneratorRulesFromSlotStateV1(input.slots);
    const usage = recommendationSlotUsageFor(itemIds, input.itemGraph, rules);
    const requiredFlex = minimumRequiredFlex(usage.flexUsed, usage.itemCount, input.strategy.slotPolicy.reservedSituationalSlots, input.slots.baseSlots);
    if (requiredFlex > input.slots.maxFlexSlots) return false;
    const currentUnlocked = input.slots.unlockedFlexSlots ?? input.slots.provedFlexLowerBound;
    if (currentUnlocked === undefined) {
      if (requiredFlex > 0) return false;
    } else if (requiredFlex > currentUnlocked) {
      return false;
    }
    const currentActiveItems = recommendationSlotUsageFor(input.ownedItemIds, input.itemGraph, rules).activeItemsUsed;
    if (usage.activeItemsUsed <= currentActiveItems) return true;
    // An unverified numeric maxActiveItems is not production truth: it cannot certify an active-count increase.
    if (input.slots.mechanicsEvidence === 'UNKNOWN') return false;
    return usage.activeItemsUsed <= input.slots.maxActiveItems;
  }
}

function findReplacementSource(
  input: BuildSlotPlannerV1Input,
  targetItemId: number,
  canFit: (itemIds: readonly number[]) => boolean,
): number | undefined {
  const terminalGoalIds = new Set(input.strategy.terminalPolicy.requiredGoalIds);
  const terminalHardGoals = input.strategy.goals.filter((goal) =>
    goal.hard && terminalGoalIds.has(goal.goalId) && input.contract.goalStates[goal.goalId] === 'SATISFIED' && goal.minSelect > 0,
  );
  const targetItem = input.itemGraph.getItem(targetItemId);

  const ownedIds = [...new Set(input.ownedItemIds)];
  const candidateScores = ownedIds.map((sourceItemId) => {
    const item = input.itemGraph.getItem(sourceItemId);
    const sameCategory = targetItem && item && item.slotType === targetItem.slotType ? 1 : 0;
    const isTemp = input.contract.temporaryItemIds.includes(sourceItemId) ? 1 : 0;
    const isTerminalHard = terminalHardGoals.some((g) =>
      g.targetItemIds.some((targetId) => input.itemGraph.isTargetSatisfied(targetId, [sourceItemId]))
    );
    const expendableTier = isTemp ? 2 : (!isTerminalHard ? 1 : 0);
    const cost = item?.directPurchaseCost ?? 0;
    return { sourceItemId, sameCategory, expendableTier, cost };
  }).sort((a, b) =>
    b.expendableTier - a.expendableTier ||
    b.sameCategory - a.sameCategory ||
    a.cost - b.cost ||
    a.sourceItemId - b.sourceItemId,
  );

  for (const { sourceItemId, cost: sourceCost } of candidateScores) {
    if (input.itemGraph.isComponentAncestor(sourceItemId, targetItemId)) continue;
    if (input.itemGraph.isComponentAncestor(targetItemId, sourceItemId)) continue;
    if (isReadyUpgradeComponentForPendingHardGoal(input, sourceItemId, targetItemId)) continue;

    const afterExit = input.ownedItemIds.filter((itemId) => itemId !== sourceItemId);
    const preservesTerminalGoals = terminalHardGoals.every((goal) => {
      const satisfied = goal.targetItemIds.filter((itemId) => input.itemGraph.isTargetSatisfied(itemId, afterExit)).length;
      if (satisfied >= goal.minSelect) return true;
      return goal.targetItemIds.some((itemId) => input.itemGraph.isTargetSatisfied(itemId, [targetItemId]));
    });
    if (!preservesTerminalGoals) continue;
    if (canFit([...afterExit, targetItemId])) return sourceItemId;
  }
  return undefined;
}

function isReadyUpgradeComponentForPendingHardGoal(
  input: BuildSlotPlannerV1Input,
  sourceItemId: number,
  currentTargetItemId: number,
): boolean {
  const owned = new Set(input.ownedItemIds);
  return input.strategy.goals
    .filter((goal) => goal.hard && goal.minSelect > 0)
    .filter((goal) => {
      const state = input.contract.goalStates[goal.goalId];
      return state !== 'SATISFIED' && state !== 'SKIPPED' && state !== 'WAIVED';
    })
    .filter((goal) => !goal.targetItemIds.includes(currentTargetItemId))
    .some((goal) => goal.targetItemIds.some((targetItemId) => {
      if (input.itemGraph.isComponentAncestor(sourceItemId, targetItemId)) return true;
      const target = input.itemGraph.getItem(targetItemId);
      return target?.upgradeRecipes.some((recipe) =>
        recipe.consumedItemIds.includes(sourceItemId) &&
        recipe.consumedItemIds.every((componentItemId) => owned.has(componentItemId)),
      ) ?? false;
    }));
}

function requiredFlexAfterAdd(
  ownedItemIds: readonly number[],
  targetItemId: number,
  input: BuildSlotPlannerV1Input,
): number {
  const rules = candidateGeneratorRulesFromSlotStateV1(input.slots);
  const usage = recommendationSlotUsageFor([...ownedItemIds, targetItemId], input.itemGraph, rules);
  return minimumRequiredFlex(
    usage.flexUsed,
    usage.itemCount,
    input.strategy.slotPolicy.reservedSituationalSlots,
    input.slots.baseSlots,
  );
}

function minimumRequiredFlex(
  categoryFlexUsed: number,
  itemCount: number,
  reservedSituationalSlots: number,
  baseSlots: number,
): number {
  const totalReserved = Math.max(0, reservedSituationalSlots);
  const generalOverflow = Math.max(0, itemCount + totalReserved - baseSlots);
  return Math.max(categoryFlexUsed, generalOverflow);
}
