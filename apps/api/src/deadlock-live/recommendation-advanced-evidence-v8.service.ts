import { createHash } from 'crypto';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  ModelBundleGateV1,
  RECOMMENDATION_ROADMAP_EVIDENCE_VERSION,
  RecommendationRoadmapEvidenceGateNameV1,
  RecommendationRoadmapEvidenceRecordV1,
  RecommendationRoadmapGateStateV1,
  evaluateValuePolicyReleaseGateV1,
} from '@deadlock-live-probe/shared';
import { ModelBundleRegistryService } from './model-bundle-registry.service';
import { RecommendationAbReportService } from './recommendation-ab-report.service';
import { RecommendationEvidenceSnapshotV8 } from './entities/recommendation-evidence-snapshot-v8.entity';
import { RecommendationOpeReportService, RecommendationOpeRewardV1 } from './recommendation-ope-report.service';
import { RecommendationRoadmapEvidenceService } from './recommendation-roadmap-evidence.service';
import { RecommendationShadowReportService } from './recommendation-shadow-report.service';

const EVALUATOR = 'recommendation-advanced-evidence-v8';

const REQUIRED_BEHAVIORAL_GATES = [
  'BEHAVIORAL_OFFLINE',
  'BEHAVIORAL_SUPPORT',
  'BEHAVIORAL_MAJOR_COHORT_SUPPORT',
  'BEHAVIORAL_CANDIDATE_COVERAGE',
  'BEHAVIORAL_ILLEGAL_CANDIDATE_RATE',
  'NO_PROBABILITY_FLOOR',
  'RNN_TRANSFORMER_ABLATION',
  'FUTURE_TEST_UNTOUCHED',
] as const;

const REQUIRED_VALUE_SENSITIVITY_GATES = [
  'VALUE_ACTION_SENSITIVITY',
  'STATE_ONLY_ABLATION',
  'CANDIDATE_PERMUTATION',
] as const;

export type RecommendationExperimentEvidenceGateV8 =
  | 'matchLevelAbSafety'
  | 'safeExplorationSafety'
  | 'policyAbRelease';

export interface RecommendationAdvancedEvidenceWindowV8 {
  from?: Date;
  to?: Date;
}

export interface RecommendationExperimentEvidenceInputV8 extends RecommendationAdvancedEvidenceWindowV8 {
  experimentId: string;
  controlArm: string;
  treatmentArm: string;
  reward: RecommendationOpeRewardV1;
  gateName: RecommendationExperimentEvidenceGateV8;
  modelId?: string;
  modelVersion?: string;
}

export interface RecommendationOpeEvidenceInputV8 extends RecommendationAdvancedEvidenceWindowV8 {
  reward: RecommendationOpeRewardV1;
}

export interface RecommendationCausalValueEvidenceInputV8 extends RecommendationOpeEvidenceInputV8 {
  modelId: string;
  modelVersion: string;
}

export interface RecommendationMaterializedAdvancedGateV8 {
  gateName: RecommendationRoadmapEvidenceGateNameV1;
  status: RecommendationRoadmapGateStateV1;
  subjectSha256: string;
  evidenceRef: string;
  snapshotStatus: 'APPENDED' | 'DUPLICATE';
  evidenceStatus: 'APPENDED' | 'DUPLICATE';
}

@Injectable()
export class RecommendationAdvancedEvidenceV8Service {
  constructor(
    @InjectRepository(RecommendationEvidenceSnapshotV8)
    private readonly snapshotRepo: Repository<RecommendationEvidenceSnapshotV8>,
    private readonly modelRegistry: ModelBundleRegistryService,
    private readonly shadowReports: RecommendationShadowReportService,
    private readonly abReports: RecommendationAbReportService,
    private readonly opeReports: RecommendationOpeReportService,
    private readonly roadmapEvidence: RecommendationRoadmapEvidenceService,
  ) {}

  async materializeBehavioralModel(
    modelId: string,
    modelVersion: string,
  ): Promise<RecommendationMaterializedAdvancedGateV8> {
    const model = await this.modelRegistry.getVerified(modelId, modelVersion);
    if (model.manifest.modelKind !== 'BEHAVIORAL') {
      throw new Error(`Behavioral evidence requires a BEHAVIORAL bundle, got ${model.manifest.modelKind}`);
    }
    const gateStatus = requiredModelGateStatus(model.manifest.gates, REQUIRED_BEHAVIORAL_GATES);
    const status: RecommendationRoadmapGateStateV1 = model.manifest.futureTestEvaluated
      ? 'FAIL'
      : gateStatus;
    return this.persistGate('behavioralOffline', status, {
      generatedAt: new Date().toISOString(),
      modelId,
      modelVersion,
      registryStatus: model.status,
      manifestSha256: model.manifestSha256,
      verifiedAt: model.verifiedAt?.toISOString(),
      futureTestEvaluated: model.manifest.futureTestEvaluated,
      requiredGates: modelGateEvidence(model.manifest.gates, REQUIRED_BEHAVIORAL_GATES),
    }, status === 'PASS' ? [] : ['VERIFIED_BEHAVIORAL_MODEL_GATE_NOT_PASS']);
  }

  async materializeShadow(
    options: RecommendationAdvancedEvidenceWindowV8 = {},
  ): Promise<RecommendationMaterializedAdvancedGateV8> {
    const report = await this.shadowReports.buildReport(options);
    const status = report.evidenceSufficient
      ? (report.gate?.passed ? 'PASS' : 'FAIL')
      : 'INSUFFICIENT_EVIDENCE';
    return this.persistGate('shadowSafety', status, report, [
      ...report.evidenceBlockers,
      ...(report.gate?.checks.filter((check) => !check.passed).map((check) => check.name) ?? []),
    ]);
  }

  async materializeExperiment(
    input: RecommendationExperimentEvidenceInputV8,
  ): Promise<readonly RecommendationMaterializedAdvancedGateV8[]> {
    const report = await this.abReports.buildReport(input);
    const safetyStatus: RecommendationRoadmapGateStateV1 = report.evidenceSufficient
      ? (report.gate?.passed ? 'PASS' : 'FAIL')
      : 'INSUFFICIENT_EVIDENCE';
    const exactPropensityStatus: RecommendationRoadmapGateStateV1 = !report.evidenceSufficient
      ? 'INSUFFICIENT_EVIDENCE'
      : report.metrics?.exactLoggedPropensityRate === 1
        ? 'PASS'
        : 'FAIL';
    const blockers = [
      ...report.blockers,
      ...(report.gate?.checks.filter((check) => !check.passed).map((check) => check.name) ?? []),
    ];

    let gateReport: unknown = report;
    if (input.gateName === 'policyAbRelease') {
      if (!input.modelId || !input.modelVersion) {
        throw new Error('POLICY_AB_RELEASE_REQUIRES_FROZEN_POLICY_MODEL');
      }
      const policy = await this.modelRegistry.getVerified(input.modelId, input.modelVersion);
      if (policy.manifest.modelKind !== 'POLICY') {
        throw new Error(`Policy A/B evidence requires a POLICY bundle, got ${policy.manifest.modelKind}`);
      }
      if (policy.manifest.futureTestEvaluated) {
        throw new Error('Policy A/B release must be evaluated before FUTURE_TEST');
      }
      gateReport = {
        generatedAt: report.generatedAt,
        policy: {
          modelId: input.modelId,
          modelVersion: input.modelVersion,
          manifestSha256: policy.manifestSha256,
          registryStatus: policy.status,
          verifiedAt: policy.verifiedAt?.toISOString(),
          futureTestEvaluated: policy.manifest.futureTestEvaluated,
        },
        experiment: report,
      };
    }

    return [
      await this.persistGate(input.gateName, safetyStatus, gateReport, blockers),
      await this.persistGate(
        'exactActionPropensity',
        exactPropensityStatus,
        {
          generatedAt: report.generatedAt,
          experimentId: report.experimentId,
          gateSource: input.gateName,
          decisionCount: report.decisionCount,
          evidenceSufficient: report.evidenceSufficient,
          exactLoggedPropensityRate: report.metrics?.exactLoggedPropensityRate,
          blockers: report.blockers,
        },
        exactPropensityStatus === 'PASS' ? [] : ['EXACT_ACTION_PROPENSITY_NOT_COMPLETE'],
      ),
    ];
  }

  async materializeOpe(
    input: RecommendationOpeEvidenceInputV8,
  ): Promise<RecommendationMaterializedAdvancedGateV8> {
    const report = await this.opeReports.buildReport(input);
    const status: RecommendationRoadmapGateStateV1 = !report.evidenceSufficient
      ? 'INSUFFICIENT_EVIDENCE'
      : report.evaluation?.passedSupportGate
        ? 'PASS'
        : 'FAIL';
    return this.persistGate('offPolicySupport', status, report, [
      ...report.blockers,
      ...(status === 'FAIL' ? ['OPE_SUPPORT_GATE_NOT_PASS'] : []),
    ]);
  }

  async materializeCausalValue(
    input: RecommendationCausalValueEvidenceInputV8,
  ): Promise<readonly RecommendationMaterializedAdvancedGateV8[]> {
    const [model, ope] = await Promise.all([
      this.modelRegistry.getVerified(input.modelId, input.modelVersion),
      this.opeReports.buildReport(input),
    ]);
    if (model.manifest.modelKind !== 'VALUE') {
      throw new Error(`Causal Value evidence requires a VALUE bundle, got ${model.manifest.modelKind}`);
    }
    if (model.manifest.futureTestEvaluated) {
      throw new Error('Causal Value model bundle must not use FUTURE_TEST');
    }

    const sensitivityStatus = requiredModelGateStatus(
      model.manifest.gates,
      REQUIRED_VALUE_SENSITIVITY_GATES,
    );
    const offPolicyStatus: RecommendationRoadmapGateStateV1 = !ope.evidenceSufficient
      ? 'INSUFFICIENT_EVIDENCE'
      : ope.evaluation?.passedSupportGate
        ? 'PASS'
        : 'FAIL';
    const evaluation = ope.evaluation;
    const actionResidualVariance = numericModelGate(model.manifest.gates, 'ACTION_RESIDUAL_VARIANCE');
    const illegalCandidateRate = numericModelGate(model.manifest.gates, 'ILLEGAL_CANDIDATE_RATE');
    const releaseEvidenceComplete = evaluation?.doublyRobustUplift !== undefined
      && evaluation.doublyRobustUpliftCiLow !== undefined
      && evaluation.doublyRobustUpliftCiHigh !== undefined
      && actionResidualVariance !== undefined
      && illegalCandidateRate !== undefined;
    const release = releaseEvidenceComplete
      ? evaluateValuePolicyReleaseGateV1({
          valueActionSensitivityPassed: sensitivityStatus === 'PASS',
          offPolicySupportPassed: offPolicyStatus === 'PASS',
          doublyRobustEstimate: evaluation!.doublyRobustUplift!,
          doublyRobustCiLow: evaluation!.doublyRobustUpliftCiLow!,
          doublyRobustCiHigh: evaluation!.doublyRobustUpliftCiHigh!,
          effectiveSampleSize: evaluation!.effectiveSampleSize,
          actionResidualVariance: actionResidualVariance!,
          illegalCandidateRate: illegalCandidateRate!,
        })
      : undefined;
    const causalStatus: RecommendationRoadmapGateStateV1 = !releaseEvidenceComplete || !ope.evidenceSufficient
      ? 'INSUFFICIENT_EVIDENCE'
      : release?.passed
        ? 'PASS'
        : 'FAIL';
    const generatedAt = new Date().toISOString();
    const modelEvidence = {
      generatedAt,
      modelId: input.modelId,
      modelVersion: input.modelVersion,
      manifestSha256: model.manifestSha256,
      registryStatus: model.status,
      verifiedAt: model.verifiedAt?.toISOString(),
      requiredSensitivityGates: modelGateEvidence(model.manifest.gates, REQUIRED_VALUE_SENSITIVITY_GATES),
      actionResidualVariance,
      illegalCandidateRate,
      futureTestEvaluated: model.manifest.futureTestEvaluated,
    };
    return [
      await this.persistGate(
        'valueActionSensitivity',
        sensitivityStatus,
        modelEvidence,
        sensitivityStatus === 'PASS' ? [] : ['VALUE_ACTION_SENSITIVITY_EVIDENCE_NOT_PASS'],
      ),
      await this.persistGate(
        'offPolicySupport',
        offPolicyStatus,
        ope,
        offPolicyStatus === 'PASS' ? [] : [...ope.blockers, 'OPE_SUPPORT_GATE_NOT_PASS'],
      ),
      await this.persistGate(
        'causalValueRelease',
        causalStatus,
        {
          generatedAt,
          model: modelEvidence,
          ope,
          release,
        },
        causalStatus === 'PASS'
          ? []
          : [...(release?.blockers ?? []), ...(!releaseEvidenceComplete ? ['VALUE_RELEASE_EVIDENCE_INCOMPLETE'] : [])],
      ),
    ];
  }

  private async persistGate(
    gateName: RecommendationRoadmapEvidenceGateNameV1,
    status: RecommendationRoadmapGateStateV1,
    report: unknown,
    blockers: readonly string[],
  ): Promise<RecommendationMaterializedAdvancedGateV8> {
    if (status === 'NOT_EVALUATED') throw new Error('Materialized evidence cannot be NOT_EVALUATED');
    const evaluatedAt = reportEvaluatedAt(report);
    const subjectSha256 = sha256Canonical({ gateName, report });
    const evidenceRef = `/deadlock-live/recommendation-roadmap/v1/evidence-snapshots/${subjectSha256}`;
    const snapshotStatus = await this.persistSnapshot({
      subjectSha256,
      gateName,
      evaluator: EVALUATOR,
      evaluatedAt,
      report,
    });
    const record: RecommendationRoadmapEvidenceRecordV1 = {
      contractVersion: RECOMMENDATION_ROADMAP_EVIDENCE_VERSION,
      evidenceId: `v8:${gateName}:${subjectSha256}`,
      gateName,
      status,
      evidenceRef,
      evaluator: EVALUATOR,
      evaluatedAt,
      subjectSha256,
      notes: blockers.length > 0 ? `blockers=${[...new Set(blockers)].sort().join('|')}` : 'blockers=none',
    };
    const evidence = await this.roadmapEvidence.append(record);
    return {
      gateName,
      status,
      subjectSha256,
      evidenceRef,
      snapshotStatus,
      evidenceStatus: evidence.status,
    };
  }

  private async persistSnapshot(input: {
    subjectSha256: string;
    gateName: RecommendationRoadmapEvidenceGateNameV1;
    evaluator: string;
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
        gateName: input.gateName,
        evaluator: input.evaluator,
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

function requiredModelGateStatus(
  gates: readonly ModelBundleGateV1[],
  names: readonly string[],
): RecommendationRoadmapGateStateV1 {
  const byName = new Map(gates.map((gate) => [gate.name, gate]));
  if (names.some((name) => !byName.has(name))) return 'INSUFFICIENT_EVIDENCE';
  return names.every((name) => byName.get(name)?.status === 'PASS') ? 'PASS' : 'FAIL';
}

function modelGateEvidence(gates: readonly ModelBundleGateV1[], names: readonly string[]) {
  const byName = new Map(gates.map((gate) => [gate.name, gate]));
  return names.map((name) => byName.get(name) ?? { name, status: 'NOT_EVALUATED' as const });
}

function numericModelGate(gates: readonly ModelBundleGateV1[], name: string): number | undefined {
  const value = gates.find((gate) => gate.name === name)?.value;
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function assertSameSnapshot(
  existing: RecommendationEvidenceSnapshotV8,
  input: {
    subjectSha256: string;
    gateName: RecommendationRoadmapEvidenceGateNameV1;
    evaluator: string;
    evaluatedAt: string;
    report: unknown;
  },
): void {
  const same = existing.subjectSha256 === input.subjectSha256
    && existing.gateName === input.gateName
    && existing.evaluator === input.evaluator
    && existing.evaluatedAt.toISOString() === input.evaluatedAt
    && canonicalJson(existing.report) === canonicalJson(input.report);
  if (!same) throw new Error(`Immutable recommendation evidence snapshot conflict: ${input.subjectSha256}`);
}

function reportEvaluatedAt(report: unknown): string {
  if (typeof report === 'object' && report !== null && 'generatedAt' in report) {
    const value = (report as { generatedAt?: unknown }).generatedAt;
    if (typeof value === 'string' && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
  }
  throw new Error('Materialized evidence report must include a valid generatedAt timestamp');
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
