import { createHash } from 'crypto';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { StatlockerVsHeroWpaRawSnapshotV1Entity } from '../deadlock-live/entities/statlocker-vs-hero-wpa-raw-snapshot-v1.entity';
import { stableJson } from './statlocker-normalizer.service';

export interface PersistStatlockerVsHeroWpaRawSnapshotV1Input {
  fetchedAt: Date | string;
  sourcePath: string;
  sourceStatus: number;
  statlockerPatchId: string;
  rulesetVersion: string;
  catalogSha256: string;
  collectorVersion: string;
  rawPayload: unknown;
}

@Injectable()
export class StatlockerVsHeroWpaRawStoreV1Service {
  constructor(
    @InjectRepository(StatlockerVsHeroWpaRawSnapshotV1Entity)
    private readonly repository: Repository<StatlockerVsHeroWpaRawSnapshotV1Entity>,
  ) {}

  contentSha256(rawPayload: unknown): string {
    return createHash('sha256').update(stableJson(rawPayload)).digest('hex');
  }

  async persist(
    input: PersistStatlockerVsHeroWpaRawSnapshotV1Input,
  ): Promise<StatlockerVsHeroWpaRawSnapshotV1Entity> {
    const contentSha256 = this.contentSha256(input.rawPayload);
    const catalogSha256 = input.catalogSha256.toLowerCase();
    const existing = await this.repository.findOne({ where: { contentSha256 } });
    if (existing) {
      // Identical upstream payload - but the identity it was ingested under may
      // no longer be the current one, and the relational rows carry that
      // identity. `AdaptiveRecommendationV2Service.queryWpa` filters rows by
      // (patch, rulesetVersion, catalogSha256), so rows stamped with a superseded
      // catalog are invisible and the recommendation silently loses its matchup
      // evidence: on 2026-09-17 all 173 496 rows were still stamped
      // client-6686 / 052d9e97 while the live identity was client-6694 /
      // f5226f2e, so every query returned zero rows and the archetype fell back
      // to OFFLINE_DEFAULT.
      //
      // The catalog moved on while the WPA payload did not change, which is the
      // normal case - statlocker aggregates per patch, not per item catalog. So
      // the snapshot is re-stamped to the current identity and put back to
      // PENDING, which is what makes the caller re-ingest the rows.
      const identityChanged =
        existing.statlockerPatchId !== input.statlockerPatchId ||
        existing.rulesetVersion !== input.rulesetVersion ||
        existing.catalogSha256.toLowerCase() !== catalogSha256;
      if (!identityChanged) return existing;

      const fetchedAt = input.fetchedAt instanceof Date ? input.fetchedAt : new Date(input.fetchedAt);
      await this.repository.update(
        { snapshotId: existing.snapshotId },
        {
          fetchedAt,
          sourcePath: input.sourcePath,
          sourceStatus: input.sourceStatus,
          statlockerPatchId: input.statlockerPatchId,
          rulesetVersion: input.rulesetVersion,
          catalogSha256,
          collectorVersion: input.collectorVersion,
          ingestStatus: 'PENDING',
          ingestMetadata: {},
        },
      );

      return {
        ...existing,
        fetchedAt,
        sourcePath: input.sourcePath,
        sourceStatus: input.sourceStatus,
        statlockerPatchId: input.statlockerPatchId,
        rulesetVersion: input.rulesetVersion,
        catalogSha256,
        collectorVersion: input.collectorVersion,
        ingestStatus: 'PENDING',
        ingestMetadata: {},
      };
    }

    const row = this.repository.create({
      snapshotId: contentSha256,
      contentSha256,
      fetchedAt: input.fetchedAt instanceof Date ? input.fetchedAt : new Date(input.fetchedAt),
      sourcePath: input.sourcePath,
      sourceStatus: input.sourceStatus,
      statlockerPatchId: input.statlockerPatchId,
      rulesetVersion: input.rulesetVersion,
      catalogSha256,
      collectorVersion: input.collectorVersion,
      rawPayload: input.rawPayload,
      ingestStatus: 'PENDING',
      ingestMetadata: {},
    });
    await this.repository.insert({
      ...row,
      rawPayload: row.rawPayload as object,
      ingestMetadata: row.ingestMetadata as object,
    });
    return row;
  }

  async persistCollected(
    input: PersistStatlockerVsHeroWpaRawSnapshotV1Input,
  ): Promise<StatlockerVsHeroWpaRawSnapshotV1Entity> {
    return this.persist(input);
  }
}
