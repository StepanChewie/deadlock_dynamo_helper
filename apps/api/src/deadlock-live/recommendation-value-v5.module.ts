import { Module } from '@nestjs/common';
import { RecommendationValueV5TrainingController } from './recommendation-value-v5-training.controller';
import { RecommendationValueV5TrainingService } from './recommendation-value-v5-training.service';

@Module({
  controllers: [RecommendationValueV5TrainingController],
  providers: [RecommendationValueV5TrainingService],
  exports: [RecommendationValueV5TrainingService],
})
export class RecommendationValueV5Module {}
