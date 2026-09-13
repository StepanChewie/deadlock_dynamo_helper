import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { evaluatePolicyAbGateV1 } from '@deadlock-live-probe/shared';
import { RecommendationOpeRewardV1 } from './recommendation-ope-report.service';

type PolicyAbMetricsV1 = Parameters<typeof evaluatePolicyAbGateV1>[0];
type PolicyAbGateReportV1 = ReturnType<typeof evaluatePolicyAbGateV1>;

export interface RecommendationAbReportOptionsV1 {
  experimentId: string;
  controlArm: string;
  treatmentArm: string;
  reward: RecommendationOpeRewardV1;
  from?: Date;
  to?: Date;
}

export interface RecommendationAbReportV1 {
  generatedAt: string;
  experimentId: string;
  controlArm: string;
  treatmentArm: string;
  reward: RecommendationOpeRewardV1;
  matchCount: number;
  decisionCount: number;
  controlMatchCount: number;
  treatmentMatchCount: number;
  runtimeHealthCoverage: number;
  abandonmentCoverage: number;
  evidenceSufficient: boolean;
  blockers: readonly string[];
  metrics?: PolicyAbMetricsV1;
  gate?: PolicyAbGateReportV1;
}

interface IntegrityRow {
  matchCount: string | number;
  decisionCount: string | number;
  validMatchAssignmentCount: string | number;
  exactActionPropensityCount: string | number;
  illegalDecisionCount: string | number;
  exposureAckCount: string | number;
}

interface MatchOutcomeRow {
  matchId: string;
  arm: string;
  reward?: string | number;
  abandoned?: boolean | string;
  healthEventCount: string | number;
  crashCount: string | number;
}

interface CountRow {
  count: string | number;
}

@Injectable()
export class RecommendationAbReportService {
  constructor(private readonly dataSource: DataSource) {}

  async buildReport(options: RecommendationAbReportOptionsV1): Promise<RecommendationAbReportV1> {
    validateOptions(options);
    const rewardExpression = rewardSqlExpression(options.reward);
    const params = [
      options.experimentId,
      options.controlArm,
      options.treatmentArm,
      options.from?.toISOString() ?? null,
      options.to?.toISOString() ?? null,
    ];
    const [integrityRows, matchRows, rejectionRows] = await Promise.all([
      this.dataSource.query(integritySql(), params),
      this.dataSource.query(matchOutcomeSql(rewardExpression), params),
      this.dataSource.query(rejectionSql(), [options.from?.toISOString() ?? null, options.to?.toISOString() ?? null]),
    ]) as [IntegrityRow[], MatchOutcomeRow[], CountRow[]];

    const integrity = integrityRows[0] ?? emptyIntegrity();
    const matchCount = number(integrity.matchCount);
    const decisionCount = number(integrity.decisionCount);
    const controlRows = matchRows.filter((row) => row.arm === options.controlArm);
    const treatmentRows = matchRows.filter((row) => row.arm === options.treatmentArm);
    const controlRewards = controlRows.map((row) => numberOrUndefined(row.reward)).filter(isNumber);
    const treatmentRewards = treatmentRows.map((row) => numberOrUndefined(row.reward)).filter(isNumber);
    const healthCoveredMatches = matchRows.filter((row) => number(row.healthEventCount) > 0).length;
    const abandonmentKnownMatches = matchRows.filter((row) => booleanOrUndefined(row.abandoned) !== undefined).length;
    const runtimeHealthCoverage = ratio(healthCoveredMatches, matchCount);
    const abandonmentCoverage = ratio(abandonmentKnownMatches, matchCount);
    const rejectionCount = number(rejectionRows[0]?.count ?? 0);
    const acceptedRelevantTelemetry = decisionCount + number(integrity.exposureAckCount);
    const telemetrySchemaErrorRate = ratio(rejectionCount, acceptedRelevantTelemetry + rejectionCount);

    const blockers: string[] = [];
    if (matchCount === 0) blockers.push('NO_EXPERIMENT_MATCHES');
    if (controlRows.length === 0) blockers.push('NO_CONTROL_MATCHES');
    if (treatmentRows.length === 0) blockers.push('NO_TREATMENT_MATCHES');
    if (controlRewards.length !== controlRows.length || treatmentRewards.length !== treatmentRows.length) {
      blockers.push('PRIMARY_OUTCOME_COVERAGE_INCOMPLETE');
    }
    if (runtimeHealthCoverage < 1) blockers.push('RUNTIME_HEALTH_COVERAGE_INCOMPLETE');
    if (abandonmentCoverage < 1) blockers.push('ABANDONMENT_COVERAGE_INCOMPLETE');
    if (controlRewards.length < 2 || treatmentRewards.length < 2) blockers.push('INSUFFICIENT_MATCHES_FOR_CONFIDENCE_INTERVAL');

    const evidenceSufficient = blockers.length === 0;
    if (!evidenceSufficient) {
      return {
        generatedAt: new Date().toISOString(),
        experimentId: options.experimentId,
        controlArm: options.controlArm,
        treatmentArm: options.treatmentArm,
        reward: options.reward,
        matchCount,
        decisionCount,
        controlMatchCount: controlRows.length,
        treatmentMatchCount: treatmentRows.length,
        runtimeHealthCoverage,
        abandonmentCoverage,
        evidenceSufficient,
        blockers: blockers.sort(),
      };
    }

    const outcome = differenceInMeans(treatmentRewards, controlRewards);
    const controlCrashRate = mean(controlRows.map((row) => number(row.crashCount)));
    const treatmentCrashRate = mean(treatmentRows.map((row) => number(row.crashCount)));
    const controlAbandonmentRate = mean(controlRows.map((row) => booleanOrUndefined(row.abandoned) ? 1 : 0));
    const treatmentAbandonmentRate = mean(treatmentRows.map((row) => booleanOrUndefined(row.abandoned) ? 1 : 0));
    const metrics: PolicyAbMetricsV1 = {
      matchCount,
      decisionCount,
      assignmentAtMatchLevelRate: ratio(number(integrity.validMatchAssignmentCount), matchCount),
      exactLoggedPropensityRate: ratio(number(integrity.exactActionPropensityCount), decisionCount),
      illegalRecommendationRate: ratio(number(integrity.illegalDecisionCount), decisionCount),
      exposureAckCoverage: ratio(number(integrity.exposureAckCount), decisionCount),
      telemetrySchemaErrorRate,
      primaryOutcomeDelta: outcome.delta,
      primaryOutcomeCiLow: outcome.ciLow,
      primaryOutcomeCiHigh: outcome.ciHigh,
      crashRateDelta: treatmentCrashRate - controlCrashRate,
      abandonmentRateDelta: treatmentAbandonmentRate - controlAbandonmentRate,
    };
    return {
      generatedAt: new Date().toISOString(),
      experimentId: options.experimentId,
      controlArm: options.controlArm,
      treatmentArm: options.treatmentArm,
      reward: options.reward,
      matchCount,
      decisionCount,
      controlMatchCount: controlRows.length,
      treatmentMatchCount: treatmentRows.length,
      runtimeHealthCoverage,
      abandonmentCoverage,
      evidenceSufficient: true,
      blockers: [],
      metrics,
      gate: evaluatePolicyAbGateV1(metrics),
    };
  }
}

function integritySql(): string {
  return `
WITH decisions AS (
  SELECT d.*
  FROM recommendation_decisions_v8 d
  WHERE d."experimentId" = $1
    AND d."experimentArm" IN ($2, $3)
    AND ($4::timestamptz IS NULL OR d."decidedAt" >= $4::timestamptz)
    AND ($5::timestamptz IS NULL OR d."decidedAt" < $5::timestamptz)
), match_integrity AS (
  SELECT
    d."matchId",
    COUNT(DISTINCT d."experimentArm") AS arm_count,
    COUNT(DISTINCT d."assignmentVersion") AS assignment_version_count,
    COUNT(DISTINCT d."experimentId") AS experiment_count
  FROM decisions d
  GROUP BY d."matchId"
)
SELECT
  (SELECT COUNT(*) FROM match_integrity) AS "matchCount",
  COUNT(*) AS "decisionCount",
  (SELECT COUNT(*) FROM match_integrity
   WHERE arm_count = 1 AND assignment_version_count = 1 AND experiment_count = 1) AS "validMatchAssignmentCount",
  COUNT(*) FILTER (
    WHERE d."actionLoggingPropensity" > 0 AND d."actionLoggingPropensity" <= 1
  ) AS "exactActionPropensityCount",
  COUNT(*) FILTER (
    WHERE selected.id IS NULL
      OR selected."feasible" IS NOT TRUE
      OR (
        selected."actionType" <> 'WAIT_SAVE'
        AND (
          selected."slotLegal" <> 'true'
          OR selected."recipeLegal" <> 'true'
          OR selected."shopLegal" <> 'true'
          OR selected."rulesetLegal" <> 'true'
          OR selected."transactionMechanicsKnown" IS NOT TRUE
          OR (selected."actionType" <> 'SELL_ITEM' AND selected."affordable" <> 'true')
        )
      )
  ) AS "illegalDecisionCount",
  COUNT(*) FILTER (WHERE ack."decisionId" IS NOT NULL) AS "exposureAckCount"
FROM decisions d
LEFT JOIN recommendation_decision_candidates_v8 selected
  ON selected."decisionId" = d."decisionId"
 AND selected."actionKey" = d."selectedActionKey"
LEFT JOIN recommendation_exposure_acks_v8 ack
  ON ack."decisionId" = d."decisionId";
`;
}

function matchOutcomeSql(rewardExpression: string): string {
  return `
WITH decisions AS (
  SELECT d.*
  FROM recommendation_decisions_v8 d
  WHERE d."experimentId" = $1
    AND d."experimentArm" IN ($2, $3)
    AND ($4::timestamptz IS NULL OR d."decidedAt" >= $4::timestamptz)
    AND ($5::timestamptz IS NULL OR d."decidedAt" < $5::timestamptz)
), assignments AS (
  SELECT d."matchId", MIN(d."experimentArm") AS arm
  FROM decisions d
  GROUP BY d."matchId"
  HAVING COUNT(DISTINCT d."experimentArm") = 1
), outcomes AS (
  SELECT DISTINCT ON (e."payload"->>'decisionId')
    e."payload"->>'decisionId' AS decision_id,
    e."payload" AS payload
  FROM recommendation_telemetry_events e
  WHERE e."eventType" = 'RECOMMENDATION_OUTCOME'
    AND COALESCE(e."payload"->>'decisionId', '') <> ''
  ORDER BY e."payload"->>'decisionId', e."sourceOccurredAt" DESC, e."receivedAt" DESC
), per_match_outcome AS (
  SELECT
    d."matchId",
    AVG(${rewardExpression}) FILTER (WHERE (${rewardExpression}) IS NOT NULL) AS reward,
    CASE
      WHEN COUNT(*) FILTER (WHERE o.payload ? 'sessionAbandoned') = COUNT(*) FILTER (WHERE o.payload IS NOT NULL)
        AND COUNT(*) FILTER (WHERE o.payload IS NOT NULL) > 0
      THEN BOOL_OR(COALESCE((o.payload->>'sessionAbandoned')::boolean, FALSE))
    END AS abandoned
  FROM decisions d
  LEFT JOIN outcomes o ON o.decision_id = d."decisionId"
  GROUP BY d."matchId"
), health AS (
  SELECT
    e."matchId",
    COUNT(*) AS health_event_count,
    SUM(CASE
      WHEN (e."payload"->>'crashCountDelta') ~ '^[0-9]+$'
      THEN (e."payload"->>'crashCountDelta')::int
      ELSE 0
    END) AS crash_count
  FROM recommendation_telemetry_events e
  WHERE e."eventType" = 'RECOMMENDATION_RUNTIME_HEALTH'
    AND ($4::timestamptz IS NULL OR e."sourceOccurredAt" >= $4::timestamptz)
    AND ($5::timestamptz IS NULL OR e."sourceOccurredAt" < $5::timestamptz)
  GROUP BY e."matchId"
)
SELECT
  a."matchId" AS "matchId",
  a.arm AS arm,
  p.reward AS reward,
  p.abandoned AS abandoned,
  COALESCE(h.health_event_count, 0) AS "healthEventCount",
  COALESCE(h.crash_count, 0) AS "crashCount"
FROM assignments a
LEFT JOIN per_match_outcome p ON p."matchId" = a."matchId"
LEFT JOIN health h ON h."matchId" = a."matchId"
ORDER BY a."matchId";
`;
}

function rejectionSql(): string {
  return `
SELECT COUNT(*) AS count
FROM recommendation_telemetry_rejections_v8 r
WHERE (r."eventType" IN ('RECOMMENDATION_DECISION', 'RECOMMENDATION_EXPOSURE_ACK', 'RECOMMENDATION_OUTCOME') OR r."eventType" IS NULL)
  AND ($1::timestamptz IS NULL OR r."receivedAt" >= $1::timestamptz)
  AND ($2::timestamptz IS NULL OR r."receivedAt" < $2::timestamptz);
`;
}

function rewardSqlExpression(reward: RecommendationOpeRewardV1): string {
  switch (reward) {
    case 'economyDelta120s':
      return `CASE WHEN (o.payload->>'economyDelta120s') ~ '^-?[0-9]+(?:\\.[0-9]+)?$' THEN (o.payload->>'economyDelta120s')::double precision END`;
    case 'economyDelta300s':
      return `CASE WHEN (o.payload->>'economyDelta300s') ~ '^-?[0-9]+(?:\\.[0-9]+)?$' THEN (o.payload->>'economyDelta300s')::double precision END`;
    case 'objectiveDelta300s':
      return `CASE WHEN (o.payload->>'objectiveDelta300s') ~ '^-?[0-9]+(?:\\.[0-9]+)?$' THEN (o.payload->>'objectiveDelta300s')::double precision END`;
    case 'finalPlayerWon':
      return `CASE WHEN o.payload->>'finalPlayerWon' = 'true' THEN 1.0 WHEN o.payload->>'finalPlayerWon' = 'false' THEN 0.0 END`;
  }
}

function differenceInMeans(treatment: readonly number[], control: readonly number[]): {
  delta: number;
  ciLow: number;
  ciHigh: number;
} {
  const treatmentMean = mean(treatment);
  const controlMean = mean(control);
  const delta = treatmentMean - controlMean;
  const standardError = Math.sqrt(
    sampleVariance(treatment) / treatment.length
    + sampleVariance(control) / control.length,
  );
  const halfWidth = 1.96 * standardError;
  return { delta, ciLow: delta - halfWidth, ciHigh: delta + halfWidth };
}

function sampleVariance(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const avg = mean(values);
  return values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / (values.length - 1);
}

function validateOptions(options: RecommendationAbReportOptionsV1): void {
  if (!options.experimentId) throw new Error('experimentId is required');
  if (!options.controlArm) throw new Error('controlArm is required');
  if (!options.treatmentArm) throw new Error('treatmentArm is required');
  if (options.controlArm === options.treatmentArm) throw new Error('controlArm and treatmentArm must differ');
  if (options.from && !Number.isFinite(options.from.getTime())) throw new Error('from is invalid');
  if (options.to && !Number.isFinite(options.to.getTime())) throw new Error('to is invalid');
  if (options.from && options.to && options.from >= options.to) throw new Error('from must be before to');
}

function emptyIntegrity(): IntegrityRow {
  return {
    matchCount: 0,
    decisionCount: 0,
    validMatchAssignmentCount: 0,
    exactActionPropensityCount: 0,
    illegalDecisionCount: 0,
    exposureAckCount: 0,
  };
}

function number(value: string | number): number {
  return numberOrUndefined(value) ?? 0;
}

function numberOrUndefined(value: string | number | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function booleanOrUndefined(value: boolean | string | undefined): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

function isNumber(value: number | undefined): value is number {
  return value !== undefined;
}

function ratio(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

function mean(values: readonly number[]): number {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}
