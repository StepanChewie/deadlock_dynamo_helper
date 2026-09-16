import { Body, Controller, Get, Logger, Param, Post, UseGuards } from '@nestjs/common';
import { OverwolfLiveBatchDto } from '@dynamo-lab/shared';
import { InternalApiGuard } from '../common/internal-api.guard';
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

  // Public by design: the shipped Overwolf client posts here and holds no
  // internal key. Do not add a guard to this method.
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

  // The reads below expose live match state, player inventories and the raw
  // event feed. None of them are used by the client, so they are operator-only.
  @Get('states')
  @UseGuards(InternalApiGuard)
  getStates() {
    return this.liveMatchStateService.getAllStates();
  }

  @Get('matches/:matchId/state')
  @UseGuards(InternalApiGuard)
  getState(@Param('matchId') matchId: string) {
    return this.liveMatchStateService.getState(matchId);
  }

  @Get('matches/:matchId/inventory-shadow')
  @UseGuards(InternalApiGuard)
  getInventoryShadow(@Param('matchId') matchId: string) {
    return this.inventoryShadowReplayService.getMatchTimelines(matchId);
  }

  @Get('matches/:matchId/inventory-shadow/:steamId')
  @UseGuards(InternalApiGuard)
  getPlayerInventoryShadow(
    @Param('matchId') matchId: string,
    @Param('steamId') steamId: string,
  ) {
    return this.inventoryShadowReplayService.getPlayerTimeline(matchId, steamId);
  }

  @Get('events/recent')
  @UseGuards(InternalApiGuard)
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
