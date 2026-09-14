import { BadRequestException, Body, Controller, Post } from '@nestjs/common';
import {
  AdaptiveRecommendationRequestV2,
  AdaptiveRecommendationResultV2,
} from '@deadlock-live-probe/shared';
import { AdaptiveLiveStateNotReadyError } from './adaptive-decision-state-v1.service';
import { BuildIterationCaptureV1 } from './build-iteration-capture-v1';
import { BuildIterationHistoryV1Service } from './build-iteration-history-v1.service';
import { AdaptiveRecommendationV2Service } from './adaptive-recommendation-v2.service';
import { LiveMatchStateService } from '../deadlock-live/live-match-state.service';

@Controller('deadlock/adaptive/v2')
export class AdaptiveRecommendationV2Controller {
  constructor(
    private readonly recommendation: AdaptiveRecommendationV2Service,
    private readonly history: BuildIterationHistoryV1Service,
    private readonly liveState: LiveMatchStateService,
  ) {}

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
    const capture = new BuildIterationCaptureV1();
    const fallbackSteamId = request.localSteamId ?? resolveMarkedLocalSteamId(this.liveState, request.matchId);

    let result: AdaptiveRecommendationResultV2;
    try {
      result = await this.recommendation.recommend(request, capture);
    } catch (error) {
      if (error instanceof AdaptiveLiveStateNotReadyError) {
        result = waitingRecommendation(request.matchId, error.blocker);
      } else {
        throw error;
      }
    }

    await this.history.record({
      matchId: request.matchId,
      steamId: capture.steamId ?? fallbackSteamId ?? 'unknown',
      result,
      capture,
    });
    return result;
  }
}

function resolveMarkedLocalSteamId(liveState: LiveMatchStateService, matchId: string): string | undefined {
  const state = liveState.getState(matchId);
  if (!state) return undefined;
  const marked = Object.values(state.playersBySteamId).filter((player) => player.isLocal);
  return marked.length === 1 ? marked[0].steamId : undefined;
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
