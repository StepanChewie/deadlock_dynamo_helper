import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

export interface RecommendationDatasetV8ReportOptions {
  from?: Date;
  to?: Date;
  candidateGeneratorVersion?: string;
}

export interface RecommendationDatasetV8Report {
  generatedAt: string;
  from?: string;
  to?: string;
  candidateGeneratorVersion?: string;
  decisionCount: number;
  labeledDecisionCount: number;
  observedActionCandidateCoverage: number;
  observedActionFeasibleCoverage: number;
  minimumMajorActionPhaseCohortObservedActionFeasibleCoverage: number;
  majorActionPhaseCohortCount: number;
  observedActionInjectionRate: number;
  explicitFeasibilityCoverage: number;
  transactionMechanicsCoverage: number;
  rulesetEvidenceCoverage: number;
  inventoryEvidenceCoverage: number;
  averageCandidateCount: number;
  p95CandidateCount: number;
  passedStructuralGate: boolean;
  passedEmpiricalGate: boolean;
  blockers: readonly string[];
}

interface DatasetAggregateRow {
  decisionCount: string | number;
  labeledDecisionCount: string | number;
  observedActionCandidateCount: string | number;
  observedActionFeasibleCount: string | number;
  observedActionInjectedCount: string | number;
  candidateCount: string | number;
  explicitFeasibilityKnownCount: string | number;
  feasibleTransactionalCandidateCount: string | number;
  transactionMechanicsKnownCount: string | number;
  rulesetEvidenceKnownCount: string | number;
  inventoryEvidenceKnownCount: string | number;
  majorActionPhaseCohortCount: string | number;
  minimumMajorActionPhaseCohortObservedActionFeasibleCoverage?: string | number;
  averageCandidateCount?: string | number;
  p95CandidateCount?: string | number;
}

const MINIMUM_DECISIONS = 10_000;
const MINIMUM_OBSERVED_ACTION_FEASIBLE_COVERAGE = 0.99;
const MINIMUM_MAJOR_ACTION_PHASE_COHORT_COVERAGE = 0.98;
const MINIMUM_MAJOR_ACTION_PHASE_COHORT_DECISIONS = 100;
const MINIMUM_EXPLICIT_FEASIBILITY_COVERAGE = 0.995;
const MINIMUM_TRANSACTION_MECHANICS_COVERAGE = 0.99;
const MINIMUM_RULESET_EVIDENCE_COVERAGE = 0.999;
const MINIMUM_INVENTORY_EVIDENCE_COVERAGE = 0.999;

@Injectable()
export class RecommendationDatasetV8ReportService {
  constructor(private readonly dataSource: DataSource) {}

  async buildReport(
    options: RecommendationDatasetV8ReportOptions = {},
  ): Promise<RecommendationDatasetV8Report> {
    validateRange(options.from, options.to);
    const candidateGeneratorVersion = normalizeCandidateGeneratorVersion(options.candidateGeneratorVersion);
    const rows = await this.dataSource.query(
      datasetReportSql(),
      [
        options.from?.toISOString() ?? null,
        options.to?.toISOString() ?? null,
        candidateGeneratorVersion ?? null,
      ],
    ) as DatasetAggregateRow[];
    const row = rows[0] ?? emptyRow();
    const decisionCount = number(row.decisionCount);
    const labeledDecisionCount = number(row.labeledDecisionCount);
    const candidateCount = number(row.candidateCount);
    const feasibleTransactionalCandidateCount = number(row.feasibleTransactionalCandidateCount);
    const observedActionCandidateCoverage = ratio(number(row.observedActionCandidateCount), labeledDecisionCount);
    const observedActionFeasibleCoverage = ratio(number(row.observedActionFeasibleCount), labeledDecisionCount);
    const observedActionInjectionRate = ratio(number(row.observedActionInjectedCount), decisionCount);
    const explicitFeasibilityCoverage = ratio(number(row.explicitFeasibilityKnownCount), candidateCount);
    const transactionMechanicsCoverage = ratio(number(row.transactionMechanicsKnownCount), feasibleTransactionalCandidateCount);
    const rulesetEvidenceCoverage = ratio(number(row.rulesetEvidenceKnownCount), feasibleTransactionalCandidateCount);
    const inventoryEvidenceCoverage = ratio(number(row.inventoryEvidenceKnownCount), feasibleTransactionalCandidateCount);
    const majorActionPhaseCohortCount = number(row.majorActionPhaseCohortCount);
    const minimumMajorActionPhaseCohortObservedActionFeasibleCoverage = majorActionPhaseCohortCount > 0
      ? number(row.minimumMajorActionPhaseCohortObservedActionFeasibleCoverage ?? 0)
      : 0;

    const structuralBlockers: string[] = [];
    if (observedActionInjectionRate !== 0) structuralBlockers.push('OBSERVED_ACTION_INJECTION_DETECTED');
    if (decisionCount > 0 && number(row.p95CandidateCount ?? 0) <= 0) structuralBlockers.push('CANDIDATE_SET_EMPTY');
    const empiricalBlockers: string[] = [];
    if (decisionCount < MINIMUM_DECISIONS) empiricalBlockers.push('DECISION_COUNT_BELOW_10000');
    if (labeledDecisionCount === 0) empiricalBlockers.push('NO_OBSERVED_ACTION_LABELS');
    if (observedActionFeasibleCoverage < MINIMUM_OBSERVED_ACTION_FEASIBLE_COVERAGE) {
      empiricalBlockers.push('OBSERVED_ACTION_FEASIBLE_COVERAGE_BELOW_0_99');
    }
    if (majorActionPhaseCohortCount === 0) {
      empiricalBlockers.push('NO_MAJOR_ACTION_PHASE_COHORTS');
    } else if (
      minimumMajorActionPhaseCohortObservedActionFeasibleCoverage
      < MINIMUM_MAJOR_ACTION_PHASE_COHORT_COVERAGE
    ) {
      empiricalBlockers.push('MAJOR_ACTION_PHASE_COHORT_FEASIBLE_COVERAGE_BELOW_0_98');
    }
    if (explicitFeasibilityCoverage < MINIMUM_EXPLICIT_FEASIBILITY_COVERAGE) {
      empiricalBlockers.push('EXPLICIT_FEASIBILITY_COVERAGE_BELOW_0_995');
    }
    if (transactionMechanicsCoverage < MINIMUM_TRANSACTION_MECHANICS_COVERAGE) {
      empiricalBlockers.push('TRANSACTION_MECHANICS_COVERAGE_BELOW_0_99');
    }
    if (rulesetEvidenceCoverage < MINIMUM_RULESET_EVIDENCE_COVERAGE) {
      empiricalBlockers.push('RULESET_EVIDENCE_COVERAGE_BELOW_0_999');
    }
    if (inventoryEvidenceCoverage < MINIMUM_INVENTORY_EVIDENCE_COVERAGE) {
      empiricalBlockers.push('INVENTORY_EVIDENCE_COVERAGE_BELOW_0_999');
    }

    const blockers = [...new Set([...structuralBlockers, ...empiricalBlockers])].sort();
    return {
      generatedAt: new Date().toISOString(),
      from: options.from?.toISOString(),
      to: options.to?.toISOString(),
      candidateGeneratorVersion,
      decisionCount,
      labeledDecisionCount,
      observedActionCandidateCoverage,
      observedActionFeasibleCoverage,
      minimumMajorActionPhaseCohortObservedActionFeasibleCoverage,
      majorActionPhaseCohortCount,
      observedActionInjectionRate,
      explicitFeasibilityCoverage,
      transactionMechanicsCoverage,
      rulesetEvidenceCoverage,
      inventoryEvidenceCoverage,
      averageCandidateCount: number(row.averageCandidateCount ?? 0),
      p95CandidateCount: number(row.p95CandidateCount ?? 0),
      passedStructuralGate: structuralBlockers.length === 0,
      passedEmpiricalGate: structuralBlockers.length === 0 && empiricalBlockers.length === 0,
      blockers,
    };
  }
}

function datasetReportSql(): string {
  return `
WITH decisions AS (
  SELECT d.*
  FROM recommendation_decisions_v8 d
  WHERE ($1::timestamptz IS NULL OR d."decidedAt" >= $1::timestamptz)
    AND ($2::timestamptz IS NULL OR d."decidedAt" < $2::timestamptz)
    AND ($3::text IS NULL OR d."candidateGeneratorVersion" = $3::text)
), outcomes AS (
  SELECT DISTINCT ON (e."payload"->>'decisionId')
    e."payload"->>'decisionId' AS decision_id,
    NULLIF(e."payload"->>'observedActionKey', '') AS observed_action_key
  FROM recommendation_telemetry_events e
  WHERE e."eventType" = 'RECOMMENDATION_OUTCOME'
    AND COALESCE(e."payload"->>'decisionId', '') <> ''
    AND (
      $2::timestamptz IS NULL
      OR (e."sourceOccurredAt" < $2::timestamptz AND e."receivedAt" < $2::timestamptz)
    )
  ORDER BY e."payload"->>'decisionId', e."sourceOccurredAt" DESC, e."receivedAt" DESC
), candidate_counts AS (
  SELECT c."decisionId", COUNT(*) AS candidate_count
  FROM recommendation_decision_candidates_v8 c
  GROUP BY c."decisionId"
), candidate_quality AS (
  SELECT
    COUNT(*) AS candidate_count,
    COUNT(*) FILTER (
      WHERE c."actionType" = 'WAIT_SAVE'
         OR (
           c."affordable" <> 'UNKNOWN'
           AND c."slotLegal" <> 'UNKNOWN'
           AND c."recipeLegal" <> 'UNKNOWN'
           AND c."shopLegal" <> 'UNKNOWN'
           AND c."rulesetLegal" <> 'UNKNOWN'
           AND c."transactionMechanicsKnown" IS TRUE
         )
    ) AS explicit_feasibility_known_count,
    COUNT(*) FILTER (WHERE c."feasible" IS TRUE AND c."actionType" <> 'WAIT_SAVE') AS feasible_transactional_candidate_count,
    COUNT(*) FILTER (
      WHERE c."feasible" IS TRUE
        AND c."actionType" <> 'WAIT_SAVE'
        AND c."transactionMechanicsKnown" IS TRUE
        AND COALESCE(c."evidence"->>'transaction', 'UNKNOWN') <> 'UNKNOWN'
    ) AS transaction_mechanics_known_count,
    COUNT(*) FILTER (
      WHERE c."feasible" IS TRUE
        AND c."actionType" <> 'WAIT_SAVE'
        AND COALESCE(c."evidence"->>'ruleset', 'UNKNOWN') <> 'UNKNOWN'
    ) AS ruleset_evidence_known_count,
    COUNT(*) FILTER (
      WHERE c."feasible" IS TRUE
        AND c."actionType" <> 'WAIT_SAVE'
        AND COALESCE(c."evidence"->>'inventory', 'UNKNOWN') <> 'UNKNOWN'
    ) AS inventory_evidence_known_count
  FROM recommendation_decision_candidates_v8 c
  JOIN decisions d ON d."decisionId" = c."decisionId"
), labeled AS (
  SELECT
    d."decisionId",
    o.observed_action_key,
    observed_candidate.id AS observed_candidate_id,
    observed_candidate."feasible" AS observed_feasible,
    COALESCE(observed_candidate."actionType", 'UNKNOWN') AS action_type,
    CASE
      WHEN COALESCE(d."gameTimeMs", 0) < 600000 THEN 'EARLY'
      WHEN COALESCE(d."gameTimeMs", 0) < 1200000 THEN 'MID'
      ELSE 'LATE'
    END AS phase
  FROM decisions d
  LEFT JOIN outcomes o ON o.decision_id = d."decisionId"
  LEFT JOIN recommendation_decision_candidates_v8 observed_candidate
    ON observed_candidate."decisionId" = d."decisionId"
   AND observed_candidate."actionKey" = o.observed_action_key
), action_phase_cohorts AS (
  SELECT
    action_type || '|phase:' || phase AS cohort_key,
    COUNT(*) AS labeled_count,
    COUNT(*) FILTER (WHERE observed_feasible IS TRUE) AS feasible_count
  FROM labeled
  WHERE observed_action_key IS NOT NULL
  GROUP BY action_type, phase
), major_action_phase_cohorts AS (
  SELECT
    cohort_key,
    labeled_count,
    feasible_count,
    feasible_count::double precision / NULLIF(labeled_count, 0) AS feasible_coverage
  FROM action_phase_cohorts
  WHERE labeled_count >= ${MINIMUM_MAJOR_ACTION_PHASE_COHORT_DECISIONS}
)
SELECT
  COUNT(*) AS "decisionCount",
  COUNT(*) FILTER (WHERE l.observed_action_key IS NOT NULL) AS "labeledDecisionCount",
  COUNT(*) FILTER (
    WHERE l.observed_action_key IS NOT NULL
      AND l.observed_candidate_id IS NOT NULL
  ) AS "observedActionCandidateCount",
  COUNT(*) FILTER (
    WHERE l.observed_action_key IS NOT NULL
      AND l.observed_feasible IS TRUE
  ) AS "observedActionFeasibleCount",
  COUNT(*) FILTER (WHERE d."observedActionInjected" IS TRUE) AS "observedActionInjectedCount",
  COALESCE((SELECT candidate_count FROM candidate_quality), 0) AS "candidateCount",
  COALESCE((SELECT explicit_feasibility_known_count FROM candidate_quality), 0) AS "explicitFeasibilityKnownCount",
  COALESCE((SELECT feasible_transactional_candidate_count FROM candidate_quality), 0) AS "feasibleTransactionalCandidateCount",
  COALESCE((SELECT transaction_mechanics_known_count FROM candidate_quality), 0) AS "transactionMechanicsKnownCount",
  COALESCE((SELECT ruleset_evidence_known_count FROM candidate_quality), 0) AS "rulesetEvidenceKnownCount",
  COALESCE((SELECT inventory_evidence_known_count FROM candidate_quality), 0) AS "inventoryEvidenceKnownCount",
  COALESCE((SELECT COUNT(*) FROM major_action_phase_cohorts), 0) AS "majorActionPhaseCohortCount",
  COALESCE((SELECT MIN(feasible_coverage) FROM major_action_phase_cohorts), 0) AS "minimumMajorActionPhaseCohortObservedActionFeasibleCoverage",
  COALESCE(AVG(cc.candidate_count), 0) AS "averageCandidateCount",
  COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY cc.candidate_count), 0) AS "p95CandidateCount"
FROM decisions d
LEFT JOIN labeled l ON l."decisionId" = d."decisionId"
LEFT JOIN candidate_counts cc ON cc."decisionId" = d."decisionId";
`;
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

function emptyRow(): DatasetAggregateRow {
  return {
    decisionCount: 0,
    labeledDecisionCount: 0,
    observedActionCandidateCount: 0,
    observedActionFeasibleCount: 0,
    observedActionInjectedCount: 0,
    candidateCount: 0,
    explicitFeasibilityKnownCount: 0,
    feasibleTransactionalCandidateCount: 0,
    transactionMechanicsKnownCount: 0,
    rulesetEvidenceKnownCount: 0,
    inventoryEvidenceKnownCount: 0,
    majorActionPhaseCohortCount: 0,
    minimumMajorActionPhaseCohortObservedActionFeasibleCoverage: 0,
    averageCandidateCount: 0,
    p95CandidateCount: 0,
  };
}

function number(value: string | number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function ratio(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}
