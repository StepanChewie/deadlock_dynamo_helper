import { Controller, Get, NotFoundException, Param, ParseIntPipe } from '@nestjs/common';
import { CanonicalBuildSequenceService } from './canonical-build-sequence.service';
import { InventoryTimelineReplayService } from './inventory-timeline-replay.service';
import { MatchTimelineNormalizationService } from './match-timeline-normalization.service';
import {
  RecentMatchSnapshot,
  RECENT_MATCH_WINDOW_DAYS,
  RecentMatchesWindowService,
} from './recent-matches-window.service';

@Controller('deadlock/analysis/recent-matches')
export class MatchTimelineNormalizationController {
  constructor(
    private readonly recentMatchesWindowService: RecentMatchesWindowService,
    private readonly matchTimelineNormalizationService: MatchTimelineNormalizationService,
    private readonly inventoryTimelineReplayService: InventoryTimelineReplayService,
    private readonly canonicalBuildSequenceService: CanonicalBuildSequenceService,
  ) {}

  @Get(':matchId/timelines')
  async getMatchTimelines(@Param('matchId', ParseIntPipe) matchId: number) {
    const match = await this.getReadyMatch(matchId);
    return this.matchTimelineNormalizationService.normalizeMatch(match);
  }

  @Get(':matchId/inventory-replays')
  async getMatchInventoryReplays(@Param('matchId', ParseIntPipe) matchId: number) {
    const match = await this.getReadyMatch(matchId);
    const timelines = this.matchTimelineNormalizationService.normalizeMatch(match);
    return this.inventoryTimelineReplayService.replayMatch(timelines);
  }

  @Get(':matchId/build-sequences')
  async getMatchBuildSequences(@Param('matchId', ParseIntPipe) matchId: number) {
    const match = await this.getReadyMatch(matchId);
    const timelines = this.matchTimelineNormalizationService.normalizeMatch(match);
    const replay = this.inventoryTimelineReplayService.replayMatch(timelines);
    return this.canonicalBuildSequenceService.canonicalizeMatch(replay);
  }

  @Get(':matchId/players/:playerId/timeline')
  async getPlayerTimeline(
    @Param('matchId', ParseIntPipe) matchId: number,
    @Param('playerId', ParseIntPipe) playerId: number,
  ) {
    const player = await this.getReadyPlayer(matchId, playerId);
    return this.matchTimelineNormalizationService.normalizePlayer(player);
  }

  @Get(':matchId/players/:playerId/inventory-replay')
  async getPlayerInventoryReplay(
    @Param('matchId', ParseIntPipe) matchId: number,
    @Param('playerId', ParseIntPipe) playerId: number,
  ) {
    const player = await this.getReadyPlayer(matchId, playerId);
    const timeline = this.matchTimelineNormalizationService.normalizePlayer(player);
    return this.inventoryTimelineReplayService.replayPlayer(timeline);
  }

  @Get(':matchId/players/:playerId/build-sequence')
  async getPlayerBuildSequence(
    @Param('matchId', ParseIntPipe) matchId: number,
    @Param('playerId', ParseIntPipe) playerId: number,
  ) {
    const player = await this.getReadyPlayer(matchId, playerId);
    const timeline = this.matchTimelineNormalizationService.normalizePlayer(player);
    const replay = this.inventoryTimelineReplayService.replayPlayer(timeline);
    return this.canonicalBuildSequenceService.canonicalizePlayer(replay);
  }

  private async getReadyPlayer(matchId: number, playerId: number) {
    const match = await this.getReadyMatch(matchId);
    const player = match.players.find((candidate) => candidate.id === playerId);
    if (!player) {
      throw new NotFoundException(`Player ${playerId} is not present in match ${matchId}.`);
    }
    return player;
  }

  private async getReadyMatch(matchId: number): Promise<RecentMatchSnapshot> {
    let match = this.recentMatchesWindowService.getMatch(matchId);
    const status = this.recentMatchesWindowService.getStatus();

    if (!match && !status.lastRefreshedAt) {
      await this.recentMatchesWindowService.refresh();
      match = this.recentMatchesWindowService.getMatch(matchId);
    }

    if (!match) {
      throw new NotFoundException(
        `Match ${matchId} is not present in the ${RECENT_MATCH_WINDOW_DAYS}-day memory window.`,
      );
    }

    return match;
  }
}
