import { Injectable } from '@nestjs/common';
import {
  RecommendationBehavioralTrainingConfigV1,
  RecommendationBehavioralTrainingLaunchReportV1,
  evaluateRecommendationBehavioralTrainingLaunchV1,
} from '@deadlock-live-probe/shared';
import { RecommendationDatasetRegistryService } from './recommendation-dataset-registry.service';
import { RecommendationDatasetV8ReportService } from './recommendation-dataset-v8-report.service';
import { configuredDirectShopSourceAllowlist } from './recommendation-direct-shop-source-v8';
import { loadRecommendationDirectShopValidationBindingV8 } from './recommendation-direct-shop-validation-binding-v8';
import { RecommendationEvidenceMaterializerV8Service } from './recommendation-evidence-materializer-v8.service';
import { RecommendationObservabilityReportService } from './recommendation-observability-report.service';
import { RecommendationRoadmapEvidenceService } from './recommendation-roadmap-evidence.service';
import { SoulsAffordabilityEvidenceV2Service } from './souls-affordability-evidence-v2.service';

export interface RecommendationTrainingLaunchPreflightV8 {
  ready: boolean;
  datasetId: string;
  datasetSha256: string;
  manifestSha256: string;
  objectBaseUri: string;
  datasetRegistryStatus: 'VERIFIED';
  training: RecommendationBehavioralTrainingLaunchReportV1;
  currentDataGates: {
    from: string;
    to: string;
    candidateGeneratorVersion: string;
    directShopSourceApprovalKeys: readonly string[];
    directShopSourceValidationSubjectSha256?: string;
    directShopSourceValidation: 'PASS' | 'FAIL' | 'INSUFFICIENT_EVIDENCE' | 'NOT_EVALUATED';
    controlledSoulsValidation: 'PASS' | 'FAIL' | 'INSUFFICIENT_EVIDENCE';
    observabilityPassed: boolean;
    datasetStructuralPassed: boolean;
    datasetEmpiricalPassed: boolean;
    explicitFeasibilityCoverage: number;
    observedActionFeasibleCoverage: number;
    minimumMajorActionPhaseCohortObservedActionFeasibleCoverage: number;
    rulesetEvidenceCoverage: number;
  };
  blockers: readonly string[];
}

@Injectable()
export class RecommendationTrainingLaunchV8Service {
  constructor(
    private readonly datasetRegistry: RecommendationDatasetRegistryService,
    private readonly roadmapEvidence: RecommendationRoadmapEvidenceService,
    private readonly datasetReport: RecommendationDatasetV8ReportService,
    private readonly observabilityReport: RecommendationObservabilityReportService,
    private readonly soulsEvidence: SoulsAffordabilityEvidenceV2Service,
    private readonly evidenceMaterializer: RecommendationEvidenceMaterializerV8Service,
  ) {}

  async preflight(
    datasetId: string,
    config: RecommendationBehavioralTrainingConfigV1,
  ): Promise<RecommendationTrainingLaunchPreflightV8> {
    if (!datasetId) throw new Error('datasetId is required');
    const dataset = await this.datasetRegistry.getVerified(datasetId);
    const candidateGeneratorVersion = dataset.manifest.candidateGeneratorVersion?.trim();
    if (!candidateGeneratorVersion) throw new Error('Verified dataset candidateGeneratorVersion is missing');
    const datasetDirectShopSourceApprovalKeys = dataset.manifest.directShopSourceApprovalKeys;
    const datasetDirectShopValidationSubjectSha256 = dataset.manifest.directShopSourceValidationSubjectSha256?.toLowerCase();
    const currentDirectShopSourceApprovalKeys = configuredDirectShopSourceAllowlist();
    const window = developmentWindow(dataset.manifest.splits);
    const [roadmap, currentDataset, currentObservability, currentSouls] = await Promise.all([
      this.roadmapEvidence.report(),
      this.datasetReport.buildReport({
        from: window.from,
        to: window.to,
        candidateGeneratorVersion,
      }),
      this.observabilityReport.buildReport({
        from: window.from,
        to: window.to,
        candidateGeneratorVersion,
      }),
      this.soulsEvidence.report(),
    ]);
    const training = evaluateRecommendationBehavioralTrainingLaunchV1({
      manifest: dataset.manifest,
      evidence: roadmap.evidence,
      config,
    });
    const blockers = [...training.blockers];
    const directShopBinding = await loadRecommendationDirectShopValidationBindingV8(
      roadmap,
      this.evidenceMaterializer,
    );
    blockers.push(...directShopBinding.blockers.map((blocker) => `CURRENT_${blocker}`));

    if (dataset.manifestSha256 !== dataset.verification?.verifiedManifestSha256) {
      blockers.push('DATASET_REGISTRY_VERIFICATION_MISMATCH');
    }
    if (dataset.datasetSha256 !== dataset.manifest.datasetSha256) {
      blockers.push('DATASET_REGISTRY_SHA_MISMATCH');
    }
    if (!datasetDirectShopSourceApprovalKeys || datasetDirectShopSourceApprovalKeys.length === 0) {
      blockers.push('DATASET_DIRECT_SHOP_SOURCE_APPROVALS_MISSING');
    } else if (!sameStrings(datasetDirectShopSourceApprovalKeys, currentDirectShopSourceApprovalKeys)) {
      blockers.push('CURRENT_DIRECT_SHOP_SOURCE_APPROVAL_SET_MISMATCH');
    }
    if (!isSha256(datasetDirectShopValidationSubjectSha256 ?? '')) {
      blockers.push('DATASET_DIRECT_SHOP_VALIDATION_SUBJECT_SHA_MISSING_OR_INVALID');
    }
    if (currentDirectShopSourceApprovalKeys.length !== 1) {
      blockers.push('CURRENT_DIRECT_SHOP_SOURCE_APPROVAL_SET_MUST_CONTAIN_EXACTLY_ONE_KEY');
    }
    if (
      directShopBinding.valid
      && currentDirectShopSourceApprovalKeys[0] !== directShopBinding.approvalKey
    ) {
      blockers.push('CURRENT_DIRECT_SHOP_SOURCE_APPROVAL_NOT_BOUND_TO_VALIDATION');
    }
    if (
      directShopBinding.valid
      && datasetDirectShopValidationSubjectSha256 !== directShopBinding.subjectSha256?.toLowerCase()
    ) {
      blockers.push('CURRENT_DIRECT_SHOP_VALIDATION_SUBJECT_SHA_MISMATCH');
    }
    if (currentDataset.candidateGeneratorVersion !== candidateGeneratorVersion) {
      blockers.push('CURRENT_DATASET_CANDIDATE_GENERATOR_SCOPE_MISMATCH');
    }
    if (currentObservability.candidateGeneratorVersion !== candidateGeneratorVersion) {
      blockers.push('CURRENT_OBSERVABILITY_CANDIDATE_GENERATOR_SCOPE_MISMATCH');
    }
    if (!sameStrings(currentObservability.approvedDirectShopSourceKeys ?? [], currentDirectShopSourceApprovalKeys)) {
      blockers.push('CURRENT_OBSERVABILITY_DIRECT_SHOP_APPROVAL_SCOPE_MISMATCH');
    }
    if (currentSouls.verdict !== 'PASS' || !currentSouls.canMarkSpendableSoulsVerified) {
      blockers.push(`CURRENT_CONTROLLED_SOULS_${currentSouls.verdict}`);
    }
    if (!currentObservability.gate.passed) {
      blockers.push(...currentObservability.gate.blockers.map((blocker) => `CURRENT_OBSERVABILITY:${blocker}`));
    }
    if (!currentDataset.passedStructuralGate) {
      blockers.push(...currentDataset.blockers.map((blocker) => `CURRENT_DATASET_STRUCTURAL:${blocker}`));
    }
    if (!currentDataset.passedEmpiricalGate) {
      blockers.push(...currentDataset.blockers.map((blocker) => `CURRENT_DATASET_EMPIRICAL:${blocker}`));
    }
    if (!roadmap.evidence.futureTestUntouched) blockers.push('FUTURE_TEST_INTEGRITY_VIOLATION');
    if ((roadmap.evidence.futureTestEvaluation ?? 'NOT_EVALUATED') !== 'NOT_EVALUATED') {
      blockers.push('FUTURE_TEST_ALREADY_EVALUATED');
    }

    return {
      ready: blockers.length === 0,
      datasetId: dataset.datasetId,
      datasetSha256: dataset.datasetSha256,
      manifestSha256: dataset.manifestSha256,
      objectBaseUri: dataset.objectBaseUri,
      datasetRegistryStatus: 'VERIFIED',
      training,
      currentDataGates: {
        from: window.from.toISOString(),
        to: window.to.toISOString(),
        candidateGeneratorVersion,
        directShopSourceApprovalKeys: currentDirectShopSourceApprovalKeys,
        directShopSourceValidationSubjectSha256: directShopBinding.valid
          ? directShopBinding.subjectSha256
          : undefined,
        directShopSourceValidation: roadmap.evidence.directShopSourceValidation,
        controlledSoulsValidation: currentSouls.verdict,
        observabilityPassed: currentObservability.gate.passed,
        datasetStructuralPassed: currentDataset.passedStructuralGate,
        datasetEmpiricalPassed: currentDataset.passedEmpiricalGate,
        explicitFeasibilityCoverage: currentDataset.explicitFeasibilityCoverage,
        observedActionFeasibleCoverage: currentDataset.observedActionFeasibleCoverage,
        minimumMajorActionPhaseCohortObservedActionFeasibleCoverage:
          currentDataset.minimumMajorActionPhaseCohortObservedActionFeasibleCoverage,
        rulesetEvidenceCoverage: currentDataset.rulesetEvidenceCoverage,
      },
      blockers: [...new Set(blockers)].sort(),
    };
  }
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify([...left]) === JSON.stringify([...right]);
}

function isSha256(value: string): boolean {
  return /^[a-f0-9]{64}$/i.test(value);
}

function developmentWindow(
  splits: readonly { split: string; from: string; to: string }[],
): { from: Date; to: Date } {
  const train = splits.find((split) => split.split === 'TRAIN');
  const shadow = splits.find((split) => split.split === 'SHADOW_HOLDOUT');
  if (!train || !shadow) throw new Error('Dataset development split descriptors are missing');
  const from = new Date(train.from);
  const to = new Date(shadow.to);
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from >= to) {
    throw new Error('Dataset development window is invalid');
  }
  return { from, to };
}
