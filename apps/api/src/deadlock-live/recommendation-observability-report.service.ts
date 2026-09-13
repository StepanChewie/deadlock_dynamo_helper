import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  RecommendationObservabilityCohortMetricsV1,
  RecommendationObservabilityGateReportV1,
  RecommendationObservabilityMetricsV1,
  evaluateRecommendationObservabilityGateV1,
} from '@deadlock-live-probe/shared';
import { configuredDirectShopSourceAllowlist } from './recommendation-direct-shop-source-v8';

export interface RecommendationObservabilityReportOptions {
  from?: Date;
  to?: Date;
  maximumAlignmentAgeMs?: number;
  candidateGeneratorVersion?: string;
}

export interface RecommendationObservabilityReport {
  generatedAt: string;
  from?: string;
  to?: string;
  maximumAlignmentAgeMs: number;
  candidateGeneratorVersion?: string;
  approvedDirectShopSourceKeys: readonly string[];
  metrics: RecommendationObservabilityMetricsV1;
  cohorts: readonly RecommendationObservabilityCohortMetricsV1[];
  gate: RecommendationObservabilityGateReportV1;
}

interface ObservabilityAggregateRow {
  cohortKey: string;
  decisionCount: string | number;
  exactSpendableSoulsCount: string | number;
  shopOpportunityCount: string | number;
  inventorySnapshotCount: string | number;
  rulesetCatalogCount: string | number;
  transactionMechanicsCount: string | number;
  playerIdentityCount: string | number;
  nonFutureTimestampCount: string | number;
  directlyObservedStateCount: string | number;
  staleStateCount: string | number;
}

@Injectable()
export class RecommendationObservabilityReportService {
  constructor(private readonly dataSource: DataSource) {}

  async buildReport(
    options: RecommendationObservabilityReportOptions = {},
  ): Promise<RecommendationObservabilityReport> {
    const maximumAlignmentAgeMs = options.maximumAlignmentAgeMs ?? 5_000;
    if (!Number.isInteger(maximumAlignmentAgeMs) || maximumAlignmentAgeMs < 0) {
      throw new Error('maximumAlignmentAgeMs must be a non-negative integer');
    }
    const candidateGeneratorVersion = normalizeCandidateGeneratorVersion(options.candidateGeneratorVersion);
    const approvedDirectShopSourceKeys = configuredDirectShopSourceAllowlist();
    const rows = await this.dataSource.query(
      observabilitySql(),
      [
        options.from?.toISOString() ?? null,
        options.to?.toISOString() ?? null,
        maximumAlignmentAgeMs,
        approvedDirectShopSourceKeys,
        candidateGeneratorVersion ?? null,
      ],
    ) as ObservabilityAggregateRow[];
    const overallRow = rows.find((row) => row.cohortKey === 'overall');
    const metrics = overallRow ? toMetrics(overallRow) : emptyMetrics();
    const cohorts = rows
      .filter((row) => row.cohortKey !== 'overall')
      .map((row) => ({ cohortKey: row.cohortKey, ...toMetrics(row) }))
      .sort((a, b) => a.cohortKey.localeCompare(b.cohortKey));
    const gate = evaluateRecommendationObservabilityGateV1(metrics, cohorts);
    return {
      generatedAt: new Date().toISOString(),
      from: options.from?.toISOString(),
      to: options.to?.toISOString(),
      maximumAlignmentAgeMs,
      candidateGeneratorVersion,
      approvedDirectShopSourceKeys,
      metrics,
      cohorts,
      gate,
    };
  }
}

function observabilitySql(): string {
  return `
WITH decisions AS (
  SELECT
    d."decisionId",
    d."matchId",
    d."playerKey",
    d."decidedAt",
    d."gameTimeMs",
    d."rulesetVersion",
    d."catalogSha256",
    e."sourceOccurredAt" AS decision_source_at,
    e."directlyObserved" AS decision_directly_observed,
    e."stale" AS decision_stale
  FROM recommendation_decisions_v8 d
  JOIN recommendation_telemetry_events e ON e."eventId" = d."eventId"
  WHERE ($1::timestamptz IS NULL OR d."decidedAt" >= $1::timestamptz)
    AND ($2::timestamptz IS NULL OR d."decidedAt" < $2::timestamptz)
    AND ($5::text IS NULL OR d."candidateGeneratorVersion" = $5::text)
), aligned AS (
  SELECT
    d.*,
    ps."payload" AS player_payload,
    ps."source" AS player_source,
    ps."sourceOccurredAt" AS player_source_at,
    ps."receivedAt" AS player_received_at,
    ps."directlyObserved" AS player_directly_observed,
    ps."stale" AS player_stale,
    inv."payload" AS inventory_payload,
    inv."sourceOccurredAt" AS inventory_source_at,
    inv."receivedAt" AS inventory_received_at,
    inv."directlyObserved" AS inventory_directly_observed,
    inv."stale" AS inventory_stale,
    CASE
      WHEN COALESCE(d."gameTimeMs", 0) < 600000 THEN 'phase:early'
      WHEN COALESCE(d."gameTimeMs", 0) < 1200000 THEN 'phase:mid'
      ELSE 'phase:late'
    END AS phase_cohort
  FROM decisions d
  LEFT JOIN LATERAL (
    SELECT e.*
    FROM recommendation_telemetry_events e
    WHERE e."matchId" = d."matchId"
      AND e."playerKey" = d."playerKey"
      AND e."eventType" = 'PLAYER_STATE'
      AND e."sourceOccurredAt" <= d.decision_source_at
      AND e."receivedAt" <= d."decidedAt"
      AND EXTRACT(EPOCH FROM (d.decision_source_at - e."sourceOccurredAt")) * 1000 <= $3
    ORDER BY e."sourceOccurredAt" DESC, e."receivedAt" DESC
    LIMIT 1
  ) ps ON TRUE
  LEFT JOIN LATERAL (
    SELECT e.*
    FROM recommendation_telemetry_events e
    WHERE e."matchId" = d."matchId"
      AND e."playerKey" = d."playerKey"
      AND e."eventType" = 'INVENTORY_SNAPSHOT'
      AND e."sourceOccurredAt" <= d.decision_source_at
      AND e."receivedAt" <= d."decidedAt"
      AND EXTRACT(EPOCH FROM (d.decision_source_at - e."sourceOccurredAt")) * 1000 <= $3
    ORDER BY e."sourceOccurredAt" DESC, e."receivedAt" DESC
    LIMIT 1
  ) inv ON TRUE
), per_decision AS (
  SELECT
    a.*,
    ((a.player_payload->'spendableSoulsVerified'->>'value') IS NOT NULL
      AND (a.player_payload->'spendableSoulsVerified'->>'verificationContractVersion') IS NOT NULL) AS exact_wallet_known,
    ((a.player_payload->>'shopOpportunity') IN ('AVAILABLE', 'UNAVAILABLE')
      AND a.player_payload->'shopOpportunityProvenance'->>'type' = 'DIRECT_SOURCE_SIGNAL'
      AND COALESCE(a.player_payload->'shopOpportunityProvenance'->>'sourceField', '') <> ''
      AND (
        COALESCE(a.player_source, '') || ':' || COALESCE(a.player_payload->'shopOpportunityProvenance'->>'sourceField', '')
      ) = ANY($4::text[])) AS shop_known,
    (a.inventory_payload IS NOT NULL
      AND (a.inventory_payload->>'snapshotSha256') ~ '^[a-fA-F0-9]{64}$') AS inventory_known,
    (COALESCE(a."rulesetVersion", '') <> ''
      AND COALESCE(a."catalogSha256", '') ~ '^[a-fA-F0-9]{64}$'
      AND EXISTS (
        SELECT 1
        FROM item_catalog_versions cv
        WHERE cv."payloadSha256" = a."catalogSha256"
          AND COALESCE(cv."rulesetKey", cv."rulesetId"::text, cv."clientVersion") = a."rulesetVersion"
      )) AS ruleset_catalog_known,
    NOT EXISTS (
      SELECT 1
      FROM recommendation_decision_candidates_v8 c
      WHERE c."decisionId" = a."decisionId"
        AND c."feasible" = TRUE
        AND c."actionType" <> 'WAIT_SAVE'
        AND (
          c."transactionMechanicsKnown" IS NOT TRUE
          OR COALESCE(c."evidence"->>'transaction', 'UNKNOWN') = 'UNKNOWN'
          OR COALESCE(c."evidence"->>'inventory', 'UNKNOWN') = 'UNKNOWN'
          OR COALESCE(c."evidence"->>'ruleset', 'UNKNOWN') = 'UNKNOWN'
          OR COALESCE(c."evidence"->>'shopOpportunity', 'UNKNOWN') = 'UNKNOWN'
          OR (
            c."actionType" <> 'SELL_ITEM'
            AND COALESCE(c."evidence"->>'spendableSouls', 'UNKNOWN') = 'UNKNOWN'
          )
        )
    ) AS transaction_mechanics_known,
    (COALESCE(a."playerKey", '') <> '') AS player_identity_known,
    ((a.player_source_at IS NULL OR a.player_source_at <= a.decision_source_at)
      AND (a.player_received_at IS NULL OR a.player_received_at <= a."decidedAt")
      AND (a.inventory_source_at IS NULL OR a.inventory_source_at <= a.decision_source_at)
      AND (a.inventory_received_at IS NULL OR a.inventory_received_at <= a."decidedAt")) AS non_future_timestamps,
    (COALESCE(a.player_directly_observed, FALSE)
      AND COALESCE(a.inventory_directly_observed, FALSE)) AS directly_observed_state,
    (COALESCE(a.decision_stale, FALSE)
      OR COALESCE(a.player_stale, FALSE)
      OR COALESCE(a.inventory_stale, FALSE)) AS stale_state
  FROM aligned a
), expanded AS (
  SELECT 'overall'::text AS cohort_key, p.* FROM per_decision p
  UNION ALL
  SELECT p.phase_cohort AS cohort_key, p.* FROM per_decision p
)
SELECT
  cohort_key AS "cohortKey",
  COUNT(*) AS "decisionCount",
  COUNT(*) FILTER (WHERE exact_wallet_known) AS "exactSpendableSoulsCount",
  COUNT(*) FILTER (WHERE shop_known) AS "shopOpportunityCount",
  COUNT(*) FILTER (WHERE inventory_known) AS "inventorySnapshotCount",
  COUNT(*) FILTER (WHERE ruleset_catalog_known) AS "rulesetCatalogCount",
  COUNT(*) FILTER (WHERE transaction_mechanics_known) AS "transactionMechanicsCount",
  COUNT(*) FILTER (WHERE player_identity_known) AS "playerIdentityCount",
  COUNT(*) FILTER (WHERE non_future_timestamps) AS "nonFutureTimestampCount",
  COUNT(*) FILTER (WHERE directly_observed_state) AS "directlyObservedStateCount",
  COUNT(*) FILTER (WHERE stale_state) AS "staleStateCount"
FROM expanded
GROUP BY cohort_key
ORDER BY cohort_key;
`;
}

function normalizeCandidateGeneratorVersion(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (!normalized) throw new Error('candidateGeneratorVersion must be non-empty when provided');
  return normalized;
}

function toMetrics(row: ObservabilityAggregateRow): RecommendationObservabilityMetricsV1 {
  const decisionCount = number(row.decisionCount);
  return {
    decisionCount,
    exactSpendableSoulsCoverage: ratio(number(row.exactSpendableSoulsCount), decisionCount),
    shopOpportunityCoverage: ratio(number(row.shopOpportunityCount), decisionCount),
    inventorySnapshotCoverage: ratio(number(row.inventorySnapshotCount), decisionCount),
    rulesetCatalogCoverage: ratio(number(row.rulesetCatalogCount), decisionCount),
    transactionMechanicsCoverage: ratio(number(row.transactionMechanicsCount), decisionCount),
    playerIdentityCoverage: ratio(number(row.playerIdentityCount), decisionCount),
    nonFutureStateTimestampRate: ratio(number(row.nonFutureTimestampCount), decisionCount),
    directlyObservedStateRate: ratio(number(row.directlyObservedStateCount), decisionCount),
    staleStateRate: ratio(number(row.staleStateCount), decisionCount),
  };
}

function emptyMetrics(): RecommendationObservabilityMetricsV1 {
  return {
    decisionCount: 0,
    exactSpendableSoulsCoverage: 0,
    shopOpportunityCoverage: 0,
    inventorySnapshotCoverage: 0,
    rulesetCatalogCoverage: 0,
    transactionMechanicsCoverage: 0,
    playerIdentityCoverage: 0,
    nonFutureStateTimestampRate: 0,
    directlyObservedStateRate: 0,
    staleStateRate: 0,
  };
}

function number(value: string | number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function ratio(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}
