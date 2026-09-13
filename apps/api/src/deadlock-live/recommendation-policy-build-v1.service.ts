import { createHash } from 'crypto';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  MODEL_BUNDLE_CONTRACT_VERSION,
  RECOMMENDATION_POLICY_ARTIFACT_V1,
  ModelBundleManifestV1,
  RecommendationPolicyArtifactV1,
  RecommendationPolicyV1Config,
  assertRecommendationPolicyArtifactV1,
  validateModelBundleManifestV1,
} from '@deadlock-live-probe/shared';
import { ModelBundleRegistryService, modelManifestSha256V1 } from './model-bundle-registry.service';
import { RecommendationEvidenceSnapshotV8 } from './entities/recommendation-evidence-snapshot-v8.entity';
import { RecommendationRoadmapEvidenceService } from './recommendation-roadmap-evidence.service';

const ADVANCED_EVIDENCE_EVALUATOR = 'recommendation-advanced-evidence-v8';

export interface RecommendationPolicyBuildV1Input {
  modelId: string;
  modelVersion: string;
  sourceCommitSha: string;
  behavioralModelId: string;
  behavioralModelVersion: string;
  valueModelId: string;
  valueModelVersion: string;
  policyConfig: RecommendationPolicyV1Config & { minimumBehaviorSupport: number };
}

export interface RecommendationPolicyBuildV1Result {
  ready: true;
  policyArtifact: RecommendationPolicyArtifactV1;
  policyArtifactContent: string;
  policyArtifactSha256: string;
  manifest: ModelBundleManifestV1;
  manifestSha256: string;
  nextRequiredStep: string;
}

@Injectable()
export class RecommendationPolicyBuildV1Service {
  constructor(
    @InjectRepository(RecommendationEvidenceSnapshotV8)
    private readonly snapshotRepo: Repository<RecommendationEvidenceSnapshotV8>,
    private readonly modelRegistry: ModelBundleRegistryService,
    private readonly roadmapEvidence: RecommendationRoadmapEvidenceService,
  ) {}

  async build(input: RecommendationPolicyBuildV1Input): Promise<RecommendationPolicyBuildV1Result> {
    validateIdentity(input);
    const [behavioral, value, roadmap] = await Promise.all([
      this.modelRegistry.getVerified(input.behavioralModelId, input.behavioralModelVersion),
      this.modelRegistry.getVerified(input.valueModelId, input.valueModelVersion),
      this.roadmapEvidence.report(),
    ]);
    if (behavioral.manifest.modelKind !== 'BEHAVIORAL') {
      throw new Error(`Policy build requires a BEHAVIORAL dependency, got ${behavioral.manifest.modelKind}`);
    }
    if (value.manifest.modelKind !== 'VALUE') {
      throw new Error(`Policy build requires a VALUE dependency, got ${value.manifest.modelKind}`);
    }
    if (behavioral.manifest.futureTestEvaluated || value.manifest.futureTestEvaluated) {
      throw new Error('Policy dependencies must not use FUTURE_TEST');
    }
    if (!roadmap.evidence.futureTestUntouched) throw new Error('FUTURE_TEST_INTEGRITY_VIOLATION');
    if ((roadmap.evidence.futureTestEvaluation ?? 'NOT_EVALUATED') !== 'NOT_EVALUATED') {
      throw new Error('FUTURE_TEST_ALREADY_EVALUATED');
    }
    const causalValue = roadmap.state.phases.find((phase) => phase.phase === 'CAUSAL_VALUE');
    if (!causalValue?.unlocked) {
      throw new Error(`POLICY_BUILD_NOT_AUTHORIZED:${causalValue?.blockers.join(',') ?? 'CAUSAL_VALUE_NOT_FOUND'}`);
    }

    await this.assertEvidenceSubject(
      roadmap.latestEvidenceByGate?.behavioralOffline,
      'behavioralOffline',
      behavioral.manifestSha256,
      (report) => stringAt(report, ['manifestSha256']),
    );
    await this.assertEvidenceSubject(
      roadmap.latestEvidenceByGate?.causalValueRelease,
      'causalValueRelease',
      value.manifestSha256,
      (report) => stringAt(report, ['model', 'manifestSha256']),
    );

    assertCompatibleDependencies(behavioral.manifest, value.manifest);
    const supportedRulesetVersions = intersection(
      behavioral.manifest.supportedRulesetVersions,
      value.manifest.supportedRulesetVersions,
    );
    const supportedCatalogSha256 = intersection(
      behavioral.manifest.supportedCatalogSha256,
      value.manifest.supportedCatalogSha256,
    );
    if (supportedRulesetVersions.length === 0) throw new Error('POLICY_DEPENDENCY_RULESET_INTERSECTION_EMPTY');
    if (supportedCatalogSha256.length === 0) throw new Error('POLICY_DEPENDENCY_CATALOG_INTERSECTION_EMPTY');

    const policyArtifact: RecommendationPolicyArtifactV1 = {
      contractVersion: RECOMMENDATION_POLICY_ARTIFACT_V1,
      policyConfig: { ...input.policyConfig },
      behavioral: {
        modelId: behavioral.manifest.modelId,
        modelVersion: behavioral.manifest.modelVersion,
        modelKind: 'BEHAVIORAL',
        manifestSha256: behavioral.manifestSha256,
      },
      value: {
        modelId: value.manifest.modelId,
        modelVersion: value.manifest.modelVersion,
        modelKind: 'VALUE',
        manifestSha256: value.manifestSha256,
      },
      featureContractVersion: behavioral.manifest.featureContractVersion,
      actionContractVersion: behavioral.manifest.actionContractVersion,
      candidateGeneratorVersion: behavioral.manifest.candidateGeneratorVersion,
      supportedRulesetVersions,
      supportedCatalogSha256,
      futureTestEvaluated: false,
    };
    assertRecommendationPolicyArtifactV1(policyArtifact);
    const policyArtifactContent = `${JSON.stringify(policyArtifact, null, 2)}\n`;
    const policyArtifactSha256 = sha256(policyArtifactContent);
    const manifest: ModelBundleManifestV1 = {
      contractVersion: MODEL_BUNDLE_CONTRACT_VERSION,
      modelId: input.modelId,
      modelVersion: input.modelVersion,
      modelKind: 'POLICY',
      createdAt: new Date().toISOString(),
      sourceCommitSha: input.sourceCommitSha,
      datasetId: value.manifest.datasetId,
      datasetSha256: value.manifest.datasetSha256,
      featureContractVersion: behavioral.manifest.featureContractVersion,
      actionContractVersion: behavioral.manifest.actionContractVersion,
      candidateGeneratorVersion: behavioral.manifest.candidateGeneratorVersion,
      supportedRulesetVersions,
      supportedCatalogSha256,
      trainingConfigSha256: policyArtifactSha256,
      files: [{
        path: 'policy.json',
        sha256: policyArtifactSha256,
        sizeBytes: Buffer.byteLength(policyArtifactContent),
      }],
      gates: [
        { name: 'BEHAVIORAL_DEPENDENCY_VERIFIED', status: 'PASS', value: behavioral.manifestSha256 },
        { name: 'VALUE_DEPENDENCY_VERIFIED', status: 'PASS', value: value.manifestSha256 },
        { name: 'CAUSAL_VALUE_RELEASE', status: 'PASS' },
        { name: 'POLICY_SUPPORT_CONSTRAINT', status: 'PASS', value: input.policyConfig.minimumBehaviorSupport, threshold: '>0' },
        { name: 'FUTURE_TEST_UNTOUCHED', status: 'PASS', value: false, threshold: false },
      ],
      futureTestEvaluated: false,
      notes: `Support-constrained Policy V1. behavioralManifestSha256=${behavioral.manifestSha256};valueManifestSha256=${value.manifestSha256}. Not activated or deployed by build.`,
    };
    const validation = validateModelBundleManifestV1(manifest);
    if (!validation.valid) throw new Error(`Generated Policy model bundle is invalid: ${validation.errors.join(',')}`);
    return {
      ready: true,
      policyArtifact,
      policyArtifactContent,
      policyArtifactSha256,
      manifest,
      manifestSha256: modelManifestSha256V1(manifest),
      nextRequiredStep: 'Write policyArtifactContent exactly as policy.json, upload policy.json and manifest.json to an approved immutable store, register the manifest, independently verify hashes, then run Policy A/B before any FUTURE_TEST evaluation.',
    };
  }

  private async assertEvidenceSubject(
    record: { status?: string; subjectSha256?: string } | undefined,
    gateName: 'behavioralOffline' | 'causalValueRelease',
    expectedManifestSha256: string,
    readManifestSha: (report: unknown) => string | undefined,
  ): Promise<void> {
    if (record?.status !== 'PASS' || !record.subjectSha256) {
      throw new Error(`POLICY_BUILD_REQUIRES_${gateName.toUpperCase()}_PASS_EVIDENCE`);
    }
    const snapshot = await this.snapshotRepo.findOne({ where: { subjectSha256: record.subjectSha256 } });
    if (!snapshot || snapshot.gateName !== gateName || snapshot.evaluator !== ADVANCED_EVIDENCE_EVALUATOR) {
      throw new Error(`POLICY_BUILD_${gateName.toUpperCase()}_SNAPSHOT_INVALID`);
    }
    if (readManifestSha(snapshot.report) !== expectedManifestSha256) {
      throw new Error(`POLICY_BUILD_${gateName.toUpperCase()}_MODEL_MISMATCH`);
    }
  }
}

function validateIdentity(input: RecommendationPolicyBuildV1Input): void {
  for (const [name, value] of [
    ['modelId', input.modelId],
    ['modelVersion', input.modelVersion],
    ['behavioralModelId', input.behavioralModelId],
    ['behavioralModelVersion', input.behavioralModelVersion],
    ['valueModelId', input.valueModelId],
    ['valueModelVersion', input.valueModelVersion],
  ] as const) {
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(value)) throw new Error(`${name} is invalid`);
  }
  if (!/^[a-f0-9]{40}$/i.test(input.sourceCommitSha)) throw new Error('sourceCommitSha is invalid');
}

function assertCompatibleDependencies(behavioral: ModelBundleManifestV1, value: ModelBundleManifestV1): void {
  if (behavioral.featureContractVersion !== value.featureContractVersion) throw new Error('POLICY_DEPENDENCY_FEATURE_CONTRACT_MISMATCH');
  if (behavioral.actionContractVersion !== value.actionContractVersion) throw new Error('POLICY_DEPENDENCY_ACTION_CONTRACT_MISMATCH');
  if (behavioral.candidateGeneratorVersion !== value.candidateGeneratorVersion) throw new Error('POLICY_DEPENDENCY_CANDIDATE_GENERATOR_MISMATCH');
}

function intersection(left: readonly string[], right: readonly string[]): string[] {
  const rightSet = new Set(right);
  return [...new Set(left.filter((value) => rightSet.has(value)))].sort();
}

function stringAt(value: unknown, path: readonly string[]): string | undefined {
  let current: unknown = value;
  for (const key of path) {
    if (typeof current !== 'object' || current === null || !(key in current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === 'string' ? current : undefined;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
