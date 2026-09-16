import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Logger,
  Param,
  Post,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { OverwolfLiveBatchDto, OverwolfLiveEventDto } from '@dynamo-lab/shared';
import { InternalApiGuard } from '../common/internal-api.guard';
import { RateLimit, RateLimitGuard } from '../common/rate-limit.guard';
import { RequestTimeoutInterceptor } from '../common/request-timeout.interceptor';
import { canonicalizeLiveBatchForStateV2 } from './canonical-live-batch';
import { InventoryShadowReplayService } from './inventory-shadow-replay.service';
import { LiveInventoryEventNormalizerService } from './live-inventory-event-normalizer.service';
import { LiveMatchStateService } from './live-match-state.service';
import { RawEventLogService } from './raw-event-log.service';
import { RecentLiveEventsService } from './recent-live-events.service';

/**
 * Ceiling on the events processed from one request.
 *
 * Exceeding it truncates the batch rather than rejecting it. Rejecting would be
 * worse in both directions: the shipped client treats a non-2xx as retryable
 * and retries the identical body, so a rejected batch can never be accepted and
 * blocks everything queued behind it; and a 413 would discard the whole batch
 * where truncation keeps the first 2,000 events. The client now chunks at 500,
 * so this only fires for a client that is not ours or is badly out of date.
 */
const MAX_EVENTS_PER_BATCH = 2_000;

/**
 * Requests allowed per address per minute. The busiest single minute ever
 * observed for one address was 245, and the 90th percentile is 64, so this sits
 * far above real traffic and only catches a runaway sender.
 */
const INGEST_RATE_LIMIT = { limit: 600, windowMs: 60_000 };

/** Ingest appends in memory and writes to disk; it should never take this long. */
const INGEST_TIMEOUT_MS = 10_000;

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
  @UseGuards(RateLimitGuard)
  @RateLimit(INGEST_RATE_LIMIT)
  @UseInterceptors(new RequestTimeoutInterceptor(INGEST_TIMEOUT_MS))
  async ingestEvents(@Body() batch: OverwolfLiveBatchDto): Promise<{ ok: true }> {
    // An absent `events` array used to reach `.length` inside the append call
    // and surface as a 500. Malformed input is the caller's fault, so it is a
    // 400 — no shipped client sends it.
    if (!batch || typeof batch !== 'object' || !Array.isArray(batch.events)) {
      throw new BadRequestException('events must be an array');
    }

    const events = batch.events.slice(0, MAX_EVENTS_PER_BATCH);
    if (events.length < batch.events.length) {
      this.logger.warn(
        `Truncated a live batch from ${describeClientId(batch)}: ` +
          `${batch.events.length} events received, ${events.length} kept`,
      );
    }

    const effectiveBatch: OverwolfLiveBatchDto = { ...batch, events };

    this.recentLiveEventsService.append(events);
    const normalizedBatch =
      this.liveInventoryEventNormalizerService.normalizeBatch(effectiveBatch);
    const stateBatch = canonicalizeLiveBatchForStateV2(normalizedBatch);
    const state = this.liveMatchStateService.applyBatch(stateBatch);
    this.inventoryShadowReplayService.applyBatch(normalizedBatch, state?.matchId);

    try {
      await this.rawEventLogService.appendEvents(events);
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

/** Log-safe client id: the field is caller-supplied and may be anything at all. */
function describeClientId(batch: OverwolfLiveBatchDto): string {
  const clientId = (batch as { clientId?: unknown }).clientId;
  if (typeof clientId !== 'string' || clientId.trim() === '') {
    return 'unknown client';
  }
  const trimmed = clientId.trim();
  return trimmed.length > 64 ? `${trimmed.slice(0, 64)}...` : trimmed;
}
