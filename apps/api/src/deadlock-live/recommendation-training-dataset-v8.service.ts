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
  RECOMMENDATION_BEHAVIORAL_TRAINING_EXAMPLE_V1,
  RECOMMENDATION_DATASET_MANIFEST_VERSION,
  RECOMMENDATION_FEATURE_CONTRACT_VERSION,
  RecommendationBehavioralTrainingExampleV1,
  RecommendationDatasetArtifactFileV1,
  RecommendationDatasetManifestV1,
  RecommendationDatasetSplitDescriptorV1,
  RecommendationDatasetSplitV1,
  validateRecommendationBehavioralTrainingExampleV1,
} from '@deadlock-live-probe/shared';
import { RecommendationDatasetV8ReportService } from './recommendation-dataset-v8-report.service';
import { configuredDirectShopSourceAllowlist } from './recommendation-direct-shop-source-v8';
import { loadRecommendationDirectShopValidationBindingV8 } from './recommendation-direct-shop-validation-binding-v8';
import { RecommendationEvidenceMaterializerV8Service } from './recommendation-evidence-materializer-v8.service';
import { RecommendationFeatureStoreV8Service } from './recommendation-feature-store-v8.service';
import { RecommendationObservabilityReportService } from './recommendation-observability-report.service';
import { RecommendationRoadmapEvidenceService } from './recommendation-roadmap-evidence.service';
import { SoulsAffordabilityEvidenceV2Service } from './souls-affordability-evidence-v2.service';

export interface RecommendationTrainingSplitWindowV1 {
  split: RecommendationDatasetSplitV1;
  from: string;
  to: string;
}

export interface RecommendationTrainingDatasetExportV1Options {
  datasetId: string;
  sourceCommitSha: string;
  actionContractVersion: string;
  candidateGeneratorVersion: string;
  outputDir: string;
  splits: readonly RecommendationTrainingSplitWindowV1[];
  maximumAlignmentAgeMs?: number;
  maximumHistoryEvents?: number;
  minimumDevelopmentExportCoverage?: number;
  minimumShadowHoldoutDecisionCount?: number;
}

export interface RecommendationTrainingDatasetPreflightV1 {
  ready: boolean;
  blockers: readonly string[];
  decisionCount: number;
  labeledDecisionCount: number;
  developmentWindowTo: string;
  directShopSourceApprovalKeys: readonly string[];
  directShopSourceValidationSubjectSha256?: string;
  futureTestSealed: true;
  futureTestMaterialized: false;
  splitMatchCounts: Readonly<Record<string, number>>;
  splitDecisionCounts: Readonly<Record<string, number>>;
}

export interface RecommendationTrainingDatasetExportReportV1 {
  datasetId: string;
  generatedAt: string;
  emittedDevelopmentDecisionCount: number;
  skippedDevelopmentDecisionCount: number;
  developmentSkipReasons: Readonly<Record<string, number>>;
  futureTestSealed: true;
  futureTestMaterialized: false;
  futureTestDiagnosticMetricsExposed: false;
  manifest: RecommendationDatasetManifestV1;
}

interface ExportDecisionRow {
  decisionId: string;
  matchId: string;
  candidateGeneratorVersion: string;
  rulesetVersion: string;
  catalogSha256: string;
  observedActionInjected: boolean;
  actionLoggingPropensity: string | number;
  observedActionKey?: string;
}

interface CandidateRow {
  actionKey: string;
  actionType: 'WAIT_SAVE' | 'BUY_ITEM' | 'UPGRADE_ITEM' | 'SELL_ITEM' | 'REPLACE_ITEM';
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

const REQUIRED_SPLITS: readonly RecommendationDatasetSplitV1[] = [
  'TRAIN',
  'VALIDATION',
  'SHADOW_HOLDOUT',
  'FUTURE_TEST',
];
const DEFAULT_MINIMUM_SHADOW_HOLDOUT_DECISIONS = 10_000;

@Injectable()
export class RecommendationTrainingDatasetV8Service {
  constructor(
    private readonly dataSource: DataSource,
    private readonly featureStore: RecommendationFeatureStoreV8Service,
    private readonly datasetReport: RecommendationDatasetV8ReportService,
    private readonly observabilityReport: RecommendationObservabilityReportService,
    private readonly soulsEvidence: SoulsAffordabilityEvidenceV2Service,
    private readonly roadmapEvidence: RecommendationRoadmapEvidenceService,
    private readonly evidenceMaterializer: RecommendationEvidenceMaterializerV8Service,
  ) {}

  async preflight(options: RecommendationTrainingDatasetExportV1Options): Promise<RecommendationTrainingDatasetPreflightV1> {
    const blockers = validateOptions(options);
    const splitMatchCounts: Record<string, number> = {};
    const splitDecisionCounts: Record<string, number> = {};
    const directShopSourceApprovalKeys = configuredDirectShopSourceAllowlist();
    const developmentWindowTo = options.splits.find((split) => split.split === 'SHADOW_HOLDOUT')?.to ?? '';
    if (blockers.length > 0) {
      return {
        ready: false,
        blockers,
        decisionCount: 0,
        labeledDecisionCount: 0,
        developmentWindowTo,
        directShopSourceApprovalKeys,
        futureTestSealed: true,
        futureTestMaterialized: false,
        splitMatchCounts,
        splitDecisionCounts,
      };
    }

    const from = new Date(options.splits[0].from);
    const developmentTo = new Date(developmentWindowTo);
    const [dataset, observability, souls, roadmap] = await Promise.all([
      this.datasetReport.buildReport({
        from,
        to: developmentTo,
        candidateGeneratorVersion: options.candidateGeneratorVersion,
      }),
      this.observabilityReport.buildReport({
        from,
        to: developmentTo,
        maximumAlignmentAgeMs: options.maximumAlignmentAgeMs,
        candidateGeneratorVersion: options.candidateGeneratorVersion,
      }),
      this.soulsEvidence.report(),
      this.roadmapEvidence.report(),
    ]);
    const directShopBinding = await loadRecommendationDirectShopValidationBindingV8(
      roadmap,
      this.evidenceMaterializer,
    );
    blockers.push(...directShopBinding.blockers.map((blocker) => `DIRECT_SHOP:${blocker}`));
    if (directShopSourceApprovalKeys.length !== 1) {
      blockers.push('DIRECT_SHOP_SOURCE_APPROVAL_SET_MUST_CONTAIN_EXACTLY_ONE_KEY');
    }
    if (directShopBinding.valid && directShopSourceApprovalKeys[0] !== directShopBinding.approvalKey) {
      blockers.push('DIRECT_SHOP_SOURCE_APPROVAL_NOT_BOUND_TO_VALIDATION');
    }
    if (directShopBinding.valid && !isSha256(directShopBinding.subjectSha256 ?? '')) {
      blockers.push('DIRECT_SHOP_SOURCE_VALIDATION_SUBJECT_SHA256_INVALID');
    }
    if (!sameStrings(observability.approvedDirectShopSourceKeys ?? [], directShopSourceApprovalKeys)) {
      blockers.push('OBSERVABILITY_DIRECT_SHOP_APPROVAL_SCOPE_MISMATCH');
    }

    if (!dataset.passedStructuralGate) blockers.push(...dataset.blockers.map((blocker) => `DATASET_STRUCTURAL:${blocker}`));
    if (!dataset.passedEmpiricalGate) blockers.push(...dataset.blockers.map((blocker) => `DATASET_EMPIRICAL:${blocker}`));
    if (!observability.gate.passed) {
      for (const check of observability.gate.checks) if (!check.passed) blockers.push(`OBSERVABILITY:${check.name}`);
    }
    if (!souls.canMarkSpendableSoulsVerified) blockers.push(`SOULS_EVIDENCE:${souls.verdict}`);
    const prospectiveData = roadmap.state.phases.find((phase) => phase.phase === 'PROSPECTIVE_DATA');
    if (!prospectiveData?.unlocked) {
      blockers.push(...(
        prospectiveData?.blockers.map((blocker) => `ROADMAP_PROSPECTIVE_DATA:${blocker}`)
        ?? ['ROADMAP_PROSPECTIVE_DATA:NOT_FOUND']
      ));
    }
    if (!roadmap.evidence.futureTestUntouched) blockers.push('FUTURE_TEST_INTEGRITY_VIOLATION');
    if ((roadmap.evidence.futureTestEvaluation ?? 'NOT_EVALUATED') !== 'NOT_EVALUATED') {
      blockers.push('FUTURE_TEST_ALREADY_EVALUATED');
    }

    for (const split of options.splits) {
      if (split.split === 'FUTURE_TEST') {
        splitMatchCounts[split.split] = 0;
        splitDecisionCounts[split.split] = 0;
        continue;
      }
      const counts = await this.splitCounts(options.candidateGeneratorVersion, split);
      splitMatchCounts[split.split] = counts.matchCount;
      splitDecisionCounts[split.split] = counts.decisionCount;
      if (counts.matchCount === 0) blockers.push(`SPLIT_EMPTY_MATCH_SET:${split.split}`);
      if (counts.decisionCount === 0) blockers.push(`SPLIT_EMPTY_DECISION_SET:${split.split}`);
      if (
        split.split === 'SHADOW_HOLDOUT'
        && counts.decisionCount < (options.minimumShadowHoldoutDecisionCount ?? DEFAULT_MINIMUM_SHADOW_HOLDOUT_DECISIONS)
      ) {
        blockers.push('SHADOW_HOLDOUT_DECISION_COUNT_BELOW_GATE');
      }
    }

    return {
      ready: blockers.length === 0,
      blockers: [...new Set(blockers)].sort(),
      decisionCount: dataset.decisionCount,
      labeledDecisionCount: dataset.labeledDecisionCount,
      developmentWindowTo,
      directShopSourceApprovalKeys,
      directShopSourceValidationSubjectSha256: directShopBinding.valid
        ? directShopBinding.subjectSha256
        : undefined,
      futureTestSealed: true,
      futureTestMaterialized: false,
      splitMatchCounts,
      splitDecisionCounts,
    };
  }

  async export(options: RecommendationTrainingDatasetExportV1Options): Promise<RecommendationTrainingDatasetExportReportV1> {
    const preflight = await this.preflight(options);
    if (!preflight.ready) {
      throw new Error(`Recommendation training dataset export is blocked: ${preflight.blockers.join(',')}`);
    }
    const directShopSourceValidationSubjectSha256 = preflight.directShopSourceValidationSubjectSha256;
    if (!isSha256(directShopSourceValidationSubjectSha256 ?? '')) {
      throw new Error('Direct shop validation snapshot identity is missing from ready dataset preflight');
    }
    const outputDir = resolve(options.outputDir);
    assertFreshOutputDirectory(outputDir);
    mkdirSync(join(outputDir, 'splits'), { recursive: true });

    const files: RecommendationDatasetArtifactFileV1[] = [];
    const splitDescriptors: RecommendationDatasetSplitDescriptorV1[] = [];
    const developmentSkipReasons = new Map<string, number>();
    const supportedRulesets = new Set<string>();
    const supportedCatalogs = new Set<string>();
    const directShopSourceApprovalKeys = preflight.directShopSourceApprovalKeys;
    const minimumDevelopmentExportCoverage = options.minimumDevelopmentExportCoverage ?? 0.99;
    let emittedDevelopmentDecisionCount = 0;
    let skippedDevelopmentDecisionCount = 0;

    for (const split of options.splits) {
      if (split.split === 'FUTURE_TEST') {
        splitDescriptors.push({
          split: 'FUTURE_TEST',
          from: new Date(split.from).toISOString(),
          to: new Date(split.to).toISOString(),
          matchCount: 0,
          decisionCount: 0,
          matchSetSha256: hashStrings([]),
          sealed: true,
        });
        continue;
      }

      const relativePath = `splits/${split.split.toLowerCase()}.jsonl.gz`;
      const absolutePath = join(outputDir, relativePath);
      const decisions = await this.loadSplitDecisions(options.candidateGeneratorVersion, split);
      const matchIds = new Set<string>();
      const gzip = createGzip({ level: 9 });
      const output = createWriteStream(absolutePath, { flags: 'wx' });
      gzip.pipe(output);
      let rowCount = 0;

      for (const decision of decisions) {
        const built = await this.buildExample(decision, split.split, options);
        if (!built.example) {
          skippedDevelopmentDecisionCount += 1;
          increment(developmentSkipReasons, built.reason ?? 'UNKNOWN_SKIP_REASON');
          continue;
        }
        if (!gzip.write(`${JSON.stringify(built.example)}\n`)) await once(gzip, 'drain');
        matchIds.add(decision.matchId);
        supportedRulesets.add(decision.rulesetVersion);
        supportedCatalogs.add(decision.catalogSha256);
        rowCount += 1;
        emittedDevelopmentDecisionCount += 1;
      }

      await endGzip(gzip, output);
      if (rowCount === 0) throw new Error(`Exported development split is empty: ${split.split}`);
      const coverage = decisions.length > 0 ? rowCount / decisions.length : 0;
      if (coverage < minimumDevelopmentExportCoverage) {
        throw new Error(
          `Development export coverage below gate for ${split.split}: ${coverage} < ${minimumDevelopmentExportCoverage}`,
        );
      }

      files.push(await artifactFile(relativePath, absolutePath, rowCount));
      splitDescriptors.push({
        split: split.split,
        from: new Date(split.from).toISOString(),
        to: new Date(split.to).toISOString(),
        matchCount: matchIds.size,
        decisionCount: rowCount,
        matchSetSha256: hashStrings([...matchIds].sort()),
        sealed: false,
      });
    }

    if (!sameStrings(configuredDirectShopSourceAllowlist(), directShopSourceApprovalKeys)) {
      throw new Error('Direct shop source approval set changed during immutable dataset export');
    }
    const manifestBase = {
      contractVersion: RECOMMENDATION_DATASET_MANIFEST_VERSION,
      datasetId: options.datasetId,
      createdAt: new Date().toISOString(),
      sourceCommitSha: options.sourceCommitSha,
      datasetContractVersion: 'recommendation-dataset-v8',
      featureContractVersion: RECOMMENDATION_FEATURE_CONTRACT_VERSION,
      actionContractVersion: options.actionContractVersion,
      candidateGeneratorVersion: options.candidateGeneratorVersion,
      directShopSourceApprovalKeys,
      directShopSourceValidationSubjectSha256,
      pointInTimeCorrect: true,
      observedActionInjected: false,
      futureTestTouched: false,
      supportedRulesetVersions: [...supportedRulesets].filter(Boolean).sort(),
      supportedCatalogSha256: [...supportedCatalogs].filter(isSha256).sort(),
      splits: splitDescriptors,
      files,
    };
    if (manifestBase.supportedRulesetVersions.length === 0) throw new Error('Export produced no supported rulesets');
    if (manifestBase.supportedCatalogSha256.length === 0) throw new Error('Export produced no supported catalog hashes');
    const datasetSha256 = createHash('sha256').update(canonicalJson(manifestBase)).digest('hex');
    const manifest: RecommendationDatasetManifestV1 = { ...manifestBase, datasetSha256 };
    writeFileSync(join(outputDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });

    const report: RecommendationTrainingDatasetExportReportV1 = {
      datasetId: options.datasetId,
      generatedAt: new Date().toISOString(),
      emittedDevelopmentDecisionCount,
      skippedDevelopmentDecisionCount,
      developmentSkipReasons: Object.fromEntries(
        [...developmentSkipReasons.entries()].sort(([left], [right]) => left.localeCompare(right)),
      ),
      futureTestSealed: true,
      futureTestMaterialized: false,
      futureTestDiagnosticMetricsExposed: false,
      manifest,
    };
    writeFileSync(join(outputDir, 'export-report.json'), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
    return report;
  }

  private async buildExample(
    decision: ExportDecisionRow,
    split: RecommendationDatasetSplitV1,
    options: RecommendationTrainingDatasetExportV1Options,
  ): Promise<{ example?: RecommendationBehavioralTrainingExampleV1; reason?: string }> {
    if (split === 'FUTURE_TEST') throw new Error('FUTURE_TEST_ACCESS_FORBIDDEN_DURING_MODEL_DEVELOPMENT');
    if (decision.observedActionInjected) return { reason: 'OBSERVED_ACTION_INJECTED' };
    if (!decision.observedActionKey) return { reason: 'OBSERVED_ACTION_MISSING' };
    const feature = await this.featureStore.buildForDecision(
      decision.decisionId,
      options.maximumAlignmentAgeMs ?? 5_000,
      options.maximumHistoryEvents ?? 64,
    );
    if (!feature.ready || !feature.featureState) {
      return { reason: `FEATURE_STATE:${feature.blockers.join('|') || 'NOT_READY'}` };
    }
    const candidates = await this.loadCandidates(decision.decisionId);
    const feasible = candidates
      .filter((candidate) => candidate.feasible)
      .map((candidate) => ({
        actionKey: candidate.actionKey,
        actionType: candidate.actionType,
        targetItemId: optionalNumber(candidate.targetItemId),
        sellItemId: optionalNumber(candidate.sellItemId),
        recipeId: candidate.recipeId,
        effectiveCostSouls: numeric(candidate.effectiveCostSouls),
        feasible: true as const,
      }));
    const propensity = numeric(decision.actionLoggingPropensity);
    const example: RecommendationBehavioralTrainingExampleV1 = {
      contractVersion: RECOMMENDATION_BEHAVIORAL_TRAINING_EXAMPLE_V1,
      split,
      decisionId: decision.decisionId,
      matchId: decision.matchId,
      candidateGeneratorVersion: decision.candidateGeneratorVersion,
      state: feature.featureState,
      candidates: feasible,
      observedActionKey: decision.observedActionKey,
      observedActionInjected: false,
      actionLoggingPropensity: propensity,
      actionLoggingPropensitySource: 'RECORDED_AT_ACTION_SELECTION',
    };
    const validation = validateRecommendationBehavioralTrainingExampleV1(example);
    if (validation.length > 0) return { reason: `EXAMPLE_INVALID:${validation.join('|')}` };
    return { example };
  }

  private async loadSplitDecisions(
    candidateGeneratorVersion: string,
    split: RecommendationTrainingSplitWindowV1,
  ): Promise<ExportDecisionRow[]> {
    if (split.split === 'FUTURE_TEST') throw new Error('FUTURE_TEST_ACCESS_FORBIDDEN_DURING_MODEL_DEVELOPMENT');
    return this.dataSource.query(
      `WITH match_bounds AS (
         SELECT "matchId", MIN("decidedAt") AS first_decision_at, MAX("decidedAt") AS last_decision_at
         FROM recommendation_decisions_v8
         WHERE "candidateGeneratorVersion" = $1
         GROUP BY "matchId"
       ), latest_outcome AS (
         SELECT DISTINCT ON (e."payload"->>'decisionId')
           e."payload"->>'decisionId' AS decision_id,
           NULLIF(e."payload"->>'observedActionKey', '') AS observed_action_key
         FROM recommendation_telemetry_events e
         WHERE e."eventType" = 'RECOMMENDATION_OUTCOME'
           AND COALESCE(e."payload"->>'decisionId', '') <> ''
           AND e."sourceOccurredAt" < $3::timestamptz
           AND e."receivedAt" < $3::timestamptz
         ORDER BY e."payload"->>'decisionId', e."sourceOccurredAt" DESC, e."receivedAt" DESC
       )
       SELECT d."decisionId", d."matchId", d."candidateGeneratorVersion", d."rulesetVersion", d."catalogSha256",
              d."observedActionInjected", d."actionLoggingPropensity", o.observed_action_key AS "observedActionKey"
       FROM recommendation_decisions_v8 d
       JOIN match_bounds m ON m."matchId" = d."matchId"
       LEFT JOIN latest_outcome o ON o.decision_id = d."decisionId"
       WHERE d."candidateGeneratorVersion" = $1
         AND m.first_decision_at >= $2::timestamptz
         AND m.last_decision_at < $3::timestamptz
       ORDER BY m.first_decision_at, d."matchId", d."decidedAt", d."decisionId"`,
      [candidateGeneratorVersion, split.from, split.to],
    ) as Promise<ExportDecisionRow[]>;
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

  private async splitCounts(
    candidateGeneratorVersion: string,
    split: RecommendationTrainingSplitWindowV1,
  ): Promise<{ matchCount: number; decisionCount: number }> {
    if (split.split === 'FUTURE_TEST') throw new Error('FUTURE_TEST_ACCESS_FORBIDDEN_DURING_MODEL_DEVELOPMENT');
    const rows = await this.dataSource.query(
      `WITH match_bounds AS (
         SELECT "matchId", MIN("decidedAt") AS first_decision_at, MAX("decidedAt") AS last_decision_at
         FROM recommendation_decisions_v8
         WHERE "candidateGeneratorVersion" = $1
         GROUP BY "matchId"
       )
       SELECT COUNT(DISTINCT d."matchId") AS "matchCount", COUNT(*) AS "decisionCount"
       FROM recommendation_decisions_v8 d
       JOIN match_bounds m ON m."matchId" = d."matchId"
       WHERE d."candidateGeneratorVersion" = $1
         AND m.first_decision_at >= $2::timestamptz
         AND m.last_decision_at < $3::timestamptz`,
      [candidateGeneratorVersion, split.from, split.to],
    ) as CountRow[];
    return {
      matchCount: numeric(rows[0]?.matchCount),
      decisionCount: numeric(rows[0]?.decisionCount),
    };
  }
}

function validateOptions(options: RecommendationTrainingDatasetExportV1Options): string[] {
  const errors: string[] = [];
  if (!options.datasetId) errors.push('DATASET_ID_REQUIRED');
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
    options.minimumDevelopmentExportCoverage !== undefined
    && (
      !Number.isFinite(options.minimumDevelopmentExportCoverage)
      || options.minimumDevelopmentExportCoverage < 0.99
      || options.minimumDevelopmentExportCoverage > 1
    )
  ) errors.push('MINIMUM_DEVELOPMENT_EXPORT_COVERAGE_INVALID');
  if (
    options.minimumShadowHoldoutDecisionCount !== undefined
    && (!Number.isInteger(options.minimumShadowHoldoutDecisionCount) || options.minimumShadowHoldoutDecisionCount <= 0)
  ) errors.push('MINIMUM_SHADOW_HOLDOUT_DECISION_COUNT_INVALID');
  if (options.splits.length !== REQUIRED_SPLITS.length) errors.push('EXACTLY_FOUR_SPLITS_REQUIRED');
  for (let index = 0; index < REQUIRED_SPLITS.length; index += 1) {
    const split = options.splits[index];
    if (!split || split.split !== REQUIRED_SPLITS[index]) errors.push(`SPLIT_ORDER_INVALID:${REQUIRED_SPLITS[index]}`);
    if (!split || !Number.isFinite(Date.parse(split.from)) || !Number.isFinite(Date.parse(split.to))) {
      errors.push(`SPLIT_TIMESTAMP_INVALID:${REQUIRED_SPLITS[index]}`);
    } else if (Date.parse(split.from) >= Date.parse(split.to)) {
      errors.push(`SPLIT_RANGE_INVALID:${split.split}`);
    }
    if (index > 0 && split && Number.isFinite(Date.parse(split.from))) {
      const previous = options.splits[index - 1];
      if (previous && Date.parse(previous.to) > Date.parse(split.from)) {
        errors.push(`SPLIT_OVERLAP:${previous.split}->${split.split}`);
      }
    }
  }
  return [...new Set(errors)].sort();
}

function assertFreshOutputDirectory(outputDir: string): void {
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
    return;
  }
  if (!statSync(outputDir).isDirectory()) throw new Error('Training dataset output path is not a directory');
  if (readdirSync(outputDir).length > 0) throw new Error('Training dataset output directory must be empty');
}

async function artifactFile(
  relativePath: string,
  absolutePath: string,
  rowCount: number,
): Promise<RecommendationDatasetArtifactFileV1> {
  const digest = createHash('sha256');
  const stream = createReadStream(absolutePath);
  for await (const chunk of stream) digest.update(chunk);
  return {
    path: relativePath,
    sha256: digest.digest('hex'),
    sizeBytes: statSync(absolutePath).size,
    rowCount,
  };
}

function hashStrings(values: readonly string[]): string {
  return createHash('sha256').update(values.join('\n')).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify([...left]) === JSON.stringify([...right]);
}

function increment(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function numeric(value: string | number | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function optionalNumber(value: string | number | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isSha256(value: string): boolean {
  return /^[a-f0-9]{64}$/i.test(value);
}

function endGzip(gzip: ReturnType<typeof createGzip>, output: ReturnType<typeof createWriteStream>): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    output.once('finish', resolvePromise);
    output.once('error', reject);
    gzip.once('error', reject);
    gzip.end();
  });
}
