import { timingSafeEqual } from 'crypto';
import { Body, Controller, Headers, Post, UnauthorizedException } from '@nestjs/common';
import {
  ModelBundleManifestV1,
  ModelBundleRuntimeCompatibilityV1,
} from '@deadlock-live-probe/shared';
import {
  ModelBundleRegistryService,
  VerifyModelBundleV1Input,
} from './model-bundle-registry.service';
import { RecommendationModelPromotionV1Service } from './recommendation-model-promotion-v1.service';

interface RegisterModelBundleBodyV1 {
  manifest: ModelBundleManifestV1;
  artifactBaseUri: string;
}

interface ActivateModelBundleBodyV1 {
  modelId: string;
  modelVersion: string;
  runtime: ModelBundleRuntimeCompatibilityV1;
}

@Controller('deadlock-live/recommendation-models/v1')
export class ModelBundleRegistryController {
  constructor(
    private readonly registry: ModelBundleRegistryService,
    private readonly promotion: RecommendationModelPromotionV1Service,
  ) {}

  @Post('register')
  register(
    @Headers('x-recommendation-artifact-token') token: string | undefined,
    @Body() body: RegisterModelBundleBodyV1,
  ) {
    requireArtifactToken(token);
    return this.registry.register(body);
  }

  @Post('verify')
  verify(
    @Headers('x-recommendation-artifact-token') token: string | undefined,
    @Body() body: VerifyModelBundleV1Input,
  ) {
    requireArtifactToken(token);
    return this.registry.verify(body);
  }

  @Post('activate')
  activate(
    @Headers('x-recommendation-artifact-token') token: string | undefined,
    @Body() body: ActivateModelBundleBodyV1,
  ) {
    requireArtifactToken(token);
    return this.promotion.promote(body);
  }
}

function requireArtifactToken(provided: string | undefined): void {
  const expected = process.env.RECOMMENDATION_ARTIFACT_REGISTRY_TOKEN;
  if (!expected || !provided || !safeEqual(expected, provided)) {
    throw new UnauthorizedException('Recommendation model registry endpoint is disabled or unauthorized');
  }
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}
