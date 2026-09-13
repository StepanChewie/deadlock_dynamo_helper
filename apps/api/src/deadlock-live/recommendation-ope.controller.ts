import { Controller, Get, Query } from '@nestjs/common';
import {
  RecommendationOpeReportService,
  RecommendationOpeRewardV1,
} from './recommendation-ope-report.service';

@Controller('deadlock-live/recommendation-ope/v1')
export class RecommendationOpeController {
  constructor(private readonly reportService: RecommendationOpeReportService) {}

  @Get('report')
  getReport(
    @Query('reward') reward: string = 'economyDelta300s',
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.reportService.buildReport({
      reward: parseReward(reward),
      from: parseOptionalDate(from, 'from'),
      to: parseOptionalDate(to, 'to'),
    });
  }
}

function parseReward(value: string): RecommendationOpeRewardV1 {
  if (
    value === 'economyDelta120s'
    || value === 'economyDelta300s'
    || value === 'objectiveDelta300s'
    || value === 'finalPlayerWon'
  ) return value;
  throw new Error('reward must be economyDelta120s, economyDelta300s, objectiveDelta300s or finalPlayerWon');
}

function parseOptionalDate(value: string | undefined, name: string): Date | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`${name} must be an ISO date`);
  return parsed;
}
