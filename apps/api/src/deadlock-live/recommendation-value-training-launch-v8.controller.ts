import { timingSafeEqual } from 'crypto';
import { Body, Controller, Headers, Post } from '@nestjs/common';
import { RecommendationOpeRewardV1 } from './recommendation-ope-report.service';
import { RecommendationValueTrainingLaunchV8Service } from './recommendation-value-training-launch-v8.service';

interface RecommendationValueTrainingPreflightBodyV8 {
  reward: RecommendationOpeRewardV1;
  from?: string;
  to?: string;
}

@Controller('deadlock-live/recommendation-value-training/v8')
export class RecommendationValueTrainingLaunchV8Controller {
  constructor(private readonly valueTraining: RecommendationValueTrainingLaunchV8Service) {}

  @Post('preflight')
  preflight(
    @Headers('x-recommendation-training-token') token: string | undefined,
    @Body() body: RecommendationValueTrainingPreflightBodyV8,
  ) {
    requireTrainingToken(token);
    if (!body?.reward) throw new Error('reward is required');
    const from = optionalDate(body.from, 'from');
    const to = optionalDate(body.to, 'to');
    if (from && to && from >= to) throw new Error('from must be before to');
    return this.valueTraining.preflight({ reward: body.reward, from, to });
  }
}

function optionalDate(value: string | undefined, name: string): Date | undefined {
  if (value === undefined) return undefined;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`${name} is invalid`);
  return date;
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
