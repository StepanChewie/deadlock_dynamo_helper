import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  createRecipeGraph as buildRecipeGraph,
  RecipeDefinition,
  RecipeGraph,
} from '@dynamo-lab/build-domain';
import { Repository } from 'typeorm';
import { CatalogContentService } from './catalog-content.service';
import { ItemCatalogRecipe } from './entities/item-catalog-recipe.entity';
import { ItemCatalogVersion } from './entities/item-catalog-version.entity';

@Injectable()
export class VersionedRecipeGraphService {
  constructor(
    @InjectRepository(ItemCatalogVersion)
    private readonly catalogVersionRepository: Repository<ItemCatalogVersion>,
    @InjectRepository(ItemCatalogRecipe)
    private readonly recipeRepository: Repository<ItemCatalogRecipe>,
    private readonly catalogContentService: CatalogContentService,
  ) {}

  async createRecipeGraph(clientVersion: number): Promise<RecipeGraph> {
    return buildRecipeGraph(await this.getRecipeDefinitions(clientVersion));
  }

  async getRecipeDefinitions(clientVersion: number): Promise<RecipeDefinition[]> {
    const catalog = await this.catalogVersionRepository.findOne({
      where: { clientVersion },
    });
    if (!catalog) {
      throw new Error(`No item catalog exists for client version ${clientVersion}`);
    }

    const contentCatalogVersionId = await this.catalogContentService.resolveContentCatalogVersionId(
      catalog.id,
    );
    const rows = await this.recipeRepository.find({
      where: { catalogVersionId: contentCatalogVersionId },
      order: { parentItemId: 'ASC', componentOrder: 'ASC' },
    });

    const componentsByParent = new Map<number, number[]>();
    for (const row of rows) {
      const parentItemId = Number(row.parentItemId);
      const componentItemId = Number(row.componentItemId);
      const components = componentsByParent.get(parentItemId) ?? [];
      components.push(componentItemId);
      componentsByParent.set(parentItemId, components);
    }

    return [...componentsByParent.entries()].map(([parentItemId, componentItemIds]) => ({
      parentItemId,
      componentItemIds,
    }));
  }

  async getDiagnostics(clientVersion: number) {
    const catalog = await this.catalogVersionRepository.findOne({
      where: { clientVersion },
    });
    if (!catalog) {
      throw new Error(`No item catalog exists for client version ${clientVersion}`);
    }

    const contentCatalogVersionId = await this.catalogContentService.resolveContentCatalogVersionId(
      catalog.id,
    );
    const definitions = await this.getRecipeDefinitions(clientVersion);
    return {
      clientVersion,
      catalogVersionId: catalog.id,
      contentCatalogVersionId,
      deduplicated: contentCatalogVersionId !== catalog.id,
      payloadHash: catalog.payloadHash,
      isCurrent: catalog.isCurrent,
      parentCount: definitions.length,
      componentLinkCount: definitions.reduce(
        (total, definition) => total + definition.componentItemIds.length,
        0,
      ),
      recipes: definitions,
    };
  }
}
