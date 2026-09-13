import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import {
  CanonicalBuildSequenceService,
  CanonicalPlayerBuildSequence,
} from './canonical-build-sequence.service';
import { Hero } from './entities/hero.entity';
import { MatchPlayerItem } from './entities/match-player-item.entity';
import { MatchPlayer } from './entities/match-player.entity';
import { Match } from './entities/match.entity';
import type { HeroBuildOfflineEvaluationMatchDescriptor } from './hero-build-offline-evaluation.service';
import { InventoryTimelineReplayService } from './inventory-timeline-replay.service';
import { MatchTimelineNormalizationService } from './match-timeline-normalization.service';
import {
  RecentMatchItemSnapshot,
  RecentMatchPlayerSnapshot,
} from './recent-matches-window.service';

const DEFAULT_DATABASE_RETRY_COUNT = 5;
const DEFAULT_DATABASE_RETRY_DELAY_MS = 500;
const DATABASE_RETRY_COUNT_ENV =
  'DEADLOCK_BUILD_EVALUATION_DB_RETRY_COUNT';
const DATABASE_RETRY_DELAY_MS_ENV =
  'DEADLOCK_BUILD_EVALUATION_DB_RETRY_DELAY_MS';

export interface HeroBuildOfflineLoadedDescriptors {
  descriptors: HeroBuildOfflineEvaluationMatchDescriptor[];
  totalAvailableMatchCount: number;
  sourceLastRefreshedAt?: Date;
  sourceSnapshotCrawledAt?: Date;
}

export interface HeroBuildOfflineLoadedHeroSample {
  descriptor: HeroBuildOfflineEvaluationMatchDescriptor;
  player: RecentMatchPlayerSnapshot;
  sequence: CanonicalPlayerBuildSequence;
  enemyHeroIds: number[];
}

export interface HeroBuildOfflineLoadedHeroBatch {
  sourcePlayerCount: number;
  samples: HeroBuildOfflineLoadedHeroSample[];
}

@Injectable()
export class HeroBuildOfflineEvaluationDataLoaderService {
  private readonly logger = new Logger(
    HeroBuildOfflineEvaluationDataLoaderService.name,
  );
  private readonly databaseRetryCount =
    readBoundedIntegerEnvironmentValue(
      DATABASE_RETRY_COUNT_ENV,
      DEFAULT_DATABASE_RETRY_COUNT,
      0,
      20,
    );
  private readonly databaseRetryDelayMs =
    readBoundedIntegerEnvironmentValue(
      DATABASE_RETRY_DELAY_MS_ENV,
      DEFAULT_DATABASE_RETRY_DELAY_MS,
      50,
      10_000,
    );

  constructor(
    @InjectRepository(Match)
    private readonly matchRepository: Repository<Match>,
    @InjectRepository(MatchPlayer)
    private readonly matchPlayerRepository: Repository<MatchPlayer>,
    @InjectRepository(MatchPlayerItem)
    private readonly matchPlayerItemRepository: Repository<MatchPlayerItem>,
    @InjectRepository(Hero)
    private readonly heroRepository: Repository<Hero>,
    private readonly matchTimelineNormalizationService:
      MatchTimelineNormalizationService,
    private readonly inventoryTimelineReplayService:
      InventoryTimelineReplayService,
    private readonly canonicalBuildSequenceService:
      CanonicalBuildSequenceService,
  ) {}

  async loadMatchDescriptors(
    maxMatches?: number,
  ): Promise<HeroBuildOfflineLoadedDescriptors> {
    const [matches, totalAvailableMatchCount] = await this.withDatabaseRetry(
      'loading immutable match descriptor snapshot',
      () =>
        Promise.all([
          this.matchRepository.find({
            order: { startTime: 'DESC', matchId: 'DESC' },
            ...(maxMatches === undefined ? {} : { take: maxMatches }),
          }),
          this.matchRepository.count(),
        ]),
    );
    const descriptors = matches
      .map((match) => ({
        matchId: Number(match.matchId),
        startTime: new Date(match.startTime),
      }))
      .filter(
        (descriptor) =>
          Number.isSafeInteger(descriptor.matchId) &&
          descriptor.matchId > 0 &&
          Number.isFinite(descriptor.startTime.getTime()),
      );
    const refreshedTimes = matches
      .map((match) => match.crawledAt?.getTime())
      .filter((value): value is number => Number.isFinite(value));

    const sourceSnapshotCrawledAt =
      refreshedTimes.length > 0
        ? new Date(Math.max(...refreshedTimes))
        : undefined;
    return {
      descriptors,
      totalAvailableMatchCount,
      sourceLastRefreshedAt: sourceSnapshotCrawledAt,
      sourceSnapshotCrawledAt,
    };
  }

  async collectHeroIds(
    _descriptors: readonly HeroBuildOfflineEvaluationMatchDescriptor[],
    _batchSize: number,
  ): Promise<number[]> {
    const heroes = await this.withDatabaseRetry(
      'loading the evaluation hero catalog',
      () => this.heroRepository.find({ order: { heroId: 'ASC' } }),
    );
    return [
      ...new Set(
        heroes
          .map((hero) => Number(hero.heroId))
          .filter(
            (heroId) => Number.isSafeInteger(heroId) && heroId > 0,
          ),
      ),
    ].sort((left, right) => left - right);
  }

  async loadHeroBatch(
    heroId: number,
    descriptors: readonly HeroBuildOfflineEvaluationMatchDescriptor[],
    batchSize: number,
    context: string,
  ): Promise<HeroBuildOfflineLoadedHeroBatch> {
    if (descriptors.length === 0) {
      return { sourcePlayerCount: 0, samples: [] };
    }

    const descriptorByMatchId = new Map(
      descriptors.map((descriptor) => [
        descriptor.matchId,
        descriptor,
      ]),
    );
    const matchIds = descriptors.map(
      (descriptor) => descriptor.matchId,
    );
    const requestedPlayers = await this.withDatabaseRetry(
      `${context}: loading requested players`,
      () =>
        this.matchPlayerRepository.find({
          where: { matchId: In(matchIds), heroId },
        }),
    );
    if (requestedPlayers.length === 0) {
      return { sourcePlayerCount: 0, samples: [] };
    }

    const relevantMatchIds = [
      ...new Set(
        requestedPlayers.map((player) => Number(player.matchId)),
      ),
    ];
    const roster = await this.withDatabaseRetry(
      `${context}: loading rosters`,
      () =>
        this.matchPlayerRepository.find({
          where: { matchId: In(relevantMatchIds) },
        }),
    );
    const rosterByMatchId = groupBy(
      roster,
      (player) => Number(player.matchId),
    );
    const itemRows: MatchPlayerItem[] = [];
    for (const [itemBatchIndex, playerIdBatch] of chunkValues(
      requestedPlayers.map((player) => Number(player.id)),
      batchSize * 4,
    ).entries()) {
      itemRows.push(
        ...(await this.withDatabaseRetry(
          `${context}: loading item rows, batch ${itemBatchIndex + 1}`,
          () =>
            this.matchPlayerItemRepository.find({
              where: { matchPlayerId: In(playerIdBatch) },
            }),
        )),
      );
    }
    const itemsByPlayerId = groupBy(
      itemRows,
      (item) => Number(item.matchPlayerId),
    );

    const samples: HeroBuildOfflineLoadedHeroSample[] = [];
    for (const player of requestedPlayers) {
      const matchId = Number(player.matchId);
      const descriptor = descriptorByMatchId.get(matchId);
      if (!descriptor) {
        continue;
      }
      const snapshot = toRecentMatchPlayerSnapshot(
        player,
        itemsByPlayerId.get(Number(player.id)) ?? [],
      );
      const timeline =
        this.matchTimelineNormalizationService.normalizePlayer(
          snapshot,
        );
      const replay =
        this.inventoryTimelineReplayService.replayPlayer(timeline);
      const sequence =
        this.canonicalBuildSequenceService.canonicalizePlayer(replay);
      const enemyHeroIds = normalizeHeroIds(
        (rosterByMatchId.get(matchId) ?? [])
          .filter(
            (candidate) =>
              Number(candidate.team) !== snapshot.team,
          )
          .map((candidate) => Number(candidate.heroId)),
      );
      samples.push({
        descriptor,
        player: snapshot,
        sequence,
        enemyHeroIds,
      });
    }

    return {
      sourcePlayerCount: requestedPlayers.length,
      samples,
    };
  }

  getRetrySettings(): {
    retryCount: number;
    retryDelayMs: number;
  } {
    return {
      retryCount: this.databaseRetryCount,
      retryDelayMs: this.databaseRetryDelayMs,
    };
  }

  async withDatabaseRetry<T>(
    context: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        if (
          attempt >= this.databaseRetryCount ||
          !isTransientDatabaseError(error)
        ) {
          throw error;
        }
        const delayMs = Math.min(
          this.databaseRetryDelayMs * 2 ** attempt,
          10_000,
        );
        this.logger.warn(
          `Transient PostgreSQL failure while ${context}; retry ` +
            `${attempt + 1}/${this.databaseRetryCount} in ${delayMs} ms: ` +
            getErrorMessage(error),
        );
        await delay(delayMs);
      }
    }
  }
}

export function chunkValues<T>(
  values: readonly T[],
  size: number,
): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

export function isEvaluableBuildSequence(
  sequence: CanonicalPlayerBuildSequence,
): boolean {
  return (
    Number.isSafeInteger(sequence.heroId) &&
    sequence.heroId > 0 &&
    sequence.replayDiagnosticCount === 0 &&
    sequence.steps.length > 0
  );
}

function toRecentMatchPlayerSnapshot(
  player: MatchPlayer,
  items: readonly MatchPlayerItem[],
): RecentMatchPlayerSnapshot {
  return {
    id: Number(player.id),
    matchId: Number(player.matchId),
    heroId: Number(player.heroId),
    team: toFiniteNumber(player.team),
    won: Boolean(player.won),
    kills: toFiniteNumber(player.kills),
    deaths: toFiniteNumber(player.deaths),
    assists: toFiniteNumber(player.assists),
    netWorth: toFiniteNumber(player.netWorth),
    itemPurchases: items.map(toRecentMatchItemSnapshot),
    skillUpgrades: [],
  };
}

function toRecentMatchItemSnapshot(
  item: MatchPlayerItem,
): RecentMatchItemSnapshot {
  return {
    id: Number(item.id),
    itemId: Number(item.itemId),
    purchaseTimeS: toOptionalFiniteNumber(item.purchaseTimeS),
    soldTimeS: toOptionalFiniteNumber(item.soldTimeS),
    upgradeId: toOptionalFiniteNumber(item.upgradeId),
    flags: toOptionalFiniteNumber(item.flags),
    imbuedAbilityId: toOptionalFiniteNumber(item.imbuedAbilityId),
    upgradeInfo: toOptionalFiniteNumber(item.upgradeInfo),
    slotOrder: toOptionalFiniteNumber(item.slotOrder),
  };
}

function groupBy<T, K>(
  values: readonly T[],
  keyOf: (value: T) => K,
): Map<K, T[]> {
  const groups = new Map<K, T[]>();
  for (const value of values) {
    const key = keyOf(value);
    const group = groups.get(key) ?? [];
    group.push(value);
    groups.set(key, group);
  }
  return groups;
}

function normalizeHeroIds(heroIds: readonly number[]): number[] {
  return [
    ...new Set(
      heroIds.filter(
        (heroId) => Number.isSafeInteger(heroId) && heroId > 0,
      ),
    ),
  ].sort((left, right) => left - right);
}

function toFiniteNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toOptionalFiniteNumber(
  value: unknown,
): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readBoundedIntegerEnvironmentValue(
  name: string,
  defaultValue: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number(process.env[name]);
  return Number.isSafeInteger(parsed) &&
    parsed >= minimum &&
    parsed <= maximum
    ? parsed
    : defaultValue;
}

function isTransientDatabaseError(error: unknown): boolean {
  const message = getErrorMessage(error).toLowerCase();
  const code = getErrorCode(error)?.toUpperCase();
  return (
    code === 'ECONNRESET' ||
    code === 'ECONNREFUSED' ||
    code === 'EPIPE' ||
    code === 'ETIMEDOUT' ||
    code === '57P01' ||
    code === '57P02' ||
    code === '57P03' ||
    code === '08000' ||
    code === '08003' ||
    code === '08006' ||
    code === '08001' ||
    code === '08004' ||
    message.includes('connection terminated unexpectedly') ||
    message.includes('connection reset') ||
    message.includes('connection refused') ||
    message.includes('client has already been released') ||
    message.includes('terminating connection') ||
    message.includes('socket hang up')
  );
}

function getErrorCode(error: unknown): string | undefined {
  if (
    typeof error !== 'object' ||
    error === null ||
    !('code' in error)
  ) {
    return undefined;
  }
  const value = (error as { code?: unknown }).code;
  return typeof value === 'string' ? value : undefined;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
