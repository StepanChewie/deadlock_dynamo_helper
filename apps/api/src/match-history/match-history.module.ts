import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppUserV1Entity } from './entities/app-user-v1.entity';
import { MatchHistoryV1Entity } from './entities/match-history-v1.entity';
import { MatchHistoryService } from './match-history.service';

@Module({
  imports: [TypeOrmModule.forFeature([AppUserV1Entity, MatchHistoryV1Entity])],
  providers: [MatchHistoryService],
  exports: [MatchHistoryService],
})
export class MatchHistoryModule {}
