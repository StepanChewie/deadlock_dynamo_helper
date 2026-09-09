import { Injectable } from '@nestjs/common';
import {
  BuildContractV1,
  BuildSituationalDecisionV1,
  BuildSituationalPurposeV1,
  BuildStrategySpecV1,
} from './build-strategy-v1';

export interface BuildSituationalCandidateEvidenceV1 {
  targetItemId: number;
  purpose: BuildSituationalPurposeV1;
  enemyHeroIds: readonly number[];
  enemyItemIds: readonly number[];
  contextualScore: number;
  statisticalSupport: number;
  confidence: number;
  effectiveCostSouls: number;
  slotImpact: number;
  investmentImpact: number;
  coreInterruptionSouls: number;
  requiredImprovement?: number;
  reasonCodes: readonly string[];
}

export interface ResolveBuildSituationalV1Input {
  strategy: BuildStrategySpecV1;
  contract: BuildContractV1;
  candidates: readonly BuildSituationalCandidateEvidenceV1[];
  continueCoreScore: number;
  minOverrideImprovement: number;
}

@Injectable()
export class BuildSituationalResolverV1Service {
  resolve(input: ResolveBuildSituationalV1Input): BuildSituationalDecisionV1 | undefined {
    const openWindows = input.strategy.situationalWindows
      .filter((window) => input.contract.reservedSituationalWindowIds.includes(window.windowId));
    if (openWindows.length === 0) return undefined;
    const threshold = Math.max(0, input.minOverrideImprovement);

    const eligible = input.candidates.flatMap((candidate) => {
      const windows = openWindows.filter((window) =>
        window.allowedPurposes.includes(candidate.purpose) &&
        candidate.slotImpact <= window.maxSlots &&
        candidate.effectiveCostSouls <= window.maxSouls &&
        candidate.coreInterruptionSouls <= window.maxCoreDelaySouls,
      );
      return windows.map((window) => ({ candidate, window }));
    }).filter(({ candidate }) =>
      candidate.confidence > 0 &&
      candidate.statisticalSupport > 0 &&
      candidate.contextualScore - input.continueCoreScore >= requiredImprovement(candidate, threshold),
    ).sort((a, b) =>
      b.candidate.contextualScore - a.candidate.contextualScore ||
      b.candidate.confidence - a.candidate.confidence ||
      b.candidate.statisticalSupport - a.candidate.statisticalSupport ||
      a.candidate.targetItemId - b.candidate.targetItemId ||
      a.window.windowId.localeCompare(b.window.windowId),
    );

    const selected = eligible[0];
    if (!selected) return undefined;
    const candidate = selected.candidate;
    return {
      windowId: selected.window.windowId,
      purpose: candidate.purpose,
      targetItemId: candidate.targetItemId,
      enemyHeroIds: [...new Set(candidate.enemyHeroIds)].sort((a, b) => a - b),
      enemyItemIds: [...new Set(candidate.enemyItemIds)].sort((a, b) => a - b),
      statisticalSupport: candidate.statisticalSupport,
      confidence: candidate.confidence,
      slotImpact: candidate.slotImpact,
      investmentImpact: candidate.investmentImpact,
      coreInterruptionSouls: candidate.coreInterruptionSouls,
      reasonCodes: [...new Set([
        ...candidate.reasonCodes,
        'SITUATIONAL_WINDOW_ACTIVE',
        'SITUATIONAL_OVERRIDE_BEATS_CONTINUE_CORE',
      ])].sort(),
    };
  }
}

function requiredImprovement(
  candidate: BuildSituationalCandidateEvidenceV1,
  fallback: number,
): number {
  const candidateThreshold = candidate.requiredImprovement;
  if (candidateThreshold === undefined || !Number.isFinite(candidateThreshold)) return fallback;
  return Math.max(fallback, Math.max(0, candidateThreshold));
}
