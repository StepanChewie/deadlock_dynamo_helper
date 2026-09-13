import { Injectable } from '@nestjs/common';
import {
  RecommendationValueTrainingReadinessV1,
  evaluateRecommendationValueTrainingReadinessV1,
} from '@deadlock-live-probe/shared';
import {
  RecommendationOpeReportOptionsV1,
  RecommendationOpeReportService,
  RecommendationOpeReportV1,
} from './recommendation-ope-report.service';
import { RecommendationRoadmapEvidenceService } from './recommendation-roadmap-evidence.service';

export interface RecommendationValueTrainingPreflightV8 {
  ready: boolean;
  blockers: readonly string[];
  readiness: RecommendationValueTrainingReadinessV1;
  ope: RecommendationOpeReportV1;
  safeExplorationPhaseUnlocked: boolean;
  futureTestUntouched: boolean;
  futureTestEvaluated: boolean;
}

@Injectable()
export class RecommendationValueTrainingLaunchV8Service {
  constructor(
    private readonly roadmapEvidence: RecommendationRoadmapEvidenceService,
    private readonly opeReports: RecommendationOpeReportService,
  ) {}

  async preflight(options: RecommendationOpeReportOptionsV1): Promise<RecommendationValueTrainingPreflightV8> {
    const [roadmap, ope] = await Promise.all([
      this.roadmapEvidence.report(),
      this.opeReports.buildReport(options),
    ]);
    const safeExplorationPhase = roadmap.state.phases.find((phase) => phase.phase === 'SAFE_EXPLORATION');
    const evaluation = ope.evaluation;
    const futureTestEvaluated = (roadmap.evidence.futureTestEvaluation ?? 'NOT_EVALUATED') !== 'NOT_EVALUATED';
    const readiness = evaluateRecommendationValueTrainingReadinessV1({
      safeExplorationPhaseUnlocked: safeExplorationPhase?.unlocked === true,
      exactActionPropensityPassed: roadmap.evidence.exactActionPropensity === 'PASS',
      safeExplorationSafetyPassed: roadmap.evidence.safeExplorationSafety === 'PASS',
      opeEvidenceSufficient: ope.evidenceSufficient,
      opeSupportPassed: evaluation?.passedSupportGate === true,
      randomizedDecisionCount: ope.randomizedDecisionCount,
      evaluableDecisionCount: ope.evaluableDecisionCount,
      excludedDecisionCount: ope.excludedDecisionCount,
      effectiveSampleSize: evaluation?.effectiveSampleSize ?? 0,
      effectiveSampleSizeRatio: evaluation?.effectiveSampleSizeRatio ?? 0,
      clippedDecisionRate: evaluation?.clippedDecisionRate ?? 0,
      futureTestUntouched: roadmap.evidence.futureTestUntouched,
      futureTestEvaluated,
    });
    const blockers = [
      ...readiness.blockers,
      ...(safeExplorationPhase?.blockers.map((blocker) => `ROADMAP_SAFE_EXPLORATION:${blocker}`) ?? []),
      ...ope.blockers.map((blocker) => `OPE:${blocker}`),
    ];
    return {
      ready: blockers.length === 0,
      blockers: [...new Set(blockers)].sort(),
      readiness,
      ope,
      safeExplorationPhaseUnlocked: safeExplorationPhase?.unlocked === true,
      futureTestUntouched: roadmap.evidence.futureTestUntouched,
      futureTestEvaluated,
    };
  }
}
