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
    const existing = await this.repository.findOne({ where: { contentSha256 } });
    if (existing) return existing;

    const row = this.repository.create({
      snapshotId: contentSha256,
      contentSha256,
      fetchedAt: input.fetchedAt instanceof Date ? input.fetchedAt : new Date(input.fetchedAt),
      sourcePath: input.sourcePath,
      sourceStatus: input.sourceStatus,
      statlockerPatchId: input.statlockerPatchId,
      rulesetVersion: input.rulesetVersion,
      catalogSha256: input.catalogSha256.toLowerCase(),
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
