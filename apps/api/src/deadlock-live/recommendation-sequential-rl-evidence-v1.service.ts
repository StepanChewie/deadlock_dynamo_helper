import { createHash } from 'crypto';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  RECOMMENDATION_FUTURE_TEST_EVALUATOR_V1,
  RECOMMENDATION_ROADMAP_EVIDENCE_VERSION,
  RECOMMENDATION_SEQUENTIAL_RL_EVALUATOR_V1,
  RecommendationRoadmapEvidenceRecordV1,
  RecommendationSequentialRlEvidenceAttestationV1,
  evaluateRecommendationSequentialRlEvidenceV1,
  validateRecommendationSequentialRlEvidenceAttestationV1,
} from '@deadlock-live-probe/shared';
import { RecommendationEvidenceSnapshotV8 } from './entities/recommendation-evidence-snapshot-v8.entity';
import { ModelBundleRegistryService } from './model-bundle-registry.service';
import { RecommendationRoadmapEvidenceService } from './recommendation-roadmap-evidence.service';

@Injectable()
export class RecommendationSequentialRlEvidenceV1Service {
  constructor(
    @InjectRepository(RecommendationEvidenceSnapshotV8)
    private readonly snapshotRepo: Repository<RecommendationEvidenceSnapshotV8>,
    private readonly modelRegistry: ModelBundleRegistryService,
    private readonly roadmapEvidence: RecommendationRoadmapEvidenceService,
  ) {}

  async materialize(attestation: RecommendationSequentialRlEvidenceAttestationV1) {
    const validationErrors = validateRecommendationSequentialRlEvidenceAttestationV1(attestation);
    if (validationErrors.length > 0) {
      throw new Error(`Sequential RL evidence attestation is invalid: ${validationErrors.join(',')}`);
    }
    const calculatedReportSha256 = sha256Canonical(attestation.report);
    if (calculatedReportSha256 !== attestation.transitionReportSha256.toLowerCase()) {
      throw new Error('SEQUENTIAL_RL_TRANSITION_REPORT_SHA256_MISMATCH');
    }

    const [policy, roadmap] = await Promise.all([
      this.modelRegistry.getVerified(attestation.policyModelId, attestation.policyModelVersion),
      this.roadmapEvidence.report(),
    ]);
    if (policy.manifest.modelKind !== 'POLICY') throw new Error('SEQUENTIAL_RL_REQUIRES_POLICY_BUNDLE');
    if (policy.manifestSha256 !== attestation.policyManifestSha256.toLowerCase()) {
      throw new Error('SEQUENTIAL_RL_POLICY_MANIFEST_MISMATCH');
    }
    if (!roadmap.evidence.futureTestUntouched) throw new Error('FUTURE_TEST_INTEGRITY_VIOLATION');

    const futureTest = roadmap.latestEvidenceByGate?.futureTestEvaluation;
    if (
      roadmap.evidence.futureTestEvaluation !== 'PASS'
      || futureTest?.status !== 'PASS'
      || futureTest.evaluator !== RECOMMENDATION_FUTURE_TEST_EVALUATOR_V1
      || futureTest.subjectSha256 !== policy.manifestSha256
    ) {
      throw new Error('SEQUENTIAL_RL_REQUIRES_MATCHING_FUTURE_TEST_PASS');
    }
    const policyRelease = roadmap.latestEvidenceByGate?.policyAbRelease;
    if (roadmap.evidence.policyAbRelease !== 'PASS' || policyRelease?.status !== 'PASS') {
      throw new Error('SEQUENTIAL_RL_REQUIRES_POLICY_AB_RELEASE_PASS');
    }

    const generatedAt = new Date(attestation.evaluatedAt).toISOString();
    const report = evaluateRecommendationSequentialRlEvidenceV1(attestation, generatedAt);
    const snapshotSubjectSha256 = sha256Canonical({
      gateName: 'sequentialRlResearchGate',
      report,
    });
    const evidenceRef = `/deadlock-live/recommendation-roadmap/v1/evidence-snapshots/${snapshotSubjectSha256}`;
    const snapshotStatus = await this.persistSnapshot(snapshotSubjectSha256, generatedAt, report);

    const record: RecommendationRoadmapEvidenceRecordV1 = {
      contractVersion: RECOMMENDATION_ROADMAP_EVIDENCE_VERSION,
      evidenceId: `v8:sequentialRlResearchGate:${snapshotSubjectSha256}`,
      gateName: 'sequentialRlResearchGate',
      status: report.status,
      evidenceRef,
      evaluator: RECOMMENDATION_SEQUENTIAL_RL_EVALUATOR_V1,
      evaluatedAt: generatedAt,
      subjectSha256: policy.manifestSha256,
      notes: report.blockers.length > 0
        ? `blockers=${report.blockers.join('|')}`
        : `transitionArtifactSha256=${report.transitionArtifactSha256}`,
    };
    const evidence = await this.roadmapEvidence.append(record);
    return {
      generatedAt,
      report,
      snapshotSubjectSha256,
      snapshotStatus,
      evidenceRef,
      evidenceStatus: evidence.status,
    };
  }

  private async persistSnapshot(
    subjectSha256: string,
    evaluatedAt: string,
    report: unknown,
  ): Promise<'APPENDED' | 'DUPLICATE'> {
    const existing = await this.snapshotRepo.findOne({ where: { subjectSha256 } });
    if (existing) {
      if (
        existing.gateName !== 'sequentialRlResearchGate'
        || existing.evaluator !== RECOMMENDATION_SEQUENTIAL_RL_EVALUATOR_V1
        || existing.evaluatedAt.toISOString() !== evaluatedAt
        || canonicalJson(existing.report) !== canonicalJson(report)
      ) {
        throw new Error(`Immutable recommendation evidence snapshot conflict: ${subjectSha256}`);
      }
      return 'DUPLICATE';
    }
    try {
      await this.snapshotRepo.save(this.snapshotRepo.create({
        subjectSha256,
        gateName: 'sequentialRlResearchGate',
        evaluator: RECOMMENDATION_SEQUENTIAL_RL_EVALUATOR_V1,
        evaluatedAt: new Date(evaluatedAt),
        report,
      }));
      return 'APPENDED';
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const raced = await this.snapshotRepo.findOne({ where: { subjectSha256 } });
      if (
        !raced
        || raced.gateName !== 'sequentialRlResearchGate'
        || raced.evaluator !== RECOMMENDATION_SEQUENTIAL_RL_EVALUATOR_V1
        || raced.evaluatedAt.toISOString() !== evaluatedAt
        || canonicalJson(raced.report) !== canonicalJson(report)
      ) throw error;
      return 'DUPLICATE';
    }
  }
}

function sha256Canonical(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}
