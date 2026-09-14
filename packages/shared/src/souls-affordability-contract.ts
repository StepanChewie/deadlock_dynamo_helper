export const SOULS_AFFORDABILITY_CONTRACT_VERSION = 'souls-affordability-v1' as const;
const SOULS_AFFORDABILITY_MIN_OBSERVATIONS = 100;
const SOULS_AFFORDABILITY_MIN_SUCCESS_WHEN_SUFFICIENT = 0.999;
const SOULS_AFFORDABILITY_MAX_SUCCESS_WHEN_INSUFFICIENT = 0.001;
const SOULS_AFFORDABILITY_MIN_HUD_MATCH_RATE = 0.999;

export type SoulsAffordabilityOperation = 'BUY' | 'UPGRADE' | 'SELL';

export interface SoulsAffordabilityObservationV1 {
  observationId: string;
  matchId: string;
  gameTimeSec: number;
  operation: SoulsAffordabilityOperation;
  soulsRawBefore: number;
  hudSpendableBefore: number;
  effectiveCost: number;
  operationSucceeded: boolean;
  soulsRawAfter?: number;
  hudSpendableAfter?: number;
  rulesetVersion?: string;
  catalogSha256?: string;
  note?: string;
}

type SoulsAffordabilityVerdict = 'PASS' | 'FAIL' | 'INSUFFICIENT_EVIDENCE';

export interface SoulsAffordabilityReportV1 {
  contractVersion: typeof SOULS_AFFORDABILITY_CONTRACT_VERSION;
  verdict: SoulsAffordabilityVerdict;
  observationCount: number;
  purchaseObservationCount: number;
  sellObservationCount: number;
  sufficientPurchaseCount: number;
  insufficientPurchaseCount: number;
  successWhenSufficientCount: number;
  successWhenInsufficientCount: number;
  hudBeforeMatchCount: number;
  hudAfterComparableCount: number;
  hudAfterMatchCount: number;
  successRateWhenSufficient: number;
  successRateWhenInsufficient: number;
  hudBeforeMatchRate: number;
  hudAfterMatchRate?: number;
  operationCounts: Record<SoulsAffordabilityOperation, number>;
  invalidObservationIds: string[];
  gateFailures: string[];
}

export function analyzeSoulsAffordabilityV1(
  observations: readonly SoulsAffordabilityObservationV1[],
): SoulsAffordabilityReportV1 {
  const invalidObservationIds: string[] = [];
  const valid = observations.filter((observation) => {
    const validObservation = isValidObservation(observation);
    if (!validObservation) invalidObservationIds.push(observation.observationId || '<missing>');
    return validObservation;
  });

  const purchases = valid.filter((observation) => observation.operation !== 'SELL');
  const sells = valid.filter((observation) => observation.operation === 'SELL');
  const sufficient = purchases.filter(
    (observation) => observation.soulsRawBefore >= observation.effectiveCost,
  );
  const insufficient = purchases.filter(
    (observation) => observation.soulsRawBefore < observation.effectiveCost,
  );
  const successWhenSufficientCount = sufficient.filter(
    (observation) => observation.operationSucceeded,
  ).length;
  const successWhenInsufficientCount = insufficient.filter(
    (observation) => observation.operationSucceeded,
  ).length;
  const hudBeforeMatchCount = valid.filter(
    (observation) => observation.soulsRawBefore === observation.hudSpendableBefore,
  ).length;
  const afterComparable = valid.filter(
    (observation) =>
      observation.soulsRawAfter !== undefined && observation.hudSpendableAfter !== undefined,
  );
  const hudAfterMatchCount = afterComparable.filter(
    (observation) => observation.soulsRawAfter === observation.hudSpendableAfter,
  ).length;

  const successRateWhenSufficient = ratio(successWhenSufficientCount, sufficient.length);
  const successRateWhenInsufficient = ratio(successWhenInsufficientCount, insufficient.length);
  const hudBeforeMatchRate = ratio(hudBeforeMatchCount, valid.length);
  const hudAfterMatchRate = afterComparable.length > 0
    ? ratio(hudAfterMatchCount, afterComparable.length)
    : undefined;

  const operationCounts: Record<SoulsAffordabilityOperation, number> = {
    BUY: 0,
    UPGRADE: 0,
    SELL: 0,
  };
  for (const observation of valid) operationCounts[observation.operation] += 1;

  const gateFailures: string[] = [];
  if (invalidObservationIds.length > 0) {
    gateFailures.push('INVALID_OBSERVATIONS_PRESENT');
  }
  if (valid.length < SOULS_AFFORDABILITY_MIN_OBSERVATIONS) {
    gateFailures.push('MIN_OBSERVATION_COUNT_NOT_MET');
  }
  if (sufficient.length === 0) {
    gateFailures.push('NO_SUFFICIENT_PURCHASE_CASES');
  }
  if (insufficient.length === 0) {
    gateFailures.push('NO_INSUFFICIENT_PURCHASE_CASES');
  }
  if (successRateWhenSufficient < SOULS_AFFORDABILITY_MIN_SUCCESS_WHEN_SUFFICIENT) {
    gateFailures.push('SUCCESS_WHEN_SUFFICIENT_BELOW_THRESHOLD');
  }
  if (successRateWhenInsufficient > SOULS_AFFORDABILITY_MAX_SUCCESS_WHEN_INSUFFICIENT) {
    gateFailures.push('SUCCESS_WHEN_INSUFFICIENT_ABOVE_THRESHOLD');
  }
  if (hudBeforeMatchRate < SOULS_AFFORDABILITY_MIN_HUD_MATCH_RATE) {
    gateFailures.push('GEP_HUD_BALANCE_MATCH_BELOW_THRESHOLD');
  }
  if (
    hudAfterMatchRate !== undefined &&
    hudAfterMatchRate < SOULS_AFFORDABILITY_MIN_HUD_MATCH_RATE
  ) {
    gateFailures.push('POST_OPERATION_GEP_HUD_MATCH_BELOW_THRESHOLD');
  }

  const evidenceComplete =
    valid.length >= SOULS_AFFORDABILITY_MIN_OBSERVATIONS &&
    sufficient.length > 0 &&
    insufficient.length > 0;
  const verdict: SoulsAffordabilityVerdict = !evidenceComplete
    ? 'INSUFFICIENT_EVIDENCE'
    : gateFailures.length === 0
      ? 'PASS'
      : 'FAIL';

  return {
    contractVersion: SOULS_AFFORDABILITY_CONTRACT_VERSION,
    verdict,
    observationCount: valid.length,
    purchaseObservationCount: purchases.length,
    sellObservationCount: sells.length,
    sufficientPurchaseCount: sufficient.length,
    insufficientPurchaseCount: insufficient.length,
    successWhenSufficientCount,
    successWhenInsufficientCount,
    hudBeforeMatchCount,
    hudAfterComparableCount: afterComparable.length,
    hudAfterMatchCount,
    successRateWhenSufficient,
    successRateWhenInsufficient,
    hudBeforeMatchRate,
    hudAfterMatchRate,
    operationCounts,
    invalidObservationIds: [...invalidObservationIds].sort(),
    gateFailures,
  };
}

function isValidObservation(observation: SoulsAffordabilityObservationV1): boolean {
  return (
    typeof observation.observationId === 'string' &&
    observation.observationId.length > 0 &&
    typeof observation.matchId === 'string' &&
    observation.matchId.length > 0 &&
    Number.isFinite(observation.gameTimeSec) &&
    observation.gameTimeSec >= 0 &&
    (observation.operation === 'BUY' ||
      observation.operation === 'UPGRADE' ||
      observation.operation === 'SELL') &&
    Number.isFinite(observation.soulsRawBefore) &&
    observation.soulsRawBefore >= 0 &&
    Number.isFinite(observation.hudSpendableBefore) &&
    observation.hudSpendableBefore >= 0 &&
    Number.isFinite(observation.effectiveCost) &&
    observation.effectiveCost >= 0 &&
    typeof observation.operationSucceeded === 'boolean' &&
    (observation.soulsRawAfter === undefined ||
      (Number.isFinite(observation.soulsRawAfter) && observation.soulsRawAfter >= 0)) &&
    (observation.hudSpendableAfter === undefined ||
      (Number.isFinite(observation.hudSpendableAfter) && observation.hudSpendableAfter >= 0))
  );
}

function ratio(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}
