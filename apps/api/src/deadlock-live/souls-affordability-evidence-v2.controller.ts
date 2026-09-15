import { timingSafeEqual } from 'crypto';
import { Body, Controller, Get, Headers, Post } from '@nestjs/common';
import { SoulsAffordabilityControlledObservationV2 } from '@dynamo-lab/shared';
import { SoulsAffordabilityEvidenceV2Service } from './souls-affordability-evidence-v2.service';

@Controller('deadlock-live/recommendation-souls-evidence/v2')
export class SoulsAffordabilityEvidenceV2Controller {
  constructor(private readonly evidenceService: SoulsAffordabilityEvidenceV2Service) {}

  @Post('observations')
  append(
    @Headers('x-recommendation-evidence-token') token: string | undefined,
    @Body() observation: SoulsAffordabilityControlledObservationV2,
  ) {
    requireEvidenceToken(token);
    return this.evidenceService.append(observation);
  }

  @Get('report')
  report(@Headers('x-recommendation-evidence-token') token: string | undefined) {
    requireEvidenceToken(token);
    return this.evidenceService.report();
  }
}

function requireEvidenceToken(provided: string | undefined): void {
  const expected = process.env.RECOMMENDATION_EVIDENCE_TOKEN;
  if (!expected || !provided || !safeEqual(expected, provided)) {
    throw new Error('Recommendation evidence endpoint is disabled or unauthorized');
  }
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}
