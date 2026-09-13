import {
  ConflictException,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Post,
} from '@nestjs/common';
import { RecommendationDecisionDatasetV4Service } from './recommendation-decision-dataset-v4.service';

@Controller('deadlock/analysis/recommendation-decision-dataset-v4')
export class RecommendationDecisionDatasetV4Controller {
  constructor(
    private readonly datasetService: RecommendationDecisionDatasetV4Service,
  ) {}

  @Post('start')
  @HttpCode(202)
  start() {
    try {
      return this.datasetService.start();
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
        'No completed recommendation decision dataset V4 manifest is available.',
      );
    }
    return manifest;
  }

  @Get('audit')
  getAudit() {
    const audit = this.datasetService.getAudit();
    if (!audit) {
      throw new NotFoundException(
        'No completed recommendation decision dataset V4 audit is available.',
      );
    }
    return audit;
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
