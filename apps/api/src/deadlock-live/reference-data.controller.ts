import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { InternalApiGuard } from '../common/internal-api.guard';
import { CatalogContentService } from './catalog-content.service';
import {
  HistoricalCatalogBackfillService,
  ImportHistoricalCatalogBatchDto,
} from './historical-catalog-backfill.service';
import {
  ConfigureRulesetWindowDto,
  ImportItemCatalogsDto,
  ItemCatalogImportService,
} from './item-catalog-import.service';
import {
  ApplyRulesetWindowManifestDto,
  RulesetWindowManifestService,
} from './ruleset-window-manifest.service';
import { VersionedRecipeGraphService } from './versioned-recipe-graph.service';

// Operator-only: catalog imports and ruleset mutations change what every client
// is recommended, so the whole controller is behind the internal key.
@Controller('deadlock/reference-data')
@UseGuards(InternalApiGuard)
export class ReferenceDataController {
  constructor(
    private readonly itemCatalogImportService: ItemCatalogImportService,
    private readonly catalogContentService: CatalogContentService,
    private readonly historicalCatalogBackfillService: HistoricalCatalogBackfillService,
    private readonly rulesetWindowManifestService: RulesetWindowManifestService,
    private readonly versionedRecipeGraphService: VersionedRecipeGraphService,
  ) {}

  @Get('catalogs/available')
  async getAvailableCatalogVersions() {
    const clientVersions = await this.itemCatalogImportService.getAvailableClientVersions();
    return {
      count: clientVersions.length,
      latestClientVersion: clientVersions[clientVersions.length - 1],
      clientVersions,
    };
  }

  @Get('catalogs')
  async getCatalogs() {
    return this.catalogContentService.listCatalogs();
  }

  @Post('catalogs/import')
  async importCatalogs(@Body() dto: ImportItemCatalogsDto) {
    const result = await this.itemCatalogImportService.importCatalogs(dto ?? {});
    const imported = [];
    for (const entry of result.imported) {
      const deduplication = await this.catalogContentService.deduplicateCatalogVersion(
        entry.catalogVersionId,
      );
      imported.push({
        ...entry,
        ...deduplication,
        itemCount: deduplication.itemCount,
        recipeCount: deduplication.recipeCount,
      });
    }
    return { ...result, imported };
  }

  @Get('catalogs/history/status')
  async getHistoricalCatalogBackfillStatus() {
    return this.historicalCatalogBackfillService.getStatus();
  }

  @Post('catalogs/history/import')
  async importHistoricalCatalogBatch(@Body() dto: ImportHistoricalCatalogBatchDto) {
    return this.historicalCatalogBackfillService.importBatch(dto ?? {});
  }

  @Get('catalogs/:clientVersion/recipes')
  async getCatalogRecipes(
    @Param('clientVersion', ParseIntPipe) clientVersion: number,
  ) {
    return this.versionedRecipeGraphService.getDiagnostics(clientVersion);
  }

  @Get('rulesets')
  async getRulesets() {
    return this.itemCatalogImportService.listRulesets();
  }

  @Get('rulesets/windows/status')
  async getRulesetWindowStatus() {
    return this.rulesetWindowManifestService.getStatus();
  }

  @Post('rulesets/windows/validate')
  async validateRulesetWindowManifest(@Body() dto: ApplyRulesetWindowManifestDto) {
    return this.rulesetWindowManifestService.validateManifest(dto ?? {});
  }

  @Put('rulesets/windows')
  async applyRulesetWindowManifest(@Body() dto: ApplyRulesetWindowManifestDto) {
    return this.rulesetWindowManifestService.applyManifest(dto ?? {});
  }

  @Put('rulesets/:clientVersion/window')
  async configureRulesetWindow(
    @Param('clientVersion', ParseIntPipe) clientVersion: number,
    @Body() dto: ConfigureRulesetWindowDto,
  ) {
    return this.itemCatalogImportService.configureRulesetWindow(clientVersion, dto ?? {});
  }
}
