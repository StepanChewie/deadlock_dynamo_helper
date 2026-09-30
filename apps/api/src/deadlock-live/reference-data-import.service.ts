import axios from 'axios';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RecommendationCatalogContentV1Service } from './recommendation-catalog-content-v1.service';
import { ItemCatalogImportService } from './item-catalog-import.service';
import { Hero } from './entities/hero.entity';
import { ItemComponent } from './entities/item-component.entity';
import { Item } from './entities/item.entity';
import { getDeadlockApiRequestConfig } from './deadlock-api-request';
import { HERO_REFERENCE_SEED, ITEM_REFERENCE_SEED } from './reference-data.seed';

@Injectable()
export class ReferenceDataImportService implements OnModuleInit {
  private readonly logger = new Logger(ReferenceDataImportService.name);
  private recommendationCatalogRefreshInFlight = false;

  constructor(
    @InjectRepository(Hero)
    private readonly heroRepo: Repository<Hero>,
    @InjectRepository(Item)
    private readonly itemRepo: Repository<Item>,
    @InjectRepository(ItemComponent)
    private readonly itemComponentRepo: Repository<ItemComponent>,
    private readonly recommendationCatalogContentService: RecommendationCatalogContentV1Service,
    private readonly itemCatalogImportService: ItemCatalogImportService,
  ) {}

  async onModuleInit() {
    await this.importIfNeeded();
  }

  async importIfNeeded() {
    await this.importHeroesIfNeeded();
    await this.importItemsIfNeeded();
    await this.syncItemsFromAssets();
  }

  /**
   * Keeps the recommendation catalog following the game.
   *
   * `syncItemsFromAssets` runs only from `onModuleInit`, so a patch that lands while the
   * container is up used to stay invisible until the next deploy — and the item catalog is
   * the one input a Deadlock patch reliably changes (6712/6722 added three items, 726 -> 729).
   * One cheap assets GET per tick: `importAssetsSnapshot` dedupes on the payload hash, so an
   * unchanged catalog costs a lookup and two counts, and only a genuinely new payload writes.
   *
   * Deliberately does NOT re-run the legacy `items` / `item_components` sync that
   * `syncItemsFromAssets` also performs. That one deletes and re-inserts every row, and
   * nothing on the recommendation path reads it.
   */
  @Cron('*/15 * * * *')
  async refreshRecommendationCatalog(): Promise<void> {
    if (this.recommendationCatalogRefreshInFlight) return;
    this.recommendationCatalogRefreshInFlight = true;
    try {
      const availableClientVersions = await this.itemCatalogImportService.getAvailableClientVersions();
      const latestClientVersion = availableClientVersions[availableClientVersions.length - 1];
      if (!latestClientVersion) return;

      const assets = await this.fetchAssets(latestClientVersion);
      if (assets.length === 0) return;

      const catalog = await this.recommendationCatalogContentService.importAssetsSnapshot({
        assets,
        clientVersion: String(latestClientVersion),
        contentCatalogVersionId: process.env.DEADLOCK_CONTENT_CATALOG_VERSION,
        rulesetKey: `client-${latestClientVersion}`,
      });
      if (!catalog.created) return;

      // A new row becomes `rulesetId` for every decision, which orphans the evidence and
      // archetype snapshots stamped with the previous identity. That is expected and
      // self-healing — the next request observes the new identity and rebuilds its own hero
      // (see `StatlockerEvidenceService.warmUpIdentity`) — but it is the event worth seeing
      // in the log when builds go quiet after a patch.
      this.logger.log(
        `New recommendation item catalog ${catalog.catalogVersionId} for client `
        + `${latestClientVersion} (${catalog.itemCount} items, ${catalog.recipeCount} recipes) `
        + `- decision identity rolled over to ${catalog.rulesetKey}`,
      );
    } catch (error) {
      this.logger.warn(`Scheduled recommendation catalog refresh failed: ${(error as Error).message}`);
    } finally {
      this.recommendationCatalogRefreshInFlight = false;
    }
  }

  private async importHeroesIfNeeded() {
    if (await this.heroRepo.count()) {
      return;
    }

    const heroes = HERO_REFERENCE_SEED.map((hero) =>
      this.heroRepo.create({
        heroId: hero.hero_id,
        name: hero.name,
      }),
    );

    await this.heroRepo.save(heroes);
    this.logger.log(`Imported ${heroes.length} heroes into PostgreSQL`);
  }

  private async importItemsIfNeeded() {
    if (await this.itemRepo.count()) {
      return;
    }

    const items = ITEM_REFERENCE_SEED.map((item) =>
      this.itemRepo.create({
        itemId: item.itemId,
        name: item.name,
        className: item.class_name,
        itemSlotType: item.item_slot_type,
        cost: item.cost,
        itemTier: item.item_tier,
      }),
    );

    await this.itemRepo.save(items);
    this.logger.log(`Imported ${items.length} items into PostgreSQL`);
  }

  // The assets payload is untyped upstream and `syncItemsFromAssets` narrows it field by
  // field, so the element type stays loose here — the same shape axios handed back before
  // this was extracted.
  private async fetchAssets(clientVersion: number): Promise<any[]> {
    const response = await axios.get('https://api.deadlock-api.com/v1/assets/items', {
      ...getDeadlockApiRequestConfig(),
      params: { client_version: clientVersion },
    });
    return Array.isArray(response.data) ? response.data : [];
  }

  private async syncItemsFromAssets() {
    try {
      const availableClientVersions = await this.itemCatalogImportService.getAvailableClientVersions();
      const latestClientVersion = availableClientVersions[availableClientVersions.length - 1];
      if (!latestClientVersion) {
        throw new Error('Deadlock API returned no available client versions');
      }
      await this.itemCatalogImportService.importCatalogs({ clientVersions: [latestClientVersion] });
      const assets = await this.fetchAssets(latestClientVersion);
      if (assets.length === 0) {
        return;
      }

      const catalog = await this.recommendationCatalogContentService.importAssetsSnapshot({
        assets,
        clientVersion: String(latestClientVersion),
        contentCatalogVersionId: process.env.DEADLOCK_CONTENT_CATALOG_VERSION,
        rulesetKey: `client-${latestClientVersion}`,
      });
      this.logger.log(
        `${catalog.created ? 'Created' : 'Reused'} immutable item catalog ${catalog.catalogVersionId} `
        + `with ${catalog.itemCount} items and ${catalog.recipeCount} recipe links`,
      );

      const shopItems = assets
        .filter(
          (item) =>
            item &&
            item.shopable === true &&
            typeof item.id === 'number' &&
            typeof item.name === 'string' &&
            typeof item.class_name === 'string' &&
            typeof item.item_slot_type === 'string',
        )
        .map((item) => ({
          itemId: item.id,
          name: item.name,
          className: item.class_name,
          itemSlotType: item.item_slot_type,
          cost: typeof item.cost === 'number' ? item.cost : 0,
          itemTier: typeof item.item_tier === 'number' ? item.item_tier : 0,
          componentClassNames: Array.isArray(item.component_items)
            ? item.component_items.filter((component: unknown): component is string => typeof component === 'string')
            : [],
        }));

      if (shopItems.length === 0) {
        return;
      }

      const existingItems = await this.itemRepo.find();
      const existingByItemId = new Map(existingItems.map((item) => [String(item.itemId), item]));

      const syncedItems = await this.itemRepo.save(
        shopItems.map((item) =>
          this.itemRepo.create({
            id: existingByItemId.get(String(item.itemId))?.id,
            itemId: item.itemId,
            name: item.name,
            className: item.className,
            itemSlotType: item.itemSlotType,
            cost: item.cost,
            itemTier: item.itemTier,
          }),
        ),
      );

      const itemIdByClassName = new Map(syncedItems.map((item) => [item.className, Number(item.itemId)]));
      const componentRows: ItemComponent[] = [];

      for (const item of shopItems) {
        const parentItemId = item.itemId;
        item.componentClassNames.forEach((componentClassName: string, index: number) => {
          const componentItemId = itemIdByClassName.get(componentClassName);
          if (!componentItemId) {
            return;
          }

          componentRows.push(
            this.itemComponentRepo.create({
              parentItemId,
              componentItemId,
              componentOrder: index,
            }),
          );
        });
      }

      await this.itemComponentRepo.createQueryBuilder().delete().from(ItemComponent).execute();
      if (componentRows.length > 0) {
        await this.itemComponentRepo.save(componentRows);
      }

      this.logger.log(`Synchronized ${syncedItems.length} items and ${componentRows.length} item-component links from assets API`);
    } catch (error) {
      this.logger.warn(`Failed to synchronize item recipes from assets API: ${(error as Error).message}`);
    }
  }
}
