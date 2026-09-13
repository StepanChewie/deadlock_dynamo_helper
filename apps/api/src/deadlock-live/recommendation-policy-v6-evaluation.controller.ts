import {
  Body,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Post,
} from '@nestjs/common';
import {
  RecommendationPolicyV6EvaluationService,
  type RecommendationPolicyV6EvaluationStartRequest,
  type RecommendationPolicyV6EvaluationStatus,
} from './recommendation-policy-v6-evaluation.service';

@Controller('deadlock/analysis/recommendation-policy-v6-evaluation')
export class RecommendationPolicyV6EvaluationController {
  constructor(
    private readonly service: RecommendationPolicyV6EvaluationService,
  ) {}

  @Post('start')
  async start(
    @Body() request: RecommendationPolicyV6EvaluationStartRequest = {},
  ): Promise<RecommendationPolicyV6EvaluationStatus> {
    try {
      return await this.service.start(request);
    } catch (error) {
      throw new HttpException(
        getErrorMessage(error),
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Get('status')
  getStatus(): RecommendationPolicyV6EvaluationStatus {
    return this.service.getStatus();
  }

  @Get('manifest')
  getManifest(): Record<string, unknown> {
    return requiredArtifact(this.service.getManifest(), 'manifest');
  }

  @Get('audit')
  getAudit(): Record<string, unknown> {
    return requiredArtifact(this.service.getAudit(), 'audit');
  }

  @Get('evaluation')
  getEvaluation(): Record<string, unknown> {
    return requiredArtifact(this.service.getEvaluation(), 'evaluation');
  }
}

function requiredArtifact(
  value: Record<string, unknown> | undefined,
  name: string,
): Record<string, unknown> {
  if (!value) {
    throw new HttpException(
      `Recommendation Policy V6 ${name} is not available.`,
      HttpStatus.NOT_FOUND,
    );
  }
  return value;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
