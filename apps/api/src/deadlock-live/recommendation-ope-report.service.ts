import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { EXACT_ACTION_PROPENSITY_SOURCE, evaluateOffPolicyV1 } from '@deadlock-live-probe/shared';

export type RecommendationOpeRewardV1 =
  | 'economyDelta120s'
  | 'economyDelta300s'
  | 'objectiveDelta300s'
  | 'finalPlayerWon';

export interface RecommendationOpeReportOptionsV1 {
  from?: Date;
  to?: Date;
  reward: RecommendationOpeRewardV1;
}

export interface RecommendationOpeReportV1 {
  generatedAt: string;
  from?: string;
  to?: string;
  reward: RecommendationOpeRewardV1;
  randomizedDecisionCount: number;
  outcomeDecisionCount: number;
  evaluableDecisionCount: number;
  excludedDecisionCount: number;
  evidenceSufficient: boolean;
  blockers: readonly string[];
  evaluation?: ReturnType<typeof evaluateOffPolicyV1>;
}

interface OpeRow {
  decisionId: string;
  reward?: string | number | boolean;
  loggingPropensity?: string | number;
  targetProbability?: string | number;
  qLogged?: string | number;
  qTargetExpected?: string | number;
  policyMass?: string | number;
}

interface CountRow {
  count: string | number;
}

@Injectable()
export class RecommendationOpeReportService {
  constructor(private readonly dataSource: DataSource) {}

  async buildReport(options: RecommendationOpeReportOptionsV1): Promise<RecommendationOpeReportV1> {
    validateRange(options.from, options.to);
    const rewardExpression = rewardSqlExpression(options.reward);
    const params = [options.from?.toISOString() ?? null, options.to?.toISOString() ?? null];
    const [rows, randomizedRows, outcomeRows] = await Promise.all([
      this.dataSource.query(opeSql(rewardExpression), params),
      this.dataSource.query(randomizedDecisionCountSql(), params),
      this.dataSource.query(outcomeDecisionCountSql(rewardExpression), params),
    ]) as [OpeRow[], CountRow[], CountRow[]];

    const randomizedDecisionCount = number(randomizedRows[0]?.count ?? 0);
    const outcomeDecisionCount = number(outcomeRows[0]?.count ?? 0);
    const evaluationRows = rows.flatMap((row) => {
      const reward = numericReward(row.reward);
      const loggingPropensity = numberOrUndefined(row.loggingPropensity);
      const targetProbability = numberOrUndefined(row.targetProbability);
      const qLogged = numberOrUndefined(row.qLogged);
      const qTargetExpected = numberOrUndefined(row.qTargetExpected);
      const policyMass = numberOrUndefined(row.policyMass);
      if (
        reward === undefined
        || loggingPropensity === undefined
        || loggingPropensity <= 0
        || loggingPropensity > 1
        || targetProbability === undefined
        || targetProbability < 0
        || targetProbability > 1
        || qLogged === undefined
        || qTargetExpected === undefined
        || policyMass === undefined
        || Math.abs(policyMass - 1) > 1e-6
      ) return [];
      return [{
        decisionId: row.decisionId,
        reward,
        loggingPropensity,
        loggingPropensitySource: EXACT_ACTION_PROPENSITY_SOURCE,
        targetProbability,
        qLogged,
        qTargetExpected,
      }];
    });
    const evaluableDecisionCount = evaluationRows.length;
    const excludedDecisionCount = Math.max(0, randomizedDecisionCount - evaluableDecisionCount);
    const blockers: string[] = [];
    if (randomizedDecisionCount === 0) blockers.push('NO_RANDOMIZED_DECISIONS');
    if (outcomeDecisionCount === 0) blockers.push('NO_MATCHED_OUTCOMES');
    if (evaluableDecisionCount === 0) blockers.push('NO_EVALUABLE_OPE_ROWS');
    if (evaluableDecisionCount < randomizedDecisionCount) blockers.push('INCOMPLETE_OPE_SUPPORT');
    const evidenceSufficient = blockers.length === 0;

    return {
      generatedAt: new Date().toISOString(),
      from: options.from?.toISOString(),
      to: options.to?.toISOString(),
      reward: options.reward,
      randomizedDecisionCount,
      outcomeDecisionCount,
      evaluableDecisionCount,
      excludedDecisionCount,
      evidenceSufficient,
      blockers,
      evaluation: evidenceSufficient ? evaluateOffPolicyV1(evaluationRows) : undefined,
    };
  }
}

function opeSql(rewardExpression: string): string {
  return `
WITH outcomes AS (
  SELECT DISTINCT ON (e."payload"->>'decisionId')
    e."payload"->>'decisionId' AS decision_id,
    e."payload" AS payload
  FROM recommendation_telemetry_events e
  WHERE e."eventType" = 'RECOMMENDATION_OUTCOME'
    AND COALESCE(e."payload"->>'decisionId', '') <> ''
  ORDER BY e."payload"->>'decisionId', e."sourceOccurredAt" DESC, e."receivedAt" DESC
), candidate_values AS (
  SELECT
    c."decisionId",
    SUM(c."policyScore") FILTER (
      WHERE c."policyScore" IS NOT NULL AND c."valueScore" IS NOT NULL
    ) AS policy_mass,
    SUM(c."policyScore" * c."valueScore") FILTER (
      WHERE c."policyScore" IS NOT NULL AND c."valueScore" IS NOT NULL
    ) AS q_target_expected
  FROM recommendation_decision_candidates_v8 c
  GROUP BY c."decisionId"
)
SELECT
  d."decisionId" AS "decisionId",
  ${rewardExpression} AS reward,
  d."actionLoggingPropensity" AS "loggingPropensity",
  selected."policyScore" AS "targetProbability",
  selected."valueScore" AS "qLogged",
  cv.q_target_expected AS "qTargetExpected",
  cv.policy_mass AS "policyMass"
FROM recommendation_decisions_v8 d
JOIN outcomes o ON o.decision_id = d."decisionId"
LEFT JOIN recommendation_decision_candidates_v8 selected
  ON selected."decisionId" = d."decisionId"
 AND selected."actionKey" = d."selectedActionKey"
LEFT JOIN candidate_values cv ON cv."decisionId" = d."decisionId"
WHERE d."randomized" IS TRUE
  AND ($1::timestamptz IS NULL OR d."decidedAt" >= $1::timestamptz)
  AND ($2::timestamptz IS NULL OR d."decidedAt" < $2::timestamptz)
ORDER BY d."decidedAt", d."decisionId";
`;
}

function randomizedDecisionCountSql(): string {
  return `
SELECT COUNT(*) AS count
FROM recommendation_decisions_v8 d
WHERE d."randomized" IS TRUE
  AND ($1::timestamptz IS NULL OR d."decidedAt" >= $1::timestamptz)
  AND ($2::timestamptz IS NULL OR d."decidedAt" < $2::timestamptz);
`;
}

function outcomeDecisionCountSql(rewardExpression: string): string {
  return `
WITH outcomes AS (
  SELECT DISTINCT ON (e."payload"->>'decisionId')
    e."payload"->>'decisionId' AS decision_id,
    e."payload" AS payload
  FROM recommendation_telemetry_events e
  WHERE e."eventType" = 'RECOMMENDATION_OUTCOME'
    AND COALESCE(e."payload"->>'decisionId', '') <> ''
  ORDER BY e."payload"->>'decisionId', e."sourceOccurredAt" DESC, e."receivedAt" DESC
)
SELECT COUNT(*) AS count
FROM recommendation_decisions_v8 d
JOIN outcomes o ON o.decision_id = d."decisionId"
WHERE d."randomized" IS TRUE
  AND (${rewardExpression}) IS NOT NULL
  AND ($1::timestamptz IS NULL OR d."decidedAt" >= $1::timestamptz)
  AND ($2::timestamptz IS NULL OR d."decidedAt" < $2::timestamptz);
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

function validateRange(from: Date | undefined, to: Date | undefined): void {
  if (from && !Number.isFinite(from.getTime())) throw new Error('from is invalid');
  if (to && !Number.isFinite(to.getTime())) throw new Error('to is invalid');
  if (from && to && from >= to) throw new Error('from must be before to');
}

function numericReward(value: string | number | boolean | undefined): number | undefined {
  if (typeof value === 'boolean') return value ? 1 : 0;
  return numberOrUndefined(value);
}

function numberOrUndefined(value: string | number | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function number(value: string | number): number {
  return numberOrUndefined(value) ?? 0;
}
