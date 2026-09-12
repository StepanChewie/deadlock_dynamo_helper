import { BadRequestException, Body, Controller, Post } from '@nestjs/common';
import {
  AdaptiveRecommendationRequestV2,
  AdaptiveRecommendationResultV2,
} from '@deadlock-live-probe/shared';
import { AdaptiveLiveStateNotReadyError } from './adaptive-decision-state-v1.service';
import { AdaptiveRecommendationV2Service } from './adaptive-recommendation-v2.service';

@Controller('deadlock/adaptive/v2')
export class AdaptiveRecommendationV2Controller {
  constructor(private readonly recommendation: AdaptiveRecommendationV2Service) {}

  @Post('recommend')
  async recommend(@Body() body: AdaptiveRecommendationRequestV2): Promise<AdaptiveRecommendationResultV2> {
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
    try {
      return await this.recommendation.recommend(request);
    } catch (error) {
      if (error instanceof AdaptiveLiveStateNotReadyError) {
        return waitingRecommendation(request.matchId, error.blocker);
      }
      throw error;
    }
  }
}

function waitingRecommendation(
  matchId: string,
  blocker: AdaptiveLiveStateNotReadyError['blocker'],
): AdaptiveRecommendationResultV2 {
  const blockers = ['LIVE_STATE_NOT_READY', blocker];
  return {
    ready: false,
    blockers,
    decisionId: `pending:${matchId}`,
    stateRevision: `pending:${matchId}`,
    nextAction: {
      type: 'HOLD',
      reasonCodes: blockers,
    },
    score: { total: 0, confidence: 0 },
    degradedReasons: blockers,
  };
}
