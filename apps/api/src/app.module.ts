import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BuildDebugV2Module } from './build-debug-v2/build-debug-v2.module';
import { databaseOptions } from './database/data-source';
import { DeadlockLiveModule } from './deadlock-live/deadlock-live.module';
import { RecommendationDatasetV5Module } from './deadlock-live/recommendation-dataset-v5.module';
import { RecommendationPolicyV6EvaluationModule } from './deadlock-live/recommendation-policy-v6-evaluation.module';
import { RecommendationValueV5Module } from './deadlock-live/recommendation-value-v5.module';
import { RecommendationValueV6Module } from './deadlock-live/recommendation-value-v6.module';
import { StatlockerAdaptiveModule } from './statlocker-adaptive/statlocker-adaptive.module';
import { StatlockerProbeModule } from './statlocker-probe/statlocker-probe.module';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    TypeOrmModule.forRoot({
      ...databaseOptions,
      migrationsRun: process.env.DB_RUN_MIGRATIONS === 'true',
    }),
    DeadlockLiveModule,
    RecommendationValueV5Module,
    RecommendationValueV6Module,
    RecommendationDatasetV5Module,
    RecommendationPolicyV6EvaluationModule,
    StatlockerAdaptiveModule,
    StatlockerProbeModule,
    BuildDebugV2Module,
  ],
})
export class AppModule {}
