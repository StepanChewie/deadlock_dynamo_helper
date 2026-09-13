import { timingSafeEqual } from 'crypto';
import { Body, Controller, Headers, Post, UnauthorizedException } from '@nestjs/common';
import { RecommendationFutureTestEvaluationArtifactV1 } from '@deadlock-live-probe/shared';
import { RecommendationFutureTestEvaluationV1Service } from './recommendation-future-test-evaluation-v1.service';

@Controller('deadlock-live/recommendation-roadmap/v1/materialize')
export class RecommendationFutureTestEvaluationV1Controller {
  constructor(private readonly futureTest: RecommendationFutureTestEvaluationV1Service) {}

  @Post('future-test')
  materialize(
    @Headers('x-recommendation-roadmap-token') token: string | undefined,
    @Body() artifact: RecommendationFutureTestEvaluationArtifactV1,
  ) {
    requireRoadmapToken(token);
    return this.futureTest.materialize(artifact);
  }
}

function requireRoadmapToken(provided: string | undefined): void {
  const expected = process.env.RECOMMENDATION_ROADMAP_EVIDENCE_TOKEN;
  if (!expected || !provided || !safeEqual(expected, provided)) {
    throw new UnauthorizedException('Recommendation roadmap evidence endpoint is disabled or unauthorized');
  }
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}
