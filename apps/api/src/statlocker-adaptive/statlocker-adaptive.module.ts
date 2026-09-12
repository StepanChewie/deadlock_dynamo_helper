import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';
import * as puppeteer from 'puppeteer-core';
import { DeadlockLiveModule } from '../deadlock-live/deadlock-live.module';
import { AdaptiveRecommendationDecisionV1Entity } from '../deadlock-live/entities/adaptive-recommendation-decision-v1.entity';
import { BuildArchetypeMatchLockV2Entity } from '../deadlock-live/entities/build-archetype-match-lock-v2.entity';
import { BuildArchetypeSnapshotV2Entity } from '../deadlock-live/entities/build-archetype-snapshot-v2.entity';
import { BuildStrategySnapshotV1Entity } from '../deadlock-live/entities/build-strategy-snapshot-v1.entity';
import { MatchPlayer } from '../deadlock-live/entities/match-player.entity';
import { RecommendationEconomyRulesSnapshotV1Entity } from '../deadlock-live/entities/recommendation-economy-rules-snapshot-v1.entity';
import { RecommendationItemCatalogItemV1 } from '../deadlock-live/entities/recommendation-item-catalog-item-v1.entity';
import { RecommendationItemCatalogRecipeV1 } from '../deadlock-live/entities/recommendation-item-catalog-recipe-v1.entity';
import { RecommendationItemCatalogVersionV1 } from '../deadlock-live/entities/recommendation-item-catalog-version-v1.entity';
import { StatlockerEvidenceSnapshotV1Entity } from '../deadlock-live/entities/statlocker-evidence-snapshot-v1.entity';
import { StatlockerVsHeroWpaRawSnapshotV1Entity } from '../deadlock-live/entities/statlocker-vs-hero-wpa-raw-snapshot-v1.entity';
import { StatlockerVsHeroWpaRowV1Entity } from '../deadlock-live/entities/statlocker-vs-hero-wpa-row-v1.entity';
import { AdaptiveBuildPlannerV1Service } from './adaptive-build-planner-v1.service';
import { AdaptiveChoiceResolverV1Service } from './adaptive-choice-resolver-v1.service';
import { AdaptiveDecisionStateV1Service } from './adaptive-decision-state-v1.service';
import { AdaptiveDecisionTraceV1Service } from './adaptive-decision-trace-v1.service';
import { AdaptiveEvidenceScorerV1Service } from './adaptive-evidence-scorer-v1.service';
import { AdaptivePhaseEligibilityV1Service } from './adaptive-phase-eligibility-v1.service';
import { AdaptivePlannerServingRouterV1Service } from './adaptive-planner-serving-router-v1.service';
import { AdaptiveRecommendationObservabilityV1Service } from './adaptive-recommendation-observability-v1.service';
import { AdaptiveRecommendationV2Controller } from './adaptive-recommendation-v2.controller';
import { AdaptiveRecommendationV2Service } from './adaptive-recommendation-v2.service';
import { AdaptiveReplayV1Service } from './adaptive-replay-v1.service';
import { AdaptiveStatusCompatibilityV1Controller } from './adaptive-status-compatibility-v1.controller';
import { BuildArchetypeCompilerV2Service } from './build-archetype-compiler-v2.service';
import { BuildArchetypeMinerV1Service } from './build-archetype-miner-v1.service';
import { BuildArchetypeMinerV2Service } from './build-archetype-miner-v2.service';
import { BuildArchetypeQualityGateV2Service } from './build-archetype-quality-gate-v2.service';
import { BuildArchetypeRefreshV2Service } from './build-archetype-refresh-v2.service';
import { BuildArchetypeSelectorV2Service } from './build-archetype-selector-v2.service';
import { BuildArchetypeSessionV2Service } from './build-archetype-session-v2.service';
import { BuildArchetypeSnapshotStoreV2Service } from './build-archetype-snapshot-store-v2.service';
import { BuildContractV1Service } from './build-contract-v1.service';
import { BuildDebugTraceStoreV2Service } from './build-debug-trace-store-v2.service';
import { BuildInvestmentPolicyV1Service } from './build-investment-policy-v1.service';
import { BuildItemUtilityV2Service } from './build-item-utility-v2.service';
import { BuildSituationalResolverV1Service } from './build-situational-resolver-v1.service';
import { BuildSkeletonService } from './build-skeleton.service';
import { BuildSlotPlannerV1Service } from './build-slot-planner-v1.service';
import { BuildStrategyCompilerV1Service } from './build-strategy-compiler-v1.service';
import { BuildStrategyFeasibilityV1Service } from './build-strategy-feasibility-v1.service';
import { BuildStrategyMiningPipelineV1Service } from './build-strategy-mining-pipeline-v1.service';
import { BuildStrategyRegistryV1Service } from './build-strategy-registry-v1.service';
import { BuildStrategySelectorV1Service } from './build-strategy-selector-v1.service';
import { BuildStrategySessionV1Service } from './build-strategy-session-v1.service';
import { BuildStrategySnapshotStoreV1Service } from './build-strategy-snapshot-store-v1.service';
import { BuildStrategyValidatorV1Service } from './build-strategy-validator-v1.service';
import { ConsensusStrategyFallbackV1Service } from './consensus-strategy-fallback-v1.service';
import { DraftMatchupEvidenceV1Service } from './draft-matchup-evidence-v1.service';
import { EnemyThreatHistoryV1Service } from './enemy-threat-history-v1.service';
import { EnemyThreatV1Service } from './enemy-threat-v1.service';
import { FamilyFirstFullBuildResolverV2Service } from './family-first-full-build-resolver-v2.service';
import { FullBuildMatchupProtectionV1Service } from './full-build-matchup-protection-v1.service';
import { FullBuildReplacementV2Service } from './full-build-replacement-v2.service';
import { FullBuildResolverV2Service } from './full-build-resolver-v2.service';
import { FullBuildSellRankerV1Service } from './full-build-sell-ranker-v1.service';
import { FullBuildTransitionValueV2Service } from './full-build-transition-value-v2.service';
import { HistoricalBuildTrajectorySourceV2Service } from './historical-build-trajectory-source-v2.service';
import { HistoricalPlannerTrajectoryExtractorV2Service } from './historical-planner-trajectory-extractor-v2.service';
import { MatchupCandidateDiscoveryV2Service } from './matchup-candidate-discovery-v2.service';
import { PlannerTrajectoryBuilderV2Service } from './planner-trajectory-builder-v2.service';
import { RecommendationEconomyRulesStoreV1Service } from './recommendation-economy-rules-store-v1.service';
import {
  STATLOCKER_BROWSER_LAUNCHER_V1,
  StatlockerBrowserCollectorService,
} from './statlocker-browser-collector.service';
import { StatlockerEvidenceService } from './statlocker-evidence.service';
import { StatlockerItemLifecycleRepositoryV1Service } from './statlocker-item-lifecycle-repository-v1.service';
import { StatlockerNormalizerService } from './statlocker-normalizer.service';
import { StatlockerRefreshService } from './statlocker-refresh.service';
import { StatlockerSnapshotStoreService } from './statlocker-snapshot-store.service';
import { StatlockerVsHeroWpaPublisherV1Service } from './statlocker-vs-hero-wpa-publisher-v1.service';
import { StatlockerVsHeroWpaRawStoreV1Service } from './statlocker-vs-hero-wpa-raw-store-v1.service';
import { StatlockerVsHeroWpaRepositoryV1Service } from './statlocker-vs-hero-wpa-repository-v1.service';
import { StatlockerVsHeroWpaRowNormalizerV1Service } from './statlocker-vs-hero-wpa-row-normalizer-v1.service';
import { StrategyFirstAdaptivePlannerFacadeV1Service } from './strategy-first-adaptive-planner-facade-v1.service';
import { StrategyFirstBuildPlannerV1Service } from './strategy-first-build-planner-v1.service';
import { StrategyFirstLegacyPlannerAdapterV1Service } from './strategy-first-legacy-planner-adapter-v1.service';
import { StrategyFirstOperationsV1Service } from './strategy-first-operations-v1.service';
import { StrategyFirstPromotionGateV1Service } from './strategy-first-promotion-gate-v1.service';
import { StrategyFirstSituationalOverlayV1Service } from './strategy-first-situational-overlay-v1.service';
import { StrategyFirstTransactionPlanV1Service } from './strategy-first-transaction-plan-v1.service';
import { ThreatWeightedMatchupV1Service } from './threat-weighted-matchup-v1.service';
import { TransactionPlanCompilerV1Service } from './transaction-plan-compiler-v1.service';
import { TransactionPlanReconcilerV1Service } from './transaction-plan-reconciler-v1.service';
import { TransactionPlanValidatorV1Service } from './transaction-plan-validator-v1.service';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    DeadlockLiveModule,
    TypeOrmModule.forFeature([
      RecommendationItemCatalogVersionV1,
      RecommendationItemCatalogItemV1,
      RecommendationItemCatalogRecipeV1,
      RecommendationEconomyRulesSnapshotV1Entity,
      StatlockerEvidenceSnapshotV1Entity,
      StatlockerVsHeroWpaRawSnapshotV1Entity,
      StatlockerVsHeroWpaRowV1Entity,
      AdaptiveRecommendationDecisionV1Entity,
      BuildArchetypeSnapshotV2Entity,
      BuildArchetypeMatchLockV2Entity,
      BuildStrategySnapshotV1Entity,
      MatchPlayer,
    ]),
  ],
  controllers: [AdaptiveRecommendationV2Controller, AdaptiveStatusCompatibilityV1Controller],
  providers: [
    {
      provide: STATLOCKER_BROWSER_LAUNCHER_V1,
      useValue: puppeteer,
    },
    StatlockerBrowserCollectorService,
    StatlockerNormalizerService,
    StatlockerSnapshotStoreService,
    StatlockerVsHeroWpaRawStoreV1Service,
    StatlockerVsHeroWpaPublisherV1Service,
    StatlockerVsHeroWpaRepositoryV1Service,
    StatlockerVsHeroWpaRowNormalizerV1Service,
    StatlockerEvidenceService,
    StatlockerItemLifecycleRepositoryV1Service,
    BuildSkeletonService,
    BuildArchetypeMinerV2Service,
    BuildArchetypeCompilerV2Service,
    BuildArchetypeQualityGateV2Service,
    BuildArchetypeSnapshotStoreV2Service,
    BuildArchetypeRefreshV2Service,
    BuildArchetypeSelectorV2Service,
    BuildArchetypeSessionV2Service,
    BuildDebugTraceStoreV2Service,
    BuildItemUtilityV2Service,
    FullBuildMatchupProtectionV1Service,
    FullBuildSellRankerV1Service,
    FullBuildReplacementV2Service,
    FullBuildTransitionValueV2Service,
    MatchupCandidateDiscoveryV2Service,
    FamilyFirstFullBuildResolverV2Service,
    {
      provide: FullBuildResolverV2Service,
      useExisting: FamilyFirstFullBuildResolverV2Service,
    },
    AdaptiveRecommendationV2Service,
    StatlockerRefreshService,
    RecommendationEconomyRulesStoreV1Service,
    AdaptiveDecisionStateV1Service,
    EnemyThreatV1Service,
    EnemyThreatHistoryV1Service,
    ThreatWeightedMatchupV1Service,
    DraftMatchupEvidenceV1Service,
    AdaptiveEvidenceScorerV1Service,
    AdaptiveDecisionTraceV1Service,
    AdaptivePhaseEligibilityV1Service,
    AdaptiveRecommendationObservabilityV1Service,
    AdaptiveChoiceResolverV1Service,
    PlannerTrajectoryBuilderV2Service,
    HistoricalPlannerTrajectoryExtractorV2Service,
    HistoricalBuildTrajectorySourceV2Service,
    BuildArchetypeMinerV1Service,
    BuildStrategyValidatorV1Service,
    BuildStrategyCompilerV1Service,
    BuildStrategyFeasibilityV1Service,
    BuildStrategyRegistryV1Service,
    BuildStrategySnapshotStoreV1Service,
    BuildStrategyMiningPipelineV1Service,
    BuildStrategySelectorV1Service,
    BuildStrategySessionV1Service,
    BuildContractV1Service,
    BuildSlotPlannerV1Service,
    BuildInvestmentPolicyV1Service,
    BuildSituationalResolverV1Service,
    ConsensusStrategyFallbackV1Service,
    StrategyFirstBuildPlannerV1Service,
    StrategyFirstSituationalOverlayV1Service,
    TransactionPlanCompilerV1Service,
    TransactionPlanValidatorV1Service,
    TransactionPlanReconcilerV1Service,
    StrategyFirstTransactionPlanV1Service,
    StrategyFirstAdaptivePlannerFacadeV1Service,
    StrategyFirstLegacyPlannerAdapterV1Service,
    StrategyFirstPromotionGateV1Service,
    StrategyFirstOperationsV1Service,
    AdaptivePlannerServingRouterV1Service,
    {
      provide: AdaptiveBuildPlannerV1Service,
      useExisting: AdaptivePlannerServingRouterV1Service,
    },
    AdaptiveReplayV1Service,
  ],
  exports: [
    AdaptiveRecommendationV2Service,
    AdaptiveRecommendationObservabilityV1Service,
    BuildDebugTraceStoreV2Service,
    StatlockerRefreshService,
    StatlockerEvidenceService,
    RecommendationEconomyRulesStoreV1Service,
    BuildArchetypeRefreshV2Service,
    BuildArchetypeSnapshotStoreV2Service,
    BuildArchetypeSelectorV2Service,
    BuildArchetypeSessionV2Service,
    BuildStrategyRegistryV1Service,
    BuildStrategySnapshotStoreV1Service,
    BuildStrategyMiningPipelineV1Service,
    StrategyFirstOperationsV1Service,
    StrategyFirstPromotionGateV1Service,
  ],
})
export class StatlockerAdaptiveModule {}
