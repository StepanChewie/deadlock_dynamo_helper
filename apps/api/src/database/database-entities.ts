import { AdaptiveRecommendationDecisionV1Entity } from '../deadlock-live/entities/adaptive-recommendation-decision-v1.entity';
import { BuildArchetypeSnapshotV2Entity } from '../deadlock-live/entities/build-archetype-snapshot-v2.entity';
import { BuildStrategySnapshotV1Entity } from '../deadlock-live/entities/build-strategy-snapshot-v1.entity';
import { CrawlerRun } from '../deadlock-live/entities/crawler-run.entity';
import { CrawlerState } from '../deadlock-live/entities/crawler-state.entity';
import { GameRuleset } from '../deadlock-live/entities/game-ruleset.entity';
import { Hero } from '../deadlock-live/entities/hero.entity';
import { ItemCatalogItem } from '../deadlock-live/entities/item-catalog-item.entity';
import { ItemCatalogRecipe } from '../deadlock-live/entities/item-catalog-recipe.entity';
import { ItemCatalogVersion } from '../deadlock-live/entities/item-catalog-version.entity';
import { ItemComponent } from '../deadlock-live/entities/item-component.entity';
import { Item } from '../deadlock-live/entities/item.entity';
import { MatchPlayerItem } from '../deadlock-live/entities/match-player-item.entity';
import { MatchPlayerSkillUpgrade } from '../deadlock-live/entities/match-player-skill-upgrade.entity';
import { MatchPlayer } from '../deadlock-live/entities/match-player.entity';
import { Match } from '../deadlock-live/entities/match.entity';
import { ModelBundleRegistryV1 } from '../deadlock-live/entities/model-bundle-registry.entity';
import { RawMatchMetadata } from '../deadlock-live/entities/raw-match-metadata.entity';
import { RecommendationDatasetRegistryV1 } from '../deadlock-live/entities/recommendation-dataset-registry.entity';
import { RecommendationDecisionCandidateV8 } from '../deadlock-live/entities/recommendation-decision-candidate.entity';
import { RecommendationDecisionV8 } from '../deadlock-live/entities/recommendation-decision.entity';
import { RecommendationEconomyRulesSnapshotV1Entity } from '../deadlock-live/entities/recommendation-economy-rules-snapshot-v1.entity';
import { RecommendationEvidenceSnapshotV8 } from '../deadlock-live/entities/recommendation-evidence-snapshot-v8.entity';
import { RecommendationExposureAckV8 } from '../deadlock-live/entities/recommendation-exposure-ack.entity';
import { RecommendationItemCatalogItemV1 } from '../deadlock-live/entities/recommendation-item-catalog-item-v1.entity';
import { RecommendationItemCatalogRecipeV1 } from '../deadlock-live/entities/recommendation-item-catalog-recipe-v1.entity';
import { RecommendationItemCatalogVersionV1 } from '../deadlock-live/entities/recommendation-item-catalog-version-v1.entity';
import { RecommendationRoadmapEvidenceEntityV1 } from '../deadlock-live/entities/recommendation-roadmap-evidence.entity';
import { RecommendationTelemetryEvent } from '../deadlock-live/entities/recommendation-telemetry-event.entity';
import { RecommendationTelemetryRejectionV8 } from '../deadlock-live/entities/recommendation-telemetry-rejection.entity';
import { RecommendationValueDatasetRegistryV1 } from '../deadlock-live/entities/recommendation-value-dataset-registry.entity';
import { SoulsAffordabilityEvidenceV2Entity } from '../deadlock-live/entities/souls-affordability-evidence-v2.entity';
import { StatlockerEvidenceSnapshotV1Entity } from '../deadlock-live/entities/statlocker-evidence-snapshot-v1.entity';
import { StatlockerVsHeroWpaRawSnapshotV1Entity } from '../deadlock-live/entities/statlocker-vs-hero-wpa-raw-snapshot-v1.entity';
import { StatlockerVsHeroWpaRowV1Entity } from '../deadlock-live/entities/statlocker-vs-hero-wpa-row-v1.entity';

export const DATABASE_ENTITIES = [
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
  RecommendationTelemetryEvent,
  RecommendationTelemetryRejectionV8,
  RecommendationDecisionV8,
  RecommendationDecisionCandidateV8,
  RecommendationEvidenceSnapshotV8,
  RecommendationExposureAckV8,
  SoulsAffordabilityEvidenceV2Entity,
  StatlockerEvidenceSnapshotV1Entity,
  StatlockerVsHeroWpaRawSnapshotV1Entity,
  StatlockerVsHeroWpaRowV1Entity,
  AdaptiveRecommendationDecisionV1Entity,
  BuildArchetypeSnapshotV2Entity,
  BuildStrategySnapshotV1Entity,
  RecommendationEconomyRulesSnapshotV1Entity,
  ModelBundleRegistryV1,
  RecommendationDatasetRegistryV1,
  RecommendationValueDatasetRegistryV1,
  RecommendationRoadmapEvidenceEntityV1,
];
