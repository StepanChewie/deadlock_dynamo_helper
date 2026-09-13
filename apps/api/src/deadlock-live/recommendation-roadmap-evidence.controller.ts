import { timingSafeEqual } from 'crypto';
import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  Param,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import {
  RecommendationDirectShopSourceValidationAttestationV1,
  RecommendationRoadmapEvidenceRecordV1,
} from '@deadlock-live-probe/shared';
import { RecommendationEvidenceMaterializerV8Service } from './recommendation-evidence-materializer-v8.service';
import { RecommendationRoadmapEvidenceService } from './recommendation-roadmap-evidence.service';

interface RecommendationFoundationalEvidenceRequestV8 {
  from?: string;
  to?: string;
  maximumAlignmentAgeMs?: number;
  candidateGeneratorVersion?: string;
}

@Controller('deadlock-live/recommendation-roadmap/v1')
export class RecommendationRoadmapEvidenceController {
  constructor(
    private readonly evidence: RecommendationRoadmapEvidenceService,
    private readonly materializer: RecommendationEvidenceMaterializerV8Service,
  ) {}

  @Post('evidence')
  append(
    @Headers('x-recommendation-roadmap-token') token: string | undefined,
    @Body() record: RecommendationRoadmapEvidenceRecordV1,
  ) {
    requireRoadmapToken(token);
    if (record?.gateName === 'futureTestEvaluation') {
      throw new ForbiddenException(
        'FUTURE_TEST evaluation can only be materialized from a verified frozen-policy evaluation artifact',
      );
    }
    if (record?.gateName === 'directShopSourceValidation') {
      throw new ForbiddenException(
        'Direct shop source validation can only be materialized from a structured independent-validation attestation',
      );
    }
    return this.evidence.append(record);
  }

  @Post('materialize/foundational')
  materializeFoundational(
    @Headers('x-recommendation-roadmap-token') token: string | undefined,
    @Body() body: RecommendationFoundationalEvidenceRequestV8,
  ) {
    requireRoadmapToken(token);
    return this.materializer.materializeFoundational({
      from: optionalDate(body.from, 'from'),
      to: optionalDate(body.to, 'to'),
      maximumAlignmentAgeMs: body.maximumAlignmentAgeMs,
      candidateGeneratorVersion: body.candidateGeneratorVersion,
    });
  }

  @Post('materialize/direct-shop-source')
  materializeDirectShopSource(
    @Headers('x-recommendation-roadmap-token') token: string | undefined,
    @Body() attestation: RecommendationDirectShopSourceValidationAttestationV1,
  ) {
    requireRoadmapToken(token);
    return this.materializer.materializeDirectShopSource(attestation);
  }

  @Get('evidence-snapshots/:subjectSha256')
  snapshot(
    @Headers('x-recommendation-roadmap-token') token: string | undefined,
    @Param('subjectSha256') subjectSha256: string,
  ) {
    requireRoadmapToken(token);
    return this.materializer.getSnapshot(subjectSha256);
  }

  @Get('report')
  report(@Headers('x-recommendation-roadmap-token') token: string | undefined) {
    requireRoadmapToken(token);
    return this.evidence.report();
  }
}

function requireRoadmapToken(provided: string | undefined): void {
  const expected = process.env.RECOMMENDATION_ROADMAP_EVIDENCE_TOKEN;
  if (!expected || !provided || !safeEqual(expected, provided)) {
    throw new UnauthorizedException('Recommendation roadmap evidence endpoint is disabled or unauthorized');
  }
}

function optionalDate(value: string | undefined, name: string): Date | undefined {
  if (value === undefined) return undefined;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`${name} is invalid`);
  return date;
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}
