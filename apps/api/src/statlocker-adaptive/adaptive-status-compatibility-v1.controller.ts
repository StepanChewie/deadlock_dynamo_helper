import { Controller, Get } from '@nestjs/common';
import { AdaptiveRecommendationObservabilityV1Service } from './adaptive-recommendation-observability-v1.service';
import { StatlockerEvidenceService } from './statlocker-evidence.service';
import { StatlockerRefreshService, StatlockerRefreshStatusV1 } from './statlocker-refresh.service';
import { StrategyFirstOperationsV1Service } from './strategy-first-operations-v1.service';
import { StrategyFirstPromotionGateV1Service } from './strategy-first-promotion-gate-v1.service';

export interface AdaptiveStatusCompatibilityV1 {
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
export class AdaptiveStatusCompatibilityV1Controller {
  constructor(
    private readonly refresh: StatlockerRefreshService,
    private readonly evidence: StatlockerEvidenceService,
    private readonly observability: AdaptiveRecommendationObservabilityV1Service,
    private readonly strategyPromotion: StrategyFirstPromotionGateV1Service,
    private readonly strategyOperations: StrategyFirstOperationsV1Service,
  ) {}

  @Get('status')
  status(): AdaptiveStatusCompatibilityV1 {
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
