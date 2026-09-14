import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';
import * as puppeteer from 'puppeteer-core';
import { DeadlockLiveModule } from '../deadlock-live/deadlock-live.module';
import { AdaptiveBuildIterationV1Entity } from '../deadlock-live/entities/adaptive-build-iteration-v1.entity';
import { BuildArchetypeMatchLockV2Entity } from '../deadlock-live/entities/build-archetype-match-lock-v2.entity';
import { BuildArchetypeSnapshotV2Entity } from '../deadlock-live/entities/build-archetype-snapshot-v2.entity';
import { RecommendationEconomyRulesSnapshotV1Entity } from '../deadlock-live/entities/recommendation-economy-rules-snapshot-v1.entity';
import { RecommendationItemCatalogItemV1 } from '../deadlock-live/entities/recommendation-item-catalog-item-v1.entity';
import { RecommendationItemCatalogRecipeV1 } from '../deadlock-live/entities/recommendation-item-catalog-recipe-v1.entity';
import { RecommendationItemCatalogVersionV1 } from '../deadlock-live/entities/recommendation-item-catalog-version-v1.entity';
import { StatlockerEvidenceSnapshotV1Entity } from '../deadlock-live/entities/statlocker-evidence-snapshot-v1.entity';
import { StatlockerVsHeroWpaRawSnapshotV1Entity } from '../deadlock-live/entities/statlocker-vs-hero-wpa-raw-snapshot-v1.entity';
import { StatlockerVsHeroWpaRowV1Entity } from '../deadlock-live/entities/statlocker-vs-hero-wpa-row-v1.entity';
import { AdaptiveDecisionStateV1Service } from './adaptive-decision-state-v1.service';
import { AdaptiveRecommendationObservabilityV1Service } from './adaptive-recommendation-observability-v1.service';
import { AdaptiveRecommendationV2Controller } from './adaptive-recommendation-v2.controller';
import { AdaptiveRecommendationV2Service } from './adaptive-recommendation-v2.service';
import { AdaptiveStatusCompatibilityV1Controller } from './adaptive-status-compatibility-v1.controller';
import { BuildArchetypeCompilerV2Service } from './build-archetype-compiler-v2.service';
import { BuildArchetypeMinerV2Service } from './build-archetype-miner-v2.service';
import { BuildArchetypeQualityGateV2Service } from './build-archetype-quality-gate-v2.service';
import { BuildArchetypeRefreshV2Service } from './build-archetype-refresh-v2.service';
import { BuildArchetypeSelectorV2Service } from './build-archetype-selector-v2.service';
import { BuildArchetypeSessionV2Service } from './build-archetype-session-v2.service';
import { BuildArchetypeSnapshotStoreV2Service } from './build-archetype-snapshot-store-v2.service';
import { BuildDebugTraceStoreV2Service } from './build-debug-trace-store-v2.service';
import { BuildItemUtilityV2Service } from './build-item-utility-v2.service';
import { BuildSkeletonService } from './build-skeleton.service';
import { EnemyThreatV1Service } from './enemy-threat-v1.service';
import { FamilyFirstFullBuildResolverV2Service } from './family-first-full-build-resolver-v2.service';
import { FullBuildMatchupProtectionV1Service } from './full-build-matchup-protection-v1.service';
import { FullBuildReplacementV2Service } from './full-build-replacement-v2.service';
import { FullBuildResolverV2Service } from './full-build-resolver-v2.service';
import { FullBuildSellRankerV1Service } from './full-build-sell-ranker-v1.service';
import { FullBuildTransactionPlannerV2Service } from './full-build-transaction-planner-v2.service';
import { FullBuildTransitionValueV2Service } from './full-build-transition-value-v2.service';
import { MatchupCandidateDiscoveryV2Service } from './matchup-candidate-discovery-v2.service';
import {
  RecommendationEconomyRulesBootstrapV1Service,
} from './recommendation-economy-rules-bootstrap-v1.service';
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
import { ThreatWeightedMatchupV1Service } from './threat-weighted-matchup-v1.service';

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
      BuildArchetypeSnapshotV2Entity,
      BuildArchetypeMatchLockV2Entity,
      AdaptiveBuildIterationV1Entity,
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
    FullBuildTransactionPlannerV2Service,
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
    RecommendationEconomyRulesBootstrapV1Service,
    AdaptiveDecisionStateV1Service,
    EnemyThreatV1Service,
    ThreatWeightedMatchupV1Service,
    AdaptiveRecommendationObservabilityV1Service,
  ],
  exports: [
    AdaptiveRecommendationV2Service,
    AdaptiveRecommendationObservabilityV1Service,
    RecommendationEconomyRulesBootstrapV1Service,
    BuildDebugTraceStoreV2Service,
    StatlockerRefreshService,
    StatlockerEvidenceService,
    RecommendationEconomyRulesStoreV1Service,
    BuildArchetypeRefreshV2Service,
    BuildArchetypeSnapshotStoreV2Service,
    BuildArchetypeSelectorV2Service,
    BuildArchetypeSessionV2Service,
  ],
})
export class StatlockerAdaptiveModule {}
