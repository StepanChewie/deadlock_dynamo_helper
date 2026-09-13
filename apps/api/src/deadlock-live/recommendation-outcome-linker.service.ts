import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { MatchPlayer } from './entities/match-player.entity';
import { heroIdAliases } from './hero-id-aliases';
import { RecommendationDecisionTelemetryService } from './recommendation-decision-telemetry.service';

const OUTCOME_LINK_INTERVAL_MS = 60_000;
const OUTCOME_LINK_BATCH_SIZE = 64;

@Injectable()
export class RecommendationOutcomeLinkerService implements OnModuleInit {
  private readonly logger = new Logger(
    RecommendationOutcomeLinkerService.name,
  );
  private running = false;

  constructor(
    private readonly telemetryService:
      RecommendationDecisionTelemetryService,
    @InjectRepository(MatchPlayer)
    private readonly matchPlayerRepository: Repository<MatchPlayer>,
  ) {}

  onModuleInit(): void {
    void this.linkPendingOutcomes();
  }

  @Interval(OUTCOME_LINK_INTERVAL_MS)
  async linkPendingOutcomes(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    let linkedCount = 0;
    try {
      const contexts = this.telemetryService.getPendingOutcomeContexts(
        OUTCOME_LINK_BATCH_SIZE,
      );
      for (const context of contexts) {
        const matchId = Number(context.matchId);
        if (!Number.isSafeInteger(matchId) || matchId <= 0) {
          continue;
        }
        const player = await this.matchPlayerRepository.findOne({
          where: {
            matchId,
            heroId: In([...heroIdAliases(context.heroId)]),
          },
        });
        if (!player) {
          continue;
        }
        const recorded = this.telemetryService.recordMatchOutcome({
          ...context,
          playerWon: player.won,
          source: 'HISTORICAL_MATCH_PLAYER',
        });
        linkedCount += recorded ? 1 : 0;
      }
      if (linkedCount > 0) {
        this.logger.log(
          `Linked ${linkedCount} recommendation telemetry outcome(s).`,
        );
      }
    } catch (error) {
      this.logger.warn(
        `Recommendation outcome linking failed: ${getErrorMessage(error)}`,
      );
    } finally {
      this.running = false;
    }
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
