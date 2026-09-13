import { timingSafeEqual } from 'crypto';
import { Body, Controller, Headers, Post, UnauthorizedException } from '@nestjs/common';
import {
  RecommendationAdvancedEvidenceV8Service,
  RecommendationExperimentEvidenceGateV8,
} from './recommendation-advanced-evidence-v8.service';
import { RecommendationOpeRewardV1 } from './recommendation-ope-report.service';

interface EvidenceWindowBodyV8 {
  from?: string;
  to?: string;
}

interface BehavioralEvidenceBodyV8 {
  modelId: string;
  modelVersion: string;
}

interface ExperimentEvidenceBodyV8 extends EvidenceWindowBodyV8 {
  experimentId: string;
  controlArm: string;
  treatmentArm: string;
  reward: RecommendationOpeRewardV1;
  gateName: RecommendationExperimentEvidenceGateV8;
  modelId?: string;
  modelVersion?: string;
}

interface OpeEvidenceBodyV8 extends EvidenceWindowBodyV8 {
  reward: RecommendationOpeRewardV1;
}

interface CausalValueEvidenceBodyV8 extends OpeEvidenceBodyV8 {
  modelId: string;
  modelVersion: string;
}

@Controller('deadlock-live/recommendation-roadmap/v1/materialize')
export class RecommendationAdvancedEvidenceV8Controller {
  constructor(private readonly evidence: RecommendationAdvancedEvidenceV8Service) {}

  @Post('behavioral')
  behavioral(
    @Headers('x-recommendation-roadmap-token') token: string | undefined,
    @Body() body: BehavioralEvidenceBodyV8,
  ) {
    requireRoadmapToken(token);
    return this.evidence.materializeBehavioralModel(body.modelId, body.modelVersion);
  }

  @Post('shadow')
  shadow(
    @Headers('x-recommendation-roadmap-token') token: string | undefined,
    @Body() body: EvidenceWindowBodyV8,
  ) {
    requireRoadmapToken(token);
    return this.evidence.materializeShadow(window(body));
  }

  @Post('experiment')
  experiment(
    @Headers('x-recommendation-roadmap-token') token: string | undefined,
    @Body() body: ExperimentEvidenceBodyV8,
  ) {
    requireRoadmapToken(token);
    return this.evidence.materializeExperiment({
      experimentId: body.experimentId,
      controlArm: body.controlArm,
      treatmentArm: body.treatmentArm,
      reward: body.reward,
      gateName: body.gateName,
      modelId: body.modelId,
      modelVersion: body.modelVersion,
      ...window(body),
    });
  }

  @Post('ope')
  ope(
    @Headers('x-recommendation-roadmap-token') token: string | undefined,
    @Body() body: OpeEvidenceBodyV8,
  ) {
    requireRoadmapToken(token);
    return this.evidence.materializeOpe({ reward: body.reward, ...window(body) });
  }

  @Post('causal-value')
  causalValue(
    @Headers('x-recommendation-roadmap-token') token: string | undefined,
    @Body() body: CausalValueEvidenceBodyV8,
  ) {
    requireRoadmapToken(token);
    return this.evidence.materializeCausalValue({
      modelId: body.modelId,
      modelVersion: body.modelVersion,
      reward: body.reward,
      ...window(body),
    });
  }
}

function window(body: EvidenceWindowBodyV8): { from?: Date; to?: Date } {
  const from = optionalDate(body.from, 'from');
  const to = optionalDate(body.to, 'to');
  if (from && to && from >= to) throw new Error('from must be before to');
  return { from, to };
}

function optionalDate(value: string | undefined, name: string): Date | undefined {
  if (value === undefined) return undefined;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`${name} is invalid`);
  return date;
}

function requireRoadmapToken(provided: string | undefined): void {
  const expected = process.env.RECOMMENDATION_ROADMAP_EVIDENCE_TOKEN;
  if (!expected || !provided || !safeEqual(expected, provided)) {
    throw new UnauthorizedException('Recommendation roadmap evidence endpoint is disabled or unauthorized');
  }
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}
