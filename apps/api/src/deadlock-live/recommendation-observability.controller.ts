import { Controller, Get, Query } from '@nestjs/common';
import { RecommendationObservabilityReportService } from './recommendation-observability-report.service';

@Controller('deadlock-live/recommendation-observability/v1')
export class RecommendationObservabilityController {
  constructor(private readonly reportService: RecommendationObservabilityReportService) {}

  @Get('report')
  getReport(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('maximumAlignmentAgeMs') maximumAlignmentAgeMs?: string,
    @Query('candidateGeneratorVersion') candidateGeneratorVersion?: string,
  ) {
    return this.reportService.buildReport({
      from: parseOptionalDate(from, 'from'),
      to: parseOptionalDate(to, 'to'),
      maximumAlignmentAgeMs: parseOptionalNonNegativeInteger(maximumAlignmentAgeMs, 'maximumAlignmentAgeMs'),
      candidateGeneratorVersion,
    });
  }
}

function parseOptionalDate(value: string | undefined, name: string): Date | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`${name} must be an ISO date`);
  return date;
}

function parseOptionalNonNegativeInteger(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer`);
  return parsed;
}
