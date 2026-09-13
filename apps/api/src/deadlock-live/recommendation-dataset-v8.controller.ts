import { Controller, Get, Query } from '@nestjs/common';
import { RecommendationDatasetV8ReportService } from './recommendation-dataset-v8-report.service';

@Controller('deadlock-live/recommendation-dataset/v8')
export class RecommendationDatasetV8Controller {
  constructor(private readonly reportService: RecommendationDatasetV8ReportService) {}

  @Get('report')
  getReport(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('candidateGeneratorVersion') candidateGeneratorVersion?: string,
  ) {
    return this.reportService.buildReport({
      from: parseOptionalDate(from, 'from'),
      to: parseOptionalDate(to, 'to'),
      candidateGeneratorVersion,
    });
  }
}

function parseOptionalDate(value: string | undefined, name: string): Date | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`${name} must be an ISO date`);
  return parsed;
}
