import { Controller, Get, Param, Query } from '@nestjs/common';
import { RecommendationFeatureStoreV8Service } from './recommendation-feature-store-v8.service';

@Controller('deadlock-live/recommendation-features/v8')
export class RecommendationFeatureStoreV8Controller {
  constructor(private readonly featureStore: RecommendationFeatureStoreV8Service) {}

  @Get('decisions/:decisionId')
  buildForDecision(
    @Param('decisionId') decisionId: string,
    @Query('maximumAlignmentAgeMs') maximumAlignmentAgeMs?: string,
    @Query('maximumHistoryEvents') maximumHistoryEvents?: string,
  ) {
    return this.featureStore.buildForDecision(
      decisionId,
      parseNonNegativeInteger(maximumAlignmentAgeMs, 5_000, 'maximumAlignmentAgeMs'),
      parseNonNegativeInteger(maximumHistoryEvents, 64, 'maximumHistoryEvents'),
    );
  }
}

function parseNonNegativeInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer`);
  return parsed;
}
