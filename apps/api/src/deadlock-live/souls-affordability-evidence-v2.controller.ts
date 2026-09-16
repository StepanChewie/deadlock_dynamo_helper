import { timingSafeEqual } from 'crypto';
import {
  Body,
  Controller,
  Get,
  Headers,
  Post,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
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

/**
 * Already token-protected, so it does not need InternalApiGuard as well -- two
 * secrets for one route would just be friction. What was wrong is the failure
 * mode: a bare `Error` surfaced as HTTP 500, which looks like an outage, leaks a
 * stack trace and pollutes error monitoring. Distinguish the two cases instead:
 * the route is disabled when no token is configured, and unauthorized when the
 * token does not match.
 *
 * Note this route is not reachable through nginx either -- the perimeter has
 * locations for /, /debug/, /deadlock/ and /deadlock/tools/statlocker, but none
 * for /deadlock-live/, so it 404s at the edge.
 */
function requireEvidenceToken(provided: string | undefined): void {
  const expected = process.env.RECOMMENDATION_EVIDENCE_TOKEN;
  if (!expected) {
    throw new ServiceUnavailableException(
      'Recommendation evidence endpoint is disabled: RECOMMENDATION_EVIDENCE_TOKEN is not set',
    );
  }
  const candidate = provided?.trim() ?? '';
  if (!candidate || !safeEqual(expected, candidate)) {
    throw new UnauthorizedException('Recommendation evidence token is invalid');
  }
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}
