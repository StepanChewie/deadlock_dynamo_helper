import { Injectable, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { StatlockerVsHeroWpaRawSnapshotV1Entity } from '../deadlock-live/entities/statlocker-vs-hero-wpa-raw-snapshot-v1.entity';
import { StatlockerVsHeroWpaRowV1Entity } from '../deadlock-live/entities/statlocker-vs-hero-wpa-row-v1.entity';
import { AdaptiveRecommendationObservabilityV1Service } from './adaptive-recommendation-observability-v1.service';

export interface FindStatlockerVsHeroWpaRowsForSnapshotV1Input {
  snapshotId: string;
  statlockerPatchId: string;
  rulesetVersion: string;
  catalogSha256: string;
  ourHeroId: number;
  enemyHeroIds: readonly number[];
}

export interface FindActiveStatlockerVsHeroWpaRowsV1Input {
  statlockerPatchId: string;
  rulesetVersion: string;
  catalogSha256: string;
  ourHeroId: number;
  enemyHeroIds: readonly number[];
}

export interface StatlockerVsHeroWpaAggregateSourceV1 {
  heroId: number;
  enemyHeroId: number;
  itemId: number;
  count: number;
  deltaWpa: number;
  meanWpa?: number;
}

export interface StatlockerVsHeroWpaAggregateV1 {
  heroId: number;
  enemyHeroId: number;
  itemId: number;
  count: number;
  deltaWpa: number;
  meanWpa?: number;
}

@Injectable()
export class StatlockerVsHeroWpaRepositoryV1Service {
  constructor(
    @InjectRepository(StatlockerVsHeroWpaRowV1Entity)
    private readonly repository: Repository<StatlockerVsHeroWpaRowV1Entity>,
    @Optional()
    @InjectRepository(StatlockerVsHeroWpaRawSnapshotV1Entity)
    private readonly rawRepository?: Repository<StatlockerVsHeroWpaRawSnapshotV1Entity>,
    @Optional()
    private readonly observability?: AdaptiveRecommendationObservabilityV1Service,
  ) {}

  async findActive(
    input: FindActiveStatlockerVsHeroWpaRowsV1Input,
  ): Promise<StatlockerVsHeroWpaRowV1Entity[]> {
    const enemyHeroIds = normalizeEnemyHeroIds(input.enemyHeroIds);
    if (enemyHeroIds.length === 0 || !this.rawRepository) return [];

    const startedAt = Date.now();
    try {
      const active = await this.rawRepository.findOne({
        where: {
          statlockerPatchId: input.statlockerPatchId,
          rulesetVersion: input.rulesetVersion,
          catalogSha256: input.catalogSha256.toLowerCase(),
          ingestStatus: 'PUBLISHED',
        },
        order: { fetchedAt: 'DESC' },
      });
      if (!active) return [];

      return this.findForSnapshotQuery({
        snapshotId: active.snapshotId,
        statlockerPatchId: input.statlockerPatchId,
        rulesetVersion: input.rulesetVersion,
        catalogSha256: input.catalogSha256,
        ourHeroId: input.ourHeroId,
        enemyHeroIds,
      });
    } finally {
      this.observability?.recordWpaQueryLatency(Date.now() - startedAt);
    }
  }

  async findForSnapshot(
    input: FindStatlockerVsHeroWpaRowsForSnapshotV1Input,
  ): Promise<StatlockerVsHeroWpaRowV1Entity[]> {
    const enemyHeroIds = normalizeEnemyHeroIds(input.enemyHeroIds);
    if (enemyHeroIds.length === 0) return [];

    const startedAt = Date.now();
    try {
      return await this.findForSnapshotQuery({ ...input, enemyHeroIds });
    } finally {
      this.observability?.recordWpaQueryLatency(Date.now() - startedAt);
    }
  }

  private async findForSnapshotQuery(
    input: FindStatlockerVsHeroWpaRowsForSnapshotV1Input,
  ): Promise<StatlockerVsHeroWpaRowV1Entity[]> {
    const identity = {
      snapshotId: input.snapshotId,
      statlockerPatchId: input.statlockerPatchId,
      rulesetVersion: input.rulesetVersion,
      catalogSha256: input.catalogSha256.toLowerCase(),
      heroId: input.ourHeroId,
    };

    return this.repository.find({
      where: input.enemyHeroIds.map((enemyHeroId) => ({
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

export function aggregateStatlockerVsHeroWpaRowsV1(
  rows: readonly StatlockerVsHeroWpaAggregateSourceV1[],
): StatlockerVsHeroWpaAggregateV1[] {
  const aggregates = new Map<string, {
    heroId: number;
    enemyHeroId: number;
    itemId: number;
    count: number;
    weightedDeltaWpa: number;
    meanCount: number;
    weightedMeanWpa: number;
  }>();

  for (const row of rows) {
    if (!Number.isFinite(row.count) || row.count <= 0 || !Number.isFinite(row.deltaWpa)) continue;
    const key = `${row.heroId}:${row.enemyHeroId}:${row.itemId}`;
    const aggregate = aggregates.get(key) ?? {
      heroId: row.heroId,
      enemyHeroId: row.enemyHeroId,
      itemId: row.itemId,
      count: 0,
      weightedDeltaWpa: 0,
      meanCount: 0,
      weightedMeanWpa: 0,
    };
    aggregate.count += row.count;
    aggregate.weightedDeltaWpa += row.deltaWpa * row.count;
    if (row.meanWpa !== undefined && Number.isFinite(row.meanWpa)) {
      aggregate.meanCount += row.count;
      aggregate.weightedMeanWpa += row.meanWpa * row.count;
    }
    aggregates.set(key, aggregate);
  }

  return [...aggregates.values()]
    .map((aggregate) => ({
      heroId: aggregate.heroId,
      enemyHeroId: aggregate.enemyHeroId,
      itemId: aggregate.itemId,
      count: aggregate.count,
      deltaWpa: aggregate.weightedDeltaWpa / aggregate.count,
      ...(aggregate.meanCount > 0
        ? { meanWpa: aggregate.weightedMeanWpa / aggregate.meanCount }
        : {}),
    }))
    .sort((a, b) =>
      a.heroId - b.heroId ||
      a.enemyHeroId - b.enemyHeroId ||
      a.itemId - b.itemId,
    );
}

function normalizeEnemyHeroIds(enemyHeroIds: readonly number[]): number[] {
  return [...new Set(enemyHeroIds)].sort((a, b) => a - b);
}
