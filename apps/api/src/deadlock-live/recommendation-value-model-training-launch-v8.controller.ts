import { timingSafeEqual } from 'crypto';
import { Controller, Headers, Param, Post } from '@nestjs/common';
import { RecommendationValueModelTrainingLaunchV8Service } from './recommendation-value-model-training-launch-v8.service';

@Controller('deadlock-live/recommendation-value-model-training/v8')
export class RecommendationValueModelTrainingLaunchV8Controller {
  constructor(private readonly training: RecommendationValueModelTrainingLaunchV8Service) {}

  @Post('preflight/:datasetId')
  preflight(
    @Headers('x-recommendation-training-token') token: string | undefined,
    @Param('datasetId') datasetId: string,
  ) {
    requireTrainingToken(token);
    return this.training.preflight(datasetId);
  }
}

function requireTrainingToken(provided: string | undefined): void {
  const expected = process.env.RECOMMENDATION_TRAINING_TOKEN;
  if (!expected || !provided || !safeEqual(expected, provided)) {
    throw new Error('Recommendation training endpoint is disabled or unauthorized');
  }
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}
