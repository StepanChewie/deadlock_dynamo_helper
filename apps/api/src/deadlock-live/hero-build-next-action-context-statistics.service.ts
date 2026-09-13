import { Injectable } from '@nestjs/common';
import { CanonicalBuildSequenceService } from './canonical-build-sequence.service';
import {
  HeroBuildContextualV2ActionEvaluation,
  HeroBuildNextActionContextIndex,
  HeroBuildNextActionContextIndexSummary,
} from './hero-build-contextual-v2.model';
import { canonicalHeroId, resolveValveHeroIdFromGep } from './hero-id-aliases';
import { InventoryTimelineReplayService } from './inventory-timeline-replay.service';
import { LiveHeroMatchupSourceService } from './live-hero-matchup-source.service';
import { MatchTimelineNormalizationService } from './match-timeline-normalization.service';
import type { RecentMatchSnapshot } from './recent-matches-window.service';

const NEXT_ACTION_CONTEXT_YIELD_INTERVAL = 25;

interface HeroContextIndexCache {
  index: HeroBuildNextActionContextIndex;
  sourceVersionMs: number;
}

export interface HeroBuildNextActionContextStatus {
  heroId: number;
  ready: boolean;
  sourceVersionMs: number;
  summary: HeroBuildNextActionContextIndexSummary;
}

export interface HeroBuildNextActionContextCandidate {
  actionKey: string;
  stateKey: string;
}

@Injectable()
export class HeroBuildNextActionContextStatisticsService {
  private readonly indexesByHeroId = new Map<number, HeroContextIndexCache>();
  private readonly refreshPromisesByHeroId = new Map<number, Promise<void>>();

  constructor(
    private readonly liveHeroMatchupSourceService: LiveHeroMatchupSourceService,
    private readonly matchTimelineNormalizationService: MatchTimelineNormalizationService,
    private readonly inventoryTimelineReplayService: InventoryTimelineReplayService,
    private readonly canonicalBuildSequenceService: CanonicalBuildSequenceService,
  ) {}

  async evaluateMany(input: {
    heroId: number;
    gameTimeS: number;
    enemyHeroIds: readonly number[];
    candidates: readonly HeroBuildNextActionContextCandidate[];
  }): Promise<Map<string, HeroBuildContextualV2ActionEvaluation>> {
    const heroId = canonicalHeroId(input.heroId);
    await this.ensureReady(heroId);
    const index = this.indexesByHeroId.get(heroId)?.index;
    const result = new Map<string, HeroBuildContextualV2ActionEvaluation>();
    if (!index) {
      return result;
    }

    for (const candidate of input.candidates) {
      result.set(
        candidate.actionKey,
        index.evaluate({
          stateKey: candidate.stateKey,
          actionKey: candidate.actionKey,
          gameTimeS: input.gameTimeS,
          enemyHeroIds: input.enemyHeroIds,
        }),
      );
    }
    return result;
  }

  getStatus(heroId: number): HeroBuildNextActionContextStatus {
    const canonicalId = canonicalHeroId(heroId);
    const cache = this.indexesByHeroId.get(canonicalId);
    return {
      heroId: canonicalId,
      ready: cache !== undefined,
      sourceVersionMs: cache?.sourceVersionMs ?? 0,
      summary: cache?.index.getSummary() ?? {
        scopeCount: 0,
        actionOptionCount: 0,
        observationCount: 0,
        enemyObservationCount: 0,
      },
    };
  }

  private async ensureReady(heroId: number): Promise<void> {
    await this.liveHeroMatchupSourceService.ensureReady(heroId);
    const sourceVersionMs =
      this.liveHeroMatchupSourceService.getSourceVersionMs(heroId);
    const cached = this.indexesByHeroId.get(heroId);
    if (cached?.sourceVersionMs === sourceVersionMs) {
      return;
    }

    const refresh = this.getOrStartRefresh(heroId, sourceVersionMs);
    if (cached) {
      void refresh.catch(() => undefined);
      return;
    }
    await refresh;
  }

  private getOrStartRefresh(heroId: number, sourceVersionMs: number): Promise<void> {
    const existing = this.refreshPromisesByHeroId.get(heroId);
    if (existing) {
      return existing;
    }
    const refresh = this.rebuildHero(heroId, sourceVersionMs).finally(() => {
      this.refreshPromisesByHeroId.delete(heroId);
    });
    this.refreshPromisesByHeroId.set(heroId, refresh);
    return refresh;
  }

  private async rebuildHero(heroId: number, sourceVersionMs: number): Promise<void> {
    const index = new HeroBuildNextActionContextIndex();
    let processedMatchCount = 0;
    for (const match of this.liveHeroMatchupSourceService.getMatches(heroId)) {
      this.addMatch(index, match, heroId);
      processedMatchCount += 1;
      if (processedMatchCount % NEXT_ACTION_CONTEXT_YIELD_INTERVAL === 0) {
        await yieldToEventLoop();
      }
    }
    this.indexesByHeroId.set(heroId, { index, sourceVersionMs });
  }

  private addMatch(
    index: HeroBuildNextActionContextIndex,
    match: RecentMatchSnapshot,
    requestedHeroId: number,
  ): void {
    const requestedValveHeroId = resolveValveHeroIdFromGep(requestedHeroId);
    const requestedPlayers = match.players.filter(
      (player) => player.heroId === requestedValveHeroId,
    );
    if (requestedPlayers.length === 0) {
      return;
    }

    const requestedHeroMatch: RecentMatchSnapshot = {
      ...match,
      players: requestedPlayers,
    };
    const timelines = this.matchTimelineNormalizationService.normalizeMatch(
      requestedHeroMatch,
    );
    const replay = this.inventoryTimelineReplayService.replayMatch(timelines);
    const sequences = this.canonicalBuildSequenceService.canonicalizeMatch(replay);
    const playersById = new Map(
      requestedPlayers.map((player) => [player.id, player]),
    );

    for (const sequence of sequences.players) {
      if (sequence.heroId !== requestedValveHeroId) {
        continue;
      }
      const player = playersById.get(sequence.playerId);
      if (!player) {
        continue;
      }
      const enemyHeroIds = match.players
        .filter((candidate) => candidate.team !== player.team)
        .map((candidate) => candidate.heroId);
      index.addSequence(sequence, enemyHeroIds);
    }
  }
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
