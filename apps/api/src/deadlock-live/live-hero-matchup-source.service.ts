import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Match } from './entities/match.entity';
import { MatchPlayer } from './entities/match-player.entity';
import { MatchPlayerItem } from './entities/match-player-item.entity';
import { canonicalHeroId, resolveValveHeroIdFromGep } from './hero-id-aliases';
import {
  chunkValues,
  getRecentMatchCutoff,
  RECENT_MATCH_QUERY_BATCH_SIZE,
  RECENT_MATCH_TARGET_COUNT,
  RecentMatchItemSnapshot,
  RecentMatchPlayerSnapshot,
  RecentMatchSnapshot,
} from './recent-matches-window.service';

const LIVE_HERO_MATCHUP_SOURCE_TTL_MS = 5 * 60_000;

interface LiveHeroMatchupSourceCache {
  matches: RecentMatchSnapshot[];
  builtAt: Date;
}

@Injectable()
export class LiveHeroMatchupSourceService {
  private readonly logger = new Logger(LiveHeroMatchupSourceService.name);
  private readonly cacheByCanonicalHeroId = new Map<number, LiveHeroMatchupSourceCache>();
  private readonly refreshPromisesByCanonicalHeroId = new Map<number, Promise<void>>();

  constructor(
    @InjectRepository(MatchPlayer)
    private readonly matchPlayerRepository: Repository<MatchPlayer>,
    @InjectRepository(MatchPlayerItem)
    private readonly matchPlayerItemRepository: Repository<MatchPlayerItem>,
  ) {}

  async ensureReady(heroId: number): Promise<void> {
    const canonicalId = canonicalHeroId(heroId);
    const cached = this.cacheByCanonicalHeroId.get(canonicalId);
    const isFresh =
      cached !== undefined &&
      Date.now() - cached.builtAt.getTime() < LIVE_HERO_MATCHUP_SOURCE_TTL_MS;
    if (isFresh) {
      return;
    }

    const refreshPromise = this.startRefresh(canonicalId);
    if (cached) {
      void refreshPromise.catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(
          `Failed to refresh cached matchup source for hero ${canonicalId}: ${message}`,
        );
      });
      return;
    }

    await refreshPromise;
  }

  getSourceVersionMs(heroId: number): number {
    return this.cacheByCanonicalHeroId.get(canonicalHeroId(heroId))?.builtAt.getTime() ?? 0;
  }

  getMatches(heroId: number): readonly RecentMatchSnapshot[] {
    return this.cacheByCanonicalHeroId.get(canonicalHeroId(heroId))?.matches ?? [];
  }

  private startRefresh(canonicalId: number): Promise<void> {
    const existing = this.refreshPromisesByCanonicalHeroId.get(canonicalId);
    if (existing) {
      return existing;
    }

    const refreshPromise = this.loadHeroMatches(canonicalId).finally(() => {
      this.refreshPromisesByCanonicalHeroId.delete(canonicalId);
    });
    this.refreshPromisesByCanonicalHeroId.set(canonicalId, refreshPromise);
    return refreshPromise;
  }

  private async loadHeroMatches(canonicalId: number): Promise<void> {
    const startedAt = Date.now();
    const valveHeroId = resolveValveHeroIdFromGep(canonicalId);
    const requestedPlayers = await this.matchPlayerRepository
      .createQueryBuilder('player')
      .innerJoinAndSelect('player.match', 'match')
      .where('player.heroId = :heroId', { heroId: valveHeroId })
      .andWhere('match.startTime >= :cutoff', { cutoff: getRecentMatchCutoff(new Date()) })
      .orderBy('match.startTime', 'DESC')
      .addOrderBy('match.matchId', 'DESC')
      .take(RECENT_MATCH_TARGET_COUNT)
      .getMany();

    const matchIds = [...new Set(requestedPlayers.map((player) => Number(player.matchId)))];
    const rosterByMatchId = new Map<number, MatchPlayer[]>();
    for (const batch of chunkValues(matchIds, RECENT_MATCH_QUERY_BATCH_SIZE)) {
      const rosterPlayers = await this.matchPlayerRepository.find({
        where: { matchId: In(batch) },
      });
      for (const player of rosterPlayers) {
        const matchId = Number(player.matchId);
        const roster = rosterByMatchId.get(matchId) ?? [];
        roster.push(player);
        rosterByMatchId.set(matchId, roster);
      }
    }

    const requestedPlayerIds = requestedPlayers.map((player) => Number(player.id));
    const itemsByPlayerId = new Map<number, RecentMatchItemSnapshot[]>();
    for (const batch of chunkValues(requestedPlayerIds, RECENT_MATCH_QUERY_BATCH_SIZE)) {
      const items = await this.matchPlayerItemRepository.find({
        where: { matchPlayerId: In(batch) },
      });
      for (const item of items) {
        const playerId = Number(item.matchPlayerId);
        const playerItems = itemsByPlayerId.get(playerId) ?? [];
        playerItems.push(toItemSnapshot(item));
        itemsByPlayerId.set(playerId, playerItems);
      }
    }

    const matchById = new Map<number, Match>();
    for (const player of requestedPlayers) {
      matchById.set(Number(player.matchId), player.match as Match);
    }

    const requestedPlayerIdSet = new Set(requestedPlayerIds);
    const matches = matchIds
      .map((matchId): RecentMatchSnapshot | undefined => {
        const match = matchById.get(matchId);
        if (!match) {
          return undefined;
        }

        const players = (rosterByMatchId.get(matchId) ?? []).map(
          (player): RecentMatchPlayerSnapshot => ({
            id: Number(player.id),
            matchId,
            heroId: Number(player.heroId),
            team: toNumber(player.team),
            won: Boolean(player.won),
            kills: toNumber(player.kills),
            deaths: toNumber(player.deaths),
            assists: toNumber(player.assists),
            netWorth: toNumber(player.netWorth),
            itemPurchases: requestedPlayerIdSet.has(Number(player.id))
              ? itemsByPlayerId.get(Number(player.id)) ?? []
              : [],
            skillUpgrades: [],
          }),
        );

        return {
          matchId,
          startTime: new Date(match.startTime),
          durationS: toNumber(match.durationS),
          averageBadge: toNumber(match.averageBadge),
          winningTeam: toNumber(match.winningTeam),
          players,
        };
      })
      .filter((match): match is RecentMatchSnapshot => match !== undefined);

    this.cacheByCanonicalHeroId.set(canonicalId, {
      matches,
      builtAt: new Date(),
    });

    const itemEventCount = [...itemsByPlayerId.values()].reduce(
      (total, items) => total + items.length,
      0,
    );
    this.logger.log(
      `Loaded matchup source for hero ${canonicalId}: ${matches.length} matches, ` +
        `${requestedPlayers.length} hero players and ${itemEventCount} item events in ` +
        `${Date.now() - startedAt} ms.`,
    );
  }
}

function toItemSnapshot(item: MatchPlayerItem): RecentMatchItemSnapshot {
  return {
    id: Number(item.id),
    itemId: Number(item.itemId),
    purchaseTimeS: toOptionalNumber(item.purchaseTimeS),
    soldTimeS: toOptionalNumber(item.soldTimeS),
    upgradeId: toOptionalNumber(item.upgradeId),
    flags: toOptionalNumber(item.flags),
    imbuedAbilityId: toOptionalNumber(item.imbuedAbilityId),
    upgradeInfo: toOptionalNumber(item.upgradeInfo),
    slotOrder: toOptionalNumber(item.slotOrder),
  };
}

function toNumber(value: number | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toOptionalNumber(value: number | null | undefined): number | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
