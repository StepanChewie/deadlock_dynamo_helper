import { AdaptiveBuildIterationV1Entity } from '../deadlock-live/entities/adaptive-build-iteration-v1.entity';
import { AdaptiveFeedbackV1Entity } from '../deadlock-live/entities/adaptive-feedback-v1.entity';
import { BuildArchetypeMatchLockV2Entity } from '../deadlock-live/entities/build-archetype-match-lock-v2.entity';
import { BuildArchetypeSnapshotV2Entity } from '../deadlock-live/entities/build-archetype-snapshot-v2.entity';
import { GameRuleset } from '../deadlock-live/entities/game-ruleset.entity';
import { Hero } from '../deadlock-live/entities/hero.entity';
import { ItemCatalogItem } from '../deadlock-live/entities/item-catalog-item.entity';
import { ItemCatalogRecipe } from '../deadlock-live/entities/item-catalog-recipe.entity';
import { ItemCatalogVersion } from '../deadlock-live/entities/item-catalog-version.entity';
import { ItemComponent } from '../deadlock-live/entities/item-component.entity';
import { Item } from '../deadlock-live/entities/item.entity';
import { RecommendationEconomyRulesSnapshotV1Entity } from '../deadlock-live/entities/recommendation-economy-rules-snapshot-v1.entity';
import { RecommendationItemCatalogItemV1 } from '../deadlock-live/entities/recommendation-item-catalog-item-v1.entity';
import { RecommendationItemCatalogRecipeV1 } from '../deadlock-live/entities/recommendation-item-catalog-recipe-v1.entity';
import { RecommendationItemCatalogVersionV1 } from '../deadlock-live/entities/recommendation-item-catalog-version-v1.entity';
import { SoulsAffordabilityEvidenceV2Entity } from '../deadlock-live/entities/souls-affordability-evidence-v2.entity';
import { StatlockerEvidenceSnapshotV1Entity } from '../deadlock-live/entities/statlocker-evidence-snapshot-v1.entity';
import { StatlockerVsHeroWpaRawSnapshotV1Entity } from '../deadlock-live/entities/statlocker-vs-hero-wpa-raw-snapshot-v1.entity';
import { StatlockerVsHeroWpaRowV1Entity } from '../deadlock-live/entities/statlocker-vs-hero-wpa-row-v1.entity';

export const DATABASE_ENTITIES = [
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
  StatlockerEvidenceSnapshotV1Entity,
  StatlockerVsHeroWpaRawSnapshotV1Entity,
  StatlockerVsHeroWpaRowV1Entity,
  BuildArchetypeMatchLockV2Entity,
  BuildArchetypeSnapshotV2Entity,
  RecommendationEconomyRulesSnapshotV1Entity,
  AdaptiveBuildIterationV1Entity,
  // Registered here as well as via `forFeature` in the statlocker-adaptive
  // module: this list is what the standalone `AppDataSource` knows about, and
  // scripts that use it directly (delete-match-data) cannot reach an entity
  // that only `forFeature` registered.
  AdaptiveFeedbackV1Entity,
];
