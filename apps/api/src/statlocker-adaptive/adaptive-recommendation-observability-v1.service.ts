import { Injectable, Logger } from '@nestjs/common';

export interface WpaIngestObservationV1 {
  dataset: 'VS_HERO_WPA';
  durationMs: number;
  rowCount: number;
  failure?: string;
}

export interface AdaptiveRecommendationObservabilityStatusV1 {
  updatedAt: string;
  wpaQueryCount: number;
  wpaQueryLatencyMsTotal: number;
  wpaQueryLatencyMsMax: number;
  wpaIngestCount: number;
  wpaIngestFailureCount: number;
  wpaIngestRowCountTotal: number;
  wpaIngestLatencyMsTotal: number;
  latestWpaIngest?: WpaIngestObservationV1;
}

/**
 * Live observability for the statlocker adaptive serving path: WPA query
 * latency and WPA ingest outcomes (feed health for the v2 evidence pipeline).
 */
@Injectable()
export class AdaptiveRecommendationObservabilityV1Service {
  private readonly logger = new Logger(AdaptiveRecommendationObservabilityV1Service.name);
  private latestWpaIngest?: WpaIngestObservationV1;
  private readonly status = {
    updatedAt: new Date(0).toISOString(),
    wpaQueryCount: 0,
    wpaQueryLatencyMsTotal: 0,
    wpaQueryLatencyMsMax: 0,
    wpaIngestCount: 0,
    wpaIngestFailureCount: 0,
    wpaIngestRowCountTotal: 0,
    wpaIngestLatencyMsTotal: 0,
  };

  recordWpaQueryLatency(durationMs: number): void {
    const bounded = Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0;
    this.status.wpaQueryCount += 1;
    this.status.wpaQueryLatencyMsTotal += bounded;
    this.status.wpaQueryLatencyMsMax = Math.max(this.status.wpaQueryLatencyMsMax, bounded);
    this.touch();
  }

  recordWpaIngestOutcome(observation: WpaIngestObservationV1): void {
    const bounded = Number.isFinite(observation.durationMs) ? Math.max(0, observation.durationMs) : 0;
    this.status.wpaIngestCount += 1;
    this.status.wpaIngestLatencyMsTotal += bounded;
    this.status.wpaIngestRowCountTotal += Number.isInteger(observation.rowCount) ? observation.rowCount : 0;
    if (observation.failure) this.status.wpaIngestFailureCount += 1;
    this.latestWpaIngest = {
      dataset: observation.dataset,
      durationMs: bounded,
      rowCount: observation.rowCount,
      ...(observation.failure ? { failure: observation.failure.slice(0, 200) } : {}),
    };
    this.touch();
    this.logger.debug(`wpa-ingest ${JSON.stringify(this.latestWpaIngest)}`);
  }

  getStatus(): AdaptiveRecommendationObservabilityStatusV1 {
    return {
      updatedAt: this.status.updatedAt,
      wpaQueryCount: this.status.wpaQueryCount,
      wpaQueryLatencyMsTotal: this.status.wpaQueryLatencyMsTotal,
      wpaQueryLatencyMsMax: this.status.wpaQueryLatencyMsMax,
      wpaIngestCount: this.status.wpaIngestCount,
      wpaIngestFailureCount: this.status.wpaIngestFailureCount,
      wpaIngestRowCountTotal: this.status.wpaIngestRowCountTotal,
      wpaIngestLatencyMsTotal: this.status.wpaIngestLatencyMsTotal,
      latestWpaIngest: this.latestWpaIngest ? { ...this.latestWpaIngest } : undefined,
    };
  }

  private touch(): void {
    this.status.updatedAt = new Date().toISOString();
  }
}
