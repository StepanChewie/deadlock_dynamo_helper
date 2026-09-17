import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { BuildArchetypeSnapshotV2Entity } from '../deadlock-live/entities/build-archetype-snapshot-v2.entity';
import { BuildArchetypeSnapshotV2 } from './build-archetype-v2';
import { BuildArchetypeQualityGateResultV2 } from './build-archetype-quality-gate-v2.service';

export interface BuildArchetypeSnapshotIdentityV2 {
  heroId: number;
  rulesetVersion: string;
  statlockerPatchId: string;
  catalogSha256: string;
}

@Injectable()
export class BuildArchetypeSnapshotStoreV2Service {
  constructor(private readonly dataSource: DataSource) {}

  async publishValidated(
    snapshot: BuildArchetypeSnapshotV2,
    quality: BuildArchetypeQualityGateResultV2,
    publishedAt: Date = new Date(),
  ): Promise<BuildArchetypeSnapshotV2Entity> {
    assertAcceptedQuality(snapshot, quality);
    const identity = normalizeIdentity(snapshot);
    const payload = clone(snapshot) as unknown as Record<string, unknown>;
    const persistedQuality = clone(quality) as unknown as Record<string, unknown>;

    return this.dataSource.transaction(async (manager) => {
      const repository = manager.getRepository(BuildArchetypeSnapshotV2Entity);
      await repository.update(
        {
          heroId: identity.heroId,
          rulesetVersion: identity.rulesetVersion,
          statlockerPatchId: identity.statlockerPatchId,
          catalogSha256: identity.catalogSha256,
          isActive: true,
        },
        { isActive: false },
      );

      const row = repository.create({
        snapshotId: snapshot.snapshotId,
        heroId: identity.heroId,
        rulesetVersion: identity.rulesetVersion,
        statlockerPatchId: identity.statlockerPatchId,
        catalogSha256: identity.catalogSha256,
        sourceProfileCount: snapshot.sourceProfileAccountIds.length,
        isActive: true,
        payload,
        quality: persistedQuality,
        publishedAt,
      });
      return repository.save(row);
    });
  }

  /**
   * The active snapshot for this hero, plus the patch it was actually built for.
   *
   * `resolveLocalPatchId` returns the patch of the newest evidence row, which can
   * be a patch statlocker has only just rolled to and for which nothing has been
   * built yet. On 2026-09-17 the per-hero datasets moved to 698776157349216434
   * while all 145 archetype snapshots - and every WPA row - were still on
   * 676255623445218601. `getActive` then found nothing, every request answered
   * BUILD_ARCHETYPE_V2_UNAVAILABLE, and the app showed no build at all.
   *
   * The caller must use the returned patch for its WPA query as well, otherwise
   * the snapshot and the rows disagree and the matchup evidence is lost again.
   */
  async getActiveWithPatch(
    identity: BuildArchetypeSnapshotIdentityV2,
  ): Promise<{ snapshot: BuildArchetypeSnapshotV2; statlockerPatchId: string }> {
    const normalized = normalizeIdentity(identity);
    const repository = this.dataSource.getRepository(BuildArchetypeSnapshotV2Entity);
    const exact = await repository.findOne({
      where: {
        heroId: normalized.heroId,
        rulesetVersion: normalized.rulesetVersion,
        statlockerPatchId: normalized.statlockerPatchId,
        catalogSha256: normalized.catalogSha256,
        isActive: true,
      },
      order: { publishedAt: 'DESC', snapshotId: 'DESC' },
    });
    if (exact) {
      return { snapshot: parsePayload(exact), statlockerPatchId: exact.statlockerPatchId };
    }

    const newestForHero = await repository.findOne({
      where: {
        heroId: normalized.heroId,
        rulesetVersion: normalized.rulesetVersion,
        catalogSha256: normalized.catalogSha256,
        isActive: true,
      },
      order: { publishedAt: 'DESC', snapshotId: 'DESC' },
    });
    if (!newestForHero) {
      throw new Error(
        `Build archetype v2 snapshot not found for hero ${normalized.heroId} ` +
        `${normalized.rulesetVersion}/${normalized.statlockerPatchId}/${normalized.catalogSha256}`,
      );
    }
    return {
      snapshot: parsePayload(newestForHero),
      statlockerPatchId: newestForHero.statlockerPatchId,
    };
  }

  async getActive(identity: BuildArchetypeSnapshotIdentityV2): Promise<BuildArchetypeSnapshotV2> {
    const normalized = normalizeIdentity(identity);
    const repository = this.dataSource.getRepository(BuildArchetypeSnapshotV2Entity);
    const row = await repository.findOne({
      where: {
        heroId: normalized.heroId,
        rulesetVersion: normalized.rulesetVersion,
        statlockerPatchId: normalized.statlockerPatchId,
        catalogSha256: normalized.catalogSha256,
        isActive: true,
      },
      order: { publishedAt: 'DESC', snapshotId: 'DESC' },
    });
    if (!row) {
      throw new Error(
        `Build archetype v2 snapshot not found for hero ${normalized.heroId} ` +
        `${normalized.rulesetVersion}/${normalized.statlockerPatchId}/${normalized.catalogSha256}`,
      );
    }
    return parsePayload(row);
  }

  async hasActive(identity: BuildArchetypeSnapshotIdentityV2): Promise<boolean> {
    const normalized = normalizeIdentity(identity);
    const repository = this.dataSource.getRepository(BuildArchetypeSnapshotV2Entity);
    const row = await repository.findOne({
      where: {
        heroId: normalized.heroId,
        rulesetVersion: normalized.rulesetVersion,
        statlockerPatchId: normalized.statlockerPatchId,
        catalogSha256: normalized.catalogSha256,
        isActive: true,
      },
    });
    return row !== null && row !== undefined;
  }

  async getById(snapshotId: string): Promise<BuildArchetypeSnapshotV2> {
    validateSnapshotId(snapshotId);
    const repository = this.dataSource.getRepository(BuildArchetypeSnapshotV2Entity);
    const row = await repository.findOne({ where: { snapshotId } });
    if (!row) {
      throw new Error(`Build archetype v2 snapshot not found: ${snapshotId}`);
    }
    return parsePayload(row);
  }
}

function assertAcceptedQuality(
  snapshot: BuildArchetypeSnapshotV2,
  quality: BuildArchetypeQualityGateResultV2,
): void {
  if (!quality.accepted || quality.reasonCodes.length > 0 || quality.archetypes.some((entry) => !entry.accepted)) {
    throw new Error(`Build archetype v2 quality gate rejected snapshot ${snapshot.snapshotId}`);
  }
  const snapshotIds = [...snapshot.archetypes.map((entry) => entry.archetypeId)].sort();
  const qualityIds = [...quality.archetypes.map((entry) => entry.archetypeId)].sort();
  if (snapshotIds.length !== qualityIds.length || snapshotIds.some((id, index) => id !== qualityIds[index])) {
    throw new Error(`Build archetype v2 quality result does not match snapshot ${snapshot.snapshotId}`);
  }
}

function normalizeIdentity(identity: BuildArchetypeSnapshotIdentityV2): BuildArchetypeSnapshotIdentityV2 {
  if (!Number.isInteger(identity.heroId) || identity.heroId <= 0) {
    throw new Error('Build archetype v2 snapshot heroId must be a positive integer');
  }
  if (identity.rulesetVersion.trim() === '' || identity.statlockerPatchId.trim() === '') {
    throw new Error('Build archetype v2 snapshot ruleset/patch identity is incomplete');
  }
  if (!/^[a-f0-9]{64}$/i.test(identity.catalogSha256)) {
    throw new Error('Build archetype v2 snapshot catalogSha256 must be a 64-character hex digest');
  }
  return {
    heroId: identity.heroId,
    rulesetVersion: identity.rulesetVersion,
    statlockerPatchId: identity.statlockerPatchId,
    catalogSha256: identity.catalogSha256.toLowerCase(),
  };
}

function validateSnapshotId(snapshotId: string): void {
  if (snapshotId.trim() === '' || snapshotId.length > 128) {
    throw new Error('Build archetype v2 snapshotId is invalid');
  }
}

function parsePayload(row: BuildArchetypeSnapshotV2Entity): BuildArchetypeSnapshotV2 {
  const value = clone(row.payload) as unknown as BuildArchetypeSnapshotV2;
  if (
    !value ||
    value.snapshotId !== row.snapshotId ||
    value.heroId !== row.heroId ||
    value.rulesetVersion !== row.rulesetVersion ||
    value.statlockerPatchId !== row.statlockerPatchId ||
    value.catalogSha256.toLowerCase() !== row.catalogSha256.toLowerCase() ||
    !Array.isArray(value.archetypes)
  ) {
    throw new Error(`Build archetype v2 persisted payload identity mismatch: ${row.snapshotId}`);
  }
  return value;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
