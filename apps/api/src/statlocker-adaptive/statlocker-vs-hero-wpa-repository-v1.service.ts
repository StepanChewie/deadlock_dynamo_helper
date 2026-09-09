import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { StatlockerVsHeroWpaRowV1Entity } from '../deadlock-live/entities/statlocker-vs-hero-wpa-row-v1.entity';

export interface FindStatlockerVsHeroWpaRowsForSnapshotV1Input {
  snapshotId: string;
  statlockerPatchId: string;
  rulesetVersion: string;
  catalogSha256: string;
  ourHeroId: number;
  enemyHeroIds: readonly number[];
}

@Injectable()
export class StatlockerVsHeroWpaRepositoryV1Service {
  constructor(
    @InjectRepository(StatlockerVsHeroWpaRowV1Entity)
    private readonly repository: Repository<StatlockerVsHeroWpaRowV1Entity>,
  ) {}

  async findForSnapshot(
    input: FindStatlockerVsHeroWpaRowsForSnapshotV1Input,
  ): Promise<StatlockerVsHeroWpaRowV1Entity[]> {
    const enemyHeroIds = [...new Set(input.enemyHeroIds)].sort((a, b) => a - b);
    if (enemyHeroIds.length === 0) return [];

    const identity = {
      snapshotId: input.snapshotId,
      statlockerPatchId: input.statlockerPatchId,
      rulesetVersion: input.rulesetVersion,
      catalogSha256: input.catalogSha256.toLowerCase(),
      heroId: input.ourHeroId,
    };

    return this.repository.find({
      where: enemyHeroIds.map((enemyHeroId) => ({
        ...identity,
        enemyHeroId,
      })),
      order: {
        itemId: 'ASC',
        enemyHeroId: 'ASC',
        rankBucket: 'ASC',
      },
    });
  }
}
