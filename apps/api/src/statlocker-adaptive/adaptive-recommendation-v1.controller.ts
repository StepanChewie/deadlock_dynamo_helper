import { BadRequestException, Body, Controller, Get, Post } from '@nestjs/common';
import { AdaptiveRecommendationRequestV1, AdaptiveRecommendationResultV1 } from '@deadlock-live-probe/shared';
import { AdaptiveRecommendationV1Service } from './adaptive-recommendation-v1.service';
import { AdaptiveLiveStateNotReadyError } from './adaptive-decision-state-v1.service';
import { AdaptiveRecommendationObservabilityV1Service } from './adaptive-recommendation-observability-v1.service';
import { StatlockerEvidenceService } from './statlocker-evidence.service';
import { StatlockerRefreshService, StatlockerRefreshStatusV1 } from './statlocker-refresh.service';
import { ADAPTIVE_POLICY_V1_CONFIG } from './statlocker-adaptive.config';
import { StrategyFirstOperationsV1Service } from './strategy-first-operations-v1.service';
import { StrategyFirstPromotionGateV1Service } from './strategy-first-promotion-gate-v1.service';

export interface AdaptiveRecommendationStatusV1 {
  refresh: StatlockerRefreshStatusV1;
  observability: ReturnType<AdaptiveRecommendationObservabilityV1Service['getStatus']>;
  strategyPromotion: ReturnType<StrategyFirstPromotionGateV1Service['status']>;
  transactionPlanPromotion: ReturnType<StrategyFirstPromotionGateV1Service['transactionStatus']>;
  strategyOperations: ReturnType<StrategyFirstOperationsV1Service['getStatus']>;
  rulesetVersion?: string;
  catalogSha256?: string;
  statlockerPatchId?: string;
  activeSnapshotIds: readonly string[];
  families: ReturnType<StatlockerEvidenceService['getLocalStatus']>['families'];
}

@Controller('deadlock/adaptive/v1')
export class AdaptiveRecommendationV1Controller {
  constructor(
    private readonly recommendation: AdaptiveRecommendationV1Service,
    private readonly refresh: StatlockerRefreshService,
    private readonly evidence: StatlockerEvidenceService,
    private readonly observability: AdaptiveRecommendationObservabilityV1Service,
    private readonly strategyPromotion: StrategyFirstPromotionGateV1Service,
    private readonly strategyOperations: StrategyFirstOperationsV1Service,
  ) {}

  @Post('recommend')
  async recommend(@Body() body: AdaptiveRecommendationRequestV1): Promise<AdaptiveRecommendationResultV1> {
    if (!body || typeof body.matchId !== 'string' || body.matchId.trim() === '') {
      throw new BadRequestException('matchId is required');
    }
    if (body.localSteamId !== undefined && (typeof body.localSteamId !== 'string' || body.localSteamId.trim() === '')) {
      throw new BadRequestException('localSteamId is invalid');
    }
    const request = { matchId: body.matchId.trim(), localSteamId: body.localSteamId?.trim() };
    try {
      return await this.recommendation.recommend(request);
    } catch (error) {
      if (error instanceof AdaptiveLiveStateNotReadyError) return waitingRecommendation(request.matchId, error.blocker);
      throw error;
    }
  }

  @Get('status')
  status(): AdaptiveRecommendationStatusV1 {
    const refresh = this.refresh.getStatus();
    const local = this.evidence.getLocalStatus(refresh.identity);
    return {
      refresh,
      observability: this.observability.getStatus(),
      strategyPromotion: this.strategyPromotion.status(),
      transactionPlanPromotion: this.strategyPromotion.transactionStatus(),
      strategyOperations: this.strategyOperations.getStatus(),
      rulesetVersion: refresh.identity?.rulesetVersion,
      catalogSha256: refresh.identity?.catalogSha256,
      statlockerPatchId: local.statlockerPatchId,
      activeSnapshotIds: local.activeSnapshotIds,
      families: local.families,
    };
  }
}

function waitingRecommendation(
  matchId: string,
  blocker: AdaptiveLiveStateNotReadyError['blocker'],
): AdaptiveRecommendationResultV1 {
  return {
    ready: false,
    blockers: ['LIVE_STATE_NOT_READY', blocker],
    decisionId: `pending:${matchId}`,
    stateRevision: `pending:${matchId}`,
    gameState: 'UNKNOWN',
    nextAction: { actionKey: 'HOLD', type: 'HOLD', reasonCodes: ['LIVE_STATE_NOT_READY'] },
    recommendedBuild: [],
    changes: [],
    rankedImmediateCandidates: [],
    totalScore: 0,
    confidence: 0,
    scorerVersion: 'adaptive-evidence-scorer-v1',
    plannerVersion: 'adaptive-build-planner-v1',
    configVersion: ADAPTIVE_POLICY_V1_CONFIG.version,
    evidence: {
      rulesetVersion: 'UNKNOWN',
      catalogSha256: '',
      snapshotIds: [],
      families: [],
      degradedReasons: ['LIVE_STATE_NOT_READY', blocker],
    },
  };
}