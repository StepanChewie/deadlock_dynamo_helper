import { timingSafeEqual } from 'crypto';
import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  Param,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { RecommendationBehavioralTrainingConfigV1 } from '@deadlock-live-probe/shared';
import {
  RecommendationPretrainingFinalReadinessV8Input,
  RecommendationPretrainingFinalReadinessV8Service,
} from './recommendation-pretraining-final-readiness-v8.service';
import { RecommendationTrainingLaunchV8Service } from './recommendation-training-launch-v8.service';

interface RecommendationTrainingPreflightBodyV8 {
  config: RecommendationBehavioralTrainingConfigV1;
}

@Controller('deadlock-live/recommendation-training/v8')
export class RecommendationTrainingLaunchV8Controller {
  constructor(
    private readonly trainingLaunch: RecommendationTrainingLaunchV8Service,
    private readonly finalReadiness: RecommendationPretrainingFinalReadinessV8Service,
  ) {}

  @Post('preflight/:datasetId')
  preflight(
    @Headers('x-recommendation-training-token') token: string | undefined,
    @Param('datasetId') datasetId: string,
    @Body() body: RecommendationTrainingPreflightBodyV8,
  ) {
    requireTrainingToken(token);
    if (!body?.config) throw new BadRequestException('training config is required');
    return this.trainingLaunch.preflight(datasetId, body.config);
  }

  @Post('final-readiness/:datasetId')
  evaluateFinalReadiness(
    @Headers('x-recommendation-training-token') token: string | undefined,
    @Param('datasetId') datasetId: string,
    @Body() body: RecommendationPretrainingFinalReadinessV8Input,
  ) {
    requireTrainingToken(token);
    if (!body?.rnnConfig || !body?.transformerConfig || !body?.runner) {
      throw new BadRequestException('rnnConfig, transformerConfig, and runner evidence are required');
    }
    return this.finalReadiness.evaluate(datasetId, body);
  }
}

function requireTrainingToken(provided: string | undefined): void {
  const expected = process.env.RECOMMENDATION_TRAINING_TOKEN;
  if (!expected || !provided || !safeEqual(expected, provided)) {
    throw new UnauthorizedException('Recommendation training endpoint is disabled or unauthorized');
  }
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}
