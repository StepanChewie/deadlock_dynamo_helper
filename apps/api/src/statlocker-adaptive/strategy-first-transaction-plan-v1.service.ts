import { Injectable } from '@nestjs/common';
import {
  RecommendationCandidate,
  generateRecommendationCandidates,
} from '@deadlock-live-probe/build-domain';
import {
  AdaptivePlanSessionV1,
  AdaptivePlannedItemV1,
} from '@deadlock-live-probe/shared';
import { AdaptiveDecisionStateV1 } from './adaptive-decision-state-v1.service';
import { candidateGeneratorRulesFromSlotStateV1 } from './adaptive-economy-v1';
import { StrategyFirstBuildPlannerV1Result } from './strategy-first-build-planner-v1.service';
import { TransactionPlanCompilerV1Service } from './transaction-plan-compiler-v1.service';
import { TransactionPlanReconcilerV1Service } from './transaction-plan-reconciler-v1.service';
import {
  nextActionFromPlanSessionV1,
  recommendedBuildFromPlanSessionV1,
} from './transaction-plan-projection-v1';
import {
  TransactionPlanValidationV1,
  TransactionPlanValidatorV1Service,
} from './transaction-plan-validator-v1.service';

export type StrategyFirstTransactionPlanResultV1 = StrategyFirstBuildPlannerV1Result & {
  planSession: AdaptivePlanSessionV1;
  transactionPlanValidation: TransactionPlanValidationV1;
};

export interface StrategyFirstTransactionPlanV1Input {
  result: StrategyFirstBuildPlannerV1Result;
  decision: AdaptiveDecisionStateV1;
  previousPlanSession?: AdaptivePlanSessionV1;
  recentPurchasedItemIds?: readonly number[];
}

@Injectable()
export class StrategyFirstTransactionPlanV1Service {
  private readonly compiler = new TransactionPlanCompilerV1Service();
  private readonly reconciler = new TransactionPlanReconcilerV1Service();
  private readonly validator = new TransactionPlanValidatorV1Service();

  apply(input: StrategyFirstTransactionPlanV1Input): StrategyFirstTransactionPlanResultV1 {
    if (input.result.contract.status === 'COMPLETE') {
      const session = this.reconciler.reconcile({
        previous: input.previousPlanSession,
        strategyId: input.result.strategy.strategyId,
        gameTimeSec: input.decision.state.gameTimeSec,
        proposedSteps: [],
        proposedReachable: true,
        decision: input.decision,
      });
      const transactionPlanValidation = this.validator.validate({ session, decision: input.decision });
      return {
        ...input.result,
        planSession: session,
        transactionPlanValidation,
        nextAction: nextActionFromPlanSessionV1(session),
        recommendedBuild: overlayTransactionStateOnSemanticBuild(
          input.result.recommendedBuild,
          session,
          input.decision,
        ),
      };
    }

    const selectedCandidate = matchingCurrentCandidate(input.result, input.decision);
    let compiled = this.compiler.compile({
      strategy: input.result.strategy,
      contract: input.result.contract,
      slotPlan: input.result.strategyPlan.slotPlan,
      decision: input.decision,
      selectedCandidates: selectedCandidate ? [selectedCandidate] : [],
      recentPurchasedItemIds: input.recentPurchasedItemIds,
    });
    // A situational decision that cannot be compiled into a replayable transaction
    // (for example a sell-driven wildcard replacement that would strand an unmet hard
    // goal without an exit slot) falls back to the strategy-goal transaction path
    // instead of discarding a viable legal plan. Fail-closed semantics still apply to
    // the retry result.
    let effectiveContract = input.result.contract;
    if (!compiled.reachable && input.result.contract.activeSituationalDecision) {
      effectiveContract = {
        ...input.result.contract,
        activeSituationalDecision: undefined,
      };
      compiled = this.compiler.compile({
        strategy: input.result.strategy,
        contract: effectiveContract,
        slotPlan: input.result.strategyPlan.slotPlan,
        decision: input.decision,
        selectedCandidates: [],
        recentPurchasedItemIds: input.recentPurchasedItemIds,
      });
    }
    let session = this.reconciler.reconcile({
      previous: input.previousPlanSession,
      strategyId: input.result.strategy.strategyId,
      gameTimeSec: input.decision.state.gameTimeSec,
      proposedSteps: compiled.steps,
      proposedReachable: compiled.reachable,
      decision: input.decision,
    });
    const transactionPlanValidation: TransactionPlanValidationV1 = compiled.reachable
      ? this.validator.validate({ session, decision: input.decision })
      : {
          valid: false,
          violations: [{
            code: 'TRANSACTION_PATH_UNREACHABLE',
            reasonCodes: compiled.reasonCodes,
          }],
        };

    if (!compiled.reachable || !transactionPlanValidation.valid) {
      const validationReasons = transactionPlanValidation.violations.flatMap((violation) => [
        `PLAN_VALIDATION:${violation.code}`,
        ...violation.reasonCodes,
      ]);
      session = {
        ...session,
        state: 'REPLAN_REQUIRED',
        nextStepId: undefined,
        reasonCodes: unique([
          ...session.reasonCodes,
          ...compiled.reasonCodes,
          ...validationReasons,
          'TRANSACTION_PLAN_FAIL_CLOSED',
        ]),
      };
      return failClosed(input.result, input.decision, session, transactionPlanValidation);
    }

    const effectiveStatus = session.state === 'WAITING'
      ? 'WAITING' as const
      : session.state === 'REPLAN_REQUIRED'
        ? 'REPLAN_REQUIRED' as const
        : input.result.contract.status;
    const contract = effectiveStatus === input.result.contract.status
      ? effectiveContract
      : {
          ...effectiveContract,
          status: effectiveStatus,
          completionReasonCodes: unique([
            ...effectiveContract.completionReasonCodes,
            ...(effectiveStatus === 'WAITING' ? ['TRANSACTION_PLAN_WAITING'] : []),
          ]),
        };
    const strategyPlan = {
      ...input.result.strategyPlan,
      buildStatus: contract.status,
    };
    return {
      ...input.result,
      contract,
      strategyPlan,
      planSession: session,
      transactionPlanValidation,
      nextAction: nextActionFromPlanSessionV1(session),
      recommendedBuild: overlayTransactionStateOnSemanticBuild(
        input.result.recommendedBuild,
        session,
        input.decision,
      ),
    };
  }
}

function matchingCurrentCandidate(
  result: StrategyFirstBuildPlannerV1Result,
  decision: AdaptiveDecisionStateV1,
): RecommendationCandidate | undefined {
  const candidates = generateRecommendationCandidates({
    state: decision.state,
    itemGraph: decision.itemGraph,
    rules: candidateGeneratorRulesFromSlotStateV1(decision.slots, {
      allowSellOnlyActions: true,
      generateTargetedWaitActions: true,
    }),
  });
  const action = result.nextAction;
  return candidates.find((candidate) => {
    const raw = candidate.action;
    if (action.type === 'BUY') {
      return raw.type === 'BUY_ITEM' && raw.itemId === (action.buyItemId ?? action.itemId ?? action.targetItemId);
    }
    if (action.type === 'UPGRADE') {
      return raw.type === 'UPGRADE_ITEM' && raw.itemId === (action.buyItemId ?? action.itemId ?? action.targetItemId);
    }
    if (action.type === 'SELL') {
      return raw.type === 'SELL_ITEM' && raw.itemId === (action.sellItemId ?? action.itemId);
    }
    if (action.type === 'REPLACE') {
      return raw.type === 'REPLACE_ITEM' &&
        raw.sellItemId === action.sellItemId &&
        raw.buyItemId === (action.buyItemId ?? action.targetItemId);
    }
    return false;
  });
}

function failClosed(
  result: StrategyFirstBuildPlannerV1Result,
  decision: AdaptiveDecisionStateV1,
  session: AdaptivePlanSessionV1,
  transactionPlanValidation: TransactionPlanValidationV1,
): StrategyFirstTransactionPlanResultV1 {
  const completionReasonCodes = unique([
    ...result.contract.completionReasonCodes,
    ...session.reasonCodes,
    'TRANSACTION_PLAN_FAIL_CLOSED',
  ]);
  return {
    ...result,
    contract: {
      ...result.contract,
      status: 'REPLAN_REQUIRED',
      completionReasonCodes,
    },
    strategyPlan: {
      ...result.strategyPlan,
      buildStatus: 'REPLAN_REQUIRED',
    },
    planSession: session,
    transactionPlanValidation,
    nextAction: {
      actionKey: 'HOLD',
      type: 'HOLD',
      reasonCodes: ['TRANSACTION_PLAN_FAIL_CLOSED', ...session.reasonCodes],
    },
    recommendedBuild: overlayTransactionStateOnSemanticBuild(
      result.recommendedBuild,
      session,
      decision,
    ),
    rankedImmediateCandidates: [],
    totalScore: 0,
    confidence: 0,
  };
}

function overlayTransactionStateOnSemanticBuild(
  semanticBuild: readonly AdaptivePlannedItemV1[],
  session: AdaptivePlanSessionV1,
  decision: AdaptiveDecisionStateV1,
): readonly AdaptivePlannedItemV1[] {
  const ownedItemIds = heldIds(decision);
  const owned = new Set(ownedItemIds);
  const transactionProjection = recommendedBuildFromPlanSessionV1({
    session,
    ownedItemIds,
  });
  const nextTransactionRow = session.state === 'ACTIVE'
    ? transactionProjection.find((row) => row.status === 'NEXT')
    : undefined;
  const preserveSemanticNext = session.state === 'WAITING';
  const rows: AdaptivePlannedItemV1[] = semanticBuild.map((row) => ({
    ...row,
    status: owned.has(row.itemId)
      ? 'OWNED'
      : nextTransactionRow?.itemId === row.itemId
        ? 'NEXT'
        : preserveSemanticNext && row.status === 'NEXT'
          ? 'NEXT'
          : 'PLANNED',
  }));

  if (nextTransactionRow && !rows.some((row) => row.itemId === nextTransactionRow.itemId)) {
    rows.push({
      ...nextTransactionRow,
      position: rows.length + 1,
    });
  }

  return rows;
}

function heldIds(decision: AdaptiveDecisionStateV1): number[] {
  return [...decision.state.inventory.heldByItemId.keys()].sort((a, b) => a - b);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}
