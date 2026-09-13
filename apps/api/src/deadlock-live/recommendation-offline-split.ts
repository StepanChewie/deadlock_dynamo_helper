import { createHash } from 'node:crypto';

export interface RecommendationOfflineMatchDescriptor {
  matchId: string;
  firstObservedAt: string;
}

export interface RecommendationOfflineSplitOptions {
  trainFraction: number;
  tuningFraction: number;
}

export interface RecommendationOfflineThreeWaySplit<
  T extends RecommendationOfflineMatchDescriptor,
> {
  train: T[];
  tuning: T[];
  test: T[];
  descriptorSha256: string;
}

export function selectRecommendationOfflineThreeWaySplit<
  T extends RecommendationOfflineMatchDescriptor,
>(
  descriptors: readonly T[],
  options: RecommendationOfflineSplitOptions,
): RecommendationOfflineThreeWaySplit<T> {
  if (descriptors.length < 3) {
    throw new Error('At least three matches are required for train, tuning, and test splits.');
  }
  validateFraction(options.trainFraction, 'trainFraction');
  validateFraction(options.tuningFraction, 'tuningFraction');
  if (options.trainFraction + options.tuningFraction >= 1) {
    throw new Error('trainFraction plus tuningFraction must be less than one.');
  }

  const sorted = [...descriptors].sort(compareDescriptors);
  const trainCount = boundedSplitCount(
    Math.floor(sorted.length * options.trainFraction),
    1,
    sorted.length - 2,
  );
  const maximumTuningCount = sorted.length - trainCount - 1;
  const tuningCount = boundedSplitCount(
    Math.floor(sorted.length * options.tuningFraction),
    1,
    maximumTuningCount,
  );
  const train = sorted.slice(0, trainCount);
  const tuning = sorted.slice(trainCount, trainCount + tuningCount);
  const test = sorted.slice(trainCount + tuningCount);

  assertNoOverlap(train, tuning, test);
  return {
    train,
    tuning,
    test,
    descriptorSha256: hashDescriptors(sorted),
  };
}

function validateFraction(value: number, fieldName: string): void {
  if (!Number.isFinite(value) || value <= 0 || value >= 1) {
    throw new Error(`${fieldName} must be greater than zero and less than one.`);
  }
}

function boundedSplitCount(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function compareDescriptors(
  left: RecommendationOfflineMatchDescriptor,
  right: RecommendationOfflineMatchDescriptor,
): number {
  const timeDelta = parseTimestamp(left.firstObservedAt) - parseTimestamp(right.firstObservedAt);
  return timeDelta || left.matchId.localeCompare(right.matchId);
}

function parseTimestamp(value: string): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new Error(`Invalid match timestamp: ${value}.`);
  }
  return timestamp;
}

function assertNoOverlap<
  T extends RecommendationOfflineMatchDescriptor,
>(train: readonly T[], tuning: readonly T[], test: readonly T[]): void {
  const trainIds = new Set(train.map((descriptor) => descriptor.matchId));
  const tuningIds = new Set(tuning.map((descriptor) => descriptor.matchId));
  const testIds = new Set(test.map((descriptor) => descriptor.matchId));
  const overlap = [
    ...[...trainIds].filter((matchId) => tuningIds.has(matchId)),
    ...[...trainIds].filter((matchId) => testIds.has(matchId)),
    ...[...tuningIds].filter((matchId) => testIds.has(matchId)),
  ];
  if (overlap.length > 0) {
    throw new Error(`Match split overlap detected for ${overlap[0]}.`);
  }
}

function hashDescriptors(
  descriptors: readonly RecommendationOfflineMatchDescriptor[],
): string {
  return createHash('sha256')
    .update(
      descriptors
        .map((descriptor) => `${descriptor.matchId}:${descriptor.firstObservedAt}`)
        .join('\n'),
    )
    .digest('hex');
}
