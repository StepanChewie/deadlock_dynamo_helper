import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { StatlockerVsHeroWpaRawSnapshotV1Entity } from '../deadlock-live/entities/statlocker-vs-hero-wpa-raw-snapshot-v1.entity';
import { StatlockerVsHeroWpaRowV1Entity } from '../deadlock-live/entities/statlocker-vs-hero-wpa-row-v1.entity';
import { NormalizedStatlockerVsHeroWpaRowV1 } from './statlocker-vs-hero-wpa-row-normalizer-v1.service';

export interface PublishStatlockerVsHeroWpaRowsV1Input {
  snapshotId: string;
  rows: readonly NormalizedStatlockerVsHeroWpaRowV1[];
}

@Injectable()
export class StatlockerVsHeroWpaPublisherV1Service {
  constructor(private readonly dataSource: DataSource) {}

  async publish(input: PublishStatlockerVsHeroWpaRowsV1Input): Promise<void> {
    try {
      if (input.rows.length === 0) {
        throw new Error('VS_HERO_WPA relational rowset must not be empty');
      }

      await this.dataSource.transaction(async (manager) => {
        const rawRepository = manager.getRepository(StatlockerVsHeroWpaRawSnapshotV1Entity);
        const rowRepository = manager.getRepository(StatlockerVsHeroWpaRowV1Entity);
        const snapshot = await rawRepository.findOne({ where: { snapshotId: input.snapshotId } });
        if (!snapshot) throw new Error(`VS_HERO_WPA RAW snapshot ${input.snapshotId} not found`);
        if (snapshot.ingestStatus === 'PUBLISHED') return;

        const previous = await rawRepository.findOne({
          where: {
            statlockerPatchId: snapshot.statlockerPatchId,
            rulesetVersion: snapshot.rulesetVersion,
            catalogSha256: snapshot.catalogSha256.toLowerCase(),
            ingestStatus: 'PUBLISHED',
          },
          order: { fetchedAt: 'DESC' },
        });

        // Rows are unique per (snapshotId, rankBucket, heroId, enemyHeroId,
        // itemId) and the snapshot id is the content hash, so re-ingesting an
        // unchanged payload under a new catalog identity collides with the rows
        // already stored for it. Replacing them is also what re-stamps the rows
        // to the current identity, which is the whole point of the re-ingest:
        // without it the ingest fails and the rows stay invisible to queryWpa.
        await rowRepository.delete({ snapshotId: snapshot.snapshotId });

        const ROW_BATCH_SIZE = 1_000;
        for (let index = 0; index < input.rows.length; index += ROW_BATCH_SIZE) {
          const batch = input.rows.slice(index, index + ROW_BATCH_SIZE);
          await rowRepository.insert([...batch]);
        }

        if (previous && previous.snapshotId !== snapshot.snapshotId) {
          await rawRepository.update(
            { snapshotId: previous.snapshotId },
            {
              ingestStatus: 'SUPERSEDED',
              ingestMetadata: {
                ...previous.ingestMetadata,
                supersededBySnapshotId: snapshot.snapshotId,
              },
            },
          );
        }

        await rawRepository.update(
          { snapshotId: snapshot.snapshotId },
          {
            ingestStatus: 'PUBLISHED',
            ingestMetadata: {
              ...snapshot.ingestMetadata,
              rowCount: input.rows.length,
              previousSnapshotId: previous?.snapshotId,
              publishedAt: new Date().toISOString(),
            },
          },
        );
      });
    } catch (error) {
      await this.markFailed(input.snapshotId, error);
      throw error;
    }
  }

  async markFailed(snapshotId: string, error: unknown): Promise<void> {
    const repository = this.dataSource.getRepository(StatlockerVsHeroWpaRawSnapshotV1Entity);
    const snapshot = await repository.findOne({ where: { snapshotId } });
    if (!snapshot || snapshot.ingestStatus === 'PUBLISHED') return;

    await repository.update(
      { snapshotId },
      {
        ingestStatus: 'FAILED',
        ingestMetadata: {
          ...snapshot.ingestMetadata,
          error: describeError(error),
          failedAt: new Date().toISOString(),
        },
      },
    );
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
