import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BuildDebugV2Module } from './build-debug-v2/build-debug-v2.module';
import { databaseOptions } from './database/data-source';
import { DeadlockLiveModule } from './deadlock-live/deadlock-live.module';
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
    StatlockerAdaptiveModule,
    StatlockerProbeModule,
    BuildDebugV2Module,
  ],
})
export class AppModule {}
