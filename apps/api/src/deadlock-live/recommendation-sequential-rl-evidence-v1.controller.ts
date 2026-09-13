import { timingSafeEqual } from 'crypto';
import { Body, Controller, Headers, Post, UnauthorizedException } from '@nestjs/common';
import { RecommendationSequentialRlEvidenceAttestationV1 } from '@deadlock-live-probe/shared';
import { RecommendationSequentialRlEvidenceV1Service } from './recommendation-sequential-rl-evidence-v1.service';

@Controller('deadlock-live/recommendation-roadmap/v1/materialize')
export class RecommendationSequentialRlEvidenceV1Controller {
  constructor(private readonly evidence: RecommendationSequentialRlEvidenceV1Service) {}

  @Post('sequential-rl-research')
  materialize(
    @Headers('x-recommendation-roadmap-token') token: string | undefined,
    @Body() body: RecommendationSequentialRlEvidenceAttestationV1,
  ) {
    requireRoadmapToken(token);
    return this.evidence.materialize(body);
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
