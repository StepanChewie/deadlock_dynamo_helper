import type {
  AdaptiveActionV1,
  AdaptiveDecisionTraceCandidateV1,
  AdaptiveDecisionTraceV1,
  AdaptiveRecommendationResultV1,
} from '@deadlock-live-probe/shared';
import { ADAPTIVE_ITEM_CATALOG } from './generated/adaptive-item-catalog';

export interface AdaptiveDecisionDebugRow {
  readonly key: string;
  readonly headline: string;
  readonly selected: boolean;
  readonly reason?: string;
  readonly source?: string;
  readonly score?: number;
  readonly confidence?: number;
  readonly details: readonly AdaptiveDecisionDebugValue[];
}

export interface AdaptiveDecisionDebugValue {
  readonly label: string;
  readonly value: string;
}

export interface AdaptiveDecisionDebugSection {
  readonly title: 'Было' | 'Рассматривали' | 'Выбрали' | 'Откинули';
  readonly rows: readonly AdaptiveDecisionDebugRow[];
}

export interface AdaptiveDecisionDebugReplacement {
  readonly headline: string;
  readonly inventory: string;
  readonly utilityBefore: number;
  readonly utilityAfter: number;
  readonly rawImprovement: number;
  readonly matchupGain: number;
  readonly skeletonDelta: number;
  readonly synergyDelta: number;
  readonly timingDelta: number;
  readonly economicLoss: number;
  readonly transactionPenalty: number;
  readonly churnPenalty: number;
  readonly netImprovement: number;
  readonly requiredThreshold: number;
  readonly verdict: 'ACCEPT' | 'REJECT';
  readonly reasonCodes: readonly string[];
}

export interface AdaptiveDecisionDebugPolicy {
  readonly version: string;
  readonly heldItemCapacity: number;
  readonly threatWeights: AdaptiveDecisionTraceV1['policy']['threatWeights'];
  readonly threatClamp: AdaptiveDecisionTraceV1['policy']['threatClamp'];
  readonly shrinkK: AdaptiveDecisionTraceV1['policy']['shrinkK'];
  readonly planSwitchThreshold: number;
  readonly sellBuyThreshold: number;
  readonly softCoreReplaceThreshold: number;
  readonly wildcardReplaceThreshold: number;
  readonly matchupConfidenceThreshold: number;
  readonly recentPurchaseProtectionMs: number;
  readonly soldItemRebuyPenaltyMs: number;
}

export interface AdaptiveDecisionDebugPresentation {
  readonly visible: boolean;
  readonly sections: readonly AdaptiveDecisionDebugSection[];
  readonly replacements: readonly AdaptiveDecisionDebugReplacement[];
  readonly policy?: AdaptiveDecisionDebugPolicy;
}

export function buildAdaptiveDecisionDebugPresentation(
  recommendation: AdaptiveRecommendationResultV1,
): AdaptiveDecisionDebugPresentation {
  const trace = recommendation.decisionTrace;
  if (!trace) return { visible: false, sections: [], replacements: [] };

  const baselineRows = trace.baseline.inventoryItemIds.map((itemId) => ({
    key: `baseline:${itemId}`,
    headline: itemName(itemId),
    selected: false,
    details: baselineDetails(itemId, trace),
  }));
  const consideredRows = trace.candidates.map(candidateRow);
  const selectedRows = trace.candidates.filter((candidate) => candidate.selected).map(candidateRow);
  if (selectedRows.length === 0) {
    selectedRows.push(actionRow(trace.finalSelection.action, true, trace.finalSelection.reasonCodes[0]));
  }
  const rejectedRows = trace.candidates
    .filter((candidate) => !candidate.selected)
    .map((candidate) => ({
      ...candidateRow(candidate),
      reason: candidate.rejectionReasonCodes[0] ?? candidate.action.reasonCodes[0] ?? 'NOT_SELECTED',
    }));

  return {
    visible: true,
    sections: [
      { title: 'Было', rows: baselineRows },
      { title: 'Рассматривали', rows: consideredRows },
      { title: 'Выбрали', rows: selectedRows },
      { title: 'Откинули', rows: rejectedRows },
    ],
    replacements: trace.replacements.map((replacement) => ({
      headline: replacementHeadline(replacement.sellItemId, replacement.buyItemId),
      inventory: `${replacement.inventoryCount}/${replacement.maxItemCount}`,
      utilityBefore: replacement.utilityBefore,
      utilityAfter: replacement.utilityAfter,
      rawImprovement: replacement.rawImprovement,
      matchupGain: replacement.matchupGain,
      skeletonDelta: replacement.skeletonDelta,
      synergyDelta: replacement.synergyDelta,
      timingDelta: replacement.timingDelta,
      economicLoss: replacement.economicLoss,
      transactionPenalty: replacement.transactionPenalty,
      churnPenalty: replacement.churnPenalty,
      netImprovement: replacement.netImprovement,
      requiredThreshold: replacement.requiredThreshold,
      verdict: replacement.accepted ? 'ACCEPT' : 'REJECT',
      reasonCodes: [...replacement.reasonCodes],
    })),
    policy: {
      version: trace.policy.policyVersion,
      heldItemCapacity: trace.policy.heldItemCapacity,
      threatWeights: { ...trace.policy.threatWeights },
      threatClamp: { ...trace.policy.threatClamp },
      shrinkK: { ...trace.policy.shrinkK },
      planSwitchThreshold: trace.policy.thresholds.planSwitch,
      sellBuyThreshold: trace.policy.thresholds.sellBuy,
      softCoreReplaceThreshold: trace.policy.thresholds.softCoreReplace,
      wildcardReplaceThreshold: trace.policy.thresholds.wildcardReplace,
      matchupConfidenceThreshold: trace.policy.thresholds.matchupConfidence,
      recentPurchaseProtectionMs: trace.policy.recentPurchaseProtectionMs,
      soldItemRebuyPenaltyMs: trace.policy.soldItemRebuyPenaltyMs,
    },
  };
}

function candidateRow(candidate: AdaptiveDecisionTraceCandidateV1): AdaptiveDecisionDebugRow {
  const details: AdaptiveDecisionDebugValue[] = [];
  if (candidate.score !== undefined) details.push({ label: 'Score', value: numeric(candidate.score) });
  if (candidate.confidence !== undefined) details.push({ label: 'Confidence', value: numeric(candidate.confidence) });
  if (candidate.matchup.score !== undefined) details.push({ label: 'Matchup', value: numeric(candidate.matchup.score) });
  if (candidate.matchup.confidence !== undefined) details.push({ label: 'Matchup confidence', value: numeric(candidate.matchup.confidence) });
  if (candidate.requiredThreshold !== undefined) details.push({ label: 'Threshold', value: numeric(candidate.requiredThreshold) });
  for (const component of candidate.scoreComponents) {
    details.push({
      label: component.key,
      value: `${numeric(component.weighted)} (raw ${numeric(component.raw)}, conf ${numeric(component.confidence)})`,
    });
  }
  for (const reason of candidate.matchup.reasonCodes) details.push({ label: 'Matchup reason', value: reason });
  return {
    key: candidate.action.actionKey,
    headline: actionHeadline(candidate.action),
    selected: candidate.selected,
    reason: candidate.selected ? undefined : candidate.rejectionReasonCodes[0],
    source: candidate.source,
    score: candidate.score,
    confidence: candidate.confidence,
    details,
  };
}

function actionRow(action: AdaptiveActionV1, selected: boolean, reason?: string): AdaptiveDecisionDebugRow {
  return {
    key: action.actionKey,
    headline: actionHeadline(action),
    selected,
    reason,
    details: action.reasonCodes.map((code) => ({ label: 'Reason', value: code })),
  };
}

function actionHeadline(action: AdaptiveActionV1): string {
  if (action.type === 'REPLACE') return replacementHeadline(action.sellItemId, action.buyItemId ?? action.targetItemId);
  const target = action.buyItemId ?? action.itemId ?? action.targetItemId ?? action.sellItemId;
  const name = target === undefined ? undefined : itemName(target);
  if (action.type === 'BUY') return name ? `Buy ${name}` : 'Buy';
  if (action.type === 'UPGRADE') return name ? `Upgrade to ${name}` : 'Upgrade';
  if (action.type === 'SELL') return name ? `Sell ${name}` : 'Sell';
  if (action.type === 'WAIT') return name ? `Wait for ${name}` : 'Wait';
  if (action.type === 'HOLD') return name ? `Hold for ${name}` : 'Hold';
  if (action.type === 'CONTINUE_CORE') return name ? `Continue toward ${name}` : 'Continue core';
  return 'Abstain';
}

function replacementHeadline(sellItemId?: number, buyItemId?: number): string {
  return `Sell ${sellItemId === undefined ? 'unknown item' : itemName(sellItemId)} - Buy ${buyItemId === undefined ? 'unknown item' : itemName(buyItemId)}`;
}

function itemName(itemId: number): string {
  const item = ADAPTIVE_ITEM_CATALOG[itemId];
  return item?.name ?? `item #${itemId}`;
}

function baselineDetails(itemId: number, trace: AdaptiveDecisionTraceV1): readonly AdaptiveDecisionDebugValue[] {
  const row = trace.baseline.recommendedBuild.find((item) => item.itemId === itemId);
  if (!row) return [];
  return [
    { label: 'Status', value: row.status },
    { label: 'Skeleton', value: numeric(row.skeletonStrength) },
    { label: 'Context', value: numeric(row.contextualSupport) },
  ];
}

function numeric(value: number): string {
  if (!Number.isFinite(value)) return '0';
  return String(Math.round(value * 1_000_000) / 1_000_000);
}
