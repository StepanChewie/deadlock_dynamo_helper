import { createHash } from 'crypto';
import { Injectable } from '@nestjs/common';
import {
  RecommendationBehavioralTrainingConfigV1,
  RecommendationPretrainingFinalReadinessReportV1,
  evaluateRecommendationPretrainingFinalReadinessV1,
  validateRecommendationBehavioralTrainingPairV1,
} from '@deadlock-live-probe/shared';
import { RecommendationDatasetRegistryService } from './recommendation-dataset-registry.service';
import {
  RecommendationTrainingLaunchPreflightV8,
  RecommendationTrainingLaunchV8Service,
} from './recommendation-training-launch-v8.service';
import { RecommendationRoadmapEvidenceService } from './recommendation-roadmap-evidence.service';

export interface RecommendationPretrainingRunnerEvidenceV8 {
  expectedDatasetSha256: string;
  expectedManifestSha256: string;
  sourceCommitSha: string;
  trainingWheelhouseSha256: string;
  splitIsolationPassed: boolean;
  immutableDatasetBytesVerified: boolean;
  offlineWheelhouseReady: boolean;
  trainingDeviceReady: boolean;
}

export interface RecommendationPretrainingFinalReadinessV8Input {
  rnnConfig: RecommendationBehavioralTrainingConfigV1;
  transformerConfig: RecommendationBehavioralTrainingConfigV1;
  runner: RecommendationPretrainingRunnerEvidenceV8;
}

export interface RecommendationPretrainingFinalReadinessV8Result {
  generatedAt: string;
  ready: boolean;
  datasetId: string;
  datasetSha256: string;
  manifestSha256: string;
  sourceCommitSha: string;
  trainingWheelhouseSha256: string;
  readinessSubjectSha256: string;
  pairValidation: {
    valid: boolean;
    errors: readonly string[];
  };
  finalReadiness: RecommendationPretrainingFinalReadinessReportV1;
  rnnPreflight: RecommendationTrainingLaunchPreflightV8;
  transformerPreflight: RecommendationTrainingLaunchPreflightV8;
  trainingPerformed: false;
  futureTestEvaluated: boolean;
  blockers: readonly string[];
}

@Injectable()
export class RecommendationPretrainingFinalReadinessV8Service {
  constructor(
    private readonly trainingLaunch: RecommendationTrainingLaunchV8Service,
    private readonly datasetRegistry: RecommendationDatasetRegistryService,
    private readonly roadmapEvidence: RecommendationRoadmapEvidenceService,
  ) {}

  async evaluate(
    datasetId: string,
    input: RecommendationPretrainingFinalReadinessV8Input,
  ): Promise<RecommendationPretrainingFinalReadinessV8Result> {
    if (!datasetId) throw new Error('datasetId is required');
    validateRunnerEvidence(input?.runner);
    const pairValidation = validateRecommendationBehavioralTrainingPairV1(
      input.rnnConfig,
      input.transformerConfig,
    );

    const [dataset, roadmap, rnnPreflight, transformerPreflight] = await Promise.all([
      this.datasetRegistry.getVerified(datasetId),
      this.roadmapEvidence.report(),
      this.trainingLaunch.preflight(datasetId, input.rnnConfig),
      this.trainingLaunch.preflight(datasetId, input.transformerConfig),
    ]);

    const blockers: string[] = [...pairValidation.errors];
    const expectedDatasetSha256 = input.runner.expectedDatasetSha256.toLowerCase();
    const expectedManifestSha256 = input.runner.expectedManifestSha256.toLowerCase();
    const sourceCommitSha = input.runner.sourceCommitSha.toLowerCase();
    const trainingWheelhouseSha256 = input.runner.trainingWheelhouseSha256.toLowerCase();
    if (dataset.datasetSha256.toLowerCase() !== expectedDatasetSha256) blockers.push('RUNNER_DATASET_SHA_MISMATCH');
    if (dataset.manifestSha256.toLowerCase() !== expectedManifestSha256) blockers.push('RUNNER_MANIFEST_SHA_MISMATCH');
    if (dataset.manifest.sourceCommitSha.toLowerCase() !== sourceCommitSha) blockers.push('RUNNER_SOURCE_COMMIT_MISMATCH');
    if (rnnPreflight.datasetSha256.toLowerCase() !== dataset.datasetSha256.toLowerCase()) blockers.push('RNN_PREFLIGHT_DATASET_SHA_MISMATCH');
    if (transformerPreflight.datasetSha256.toLowerCase() !== dataset.datasetSha256.toLowerCase()) blockers.push('TRANSFORMER_PREFLIGHT_DATASET_SHA_MISMATCH');
    if (rnnPreflight.manifestSha256.toLowerCase() !== dataset.manifestSha256.toLowerCase()) blockers.push('RNN_PREFLIGHT_MANIFEST_SHA_MISMATCH');
    if (transformerPreflight.manifestSha256.toLowerCase() !== dataset.manifestSha256.toLowerCase()) blockers.push('TRANSFORMER_PREFLIGHT_MANIFEST_SHA_MISMATCH');
    if (!sameDataGateSnapshot(rnnPreflight, transformerPreflight)) blockers.push('RNN_TRANSFORMER_PREFLIGHT_DATA_SCOPE_MISMATCH');
    blockers.push(...rnnPreflight.blockers.map((blocker) => `RNN_PREFLIGHT:${blocker}`));
    blockers.push(...transformerPreflight.blockers.map((blocker) => `TRANSFORMER_PREFLIGHT:${blocker}`));

    const gates = rnnPreflight.currentDataGates;
    const shadowHoldoutDecisionCount = dataset.manifest.splits.find(
      (split) => split.split === 'SHADOW_HOLDOUT',
    )?.decisionCount ?? 0;
    const futureTestEvaluation = roadmap.evidence.futureTestEvaluation ?? 'NOT_EVALUATED';
    const futureTestEvaluated = futureTestEvaluation !== 'NOT_EVALUATED';
    const finalReadiness = evaluateRecommendationPretrainingFinalReadinessV1({
      canonicalGepFixtureCoverage: roadmap.evidence.canonicalGepV2 === 'PASS' ? 1 : 0,
      controlledSoulsValidation: gates.controlledSoulsValidation,
      directShopSourceValidation: gates.directShopSourceValidation,
      rulesetCatalogCoverage: gates.rulesetEvidenceCoverage,
      deterministicIllegalRecommendationCount: roadmap.evidence.deterministicLegality === 'PASS' ? 0 : 1,
      recommendationTelemetryContractPassed: roadmap.evidence.recommendationTelemetryV8 === 'PASS',
      observabilityGatePassed: gates.observabilityPassed,
      datasetStructuralPassed: gates.datasetStructuralPassed,
      datasetEmpiricalPassed: gates.datasetEmpiricalPassed,
      explicitFeasibilityCoverage: gates.explicitFeasibilityCoverage,
      observedActionFeasibleCoverage: gates.observedActionFeasibleCoverage,
      criticalCohortObservedActionFeasibleCoverage:
        gates.minimumMajorActionPhaseCohortObservedActionFeasibleCoverage,
      shadowHoldoutDecisionCount,
      datasetRegistryVerified: true,
      datasetRegistryVerificationFresh: true,
      splitIsolationPassed: input.runner.splitIsolationPassed,
      futureTestUntouched: roadmap.evidence.futureTestUntouched,
      futureTestEvaluated,
      rnnApiPreflightReady: rnnPreflight.ready,
      transformerApiPreflightReady: transformerPreflight.ready,
      immutableDatasetBytesVerified: input.runner.immutableDatasetBytesVerified,
      offlineWheelhouseReady: input.runner.offlineWheelhouseReady,
      trainingDeviceReady: input.runner.trainingDeviceReady,
    });
    blockers.push(...finalReadiness.blockers);

    const readinessSubjectSha256 = sha256Canonical({
      datasetId: dataset.datasetId,
      datasetSha256: dataset.datasetSha256.toLowerCase(),
      manifestSha256: dataset.manifestSha256.toLowerCase(),
      sourceCommitSha: dataset.manifest.sourceCommitSha.toLowerCase(),
      rnnConfig: input.rnnConfig,
      transformerConfig: input.transformerConfig,
      currentDataGates: gates,
      roadmapDataContractGates: {
        canonicalGepV2: roadmap.evidence.canonicalGepV2,
        deterministicLegality: roadmap.evidence.deterministicLegality,
        recommendationTelemetryV8: roadmap.evidence.recommendationTelemetryV8,
        futureTestUntouched: roadmap.evidence.futureTestUntouched,
        futureTestEvaluation,
      },
      runner: {
        trainingWheelhouseSha256,
        splitIsolationPassed: input.runner.splitIsolationPassed,
        immutableDatasetBytesVerified: input.runner.immutableDatasetBytesVerified,
        offlineWheelhouseReady: input.runner.offlineWheelhouseReady,
        trainingDeviceReady: input.runner.trainingDeviceReady,
      },
    });
    const uniqueBlockers = [...new Set(blockers)].sort();
    return {
      generatedAt: new Date().toISOString(),
      ready: uniqueBlockers.length === 0 && finalReadiness.readyToStartBehavioralTraining,
      datasetId: dataset.datasetId,
      datasetSha256: dataset.datasetSha256,
      manifestSha256: dataset.manifestSha256,
      sourceCommitSha: dataset.manifest.sourceCommitSha,
      trainingWheelhouseSha256,
      readinessSubjectSha256,
      pairValidation: {
        valid: pairValidation.valid,
        errors: pairValidation.errors,
      },
      finalReadiness,
      rnnPreflight,
      transformerPreflight,
      trainingPerformed: false,
      futureTestEvaluated,
      blockers: uniqueBlockers,
    };
  }
}

function validateRunnerEvidence(runner: RecommendationPretrainingRunnerEvidenceV8 | undefined): void {
  if (!runner) throw new Error('runner evidence is required');
  if (!isSha256(runner.expectedDatasetSha256)) throw new Error('runner expectedDatasetSha256 is invalid');
  if (!isSha256(runner.expectedManifestSha256)) throw new Error('runner expectedManifestSha256 is invalid');
  if (!isCommitSha(runner.sourceCommitSha)) throw new Error('runner sourceCommitSha is invalid');
  if (!isSha256(runner.trainingWheelhouseSha256)) throw new Error('runner trainingWheelhouseSha256 is invalid');
  for (const field of [
    'splitIsolationPassed',
    'immutableDatasetBytesVerified',
    'offlineWheelhouseReady',
    'trainingDeviceReady',
  ] as const) {
    if (typeof runner[field] !== 'boolean') throw new Error(`runner ${field} must be boolean`);
  }
}

function sameDataGateSnapshot(
  left: RecommendationTrainingLaunchPreflightV8,
  right: RecommendationTrainingLaunchPreflightV8,
): boolean {
  return canonicalJson(left.currentDataGates) === canonicalJson(right.currentDataGates);
}

function sha256Canonical(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

function isSha256(value: string): boolean {
  return /^[a-f0-9]{64}$/i.test(value);
}

function isCommitSha(value: string): boolean {
  return /^[a-f0-9]{40}$/i.test(value);
}
