import { createHash } from 'crypto';
import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { StatlockerEvidenceSnapshotV1Entity } from '../deadlock-live/entities/statlocker-evidence-snapshot-v1.entity';
import { StatlockerDatasetV1 } from './statlocker-adaptive.types';

export interface StatlockerSnapshotIdentityV1 {
  dataset: StatlockerDatasetV1;
  rulesetVersion: string;
  catalogSha256: string;
  statlockerPatchId: string;
  scopeKey: string;
  contentSha256: string;
}

export interface StatlockerSnapshotLookupV1 {
  dataset: StatlockerDatasetV1;
  rulesetVersion: string;
  catalogSha256: string;
  statlockerPatchId: string;
  scopeKey: string;
}

export interface StatlockerSnapshotPublishInputV1 extends StatlockerSnapshotIdentityV1 {
  fetchedAt: Date;
  schemaVersion: string;
  collectorVersion: string;
  normalizerVersion: string;
  payload: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export type StatlockerStoredSnapshotV1 = StatlockerEvidenceSnapshotV1Entity;

export const CONSENSUS_SKELETON_SCHEMA_VERSION = 'statlocker-consensus-skeleton-v2';
export const CONSENSUS_SKELETON_NORMALIZER_VERSION = 'consensus-builder-v2';

type ValidatedStoredSnapshotV1 = StatlockerStoredSnapshotV1 & {
  dataset: StatlockerDatasetV1;
};

const STATLOCKER_DATASETS_V1 = new Set<StatlockerDatasetV1>([
  'WPA_PATCH_DATA',
  'VS_HERO_WPA',
  'T4_CHAINS',
  'HERO_LEADERBOARD',
  'PRO_BUILD_ANALYSIS',
  'WPA_FILTERED_ITEMS',
  'CONSENSUS_SKELETON',
]);

@Injectable()
export class StatlockerSnapshotStoreService implements OnModuleInit {
  private readonly active = new Map<string, StatlockerStoredSnapshotV1>();

  constructor(
    @InjectRepository(StatlockerEvidenceSnapshotV1Entity)
    private readonly repository: Repository<StatlockerEvidenceSnapshotV1Entity>,
  ) {}

  async onModuleInit(): Promise<void> {
    const rows = await this.repository.find({
      order: { fetchedAt: 'DESC', snapshotId: 'DESC' },
    });
    for (const row of rows) {
      if (!isValidStoredSnapshot(row) || !isSelectableSnapshot(row)) continue;
      const key = lookupKey(row);
      if (!this.active.has(key)) this.active.set(key, row);
    }
  }

  async publish(input: StatlockerSnapshotPublishInputV1): Promise<StatlockerStoredSnapshotV1> {
    validatePublishInput(input);
    if (input.dataset === 'VS_HERO_WPA') {
      throw new Error('VS_HERO_WPA is relational-only and cannot be published to the legacy snapshot store');
    }

    const key = lookupKey(input);
    const current = this.active.get(key);
    if (current?.contentSha256 === input.contentSha256) {
      if (input.fetchedAt.getTime() <= current.fetchedAt.getTime()) return current;
      const refreshed = await this.repository.save({
        ...current,
        fetchedAt: input.fetchedAt,
        metadata: input.metadata ?? current.metadata,
      });
      this.active.set(key, refreshed);
      return refreshed;
    }

    const snapshotId = computeSnapshotId(input);
    let persisted = await this.repository.findOne({ where: { snapshotId } });
    if (!persisted) {
      const entity = this.repository.create({
        snapshotId,
        dataset: input.dataset,
        rulesetVersion: input.rulesetVersion,
        catalogSha256: input.catalogSha256.toLowerCase(),
        statlockerPatchId: input.statlockerPatchId,
        scopeKey: input.scopeKey,
        fetchedAt: input.fetchedAt,
        schemaVersion: input.schemaVersion,
        collectorVersion: input.collectorVersion,
        normalizerVersion: input.normalizerVersion,
        contentSha256: input.contentSha256.toLowerCase(),
        payload: input.payload,
        metadata: input.metadata ?? {},
      });
      persisted = await this.repository.save(entity);
    }

    if (isSelectableSnapshot(persisted)) this.active.set(key, persisted);
    return persisted;
  }

  getActive(input: StatlockerSnapshotLookupV1): StatlockerStoredSnapshotV1 | undefined {
    return this.active.get(lookupKey(input));
  }

  getActiveForScope(dataset: StatlockerDatasetV1, scopeKey: string): readonly StatlockerStoredSnapshotV1[] {
    return [...this.active.values()]
      .filter((row) => row.dataset === dataset && row.scopeKey === scopeKey)
      .sort((a, b) => b.fetchedAt.getTime() - a.fetchedAt.getTime() || a.snapshotId.localeCompare(b.snapshotId));
  }

  listActive(): readonly StatlockerStoredSnapshotV1[] {
    return [...this.active.values()].sort((a, b) =>
      a.dataset.localeCompare(b.dataset) ||
      a.scopeKey.localeCompare(b.scopeKey) ||
      a.snapshotId.localeCompare(b.snapshotId));
  }
}

function lookupKey(input: StatlockerSnapshotLookupV1): string {
  return [
    input.dataset,
    input.rulesetVersion,
    input.catalogSha256.toLowerCase(),
    input.statlockerPatchId,
    input.scopeKey,
  ].join('|');
}

function computeSnapshotId(input: StatlockerSnapshotIdentityV1): string {
  const hash = createHash('sha256').update([
    input.dataset,
    input.rulesetVersion,
    input.catalogSha256.toLowerCase(),
    input.statlockerPatchId,
    input.scopeKey,
    input.contentSha256.toLowerCase(),
  ].join('|')).digest('hex');
  return `slv1-${hash}`;
}

function validatePublishInput(input: StatlockerSnapshotPublishInputV1): void {
  if (!input.dataset || !input.rulesetVersion || !input.statlockerPatchId || !input.scopeKey) {
    throw new Error('Statlocker snapshot identity is incomplete');
  }
  if (!isSha(input.catalogSha256) || !isSha(input.contentSha256)) {
    throw new Error('Statlocker snapshot SHA-256 identity is invalid');
  }
  if (!(input.fetchedAt instanceof Date) || !Number.isFinite(input.fetchedAt.getTime())) {
    throw new Error('Statlocker snapshot fetchedAt is invalid');
  }
  if (!input.schemaVersion || !input.collectorVersion || !input.normalizerVersion) {
    throw new Error('Statlocker snapshot version lineage is incomplete');
  }
}

function isValidStoredSnapshot(row: StatlockerStoredSnapshotV1): row is ValidatedStoredSnapshotV1 {
  return Boolean(
    row.snapshotId &&
    isStatlockerDatasetV1(row.dataset) &&
    row.rulesetVersion &&
    isSha(row.catalogSha256) &&
    row.statlockerPatchId &&
    row.scopeKey &&
    row.fetchedAt instanceof Date &&
    Number.isFinite(row.fetchedAt.getTime()) &&
    isSha(row.contentSha256) &&
    row.payload && typeof row.payload === 'object',
  );
}

export function isSelectableSnapshot(snapshot: Pick<
  StatlockerStoredSnapshotV1,
  'dataset' | 'schemaVersion' | 'normalizerVersion' | 'payload'
>): boolean {
  if (snapshot.dataset === 'VS_HERO_WPA') return false;
  if (snapshot.dataset !== 'CONSENSUS_SKELETON') return true;
  return snapshot.schemaVersion === CONSENSUS_SKELETON_SCHEMA_VERSION &&
    snapshot.normalizerVersion === CONSENSUS_SKELETON_NORMALIZER_VERSION &&
    isRecord(snapshot.payload) &&
    Array.isArray(snapshot.payload.groups);
}

function isStatlockerDatasetV1(value: string): value is StatlockerDatasetV1 {
  return STATLOCKER_DATASETS_V1.has(value as StatlockerDatasetV1);
}

function isSha(value: string): boolean {
  return /^[a-f0-9]{64}$/i.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
