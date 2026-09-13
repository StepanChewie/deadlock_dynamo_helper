import { Module } from '@nestjs/common';
import { MatchTimelineCollectorController } from './match-timeline-collector.controller';
import { MatchTimelineCollectorService } from './match-timeline-collector.service';
import { RecommendationDecisionDatasetV5Controller } from './recommendation-decision-dataset-v5.controller';
import { RecommendationDecisionDatasetV5Service } from './recommendation-decision-dataset-v5.service';

@Module({
  controllers: [
    MatchTimelineCollectorController,
    RecommendationDecisionDatasetV5Controller,
  ],
  providers: [
    MatchTimelineCollectorService,
    RecommendationDecisionDatasetV5Service,
  ],
  exports: [
    MatchTimelineCollectorService,
    RecommendationDecisionDatasetV5Service,
  ],
})
export class RecommendationDatasetV5Module {}
