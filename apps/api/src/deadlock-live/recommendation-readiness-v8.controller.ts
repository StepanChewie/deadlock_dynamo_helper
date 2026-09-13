import { Controller, Get } from '@nestjs/common';
import { RecommendationReadinessV8Service } from './recommendation-readiness-v8.service';

@Controller('deadlock-live/recommendation-health')
export class RecommendationReadinessV8Controller {
  constructor(private readonly readiness: RecommendationReadinessV8Service) {}

  @Get('live')
  live() {
    return this.readiness.live();
  }

  @Get('ready')
  ready() {
    return this.readiness.ready();
  }

  @Get('recommendation/ready')
  recommendationReady() {
    return this.readiness.recommendationReady();
  }

  @Get('recommendation/degraded')
  recommendationDegraded() {
    return this.readiness.recommendationDegraded();
  }
}
