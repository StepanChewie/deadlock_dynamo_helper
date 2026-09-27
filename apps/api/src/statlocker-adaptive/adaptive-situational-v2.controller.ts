import { BadRequestException, Body, Controller, Post, UseGuards } from '@nestjs/common';
import {
  AdaptiveRecommendationRequestV2,
  AdaptiveSituationalResultV2,
} from '@dynamo-lab/shared';
import { RateLimit, RateLimitGuard } from '../common/rate-limit.guard';
import { AdaptiveLiveStateNotReadyError } from './adaptive-decision-state-v1.service';
import { AdaptiveAvailabilityV1Service } from './adaptive-availability-v1.service';
import { AdaptiveSituationalV2Service } from './adaptive-situational-v2.service';

@Controller('deadlock/adaptive/v2')
export class AdaptiveSituationalV2Controller {
  constructor(
    private readonly situational: AdaptiveSituationalV2Service,
    private readonly availability: AdaptiveAvailabilityV1Service,
  ) {}

  // The same client polls this on the same cadence as /recommend, so it carries
  // the same 240/min limit value. The guard keys its bucket per controller +
  // handler + IP, so this route gets a bucket of its own rather than sharing
  // /recommend's — a 480/min per-address ceiling while both are polled. That is
  // acceptable: the client's mode switch means only one loop is active at a time.
  @Post('situational')
  @UseGuards(RateLimitGuard)
  @RateLimit({ limit: 240, windowMs: 60_000 })
  async recommend(@Body() body: AdaptiveRecommendationRequestV2): Promise<AdaptiveSituationalResultV2> {
    if (!body || typeof body.matchId !== 'string' || body.matchId.trim() === '') {
      throw new BadRequestException('matchId is required');
    }
    if (
      body.localSteamId !== undefined &&
      (typeof body.localSteamId !== 'string' || body.localSteamId.trim() === '')
    ) {
      throw new BadRequestException('localSteamId is invalid');
    }
    const request: AdaptiveRecommendationRequestV2 = {
      matchId: body.matchId.trim(),
      ...(body.localSteamId === undefined ? {} : { localSteamId: body.localSteamId.trim() }),
    };

    const availability = this.availability.getAvailability();
    if (!availability.recommendationsEnabled) {
      return disabledSituational(request.matchId, availability.maintenanceMessage);
    }

    try {
      return await this.situational.recommend(request);
    } catch (error) {
      if (error instanceof AdaptiveLiveStateNotReadyError) {
        return waitingSituational(request.matchId, error.blocker);
      }
      throw error;
    }
  }
}

function waitingSituational(
  matchId: string,
  blocker: AdaptiveLiveStateNotReadyError['blocker'],
): AdaptiveSituationalResultV2 {
  const blockers = ['LIVE_STATE_NOT_READY', blocker];
  return {
    mode: 'situational',
    ready: false,
    blockers,
    decisionId: `pending:${matchId}`,
    stateRevision: `pending:${matchId}`,
    situationalItems: [],
    degradedReasons: blockers,
  };
}

/**
 * Fail-closed answer while the kill switch is off. Like the full-build route it
 * never carries items, so a disabled backend can only ever produce "nothing to
 * show", never a stale or fabricated recommendation.
 */
function disabledSituational(
  matchId: string,
  maintenanceMessage?: string,
): AdaptiveSituationalResultV2 {
  const blockers = ['RECOMMENDATIONS_DISABLED'];
  return {
    mode: 'situational',
    ready: false,
    blockers,
    decisionId: `disabled:${matchId}`,
    stateRevision: `disabled:${matchId}`,
    situationalItems: [],
    degradedReasons: maintenanceMessage ? [...blockers, maintenanceMessage] : blockers,
  };
}
