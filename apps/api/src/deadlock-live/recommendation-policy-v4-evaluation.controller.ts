import {
  Body,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Post,
} from '@nestjs/common';
import {
  RecommendationPolicyV4EvaluationService,
  type RecommendationPolicyV4EvaluationStartRequest,
  type RecommendationPolicyV4EvaluationStatus,
} from './recommendation-policy-v4-evaluation.service';

@Controller('deadlock/analysis/recommendation-policy-v4-evaluation')
export class RecommendationPolicyV4EvaluationController {
  constructor(
    private readonly service: RecommendationPolicyV4EvaluationService,
  ) {}

  @Post('start')
  async start(
    @Body() request: RecommendationPolicyV4EvaluationStartRequest = {},
  ): Promise<RecommendationPolicyV4EvaluationStatus> {
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
  getStatus(): RecommendationPolicyV4EvaluationStatus {
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
      `Recommendation Policy V4 ${name} is not available.`,
      HttpStatus.NOT_FOUND,
    );
  }
  return value;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
