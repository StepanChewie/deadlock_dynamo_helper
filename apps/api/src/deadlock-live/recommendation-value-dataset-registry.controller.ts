import { timingSafeEqual } from 'crypto';
import { Body, Controller, Get, Headers, Param, Post } from '@nestjs/common';
import { RecommendationValueDatasetRegistryService } from './recommendation-value-dataset-registry.service';
import { RecommendationValueDatasetManifestV1 } from '@deadlock-live-probe/shared';

interface RegisterBody {
  manifest: RecommendationValueDatasetManifestV1;
  objectBaseUri: string;
}

interface VerifyBody {
  verifier: string;
  manifestSha256: string;
  files: readonly { path: string; sha256: string; sizeBytes: number; rowCount: number }[];
  attestationRef?: string;
}

@Controller('deadlock-live/recommendation-value-datasets/v1')
export class RecommendationValueDatasetRegistryController {
  constructor(private readonly registry: RecommendationValueDatasetRegistryService) {}

  @Post('register')
  register(
    @Headers('x-recommendation-artifact-token') token: string | undefined,
    @Body() body: RegisterBody,
  ) {
    requireArtifactToken(token);
    return this.registry.register(body);
  }

  @Post(':datasetId/verify')
  verify(
    @Headers('x-recommendation-artifact-token') token: string | undefined,
    @Param('datasetId') datasetId: string,
    @Body() body: VerifyBody,
  ) {
    requireArtifactToken(token);
    return this.registry.verify({ datasetId, ...body });
  }

  @Get(':datasetId')
  get(
    @Headers('x-recommendation-artifact-token') token: string | undefined,
    @Param('datasetId') datasetId: string,
  ) {
    requireArtifactToken(token);
    return this.registry.getVerified(datasetId);
  }
}

function requireArtifactToken(provided: string | undefined): void {
  const expected = process.env.RECOMMENDATION_ARTIFACT_REGISTRY_TOKEN;
  if (!expected || !provided || !safeEqual(expected, provided)) {
    throw new Error('Recommendation artifact registry endpoint is disabled or unauthorized');
  }
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}
