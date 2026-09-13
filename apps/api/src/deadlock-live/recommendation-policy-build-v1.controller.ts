import { timingSafeEqual } from 'crypto';
import { Body, Controller, Headers, Post, UnauthorizedException } from '@nestjs/common';
import { RecommendationPolicyBuildV1Input, RecommendationPolicyBuildV1Service } from './recommendation-policy-build-v1.service';

@Controller('deadlock-live/recommendation-policy/v1')
export class RecommendationPolicyBuildV1Controller {
  constructor(private readonly policyBuild: RecommendationPolicyBuildV1Service) {}

  @Post('build-spec')
  buildSpec(
    @Headers('x-recommendation-artifact-token') token: string | undefined,
    @Body() body: RecommendationPolicyBuildV1Input,
  ) {
    requireArtifactToken(token);
    return this.policyBuild.build(body);
  }
}

function requireArtifactToken(provided: string | undefined): void {
  const expected = process.env.RECOMMENDATION_ARTIFACT_REGISTRY_TOKEN;
  if (!expected || !provided || !safeEqual(expected, provided)) {
    throw new UnauthorizedException('Recommendation Policy build endpoint is disabled or unauthorized');
  }
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}
