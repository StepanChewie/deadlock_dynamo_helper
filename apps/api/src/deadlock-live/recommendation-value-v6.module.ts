import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Item } from './entities/item.entity';
import { RecommendationValueV6LiveService } from './recommendation-value-v6-live.service';
import { RecommendationValueV6ProductionSafeService } from './recommendation-value-v6-production-safe.service';
import { RecommendationValueV6TelemetryService } from './recommendation-value-v6-telemetry.service';
import { RecommendationValueV6TrainingController } from './recommendation-value-v6-training.controller';
import { RecommendationValueV6TrainingService } from './recommendation-value-v6-training.service';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([Item])],
  controllers: [
    RecommendationValueV6TrainingController,
  ],
  providers: [
    RecommendationValueV6TrainingService,
    RecommendationValueV6TelemetryService,
    RecommendationValueV6ProductionSafeService,
    {
      provide: RecommendationValueV6LiveService,
      useExisting: RecommendationValueV6ProductionSafeService,
    },
  ],
  exports: [
    RecommendationValueV6TrainingService,
    RecommendationValueV6LiveService,
    RecommendationValueV6TelemetryService,
  ],
})
export class RecommendationValueV6Module {}
