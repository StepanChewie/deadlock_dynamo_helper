import { Injectable } from '@nestjs/common';
import { RecommendationRuntimeModeV8 } from '@deadlock-live-probe/shared';
import { RecommendationActionSelectionModeV8 } from './recommendation-decision-v8.service';
import { RecommendationRoadmapEvidenceService } from './recommendation-roadmap-evidence.service';

export interface RecommendationRuntimeTrustV8Input {
  runtimeMode: RecommendationRuntimeModeV8;
  selectionMode: RecommendationActionSelectionModeV8;
}

export interface RecommendationRuntimeTrustV8 {
  observabilityGatePassed: boolean;
  shadowGatePassed: boolean;
  safeExplorationAuthorized: boolean;
  futureTestUntouched: boolean;
  futureTestUnevaluated: boolean;
  blockers: readonly string[];
}

@Injectable()
export class RecommendationRuntimeTrustV8Service {
  constructor(private readonly roadmapEvidence: RecommendationRoadmapEvidenceService) {}

  async resolve(input: RecommendationRuntimeTrustV8Input): Promise<RecommendationRuntimeTrustV8> {
    const roadmap = await this.roadmapEvidence.report();
    const observabilityGatePassed = roadmap.evidence.observabilityCoverage === 'PASS';
    const shadowGatePassed = roadmap.evidence.shadowSafety === 'PASS';
    const futureTestUntouched = roadmap.evidence.futureTestUntouched;
    const futureTestUnevaluated = (roadmap.evidence.futureTestEvaluation ?? 'NOT_EVALUATED') === 'NOT_EVALUATED';
    const matchLevelAbPassed = roadmap.evidence.matchLevelAbSafety === 'PASS';
    const safeExplorationAuthorized = input.selectionMode !== 'SAFE_EXPLORATION'
      || (
        input.runtimeMode === 'LIVE'
        && matchLevelAbPassed
        && futureTestUntouched
        && futureTestUnevaluated
      );
    const blockers: string[] = [];

    if (input.selectionMode === 'SAFE_EXPLORATION') {
      if (input.runtimeMode !== 'LIVE') blockers.push('SAFE_EXPLORATION_REQUIRES_LIVE_RUNTIME');
      if (!matchLevelAbPassed) blockers.push('SAFE_EXPLORATION_REQUIRES_MATCH_LEVEL_AB_PASS');
      if (!futureTestUntouched) blockers.push('FUTURE_TEST_INTEGRITY_VIOLATION');
      if (!futureTestUnevaluated) blockers.push('SAFE_EXPLORATION_FORBIDDEN_AFTER_FUTURE_TEST');
    }

    return {
      observabilityGatePassed,
      shadowGatePassed,
      safeExplorationAuthorized,
      futureTestUntouched,
      futureTestUnevaluated,
      blockers: [...new Set(blockers)].sort(),
    };
  }
}
