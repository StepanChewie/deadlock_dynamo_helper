import { Injectable } from '@nestjs/common';
import { RecommendationItemGraph } from '@dynamo-lab/build-domain';
import { BuildArchetypeGroupV2, BuildArchetypeV2 } from './build-archetype-v2';
import {
  BuildFamilySatisfactionV2,
  evaluateBuildFamilySatisfactionV2,
  isTerminalFamilySatisfactionV2,
} from './build-family-satisfaction-v2';
import { DesiredBuildStateV2 } from './build-desired-state-v2.service';
import { FullBuildStepV2 } from './full-build-plan-v2';

export type FullBuildSemanticValidationReasonV2 =
  | 'REQUIRED_FAMILY_UNSATISFIED'
  | 'CHOICE_BOUNDS_UNSATISFIED'
  | 'REQUIRED_FAMILY_REGRESSION'
  | 'IMMEDIATE_BUY_REPLACE_CHURN'
  | 'POINTLESS_PURCHASE_CHURN'
  | 'UNSUPPORTED_STRATEGIC_TERMINAL';

export interface FullBuildSemanticValidationV2 {
  valid: boolean;
  reasonCodes: readonly FullBuildSemanticValidationReasonV2[];
  finalFamilyStates: readonly BuildFamilySatisfactionV2[];
}

export interface ValidateFullBuildSemanticsV2Input {
  archetype: BuildArchetypeV2;
  desiredState: DesiredBuildStateV2;
  initialInventoryItemIds: readonly number[];
  steps: readonly FullBuildStepV2[];
  itemGraph: RecommendationItemGraph;
}

@Injectable()
export class FullBuildSemanticValidatorV2Service {
  validate(input: ValidateFullBuildSemanticsV2Input): FullBuildSemanticValidationV2 {
    const reasons = new Set<FullBuildSemanticValidationReasonV2>();
    const families = input.archetype.families ?? [];
    const familyById = new Map(families.map((family) => [family.familyId, family]));
    const finalInventoryItemIds = input.steps.length > 0
      ? input.steps[input.steps.length - 1].inventoryAfter
      : input.initialInventoryItemIds;
    const finalFamilyStates = evaluateBuildFamilySatisfactionV2(
      input.archetype,
      finalInventoryItemIds,
      input.itemGraph,
    );
    const finalStateByFamilyId = new Map(finalFamilyStates.map((state) => [state.familyId, state]));

    for (const desired of input.desiredState.families) {
      const family = familyById.get(desired.familyId);
      const supported = family?.terminalCandidates.some((candidate) =>
        candidate.itemId === desired.selectedTerminalItemId &&
        candidate.kind === desired.selectedTerminalKind,
      ) ?? false;
      if (!supported) {
        reasons.add('UNSUPPORTED_STRATEGIC_TERMINAL');
        continue;
      }

      const selectedTerminalSatisfied = input.itemGraph.isTargetSatisfied(
        desired.selectedTerminalItemId,
        finalInventoryItemIds,
      );
      if (desired.requirement === 'REQUIRED' && !selectedTerminalSatisfied) {
        reasons.add('REQUIRED_FAMILY_UNSATISFIED');
      }
      if (desired.requirement === 'CHOICE' && !selectedTerminalSatisfied) {
        reasons.add('CHOICE_BOUNDS_UNSATISFIED');
      }
    }

    validateChoiceBounds(input, finalStateByFamilyId, reasons);
    validateRequiredFamilyMonotonicity(input, reasons);
    validatePurchaseChurn(input, reasons);

    const reasonCodes = [...reasons].sort();
    return {
      valid: reasonCodes.length === 0,
      reasonCodes,
      finalFamilyStates,
    };
  }
}

function validateChoiceBounds(
  input: ValidateFullBuildSemanticsV2Input,
  finalStateByFamilyId: ReadonlyMap<number, BuildFamilySatisfactionV2>,
  reasons: Set<FullBuildSemanticValidationReasonV2>,
): void {
  const itemToFamily = buildItemToFamilyMap(input.archetype);
  for (const group of input.archetype.groups.filter((entry) => entry.type === 'CHOICE')) {
    const familyIds = resolveGroupFamilyIds(group, itemToFamily);
    const satisfiedCount = familyIds.filter((familyId) => {
      const state = finalStateByFamilyId.get(familyId);
      return state ? isTerminalFamilySatisfactionV2(state.status) : false;
    }).length;
    if (satisfiedCount < group.minSelect || satisfiedCount > group.maxSelect) {
      reasons.add('CHOICE_BOUNDS_UNSATISFIED');
    }
  }
}

function validateRequiredFamilyMonotonicity(
  input: ValidateFullBuildSemanticsV2Input,
  reasons: Set<FullBuildSemanticValidationReasonV2>,
): void {
  const requiredFamilyIds = new Set(
    (input.archetype.families ?? [])
      .filter((family) => family.requirement === 'REQUIRED')
      .map((family) => family.familyId),
  );
  if (requiredFamilyIds.size === 0 || input.steps.length === 0) return;

  let previous = new Map(
    evaluateBuildFamilySatisfactionV2(input.archetype, input.initialInventoryItemIds, input.itemGraph)
      .map((state) => [state.familyId, state]),
  );

  for (const step of input.steps) {
    const current = new Map(
      evaluateBuildFamilySatisfactionV2(input.archetype, step.inventoryAfter, input.itemGraph)
        .map((state) => [state.familyId, state]),
    );
    for (const familyId of requiredFamilyIds) {
      const before = previous.get(familyId);
      const after = current.get(familyId);
      if (
        before && isTerminalFamilySatisfactionV2(before.status) &&
        (!after || !isTerminalFamilySatisfactionV2(after.status))
      ) {
        reasons.add('REQUIRED_FAMILY_REGRESSION');
      }
    }
    previous = current;
  }
}

function validatePurchaseChurn(
  input: ValidateFullBuildSemanticsV2Input,
  reasons: Set<FullBuildSemanticValidationReasonV2>,
): void {
  for (let acquiredIndex = 0; acquiredIndex < input.steps.length; acquiredIndex += 1) {
    const acquired = input.steps[acquiredIndex];
    const itemId = acquired.buyItemId;
    for (let index = acquiredIndex + 1; index < input.steps.length; index += 1) {
      const step = input.steps[index];
      if (!step.inventoryBefore.includes(itemId) || step.inventoryAfter.includes(itemId)) continue;
      if (isLegalUpgradeConsumption(step, itemId, input.itemGraph)) break;
      if (
        index === acquiredIndex + 1 &&
        step.action === 'REPLACE' &&
        step.sellItemId === itemId
      ) {
        reasons.add('IMMEDIATE_BUY_REPLACE_CHURN');
      }
      reasons.add('POINTLESS_PURCHASE_CHURN');
      break;
    }
  }
}

function isLegalUpgradeConsumption(
  step: FullBuildStepV2,
  consumedItemId: number,
  itemGraph: RecommendationItemGraph,
): boolean {
  if (step.action !== 'UPGRADE' || !step.recipeId || !step.consumedItemIds.includes(consumedItemId)) {
    return false;
  }
  const target = itemGraph.getItem(step.buyItemId);
  const recipe = target?.upgradeRecipes.find((entry) => entry.recipeId === step.recipeId);
  return recipe?.consumedItemIds.includes(consumedItemId) ?? false;
}

function buildItemToFamilyMap(archetype: BuildArchetypeV2): Map<number, number> {
  return new Map(
    (archetype.families ?? []).flatMap((family) =>
      family.progressionNodes.map((node) => [node.itemId, family.familyId] as const),
    ),
  );
}

function resolveGroupFamilyIds(
  group: BuildArchetypeGroupV2,
  itemToFamily: ReadonlyMap<number, number>,
): number[] {
  if (group.candidateFamilyIds && group.candidateFamilyIds.length > 0) {
    return [...new Set(group.candidateFamilyIds)].sort((a, b) => a - b);
  }
  return [...new Set(
    group.candidateItemIds
      .map((itemId) => itemToFamily.get(itemId))
      .filter((familyId): familyId is number => familyId !== undefined),
  )].sort((a, b) => a - b);
}
