import { Controller, Get } from '@nestjs/common';
import {
  AdaptiveAvailabilityV1,
  AdaptiveAvailabilityV1Service,
} from './adaptive-availability-v1.service';
import { AdaptiveRecommendationObservabilityV1Service } from './adaptive-recommendation-observability-v1.service';
import { RecommendationEconomyRulesBootstrapV1Service } from './recommendation-economy-rules-bootstrap-v1.service';
import { StatlockerEvidenceService } from './statlocker-evidence.service';
import { StatlockerRefreshService, StatlockerRefreshStatusV1 } from './statlocker-refresh.service';

export interface AdaptiveStatusCompatibilityV1 extends AdaptiveAvailabilityV1 {
  refresh: StatlockerRefreshStatusV1;
  observability: ReturnType<AdaptiveRecommendationObservabilityV1Service['getStatus']>;
  economyRulesBootstrap: ReturnType<RecommendationEconomyRulesBootstrapV1Service['getStatus']>;
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
    private readonly economyRulesBootstrap: RecommendationEconomyRulesBootstrapV1Service,
    private readonly availability: AdaptiveAvailabilityV1Service,
  ) {}

  // Deliberately NOT rate limited.
  //
  // This is the container's own liveness probe: the compose healthcheck fetches
  // it every 15s and treats any non-2xx as failure, so a 429 here would report
  // the container unhealthy and fail the deploy gate. Host-local callers share
  // the same source address as that healthcheck, which makes the margin easy to
  // eat without noticing. Never put a limiter on a health endpoint.
  @Get('status')
  status(): AdaptiveStatusCompatibilityV1 {
    const refresh = this.refresh.getStatus();
    const local = this.evidence.getLocalStatus(refresh.identity);
    return {
      ...this.availability.getAvailability(),
      refresh,
      observability: this.observability.getStatus(),
      economyRulesBootstrap: this.economyRulesBootstrap.getStatus(),
      rulesetVersion: refresh.identity?.rulesetVersion,
      catalogSha256: refresh.identity?.catalogSha256,
      statlockerPatchId: local.statlockerPatchId,
      activeSnapshotIds: local.activeSnapshotIds,
      families: local.families,
    };
  }
}
