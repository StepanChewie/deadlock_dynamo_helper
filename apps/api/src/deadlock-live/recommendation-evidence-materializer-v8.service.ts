import { createHash } from 'crypto';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  RECOMMENDATION_DIRECT_SHOP_SOURCE_VALIDATION_EVALUATOR_V1,
  RECOMMENDATION_ROADMAP_EVIDENCE_VERSION,
  RecommendationDirectShopSourceValidationAttestationV1,
  RecommendationDirectShopSourceValidationReportV1,
  RecommendationRoadmapEvidenceGateNameV1,
  RecommendationRoadmapEvidenceRecordV1,
  RecommendationRoadmapGateStateV1,
  evaluateRecommendationDirectShopSourceValidationV1,
} from '@deadlock-live-probe/shared';
import { RecommendationDatasetV8Report, RecommendationDatasetV8ReportService } from './recommendation-dataset-v8-report.service';
import { RecommendationObservabilityReport, RecommendationObservabilityReportService } from './recommendation-observability-report.service';
import { RecommendationRoadmapEvidenceService } from './recommendation-roadmap-evidence.service';
import { SoulsAffordabilityEvidenceV2Service } from './souls-affordability-evidence-v2.service';
import { RecommendationEvidenceSnapshotV8 } from './entities/recommendation-evidence-snapshot-v8.entity';

const EVALUATOR = 'recommendation-evidence-materializer-v8';

export interface RecommendationFoundationalEvidenceMaterializationOptionsV8 {
  from?: Date;
  to?: Date;
  maximumAlignmentAgeMs?: number;
  candidateGeneratorVersion?: string;
}

export interface RecommendationMaterializedGateEvidenceV8 {
  gateName: RecommendationRoadmapEvidenceGateNameV1;
  status: RecommendationRoadmapGateStateV1;
  subjectSha256: string;
  snapshotStatus: 'APPENDED' | 'DUPLICATE';
  evidenceStatus: 'APPENDED' | 'DUPLICATE';
  evidenceRef: string;
}

export interface RecommendationFoundationalEvidenceMaterializationReportV8 {
  generatedAt: string;
  from?: string;
  to?: string;
  candidateGeneratorVersion?: string;
  gates: readonly RecommendationMaterializedGateEvidenceV8[];
}

export interface RecommendationDirectShopEvidenceMaterializationReportV8 {
  generatedAt: string;
  validation: RecommendationDirectShopSourceValidationReportV1;
  gate: RecommendationMaterializedGateEvidenceV8;
}

@Injectable()
export class RecommendationEvidenceMaterializerV8Service {
  constructor(
    @InjectRepository(RecommendationEvidenceSnapshotV8)
    private readonly snapshotRepo: Repository<RecommendationEvidenceSnapshotV8>,
    private readonly soulsEvidence: SoulsAffordabilityEvidenceV2Service,
    private readonly observability: RecommendationObservabilityReportService,
    private readonly dataset: RecommendationDatasetV8ReportService,
    private readonly roadmapEvidence: RecommendationRoadmapEvidenceService,
  ) {}

  async materializeFoundational(
    options: RecommendationFoundationalEvidenceMaterializationOptionsV8 = {},
  ): Promise<RecommendationFoundationalEvidenceMaterializationReportV8> {
    validateRange(options.from, options.to);
    const candidateGeneratorVersion = normalizeCandidateGeneratorVersion(options.candidateGeneratorVersion);
    const [souls, observability, dataset] = await Promise.all([
      this.soulsEvidence.report(),
      this.observability.buildReport({
        from: options.from,
        to: options.to,
        maximumAlignmentAgeMs: options.maximumAlignmentAgeMs,
        candidateGeneratorVersion,
      }),
      this.dataset.buildReport({
        from: options.from,
        to: options.to,
        candidateGeneratorVersion,
      }),
    ]);
    const generatedAt = new Date().toISOString();
    const soulsSnapshot = { generatedAt, report: souls };

    const materialized = [] as RecommendationMaterializedGateEvidenceV8[];
    materialized.push(await this.persistGate(
      'controlledSoulsValidation',
      controlledSoulsStatus(souls),
      soulsSnapshot,
      souls.affordability.gateFailures,
    ));
    materialized.push(await this.persistGate(
      'observabilityCoverage',
      observabilityStatus(observability),
      observability,
      observability.gate.blockers,
    ));
    materialized.push(await this.persistGate(
      'datasetV8Structural',
      datasetStructuralStatus(dataset),
      dataset,
      dataset.blockers,
    ));
    materialized.push(await this.persistGate(
      'datasetV8Empirical',
      datasetEmpiricalStatus(dataset),
      dataset,
      dataset.blockers,
    ));

    return {
      generatedAt,
      from: options.from?.toISOString(),
      to: options.to?.toISOString(),
      candidateGeneratorVersion,
      gates: materialized,
    };
  }

  async materializeDirectShopSource(
    attestation: RecommendationDirectShopSourceValidationAttestationV1,
  ): Promise<RecommendationDirectShopEvidenceMaterializationReportV8> {
    if (!attestation?.candidateAnalysis || typeof attestation.candidateAnalysis !== 'object') {
      throw new Error('DIRECT_SHOP_CANDIDATE_ANALYSIS_REQUIRED');
    }
    const calculatedCandidateAnalysisSha256 = sha256Canonical(attestation.candidateAnalysis);
    if (calculatedCandidateAnalysisSha256 !== attestation.candidateAnalysisSha256?.toLowerCase()) {
      throw new Error('DIRECT_SHOP_CANDIDATE_ANALYSIS_SHA256_MISMATCH');
    }
    const generatedAt = new Date().toISOString();
    const validation = evaluateRecommendationDirectShopSourceValidationV1(attestation, generatedAt);
    const gate = await this.persistGate(
      'directShopSourceValidation',
      validation.status,
      validation,
      validation.blockers,
      RECOMMENDATION_DIRECT_SHOP_SOURCE_VALIDATION_EVALUATOR_V1,
    );
    return { generatedAt, validation, gate };
  }

  async getSnapshot(subjectSha256: string): Promise<RecommendationEvidenceSnapshotV8> {
    if (!isSha256(subjectSha256)) throw new Error('subjectSha256 is invalid');
    const snapshot = await this.snapshotRepo.findOne({ where: { subjectSha256 } });
    if (!snapshot) throw new Error(`Recommendation evidence snapshot not found: ${subjectSha256}`);
    return snapshot;
  }

  private async persistGate(
    gateName: RecommendationRoadmapEvidenceGateNameV1,
    status: RecommendationRoadmapGateStateV1,
    report: unknown,
    blockers: readonly string[],
    evaluator = EVALUATOR,
  ): Promise<RecommendationMaterializedGateEvidenceV8> {
    if (status === 'NOT_EVALUATED') throw new Error('Materialized evidence cannot be NOT_EVALUATED');
    const evaluatedAt = reportEvaluatedAt(report);
    const subjectSha256 = sha256Canonical({ gateName, report });
    const evidenceRef = `/deadlock-live/recommendation-roadmap/v1/evidence-snapshots/${subjectSha256}`;
    const snapshotStatus = await this.persistSnapshot({
      subjectSha256,
      gateName,
      evaluator,
      evaluatedAt,
      report,
    });
    const record: RecommendationRoadmapEvidenceRecordV1 = {
      contractVersion: RECOMMENDATION_ROADMAP_EVIDENCE_VERSION,
      evidenceId: `v8:${gateName}:${subjectSha256}`,
      gateName,
      status,
      evidenceRef,
      evaluator,
      evaluatedAt,
      subjectSha256,
      notes: blockers.length > 0 ? `blockers=${[...new Set(blockers)].sort().join('|')}` : 'blockers=none',
    };
    const evidence = await this.roadmapEvidence.append(record);
    return {
      gateName,
      status,
      subjectSha256,
      snapshotStatus,
      evidenceStatus: evidence.status,
      evidenceRef,
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

function controlledSoulsStatus(
  report: Awaited<ReturnType<SoulsAffordabilityEvidenceV2Service['report']>>,
): RecommendationRoadmapGateStateV1 {
  if (report.invalidObservationIds.length > 0) return 'FAIL';
  return report.affordability.verdict;
}

function observabilityStatus(report: RecommendationObservabilityReport): RecommendationRoadmapGateStateV1 {
  if (!report.gate.evidenceSufficient) return 'INSUFFICIENT_EVIDENCE';
  return report.gate.passed ? 'PASS' : 'FAIL';
}

function datasetStructuralStatus(report: RecommendationDatasetV8Report): RecommendationRoadmapGateStateV1 {
  if (report.decisionCount === 0) return 'INSUFFICIENT_EVIDENCE';
  return report.passedStructuralGate ? 'PASS' : 'FAIL';
}

function datasetEmpiricalStatus(report: RecommendationDatasetV8Report): RecommendationRoadmapGateStateV1 {
  if (report.decisionCount < 10_000 || report.labeledDecisionCount === 0) return 'INSUFFICIENT_EVIDENCE';
  return report.passedEmpiricalGate ? 'PASS' : 'FAIL';
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

function validateRange(from: Date | undefined, to: Date | undefined): void {
  if (from && !Number.isFinite(from.getTime())) throw new Error('from is invalid');
  if (to && !Number.isFinite(to.getTime())) throw new Error('to is invalid');
  if (from && to && from >= to) throw new Error('from must be before to');
}

function normalizeCandidateGeneratorVersion(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (!normalized) throw new Error('candidateGeneratorVersion must be non-empty when provided');
  return normalized;
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

function isSha256(value: string): boolean {
  return /^[a-f0-9]{64}$/i.test(value);
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}
