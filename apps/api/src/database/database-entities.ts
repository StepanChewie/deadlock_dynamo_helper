import { AdaptiveRecommendationDecisionV1Entity } from '../deadlock-live/entities/adaptive-recommendation-decision-v1.entity';
import { BuildArchetypeMatchLockV2Entity } from '../deadlock-live/entities/build-archetype-match-lock-v2.entity';
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
import { RawMatchMetadata } from '../deadlock-live/entities/raw-match-metadata.entity';
import { RecommendationEconomyRulesSnapshotV1Entity } from '../deadlock-live/entities/recommendation-economy-rules-snapshot-v1.entity';
import { RecommendationItemCatalogItemV1 } from '../deadlock-live/entities/recommendation-item-catalog-item-v1.entity';
import { RecommendationItemCatalogRecipeV1 } from '../deadlock-live/entities/recommendation-item-catalog-recipe-v1.entity';
import { RecommendationItemCatalogVersionV1 } from '../deadlock-live/entities/recommendation-item-catalog-version-v1.entity';
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
  SoulsAffordabilityEvidenceV2Entity,
  StatlockerEvidenceSnapshotV1Entity,
  StatlockerVsHeroWpaRawSnapshotV1Entity,
  StatlockerVsHeroWpaRowV1Entity,
  AdaptiveRecommendationDecisionV1Entity,
  BuildArchetypeMatchLockV2Entity,
  BuildArchetypeSnapshotV2Entity,
  BuildStrategySnapshotV1Entity,
  RecommendationEconomyRulesSnapshotV1Entity,
];
