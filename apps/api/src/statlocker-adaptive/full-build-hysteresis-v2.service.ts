import { Injectable } from '@nestjs/common';
import { FullBuildStepV2, ResolvedFullBuildPlanV2 } from './full-build-plan-v2';
import { STATLOCKER_BUILD_V2_CONFIG } from './statlocker-build-v2.config';

export interface BuildPlanSwitchContextV2 {
  improvement: number;
  coreReplacement: boolean;
  recentPurchaseProtected: boolean;
}

export interface BuildPlanSwitchDecisionV2 {
  action: 'KEEP_PREVIOUS' | 'SWITCH_TO_CANDIDATE';
  selected: ResolvedFullBuildPlanV2;
  requiredImprovement: number;
  reasonCodes: readonly string[];
}

@Injectable()
export class FullBuildHysteresisV2Service {
  choose(
    previous: ResolvedFullBuildPlanV2,
    candidate: ResolvedFullBuildPlanV2,
    context: BuildPlanSwitchContextV2,
  ): BuildPlanSwitchDecisionV2 {
    validateComparablePlans(previous, candidate);
    if (!Number.isFinite(context.improvement)) {
      throw new Error('Full build hysteresis v2: improvement must be finite');
    }

    const reasonCodes: string[] = [];
    const config = STATLOCKER_BUILD_V2_CONFIG.fullBuildResolver;
    const firstChangedStepIndex = findFirstChangedStepIndex(previous.steps, candidate.steps);
    const nearTermChange = firstChangedStepIndex >= 0 &&
      firstChangedStepIndex < config.nearTermProtectedStepCount;
    const normalRequiredImprovement = nearTermChange
      ? Math.max(config.minPlanSwitchImprovement, config.nearTermPlanSwitchMinImprovement)
      : config.minPlanSwitchImprovement;
    const requiredImprovement = context.coreReplacement
      ? Math.max(config.coreReplacementMinImprovement, normalRequiredImprovement)
      : normalRequiredImprovement;

    if (context.coreReplacement) reasonCodes.push('CORE_REPLACEMENT_HIGHER_THRESHOLD');
    if (nearTermChange) reasonCodes.push('NEAR_TERM_PLAN_COMMITMENT_PROTECTED');
    if (!candidate.validation.valid) {
      return {
        action: 'KEEP_PREVIOUS',
        selected: previous,
        requiredImprovement,
        reasonCodes: [...reasonCodes, 'SEMANTICALLY_INVALID_CANDIDATE'],
      };
    }
    if (context.recentPurchaseProtected) {
      return {
        action: 'KEEP_PREVIOUS',
        selected: previous,
        requiredImprovement,
        reasonCodes: [...reasonCodes, 'RECENT_PURCHASE_PROTECTED'],
      };
    }

    if (context.improvement < requiredImprovement) {
      return {
        action: 'KEEP_PREVIOUS',
        selected: previous,
        requiredImprovement,
        reasonCodes: [...reasonCodes, 'PLAN_HYSTERESIS_MARGIN_NOT_CLEARED'],
      };
    }

    return {
      action: 'SWITCH_TO_CANDIDATE',
      selected: candidate,
      requiredImprovement,
      reasonCodes: [...reasonCodes, 'PLAN_HYSTERESIS_MARGIN_CLEARED'],
    };
  }
}

function validateComparablePlans(
  previous: ResolvedFullBuildPlanV2,
  candidate: ResolvedFullBuildPlanV2,
): void {
  if (previous.matchId !== candidate.matchId) {
    throw new Error('Full build hysteresis v2: plans must belong to the same match');
  }
  if (previous.heroId !== candidate.heroId) {
    throw new Error('Full build hysteresis v2: plans must belong to the same hero');
  }
  if (previous.archetypeId !== candidate.archetypeId) {
    throw new Error('Full build hysteresis v2: locked archetype cannot change');
  }
}

function findFirstChangedStepIndex(
  previous: readonly FullBuildStepV2[],
  candidate: readonly FullBuildStepV2[],
): number {
  const length = Math.max(previous.length, candidate.length);
  for (let index = 0; index < length; index += 1) {
    const previousStep = previous[index];
    const candidateStep = candidate[index];
    if (!previousStep || !candidateStep) return index;
    if (stepSemanticKey(previousStep) !== stepSemanticKey(candidateStep)) return index;
  }
  return -1;
}

function stepSemanticKey(step: FullBuildStepV2): string {
  return [
    step.action,
    step.buyItemId,
    step.sellItemId ?? '',
    step.recipeId ?? '',
  ].join(':');
}
