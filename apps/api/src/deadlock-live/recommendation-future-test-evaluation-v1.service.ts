import { createHash } from 'crypto';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  RECOMMENDATION_FUTURE_TEST_EVALUATOR_V1,
  RECOMMENDATION_ROADMAP_EVIDENCE_VERSION,
  RecommendationFutureTestEvaluationArtifactV1,
  RecommendationRoadmapEvidenceRecordV1,
  assertRecommendationFutureTestEvaluationArtifactV1,
} from '@deadlock-live-probe/shared';
import { ModelBundleRegistryService } from './model-bundle-registry.service';
import { RecommendationEvidenceSnapshotV8 } from './entities/recommendation-evidence-snapshot-v8.entity';
import { RecommendationRoadmapEvidenceService } from './recommendation-roadmap-evidence.service';

const ADVANCED_EVIDENCE_EVALUATOR = 'recommendation-advanced-evidence-v8';

export interface RecommendationFutureTestMaterializationV1 {
  gateName: 'futureTestEvaluation';
  status: 'PASS' | 'FAIL';
  policyManifestSha256: string;
  evaluationSnapshotSha256: string;
  evidenceRef: string;
  snapshotStatus: 'APPENDED' | 'DUPLICATE';
  evidenceStatus: 'APPENDED' | 'DUPLICATE';
}

@Injectable()
export class RecommendationFutureTestEvaluationV1Service {
  constructor(
    @InjectRepository(RecommendationEvidenceSnapshotV8)
    private readonly snapshotRepo: Repository<RecommendationEvidenceSnapshotV8>,
    private readonly modelRegistry: ModelBundleRegistryService,
    private readonly roadmapEvidence: RecommendationRoadmapEvidenceService,
  ) {}

  async materialize(
    artifact: RecommendationFutureTestEvaluationArtifactV1,
  ): Promise<RecommendationFutureTestMaterializationV1> {
    assertRecommendationFutureTestEvaluationArtifactV1(artifact);
    validateImmutableArtifactRef(artifact.evaluationArtifactRef);

    const [policy, roadmap] = await Promise.all([
      this.modelRegistry.getVerified(artifact.policyModelId, artifact.policyModelVersion),
      this.roadmapEvidence.report(),
    ]);
    if (policy.manifest.modelKind !== 'POLICY') {
      throw new Error(`FUTURE_TEST requires a verified POLICY bundle, got ${policy.manifest.modelKind}`);
    }
    if (policy.manifestSha256 !== artifact.policyManifestSha256) {
      throw new Error('FUTURE_TEST policy manifest SHA does not match the verified registry artifact');
    }
    if (policy.manifest.futureTestEvaluated) {
      throw new Error('FUTURE_TEST subject policy bundle already declares a prior FUTURE_TEST evaluation');
    }
    if (!roadmap.evidence.futureTestUntouched) throw new Error('FUTURE_TEST_INTEGRITY_VIOLATION');
    if ((roadmap.evidence.futureTestEvaluation ?? 'NOT_EVALUATED') !== 'NOT_EVALUATED') {
      throw new Error('FUTURE_TEST_EVALUATION_ALREADY_RECORDED');
    }
    const policyPhase = roadmap.state.phases.find((phase) => phase.phase === 'POLICY_V1');
    if (!policyPhase?.unlocked) {
      throw new Error(`FUTURE_TEST_EVALUATION_NOT_AUTHORIZED:${policyPhase?.blockers.join(',') ?? 'POLICY_V1_NOT_FOUND'}`);
    }

    const policyRelease = roadmap.latestEvidenceByGate?.policyAbRelease;
    if (policyRelease?.status !== 'PASS' || !policyRelease.subjectSha256) {
      throw new Error('FUTURE_TEST_REQUIRES_POLICY_AB_RELEASE_EVIDENCE');
    }
    const policyReleaseSnapshot = await this.snapshotRepo.findOne({
      where: { subjectSha256: policyRelease.subjectSha256 },
    });
    if (!policyReleaseSnapshot
      || policyReleaseSnapshot.gateName !== 'policyAbRelease'
      || policyReleaseSnapshot.evaluator !== ADVANCED_EVIDENCE_EVALUATOR) {
      throw new Error('FUTURE_TEST_POLICY_AB_RELEASE_SNAPSHOT_INVALID');
    }
    const releasedPolicyManifestSha256 = policyManifestShaFromReleaseSnapshot(policyReleaseSnapshot.report);
    if (releasedPolicyManifestSha256 !== policy.manifestSha256) {
      throw new Error('FUTURE_TEST_POLICY_DOES_NOT_MATCH_POLICY_AB_RELEASE');
    }

    const report = {
      contractVersion: artifact.contractVersion,
      generatedAt: new Date().toISOString(),
      evaluatedAt: new Date(artifact.evaluatedAt).toISOString(),
      gateStatus: artifact.gateStatus,
      frozenPolicy: {
        modelId: artifact.policyModelId,
        modelVersion: artifact.policyModelVersion,
        manifestSha256: policy.manifestSha256,
        registryStatus: policy.status,
        verifiedAt: policy.verifiedAt?.toISOString(),
        policyAbReleaseEvidenceId: policyRelease.evidenceId,
        policyAbReleaseSnapshotSha256: policyRelease.subjectSha256,
      },
      evaluationPlanSha256: artifact.evaluationPlanSha256,
      evaluationArtifactSha256: artifact.evaluationArtifactSha256,
      evaluationArtifactRef: artifact.evaluationArtifactRef,
      modelSelectionFrozen: artifact.modelSelectionFrozen,
      hyperparametersFrozen: artifact.hyperparametersFrozen,
      candidateGeneratorFrozen: artifact.candidateGeneratorFrozen,
      featureContractFrozen: artifact.featureContractFrozen,
      futureTestAccessCount: artifact.futureTestAccessCount,
    };
    const evaluationSnapshotSha256 = sha256Canonical({ gateName: 'futureTestEvaluation', report });
    const evidenceRef = `/deadlock-live/recommendation-roadmap/v1/evidence-snapshots/${evaluationSnapshotSha256}`;
    const snapshotStatus = await this.persistSnapshot({
      subjectSha256: evaluationSnapshotSha256,
      evaluatedAt: report.evaluatedAt,
      report,
    });
    const record: RecommendationRoadmapEvidenceRecordV1 = {
      contractVersion: RECOMMENDATION_ROADMAP_EVIDENCE_VERSION,
      evidenceId: `v8:futureTestEvaluation:${policy.manifestSha256}:${evaluationSnapshotSha256}`,
      gateName: 'futureTestEvaluation',
      status: artifact.gateStatus,
      evidenceRef,
      evaluator: RECOMMENDATION_FUTURE_TEST_EVALUATOR_V1,
      evaluatedAt: report.evaluatedAt,
      subjectSha256: policy.manifestSha256,
      notes: `evaluationPlanSha256=${artifact.evaluationPlanSha256};evaluationArtifactSha256=${artifact.evaluationArtifactSha256}`,
    };
    const evidence = await this.roadmapEvidence.append(record);
    return {
      gateName: 'futureTestEvaluation',
      status: artifact.gateStatus,
      policyManifestSha256: policy.manifestSha256,
      evaluationSnapshotSha256,
      evidenceRef,
      snapshotStatus,
      evidenceStatus: evidence.status,
    };
  }

  private async persistSnapshot(input: {
    subjectSha256: string;
    evaluatedAt: string;
    report: unknown;
  }): Promise<'APPENDED' | 'DUPLICATE'> {
    const existing = await this.snapshotRepo.findOne({ where: { subjectSha256: input.subjectSha256 } });
    if (existing) {
      assertSameSnapshot(existing, input);
      return 'DUPLICATE';
    }
    try {
      await this.snapshotRepo.save(this.snapshotRepo.create({
        subjectSha256: input.subjectSha256,
        gateName: 'futureTestEvaluation',
        evaluator: RECOMMENDATION_FUTURE_TEST_EVALUATOR_V1,
        evaluatedAt: new Date(input.evaluatedAt),
        report: input.report,
      }));
      return 'APPENDED';
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const raced = await this.snapshotRepo.findOne({ where: { subjectSha256: input.subjectSha256 } });
      if (!raced) throw error;
      assertSameSnapshot(raced, input);
      return 'DUPLICATE';
    }
  }
}

function policyManifestShaFromReleaseSnapshot(report: unknown): string | undefined {
  if (typeof report !== 'object' || report === null || !('policy' in report)) return undefined;
  const policy = (report as { policy?: unknown }).policy;
  if (typeof policy !== 'object' || policy === null || !('manifestSha256' in policy)) return undefined;
  const value = (policy as { manifestSha256?: unknown }).manifestSha256;
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value) ? value : undefined;
}

function validateImmutableArtifactRef(value: string): void {
  const trimmed = value.trim();
  if (!/^(s3|gs|https):\/\//.test(trimmed)) {
    throw new Error('FUTURE_TEST evaluationArtifactRef must use an approved immutable remote store');
  }
  if (trimmed.includes('..')) throw new Error('FUTURE_TEST evaluationArtifactRef must not contain parent traversal');
}

function assertSameSnapshot(
  existing: RecommendationEvidenceSnapshotV8,
  input: { subjectSha256: string; evaluatedAt: string; report: unknown },
): void {
  const same = existing.subjectSha256 === input.subjectSha256
    && existing.gateName === 'futureTestEvaluation'
    && existing.evaluator === RECOMMENDATION_FUTURE_TEST_EVALUATOR_V1
    && existing.evaluatedAt.toISOString() === input.evaluatedAt
    && canonicalJson(existing.report) === canonicalJson(input.report);
  if (!same) throw new Error(`Immutable FUTURE_TEST evaluation snapshot conflict: ${input.subjectSha256}`);
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

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}
