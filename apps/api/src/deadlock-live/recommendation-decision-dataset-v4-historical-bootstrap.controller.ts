import {
  Body,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Post,
} from '@nestjs/common';
import {
  RecommendationDecisionDatasetV4HistoricalBootstrapService,
  type RecommendationDecisionDatasetV4HistoricalBootstrapStartRequest,
  type RecommendationDecisionDatasetV4HistoricalBootstrapStatus,
} from './recommendation-decision-dataset-v4-historical-bootstrap.service';

@Controller(
  'deadlock/analysis/recommendation-decision-dataset-v4-historical-bootstrap',
)
export class RecommendationDecisionDatasetV4HistoricalBootstrapController {
  constructor(
    private readonly service:
      RecommendationDecisionDatasetV4HistoricalBootstrapService,
  ) {}

  @Post('start')
  async start(
    @Body()
    request: RecommendationDecisionDatasetV4HistoricalBootstrapStartRequest = {},
  ): Promise<RecommendationDecisionDatasetV4HistoricalBootstrapStatus> {
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
  getStatus(): RecommendationDecisionDatasetV4HistoricalBootstrapStatus {
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
}

function requiredArtifact(
  value: Record<string, unknown> | undefined,
  name: string,
): Record<string, unknown> {
  if (!value) {
    throw new HttpException(
      `Recommendation V4 historical bootstrap ${name} is not available.`,
      HttpStatus.NOT_FOUND,
    );
  }
  return value;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
