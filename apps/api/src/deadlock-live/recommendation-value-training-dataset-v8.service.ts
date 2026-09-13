import { createHash } from 'crypto';
import { once } from 'events';
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'fs';
import { join, resolve } from 'path';
import { createGzip } from 'zlib';
import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  EXACT_ACTION_PROPENSITY_SOURCE,
  RECOMMENDATION_FEATURE_CONTRACT_VERSION,
  RECOMMENDATION_VALUE_DATASET_MANIFEST_V1,
  RECOMMENDATION_VALUE_TRAINING_EXAMPLE_V1,
  RecommendationActionFeatureV8,
  RecommendationValueDatasetFileV1,
  RecommendationValueDatasetManifestV1,
  RecommendationValueDatasetSplitV1,
  RecommendationValueTrainingExampleV1,
  RecommendationValueTrainingSplitV1,
  validateRecommendationValueDatasetManifestV1,
  validateRecommendationValueTrainingExampleV1,
} from '@deadlock-live-probe/shared';
import { RecommendationFeatureStoreV8Service } from './recommendation-feature-store-v8.service';
import { RecommendationOpeRewardV1 } from './recommendation-ope-report.service';
import { RecommendationValueTrainingLaunchV8Service } from './recommendation-value-training-launch-v8.service';

export interface RecommendationValueTrainingSplitWindowV1 {
  split: RecommendationValueTrainingSplitV1;
  from: string;
  to: string;
}

export interface RecommendationValueTrainingDatasetExportV1Options {
  datasetId: string;
  sourceCommitSha: string;
  actionContractVersion: string;
  candidateGeneratorVersion: string;
  reward: RecommendationOpeRewardV1;
  outputDir: string;
  splits: readonly RecommendationValueTrainingSplitWindowV1[];
  maximumAlignmentAgeMs?: number;
  maximumHistoryEvents?: number;
  minimumExportCoverage?: number;
}

export interface RecommendationValueTrainingDatasetPreflightV1 {
  ready: boolean;
  blockers: readonly string[];
  splitMatchCounts: Readonly<Record<string, number>>;
  splitDecisionCounts: Readonly<Record<string, number>>;
  futureTestEvaluated: false;
}

export interface RecommendationValueTrainingDatasetExportReportV1 {
  datasetId: string;
  generatedAt: string;
  emittedDecisionCount: number;
  skippedDecisionCount: number;
  skipReasons: Readonly<Record<string, number>>;
  futureTestEvaluated: false;
  manifest: RecommendationValueDatasetManifestV1;
}

interface ValueDecisionRow {
  decisionId: string;
  matchId: string;
  selectedActionKey: string;
  candidateGeneratorVersion: string;
  actionLoggingPropensity: string | number;
  reward: string | number | boolean;
}

interface CandidateRow {
  actionKey: string;
  actionType: RecommendationActionFeatureV8['actionType'];
  targetItemId?: string | number;
  sellItemId?: string | number;
  recipeId?: string;
  effectiveCostSouls: string | number;
  feasible: boolean;
}

interface CountRow {
  matchCount: string | number;
  decisionCount: string | number;
}

const REQUIRED_SPLITS: readonly RecommendationValueTrainingSplitV1[] = [
  'TRAIN',
  'VALIDATION',
  'SHADOW_HOLDOUT',
];

@Injectable()
export class RecommendationValueTrainingDatasetV8Service {
  constructor(
    private readonly dataSource: DataSource,
    private readonly featureStore: RecommendationFeatureStoreV8Service,
    private readonly valueTraining: RecommendationValueTrainingLaunchV8Service,
  ) {}

  async preflight(
    options: RecommendationValueTrainingDatasetExportV1Options,
  ): Promise<RecommendationValueTrainingDatasetPreflightV1> {
    const blockers = validateOptions(options);
    const splitMatchCounts: Record<string, number> = {};
    const splitDecisionCounts: Record<string, number> = {};
    if (blockers.length > 0) {
      return { ready: false, blockers, splitMatchCounts, splitDecisionCounts, futureTestEvaluated: false };
    }
    const from = new Date(options.splits[0].from);
    const to = new Date(options.splits[options.splits.length - 1].to);
    const launch = await this.valueTraining.preflight({ reward: options.reward, from, to });
    if (!launch.ready) blockers.push(...launch.blockers.map((blocker) => `VALUE_TRAINING:${blocker}`));
    if (launch.futureTestEvaluated) blockers.push('FUTURE_TEST_ALREADY_EVALUATED');
    if (!launch.futureTestUntouched) blockers.push('FUTURE_TEST_INTEGRITY_VIOLATION');

    for (const split of options.splits) {
      const counts = await this.splitCounts(options.candidateGeneratorVersion, options.reward, split);
      splitMatchCounts[split.split] = counts.matchCount;
      splitDecisionCounts[split.split] = counts.decisionCount;
      if (counts.matchCount === 0) blockers.push(`SPLIT_EMPTY_MATCH_SET:${split.split}`);
      if (counts.decisionCount === 0) blockers.push(`SPLIT_EMPTY_DECISION_SET:${split.split}`);
    }
    return {
      ready: blockers.length === 0,
      blockers: [...new Set(blockers)].sort(),
      splitMatchCounts,
      splitDecisionCounts,
      futureTestEvaluated: false,
    };
  }

  async export(
    options: RecommendationValueTrainingDatasetExportV1Options,
  ): Promise<RecommendationValueTrainingDatasetExportReportV1> {
    const preflight = await this.preflight(options);
    if (!preflight.ready) throw new Error(`Causal Value dataset export is blocked: ${preflight.blockers.join(',')}`);
    const outputDir = resolve(options.outputDir);
    assertFreshOutputDirectory(outputDir);
    mkdirSync(join(outputDir, 'splits'), { recursive: true });
    const files: RecommendationValueDatasetFileV1[] = [];
    const splitDescriptors: RecommendationValueDatasetSplitV1[] = [];
    const skipReasons = new Map<string, number>();
    let emittedDecisionCount = 0;
    let skippedDecisionCount = 0;
    const minimumExportCoverage = options.minimumExportCoverage ?? 0.99;

    for (const split of options.splits) {
      const decisions = await this.loadSplitDecisions(options.candidateGeneratorVersion, options.reward, split);
      const relativePath = `splits/${split.split.toLowerCase()}.jsonl.gz`;
      const absolutePath = join(outputDir, relativePath);
      const gzip = createGzip({ level: 9 });
      const output = createWriteStream(absolutePath, { flags: 'wx' });
      gzip.pipe(output);
      const matchIds = new Set<string>();
      let rowCount = 0;

      for (const decision of decisions) {
        const built = await this.buildExample(decision, split.split, options);
        if (!built.example) {
          skippedDecisionCount += 1;
          increment(skipReasons, built.reason ?? 'UNKNOWN_SKIP_REASON');
          continue;
        }
        if (!gzip.write(`${JSON.stringify(built.example)}\n`)) await once(gzip, 'drain');
        matchIds.add(decision.matchId);
        rowCount += 1;
        emittedDecisionCount += 1;
      }
      await endGzip(gzip, output);
      if (rowCount === 0) throw new Error(`Exported causal Value split is empty: ${split.split}`);
      const coverage = decisions.length > 0 ? rowCount / decisions.length : 0;
      if (coverage < minimumExportCoverage) {
        throw new Error(`Causal Value export coverage below gate for ${split.split}: ${coverage} < ${minimumExportCoverage}`);
      }
      files.push(await artifactFile(relativePath, absolutePath, rowCount));
      splitDescriptors.push({
        split: split.split,
        from: new Date(split.from).toISOString(),
        to: new Date(split.to).toISOString(),
        matchCount: matchIds.size,
        decisionCount: rowCount,
        matchSetSha256: hashStrings([...matchIds].sort()),
      });
    }

    const manifestBase = {
      contractVersion: RECOMMENDATION_VALUE_DATASET_MANIFEST_V1,
      datasetId: options.datasetId,
      createdAt: new Date().toISOString(),
      sourceCommitSha: options.sourceCommitSha,
      reward: options.reward,
      featureContractVersion: RECOMMENDATION_FEATURE_CONTRACT_VERSION,
      actionContractVersion: options.actionContractVersion,
      candidateGeneratorVersion: options.candidateGeneratorVersion,
      pointInTimeCorrect: true as const,
      randomizedOnly: true as const,
      exactActionPropensityOnly: true as const,
      futureTestEvaluated: false as const,
      splits: splitDescriptors,
      files,
    };
    const datasetSha256 = createHash('sha256').update(canonicalJson(manifestBase)).digest('hex');
    const manifest: RecommendationValueDatasetManifestV1 = { ...manifestBase, datasetSha256 };
    const validation = validateRecommendationValueDatasetManifestV1(manifest);
    if (validation.length > 0) throw new Error(`Invalid causal Value manifest: ${validation.join(',')}`);
    writeFileSync(join(outputDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
    const report: RecommendationValueTrainingDatasetExportReportV1 = {
      datasetId: options.datasetId,
      generatedAt: new Date().toISOString(),
      emittedDecisionCount,
      skippedDecisionCount,
      skipReasons: Object.fromEntries([...skipReasons.entries()].sort(([a], [b]) => a.localeCompare(b))),
      futureTestEvaluated: false,
      manifest,
    };
    writeFileSync(join(outputDir, 'export-report.json'), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
    return report;
  }

  private async buildExample(
    decision: ValueDecisionRow,
    split: RecommendationValueTrainingSplitV1,
    options: RecommendationValueTrainingDatasetExportV1Options,
  ): Promise<{ example?: RecommendationValueTrainingExampleV1; reason?: string }> {
    const feature = await this.featureStore.buildForDecision(
      decision.decisionId,
      options.maximumAlignmentAgeMs ?? 5_000,
      options.maximumHistoryEvents ?? 64,
    );
    if (!feature.ready || !feature.featureState) return { reason: `FEATURE_STATE:${feature.blockers.join('|') || 'NOT_READY'}` };
    const candidates = (await this.loadCandidates(decision.decisionId))
      .filter((candidate) => candidate.feasible)
      .map(toActionFeature);
    const reward = numericReward(decision.reward);
    if (reward === undefined) return { reason: 'REWARD_INVALID' };
    const propensity = numeric(decision.actionLoggingPropensity);
    const example: RecommendationValueTrainingExampleV1 = {
      contractVersion: RECOMMENDATION_VALUE_TRAINING_EXAMPLE_V1,
      split,
      decisionId: decision.decisionId,
      matchId: decision.matchId,
      candidateGeneratorVersion: decision.candidateGeneratorVersion,
      state: feature.featureState,
      candidates,
      loggedActionKey: decision.selectedActionKey,
      reward,
      actionLoggingPropensity: propensity,
      actionLoggingPropensitySource: EXACT_ACTION_PROPENSITY_SOURCE,
      randomized: true,
    };
    const errors = validateRecommendationValueTrainingExampleV1(example);
    return errors.length > 0 ? { reason: `EXAMPLE_INVALID:${errors.join('|')}` } : { example };
  }

  private async splitCounts(
    candidateGeneratorVersion: string,
    reward: RecommendationOpeRewardV1,
    split: RecommendationValueTrainingSplitWindowV1,
  ): Promise<{ matchCount: number; decisionCount: number }> {
    const rows = await this.dataSource.query(
      countSql(rewardSqlExpression(reward)),
      [candidateGeneratorVersion, new Date(split.from).toISOString(), new Date(split.to).toISOString()],
    ) as CountRow[];
    return {
      matchCount: numeric(rows[0]?.matchCount ?? 0),
      decisionCount: numeric(rows[0]?.decisionCount ?? 0),
    };
  }

  private async loadSplitDecisions(
    candidateGeneratorVersion: string,
    reward: RecommendationOpeRewardV1,
    split: RecommendationValueTrainingSplitWindowV1,
  ): Promise<ValueDecisionRow[]> {
    return this.dataSource.query(
      decisionSql(rewardSqlExpression(reward)),
      [candidateGeneratorVersion, new Date(split.from).toISOString(), new Date(split.to).toISOString()],
    ) as Promise<ValueDecisionRow[]>;
  }

  private async loadCandidates(decisionId: string): Promise<CandidateRow[]> {
    return this.dataSource.query(
      `SELECT "actionKey", "actionType", "targetItemId", "sellItemId", "recipeId", "effectiveCostSouls", "feasible"
       FROM recommendation_decision_candidates_v8
       WHERE "decisionId" = $1
       ORDER BY "actionKey"`,
      [decisionId],
    ) as Promise<CandidateRow[]>;
  }
}

function decisionSql(rewardExpression: string): string {
  return `
WITH match_bounds AS (
  SELECT d."matchId", MIN(d."decidedAt") AS first_decision_at, MAX(d."decidedAt") AS last_decision_at
  FROM recommendation_decisions_v8 d
  WHERE d."randomized" IS TRUE AND d."candidateGeneratorVersion" = $1
  GROUP BY d."matchId"
), outcomes AS (
  SELECT DISTINCT ON (e."payload"->>'decisionId')
    e."payload"->>'decisionId' AS decision_id,
    e."payload" AS payload
  FROM recommendation_telemetry_events e
  WHERE e."eventType" = 'RECOMMENDATION_OUTCOME'
    AND COALESCE(e."payload"->>'decisionId', '') <> ''
    AND e."sourceOccurredAt" < $3::timestamptz
    AND e."receivedAt" < $3::timestamptz
  ORDER BY e."payload"->>'decisionId', e."sourceOccurredAt" DESC, e."receivedAt" DESC
)
SELECT
  d."decisionId" AS "decisionId",
  d."matchId" AS "matchId",
  d."selectedActionKey" AS "selectedActionKey",
  d."candidateGeneratorVersion" AS "candidateGeneratorVersion",
  d."actionLoggingPropensity" AS "actionLoggingPropensity",
  ${rewardExpression} AS reward
FROM recommendation_decisions_v8 d
JOIN match_bounds m ON m."matchId" = d."matchId"
JOIN outcomes o ON o.decision_id = d."decisionId"
WHERE d."randomized" IS TRUE
  AND d."candidateGeneratorVersion" = $1
  AND m.first_decision_at >= $2::timestamptz
  AND m.last_decision_at < $3::timestamptz
  AND (${rewardExpression}) IS NOT NULL
ORDER BY d."decidedAt", d."decisionId"
`;
}

function countSql(rewardExpression: string): string {
  return `
WITH rows AS (${decisionSql(rewardExpression)})
SELECT COUNT(DISTINCT "matchId") AS "matchCount", COUNT(*) AS "decisionCount" FROM rows
`;
}

function rewardSqlExpression(reward: RecommendationOpeRewardV1): string {
  switch (reward) {
    case 'economyDelta120s': return `CASE WHEN (o.payload->>'economyDelta120s') ~ '^-?[0-9]+(?:\\.[0-9]+)?$' THEN (o.payload->>'economyDelta120s')::double precision END`;
    case 'economyDelta300s': return `CASE WHEN (o.payload->>'economyDelta300s') ~ '^-?[0-9]+(?:\\.[0-9]+)?$' THEN (o.payload->>'economyDelta300s')::double precision END`;
    case 'objectiveDelta300s': return `CASE WHEN (o.payload->>'objectiveDelta300s') ~ '^-?[0-9]+(?:\\.[0-9]+)?$' THEN (o.payload->>'objectiveDelta300s')::double precision END`;
    case 'finalPlayerWon': return `CASE WHEN o.payload->>'finalPlayerWon' = 'true' THEN 1.0 WHEN o.payload->>'finalPlayerWon' = 'false' THEN 0.0 END`;
  }
}

function toActionFeature(candidate: CandidateRow): RecommendationActionFeatureV8 {
  return {
    actionKey: candidate.actionKey,
    actionType: candidate.actionType,
    targetItemId: optionalNumber(candidate.targetItemId),
    sellItemId: optionalNumber(candidate.sellItemId),
    recipeId: candidate.recipeId,
    effectiveCostSouls: numeric(candidate.effectiveCostSouls),
  };
}

function validateOptions(options: RecommendationValueTrainingDatasetExportV1Options): string[] {
  const errors: string[] = [];
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(options.datasetId)) errors.push('DATASET_ID_INVALID');
  if (!/^[a-f0-9]{40}$/i.test(options.sourceCommitSha)) errors.push('SOURCE_COMMIT_SHA_INVALID');
  if (!options.actionContractVersion) errors.push('ACTION_CONTRACT_VERSION_REQUIRED');
  if (!options.candidateGeneratorVersion) errors.push('CANDIDATE_GENERATOR_VERSION_REQUIRED');
  if (!options.outputDir) errors.push('OUTPUT_DIR_REQUIRED');
  if (
    options.maximumAlignmentAgeMs !== undefined
    && (!Number.isInteger(options.maximumAlignmentAgeMs) || options.maximumAlignmentAgeMs < 0)
  ) errors.push('MAXIMUM_ALIGNMENT_AGE_INVALID');
  if (
    options.maximumHistoryEvents !== undefined
    && (!Number.isInteger(options.maximumHistoryEvents) || options.maximumHistoryEvents < 0)
  ) errors.push('MAXIMUM_HISTORY_EVENTS_INVALID');
  if (
    options.minimumExportCoverage !== undefined
    && (!Number.isFinite(options.minimumExportCoverage) || options.minimumExportCoverage < 0.99 || options.minimumExportCoverage > 1)
  ) errors.push('MINIMUM_EXPORT_COVERAGE_INVALID');
  if (options.splits.length !== REQUIRED_SPLITS.length) errors.push('SPLIT_COUNT_INVALID');
  let previousTo: number | undefined;
  for (let index = 0; index < options.splits.length; index += 1) {
    const split = options.splits[index];
    if (split.split !== REQUIRED_SPLITS[index]) errors.push(`SPLIT_ORDER_INVALID:${split.split}`);
    const from = Date.parse(split.from);
    const to = Date.parse(split.to);
    if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) errors.push(`SPLIT_RANGE_INVALID:${split.split}`);
    if (previousTo !== undefined && from !== previousTo) errors.push(`SPLIT_BOUNDARY_NOT_CONTIGUOUS:${split.split}`);
    previousTo = to;
  }
  return [...new Set(errors)].sort();
}

function assertFreshOutputDirectory(outputDir: string): void {
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
    return;
  }
  if (!statSync(outputDir).isDirectory()) throw new Error('Causal Value dataset output path is not a directory');
  if (readdirSync(outputDir).length > 0) throw new Error('Causal Value dataset output directory must be empty');
}

async function artifactFile(path: string, absolutePath: string, rowCount: number): Promise<RecommendationValueDatasetFileV1> {
  const digest = createHash('sha256');
  const stream = createReadStream(absolutePath);
  for await (const chunk of stream) digest.update(chunk);
  return {
    path,
    sha256: digest.digest('hex'),
    sizeBytes: statSync(absolutePath).size,
    rowCount,
  };
}

function endGzip(gzip: ReturnType<typeof createGzip>, output: ReturnType<typeof createWriteStream>): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    output.once('finish', resolvePromise);
    output.once('error', reject);
    gzip.once('error', reject);
    gzip.end();
  });
}

function increment(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function hashStrings(values: readonly string[]): string {
  return createHash('sha256').update(values.join('\n')).digest('hex');
}

function numeric(value: string | number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Expected finite numeric value, got ${String(value)}`);
  return parsed;
}

function numericReward(value: string | number | boolean): number | undefined {
  if (typeof value === 'boolean') return value ? 1 : 0;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function optionalNumber(value: string | number | undefined): number | undefined {
  if (value === undefined) return undefined;
  return numeric(value);
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}
