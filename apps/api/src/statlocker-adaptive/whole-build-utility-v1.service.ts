import { Injectable } from '@nestjs/common';
import { ADAPTIVE_POLICY_V1_CONFIG } from './statlocker-adaptive.config';

export type WholeBuildReplacementKindV1 = 'ORDINARY' | 'SOFT_CORE' | 'OUTSIDE_SKELETON';

export interface WholeBuildUtilityContributionsV1 {
  skeletonAdherence: number;
  coreIntegrity: number;
  branchCoherence: number;
  threatMatchup: number;
  synergy: number;
  timing: number;
  slotEfficiency: number;
  economyOpportunityCost: number;
  investmentContinuity: number;
}

export interface WholeBuildReplacementEvaluationV1Input {
  kind: WholeBuildReplacementKindV1;
  current: WholeBuildUtilityContributionsV1;
  candidate: WholeBuildUtilityContributionsV1;
  transactionFriction: number;
  churnPenalty: number;
  investmentLoss: number;
  finalItemCount: number;
  maxItemCount: number;
  protectedSale: boolean;
  sellEconomicsKnown: boolean;
}

export interface WholeBuildReplacementEvaluationV1 {
  accepted: boolean;
  currentUtility: number;
  candidateUtility: number;
  netGain: number;
  threshold: number;
  reasonCodes: readonly string[];
  trace: {
    current: WholeBuildUtilityContributionsV1;
    candidate: WholeBuildUtilityContributionsV1;
    penalties: {
      transactionFriction: number;
      churnPenalty: number;
      investmentLoss: number;
    };
  };
}

const UTILITY_KEYS: readonly (keyof WholeBuildUtilityContributionsV1)[] = [
  'skeletonAdherence',
  'coreIntegrity',
  'branchCoherence',
  'threatMatchup',
  'synergy',
  'timing',
  'slotEfficiency',
  'economyOpportunityCost',
  'investmentContinuity',
];

@Injectable()
export class WholeBuildUtilityV1Service {
  evaluateReplacement(input: WholeBuildReplacementEvaluationV1Input): WholeBuildReplacementEvaluationV1 {
    const threshold = replacementThreshold(input.kind);
    const currentUtility = utilityTotal(input.current);
    const candidateUtility = utilityTotal(input.candidate);
    const transactionFriction = nonNegativeFinite(input.transactionFriction);
    const churnPenalty = nonNegativeFinite(input.churnPenalty);
    const investmentLoss = nonNegativeFinite(input.investmentLoss);
    const penalties = transactionFriction + churnPenalty + investmentLoss;
    const netGain = roundUtility(candidateUtility - currentUtility - penalties);
    const reasonCodes: string[] = [];

    if (!utilityInputIsFinite(input)) reasonCodes.push('UTILITY_INPUT_INVALID');
    if (input.protectedSale) reasonCodes.push('PROTECTED_SALE');
    if (!input.sellEconomicsKnown) reasonCodes.push('SELL_ECONOMICS_UNKNOWN');
    if (!capacityIsValid(input.finalItemCount, input.maxItemCount)) reasonCodes.push('FINAL_CAPACITY_EXCEEDED');
    if (netGain < threshold) reasonCodes.push('WHOLE_BUILD_GAIN_BELOW_THRESHOLD');

    const accepted = reasonCodes.length === 0;
    return {
      accepted,
      currentUtility,
      candidateUtility,
      netGain,
      threshold,
      reasonCodes: accepted ? ['WHOLE_BUILD_REPLACEMENT_ACCEPTED'] : [...new Set(reasonCodes)].sort(),
      trace: {
        current: { ...input.current },
        candidate: { ...input.candidate },
        penalties: {
          transactionFriction,
          churnPenalty,
          investmentLoss,
        },
      },
    };
  }
}

function replacementThreshold(kind: WholeBuildReplacementKindV1): number {
  if (kind === 'SOFT_CORE') return ADAPTIVE_POLICY_V1_CONFIG.coreReplaceMinImprovement;
  if (kind === 'OUTSIDE_SKELETON') {
    return ADAPTIVE_POLICY_V1_CONFIG.situational.matchupDiscoveryReplaceMinImprovement;
  }
  return ADAPTIVE_POLICY_V1_CONFIG.sellMinImprovement;
}

function utilityTotal(contributions: WholeBuildUtilityContributionsV1): number {
  const total = UTILITY_KEYS.reduce((sum, key) => {
    const value = contributions[key];
    return sum + (Number.isFinite(value) ? value : 0);
  }, 0);
  return roundUtility(total);
}

function utilityInputIsFinite(input: WholeBuildReplacementEvaluationV1Input): boolean {
  return UTILITY_KEYS.every((key) =>
    Number.isFinite(input.current[key]) && Number.isFinite(input.candidate[key]),
  ) &&
    Number.isFinite(input.transactionFriction) &&
    Number.isFinite(input.churnPenalty) &&
    Number.isFinite(input.investmentLoss) &&
    Number.isInteger(input.finalItemCount) &&
    Number.isInteger(input.maxItemCount);
}

function capacityIsValid(finalItemCount: number, maxItemCount: number): boolean {
  return Number.isInteger(finalItemCount) &&
    Number.isInteger(maxItemCount) &&
    finalItemCount >= 0 &&
    maxItemCount > 0 &&
    finalItemCount <= maxItemCount;
}

function nonNegativeFinite(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function roundUtility(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 1_000_000) / 1_000_000;
}
