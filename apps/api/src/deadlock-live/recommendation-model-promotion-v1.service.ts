import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  RECOMMENDATION_FUTURE_TEST_EVALUATOR_V1,
  ModelBundleRuntimeCompatibilityV1,
} from '@deadlock-live-probe/shared';
import {
  ModelBundleRegistryService,
} from './model-bundle-registry.service';
import { RecommendationEvidenceSnapshotV8 } from './entities/recommendation-evidence-snapshot-v8.entity';
import { RecommendationRoadmapEvidenceService } from './recommendation-roadmap-evidence.service';

const ADVANCED_EVIDENCE_EVALUATOR = 'recommendation-advanced-evidence-v8';

export interface RecommendationModelPromotionV1Input {
  modelId: string;
  modelVersion: string;
  runtime: ModelBundleRuntimeCompatibilityV1;
}

@Injectable()
export class RecommendationModelPromotionV1Service {
  constructor(
    @InjectRepository(RecommendationEvidenceSnapshotV8)
    private readonly snapshotRepo: Repository<RecommendationEvidenceSnapshotV8>,
    private readonly registry: ModelBundleRegistryService,
    private readonly roadmapEvidence: RecommendationRoadmapEvidenceService,
  ) {}

  async promote(input: RecommendationModelPromotionV1Input) {
    const [model, roadmap] = await Promise.all([
      this.registry.getVerified(input.modelId, input.modelVersion),
      this.roadmapEvidence.report(),
    ]);
    if (!roadmap.evidence.futureTestUntouched) throw new Error('FUTURE_TEST_INTEGRITY_VIOLATION');

    if (model.manifest.modelKind === 'BEHAVIORAL') {
      await this.assertAdvancedEvidenceSubject(
        roadmap.latestEvidenceByGate?.behavioralOffline,
        'behavioralOffline',
        model.manifestSha256,
        (report) => stringAt(report, ['manifestSha256']),
      );
    } else if (model.manifest.modelKind === 'VALUE') {
      await this.assertAdvancedEvidenceSubject(
        roadmap.latestEvidenceByGate?.causalValueRelease,
        'causalValueRelease',
        model.manifestSha256,
        (report) => stringAt(report, ['model', 'manifestSha256']),
      );
    } else if (model.manifest.modelKind === 'POLICY') {
      await this.assertAdvancedEvidenceSubject(
        roadmap.latestEvidenceByGate?.policyAbRelease,
        'policyAbRelease',
        model.manifestSha256,
        (report) => stringAt(report, ['policy', 'manifestSha256']),
      );
      const futureTest = roadmap.latestEvidenceByGate?.futureTestEvaluation;
      if (
        futureTest?.status !== 'PASS'
        || futureTest.evaluator !== RECOMMENDATION_FUTURE_TEST_EVALUATOR_V1
        || futureTest.subjectSha256 !== model.manifestSha256
      ) {
        throw new Error('POLICY_ACTIVATION_REQUIRES_MATCHING_FUTURE_TEST_PASS');
      }
    } else {
      throw new Error(`Unsupported recommendation model kind for activation: ${model.manifest.modelKind}`);
    }

    return this.registry.activate(input);
  }

  private async assertAdvancedEvidenceSubject(
    record: { status?: string; subjectSha256?: string; evaluator?: string } | undefined,
    gateName: 'behavioralOffline' | 'causalValueRelease' | 'policyAbRelease',
    expectedManifestSha256: string,
    readManifestSha: (report: unknown) => string | undefined,
  ): Promise<void> {
    if (
      record?.status !== 'PASS'
      || !record.subjectSha256
      || record.evaluator !== ADVANCED_EVIDENCE_EVALUATOR
    ) {
      throw new Error(`MODEL_PROMOTION_REQUIRES_${gateName.toUpperCase()}_PASS_EVIDENCE`);
    }
    const snapshot = await this.snapshotRepo.findOne({ where: { subjectSha256: record.subjectSha256 } });
    if (
      !snapshot
      || snapshot.gateName !== gateName
      || snapshot.evaluator !== ADVANCED_EVIDENCE_EVALUATOR
      || readManifestSha(snapshot.report) !== expectedManifestSha256
    ) {
      throw new Error(`MODEL_PROMOTION_${gateName.toUpperCase()}_MODEL_MISMATCH`);
    }
  }
}

function stringAt(value: unknown, path: readonly string[]): string | undefined {
  let current: unknown = value;
  for (const key of path) {
    if (typeof current !== 'object' || current === null || !(key in current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === 'string' ? current : undefined;
}
