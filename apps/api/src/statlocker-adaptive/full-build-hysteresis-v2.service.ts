import { Injectable } from '@nestjs/common';
import { ResolvedFullBuildPlanV2 } from './full-build-plan-v2';
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
    const requiredImprovement = context.coreReplacement
      ? STATLOCKER_BUILD_V2_CONFIG.fullBuildResolver.coreReplacementMinImprovement
      : STATLOCKER_BUILD_V2_CONFIG.fullBuildResolver.minPlanSwitchImprovement;

    if (context.coreReplacement) reasonCodes.push('CORE_REPLACEMENT_HIGHER_THRESHOLD');
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
