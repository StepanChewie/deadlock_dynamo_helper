import { Controller, Get } from '@nestjs/common';
import { RecommendationValueV6LiveService } from './recommendation-value-v6-live.service';

@Controller('deadlock/analysis/recommendation-value-v6-live')
export class RecommendationValueV6LiveController {
  constructor(
    private readonly recommendationValueV6LiveService:
      RecommendationValueV6LiveService,
  ) {}

  @Get('status')
  getStatus() {
    return this.recommendationValueV6LiveService.getStatus();
  }
}
