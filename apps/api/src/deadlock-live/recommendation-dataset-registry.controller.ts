import { timingSafeEqual } from 'crypto';
import { Body, Controller, Get, Headers, Param, Post, UnauthorizedException } from '@nestjs/common';
import { RecommendationDatasetManifestV1 } from '@deadlock-live-probe/shared';
import {
  RecommendationDatasetRegistryService,
  VerifyRecommendationDatasetV1Input,
} from './recommendation-dataset-registry.service';

interface RegisterDatasetBodyV1 {
  manifest: RecommendationDatasetManifestV1;
  objectBaseUri: string;
}

@Controller('deadlock-live/recommendation-datasets/v1')
export class RecommendationDatasetRegistryController {
  constructor(private readonly registry: RecommendationDatasetRegistryService) {}

  @Post('register')
  register(
    @Headers('x-recommendation-artifact-token') token: string | undefined,
    @Body() body: RegisterDatasetBodyV1,
  ) {
    requireArtifactToken(token);
    return this.registry.register(body);
  }

  @Post('verify')
  verify(
    @Headers('x-recommendation-artifact-token') token: string | undefined,
    @Body() body: VerifyRecommendationDatasetV1Input,
  ) {
    requireArtifactToken(token);
    return this.registry.verify(body);
  }

  @Get(':datasetId')
  get(
    @Headers('x-recommendation-artifact-token') token: string | undefined,
    @Param('datasetId') datasetId: string,
  ) {
    requireArtifactToken(token);
    return this.registry.get(datasetId);
  }
}

function requireArtifactToken(provided: string | undefined): void {
  const expected = process.env.RECOMMENDATION_ARTIFACT_REGISTRY_TOKEN;
  if (!expected || !provided || !safeEqual(expected, provided)) {
    throw new UnauthorizedException('Recommendation artifact registry endpoint is disabled or unauthorized');
  }
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}
