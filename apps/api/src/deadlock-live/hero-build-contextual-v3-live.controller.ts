import { Controller, Get, HttpCode, Post } from '@nestjs/common';
import { HeroBuildContextualV3LiveService } from './hero-build-contextual-v3-live.service';
import { ProductionHeroBuildRecommendationService } from './production-hero-build-recommendation.service';

@Controller('deadlock/analysis/contextual-v3-live')
export class HeroBuildContextualV3LiveController {
  constructor(
    private readonly liveService: HeroBuildContextualV3LiveService,
    private readonly productionService: ProductionHeroBuildRecommendationService,
  ) {}

  @Get('status')
  getStatus() {
    return this.productionService.getStatus();
  }

  @Post('reload')
  @HttpCode(200)
  async reload() {
    await this.liveService.reload();
    return this.productionService.getStatus();
  }
}
