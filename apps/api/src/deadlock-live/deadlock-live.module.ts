import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CatalogContentService } from './catalog-content.service';
import { DebugPageController } from './debug-page.controller';
import { HistoricalCatalogBackfillService } from './historical-catalog-backfill.service';
import { InventoryShadowReplayService } from './inventory-shadow-replay.service';
import { ItemCatalogImportService } from './item-catalog-import.service';
import { LiveIngestController } from './live-ingest.controller';
import { LiveInventoryEventNormalizerService } from './live-inventory-event-normalizer.service';
import { LiveMatchStateService } from './live-match-state.service';
import { RawEventLogService } from './raw-event-log.service';
import { RawMatchMetadataNormalizerService } from './raw-match-metadata-normalizer.service';
import { RawMatchMetadataService } from './raw-match-metadata.service';
import { RecentLiveEventsService } from './recent-live-events.service';
import { RecentMatchCrawlerService } from './recent-match-crawler.service';
import { RecentMatchRosterRepairService } from './recent-match-roster-repair.service';
import { RecentMatchesWindowController } from './recent-matches-window.controller';
import { RecentMatchesWindowService } from './recent-matches-window.service';
import { LazyRecentMatchesWindowService } from './lazy-recent-matches-window.service';
import { RecommendationCatalogContentV1Service } from './recommendation-catalog-content-v1.service';
import { ReferenceDataController } from './reference-data.controller';
import { ReferenceDataImportService } from './reference-data-import.service';
import { RulesetResolverService } from './ruleset-resolver.service';
import { RulesetResolutionRefreshService } from './ruleset-resolution-refresh.service';
import { RulesetWindowManifestService } from './ruleset-window-manifest.service';
import { SoulsAffordabilityEvidenceV2Controller } from './souls-affordability-evidence-v2.controller';
import { SoulsAffordabilityEvidenceV2Service } from './souls-affordability-evidence-v2.service';
import { StoredMatchReprocessingService } from './stored-match-reprocessing.service';
import { VersionedRecipeGraphService } from './versioned-recipe-graph.service';
import { CrawlerRun } from './entities/crawler-run.entity';
import { CrawlerState } from './entities/crawler-state.entity';
import { GameRuleset } from './entities/game-ruleset.entity';
import { Hero } from './entities/hero.entity';
import { ItemCatalogItem } from './entities/item-catalog-item.entity';
import { ItemCatalogRecipe } from './entities/item-catalog-recipe.entity';
import { ItemCatalogVersion } from './entities/item-catalog-version.entity';
import { ItemComponent } from './entities/item-component.entity';
import { Item } from './entities/item.entity';
import { MatchPlayerItem } from './entities/match-player-item.entity';
import { MatchPlayerSkillUpgrade } from './entities/match-player-skill-upgrade.entity';
import { MatchPlayer } from './entities/match-player.entity';
import { Match } from './entities/match.entity';
import { RawMatchMetadata } from './entities/raw-match-metadata.entity';
import { RecommendationItemCatalogItemV1 } from './entities/recommendation-item-catalog-item-v1.entity';
import { RecommendationItemCatalogRecipeV1 } from './entities/recommendation-item-catalog-recipe-v1.entity';
import { RecommendationItemCatalogVersionV1 } from './entities/recommendation-item-catalog-version-v1.entity';
import { SoulsAffordabilityEvidenceV2Entity } from './entities/souls-affordability-evidence-v2.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Match,
      MatchPlayer,
      MatchPlayerItem,
      MatchPlayerSkillUpgrade,
      Hero,
      Item,
      ItemComponent,
      CrawlerRun,
      CrawlerState,
      RawMatchMetadata,
      GameRuleset,
      ItemCatalogVersion,
      ItemCatalogItem,
      ItemCatalogRecipe,
      RecommendationItemCatalogVersionV1,
      RecommendationItemCatalogItemV1,
      RecommendationItemCatalogRecipeV1,
      SoulsAffordabilityEvidenceV2Entity,
    ]),
  ],
  controllers: [
    LiveIngestController,
    DebugPageController,
    RecentMatchesWindowController,
    ReferenceDataController,
    SoulsAffordabilityEvidenceV2Controller,
  ],
  providers: [
    LiveMatchStateService,
    LiveInventoryEventNormalizerService,
    InventoryShadowReplayService,
    RawEventLogService,
    RecentLiveEventsService,
    LazyRecentMatchesWindowService,
    {
      provide: RecentMatchesWindowService,
      useExisting: LazyRecentMatchesWindowService,
    },
    RecentMatchCrawlerService,
    RecentMatchRosterRepairService,
    RulesetResolverService,
    RulesetResolutionRefreshService,
    RawMatchMetadataService,
    RawMatchMetadataNormalizerService,
    StoredMatchReprocessingService,
    ItemCatalogImportService,
    CatalogContentService,
    HistoricalCatalogBackfillService,
    RulesetWindowManifestService,
    VersionedRecipeGraphService,
    RecommendationCatalogContentV1Service,
    SoulsAffordabilityEvidenceV2Service,
    ReferenceDataImportService,
  ],
  exports: [
    LiveMatchStateService,
    InventoryShadowReplayService,
    RawEventLogService,
    RecentLiveEventsService,
    RecentMatchesWindowService,
    RecentMatchCrawlerService,
    RecentMatchRosterRepairService,
    RulesetResolverService,
    RulesetResolutionRefreshService,
    RawMatchMetadataService,
    RawMatchMetadataNormalizerService,
    StoredMatchReprocessingService,
    ItemCatalogImportService,
    CatalogContentService,
    HistoricalCatalogBackfillService,
    RulesetWindowManifestService,
    VersionedRecipeGraphService,
    RecommendationCatalogContentV1Service,
    SoulsAffordabilityEvidenceV2Service,
    ReferenceDataImportService,
  ],
})
export class DeadlockLiveModule {}
