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
import { RecentLiveEventsService } from './recent-live-events.service';
import { RecommendationCatalogContentV1Service } from './recommendation-catalog-content-v1.service';
import { ReferenceDataController } from './reference-data.controller';
import { ReferenceDataImportService } from './reference-data-import.service';
import { RulesetWindowManifestService } from './ruleset-window-manifest.service';
import { SoulsAffordabilityEvidenceV2Controller } from './souls-affordability-evidence-v2.controller';
import { SoulsAffordabilityEvidenceV2Service } from './souls-affordability-evidence-v2.service';
import { VersionedRecipeGraphService } from './versioned-recipe-graph.service';
import { GameRuleset } from './entities/game-ruleset.entity';
import { Hero } from './entities/hero.entity';
import { ItemCatalogItem } from './entities/item-catalog-item.entity';
import { ItemCatalogRecipe } from './entities/item-catalog-recipe.entity';
import { ItemCatalogVersion } from './entities/item-catalog-version.entity';
import { ItemComponent } from './entities/item-component.entity';
import { Item } from './entities/item.entity';
import { RecommendationItemCatalogItemV1 } from './entities/recommendation-item-catalog-item-v1.entity';
import { RecommendationItemCatalogRecipeV1 } from './entities/recommendation-item-catalog-recipe-v1.entity';
import { RecommendationItemCatalogVersionV1 } from './entities/recommendation-item-catalog-version-v1.entity';
import { SoulsAffordabilityEvidenceV2Entity } from './entities/souls-affordability-evidence-v2.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Hero,
      Item,
      ItemComponent,
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
    ReferenceDataController,
    SoulsAffordabilityEvidenceV2Controller,
  ],
  providers: [
    LiveMatchStateService,
    LiveInventoryEventNormalizerService,
    InventoryShadowReplayService,
    RawEventLogService,
    RecentLiveEventsService,
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
