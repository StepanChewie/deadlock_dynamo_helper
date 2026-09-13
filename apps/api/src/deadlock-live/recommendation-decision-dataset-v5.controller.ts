import {
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Post,
} from '@nestjs/common';
import {
  RecommendationDecisionDatasetV5Service,
  type RecommendationDecisionDatasetV5StartRequest,
} from './recommendation-decision-dataset-v5.service';

@Controller('deadlock/analysis/recommendation-decision-dataset-v5')
export class RecommendationDecisionDatasetV5Controller {
  constructor(
    private readonly datasetService: RecommendationDecisionDatasetV5Service,
  ) {}

  @Post('start')
  @HttpCode(202)
  async start(@Body() request: RecommendationDecisionDatasetV5StartRequest = {}) {
    try {
      return await this.datasetService.start(request);
    } catch (error) {
      throw new ConflictException(getErrorMessage(error));
    }
  }

  @Get('status')
  getStatus() {
    return this.datasetService.getStatus();
  }

  @Get('manifest')
  getManifest() {
    const manifest = this.datasetService.getManifest();
    if (!manifest) {
      throw new NotFoundException(
        'No completed Recommendation Dataset V5 manifest is available.',
      );
    }
    return manifest;
  }

  @Get('audit')
  getAudit() {
    const audit = this.datasetService.getAudit();
    if (!audit) {
      throw new NotFoundException(
        'No completed Recommendation Dataset V5 audit is available.',
      );
    }
    return audit;
  }

  @Get('source-availability')
  getSourceAvailability() {
    const sourceAvailability = this.datasetService.getSourceAvailability();
    if (!sourceAvailability) {
      throw new NotFoundException(
        'No completed Recommendation Dataset V5 source availability audit is available.',
      );
    }
    return sourceAvailability;
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
