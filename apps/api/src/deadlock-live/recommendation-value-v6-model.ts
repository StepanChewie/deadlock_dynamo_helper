export const RECOMMENDATION_VALUE_V6_MODEL_VERSION =
  'RECOMMENDATION_VALUE_V6_MATCH_BALANCED_ADVANTAGE_1' as const;

const EPSILON = 1e-9;

export interface RecommendationValueV6TargetComponents {
  finalOutcome: number;
  shortHorizonUtility?: number;
  shortHorizonCount: number;
}

export interface RecommendationValueV6SourceRow {
  decisionId: string;
  matchId: string;
  playerWon: boolean;
  targetUtility: number;
  targetComponents: RecommendationValueV6TargetComponents;
  stateKeys: string[];
  actionKeys: string[];
  observedActionKey: string;
  candidateActions: Array<{
    actionKey: string;
    actionKeys: string[];
  }>;
}

export interface RecommendationValueV6WeightedRow
  extends RecommendationValueV6SourceRow {
  matchWeight: number;
}

export interface RecommendationValueV6ModelOptions {
  statePriorStrength: number;
  actionPriorStrength: number;
  minimumObservations: number;
  maximumAbsoluteStateResidual: number;
  maximumAbsoluteActionResidual: number;
}

export interface RecommendationValueV6Count {
  utilitySum: number;
  utilitySquaredSum: number;
  winWeight: number;
  totalWeight: number;
  observations: number;
}

export interface RecommendationValueV6Model {
  version: typeof RECOMMENDATION_VALUE_V6_MODEL_VERSION;
  global: RecommendationValueV6Count;
  state: Map<string, RecommendationValueV6Count>;
  action: Map<string, RecommendationValueV6Count>;
}

export interface RecommendationValueV6Prediction {
  stateUtility: number;
  actionUtility: number;
  actionAdvantage: number;
  stateWinProbability: number;
  actionWinProbability: number;
  supportedStateKeyCount: number;
  supportedActionKeyCount: number;
}

export interface RecommendationValueV6MetricsAccumulator {
  matchIds: Set<string>;
  decisionCount: number;
  totalWeight: number;
  squaredErrorState: number;
  squaredErrorAction: number;
  absoluteErrorState: number;
  absoluteErrorAction: number;
  logLossState: number;
  logLossAction: number;
  brierState: number;
  brierAction: number;
  supportedStateWeight: number;
  supportedActionWeight: number;
  observedActionTop1Weight: number;
  reciprocalRankWeight: number;
  rankingWeight: number;
  separationWeightSum: number;
  shortHorizonWeight: number;
}

export interface RecommendationValueV6Metrics {
  matchCount: number;
  decisionCount: number;
  totalWeight: number;
  stateRmse: number;
  actionRmse: number;
  utilityRmseImprovement: number;
  stateMae: number;
  actionMae: number;
  stateLogLoss: number;
  actionLogLoss: number;
  logLossImprovement: number;
  stateBrierScore: number;
  actionBrierScore: number;
  brierImprovement: number;
  stateSupportCoverage: number;
  actionSupportCoverage: number;
  observedActionTop1Agreement: number;
  observedActionMeanReciprocalRank: number;
  averageTopCandidateSeparation: number;
  shortHorizonCoverage: number;
}

export function createRecommendationValueV6Model(): RecommendationValueV6Model {
  return {
    version: RECOMMENDATION_VALUE_V6_MODEL_VERSION,
    global: emptyCount(),
    state: new Map(),
    action: new Map(),
  };
}

export function updateRecommendationValueV6Model(
  model: RecommendationValueV6Model,
  row: RecommendationValueV6SourceRow,
  matchWeight: number,
): void {
  validateSourceRow(row);
  validateWeight(matchWeight);
  incrementCount(model.global, row, matchWeight);
  for (const key of uniqueKeys(row.stateKeys)) {
    incrementTable(model.state, key, row, matchWeight);
  }
  for (const key of uniqueKeys(row.actionKeys)) {
    incrementTable(model.action, key, row, matchWeight);
  }
}

export function predictRecommendationValueV6(
  model: RecommendationValueV6Model,
  row: Pick<RecommendationValueV6SourceRow, 'stateKeys' | 'actionKeys'>,
  options: RecommendationValueV6ModelOptions,
  actionResidualScale: number,
): RecommendationValueV6Prediction {
  validateOptions(options);
  if (!Number.isFinite(actionResidualScale) || actionResidualScale < 0) {
    throw new Error('actionResidualScale must be a finite non-negative number.');
  }
  if (model.global.totalWeight <= 0) {
    throw new Error('Recommendation Value V6 model has no training weight.');
  }

  const globalUtility = countUtilityMean(model.global);
  const globalWinProbability = countWinProbability(model.global);
  const stateUtilityResiduals = supportedResiduals(
    model.state,
    row.stateKeys,
    globalUtility,
    options.statePriorStrength,
    options.minimumObservations,
    countUtilityMean,
  );
  const stateWinResiduals = supportedResiduals(
    model.state,
    row.stateKeys,
    globalWinProbability,
    options.statePriorStrength,
    options.minimumObservations,
    countWinProbability,
  );
  const stateUtility = clamp(
    globalUtility +
      clamp(
        robustAverage(stateUtilityResiduals),
        -options.maximumAbsoluteStateResidual,
        options.maximumAbsoluteStateResidual,
      ),
    -1,
    1,
  );
  const stateWinProbability = clampProbability(
    globalWinProbability +
      clamp(
        robustAverage(stateWinResiduals),
        -options.maximumAbsoluteStateResidual,
        options.maximumAbsoluteStateResidual,
      ),
  );

  const actionUtilityResiduals = supportedResiduals(
    model.action,
    row.actionKeys,
    stateUtility,
    options.actionPriorStrength,
    options.minimumObservations,
    countUtilityMean,
  );
  const actionWinResiduals = supportedResiduals(
    model.action,
    row.actionKeys,
    stateWinProbability,
    options.actionPriorStrength,
    options.minimumObservations,
    countWinProbability,
  );
  const actionAdvantage = clamp(
    actionResidualScale * robustAverage(actionUtilityResiduals),
    -options.maximumAbsoluteActionResidual,
    options.maximumAbsoluteActionResidual,
  );
  const winAdvantage = clamp(
    actionResidualScale * robustAverage(actionWinResiduals),
    -options.maximumAbsoluteActionResidual,
    options.maximumAbsoluteActionResidual,
  );

  return {
    stateUtility,
    actionUtility: clamp(stateUtility + actionAdvantage, -1, 1),
    actionAdvantage,
    stateWinProbability,
    actionWinProbability: clampProbability(stateWinProbability + winAdvantage),
    supportedStateKeyCount: Math.max(
      stateUtilityResiduals.length,
      stateWinResiduals.length,
    ),
    supportedActionKeyCount: Math.max(
      actionUtilityResiduals.length,
      actionWinResiduals.length,
    ),
  };
}

export function createRecommendationValueV6MetricsAccumulator(): RecommendationValueV6MetricsAccumulator {
  return {
    matchIds: new Set(),
    decisionCount: 0,
    totalWeight: 0,
    squaredErrorState: 0,
    squaredErrorAction: 0,
    absoluteErrorState: 0,
    absoluteErrorAction: 0,
    logLossState: 0,
    logLossAction: 0,
    brierState: 0,
    brierAction: 0,
    supportedStateWeight: 0,
    supportedActionWeight: 0,
    observedActionTop1Weight: 0,
    reciprocalRankWeight: 0,
    rankingWeight: 0,
    separationWeightSum: 0,
    shortHorizonWeight: 0,
  };
}

export function observeRecommendationValueV6Prediction(
  accumulator: RecommendationValueV6MetricsAccumulator,
  row: RecommendationValueV6SourceRow,
  prediction: RecommendationValueV6Prediction,
  candidatePredictions: Array<{
    actionKey: string;
    prediction: RecommendationValueV6Prediction;
  }>,
  matchWeight: number,
): void {
  validateSourceRow(row);
  validateWeight(matchWeight);
  const outcome = row.playerWon ? 1 : 0;
  accumulator.matchIds.add(row.matchId);
  accumulator.decisionCount += 1;
  accumulator.totalWeight += matchWeight;
  accumulator.squaredErrorState +=
    matchWeight * (prediction.stateUtility - row.targetUtility) ** 2;
  accumulator.squaredErrorAction +=
    matchWeight * (prediction.actionUtility - row.targetUtility) ** 2;
  accumulator.absoluteErrorState +=
    matchWeight * Math.abs(prediction.stateUtility - row.targetUtility);
  accumulator.absoluteErrorAction +=
    matchWeight * Math.abs(prediction.actionUtility - row.targetUtility);
  accumulator.logLossState +=
    matchWeight * binaryLogLoss(outcome, prediction.stateWinProbability);
  accumulator.logLossAction +=
    matchWeight * binaryLogLoss(outcome, prediction.actionWinProbability);
  accumulator.brierState +=
    matchWeight * (prediction.stateWinProbability - outcome) ** 2;
  accumulator.brierAction +=
    matchWeight * (prediction.actionWinProbability - outcome) ** 2;
  accumulator.supportedStateWeight +=
    prediction.supportedStateKeyCount > 0 ? matchWeight : 0;
  accumulator.supportedActionWeight +=
    prediction.supportedActionKeyCount > 0 ? matchWeight : 0;
  accumulator.shortHorizonWeight +=
    row.targetComponents.shortHorizonCount > 0 ? matchWeight : 0;

  const ranking = [...candidatePredictions].sort(
    (left, right) =>
      right.prediction.actionAdvantage - left.prediction.actionAdvantage ||
      left.actionKey.localeCompare(right.actionKey),
  );
  if (ranking.length > 0) {
    const observedIndex = ranking.findIndex(
      (entry) => entry.actionKey === row.observedActionKey,
    );
    if (observedIndex >= 0) {
      accumulator.rankingWeight += matchWeight;
      accumulator.observedActionTop1Weight +=
        observedIndex === 0 ? matchWeight : 0;
      accumulator.reciprocalRankWeight += matchWeight / (observedIndex + 1);
      if (ranking.length > 1) {
        accumulator.separationWeightSum +=
          matchWeight *
          (ranking[0].prediction.actionAdvantage -
            ranking[1].prediction.actionAdvantage);
      }
    }
  }
}

export function finalizeRecommendationValueV6Metrics(
  accumulator: RecommendationValueV6MetricsAccumulator,
): RecommendationValueV6Metrics {
  if (accumulator.totalWeight <= 0) {
    throw new Error('Recommendation Value V6 evaluation has no weight.');
  }
  const rankingWeight = Math.max(accumulator.rankingWeight, EPSILON);
  return {
    matchCount: accumulator.matchIds.size,
    decisionCount: accumulator.decisionCount,
    totalWeight: accumulator.totalWeight,
    stateRmse: Math.sqrt(accumulator.squaredErrorState / accumulator.totalWeight),
    actionRmse: Math.sqrt(accumulator.squaredErrorAction / accumulator.totalWeight),
    utilityRmseImprovement:
      Math.sqrt(accumulator.squaredErrorState / accumulator.totalWeight) -
      Math.sqrt(accumulator.squaredErrorAction / accumulator.totalWeight),
    stateMae: accumulator.absoluteErrorState / accumulator.totalWeight,
    actionMae: accumulator.absoluteErrorAction / accumulator.totalWeight,
    stateLogLoss: accumulator.logLossState / accumulator.totalWeight,
    actionLogLoss: accumulator.logLossAction / accumulator.totalWeight,
    logLossImprovement:
      (accumulator.logLossState - accumulator.logLossAction) /
      accumulator.totalWeight,
    stateBrierScore: accumulator.brierState / accumulator.totalWeight,
    actionBrierScore: accumulator.brierAction / accumulator.totalWeight,
    brierImprovement:
      (accumulator.brierState - accumulator.brierAction) /
      accumulator.totalWeight,
    stateSupportCoverage:
      accumulator.supportedStateWeight / accumulator.totalWeight,
    actionSupportCoverage:
      accumulator.supportedActionWeight / accumulator.totalWeight,
    observedActionTop1Agreement:
      accumulator.observedActionTop1Weight / rankingWeight,
    observedActionMeanReciprocalRank:
      accumulator.reciprocalRankWeight / rankingWeight,
    averageTopCandidateSeparation:
      accumulator.separationWeightSum / rankingWeight,
    shortHorizonCoverage:
      accumulator.shortHorizonWeight / accumulator.totalWeight,
  };
}

export function selectRecommendationValueV6ActionScale(
  candidates: readonly {
    actionResidualScale: number;
    tuningLoss: number;
  }[],
): {
  actionResidualScale: number;
  tuningLoss: number;
  candidates: Array<{ actionResidualScale: number; tuningLoss: number }>;
} {
  if (candidates.length === 0) {
    throw new Error('Recommendation Value V6 scale tuning requires candidates.');
  }
  const normalized = candidates.map((candidate) => {
    if (
      !Number.isFinite(candidate.actionResidualScale) ||
      candidate.actionResidualScale < 0 ||
      !Number.isFinite(candidate.tuningLoss)
    ) {
      throw new Error('Recommendation Value V6 tuning candidate is invalid.');
    }
    return { ...candidate };
  });
  normalized.sort(
    (left, right) =>
      left.tuningLoss - right.tuningLoss ||
      left.actionResidualScale - right.actionResidualScale,
  );
  return {
    actionResidualScale: normalized[0].actionResidualScale,
    tuningLoss: normalized[0].tuningLoss,
    candidates: normalized,
  };
}

export function serializeRecommendationValueV6Model(
  model: RecommendationValueV6Model,
  minimumObservations: number,
): Record<string, unknown> {
  return {
    version: model.version,
    global: { ...model.global },
    state: serializeTable(model.state, minimumObservations),
    action: serializeTable(model.action, minimumObservations),
  };
}

function serializeTable(
  table: Map<string, RecommendationValueV6Count>,
  minimumObservations: number,
): Record<string, RecommendationValueV6Count> {
  const result: Record<string, RecommendationValueV6Count> = {};
  for (const [key, count] of [...table.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (count.observations >= minimumObservations) {
      result[key] = { ...count };
    }
  }
  return result;
}

function supportedResiduals(
  table: Map<string, RecommendationValueV6Count>,
  keys: readonly string[],
  priorMean: number,
  priorStrength: number,
  minimumObservations: number,
  mean: (count: RecommendationValueV6Count) => number,
): number[] {
  const result: number[] = [];
  for (const key of uniqueKeys(keys)) {
    const count = table.get(key);
    if (!count || count.observations < minimumObservations) {
      continue;
    }
    const posterior =
      (mean(count) * count.totalWeight + priorMean * priorStrength) /
      (count.totalWeight + priorStrength);
    result.push(posterior - priorMean);
  }
  return result;
}

function incrementTable(
  table: Map<string, RecommendationValueV6Count>,
  key: string,
  row: RecommendationValueV6SourceRow,
  weight: number,
): void {
  const count = table.get(key) ?? emptyCount();
  incrementCount(count, row, weight);
  table.set(key, count);
}

function incrementCount(
  count: RecommendationValueV6Count,
  row: RecommendationValueV6SourceRow,
  weight: number,
): void {
  count.utilitySum += row.targetUtility * weight;
  count.utilitySquaredSum += row.targetUtility ** 2 * weight;
  count.winWeight += row.playerWon ? weight : 0;
  count.totalWeight += weight;
  count.observations += 1;
}

function emptyCount(): RecommendationValueV6Count {
  return {
    utilitySum: 0,
    utilitySquaredSum: 0,
    winWeight: 0,
    totalWeight: 0,
    observations: 0,
  };
}

function countUtilityMean(count: RecommendationValueV6Count): number {
  return count.totalWeight > 0 ? count.utilitySum / count.totalWeight : 0;
}

function countWinProbability(count: RecommendationValueV6Count): number {
  return clampProbability(
    count.totalWeight > 0 ? count.winWeight / count.totalWeight : 0.5,
  );
}

function robustAverage(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const trim = sorted.length >= 5 ? Math.floor(sorted.length * 0.2) : 0;
  const selected = sorted.slice(trim, sorted.length - trim || undefined);
  return selected.reduce((sum, value) => sum + value, 0) / selected.length;
}

function binaryLogLoss(outcome: number, probability: number): number {
  const normalized = clampProbability(probability);
  return -(
    outcome * Math.log(normalized) +
    (1 - outcome) * Math.log(1 - normalized)
  );
}

function uniqueKeys(keys: readonly string[]): string[] {
  return [...new Set(keys.filter((key) => key.length > 0))];
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function clampProbability(value: number): number {
  return clamp(value, EPSILON, 1 - EPSILON);
}

function validateSourceRow(row: RecommendationValueV6SourceRow): void {
  if (!row.decisionId || !row.matchId || !row.observedActionKey) {
    throw new Error('Recommendation Value V6 source row identity is invalid.');
  }
  if (!Number.isFinite(row.targetUtility) || Math.abs(row.targetUtility) > 1) {
    throw new Error(
      `Recommendation Value V6 row ${row.decisionId} has invalid target utility.`,
    );
  }
}

function validateWeight(weight: number): void {
  if (!Number.isFinite(weight) || weight <= 0) {
    throw new Error('Recommendation Value V6 match weight must be positive.');
  }
}

function validateOptions(options: RecommendationValueV6ModelOptions): void {
  if (
    !Number.isFinite(options.statePriorStrength) ||
    options.statePriorStrength < 0 ||
    !Number.isFinite(options.actionPriorStrength) ||
    options.actionPriorStrength < 0 ||
    !Number.isSafeInteger(options.minimumObservations) ||
    options.minimumObservations < 1 ||
    !Number.isFinite(options.maximumAbsoluteStateResidual) ||
    options.maximumAbsoluteStateResidual <= 0 ||
    !Number.isFinite(options.maximumAbsoluteActionResidual) ||
    options.maximumAbsoluteActionResidual <= 0
  ) {
    throw new Error('Recommendation Value V6 model options are invalid.');
  }
}
