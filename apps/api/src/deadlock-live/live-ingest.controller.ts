import { Body, Controller, Get, Logger, Param, Post } from '@nestjs/common';
import { OverwolfLiveBatchDto } from '@dynamo-lab/shared';
import { canonicalizeLiveBatchForStateV2 } from './canonical-live-batch';
import { InventoryShadowReplayService } from './inventory-shadow-replay.service';
import { LiveInventoryEventNormalizerService } from './live-inventory-event-normalizer.service';
import { LiveMatchStateService } from './live-match-state.service';
import { RawEventLogService } from './raw-event-log.service';
import { RecentLiveEventsService } from './recent-live-events.service';

@Controller('deadlock/live')
export class LiveIngestController {
  private readonly logger = new Logger(LiveIngestController.name);

  constructor(
    private readonly rawEventLogService: RawEventLogService,
    private readonly liveMatchStateService: LiveMatchStateService,
    private readonly inventoryShadowReplayService: InventoryShadowReplayService,
    private readonly recentLiveEventsService: RecentLiveEventsService,
    private readonly liveInventoryEventNormalizerService:
      LiveInventoryEventNormalizerService,
  ) {}

  @Post('events')
  async ingestEvents(@Body() batch: OverwolfLiveBatchDto): Promise<{ ok: true }> {
    this.recentLiveEventsService.append(batch.events);
    const normalizedBatch = this.liveInventoryEventNormalizerService.normalizeBatch(batch);
    const stateBatch = canonicalizeLiveBatchForStateV2(normalizedBatch);
    const state = this.liveMatchStateService.applyBatch(stateBatch);
    this.inventoryShadowReplayService.applyBatch(normalizedBatch, state?.matchId);

    try {
      await this.rawEventLogService.appendEvents(batch.events);
    } catch (error) {
      this.logger.warn(`Raw live event logging failed: ${describeError(error)}`);
    }

    return { ok: true };
  }

  @Get('states')
  getStates() {
    return this.liveMatchStateService.getAllStates();
  }

  @Get('matches/:matchId/state')
  getState(@Param('matchId') matchId: string) {
    return this.liveMatchStateService.getState(matchId);
  }

  @Get('matches/:matchId/inventory-shadow')
  getInventoryShadow(@Param('matchId') matchId: string) {
    return this.inventoryShadowReplayService.getMatchTimelines(matchId);
  }

  @Get('matches/:matchId/inventory-shadow/:steamId')
  getPlayerInventoryShadow(
    @Param('matchId') matchId: string,
    @Param('steamId') steamId: string,
  ) {
    return this.inventoryShadowReplayService.getPlayerTimeline(matchId, steamId);
  }

  @Get('events/recent')
  getRecentEvents() {
    return this.recentLiveEventsService.getRecent();
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code ? `${code}: ${error.message}` : error.message;
  }
  return String(error);
}
