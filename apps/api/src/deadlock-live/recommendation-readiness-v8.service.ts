import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  RecommendationBehavioralServingReadyV1,
  RecommendationBehavioralServingV1Service,
} from './recommendation-behavioral-serving-v1.service';

export interface RecommendationProcessLivenessV8 {
  live: true;
  checkedAt: string;
}

export interface RecommendationDependencyReadinessV8 {
  ready: boolean;
  checkedAt: string;
  databaseReachable: boolean;
  blockers: readonly string[];
}

export interface RecommendationSemanticReadinessV8 {
  ready: boolean;
  degradedAvailable: boolean;
  checkedAt: string;
  databaseReachable: boolean;
  constraintEngineAvailable: true;
  versionedCatalogAvailable: boolean;
  verifiedActiveModelAvailable: boolean;
  behavioralServingConfigured: boolean;
  behavioralServingReady: boolean;
  loadedBehavioralModelId?: string;
  loadedBehavioralModelVersion?: string;
  loadedBehavioralManifestSha256?: string;
  exactActiveBehavioralBundleLoaded: boolean;
  runtimeHealthEvidenceAvailable: boolean;
  lastDecisionAt?: string;
  blockers: readonly string[];
}

interface CountRow {
  count: string | number;
}

interface TimestampRow {
  timestamp?: Date | string;
}

@Injectable()
export class RecommendationReadinessV8Service {
  constructor(
    private readonly dataSource: DataSource,
    private readonly behavioralServing: RecommendationBehavioralServingV1Service,
  ) {}

  live(): RecommendationProcessLivenessV8 {
    return { live: true, checkedAt: new Date().toISOString() };
  }

  async ready(): Promise<RecommendationDependencyReadinessV8> {
    const checkedAt = new Date().toISOString();
    const databaseReachable = await this.databaseReachable();
    return {
      ready: databaseReachable,
      checkedAt,
      databaseReachable,
      blockers: databaseReachable ? [] : ['DATABASE_UNREACHABLE'],
    };
  }

  async recommendationReady(): Promise<RecommendationSemanticReadinessV8> {
    const checkedAt = new Date().toISOString();
    const databaseReachable = await this.databaseReachable();
    if (!databaseReachable) return unavailable(checkedAt, false, this.behavioralServing.configured(), ['DATABASE_UNREACHABLE']);

    const [catalogCount, runtimeHealthCount, decisionRows] = await Promise.all([
      this.countSafely('SELECT COUNT(*) AS count FROM item_catalog_versions WHERE "payloadSha256" IS NOT NULL'),
      this.countSafely(`SELECT COUNT(*) AS count
        FROM recommendation_telemetry_events
        WHERE "eventType" = 'RECOMMENDATION_RUNTIME_HEALTH'`),
      this.querySafely<TimestampRow>(`SELECT MAX("decidedAt") AS timestamp FROM recommendation_decisions_v8`),
    ]);

    const versionedCatalogAvailable = catalogCount > 0;
    const runtimeHealthEvidenceAvailable = runtimeHealthCount > 0;
    const lastDecisionAt = dateString(decisionRows[0]?.timestamp);
    const behavioralServingConfigured = this.behavioralServing.configured();
    let servingReady: RecommendationBehavioralServingReadyV1 | undefined;
    if (behavioralServingConfigured) {
      try {
        servingReady = await this.behavioralServing.ready();
      } catch {
        servingReady = undefined;
      }
    }
    const exactActiveBehavioralBundleLoaded = servingReady
      ? await this.exactActiveBehavioralBundleLoaded(servingReady)
      : false;
    const verifiedActiveModelAvailable = exactActiveBehavioralBundleLoaded;
    const blockers: string[] = [];
    if (!versionedCatalogAvailable) blockers.push('NO_VERSIONED_CATALOG');
    if (!behavioralServingConfigured) blockers.push('BEHAVIORAL_SERVING_NOT_CONFIGURED');
    else if (!servingReady) blockers.push('BEHAVIORAL_SERVING_NOT_READY');
    else if (!exactActiveBehavioralBundleLoaded) blockers.push('BEHAVIORAL_SERVING_ACTIVE_BUNDLE_MISMATCH');

    return {
      ready: blockers.length === 0,
      degradedAvailable: versionedCatalogAvailable,
      checkedAt,
      databaseReachable,
      constraintEngineAvailable: true,
      versionedCatalogAvailable,
      verifiedActiveModelAvailable,
      behavioralServingConfigured,
      behavioralServingReady: servingReady !== undefined,
      loadedBehavioralModelId: servingReady?.modelId,
      loadedBehavioralModelVersion: servingReady?.modelVersion,
      loadedBehavioralManifestSha256: servingReady?.manifestSha256,
      exactActiveBehavioralBundleLoaded,
      runtimeHealthEvidenceAvailable,
      lastDecisionAt,
      blockers,
    };
  }

  async recommendationDegraded(): Promise<RecommendationSemanticReadinessV8> {
    const report = await this.recommendationReady();
    return {
      ...report,
      ready: report.degradedAvailable,
      blockers: report.degradedAvailable
        ? []
        : [...new Set([...report.blockers, 'DETERMINISTIC_HOLD_FALLBACK_UNAVAILABLE'])].sort(),
    };
  }

  private async exactActiveBehavioralBundleLoaded(ready: RecommendationBehavioralServingReadyV1): Promise<boolean> {
    const rows = await this.querySafely<CountRow>(
      `SELECT COUNT(*) AS count
       FROM model_bundle_registry_v1
       WHERE status = 'ACTIVE'
         AND verification IS NOT NULL
         AND "verifiedAt" IS NOT NULL
         AND manifest->>'modelKind' = 'BEHAVIORAL'
         AND "modelId" = $1
         AND "modelVersion" = $2
         AND "manifestSha256" = $3`,
      [ready.modelId, ready.modelVersion, ready.manifestSha256],
    );
    return Number(rows[0]?.count ?? 0) === 1;
  }

  private async databaseReachable(): Promise<boolean> {
    try {
      await this.dataSource.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  private async countSafely(sql: string): Promise<number> {
    const rows = await this.querySafely<CountRow>(sql);
    const parsed = Number(rows[0]?.count ?? 0);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  private async querySafely<T>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
    try {
      return await this.dataSource.query(sql, params) as T[];
    } catch {
      return [];
    }
  }
}

function unavailable(
  checkedAt: string,
  databaseReachable: boolean,
  behavioralServingConfigured: boolean,
  blockers: readonly string[],
): RecommendationSemanticReadinessV8 {
  return {
    ready: false,
    degradedAvailable: false,
    checkedAt,
    databaseReachable,
    constraintEngineAvailable: true,
    versionedCatalogAvailable: false,
    verifiedActiveModelAvailable: false,
    behavioralServingConfigured,
    behavioralServingReady: false,
    exactActiveBehavioralBundleLoaded: false,
    runtimeHealthEvidenceAvailable: false,
    blockers,
  };
}

function dateString(value: Date | string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}
