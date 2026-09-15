import { Injectable } from '@nestjs/common';
import { AdaptiveEvidenceFreshnessV1 } from '@dynamo-lab/shared';
import {
  StatlockerEvidenceFamilyV1,
  StatlockerNormalizedPayloadV1,
} from './statlocker-adaptive.types';
import { StatlockerRefreshService, StatlockerGameIdentityV1 } from './statlocker-refresh.service';
import {
  StatlockerSnapshotStoreService,
  StatlockerStoredSnapshotV1,
  isSelectableSnapshot,
} from './statlocker-snapshot-store.service';

export type AdaptiveScoringDatasetV1 =
  | 'WPA_PATCH_DATA'
  | 'VS_HERO_WPA'
  | 'T4_CHAINS'
  | 'CONSENSUS_SKELETON'
  | 'WPA_FILTERED_ITEMS';

export interface StatlockerEvidenceRequestV1 {
  heroId: number;
  rulesetVersion: string;
  catalogSha256: string;
  statlockerPatchId: string;
  nowMs?: number;
}

export interface StatlockerEvidenceBundleV1 {
  heroId: number;
  rulesetVersion: string;
  catalogSha256: string;
  statlockerPatchId: string;
  usable: boolean;
  snapshotIds: readonly string[];
  degradedReasons: readonly string[];
  families: readonly StatlockerEvidenceFamilyV1[];
  byDataset: Record<AdaptiveScoringDatasetV1, StatlockerEvidenceFamilyV1>;
}

export interface StatlockerLocalStatusFamilyV1 {
  dataset: string;
  scopeKey: string;
  snapshotId: string;
  statlockerPatchId: string;
  fetchedAt: string;
  freshness: AdaptiveEvidenceFreshnessV1;
}

export interface StatlockerLocalEvidenceStatusV1 {
  statlockerPatchId?: string;
  activeSnapshotIds: readonly string[];
  families: readonly StatlockerLocalStatusFamilyV1[];
}

interface FreshnessPolicyV1 {
  refreshAfterMs: number;
  maxStaleAgeMs: number;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const FRESH_EVIDENCE_AGE_MS = 2 * DAY;
const MAX_STALE_EVIDENCE_AGE_MS = 4 * DAY;
const POLICIES: Record<AdaptiveScoringDatasetV1, FreshnessPolicyV1> = {
  WPA_PATCH_DATA: { refreshAfterMs: FRESH_EVIDENCE_AGE_MS, maxStaleAgeMs: MAX_STALE_EVIDENCE_AGE_MS },
  VS_HERO_WPA: { refreshAfterMs: FRESH_EVIDENCE_AGE_MS, maxStaleAgeMs: MAX_STALE_EVIDENCE_AGE_MS },
  T4_CHAINS: { refreshAfterMs: FRESH_EVIDENCE_AGE_MS, maxStaleAgeMs: MAX_STALE_EVIDENCE_AGE_MS },
  CONSENSUS_SKELETON: { refreshAfterMs: FRESH_EVIDENCE_AGE_MS, maxStaleAgeMs: MAX_STALE_EVIDENCE_AGE_MS },
  WPA_FILTERED_ITEMS: { refreshAfterMs: FRESH_EVIDENCE_AGE_MS, maxStaleAgeMs: MAX_STALE_EVIDENCE_AGE_MS },
};
const PROFILE_POLICY: FreshnessPolicyV1 = {
  refreshAfterMs: FRESH_EVIDENCE_AGE_MS,
  maxStaleAgeMs: MAX_STALE_EVIDENCE_AGE_MS,
};

const DATASET_ORDER: readonly AdaptiveScoringDatasetV1[] = [
  'WPA_PATCH_DATA',
  'VS_HERO_WPA',
  'T4_CHAINS',
  'CONSENSUS_SKELETON',
  'WPA_FILTERED_ITEMS',
];

@Injectable()
export class StatlockerEvidenceService {
  constructor(
    private readonly store: StatlockerSnapshotStoreService,
    private readonly refresh: StatlockerRefreshService,
  ) {}

  getEvidence(input: StatlockerEvidenceRequestV1): StatlockerEvidenceBundleV1 {
    const bundle = this.getLocalEvidence(input);
    const nowMs = input.nowMs ?? Date.now();
    if (needsGlobalRefresh(bundle.byDataset)) {
      void this.refresh.refreshGlobalNow(false, nowMs).catch(() => undefined);
    }
    if (needsHeroRefresh(bundle.byDataset.CONSENSUS_SKELETON)) {
      this.refresh.enqueueHeroRefresh(input.heroId, nowMs);
    }
    return bundle;
  }

  getLocalEvidence(input: StatlockerEvidenceRequestV1): StatlockerEvidenceBundleV1 {
    validateRequest(input);
    const nowMs = input.nowMs ?? Date.now();
    this.refresh.observeGameIdentity({
      rulesetVersion: input.rulesetVersion,
      catalogSha256: input.catalogSha256,
    }, nowMs);
    this.refresh.observeActiveHero(input.heroId, nowMs);
    const rows = this.store.listActive();
    const byDataset = {} as Record<AdaptiveScoringDatasetV1, StatlockerEvidenceFamilyV1>;

    for (const dataset of DATASET_ORDER) {
      byDataset[dataset] = this.resolveFamily(dataset, scopeFor(dataset, input), input, rows, nowMs);
    }

    const families = DATASET_ORDER.map((dataset) => byDataset[dataset]);
    const snapshotIds = families
      .filter((family) => family.payload !== undefined && family.snapshotId !== undefined)
      .map((family) => family.snapshotId as string)
      .sort();
    const degradedReasons = families
      .filter((family) => family.freshness !== 'FRESH' && family.dataset !== 'WPA_FILTERED_ITEMS')
      .map((family) => `${family.dataset}:${family.freshness}`)
      .sort();
    const usable = families.some((family) =>
      family.dataset !== 'WPA_FILTERED_ITEMS' &&
      (family.freshness === 'FRESH' || family.freshness === 'STALE_USABLE') &&
      family.payload !== undefined,
    );

    return {
      heroId: input.heroId,
      rulesetVersion: input.rulesetVersion,
      catalogSha256: input.catalogSha256.toLowerCase(),
      statlockerPatchId: input.statlockerPatchId,
      usable,
      snapshotIds,
      degradedReasons,
      families,
      byDataset,
    };
  }

  resolveLocalPatchId(rulesetVersion: string, catalogSha256: string): string | undefined {
    if (!rulesetVersion || !/^[a-f0-9]{64}$/i.test(catalogSha256)) return undefined;
    return this.store.listActive()
      .filter((row) =>
        row.rulesetVersion === rulesetVersion &&
        row.catalogSha256.toLowerCase() === catalogSha256.toLowerCase() &&
        Boolean(row.statlockerPatchId),
      )
      .sort(compareNewest)[0]?.statlockerPatchId;
  }

  getLocalStatus(identity?: StatlockerGameIdentityV1, nowMs = Date.now()): StatlockerLocalEvidenceStatusV1 {
    const rows = this.store.listActive()
      .filter((row) => !identity || (
        row.rulesetVersion === identity.rulesetVersion &&
        row.catalogSha256.toLowerCase() === identity.catalogSha256.toLowerCase()
      ))
      .sort(compareNewest);
    const families = rows.map((row) => ({
      dataset: row.dataset,
      scopeKey: row.scopeKey,
      snapshotId: row.snapshotId,
      statlockerPatchId: row.statlockerPatchId,
      fetchedAt: row.fetchedAt.toISOString(),
      freshness: classifyFreshness(
        Math.max(0, nowMs - row.fetchedAt.getTime()),
        policyForDataset(row.dataset),
      ),
    })).sort((a, b) => a.dataset.localeCompare(b.dataset) || a.scopeKey.localeCompare(b.scopeKey) || a.snapshotId.localeCompare(b.snapshotId));
    return {
      statlockerPatchId: rows[0]?.statlockerPatchId,
      activeSnapshotIds: rows.map((row) => row.snapshotId).sort(),
      families,
    };
  }

  private resolveFamily(
    dataset: AdaptiveScoringDatasetV1,
    scopeKey: string,
    input: StatlockerEvidenceRequestV1,
    rows: readonly StatlockerStoredSnapshotV1[],
    nowMs: number,
  ): StatlockerEvidenceFamilyV1 {
    const candidates = rows
      .filter((row) => row.dataset === dataset && row.scopeKey === scopeKey)
      .filter(isSelectableSnapshot)
      .sort(compareNewest);
    const exact = candidates.find((row) =>
      row.rulesetVersion === input.rulesetVersion &&
      row.catalogSha256.toLowerCase() === input.catalogSha256.toLowerCase() &&
      row.statlockerPatchId === input.statlockerPatchId,
    );

    if (exact) return familyFromExact(dataset, exact, POLICIES[dataset], nowMs);
    if (candidates.length > 0) {
      const mismatch = candidates[0];
      return {
        dataset,
        scopeKey,
        snapshotId: mismatch.snapshotId,
        contentSha256: mismatch.contentSha256,
        fetchedAt: mismatch.fetchedAt.toISOString(),
        freshness: 'PATCH_MISMATCH',
        confidence: 0,
      };
    }

    return {
      dataset,
      scopeKey,
      freshness: 'UNAVAILABLE',
      confidence: 0,
    };
  }
}

function familyFromExact(
  dataset: AdaptiveScoringDatasetV1,
  snapshot: StatlockerStoredSnapshotV1,
  policy: FreshnessPolicyV1,
  nowMs: number,
): StatlockerEvidenceFamilyV1 {
  const ageMs = Math.max(0, nowMs - snapshot.fetchedAt.getTime());
  const freshness = classifyFreshness(ageMs, policy);
  const confidence = freshnessConfidence(ageMs, policy, freshness);
  const canUse = freshness === 'FRESH' || freshness === 'STALE_USABLE';
  return {
    dataset,
    scopeKey: snapshot.scopeKey,
    snapshotId: snapshot.snapshotId,
    contentSha256: snapshot.contentSha256,
    fetchedAt: snapshot.fetchedAt.toISOString(),
    freshness,
    confidence,
    payload: canUse ? snapshot.payload as unknown as StatlockerNormalizedPayloadV1 : undefined,
  };
}

function classifyFreshness(ageMs: number, policy: FreshnessPolicyV1): AdaptiveEvidenceFreshnessV1 {
  if (ageMs <= policy.refreshAfterMs) return 'FRESH';
  if (ageMs <= policy.maxStaleAgeMs) return 'STALE_USABLE';
  return 'UNAVAILABLE';
}

function freshnessConfidence(
  ageMs: number,
  policy: FreshnessPolicyV1,
  freshness: AdaptiveEvidenceFreshnessV1,
): number {
  if (freshness === 'FRESH') return 1;
  if (freshness !== 'STALE_USABLE') return 0;
  const width = Math.max(1, policy.maxStaleAgeMs - policy.refreshAfterMs);
  const remaining = clamp01((policy.maxStaleAgeMs - ageMs) / width);
  return 0.25 + 0.75 * remaining;
}

function policyForDataset(dataset: string): FreshnessPolicyV1 {
  if (dataset === 'WPA_PATCH_DATA' || dataset === 'VS_HERO_WPA' || dataset === 'T4_CHAINS' || dataset === 'CONSENSUS_SKELETON' || dataset === 'WPA_FILTERED_ITEMS') {
    return POLICIES[dataset];
  }
  return PROFILE_POLICY;
}

function scopeFor(dataset: AdaptiveScoringDatasetV1, input: StatlockerEvidenceRequestV1): string {
  if (dataset === 'WPA_PATCH_DATA') return `patch:${input.statlockerPatchId}`;
  if (dataset === 'VS_HERO_WPA' || dataset === 'T4_CHAINS') return 'global';
  if (dataset === 'CONSENSUS_SKELETON') return `hero:${input.heroId}:consensus`;
  return `hero:${input.heroId}`;
}

function needsGlobalRefresh(byDataset: Record<AdaptiveScoringDatasetV1, StatlockerEvidenceFamilyV1>): boolean {
  // VS_HERO_WPA is relational-only with its own daily refresh TTL; the snapshot store
  // only tracks WPA_PATCH_DATA and T4_CHAINS for global refresh triggers.
  return ['WPA_PATCH_DATA', 'T4_CHAINS'].some((dataset) =>
    needsRefresh(byDataset[dataset as AdaptiveScoringDatasetV1]),
  );
}

function needsHeroRefresh(family: StatlockerEvidenceFamilyV1): boolean {
  return needsRefresh(family);
}

function needsRefresh(family: StatlockerEvidenceFamilyV1): boolean {
  return family.freshness !== 'FRESH';
}

function compareNewest(a: StatlockerStoredSnapshotV1, b: StatlockerStoredSnapshotV1): number {
  return b.fetchedAt.getTime() - a.fetchedAt.getTime() || a.snapshotId.localeCompare(b.snapshotId);
}

function validateRequest(input: StatlockerEvidenceRequestV1): void {
  if (!Number.isInteger(input.heroId) || input.heroId <= 0) throw new Error('Invalid evidence heroId');
  if (!input.rulesetVersion || !/^[a-f0-9]{64}$/i.test(input.catalogSha256) || !input.statlockerPatchId) {
    throw new Error('Invalid evidence identity');
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}
