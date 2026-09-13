import { Controller, Get, Query } from '@nestjs/common';
import { RecommendationShadowReportService } from './recommendation-shadow-report.service';

@Controller('deadlock-live/recommendation-shadow/v1')
export class RecommendationShadowController {
  constructor(private readonly reportService: RecommendationShadowReportService) {}

  @Get('report')
  getReport(
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.reportService.buildReport({
      from: parseOptionalDate(from, 'from'),
      to: parseOptionalDate(to, 'to'),
    });
  }
}

function parseOptionalDate(value: string | undefined, name: string): Date | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`${name} must be an ISO date`);
  return parsed;
}
