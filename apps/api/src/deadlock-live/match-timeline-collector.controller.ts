import {
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
} from '@nestjs/common';
import { MatchTimelineCollectorService } from './match-timeline-collector.service';

class StartTimelineCollectionDto {
  matchId!: number;
}

@Controller('deadlock/analysis/match-timeline-collector')
export class MatchTimelineCollectorController {
  constructor(private readonly collectorService: MatchTimelineCollectorService) {}

  @Get('status')
  getStatus() {
    return this.collectorService.getStatus();
  }

  @Post('poll')
  @HttpCode(202)
  async poll() {
    await this.collectorService.pollActiveMatches();
    return this.collectorService.getStatus();
  }

  @Post('start')
  @HttpCode(202)
  async start(@Body() request: StartTimelineCollectionDto) {
    try {
      return await this.collectorService.startMatch(Number(request.matchId));
    } catch (error) {
      throw new ConflictException(getErrorMessage(error));
    }
  }

  @Post(':matchId/stop')
  stop(@Param('matchId') matchId: string) {
    try {
      return this.collectorService.stopMatch(Number(matchId));
    } catch (error) {
      throw new ConflictException(getErrorMessage(error));
    }
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
