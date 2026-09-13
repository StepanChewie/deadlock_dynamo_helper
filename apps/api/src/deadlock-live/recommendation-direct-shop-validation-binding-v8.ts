import { createHash } from 'crypto';
import {
  RECOMMENDATION_DIRECT_SHOP_SOURCE_VALIDATION_EVALUATOR_V1,
  RECOMMENDATION_DIRECT_SHOP_SOURCE_VALIDATION_V1,
  RecommendationDirectShopSourceValidationReportV1,
  evaluateRecommendationDirectShopSourceValidationV1,
} from '@deadlock-live-probe/shared';
import { RecommendationEvidenceMaterializerV8Service } from './recommendation-evidence-materializer-v8.service';
import { RecommendationRoadmapEvidenceService } from './recommendation-roadmap-evidence.service';

export interface RecommendationDirectShopValidationBindingV8 {
  valid: boolean;
  approvalKey?: string;
  subjectSha256?: string;
  report?: RecommendationDirectShopSourceValidationReportV1;
  blockers: readonly string[];
}

export async function loadRecommendationDirectShopValidationBindingV8(
  roadmap: Awaited<ReturnType<RecommendationRoadmapEvidenceService['report']>>,
  materializer: Pick<RecommendationEvidenceMaterializerV8Service, 'getSnapshot'>,
): Promise<RecommendationDirectShopValidationBindingV8> {
  const blockers: string[] = [];
  if (roadmap.evidence.directShopSourceValidation !== 'PASS') {
    blockers.push(`DIRECT_SHOP_SOURCE_VALIDATION_${roadmap.evidence.directShopSourceValidation}`);
    return { valid: false, blockers };
  }

  const evidence = roadmap.latestEvidenceByGate.directShopSourceValidation;
  if (!evidence?.subjectSha256) {
    return { valid: false, blockers: ['DIRECT_SHOP_SOURCE_VALIDATION_SNAPSHOT_MISSING'] };
  }
  if (evidence.evaluator !== RECOMMENDATION_DIRECT_SHOP_SOURCE_VALIDATION_EVALUATOR_V1) {
    return { valid: false, blockers: ['DIRECT_SHOP_SOURCE_VALIDATION_EVIDENCE_EVALUATOR_MISMATCH'] };
  }

  let snapshot: Awaited<ReturnType<RecommendationEvidenceMaterializerV8Service['getSnapshot']>>;
  try {
    snapshot = await materializer.getSnapshot(evidence.subjectSha256);
  } catch {
    return { valid: false, blockers: ['DIRECT_SHOP_SOURCE_VALIDATION_SNAPSHOT_MISSING'] };
  }

  if (snapshot.subjectSha256 !== evidence.subjectSha256) blockers.push('DIRECT_SHOP_SOURCE_VALIDATION_SNAPSHOT_SHA_MISMATCH');
  if (snapshot.gateName !== 'directShopSourceValidation') blockers.push('DIRECT_SHOP_SOURCE_VALIDATION_SNAPSHOT_GATE_MISMATCH');
  if (snapshot.evaluator !== RECOMMENDATION_DIRECT_SHOP_SOURCE_VALIDATION_EVALUATOR_V1) {
    blockers.push('DIRECT_SHOP_SOURCE_VALIDATION_SNAPSHOT_EVALUATOR_MISMATCH');
  }
  if (snapshot.evaluator !== evidence.evaluator) blockers.push('DIRECT_SHOP_SOURCE_VALIDATION_SNAPSHOT_IDENTITY_MISMATCH');

  const report = parseReport(snapshot.report, blockers);
  if (!report) return { valid: false, subjectSha256: evidence.subjectSha256, blockers: uniqueSorted(blockers) };

  const calculatedSubjectSha256 = sha256Canonical({ gateName: 'directShopSourceValidation', report });
  if (calculatedSubjectSha256 !== evidence.subjectSha256.toLowerCase()) {
    blockers.push('DIRECT_SHOP_SOURCE_VALIDATION_SNAPSHOT_CONTENT_SHA_MISMATCH');
  }
  const evaluatedAt = snapshot.evaluatedAt instanceof Date
    ? snapshot.evaluatedAt
    : new Date(snapshot.evaluatedAt as unknown as string);
  if (!Number.isFinite(evaluatedAt.getTime()) || evaluatedAt.toISOString() !== new Date(report.generatedAt).toISOString()) {
    blockers.push('DIRECT_SHOP_SOURCE_VALIDATION_SNAPSHOT_TIMESTAMP_MISMATCH');
  }

  if (report.contractVersion !== RECOMMENDATION_DIRECT_SHOP_SOURCE_VALIDATION_V1) {
    blockers.push('DIRECT_SHOP_SOURCE_VALIDATION_CONTRACT_MISMATCH');
  }
  if (report.status !== 'PASS' || !report.canActivateDirectShopSource) {
    blockers.push(`DIRECT_SHOP_SOURCE_VALIDATION_REPORT_${report.status}`);
  }
  if (report.blockers.length > 0) blockers.push('DIRECT_SHOP_SOURCE_VALIDATION_PASS_HAS_BLOCKERS');
  if (!report.approvalKey?.trim()) blockers.push('DIRECT_SHOP_SOURCE_VALIDATION_APPROVAL_KEY_MISSING');

  const attestation = report.attestation;
  if (!attestation?.candidateAnalysis || typeof attestation.candidateAnalysis !== 'object') {
    blockers.push('DIRECT_SHOP_SOURCE_VALIDATION_CANDIDATE_ANALYSIS_MISSING');
  } else {
    const calculated = sha256Canonical(attestation.candidateAnalysis);
    if (calculated !== attestation.candidateAnalysisSha256?.toLowerCase()) {
      blockers.push('DIRECT_SHOP_SOURCE_VALIDATION_CANDIDATE_ANALYSIS_SHA_MISMATCH');
    }
  }

  try {
    const reevaluated = evaluateRecommendationDirectShopSourceValidationV1(attestation, report.generatedAt);
    if (
      reevaluated.status !== 'PASS'
      || !reevaluated.canActivateDirectShopSource
      || reevaluated.approvalKey !== report.approvalKey
      || canonicalJson(reevaluated.blockers) !== canonicalJson(report.blockers)
    ) {
      blockers.push('DIRECT_SHOP_SOURCE_VALIDATION_REEVALUATION_MISMATCH');
    }
  } catch {
    blockers.push('DIRECT_SHOP_SOURCE_VALIDATION_REEVALUATION_FAILED');
  }

  const finalBlockers = uniqueSorted(blockers);
  return {
    valid: finalBlockers.length === 0,
    approvalKey: finalBlockers.length === 0 ? report.approvalKey : undefined,
    subjectSha256: evidence.subjectSha256,
    report,
    blockers: finalBlockers,
  };
}

function parseReport(
  value: unknown,
  blockers: string[],
): RecommendationDirectShopSourceValidationReportV1 | undefined {
  if (typeof value !== 'object' || value === null) {
    blockers.push('DIRECT_SHOP_SOURCE_VALIDATION_SNAPSHOT_INVALID');
    return undefined;
  }
  const report = value as Partial<RecommendationDirectShopSourceValidationReportV1>;
  if (
    typeof report.generatedAt !== 'string'
    || !Number.isFinite(Date.parse(report.generatedAt))
    || typeof report.approvalKey !== 'string'
    || !Array.isArray(report.blockers)
    || typeof report.canActivateDirectShopSource !== 'boolean'
    || typeof report.attestation !== 'object'
    || report.attestation === null
    || !['PASS', 'FAIL', 'INSUFFICIENT_EVIDENCE'].includes(String(report.status))
  ) {
    blockers.push('DIRECT_SHOP_SOURCE_VALIDATION_SNAPSHOT_INVALID');
    return undefined;
  }
  return report as RecommendationDirectShopSourceValidationReportV1;
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

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}
