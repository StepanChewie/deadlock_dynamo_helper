import type {
  HeroBuildEvaluationPhase,
  HeroBuildOfflineEvaluationMatchDescriptor,
} from './hero-build-offline-evaluation.service';
import type { HeroBuildRecommendationMode } from './hero-build-recommendation.service';

export const HERO_BUILD_OFFLINE_EVALUATION_V2_MODEL_VERSION =
  'HERO_BUILD_CHRONOLOGICAL_VALIDATION_TEST_V2' as const;
export const HERO_BUILD_OFFLINE_EVALUATION_V2_DEFAULT_TRAIN_FRACTION = 0.7;
export const HERO_BUILD_OFFLINE_EVALUATION_V2_DEFAULT_VALIDATION_FRACTION = 0.15;
export const HERO_BUILD_OFFLINE_EVALUATION_V2_DEFAULT_BOOTSTRAP_ITERATIONS = 2_000;
export const HERO_BUILD_OFFLINE_EVALUATION_V2_DEFAULT_BOOTSTRAP_SEED = 20_260_717;

export type HeroBuildOfflineEvaluationMetric = 'TOP1' | 'TOP3' | 'COVERAGE';

export interface HeroBuildOfflineEvaluationThreeWaySplit {
  strategy: 'CHRONOLOGICAL_TRAIN_VALIDATION_TEST';
  selected: HeroBuildOfflineEvaluationMatchDescriptor[];
  train: HeroBuildOfflineEvaluationMatchDescriptor[];
  validation: HeroBuildOfflineEvaluationMatchDescriptor[];
  test: HeroBuildOfflineEvaluationMatchDescriptor[];
  trainFraction: number;
  validationFraction: number;
}

export interface HeroBuildOfflinePairedStepOutcome {
  matchId: number;
  playerId: number;
  heroId: number;
  phase: HeroBuildEvaluationPhase;
  baselineMode: HeroBuildRecommendationMode;
  contextualMode: HeroBuildRecommendationMode;
  baselineCovered: boolean;
  contextualCovered: boolean;
  baselineTop1Correct: boolean;
  contextualTop1Correct: boolean;
  baselineTop3Correct: boolean;
  contextualTop3Correct: boolean;
  changedTop1: boolean;
  contextualPromoted: boolean;
  contextualInserted: boolean;
}

export interface HeroBuildOfflineChangedPredictionDiagnostic
  extends HeroBuildOfflinePairedStepOutcome {
  gameTimeS: number;
  stateKey: string;
  enemyHeroIds: number[];
  actualActionKey: string;
  baselineActionKeys: string[];
  contextualActionKeys: string[];
  baselineMatchedStateKey?: string;
  contextualMatchedStateKey?: string;
  baselineStateDistance?: number;
  contextualStateDistance?: number;
  situationalAgainstHeroId?: number;
  situationalLower95OddsRatio?: number;
}

export interface HeroBuildOfflineBootstrapInterval {
  metric: HeroBuildOfflineEvaluationMetric;
  pointEstimatePercentagePoints: number;
  lower95PercentagePoints: number;
  upper95PercentagePoints: number;
  clusterCount: number;
  iterationCount: number;
  seed: number;
}

export interface HeroBuildOfflineMcNemarResult {
  improvedCount: number;
  worsenedCount: number;
  discordantCount: number;
  continuityCorrectedChiSquare: number;
  approximateTwoSidedPValue: number;
}

export interface HeroBuildOfflinePairedStatisticalSummary {
  top1: HeroBuildOfflineBootstrapInterval;
  top3: HeroBuildOfflineBootstrapInterval;
  coverage: HeroBuildOfflineBootstrapInterval;
  top1McNemar: HeroBuildOfflineMcNemarResult;
}

export interface HeroBuildOfflineReleaseGateInput {
  top1DeltaPercentagePoints: number;
  top1Lower95PercentagePoints: number;
  top3DeltaPercentagePoints: number;
  top3Lower95PercentagePoints: number;
  coverageDeltaPercentagePoints: number;
  improvedCount: number;
  worsenedCount: number;
  worstPhaseTop1DeltaPercentagePoints: number;
  worstLargeHeroTop1DeltaPercentagePoints: number;
}

export interface HeroBuildOfflineReleaseGateResult {
  passed: boolean;
  violations: string[];
}

export function splitHeroBuildEvaluationMatchesThreeWay(
  descriptors: readonly HeroBuildOfflineEvaluationMatchDescriptor[],
  trainFraction = HERO_BUILD_OFFLINE_EVALUATION_V2_DEFAULT_TRAIN_FRACTION,
  validationFraction = HERO_BUILD_OFFLINE_EVALUATION_V2_DEFAULT_VALIDATION_FRACTION,
  maxMatches = descriptors.length,
): HeroBuildOfflineEvaluationThreeWaySplit {
  assertFraction('trainFraction', trainFraction);
  assertFraction('validationFraction', validationFraction);
  if (trainFraction + validationFraction >= 1) {
    throw new Error('trainFraction plus validationFraction must be less than 1.');
  }
  if (!Number.isSafeInteger(maxMatches) || maxMatches < 3) {
    throw new Error('maxMatches must be a safe integer of at least 3.');
  }

  const selected = descriptors
    .filter(isValidDescriptor)
    .map(cloneDescriptor)
    .sort(compareDescriptors)
    .slice(-maxMatches);
  if (selected.length < 3) {
    throw new Error('Three-way evaluation requires at least three valid matches.');
  }

  let trainCount = Math.max(1, Math.floor(selected.length * trainFraction));
  let validationCount = Math.max(
    1,
    Math.floor(selected.length * validationFraction),
  );
  while (trainCount + validationCount > selected.length - 1) {
    if (trainCount >= validationCount && trainCount > 1) {
      trainCount -= 1;
    } else if (validationCount > 1) {
      validationCount -= 1;
    } else {
      break;
    }
  }

  const validationEnd = trainCount + validationCount;
  return {
    strategy: 'CHRONOLOGICAL_TRAIN_VALIDATION_TEST',
    selected,
    train: selected.slice(0, trainCount),
    validation: selected.slice(trainCount, validationEnd),
    test: selected.slice(validationEnd),
    trainFraction,
    validationFraction,
  };
}

export function buildHeroBuildOfflinePairedStatisticalSummary(
  outcomes: readonly HeroBuildOfflinePairedStepOutcome[],
  iterationCount = HERO_BUILD_OFFLINE_EVALUATION_V2_DEFAULT_BOOTSTRAP_ITERATIONS,
  seed = HERO_BUILD_OFFLINE_EVALUATION_V2_DEFAULT_BOOTSTRAP_SEED,
): HeroBuildOfflinePairedStatisticalSummary {
  return {
    top1: calculateClusteredPairedBootstrapInterval(
      outcomes,
      'TOP1',
      iterationCount,
      seed,
    ),
    top3: calculateClusteredPairedBootstrapInterval(
      outcomes,
      'TOP3',
      iterationCount,
      seed + 1,
    ),
    coverage: calculateClusteredPairedBootstrapInterval(
      outcomes,
      'COVERAGE',
      iterationCount,
      seed + 2,
    ),
    top1McNemar: calculateTop1McNemar(outcomes),
  };
}

export function calculateClusteredPairedBootstrapInterval(
  outcomes: readonly HeroBuildOfflinePairedStepOutcome[],
  metric: HeroBuildOfflineEvaluationMetric,
  iterationCount = HERO_BUILD_OFFLINE_EVALUATION_V2_DEFAULT_BOOTSTRAP_ITERATIONS,
  seed = HERO_BUILD_OFFLINE_EVALUATION_V2_DEFAULT_BOOTSTRAP_SEED,
): HeroBuildOfflineBootstrapInterval {
  if (!Number.isSafeInteger(iterationCount) || iterationCount < 100) {
    throw new Error('Bootstrap iterationCount must be a safe integer of at least 100.');
  }
  if (!Number.isSafeInteger(seed)) {
    throw new Error('Bootstrap seed must be a safe integer.');
  }

  const clusters = buildMatchClusters(outcomes, metric);
  if (clusters.length === 0) {
    return {
      metric,
      pointEstimatePercentagePoints: 0,
      lower95PercentagePoints: 0,
      upper95PercentagePoints: 0,
      clusterCount: 0,
      iterationCount,
      seed,
    };
  }

  const pointEstimatePercentagePoints = calculateDeltaPercentagePoints(clusters);
  const random = createSeededRandom(seed);
  const bootstrapDeltas: number[] = [];
  for (let iteration = 0; iteration < iterationCount; iteration += 1) {
    let sampleCount = 0;
    let baselineSuccessCount = 0;
    let contextualSuccessCount = 0;
    for (let index = 0; index < clusters.length; index += 1) {
      const cluster = clusters[Math.floor(random() * clusters.length)];
      sampleCount += cluster.sampleCount;
      baselineSuccessCount += cluster.baselineSuccessCount;
      contextualSuccessCount += cluster.contextualSuccessCount;
    }
    bootstrapDeltas.push(
      toPercentagePoints(contextualSuccessCount - baselineSuccessCount, sampleCount),
    );
  }
  bootstrapDeltas.sort((left, right) => left - right);

  return {
    metric,
    pointEstimatePercentagePoints: round(pointEstimatePercentagePoints),
    lower95PercentagePoints: round(percentile(bootstrapDeltas, 0.025)),
    upper95PercentagePoints: round(percentile(bootstrapDeltas, 0.975)),
    clusterCount: clusters.length,
    iterationCount,
    seed,
  };
}

export function calculateTop1McNemar(
  outcomes: readonly HeroBuildOfflinePairedStepOutcome[],
): HeroBuildOfflineMcNemarResult {
  let improvedCount = 0;
  let worsenedCount = 0;
  for (const outcome of outcomes) {
    if (!outcome.baselineTop1Correct && outcome.contextualTop1Correct) {
      improvedCount += 1;
    } else if (outcome.baselineTop1Correct && !outcome.contextualTop1Correct) {
      worsenedCount += 1;
    }
  }

  const discordantCount = improvedCount + worsenedCount;
  const continuityCorrectedChiSquare =
    discordantCount === 0
      ? 0
      : Math.max(0, Math.abs(improvedCount - worsenedCount) - 1) ** 2 /
        discordantCount;
  const approximateTwoSidedPValue =
    discordantCount === 0
      ? 1
      : complementaryErrorFunction(
          Math.sqrt(continuityCorrectedChiSquare / 2),
        );

  return {
    improvedCount,
    worsenedCount,
    discordantCount,
    continuityCorrectedChiSquare: round(continuityCorrectedChiSquare),
    approximateTwoSidedPValue: round(approximateTwoSidedPValue),
  };
}

export function adjustPValuesBenjaminiHochberg<T extends string | number>(
  values: readonly { key: T; pValue: number }[],
): { key: T; pValue: number; adjustedPValue: number }[] {
  const normalized = values.map((value, index) => ({
    key: value.key,
    pValue: clampProbability(value.pValue),
    index,
  }));
  const sorted = [...normalized].sort(
    (left, right) => left.pValue - right.pValue || left.index - right.index,
  );
  const adjustedByIndex = new Map<number, number>();
  let nextAdjusted = 1;
  for (let index = sorted.length - 1; index >= 0; index -= 1) {
    const rank = index + 1;
    const adjusted = Math.min(
      nextAdjusted,
      (sorted[index].pValue * sorted.length) / rank,
    );
    nextAdjusted = adjusted;
    adjustedByIndex.set(sorted[index].index, adjusted);
  }

  return normalized.map((value) => ({
    key: value.key,
    pValue: value.pValue,
    adjustedPValue: round(adjustedByIndex.get(value.index) ?? 1),
  }));
}

export function evaluateHeroBuildOfflineReleaseGates(
  input: HeroBuildOfflineReleaseGateInput,
): HeroBuildOfflineReleaseGateResult {
  const violations: string[] = [];
  if (input.top1DeltaPercentagePoints < 0.1) {
    violations.push('Overall top-1 delta is below +0.10 percentage points.');
  }
  if (input.top1Lower95PercentagePoints <= 0) {
    violations.push('The clustered 95% lower bound for top-1 is not above zero.');
  }
  if (input.top3DeltaPercentagePoints < 0) {
    violations.push('Overall top-3 delta is negative.');
  }
  if (input.top3Lower95PercentagePoints < -0.05) {
    violations.push('The clustered 95% lower bound for top-3 is below -0.05 points.');
  }
  if (input.coverageDeltaPercentagePoints < -0.05) {
    violations.push('Coverage delta is below -0.05 percentage points.');
  }
  if (input.improvedCount <= input.worsenedCount) {
    violations.push('Contextual top-1 improvements do not exceed regressions.');
  }
  if (input.worstPhaseTop1DeltaPercentagePoints < -0.2) {
    violations.push('At least one phase regresses by more than 0.20 top-1 points.');
  }
  if (input.worstLargeHeroTop1DeltaPercentagePoints < -0.5) {
    violations.push('At least one large hero segment regresses by more than 0.50 top-1 points.');
  }

  return { passed: violations.length === 0, violations };
}

interface MatchCluster {
  sampleCount: number;
  baselineSuccessCount: number;
  contextualSuccessCount: number;
}

function buildMatchClusters(
  outcomes: readonly HeroBuildOfflinePairedStepOutcome[],
  metric: HeroBuildOfflineEvaluationMetric,
): MatchCluster[] {
  const byMatchId = new Map<number, MatchCluster>();
  for (const outcome of outcomes) {
    const cluster = byMatchId.get(outcome.matchId) ?? {
      sampleCount: 0,
      baselineSuccessCount: 0,
      contextualSuccessCount: 0,
    };
    cluster.sampleCount += 1;
    cluster.baselineSuccessCount += getSuccess(outcome, metric, 'baseline') ? 1 : 0;
    cluster.contextualSuccessCount += getSuccess(outcome, metric, 'contextual') ? 1 : 0;
    byMatchId.set(outcome.matchId, cluster);
  }
  return [...byMatchId.values()];
}

function getSuccess(
  outcome: HeroBuildOfflinePairedStepOutcome,
  metric: HeroBuildOfflineEvaluationMetric,
  model: 'baseline' | 'contextual',
): boolean {
  if (metric === 'TOP1') {
    return model === 'baseline'
      ? outcome.baselineTop1Correct
      : outcome.contextualTop1Correct;
  }
  if (metric === 'TOP3') {
    return model === 'baseline'
      ? outcome.baselineTop3Correct
      : outcome.contextualTop3Correct;
  }
  return model === 'baseline'
    ? outcome.baselineCovered
    : outcome.contextualCovered;
}

function calculateDeltaPercentagePoints(clusters: readonly MatchCluster[]): number {
  let sampleCount = 0;
  let baselineSuccessCount = 0;
  let contextualSuccessCount = 0;
  for (const cluster of clusters) {
    sampleCount += cluster.sampleCount;
    baselineSuccessCount += cluster.baselineSuccessCount;
    contextualSuccessCount += cluster.contextualSuccessCount;
  }
  return toPercentagePoints(
    contextualSuccessCount - baselineSuccessCount,
    sampleCount,
  );
}

function toPercentagePoints(numerator: number, denominator: number): number {
  return denominator > 0 ? (numerator / denominator) * 100 : 0;
}

function percentile(sortedValues: readonly number[], probability: number): number {
  if (sortedValues.length === 0) {
    return 0;
  }
  const position = (sortedValues.length - 1) * probability;
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  if (lowerIndex === upperIndex) {
    return sortedValues[lowerIndex];
  }
  const weight = position - lowerIndex;
  return (
    sortedValues[lowerIndex] * (1 - weight) +
    sortedValues[upperIndex] * weight
  );
}

function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function complementaryErrorFunction(value: number): number {
  const sign = value < 0 ? -1 : 1;
  const absolute = Math.abs(value);
  const t = 1 / (1 + 0.3275911 * absolute);
  const polynomial =
    (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t -
      0.284496736) *
      t +
      0.254829592) *
    t;
  const erf = sign * (1 - polynomial * Math.exp(-absolute * absolute));
  return clampProbability(1 - erf);
}

function assertFraction(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0 || value >= 1) {
    throw new Error(`${name} must be a finite number greater than 0 and below 1.`);
  }
}

function isValidDescriptor(
  descriptor: HeroBuildOfflineEvaluationMatchDescriptor,
): boolean {
  return (
    Number.isSafeInteger(descriptor.matchId) &&
    descriptor.matchId > 0 &&
    Number.isFinite(descriptor.startTime.getTime())
  );
}

function cloneDescriptor(
  descriptor: HeroBuildOfflineEvaluationMatchDescriptor,
): HeroBuildOfflineEvaluationMatchDescriptor {
  return {
    matchId: descriptor.matchId,
    startTime: new Date(descriptor.startTime),
  };
}

function compareDescriptors(
  left: HeroBuildOfflineEvaluationMatchDescriptor,
  right: HeroBuildOfflineEvaluationMatchDescriptor,
): number {
  const timeDifference = left.startTime.getTime() - right.startTime.getTime();
  return timeDifference !== 0 ? timeDifference : left.matchId - right.matchId;
}

function clampProbability(value: number): number {
  if (!Number.isFinite(value)) {
    return 1;
  }
  return Math.max(0, Math.min(1, value));
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
