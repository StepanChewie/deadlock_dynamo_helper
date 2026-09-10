import { Injectable, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RecommendationItemCatalogVersionV1 } from '../deadlock-live/entities/recommendation-item-catalog-version-v1.entity';
import {
  StatlockerBrowserCollectorService,
  StatlockerCollectedDatasetV1,
  StatlockerCollectionTargetV1,
} from './statlocker-browser-collector.service';
import { BuildArchetypeRefreshV2Service } from './build-archetype-refresh-v2.service';
import { BuildSkeletonService } from './build-skeleton.service';
import { STATLOCKER_HERO_IDS_V1 } from './statlocker-hero-pool';
import { StatlockerNormalizerService } from './statlocker-normalizer.service';
import {
  StatlockerNormalizedDatasetV1,
  StatlockerNormalizedPayloadV1,
} from './statlocker-adaptive.types';
import { StatlockerSnapshotStoreService } from './statlocker-snapshot-store.service';
import { StatlockerVsHeroWpaPublisherV1Service } from './statlocker-vs-hero-wpa-publisher-v1.service';
import { StatlockerVsHeroWpaRawStoreV1Service } from './statlocker-vs-hero-wpa-raw-store-v1.service';
import { StatlockerVsHeroWpaRowNormalizerV1Service } from './statlocker-vs-hero-wpa-row-normalizer-v1.service';

export interface StatlockerGameIdentityV1 {
  rulesetVersion: string;
  catalogSha256: string;
}

export interface StatlockerRefreshStatusV1 {
  activeHeroIds: readonly number[];
  inFlightKeys: readonly string[];
  lastAttemptAt?: string;
  lastSuccessAt?: string;
  lastError?: string;
  identity?: StatlockerGameIdentityV1;
}

const MINUTE = 60_000;
import { AdaptiveRecommendationObservabilityV1Service } from './adaptive-recommendation-observability-v1.service';

const HOUR = 60 * MINUTE;
const GLOBAL_REFRESH_TTL_MS = 30 * MINUTE;
const VS_HERO_WPA_REFRESH_TTL_MS = 24 * HOUR;
const HERO_REFRESH_TTL_MS = 36 * HOUR;
const DEFAULT_ACTIVE_HERO_TTL_MS = 30 * MINUTE;
const MAX_PROFILES_PER_HERO = 10;
const SNAPSHOT_SCHEMA_VERSION = 'statlocker-evidence-v1';
const COLLECTOR_VERSION = 'statlocker-browser-collector-v1';
const NORMALIZER_VERSION = 'statlocker-normalizer-v1';

@Injectable()
export class StatlockerRefreshService {
  private identity?: StatlockerGameIdentityV1;
  private readonly activeHeroes = new Map<number, number>();
  private readonly lastSuccessByKey = new Map<string, number>();
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly activeHeroTtlMs = readBoundedMs(
    process.env.STATLOCKER_ACTIVE_HERO_TTL_MS,
    DEFAULT_ACTIVE_HERO_TTL_MS,
    MINUTE,
    24 * HOUR,
  );
  private poolCursor = 0;
  private lastAttemptAt?: string;
  private lastSuccessAt?: string;
  private lastError?: string;

  constructor(
    private readonly collector: StatlockerBrowserCollectorService,
    private readonly normalizer: StatlockerNormalizerService,
    private readonly store: StatlockerSnapshotStoreService,
    @Optional() private readonly skeleton?: BuildSkeletonService,
    @Optional()
    @InjectRepository(RecommendationItemCatalogVersionV1)
    private readonly catalogVersionRepo?: Repository<RecommendationItemCatalogVersionV1>,
    @Optional() private readonly rawVsHeroWpaStore?: StatlockerVsHeroWpaRawStoreV1Service,
    @Optional() private readonly vsHeroWpaRowNormalizer?: StatlockerVsHeroWpaRowNormalizerV1Service,
    @Optional() private readonly vsHeroWpaPublisher?: StatlockerVsHeroWpaPublisherV1Service,
    @Optional() private readonly observability?: AdaptiveRecommendationObservabilityV1Service,
    @Optional() private readonly archetypeRefreshV2?: BuildArchetypeRefreshV2Service,
  ) {}

  observeGameIdentity(identity: StatlockerGameIdentityV1, _nowMs = Date.now()): void {
    validateIdentity(identity);
    const changed =
      this.identity?.rulesetVersion !== identity.rulesetVersion ||
      this.identity?.catalogSha256.toLowerCase() !== identity.catalogSha256.toLowerCase();
    this.identity = {
      rulesetVersion: identity.rulesetVersion,
      catalogSha256: identity.catalogSha256.toLowerCase(),
    };
    if (changed) {
      this.lastSuccessByKey.clear();
      this.poolCursor = 0;
    }
  }

  observeActiveHero(heroId: number, nowMs = Date.now()): void {
    if (!Number.isInteger(heroId) || heroId <= 0) return;
    this.activeHeroes.set(heroId, nowMs);
  }

  enqueueHeroRefresh(heroId: number, nowMs = Date.now()): void {
    this.observeActiveHero(heroId, nowMs);
    if (!Number.isInteger(heroId) || heroId <= 0) return;
    void this.refreshHeroNow(heroId, false, nowMs).catch((error) => {
      this.lastError = describeError(error);
    });
  }

  async refreshGlobalNow(force = false, nowMs = Date.now()): Promise<void> {
    const identity = this.requireIdentity();
    const key = this.globalRefreshKey(identity);
    const vsHeroWpaKey = this.globalVsHeroWpaRefreshKey(identity);
    const globalDue = force || this.isDue(key, GLOBAL_REFRESH_TTL_MS, nowMs);
    const vsHeroWpaDue = force || this.isDue(vsHeroWpaKey, VS_HERO_WPA_REFRESH_TTL_MS, nowMs);
    if (!globalDue && !vsHeroWpaDue) return;

    const targets: StatlockerCollectionTargetV1[] = [];
    if (globalDue) targets.push({ dataset: 'WPA_PATCH_DATA', scopeKey: 'patch:current' });
    if (vsHeroWpaDue) targets.push({ dataset: 'VS_HERO_WPA', scopeKey: 'global' });
    if (globalDue) targets.push({ dataset: 'T4_CHAINS', scopeKey: 'global' });

    return this.singleFlight(key, async () => {
      this.markAttempt(nowMs);
      try {
        const result = await this.collector.collectBatch(targets);
        for (const dataset of result.datasets) {
          if (dataset.dataset === 'VS_HERO_WPA') {
            const rawSnapshot = await this.rawVsHeroWpaStore?.persistCollected({
              fetchedAt: new Date(dataset.fetchedAt),
              sourcePath: dataset.path,
              sourceStatus: dataset.status,
              statlockerPatchId: result.statlockerPatchId,
              rulesetVersion: identity.rulesetVersion,
              catalogSha256: identity.catalogSha256,
              collectorVersion: COLLECTOR_VERSION,
              rawPayload: dataset.data,
            });

            if (!rawSnapshot) {
              throw new Error('VS_HERO_WPA RAW persistence is unavailable');
            }
            if (rawSnapshot.ingestStatus === 'PUBLISHED') continue;

            const ingestStartedAt = Date.now();
            try {
              if (!this.vsHeroWpaRowNormalizer || !this.vsHeroWpaPublisher) {
                throw new Error('VS_HERO_WPA relational ingest dependencies are unavailable');
              }
              const rows = this.vsHeroWpaRowNormalizer.normalize(dataset.data, {
                snapshotId: rawSnapshot.snapshotId,
                statlockerPatchId: result.statlockerPatchId,
                rulesetVersion: identity.rulesetVersion,
                catalogSha256: identity.catalogSha256,
              });
              await this.vsHeroWpaPublisher.publish({
                snapshotId: rawSnapshot.snapshotId,
                rows,
              });
              this.observability?.recordWpaIngestOutcome({
                dataset: 'VS_HERO_WPA',
                durationMs: Date.now() - ingestStartedAt,
                rowCount: rows.length,
              });
            } catch (error) {
              this.observability?.recordWpaIngestOutcome({
                dataset: 'VS_HERO_WPA',
                durationMs: Date.now() - ingestStartedAt,
                rowCount: 0,
                failure: error instanceof Error ? error.message : String(error),
              });
              if (this.vsHeroWpaPublisher) {
                await this.vsHeroWpaPublisher.markFailed(rawSnapshot.snapshotId, error);
              }
              throw error;
            }
            continue;
          }

          const normalized = this.normalizeCollected(dataset, result.statlockerPatchId);
          await this.publishObservation(normalized, identity, dataset);
        }
        if (globalDue) this.lastSuccessByKey.set(key, nowMs);
        if (vsHeroWpaDue) this.lastSuccessByKey.set(vsHeroWpaKey, nowMs);
        this.markSuccess(nowMs);
      } catch (error) {
        this.lastError = describeError(error);
        throw error;
      }
    });
  }

  async refreshHeroNow(heroId: number, force = false, nowMs = Date.now()): Promise<void> {
    if (!Number.isInteger(heroId) || heroId <= 0) return;
    const identity = this.requireIdentity();
    const key = this.heroRefreshKey(identity, heroId);
    if (!force && !this.isHeroDue(identity, heroId, nowMs)) return;
    return this.singleFlight(key, async () => {
      this.markAttempt(nowMs);
      try {
        const leaderboardResult = await this.collector.collectBatch([
          { dataset: 'HERO_LEADERBOARD', scopeKey: `hero:${heroId}`, heroId },
        ]);
        const leaderboardRaw = leaderboardResult.datasets[0];
        if (!leaderboardRaw) throw new Error(`Missing leaderboard collection for hero ${heroId}`);
        const leaderboard = this.normalizer.normalizeHeroLeaderboard(
          leaderboardRaw.data,
          leaderboardResult.statlockerPatchId,
          heroId,
        );
        await this.publishObservation(leaderboard, identity, leaderboardRaw);

        const profiles = leaderboard.payload.profiles.slice(0, MAX_PROFILES_PER_HERO);
        if (profiles.length > 0) {
          const targets: StatlockerCollectionTargetV1[] = profiles.map((profile) => ({
            dataset: 'PRO_BUILD_ANALYSIS',
            scopeKey: `hero:${heroId}:account:${profile.accountId}`,
            heroId,
            accountId: profile.accountId,
          }));
          const profileResult = await this.collector.collectBatch(targets);
          for (const dataset of profileResult.datasets) {
            const accountId = accountIdFromScope(dataset.scopeKey);
            const normalized = this.normalizer.normalizeProBuildAnalysis(
              dataset.data,
              profileResult.statlockerPatchId,
              accountId,
              heroId,
            );
            await this.publishObservation(normalized, identity, dataset);
          }
        }

        await this.archetypeRefreshV2?.refreshHero(heroId, {
          rulesetVersion: identity.rulesetVersion,
          catalogSha256: identity.catalogSha256,
          statlockerPatchId: leaderboardResult.statlockerPatchId,
        }, nowMs);

        await this.skeleton?.rebuild({
          heroId,
          rulesetVersion: identity.rulesetVersion,
          catalogSha256: identity.catalogSha256,
          statlockerPatchId: leaderboardResult.statlockerPatchId,
        });
        this.lastSuccessByKey.set(key, nowMs);
        this.markSuccess(nowMs);
      } catch (error) {
        this.lastError = describeError(error);
        throw error;
      }
    });
  }

  @Cron('* * * * *')
  async scheduledTick(nowMs = Date.now()): Promise<void> {
    this.pruneInactiveHeroes(nowMs);
    if (!this.identity) {
      await this.bootstrapIdentity().catch((error) => {
        this.lastError = describeError(error);
      });
    }
    if (!this.identity) return;

    await this.refreshGlobalNow(false, nowMs).catch((error) => {
      this.lastError = describeError(error);
    });

    const heroId = this.takeNextDuePoolHero(this.identity, nowMs);
    if (heroId === undefined) return;
    await this.refreshHeroNow(heroId, false, nowMs).catch((error) => {
      this.lastError = describeError(error);
    });
  }

  getStatus(): StatlockerRefreshStatusV1 {
    return {
      activeHeroIds: [...this.activeHeroes.keys()].sort((a, b) => a - b),
      inFlightKeys: [...this.inFlight.keys()].sort(),
      lastAttemptAt: this.lastAttemptAt,
      lastSuccessAt: this.lastSuccessAt,
      lastError: this.lastError,
      identity: this.identity ? { ...this.identity } : undefined,
    };
  }

  private async bootstrapIdentity(): Promise<void> {
    if (this.identity || !this.catalogVersionRepo) return;
    const [version] = await this.catalogVersionRepo.find({
      order: { importedAt: 'DESC', catalogVersionId: 'DESC' },
      take: 1,
    });
    if (!version) return;
    this.observeGameIdentity({
      rulesetVersion: version.rulesetKey,
      catalogSha256: version.payloadSha256,
    });
  }

  private takeNextDuePoolHero(identity: StatlockerGameIdentityV1, nowMs: number): number | undefined {
    if (STATLOCKER_HERO_IDS_V1.length === 0) return undefined;
    for (let offset = 0; offset < STATLOCKER_HERO_IDS_V1.length; offset += 1) {
      const index = (this.poolCursor + offset) % STATLOCKER_HERO_IDS_V1.length;
      const heroId = STATLOCKER_HERO_IDS_V1[index];
      if (!this.isHeroDue(identity, heroId, nowMs)) continue;
      this.poolCursor = (index + 1) % STATLOCKER_HERO_IDS_V1.length;
      return heroId;
    }
    return undefined;
  }

  private isHeroDue(identity: StatlockerGameIdentityV1, heroId: number, nowMs: number): boolean {
    const key = this.heroRefreshKey(identity, heroId);
    const inMemorySuccess = this.lastSuccessByKey.get(key);
    if (inMemorySuccess !== undefined) return nowMs - inMemorySuccess >= HERO_REFRESH_TTL_MS;

    const rows = this.store.listActive().filter((row) =>
      row.rulesetVersion === identity.rulesetVersion &&
      row.catalogSha256.toLowerCase() === identity.catalogSha256.toLowerCase(),
    );
    const currentPatchId = rows
      .filter((row) => row.dataset === 'WPA_PATCH_DATA' || row.dataset === 'T4_CHAINS')
      .sort((a, b) => b.fetchedAt.getTime() - a.fetchedAt.getTime())[0]?.statlockerPatchId;
    const latestHeroSnapshot = rows
      .filter((row) =>
        row.dataset === 'HERO_LEADERBOARD' &&
        row.scopeKey === `hero:${heroId}` &&
        (!currentPatchId || row.statlockerPatchId === currentPatchId),
      )
      .sort((a, b) => b.fetchedAt.getTime() - a.fetchedAt.getTime())[0];

    const latestConsensusSnapshot = rows
      .filter((row) =>
        row.dataset === 'CONSENSUS_SKELETON' &&
        row.scopeKey === `hero:${heroId}:consensus` &&
        (!currentPatchId || row.statlockerPatchId === currentPatchId),
      )
      .sort((a, b) => b.fetchedAt.getTime() - a.fetchedAt.getTime())[0];

    if (!latestConsensusSnapshot) return true;
    if (latestHeroSnapshot && latestConsensusSnapshot.fetchedAt < latestHeroSnapshot.fetchedAt) return true;

    return !latestHeroSnapshot || nowMs - latestHeroSnapshot.fetchedAt.getTime() >= HERO_REFRESH_TTL_MS;
  }

  private normalizeCollected(
    dataset: StatlockerCollectedDatasetV1,
    statlockerPatchId: string,
  ): StatlockerNormalizedDatasetV1 {
    if (dataset.dataset === 'WPA_PATCH_DATA') return this.normalizer.normalizeWpaPatchData(dataset.data, statlockerPatchId);
    if (dataset.dataset === 'VS_HERO_WPA') return this.normalizer.normalizeVsHeroWpa(dataset.data, statlockerPatchId);
    if (dataset.dataset === 'T4_CHAINS') return this.normalizer.normalizeT4Chains(dataset.data, statlockerPatchId);
    if (dataset.dataset === 'HERO_LEADERBOARD') {
      const heroId = heroIdFromScope(dataset.scopeKey);
      return this.normalizer.normalizeHeroLeaderboard(dataset.data, statlockerPatchId, heroId);
    }
    if (dataset.dataset === 'PRO_BUILD_ANALYSIS') {
      const heroId = heroIdFromScope(dataset.scopeKey);
      return this.normalizer.normalizeProBuildAnalysis(dataset.data, statlockerPatchId, accountIdFromScope(dataset.scopeKey), heroId);
    }
    if (dataset.dataset === 'WPA_FILTERED_ITEMS') {
      const heroId = heroIdFromScope(dataset.scopeKey);
      return this.normalizer.normalizeWpaFilteredItems(dataset.data, statlockerPatchId, heroId);
    }
    throw new Error(`Unsupported collected dataset ${String(dataset.dataset)}`);
  }

  private async publishObservation(
    normalized: StatlockerNormalizedDatasetV1<StatlockerNormalizedPayloadV1>,
    identity: StatlockerGameIdentityV1,
    source: StatlockerCollectedDatasetV1,
  ): Promise<void> {
    await this.store.publish({
      dataset: normalized.dataset,
      rulesetVersion: identity.rulesetVersion,
      catalogSha256: identity.catalogSha256,
      statlockerPatchId: normalized.statlockerPatchId,
      scopeKey: normalized.scopeKey,
      contentSha256: normalized.contentSha256,
      fetchedAt: new Date(source.fetchedAt),
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      collectorVersion: COLLECTOR_VERSION,
      normalizerVersion: NORMALIZER_VERSION,
      payload: normalized.payload as unknown as Record<string, unknown>,
      metadata: { sourcePath: source.path, httpStatus: source.status },
    });
  }

  private singleFlight(key: string, work: () => Promise<void>): Promise<void> {
    const current = this.inFlight.get(key);
    if (current) return current;
    const promise = work().finally(() => {
      if (this.inFlight.get(key) === promise) this.inFlight.delete(key);
    });
    this.inFlight.set(key, promise);
    return promise;
  }

  private isDue(key: string, ttlMs: number, nowMs: number): boolean {
    const lastSuccess = this.lastSuccessByKey.get(key);
    return lastSuccess === undefined || nowMs - lastSuccess >= ttlMs;
  }

  private pruneInactiveHeroes(nowMs: number): void {
    for (const [heroId, lastSeenAt] of this.activeHeroes.entries()) {
      if (nowMs - lastSeenAt > this.activeHeroTtlMs) this.activeHeroes.delete(heroId);
    }
  }

  private requireIdentity(): StatlockerGameIdentityV1 {
    if (!this.identity) throw new Error('Statlocker game identity is unavailable');
    return this.identity;
  }

  private globalRefreshKey(identity: StatlockerGameIdentityV1): string {
    return `global:${identity.rulesetVersion}:${identity.catalogSha256}`;
  }

  private globalVsHeroWpaRefreshKey(identity: StatlockerGameIdentityV1): string {
    return `${this.globalRefreshKey(identity)}:vs-hero-wpa`;
  }

  private heroRefreshKey(identity: StatlockerGameIdentityV1, heroId: number): string {
    return `hero:${heroId}:${identity.rulesetVersion}:${identity.catalogSha256}`;
  }

  private markAttempt(nowMs: number): void {
    this.lastAttemptAt = new Date(nowMs).toISOString();
    this.lastError = undefined;
  }

  private markSuccess(nowMs: number): void {
    this.lastSuccessAt = new Date(nowMs).toISOString();
    this.lastError = undefined;
  }
}

function validateIdentity(identity: StatlockerGameIdentityV1): void {
  if (!identity.rulesetVersion || !/^[a-f0-9]{64}$/i.test(identity.catalogSha256)) {
    throw new Error('Invalid Statlocker game identity');
  }
}

function heroIdFromScope(scopeKey: string): number {
  const match = /^hero:(\d+)/.exec(scopeKey);
  const heroId = match ? Number(match[1]) : Number.NaN;
  if (!Number.isInteger(heroId) || heroId <= 0) throw new Error(`Invalid hero scope ${scopeKey}`);
  return heroId;
}

function accountIdFromScope(scopeKey: string): string {
  const match = /:account:([^:]+)$/.exec(scopeKey);
  if (!match?.[1]) throw new Error(`Invalid account scope ${scopeKey}`);
  return match[1];
}

function readBoundedMs(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) return fallback;
  return value;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown Statlocker refresh failure';
}
