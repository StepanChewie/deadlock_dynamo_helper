import type { HeroBuildOfflineModelPrediction } from './hero-build-offline-evaluation.model';
import type {
  HeroBuildOfflineEvaluationComparison,
  HeroBuildOfflineEvaluationMetrics,
} from './hero-build-offline-evaluation.service';
import type {
  HeroBuildOfflineBootstrapInterval,
  HeroBuildOfflineMcNemarResult,
  HeroBuildOfflinePairedStatisticalSummary,
} from './hero-build-offline-evaluation-v2';

export interface HeroBuildOfflineV2MatchCluster {
  matchId: number;
  sampleCount: number;
  baselineCoveredCount: number;
  contextualCoveredCount: number;
  baselineTop1Count: number;
  contextualTop1Count: number;
  baselineTop3Count: number;
  contextualTop3Count: number;
}

export interface HeroBuildOfflineV2ComparisonSnapshot {
  comparison: HeroBuildOfflineEvaluationComparison;
  clusters: HeroBuildOfflineV2MatchCluster[];
}

export class HeroBuildOfflineV2ComparisonAccumulator {
  private readonly baseline: PredictionMetricsAccumulator;
  private readonly contextual: PredictionMetricsAccumulator;
  private readonly clustersByMatchId = new Map<
    number,
    HeroBuildOfflineV2MatchCluster
  >();
  private changedTop1Count = 0;
  private contextualImprovedCount = 0;
  private contextualWorsenedCount = 0;
  private bothTop1CorrectCount = 0;
  private bothTop1WrongCount = 0;

  constructor(snapshot?: HeroBuildOfflineV2ComparisonSnapshot) {
    this.baseline = new PredictionMetricsAccumulator(
      snapshot?.comparison.baseline,
    );
    this.contextual = new PredictionMetricsAccumulator(
      snapshot?.comparison.contextual,
    );
    if (!snapshot) {
      return;
    }
    this.changedTop1Count = snapshot.comparison.changedTop1Count;
    this.contextualImprovedCount =
      snapshot.comparison.contextualImprovedCount;
    this.contextualWorsenedCount =
      snapshot.comparison.contextualWorsenedCount;
    this.bothTop1CorrectCount = snapshot.comparison.bothTop1CorrectCount;
    this.bothTop1WrongCount = snapshot.comparison.bothTop1WrongCount;
    for (const cluster of snapshot.clusters) {
      this.clustersByMatchId.set(cluster.matchId, { ...cluster });
    }
  }

  add(
    matchId: number,
    baseline: HeroBuildOfflineModelPrediction,
    contextual: HeroBuildOfflineModelPrediction,
    actualActionKey: string,
  ): void {
    this.baseline.add(baseline, actualActionKey);
    this.contextual.add(contextual, actualActionKey);

    const baselineTop1Correct = baseline.topActionKey === actualActionKey;
    const contextualTop1Correct = contextual.topActionKey === actualActionKey;
    const baselineTop3Correct = baseline.actionKeys
      .slice(0, 3)
      .includes(actualActionKey);
    const contextualTop3Correct = contextual.actionKeys
      .slice(0, 3)
      .includes(actualActionKey);
    if (baseline.topActionKey !== contextual.topActionKey) {
      this.changedTop1Count += 1;
    }
    if (!baselineTop1Correct && contextualTop1Correct) {
      this.contextualImprovedCount += 1;
    } else if (baselineTop1Correct && !contextualTop1Correct) {
      this.contextualWorsenedCount += 1;
    } else if (baselineTop1Correct && contextualTop1Correct) {
      this.bothTop1CorrectCount += 1;
    } else {
      this.bothTop1WrongCount += 1;
    }

    const cluster =
      this.clustersByMatchId.get(matchId) ?? createCluster(matchId);
    cluster.sampleCount += 1;
    cluster.baselineCoveredCount += baseline.covered ? 1 : 0;
    cluster.contextualCoveredCount += contextual.covered ? 1 : 0;
    cluster.baselineTop1Count += baselineTop1Correct ? 1 : 0;
    cluster.contextualTop1Count += contextualTop1Correct ? 1 : 0;
    cluster.baselineTop3Count += baselineTop3Correct ? 1 : 0;
    cluster.contextualTop3Count += contextualTop3Correct ? 1 : 0;
    this.clustersByMatchId.set(matchId, cluster);
  }

  buildComparison(): HeroBuildOfflineEvaluationComparison {
    const baseline = this.baseline.build();
    const contextual = this.contextual.build();
    return {
      baseline,
      contextual,
      coverageDeltaPercentagePoints: round(
        contextual.coveragePercent - baseline.coveragePercent,
      ),
      top1DeltaPercentagePoints: round(
        contextual.top1AccuracyPercent - baseline.top1AccuracyPercent,
      ),
      top3DeltaPercentagePoints: round(
        contextual.top3AccuracyPercent - baseline.top3AccuracyPercent,
      ),
      changedTop1Count: this.changedTop1Count,
      contextualImprovedCount: this.contextualImprovedCount,
      contextualWorsenedCount: this.contextualWorsenedCount,
      bothTop1CorrectCount: this.bothTop1CorrectCount,
      bothTop1WrongCount: this.bothTop1WrongCount,
    };
  }

  buildSnapshot(): HeroBuildOfflineV2ComparisonSnapshot {
    return {
      comparison: this.buildComparison(),
      clusters: [...this.clustersByMatchId.values()]
        .map((cluster) => ({ ...cluster }))
        .sort((left, right) => left.matchId - right.matchId),
    };
  }
}

export function buildHeroBuildOfflineV2StatisticalSummary(
  snapshot: HeroBuildOfflineV2ComparisonSnapshot,
  iterationCount: number,
  seed: number,
): HeroBuildOfflinePairedStatisticalSummary {
  return {
    top1: calculateClusteredInterval(
      snapshot.clusters,
      'TOP1',
      iterationCount,
      seed,
    ),
    top3: calculateClusteredInterval(
      snapshot.clusters,
      'TOP3',
      iterationCount,
      seed + 1,
    ),
    coverage: calculateClusteredInterval(
      snapshot.clusters,
      'COVERAGE',
      iterationCount,
      seed + 2,
    ),
    top1McNemar: calculateMcNemarFromComparison(snapshot.comparison),
  };
}

export function calculateMcNemarFromComparison(
  comparison: HeroBuildOfflineEvaluationComparison,
): HeroBuildOfflineMcNemarResult {
  const improvedCount = comparison.contextualImprovedCount;
  const worsenedCount = comparison.contextualWorsenedCount;
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

function calculateClusteredInterval(
  clusters: readonly HeroBuildOfflineV2MatchCluster[],
  metric: HeroBuildOfflineBootstrapInterval['metric'],
  iterationCount: number,
  seed: number,
): HeroBuildOfflineBootstrapInterval {
  if (!Number.isSafeInteger(iterationCount) || iterationCount < 100) {
    throw new Error(
      'Bootstrap iteration count must be a safe integer of at least 100.',
    );
  }
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

  const pointEstimatePercentagePoints = calculateClusterDelta(
    clusters,
    metric,
  );
  const random = createSeededRandom(seed);
  const values: number[] = [];
  for (let iteration = 0; iteration < iterationCount; iteration += 1) {
    let sampleCount = 0;
    let baselineCount = 0;
    let contextualCount = 0;
    for (let index = 0; index < clusters.length; index += 1) {
      const cluster = clusters[Math.floor(random() * clusters.length)];
      sampleCount += cluster.sampleCount;
      baselineCount += getClusterCount(cluster, metric, 'baseline');
      contextualCount += getClusterCount(cluster, metric, 'contextual');
    }
    values.push(
      toPercentagePoints(contextualCount - baselineCount, sampleCount),
    );
  }
  values.sort((left, right) => left - right);

  return {
    metric,
    pointEstimatePercentagePoints: round(pointEstimatePercentagePoints),
    lower95PercentagePoints: round(percentile(values, 0.025)),
    upper95PercentagePoints: round(percentile(values, 0.975)),
    clusterCount: clusters.length,
    iterationCount,
    seed,
  };
}

function calculateClusterDelta(
  clusters: readonly HeroBuildOfflineV2MatchCluster[],
  metric: HeroBuildOfflineBootstrapInterval['metric'],
): number {
  let sampleCount = 0;
  let baselineCount = 0;
  let contextualCount = 0;
  for (const cluster of clusters) {
    sampleCount += cluster.sampleCount;
    baselineCount += getClusterCount(cluster, metric, 'baseline');
    contextualCount += getClusterCount(cluster, metric, 'contextual');
  }
  return toPercentagePoints(
    contextualCount - baselineCount,
    sampleCount,
  );
}

function getClusterCount(
  cluster: HeroBuildOfflineV2MatchCluster,
  metric: HeroBuildOfflineBootstrapInterval['metric'],
  model: 'baseline' | 'contextual',
): number {
  if (metric === 'TOP1') {
    return model === 'baseline'
      ? cluster.baselineTop1Count
      : cluster.contextualTop1Count;
  }
  if (metric === 'TOP3') {
    return model === 'baseline'
      ? cluster.baselineTop3Count
      : cluster.contextualTop3Count;
  }
  return model === 'baseline'
    ? cluster.baselineCoveredCount
    : cluster.contextualCoveredCount;
}

class PredictionMetricsAccumulator {
  private sampleCount = 0;
  private coveredCount = 0;
  private top1Count = 0;
  private top3Count = 0;
  private exactModeCount = 0;
  private backoffModeCount = 0;
  private noMatchCount = 0;

  constructor(metrics?: HeroBuildOfflineEvaluationMetrics) {
    if (!metrics) {
      return;
    }
    this.sampleCount = metrics.sampleCount;
    this.coveredCount = metrics.coveredCount;
    this.top1Count = metrics.top1Count;
    this.top3Count = metrics.top3Count;
    this.exactModeCount = metrics.exactModeCount;
    this.backoffModeCount = metrics.backoffModeCount;
    this.noMatchCount = metrics.noMatchCount;
  }

  add(
    prediction: HeroBuildOfflineModelPrediction,
    actualActionKey: string,
  ): void {
    this.sampleCount += 1;
    this.coveredCount += prediction.covered ? 1 : 0;
    this.top1Count +=
      prediction.topActionKey === actualActionKey ? 1 : 0;
    this.top3Count += prediction.actionKeys
      .slice(0, 3)
      .includes(actualActionKey)
      ? 1
      : 0;
    if (prediction.mode === 'EXACT') {
      this.exactModeCount += 1;
    } else if (prediction.mode === 'BACKOFF') {
      this.backoffModeCount += 1;
    } else {
      this.noMatchCount += 1;
    }
  }

  build(): HeroBuildOfflineEvaluationMetrics {
    const coverage = ratio(this.coveredCount, this.sampleCount);
    const top1Accuracy = ratio(this.top1Count, this.sampleCount);
    const top3Accuracy = ratio(this.top3Count, this.sampleCount);
    const top1AccuracyWhenCovered = ratio(
      this.top1Count,
      this.coveredCount,
    );
    const top3AccuracyWhenCovered = ratio(
      this.top3Count,
      this.coveredCount,
    );
    return {
      sampleCount: this.sampleCount,
      coveredCount: this.coveredCount,
      coverage,
      coveragePercent: toPercent(coverage),
      top1Count: this.top1Count,
      top1Accuracy,
      top1AccuracyPercent: toPercent(top1Accuracy),
      top1AccuracyWhenCovered,
      top1AccuracyWhenCoveredPercent: toPercent(
        top1AccuracyWhenCovered,
      ),
      top3Count: this.top3Count,
      top3Accuracy,
      top3AccuracyPercent: toPercent(top3Accuracy),
      top3AccuracyWhenCovered,
      top3AccuracyWhenCoveredPercent: toPercent(
        top3AccuracyWhenCovered,
      ),
      exactModeCount: this.exactModeCount,
      backoffModeCount: this.backoffModeCount,
      noMatchCount: this.noMatchCount,
    };
  }
}

function createCluster(matchId: number): HeroBuildOfflineV2MatchCluster {
  return {
    matchId,
    sampleCount: 0,
    baselineCoveredCount: 0,
    contextualCoveredCount: 0,
    baselineTop1Count: 0,
    contextualTop1Count: 0,
    baselineTop3Count: 0,
    contextualTop3Count: 0,
  };
}

function ratio(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

function toPercent(value: number): number {
  return round(value * 100);
}

function toPercentagePoints(
  numerator: number,
  denominator: number,
): number {
  return denominator > 0 ? (numerator / denominator) * 100 : 0;
}

function percentile(
  sortedValues: readonly number[],
  probability: number,
): number {
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
    (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) *
        t -
      0.284496736) *
      t +
      0.254829592) *
    t;
  const erf =
    sign * (1 - polynomial * Math.exp(-absolute * absolute));
  return Math.max(0, Math.min(1, 1 - erf));
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
