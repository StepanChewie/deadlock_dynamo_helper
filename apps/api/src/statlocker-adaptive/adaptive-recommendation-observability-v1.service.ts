import { Injectable, Logger } from '@nestjs/common';
import {
  AdaptivePlanProjectionV1,
  AdaptivePlanSessionV1,
  AdaptiveRecommendationResultV1,
} from '@deadlock-live-probe/shared';
import { AdaptiveDecisionStateV1 } from './adaptive-decision-state-v1.service';
import { StatlockerEvidenceBundleV1 } from './statlocker-evidence.service';
import {
  StrategyFirstInvariantCheckV1,
  StrategyFirstInvariantSummaryV1,
  StrategyFirstInvariantViolationCodeV1,
} from './strategy-first-invariants-v1';
import { TransactionPlanChangeV1 } from './transaction-plan-diff-v1';
import {
  TransactionPlanInvariantCheckV1,
  TransactionPlanInvariantSummaryV1,
  TransactionPlanInvariantViolationCodeV1,
} from './transaction-plan-invariants-v1';

export interface AdaptiveRecommendationObservabilityLatencyV1 {
  count: number;
  lastMs: number;
  maxMs: number;
  totalMs: number;
}

export interface AdaptiveRecommendationObservabilityCountersV1 {
  evidenceDegradedCount: number;
  evidenceFallbackCount: number;
  finalLegalityFallbackCount: number;
  phaseViolationPreventedCount: number;
  choiceGroupViolationPreventedCount: number;
  flexCapacityUnknownCount: number;
  investmentRulesUnknownCount: number;
  planSwitchCount: number;
  planChurnCount: number;
  sellCount: number;
  replaceCount: number;
  postCommitReplacementCount: number;
  externallyDivergedChoiceStateCount: number;
  transactionPlanSessionSwitchCount: number;
  transactionPlanRevisionCount: number;
  transactionPlanDecisionCount: number;
  transactionPlanPreservedPrefixStepCount: number;
  transactionPlanInsertedStepCount: number;
  transactionPlanCompletedStepCount: number;
  transactionPlanInvalidatedStepCount: number;
  transactionPlanReplacedStepCount: number;
  transactionPlanBlockedStepCount: number;
  transactionPlanUnblockedStepCount: number;
  transactionPlanReplacementPairCount: number;
  transactionPlanValidationFailureCount: number;
  threatWeightedShadowComparisonCount: number;
  threatWeightedShadowFailureCount: number;
  threatWeightedWouldSwitchCount: number;
  threatWeightedBranchDifferenceCount: number;
  threatWeightedWildcardActivationCount: number;
  threatWeightedReplacementActivationCount: number;
  threatWeightedDisagreementCount: number;
  threatWeightedStaleEvidenceFallbackCount: number;
  threatWeightedLowMatchupConfidenceCount: number;
  threatWeightedHardCoreViolationAttemptCount: number;
  threatWeightedInventoryViolationCount: number;
  threatWeightedRejectedReplacementCount: number;
  threatWeightedRejectedReplacementClosestGapMilli: number;
  wpaQueryCount: number;
  wpaQueryLatencyMsTotal: number;
  wpaQueryLatencyMsMax: number;
  wpaIngestCount: number;
  wpaIngestFailureCount: number;
  wpaIngestRowCountTotal: number;
  wpaIngestLatencyMsTotal: number;
}

export interface TransactionPlanProjectedSlotUsageV1 {
  usedByType: AdaptivePlanProjectionV1['usedByType'];
  flexUsed: number;
  unlockedFlexSlots?: number;
  activeItemsUsed: number;
}

export interface TransactionPlanObservabilitySnapshotV1 {
  planSessionId: string;
  revision: number;
  preservedPrefixLength: number;
  insertedStepCount: number;
  completedStepCount: number;
  invalidatedStepCount: number;
  replacedStepCount: number;
  blockedStepCount: number;
  unblockedStepCount: number;
  replacementPairCount: number;
  firstBarrierReason?: string;
  projectedSlotBefore?: TransactionPlanProjectedSlotUsageV1;
  projectedSlotAfter?: TransactionPlanProjectedSlotUsageV1;
  validatorValid: boolean;
  validatorViolationCodes: readonly string[];
}

export interface ThreatWeightedShadowComparisonV1 {
  decisionId: string;
  stateRevision: string;
  currentPlanFingerprint: string;
  challengerPlanFingerprint: string;
  currentNextActionKey: string;
  challengerNextActionKey: string;
  nextItemDifference: boolean;
  branchDifference: boolean;
  wildcardActivation: boolean;
  replacementActivation: boolean;
  sellSource?: number;
  matchupConfidence?: number;
  matchupCoverage?: number;
  utilityImprovement: number;
  wouldSwitch: boolean;
  reasonCodes: readonly string[];
}

export interface WpaIngestObservationV1 {
  dataset: 'VS_HERO_WPA';
  durationMs: number;
  rowCount: number;
  failure?: string;
}

export interface AdaptiveRecommendationObservabilityStatusV1 {
  updatedAt: string;
  plannerLatencyMs: AdaptiveRecommendationObservabilityLatencyV1;
  counters: AdaptiveRecommendationObservabilityCountersV1;
  strategyFirstRelease: StrategyFirstInvariantSummaryV1;
  transactionPlanRelease: TransactionPlanInvariantSummaryV1;
  latestTransactionPlan?: TransactionPlanObservabilitySnapshotV1;
  latestThreatWeightedShadow?: ThreatWeightedShadowComparisonV1;
  latestWpaIngest?: WpaIngestObservationV1;
  reasonCodeCounts: Record<string, number>;
}

export interface AdaptiveRecommendationOutcomeV1 {
  evidence: StatlockerEvidenceBundleV1;
  decision: AdaptiveDecisionStateV1;
  previousResult?: Pick<AdaptiveRecommendationResultV1, 'nextAction' | 'nextTargetItemId' | 'recommendedBuild' | 'planSession'>;
  result: AdaptiveRecommendationResultV1;
  plannerLatencyMs?: number;
  legalityFallback?: boolean;
  legalityFallbackReasonCodes?: readonly string[];
}

export interface RecordTransactionPlanOutcomeV1Input {
  previous?: AdaptivePlanSessionV1;
  current: AdaptivePlanSessionV1;
  changes: readonly TransactionPlanChangeV1[];
  validation: {
    valid: boolean;
    violations: readonly {
      code: string;
      reasonCodes: readonly string[];
    }[];
  };
}

const RELEASE_CODES: readonly StrategyFirstInvariantViolationCodeV1[] = [
  'ILLEGAL_NEXT_ACTION',
  'SLOT_STATE_INVALID',
  'UNREACHABLE_PLAN',
  'REDUNDANT_ANCESTOR_IN_PLAN',
  'FALSE_BUILD_COMPLETE',
  'MANDATORY_GOAL_LOST',
  'BRANCH_CONTRADICTION',
  'UNEXPECTED_COMMITTED_STRATEGY_SWITCH',
  'CORE_WITHOUT_EXIT_SLOT',
  'UNEXPLAINED_SITUATIONAL',
  'NEXT_ACTION_BUILD_MISMATCH',
];

const TRANSACTION_RELEASE_CODES: readonly TransactionPlanInvariantViolationCodeV1[] = [
  'FUTURE_TARGET_WITHOUT_STEP',
  'PROJECTED_SLOT_VIOLATION',
  'REPLACE_WITHOUT_VALIDATED_BUY',
  'NEXT_STEP_MISMATCH',
  'NEXT_NOT_EXECUTABLE',
  'UNKNOWN_SLOT_PATH',
  'COMPATIBILITY_PROJECTION_DIVERGENCE',
];

@Injectable()
export class AdaptiveRecommendationObservabilityV1Service {
  private readonly logger = new Logger(AdaptiveRecommendationObservabilityV1Service.name);
  private readonly invariantViolationDecisionCounts = new Map<StrategyFirstInvariantViolationCodeV1, number>();
  private readonly transactionInvariantViolationDecisionCounts = new Map<TransactionPlanInvariantViolationCodeV1, number>();
  private evaluatedStrategyDecisions = 0;
  private evaluatedTransactionPlanDecisions = 0;
  private latestTransactionPlan?: TransactionPlanObservabilitySnapshotV1;
  private latestThreatWeightedShadow?: ThreatWeightedShadowComparisonV1;
  private latestWpaIngest?: WpaIngestObservationV1;
  private readonly status = {
    updatedAt: new Date(0).toISOString(),
    plannerLatencyMs: {
      count: 0,
      lastMs: 0,
      maxMs: 0,
      totalMs: 0,
    },
    counters: {
      evidenceDegradedCount: 0,
      evidenceFallbackCount: 0,
      finalLegalityFallbackCount: 0,
      phaseViolationPreventedCount: 0,
      choiceGroupViolationPreventedCount: 0,
      flexCapacityUnknownCount: 0,
      investmentRulesUnknownCount: 0,
      planSwitchCount: 0,
      planChurnCount: 0,
      sellCount: 0,
      replaceCount: 0,
      postCommitReplacementCount: 0,
      externallyDivergedChoiceStateCount: 0,
      transactionPlanSessionSwitchCount: 0,
      transactionPlanRevisionCount: 0,
      transactionPlanDecisionCount: 0,
      transactionPlanPreservedPrefixStepCount: 0,
      transactionPlanInsertedStepCount: 0,
      transactionPlanCompletedStepCount: 0,
      transactionPlanInvalidatedStepCount: 0,
      transactionPlanReplacedStepCount: 0,
      transactionPlanBlockedStepCount: 0,
      transactionPlanUnblockedStepCount: 0,
      transactionPlanReplacementPairCount: 0,
      transactionPlanValidationFailureCount: 0,
      threatWeightedShadowComparisonCount: 0,
      threatWeightedShadowFailureCount: 0,
      threatWeightedWouldSwitchCount: 0,
      threatWeightedBranchDifferenceCount: 0,
      threatWeightedWildcardActivationCount: 0,
      threatWeightedReplacementActivationCount: 0,
      threatWeightedDisagreementCount: 0,
      threatWeightedStaleEvidenceFallbackCount: 0,
      threatWeightedLowMatchupConfidenceCount: 0,
      threatWeightedHardCoreViolationAttemptCount: 0,
      threatWeightedInventoryViolationCount: 0,
      threatWeightedRejectedReplacementCount: 0,
      threatWeightedRejectedReplacementClosestGapMilli: 0,
      wpaQueryCount: 0,
      wpaQueryLatencyMsTotal: 0,
      wpaQueryLatencyMsMax: 0,
      wpaIngestCount: 0,
      wpaIngestFailureCount: 0,
      wpaIngestRowCountTotal: 0,
      wpaIngestLatencyMsTotal: 0,
    } satisfies AdaptiveRecommendationObservabilityCountersV1,
    reasonCodeCounts: {} as Record<string, number>,
  };

  recordDecisionState(decision: Partial<Pick<AdaptiveDecisionStateV1, 'slots' | 'investment'>>): void {
    const slots = decision.slots;
    const investment = decision.investment;
    if (slots && (slots.evidence === 'UNKNOWN' || slots.unlockedFlexSlots === undefined)) {
      this.status.counters.flexCapacityUnknownCount += 1;
    }
    if (investment && investment.evidence === 'UNKNOWN') {
      this.status.counters.investmentRulesUnknownCount += 1;
    }
    this.touch();
  }

  recordEvidence(bundle: Pick<StatlockerEvidenceBundleV1, 'usable' | 'degradedReasons'>): void {
    if (bundle.degradedReasons.length > 0) this.status.counters.evidenceDegradedCount += 1;
    if (!bundle.usable) this.status.counters.evidenceFallbackCount += 1;
    this.recordReasonCodes(bundle.degradedReasons);
    this.touch();
  }

  recordPlannerLatency(latencyMs: number): void {
    const normalized = Number.isFinite(latencyMs) ? Math.max(0, Math.floor(latencyMs)) : 0;
    this.status.plannerLatencyMs.count += 1;
    this.status.plannerLatencyMs.lastMs = normalized;
    this.status.plannerLatencyMs.totalMs += normalized;
    this.status.plannerLatencyMs.maxMs = Math.max(this.status.plannerLatencyMs.maxMs, normalized);
    this.touch();
  }

  recordPhaseViolationPrevented(): void {
    this.status.counters.phaseViolationPreventedCount += 1;
    this.touch();
  }

  recordChoiceGroupViolationPrevented(): void {
    this.status.counters.choiceGroupViolationPreventedCount += 1;
    this.touch();
  }

  recordExternallyDivergedChoiceState(): void {
    this.status.counters.externallyDivergedChoiceStateCount += 1;
    this.touch();
  }

  recordPostCommitReplacement(): void {
    this.status.counters.postCommitReplacementCount += 1;
    this.touch();
  }

  recordStrategyInvariantCheck(check: StrategyFirstInvariantCheckV1): void {
    this.evaluatedStrategyDecisions += 1;
    const codes = new Set(check.violations.map((violation) => violation.code));
    if (codes.has('MANDATORY_GOAL_LOST') || codes.has('CORE_WITHOUT_EXIT_SLOT')) {
      this.status.counters.threatWeightedHardCoreViolationAttemptCount += 1;
    }
    for (const code of codes) {
      this.invariantViolationDecisionCounts.set(code, (this.invariantViolationDecisionCounts.get(code) ?? 0) + 1);
    }
    this.recordReasonCodes([...codes].map((code) => `STRATEGY_INVARIANT:${code}`));
    this.touch();
  }

  recordTransactionPlanInvariantCheck(check: TransactionPlanInvariantCheckV1): void {
    this.evaluatedTransactionPlanDecisions += 1;
    const codes = new Set(check.violations.map((violation) => violation.code));
    if (codes.has('PROJECTED_SLOT_VIOLATION')) {
      this.status.counters.threatWeightedInventoryViolationCount += 1;
    }
    for (const code of codes) {
      this.transactionInvariantViolationDecisionCounts.set(
        code,
        (this.transactionInvariantViolationDecisionCounts.get(code) ?? 0) + 1,
      );
    }
    this.recordReasonCodes([...codes].map((code) => `TRANSACTION_PLAN_INVARIANT:${code}`));
    this.touch();
  }

  recordTransactionPlanOutcome(input: RecordTransactionPlanOutcomeV1Input): void {
    const preservedPrefixLength = transactionPlanPreservedPrefixLength(input.previous, input.current);
    const count = (type: TransactionPlanChangeV1['type']): number =>
      input.changes.filter((change) => change.type === type).length;
    const insertedStepCount = count('INSERT_STEP');
    const completedStepCount = count('COMPLETE_STEP');
    const invalidatedStepCount = count('INVALIDATE_STEP');
    const replacedStepCount = count('REPLACE_STEP');
    const blockedStepCount = count('BLOCK_STEP');
    const unblockedStepCount = count('UNBLOCK_STEP');
    const replacementPairCount = input.current.steps.filter((step) =>
      step.kind === 'TRANSACTION' && step.action?.type === 'SELL_AND_BUY',
    ).length;
    const firstBarrier = input.current.steps.find((step) => step.kind === 'BARRIER' && step.barrier);
    const firstTransaction = input.current.steps.find((step) => step.kind === 'TRANSACTION' && step.action);

    this.status.counters.transactionPlanDecisionCount += 1;
    this.status.counters.transactionPlanPreservedPrefixStepCount += preservedPrefixLength;
    this.status.counters.transactionPlanInsertedStepCount += insertedStepCount;
    this.status.counters.transactionPlanCompletedStepCount += completedStepCount;
    this.status.counters.transactionPlanInvalidatedStepCount += invalidatedStepCount;
    this.status.counters.transactionPlanReplacedStepCount += replacedStepCount;
    this.status.counters.transactionPlanBlockedStepCount += blockedStepCount;
    this.status.counters.transactionPlanUnblockedStepCount += unblockedStepCount;
    this.status.counters.transactionPlanReplacementPairCount += replacementPairCount;
    if (!input.validation.valid) this.status.counters.transactionPlanValidationFailureCount += 1;

    const validatorViolationCodes = [...new Set(input.validation.violations.map((violation) => violation.code))].sort();
    this.latestTransactionPlan = {
      planSessionId: input.current.planSessionId,
      revision: input.current.revision,
      preservedPrefixLength,
      insertedStepCount,
      completedStepCount,
      invalidatedStepCount,
      replacedStepCount,
      blockedStepCount,
      unblockedStepCount,
      replacementPairCount,
      firstBarrierReason: firstBarrier
        ? firstBarrier.blockingReasons[0] ?? firstBarrier.barrier?.type ?? firstBarrier.reasonCodes[0]
        : undefined,
      projectedSlotBefore: firstTransaction
        ? projectedSlotUsage(firstTransaction.projectedBefore)
        : undefined,
      projectedSlotAfter: firstTransaction?.projectedAfter
        ? projectedSlotUsage(firstTransaction.projectedAfter)
        : undefined,
      validatorValid: input.validation.valid,
      validatorViolationCodes,
    };
    this.recordReasonCodes(validatorViolationCodes.map((code) => `TRANSACTION_PLAN_VALIDATOR:${code}`));
    if (this.latestTransactionPlan.firstBarrierReason) {
      this.recordReasonCodes([`TRANSACTION_BARRIER:${this.latestTransactionPlan.firstBarrierReason}`]);
    }
    this.touch();
  }

  recordRecommendationOutcome(outcome: AdaptiveRecommendationOutcomeV1): void {
    if (outcome.result.nextAction.type === 'SELL') this.status.counters.sellCount += 1;
    if (outcome.result.nextAction.type === 'REPLACE') this.status.counters.replaceCount += 1;

    if (outcome.legalityFallback) {
      this.status.counters.finalLegalityFallbackCount += 1;
      this.recordReasonCodes(outcome.legalityFallbackReasonCodes ?? []);
    }

    if (outcome.previousResult) {
      if (
        !sameAction(outcome.previousResult.nextAction, outcome.result.nextAction) ||
        outcome.previousResult.nextTargetItemId !== outcome.result.nextTargetItemId
      ) {
        this.status.counters.planSwitchCount += 1;
      }
      if (outcome.previousResult.planSession && outcome.result.planSession) {
        if (outcome.previousResult.planSession.planSessionId !== outcome.result.planSession.planSessionId) {
          this.status.counters.transactionPlanSessionSwitchCount += 1;
        }
        if (outcome.previousResult.planSession.revision !== outcome.result.planSession.revision) {
          this.status.counters.transactionPlanRevisionCount += 1;
        }
        if (!samePlanSession(outcome.previousResult.planSession, outcome.result.planSession)) {
          this.status.counters.planChurnCount += 1;
        }
      } else if (!sameBuild(outcome.previousResult.recommendedBuild, outcome.result.recommendedBuild)) {
        this.status.counters.planChurnCount += 1;
      }
    }

    this.recordReasonCodes(outcome.result.nextAction.reasonCodes ?? []);
    this.touch();
    this.logger.debug(
      `adaptive-observability ${JSON.stringify({
        plannerLatencyMs: outcome.plannerLatencyMs,
        evidenceUsable: outcome.evidence.usable,
        nextActionType: outcome.result.nextAction.type,
        legalityFallback: outcome.legalityFallback ?? false,
        planSessionId: outcome.result.planSession?.planSessionId,
        planRevision: outcome.result.planSession?.revision,
      })}`,
    );
  }

  recordThreatWeightedShadowComparison(
    comparison: ThreatWeightedShadowComparisonV1,
  ): void {
    this.status.counters.threatWeightedShadowComparisonCount += 1;
    if (comparison.wouldSwitch) this.status.counters.threatWeightedWouldSwitchCount += 1;
    if (comparison.branchDifference) this.status.counters.threatWeightedBranchDifferenceCount += 1;
    if (comparison.wildcardActivation) this.status.counters.threatWeightedWildcardActivationCount += 1;
    if (comparison.replacementActivation) this.status.counters.threatWeightedReplacementActivationCount += 1;
    if (comparison.currentPlanFingerprint !== comparison.challengerPlanFingerprint) {
      this.status.counters.threatWeightedDisagreementCount += 1;
    }
    if ((comparison.matchupConfidence ?? 1) < 0.4) {
      this.status.counters.threatWeightedLowMatchupConfidenceCount += 1;
    }
    this.latestThreatWeightedShadow = { ...comparison, reasonCodes: comparison.reasonCodes.slice(0, 12) };
    this.recordReasonCodes(comparison.reasonCodes.slice(0, 12));
    this.touch();
    this.logger.debug(`threat-weighted-shadow ${JSON.stringify(this.latestThreatWeightedShadow)}`);
  }

  recordThreatWeightedShadowFailure(decisionId: string, error: unknown): void {
    this.status.counters.threatWeightedShadowFailureCount += 1;
    this.touch();
    this.logger.debug(`threat-weighted-shadow-failure ${JSON.stringify({
      decisionId,
      error: error instanceof Error ? error.message : String(error),
    })}`);
  }

  recordThreatWeightedStaleEvidenceFallback(): void {
    this.status.counters.threatWeightedStaleEvidenceFallbackCount += 1;
    this.touch();
  }

  /**
   * Calibration input for threshold tuning: how many whole-build replacements were
   * rejected, and how close the closest rejection came to its required threshold
   * (gap in thousandths, so a 0.011 gap under a 0.20 threshold is recorded as 11).
   */
  recordRejectedReplacementObservations(
    observations: readonly { netImprovement: number; requiredThreshold: number }[],
  ): void {
    for (const observation of observations) {
      const gap = observation.requiredThreshold - observation.netImprovement;
      if (!Number.isFinite(gap) || gap < 0) continue;
      this.status.counters.threatWeightedRejectedReplacementCount += 1;
      const gapMilli = Math.round(gap * 1000);
      if (this.status.counters.threatWeightedRejectedReplacementClosestGapMilli === 0 ||
        gapMilli < this.status.counters.threatWeightedRejectedReplacementClosestGapMilli) {
        this.status.counters.threatWeightedRejectedReplacementClosestGapMilli = gapMilli;
      }
    }
    this.touch();
  }

  recordWpaQueryLatency(durationMs: number): void {
    const bounded = Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0;
    this.status.counters.wpaQueryCount += 1;
    this.status.counters.wpaQueryLatencyMsTotal += bounded;
    this.status.counters.wpaQueryLatencyMsMax = Math.max(this.status.counters.wpaQueryLatencyMsMax, bounded);
  }

  recordWpaIngestOutcome(observation: WpaIngestObservationV1): void {
    const bounded = Number.isFinite(observation.durationMs) ? Math.max(0, observation.durationMs) : 0;
    this.status.counters.wpaIngestCount += 1;
    this.status.counters.wpaIngestLatencyMsTotal += bounded;
    this.status.counters.wpaIngestRowCountTotal += Number.isInteger(observation.rowCount) ? observation.rowCount : 0;
    if (observation.failure) this.status.counters.wpaIngestFailureCount += 1;
    this.latestWpaIngest = {
      dataset: observation.dataset,
      durationMs: bounded,
      rowCount: observation.rowCount,
      ...(observation.failure ? { failure: observation.failure.slice(0, 200) } : {}),
    };
    this.touch();
  }

  getStatus(): AdaptiveRecommendationObservabilityStatusV1 {
    return {
      updatedAt: this.status.updatedAt,
      plannerLatencyMs: { ...this.status.plannerLatencyMs },
      counters: { ...this.status.counters },
      strategyFirstRelease: this.strategyFirstReleaseSummary(),
      transactionPlanRelease: this.transactionPlanReleaseSummary(),
      latestTransactionPlan: this.latestTransactionPlan
        ? cloneTransactionSnapshot(this.latestTransactionPlan)
        : undefined,
      latestThreatWeightedShadow: this.latestThreatWeightedShadow
        ? { ...this.latestThreatWeightedShadow }
        : undefined,
      latestWpaIngest: this.latestWpaIngest ? { ...this.latestWpaIngest } : undefined,
      reasonCodeCounts: { ...this.status.reasonCodeCounts },
    };
  }

  private strategyFirstReleaseSummary(): StrategyFirstInvariantSummaryV1 {
    const rate = (code: StrategyFirstInvariantViolationCodeV1): number => {
      if (this.evaluatedStrategyDecisions === 0) return 0;
      return (this.invariantViolationDecisionCounts.get(code) ?? 0) / this.evaluatedStrategyDecisions;
    };
    for (const code of RELEASE_CODES) {
      if (!this.invariantViolationDecisionCounts.has(code)) this.invariantViolationDecisionCounts.set(code, 0);
    }
    return {
      evaluatedDecisions: this.evaluatedStrategyDecisions,
      illegalActionRate: rate('ILLEGAL_NEXT_ACTION'),
      slotViolationRate: rate('SLOT_STATE_INVALID'),
      unreachablePlanRate: rate('UNREACHABLE_PLAN'),
      redundantAncestorRate: rate('REDUNDANT_ANCESTOR_IN_PLAN'),
      falseBuildCompleteRate: rate('FALSE_BUILD_COMPLETE'),
      mandatoryGoalLostRate: rate('MANDATORY_GOAL_LOST'),
      branchContradictionRate: rate('BRANCH_CONTRADICTION'),
      archetypeUnexpectedSwitchRate: rate('UNEXPECTED_COMMITTED_STRATEGY_SWITCH'),
      coreWithoutExitSlotRate: rate('CORE_WITHOUT_EXIT_SLOT'),
      unexplainedSituationalRate: rate('UNEXPLAINED_SITUATIONAL'),
      nextActionBuildMismatchRate: rate('NEXT_ACTION_BUILD_MISMATCH'),
    };
  }

  private transactionPlanReleaseSummary(): TransactionPlanInvariantSummaryV1 {
    const rate = (code: TransactionPlanInvariantViolationCodeV1): number => {
      if (this.evaluatedTransactionPlanDecisions === 0) return 0;
      return (this.transactionInvariantViolationDecisionCounts.get(code) ?? 0) /
        this.evaluatedTransactionPlanDecisions;
    };
    for (const code of TRANSACTION_RELEASE_CODES) {
      if (!this.transactionInvariantViolationDecisionCounts.has(code)) {
        this.transactionInvariantViolationDecisionCounts.set(code, 0);
      }
    }
    return {
      evaluatedDecisions: this.evaluatedTransactionPlanDecisions,
      futureTargetWithoutStepRate: rate('FUTURE_TARGET_WITHOUT_STEP'),
      projectedSlotViolationRate: rate('PROJECTED_SLOT_VIOLATION'),
      replaceWithoutValidatedBuyRate: rate('REPLACE_WITHOUT_VALIDATED_BUY'),
      nextStepMismatchRate: rate('NEXT_STEP_MISMATCH'),
      nextNotExecutableRate: rate('NEXT_NOT_EXECUTABLE'),
      unknownSlotPathRate: rate('UNKNOWN_SLOT_PATH'),
      compatibilityProjectionDivergenceRate: rate('COMPATIBILITY_PROJECTION_DIVERGENCE'),
    };
  }

  private recordReasonCodes(reasonCodes: readonly string[]): void {
    for (const reasonCode of new Set(reasonCodes)) {
      this.status.reasonCodeCounts[reasonCode] = (this.status.reasonCodeCounts[reasonCode] ?? 0) + 1;
    }
  }

  private touch(): void {
    this.status.updatedAt = new Date().toISOString();
  }
}

function transactionPlanPreservedPrefixLength(
  previous: AdaptivePlanSessionV1 | undefined,
  current: AdaptivePlanSessionV1,
): number {
  if (!previous || previous.strategyId !== current.strategyId) return 0;
  let index = 0;
  while (index < previous.steps.length && index < current.steps.length) {
    if (previous.steps[index]?.stepId !== current.steps[index]?.stepId) break;
    index += 1;
  }
  return index;
}

function projectedSlotUsage(projection: AdaptivePlanProjectionV1): TransactionPlanProjectedSlotUsageV1 {
  return {
    usedByType: { ...projection.usedByType },
    flexUsed: projection.flexUsed,
    unlockedFlexSlots: projection.unlockedFlexSlots,
    activeItemsUsed: projection.activeItemsUsed,
  };
}

function cloneTransactionSnapshot(
  snapshot: TransactionPlanObservabilitySnapshotV1,
): TransactionPlanObservabilitySnapshotV1 {
  return {
    ...snapshot,
    projectedSlotBefore: snapshot.projectedSlotBefore
      ? { ...snapshot.projectedSlotBefore, usedByType: { ...snapshot.projectedSlotBefore.usedByType } }
      : undefined,
    projectedSlotAfter: snapshot.projectedSlotAfter
      ? { ...snapshot.projectedSlotAfter, usedByType: { ...snapshot.projectedSlotAfter.usedByType } }
      : undefined,
    validatorViolationCodes: [...snapshot.validatorViolationCodes],
  };
}

function sameAction(
  a: Pick<AdaptiveRecommendationResultV1['nextAction'], 'actionKey' | 'type' | 'targetItemId'>,
  b: Pick<AdaptiveRecommendationResultV1['nextAction'], 'actionKey' | 'type' | 'targetItemId'>,
): boolean {
  return a.actionKey === b.actionKey && a.type === b.type && a.targetItemId === b.targetItemId;
}

function sameBuild(
  a: AdaptiveRecommendationResultV1['recommendedBuild'],
  b: AdaptiveRecommendationResultV1['recommendedBuild'],
): boolean {
  if (a.length !== b.length) return false;
  return a.every((item, index) =>
    item.itemId === b[index]?.itemId &&
    item.position === b[index]?.position &&
    item.status === b[index]?.status,
  );
}

function samePlanSession(
  a: NonNullable<AdaptiveRecommendationResultV1['planSession']>,
  b: NonNullable<AdaptiveRecommendationResultV1['planSession']>,
): boolean {
  if (a.planSessionId !== b.planSessionId || a.state !== b.state || a.nextStepId !== b.nextStepId) return false;
  if (a.steps.length !== b.steps.length) return false;
  return a.steps.every((step, index) => {
    const other = b.steps[index];
    if (!other) return false;
    return step.stepId === other.stepId && step.state === other.state;
  });
}
