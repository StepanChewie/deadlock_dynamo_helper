import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { CanonicalBuildSequenceService } from './canonical-build-sequence.service';
import { Match } from './entities/match.entity';
import { MatchPlayer } from './entities/match-player.entity';
import { MatchPlayerItem } from './entities/match-player-item.entity';
import { canonicalHeroId, resolveValveHeroIdFromGep } from './hero-id-aliases';
import {
  HeroBuildNextActionsResponse,
  HeroBuildPolicy,
  HeroBuildTransitionAccumulator,
  HeroBuildTransitionAggregationStatus,
} from './hero-build-transition-aggregation.service';
import { InventoryTimelineReplayService } from './inventory-timeline-replay.service';
import { MatchTimelineNormalizationService } from './match-timeline-normalization.service';
import {
  chunkValues,
  getRecentMatchCutoff,
  RECENT_MATCH_QUERY_BATCH_SIZE,
  RecentMatchSnapshot,
} from './recent-matches-window.service';
import { RecipeAwareTimelineReconciliationService } from './recipe-aware-timeline-reconciliation.service';

const LIVE_HERO_POLICY_TTL_MS = 5 * 60_000;
const LIVE_HERO_POLICY_TARGET_PLAYER_COUNT = 5_000;
const LIVE_HERO_POLICY_YIELD_INTERVAL = 25;

interface LiveHeroPolicyCache {
  policy: HeroBuildPolicy;
  matchCount: number;
  sourcePlayerCount: number;
  includedPlayerCount: number;
  excludedPlayerCount: number;
  stateCount: number;
  transitionCount: number;
  actionOptionCount: number;
  builtAt: Date;
}

@Injectable()
export class LiveHeroBuildPolicyService {
  private readonly logger = new Logger(LiveHeroBuildPolicyService.name);
  private readonly cacheByCanonicalHeroId = new Map<number, LiveHeroPolicyCache>();
  private readonly refreshPromisesByCanonicalHeroId = new Map<number, Promise<void>>();
  private lastRefreshDurationMs = 0;
  private lastError?: string;

  constructor(
    @InjectRepository(MatchPlayer)
    private readonly matchPlayerRepository: Repository<MatchPlayer>,
    @InjectRepository(MatchPlayerItem)
    private readonly matchPlayerItemRepository: Repository<MatchPlayerItem>,
    private readonly matchTimelineNormalizationService: MatchTimelineNormalizationService,
    private readonly inventoryTimelineReplayService: InventoryTimelineReplayService,
    private readonly canonicalBuildSequenceService: CanonicalBuildSequenceService,
    private readonly recipeAwareTimelineReconciliationService:
      RecipeAwareTimelineReconciliationService,
  ) {}

  async ensureReady(heroId?: number): Promise<void> {
    if (!Number.isSafeInteger(heroId) || Number(heroId) <= 0) {
      return;
    }

    const canonicalId = canonicalHeroId(Number(heroId));
    const cached = this.cacheByCanonicalHeroId.get(canonicalId);
    const isFresh =
      cached !== undefined && Date.now() - cached.builtAt.getTime() < LIVE_HERO_POLICY_TTL_MS;
    if (isFresh) {
      return;
    }

    const refreshPromise = this.startRefresh(canonicalId);
    if (cached) {
      void refreshPromise.catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(`Failed to refresh cached live policy for hero ${canonicalId}: ${message}`);
      });
      return;
    }
    await refreshPromise;
  }

  async refresh(): Promise<HeroBuildTransitionAggregationStatus> {
    for (const heroId of this.cacheByCanonicalHeroId.keys()) {
      await this.startRefresh(heroId);
    }
    return this.getStatus();
  }

  getHeroPolicy(heroId: number): HeroBuildPolicy | undefined {
    return this.cacheByCanonicalHeroId.get(canonicalHeroId(heroId))?.policy;
  }

  getStatus(): HeroBuildTransitionAggregationStatus {
    const caches = [...this.cacheByCanonicalHeroId.values()];
    const lastRefreshedAt = caches.length > 0
      ? new Date(Math.max(...caches.map((cache) => cache.builtAt.getTime())))
      : undefined;

    return {
      refreshCheckIntervalMs: LIVE_HERO_POLICY_TTL_MS,
      matchCount: caches.reduce((total, cache) => total + cache.matchCount, 0),
      sourcePlayerCount: caches.reduce((total, cache) => total + cache.sourcePlayerCount, 0),
      includedPlayerCount: caches.reduce((total, cache) => total + cache.includedPlayerCount, 0),
      excludedPlayerCount: caches.reduce((total, cache) => total + cache.excludedPlayerCount, 0),
      heroCount: caches.length,
      stateCount: caches.reduce((total, cache) => total + cache.stateCount, 0),
      transitionCount: caches.reduce((total, cache) => total + cache.transitionCount, 0),
      actionOptionCount: caches.reduce((total, cache) => total + cache.actionOptionCount, 0),
      lastRefreshDurationMs: this.lastRefreshDurationMs,
      lastRefreshedAt,
      lastError: this.lastError,
    };
  }

  getNextActions(
    heroId: number,
    stateKey: string,
    limit = 10,
    minCount = 1,
  ): HeroBuildNextActionsResponse {
    const policy = this.getHeroPolicy(heroId);
    const state = policy?.statesByKey.get(stateKey);
    const status = this.getStatus();
    if (!state) {
      return {
        heroId,
        stateKey,
        found: false,
        observationCount: 0,
        availableActionCount: 0,
        returnedActionCount: 0,
        coverageProbability: 0,
        nextActions: [],
        lastRefreshedAt: status.lastRefreshedAt,
      };
    }

    const eligibleActions = state.nextActions.filter((action) => action.count >= minCount);
    const nextActions = eligibleActions.slice(0, limit).map((action) => ({
      ...action,
      afterStates: action.afterStates.map((afterState) => ({ ...afterState })),
    }));

    return {
      heroId,
      stateKey,
      found: true,
      observationCount: state.observationCount,
      availableActionCount: eligibleActions.length,
      returnedActionCount: nextActions.length,
      coverageProbability: nextActions.reduce((total, action) => total + action.probability, 0),
      nextActions,
      lastRefreshedAt: status.lastRefreshedAt,
    };
  }

  private startRefresh(canonicalId: number): Promise<void> {
    const existing = this.refreshPromisesByCanonicalHeroId.get(canonicalId);
    if (existing) {
      return existing;
    }

    const refreshPromise = this.buildHeroPolicy(canonicalId).finally(() => {
      this.refreshPromisesByCanonicalHeroId.delete(canonicalId);
    });
    this.refreshPromisesByCanonicalHeroId.set(canonicalId, refreshPromise);
    return refreshPromise;
  }

  private async buildHeroPolicy(canonicalId: number): Promise<void> {
    const startedAt = Date.now();
    try {
      try {
        await this.recipeAwareTimelineReconciliationService.refreshRecipes();
      } catch {
        // The live policy can use the existing recipe cache when refresh is unavailable.
      }

      const valveHeroId = resolveValveHeroIdFromGep(canonicalId);
      const players = await this.matchPlayerRepository
        .createQueryBuilder('player')
        .innerJoinAndSelect('player.match', 'match')
        .where('player.heroId = :heroId', { heroId: valveHeroId })
        .andWhere('match.startTime >= :cutoff', { cutoff: getRecentMatchCutoff(new Date()) })
        .orderBy('match.startTime', 'DESC')
        .addOrderBy('match.matchId', 'DESC')
        .take(LIVE_HERO_POLICY_TARGET_PLAYER_COUNT)
        .getMany();

      const itemsByPlayerId = new Map<number, MatchPlayerItem[]>();
      const playerIds = players.map((player) => Number(player.id));
      for (const batch of chunkValues(playerIds, RECENT_MATCH_QUERY_BATCH_SIZE)) {
        const items = await this.matchPlayerItemRepository.find({
          where: { matchPlayerId: In(batch) },
        });
        for (const item of items) {
          const playerId = Number(item.matchPlayerId);
          const playerItems = itemsByPlayerId.get(playerId) ?? [];
          playerItems.push(item);
          itemsByPlayerId.set(playerId, playerItems);
        }
      }

      const accumulator = new HeroBuildTransitionAccumulator();
      let processedMatchCount = 0;
      for (const player of players) {
        const match = toRequestedHeroMatchSnapshot(
          player,
          itemsByPlayerId.get(Number(player.id)) ?? [],
        );
        const timelines = this.matchTimelineNormalizationService.normalizeMatch(match);
        const replay = this.inventoryTimelineReplayService.replayMatch(timelines);
        const sequences = this.canonicalBuildSequenceService.canonicalizeMatch(replay);
        for (const sequence of sequences.players) {
          if (sequence.heroId !== valveHeroId) {
            continue;
          }
          accumulator.addPlayer({ ...sequence, heroId: canonicalId });
        }
        processedMatchCount += 1;
        if (processedMatchCount % LIVE_HERO_POLICY_YIELD_INTERVAL === 0) {
          await yieldToEventLoop();
        }
      }

      const snapshot = accumulator.build();
      const policy = snapshot.policiesByHeroId.get(canonicalId) ?? createEmptyPolicy(canonicalId);
      this.cacheByCanonicalHeroId.set(canonicalId, {
        policy,
        matchCount: processedMatchCount,
        sourcePlayerCount: snapshot.sourcePlayerCount,
        includedPlayerCount: snapshot.includedPlayerCount,
        excludedPlayerCount: snapshot.excludedPlayerCount,
        stateCount: snapshot.stateCount,
        transitionCount: snapshot.transitionCount,
        actionOptionCount: snapshot.actionOptionCount,
        builtAt: new Date(),
      });

      this.lastRefreshDurationMs = Date.now() - startedAt;
      this.lastError = undefined;
      this.logger.log(
        `Built live policy for hero ${canonicalId} from ${processedMatchCount} matches in ` +
          `${this.lastRefreshDurationMs} ms.`,
      );
    } catch (error) {
      this.lastRefreshDurationMs = Date.now() - startedAt;
      this.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }
}

function createEmptyPolicy(heroId: number): HeroBuildPolicy {
  return {
    heroId,
    playerCount: 0,
    stateCount: 0,
    transitionCount: 0,
    statesByKey: new Map(),
  };
}

function toRequestedHeroMatchSnapshot(
  player: MatchPlayer,
  items: MatchPlayerItem[],
): RecentMatchSnapshot {
  const match = player.match as Match;
  return {
    matchId: Number(player.matchId),
    startTime: new Date(match.startTime),
    durationS: toNumber(match.durationS),
    averageBadge: toNumber(match.averageBadge),
    winningTeam: toNumber(match.winningTeam),
    players: [
      {
        id: Number(player.id),
        matchId: Number(player.matchId),
        heroId: Number(player.heroId),
        team: toNumber(player.team),
        won: Boolean(player.won),
        kills: toNumber(player.kills),
        deaths: toNumber(player.deaths),
        assists: toNumber(player.assists),
        netWorth: toNumber(player.netWorth),
        itemPurchases: items.map((item) => ({
          id: Number(item.id),
          itemId: Number(item.itemId),
          purchaseTimeS: toOptionalNumber(item.purchaseTimeS),
          soldTimeS: toOptionalNumber(item.soldTimeS),
          upgradeId: toOptionalNumber(item.upgradeId),
          flags: toOptionalNumber(item.flags),
          imbuedAbilityId: toOptionalNumber(item.imbuedAbilityId),
          upgradeInfo: toOptionalNumber(item.upgradeInfo),
          slotOrder: toOptionalNumber(item.slotOrder),
        })),
        skillUpgrades: [],
      },
    ],
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

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
