import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
} from '@nestjs/common';
import { RecommendationDecisionTelemetryService } from './recommendation-decision-telemetry.service';

export class RecordRecommendationMatchOutcomeDto {
  matchId!: string;
  steamId!: string;
  heroId!: number;
  teamId?: number;
  playerWon!: boolean;
}

@Controller('deadlock/analysis/recommendation-telemetry')
export class RecommendationDecisionTelemetryController {
  constructor(
    private readonly telemetryService:
      RecommendationDecisionTelemetryService,
  ) {}

  @Get('status')
  getStatus() {
    return this.telemetryService.getStatus();
  }

  @Post('outcome')
  @HttpCode(200)
  recordOutcome(@Body() dto: RecordRecommendationMatchOutcomeDto) {
    validateOutcomeRequest(dto);
    const recorded = this.telemetryService.recordMatchOutcome({
      matchId: dto.matchId.trim(),
      steamId: dto.steamId.trim(),
      heroId: dto.heroId,
      teamId: dto.teamId,
      playerWon: dto.playerWon,
      source: 'MANUAL',
    });
    return {
      recorded,
      status: this.telemetryService.getStatus(),
    };
  }
}

function validateOutcomeRequest(
  dto: RecordRecommendationMatchOutcomeDto,
): void {
  if (typeof dto?.matchId !== 'string' || !dto.matchId.trim()) {
    throw new BadRequestException('matchId must be a non-empty string.');
  }
  if (typeof dto.steamId !== 'string' || !dto.steamId.trim()) {
    throw new BadRequestException('steamId must be a non-empty string.');
  }
  if (!Number.isSafeInteger(dto.heroId) || dto.heroId <= 0) {
    throw new BadRequestException(
      'heroId must be a positive safe integer.',
    );
  }
  if (
    dto.teamId !== undefined &&
    (!Number.isSafeInteger(dto.teamId) || dto.teamId < 0)
  ) {
    throw new BadRequestException(
      'teamId must be a non-negative safe integer.',
    );
  }
  if (typeof dto.playerWon !== 'boolean') {
    throw new BadRequestException('playerWon must be a boolean.');
  }
}
