export const RECOMMENDATION_VALUE_V5_MODEL_VERSION =
  'RECOMMENDATION_VALUE_V5_MATCH_BALANCED_STATE_ACTION_RESIDUAL_2' as const;

const EPSILON = 1e-9;

export interface RecommendationValueV5SourceRow {
  decisionId: string;
  matchId: string;
  playerWon: boolean;
  stateKeys: string[];
  actionKeys: string[];
}

export interface RecommendationValueV5WeightedRow
  extends RecommendationValueV5SourceRow {
  matchWeight: number;
}

export interface RecommendationValueV5ModelOptions {
  statePriorStrength: number;
  actionPriorStrength: number;
  minimumEffectiveObservations: number;
  maximumAbsoluteStateLogitResidual: number;
  maximumAbsoluteActionLogitResidual: number;
}

export interface RecommendationValueV5WeightedBinaryCount {
  wins: number;
  total: number;
  observations: number;
}

export interface RecommendationValueV5Model {
  version: typeof RECOMMENDATION_VALUE_V5_MODEL_VERSION;
  global: RecommendationValueV5WeightedBinaryCount;
  state: Map<string, RecommendationValueV5WeightedBinaryCount>;
  action: Map<string, RecommendationValueV5WeightedBinaryCount>;
}

export interface RecommendationValueV5Prediction {
  stateProbability: number;
  actionProbability: number;
  stateLogitResidual: number;
  actionLogitResidual: number;
  supportedStateKeyCount: number;
  supportedActionKeyCount: number;
}

export interface RecommendationValueV5ScaleSelection {
  actionResidualScale: number;
  tuningLogLoss: number;
  candidates: Array<{
    actionResidualScale: number;
    tuningLogLoss: number;
  }>;
}

export interface RecommendationValueV5Metrics {
  matchCount: number;
  decisionCount: number;
  totalWeight: number;
  positiveWeight: number;
  negativeWeight: number;
  logLoss: number;
  brierScore: number;
  accuracy: number;
  averagePrediction: number;
  observedWinRate: number;
}

export interface RecommendationValueV5MetricsAccumulator {
  matchIds: Set<string>;
  decisionCount: number;
  totalWeight: number;
  positiveWeight: number;
  negativeWeight: number;
  logLossSum: number;
  brierScoreSum: number;
  correctWeight: number;
  predictionSum: number;
  outcomeSum: number;
}

export function createRecommendationValueV5Model(): RecommendationValueV5Model {
  return {
    version: RECOMMENDATION_VALUE_V5_MODEL_VERSION,
    global: { wins: 0, total: 0, observations: 0 },
    state: new Map(),
    action: new Map(),
  };
}

export function updateRecommendationValueV5Model(
  model: RecommendationValueV5Model,
  row: RecommendationValueV5SourceRow,
  matchWeight: number,
): void {
  validateSourceRow(row);
  validateWeight(row.decisionId, matchWeight);
  incrementCount(model.global, row.playerWon, matchWeight);
  for (const key of uniqueKeys(row.stateKeys)) {
    incrementTable(model.state, key, row.playerWon, matchWeight);
  }
  for (const key of uniqueKeys(row.actionKeys)) {
    incrementTable(model.action, key, row.playerWon, matchWeight);
  }
}

export function buildRecommendationValueV5MatchBalancedRows(
  rows: readonly RecommendationValueV5SourceRow[],
): RecommendationValueV5WeightedRow[] {
  const decisionCountsByMatch = new Map<string, number>();
  const decisionIds = new Set<string>();
  for (const row of rows) {
    validateSourceRow(row);
    if (decisionIds.has(row.decisionId)) {
      throw new Error(`Duplicate Value V5 decision ID: ${row.decisionId}.`);
    }
    decisionIds.add(row.decisionId);
    decisionCountsByMatch.set(
      row.matchId,
      (decisionCountsByMatch.get(row.matchId) ?? 0) + 1,
    );
  }
  return rows.map((row) => {
    const decisionCount = decisionCountsByMatch.get(row.matchId) ?? 0;
    if (decisionCount <= 0) {
      throw new Error(`Value V5 match ${row.matchId} has no eligible decisions.`);
    }
    return {
      ...row,
      stateKeys: uniqueKeys(row.stateKeys),
      actionKeys: uniqueKeys(row.actionKeys),
      matchWeight: 1 / decisionCount,
    };
  });
}

export function trainRecommendationValueV5Model(
  rows: readonly RecommendationValueV5WeightedRow[],
): RecommendationValueV5Model {
  if (rows.length === 0) {
    throw new Error('Value V5 training requires at least one weighted row.');
  }
  const model = createRecommendationValueV5Model();
  for (const row of rows) {
    validateWeightedRow(row);
    updateRecommendationValueV5Model(model, row, row.matchWeight);
  }
  return model;
}

export function predictRecommendationValueV5(
  model: RecommendationValueV5Model,
  row: Pick<RecommendationValueV5SourceRow, 'stateKeys' | 'actionKeys'>,
  options: RecommendationValueV5ModelOptions,
  actionResidualScale: number,
): RecommendationValueV5Prediction {
  validateOptions(options);
  if (!Number.isFinite(actionResidualScale) || actionResidualScale < 0) {
    throw new Error('actionResidualScale must be a finite non-negative number.');
  }
  if (model.global.total <= 0) {
    throw new Error('Value V5 model contains no effective training observations.');
  }

  const globalProbability = posteriorProbability(
    model.global,
    0.5,
    options.statePriorStrength,
  );
  const globalLogit = probabilityLogit(globalProbability);
  const stateDeltas = supportedDeltas(
    model.state,
    row.stateKeys,
    globalProbability,
    options.statePriorStrength,
    options.minimumEffectiveObservations,
  );
  const stateLogitResidual = clamp(
    robustAverage(stateDeltas),
    -options.maximumAbsoluteStateLogitResidual,
    options.maximumAbsoluteStateLogitResidual,
  );
  const stateProbability = probabilityFromLogit(
    globalLogit + stateLogitResidual,
  );
  const stateLogit = probabilityLogit(stateProbability);
  const actionDeltas = supportedDeltas(
    model.action,
    row.actionKeys,
    stateProbability,
    options.actionPriorStrength,
    options.minimumEffectiveObservations,
  );
  const actionLogitResidual = clamp(
    actionResidualScale * robustAverage(actionDeltas),
    -options.maximumAbsoluteActionLogitResidual,
    options.maximumAbsoluteActionLogitResidual,
  );

  return {
    stateProbability,
    actionProbability: probabilityFromLogit(stateLogit + actionLogitResidual),
    stateLogitResidual,
    actionLogitResidual,
    supportedStateKeyCount: stateDeltas.length,
    supportedActionKeyCount: actionDeltas.length,
  };
}

export function createRecommendationValueV5MetricsAccumulator(): RecommendationValueV5MetricsAccumulator {
  return {
    matchIds: new Set(),
    decisionCount: 0,
    totalWeight: 0,
    positiveWeight: 0,
    negativeWeight: 0,
    logLossSum: 0,
    brierScoreSum: 0,
    correctWeight: 0,
    predictionSum: 0,
    outcomeSum: 0,
  };
}

export function observeRecommendationValueV5Prediction(
  accumulator: RecommendationValueV5MetricsAccumulator,
  row: RecommendationValueV5SourceRow,
  prediction: number,
  matchWeight: number,
): void {
  validateSourceRow(row);
  validateWeight(row.decisionId, matchWeight);
  if (!Number.isFinite(prediction) || prediction <= 0 || prediction >= 1) {
    throw new Error(`Value V5 decision ${row.decisionId} has invalid prediction.`);
  }
  const outcome = row.playerWon ? 1 : 0;
  accumulator.matchIds.add(row.matchId);
  accumulator.decisionCount += 1;
  accumulator.totalWeight += matchWeight;
  accumulator.positiveWeight += row.playerWon ? matchWeight : 0;
  accumulator.negativeWeight += row.playerWon ? 0 : matchWeight;
  accumulator.logLossSum +=
    matchWeight *
    -(outcome * Math.log(prediction) + (1 - outcome) * Math.log(1 - prediction));
  accumulator.brierScoreSum += matchWeight * (prediction - outcome) ** 2;
  accumulator.correctWeight +=
    matchWeight * (Number(prediction >= 0.5) === outcome ? 1 : 0);
  accumulator.predictionSum += matchWeight * prediction;
  accumulator.outcomeSum += matchWeight * outcome;
}

export function finalizeRecommendationValueV5Metrics(
  accumulator: RecommendationValueV5MetricsAccumulator,
): RecommendationValueV5Metrics {
  if (accumulator.totalWeight <= 0) {
    throw new Error('Value V5 evaluation has no positive observation weight.');
  }
  return {
    matchCount: accumulator.matchIds.size,
    decisionCount: accumulator.decisionCount,
    totalWeight: accumulator.totalWeight,
    positiveWeight: accumulator.positiveWeight,
    negativeWeight: accumulator.negativeWeight,
    logLoss: accumulator.logLossSum / accumulator.totalWeight,
    brierScore: accumulator.brierScoreSum / accumulator.totalWeight,
    accuracy: accumulator.correctWeight / accumulator.totalWeight,
    averagePrediction: accumulator.predictionSum / accumulator.totalWeight,
    observedWinRate: accumulator.outcomeSum / accumulator.totalWeight,
  };
}

export function tuneRecommendationValueV5ActionResidualScale(
  model: RecommendationValueV5Model,
  tuningRows: readonly RecommendationValueV5WeightedRow[],
  options: RecommendationValueV5ModelOptions,
  candidateScales: readonly number[],
): RecommendationValueV5ScaleSelection {
  if (tuningRows.length === 0) {
    throw new Error('Value V5 tuning requires at least one row.');
  }
  const scales = normalizeScales(candidateScales);
  const candidates = scales.map((actionResidualScale) => ({
    actionResidualScale,
    tuningLogLoss: evaluateRecommendationValueV5(
      model,
      tuningRows,
      options,
      actionResidualScale,
    ).logLoss,
  }));
  return selectRecommendationValueV5ActionResidualScale(candidates);
}

export function selectRecommendationValueV5ActionResidualScale(
  candidates: readonly {
    actionResidualScale: number;
    tuningLogLoss: number;
  }[],
): RecommendationValueV5ScaleSelection {
  if (candidates.length === 0) {
    throw new Error('Value V5 tuning requires at least one scale candidate.');
  }
  const sorted = candidates.map((candidate) => {
    if (
      !Number.isFinite(candidate.actionResidualScale) ||
      candidate.actionResidualScale < 0 ||
      !Number.isFinite(candidate.tuningLogLoss)
    ) {
      throw new Error('Value V5 tuning candidate contains invalid metrics.');
    }
    return { ...candidate };
  });
  sorted.sort(
    (left, right) =>
      left.tuningLogLoss - right.tuningLogLoss ||
      left.actionResidualScale - right.actionResidualScale,
  );
  return {
    actionResidualScale: sorted[0].actionResidualScale,
    tuningLogLoss: sorted[0].tuningLogLoss,
    candidates: sorted,
  };
}

export function normalizeRecommendationValueV5Scales(
  candidateScales: readonly number[],
): number[] {
  return normalizeScales(candidateScales);
}

export function evaluateRecommendationValueV5(
  model: RecommendationValueV5Model,
  rows: readonly RecommendationValueV5WeightedRow[],
  options: RecommendationValueV5ModelOptions,
  actionResidualScale: number,
): RecommendationValueV5Metrics {
  if (rows.length === 0) {
    throw new Error('Value V5 evaluation requires at least one row.');
  }
  const accumulator = createRecommendationValueV5MetricsAccumulator();
  for (const row of rows) {
    validateWeightedRow(row);
    const prediction = predictRecommendationValueV5(
      model,
      row,
      options,
      actionResidualScale,
    ).actionProbability;
    observeRecommendationValueV5Prediction(
      accumulator,
      row,
      prediction,
      row.matchWeight,
    );
  }
  return finalizeRecommendationValueV5Metrics(accumulator);
}

export function serializeRecommendationValueV5Model(
  model: RecommendationValueV5Model,
  minimumEffectiveObservations = 0,
): Record<string, unknown> {
  return {
    version: model.version,
    global: { ...model.global },
    state: serializeTable(model.state, minimumEffectiveObservations),
    action: serializeTable(model.action, minimumEffectiveObservations),
  };
}

export function sumRecommendationValueV5WeightsByMatch(
  rows: readonly RecommendationValueV5WeightedRow[],
): Map<string, number> {
  const result = new Map<string, number>();
  for (const row of rows) {
    result.set(row.matchId, (result.get(row.matchId) ?? 0) + row.matchWeight);
  }
  return result;
}

function normalizeScales(candidateScales: readonly number[]): number[] {
  const scales = [...new Set(candidateScales)].sort((left, right) => left - right);
  if (
    scales.length === 0 ||
    scales.some((scale) => !Number.isFinite(scale) || scale < 0)
  ) {
    throw new Error('Value V5 action residual scales must be finite non-negative numbers.');
  }
  return scales;
}

function supportedDeltas(
  table: ReadonlyMap<string, RecommendationValueV5WeightedBinaryCount>,
  keys: readonly string[],
  priorProbability: number,
  priorStrength: number,
  minimumEffectiveObservations: number,
): number[] {
  const priorLogit = probabilityLogit(priorProbability);
  return uniqueKeys(keys)
    .map((key) => table.get(key))
    .filter(
      (count): count is RecommendationValueV5WeightedBinaryCount =>
        Boolean(count && count.observations >= minimumEffectiveObservations),
    )
    .map(
      (count) =>
        probabilityLogit(
          posteriorProbability(count, priorProbability, priorStrength),
        ) - priorLogit,
    );
}

function robustAverage(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const trimCount = sorted.length >= 5 ? Math.floor(sorted.length * 0.1) : 0;
  const retained = sorted.slice(trimCount, sorted.length - trimCount);
  return retained.reduce((sum, value) => sum + value, 0) / retained.length;
}

function posteriorProbability(
  count: RecommendationValueV5WeightedBinaryCount,
  priorProbability: number,
  priorStrength: number,
): number {
  return clampProbability(
    (count.wins + priorProbability * priorStrength) /
      (count.total + priorStrength),
  );
}

function incrementTable(
  table: Map<string, RecommendationValueV5WeightedBinaryCount>,
  key: string,
  won: boolean,
  weight: number,
): void {
  const count = table.get(key) ?? { wins: 0, total: 0, observations: 0 };
  incrementCount(count, won, weight);
  table.set(key, count);
}

function incrementCount(
  count: RecommendationValueV5WeightedBinaryCount,
  won: boolean,
  weight: number,
): void {
  count.total += weight;
  count.wins += won ? weight : 0;
  count.observations += 1;
}

function serializeTable(
  table: ReadonlyMap<string, RecommendationValueV5WeightedBinaryCount>,
  minimumEffectiveObservations: number,
): Record<string, RecommendationValueV5WeightedBinaryCount> {
  return Object.fromEntries(
    [...table.entries()]
      .filter(([, count]) => count.observations >= minimumEffectiveObservations)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, count]) => [key, { ...count }]),
  );
}

function uniqueKeys(keys: readonly string[]): string[] {
  return [...new Set(keys.map((key) => key.trim()).filter(Boolean))].sort();
}

function validateSourceRow(row: RecommendationValueV5SourceRow): void {
  if (!row.decisionId.trim()) {
    throw new Error('Value V5 decisionId is required.');
  }
  if (!row.matchId.trim()) {
    throw new Error(`Value V5 decision ${row.decisionId} has no matchId.`);
  }
  if (row.stateKeys.length === 0) {
    throw new Error(`Value V5 decision ${row.decisionId} has no state keys.`);
  }
  if (row.actionKeys.length === 0) {
    throw new Error(`Value V5 decision ${row.decisionId} has no action keys.`);
  }
}

function validateWeightedRow(row: RecommendationValueV5WeightedRow): void {
  validateSourceRow(row);
  validateWeight(row.decisionId, row.matchWeight);
}

function validateWeight(decisionId: string, weight: number): void {
  if (!Number.isFinite(weight) || weight <= 0) {
    throw new Error(`Value V5 decision ${decisionId} has invalid match weight.`);
  }
}

function validateOptions(options: RecommendationValueV5ModelOptions): void {
  for (const [fieldName, value] of Object.entries(options)) {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`${fieldName} must be a finite non-negative number.`);
    }
  }
  if (options.statePriorStrength <= 0 || options.actionPriorStrength <= 0) {
    throw new Error('Value V5 prior strengths must be greater than zero.');
  }
}

function probabilityLogit(probability: number): number {
  const value = clampProbability(probability);
  return Math.log(value / (1 - value));
}

function probabilityFromLogit(logit: number): number {
  if (logit >= 0) {
    const exponent = Math.exp(-logit);
    return clampProbability(1 / (1 + exponent));
  }
  const exponent = Math.exp(logit);
  return clampProbability(exponent / (1 + exponent));
}

function clampProbability(value: number): number {
  return clamp(value, EPSILON, 1 - EPSILON);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
