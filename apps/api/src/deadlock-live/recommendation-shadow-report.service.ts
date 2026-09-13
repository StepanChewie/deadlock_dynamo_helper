import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  ShadowGateReportV1,
  ShadowMetricsV1,
  evaluateShadowGateV1,
} from '@deadlock-live-probe/shared';

export interface RecommendationShadowReportOptionsV1 {
  from?: Date;
  to?: Date;
}

export interface RecommendationShadowReportV1 {
  generatedAt: string;
  from?: string;
  to?: string;
  evidenceSufficient: boolean;
  evidenceBlockers: readonly string[];
  runtimeHealthEventCount: number;
  rejectionCount: number;
  acceptedTelemetryCount: number;
  metrics: ShadowMetricsV1;
  gate?: ShadowGateReportV1;
}

interface ShadowAggregateRow {
  matchCount: string | number;
  decisionCount: string | number;
  illegalDecisionCount: string | number;
  staleDecisionCount: string | number;
  fallbackDecisionCount: string | number;
  p99LatencyMs?: string | number;
}

interface HealthAggregateRow {
  healthEventCount: string | number;
  crashCount: string | number;
}

interface CountRow {
  count: string | number;
}

@Injectable()
export class RecommendationShadowReportService {
  constructor(private readonly dataSource: DataSource) {}

  async buildReport(
    options: RecommendationShadowReportOptionsV1 = {},
  ): Promise<RecommendationShadowReportV1> {
    validateRange(options.from, options.to);
    const params = [options.from?.toISOString() ?? null, options.to?.toISOString() ?? null];
    const [aggregateRows, healthRows, rejectionRows] = await Promise.all([
      this.dataSource.query(shadowAggregateSql(), params),
      this.dataSource.query(shadowHealthSql(), params),
      this.dataSource.query(shadowRejectionSql(), params),
    ]) as [ShadowAggregateRow[], HealthAggregateRow[], CountRow[]];

    const aggregate = aggregateRows[0] ?? emptyShadowAggregate();
    const health = healthRows[0] ?? { healthEventCount: 0, crashCount: 0 };
    const matchCount = number(aggregate.matchCount);
    const decisionCount = number(aggregate.decisionCount);
    const runtimeHealthEventCount = number(health.healthEventCount);
    const crashCount = number(health.crashCount);
    const rejectionCount = number(rejectionRows[0]?.count ?? 0);
    const acceptedTelemetryCount = decisionCount + runtimeHealthEventCount;
    const schemaErrorRate = ratio(rejectionCount, acceptedTelemetryCount + rejectionCount);

    const metrics: ShadowMetricsV1 = {
      matchCount,
      decisionCount,
      illegalRecommendationRate: ratio(number(aggregate.illegalDecisionCount), decisionCount),
      staleStateRate: ratio(number(aggregate.staleDecisionCount), decisionCount),
      fallbackRate: ratio(number(aggregate.fallbackDecisionCount), decisionCount),
      p99LatencyMs: number(aggregate.p99LatencyMs ?? 0),
      crashCount,
      schemaErrorRate,
    };

    const evidenceBlockers: string[] = [];
    if (decisionCount === 0) evidenceBlockers.push('NO_SHADOW_DECISIONS');
    if (runtimeHealthEventCount === 0) evidenceBlockers.push('NO_RUNTIME_HEALTH_EVIDENCE');
    const evidenceSufficient = evidenceBlockers.length === 0;

    return {
      generatedAt: new Date().toISOString(),
      from: options.from?.toISOString(),
      to: options.to?.toISOString(),
      evidenceSufficient,
      evidenceBlockers,
      runtimeHealthEventCount,
      rejectionCount,
      acceptedTelemetryCount,
      metrics,
      gate: evidenceSufficient ? evaluateShadowGateV1(metrics) : undefined,
    };
  }
}

function shadowAggregateSql(): string {
  return `
SELECT
  COUNT(DISTINCT d."matchId") AS "matchCount",
  COUNT(*) AS "decisionCount",
  COUNT(*) FILTER (
    WHERE c.id IS NULL
      OR c."feasible" IS NOT TRUE
      OR (
        c."actionType" <> 'WAIT_SAVE'
        AND (
          c."slotLegal" <> 'true'
          OR c."recipeLegal" <> 'true'
          OR c."shopLegal" <> 'true'
          OR c."rulesetLegal" <> 'true'
          OR c."transactionMechanicsKnown" IS NOT TRUE
          OR COALESCE(c."evidence"->>'shopOpportunity', 'UNKNOWN') = 'UNKNOWN'
          OR COALESCE(c."evidence"->>'inventory', 'UNKNOWN') = 'UNKNOWN'
          OR COALESCE(c."evidence"->>'ruleset', 'UNKNOWN') = 'UNKNOWN'
          OR COALESCE(c."evidence"->>'transaction', 'UNKNOWN') = 'UNKNOWN'
          OR (
            c."actionType" <> 'SELL_ITEM'
            AND (
              c."affordable" <> 'true'
              OR COALESCE(c."evidence"->>'spendableSouls', 'UNKNOWN') = 'UNKNOWN'
            )
          )
        )
      )
  ) AS "illegalDecisionCount",
  COUNT(*) FILTER (WHERE e."stale" IS TRUE) AS "staleDecisionCount",
  COUNT(*) FILTER (WHERE d."fallbackUsed" IS TRUE) AS "fallbackDecisionCount",
  COALESCE(percentile_cont(0.99) WITHIN GROUP (ORDER BY d."inferenceLatencyMs"), 0) AS "p99LatencyMs"
FROM recommendation_decisions_v8 d
JOIN recommendation_telemetry_events e ON e."eventId" = d."eventId"
LEFT JOIN recommendation_decision_candidates_v8 c
  ON c."decisionId" = d."decisionId"
 AND c."actionKey" = d."selectedActionKey"
WHERE d."runtimeMode" = 'SHADOW'
  AND ($1::timestamptz IS NULL OR d."decidedAt" >= $1::timestamptz)
  AND ($2::timestamptz IS NULL OR d."decidedAt" < $2::timestamptz);
`;
}

function shadowHealthSql(): string {
  return `
SELECT
  COUNT(*) AS "healthEventCount",
  COALESCE(SUM(CASE
    WHEN (e."payload"->>'crashCountDelta') ~ '^[0-9]+$'
    THEN (e."payload"->>'crashCountDelta')::int
    ELSE 0
  END), 0) AS "crashCount"
FROM recommendation_telemetry_events e
WHERE e."eventType" = 'RECOMMENDATION_RUNTIME_HEALTH'
  AND e."payload"->>'runtimeMode' = 'SHADOW'
  AND ($1::timestamptz IS NULL OR e."sourceOccurredAt" >= $1::timestamptz)
  AND ($2::timestamptz IS NULL OR e."sourceOccurredAt" < $2::timestamptz);
`;
}

function shadowRejectionSql(): string {
  return `
SELECT COUNT(*) AS count
FROM recommendation_telemetry_rejections_v8 r
WHERE (r."runtimeMode" = 'SHADOW' OR r."runtimeMode" IS NULL)
  AND (r."eventType" IN ('RECOMMENDATION_DECISION', 'RECOMMENDATION_RUNTIME_HEALTH') OR r."eventType" IS NULL)
  AND ($1::timestamptz IS NULL OR r."receivedAt" >= $1::timestamptz)
  AND ($2::timestamptz IS NULL OR r."receivedAt" < $2::timestamptz);
`;
}

function validateRange(from: Date | undefined, to: Date | undefined): void {
  if (from && !Number.isFinite(from.getTime())) throw new Error('from is invalid');
  if (to && !Number.isFinite(to.getTime())) throw new Error('to is invalid');
  if (from && to && from >= to) throw new Error('from must be before to');
}

function emptyShadowAggregate(): ShadowAggregateRow {
  return {
    matchCount: 0,
    decisionCount: 0,
    illegalDecisionCount: 0,
    staleDecisionCount: 0,
    fallbackDecisionCount: 0,
    p99LatencyMs: 0,
  };
}

function number(value: string | number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function ratio(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}
