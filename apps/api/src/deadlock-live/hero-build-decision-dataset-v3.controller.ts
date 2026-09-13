import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Post,
} from '@nestjs/common';
import { HeroBuildDecisionDatasetV3CoordinatorService } from './hero-build-decision-dataset-v3-coordinator.service';
import {
  HERO_BUILD_DECISION_DATASET_V3_DEFAULT_BATCH_SIZE,
  HERO_BUILD_DECISION_DATASET_V3_MAX_BATCH_SIZE,
  HERO_BUILD_DECISION_DATASET_V3_MAX_MATCHES,
  HERO_BUILD_DECISION_DATASET_V3_MIN_BATCH_SIZE,
  HeroBuildDecisionDatasetV3StartRequest,
} from './hero-build-decision-dataset-v3.service';

export class StartHeroBuildDecisionDatasetV3Dto {
  maxMatches?: number;
  batchSize?: number;
  includeSellActions?: boolean;
}

@Controller('deadlock/analysis/build-decision-dataset-v3')
export class HeroBuildDecisionDatasetV3Controller {
  constructor(
    private readonly datasetCoordinator:
      HeroBuildDecisionDatasetV3CoordinatorService,
  ) {}

  @Post('start')
  @HttpCode(202)
  async start(@Body() dto: StartHeroBuildDecisionDatasetV3Dto) {
    try {
      return await this.datasetCoordinator.start(
        parseRequest(dto ?? {}),
      );
    } catch (error) {
      throw new BadRequestException(getErrorMessage(error));
    }
  }

  @Get('status')
  getStatus() {
    return this.datasetCoordinator.getStatus();
  }

  @Get('manifest')
  getManifest() {
    this.assertNotRunning();
    const manifest = this.datasetCoordinator.getManifest();
    if (!manifest) {
      throw new NotFoundException(
        'No completed Contextual V3 decision dataset manifest is available.',
      );
    }
    return manifest;
  }

  @Get('audit')
  getAudit() {
    this.assertNotRunning();
    const audit = this.datasetCoordinator.getAudit();
    if (!audit) {
      throw new NotFoundException(
        'No completed Contextual V3 decision dataset audit is available.',
      );
    }
    return audit;
  }

  private assertNotRunning(): void {
    if (this.datasetCoordinator.getStatus().state === 'RUNNING') {
      throw new ConflictException(
        'Contextual V3 decision dataset extraction is still running.',
      );
    }
  }
}

function parseRequest(
  dto: StartHeroBuildDecisionDatasetV3Dto,
): HeroBuildDecisionDatasetV3StartRequest {
  return {
    maxMatches: parseOptionalInteger(
      dto.maxMatches,
      'maxMatches',
      1,
      HERO_BUILD_DECISION_DATASET_V3_MAX_MATCHES,
    ),
    batchSize: parseInteger(
      dto.batchSize,
      'batchSize',
      HERO_BUILD_DECISION_DATASET_V3_DEFAULT_BATCH_SIZE,
      HERO_BUILD_DECISION_DATASET_V3_MIN_BATCH_SIZE,
      HERO_BUILD_DECISION_DATASET_V3_MAX_BATCH_SIZE,
    ),
    includeSellActions: parseBoolean(
      dto.includeSellActions,
      'includeSellActions',
      false,
    ),
  };
}

function parseOptionalInteger(
  value: unknown,
  fieldName: string,
  minimum: number,
  maximum: number,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new BadRequestException(
      `${fieldName} must be a safe integer from ${minimum} to ${maximum}.`,
    );
  }
  return value;
}

function parseInteger(
  value: unknown,
  fieldName: string,
  defaultValue: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined) {
    return defaultValue;
  }
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new BadRequestException(
      `${fieldName} must be a safe integer from ${minimum} to ${maximum}.`,
    );
  }
  return value;
}

function parseBoolean(
  value: unknown,
  fieldName: string,
  defaultValue: boolean,
): boolean {
  if (value === undefined) {
    return defaultValue;
  }
  if (typeof value !== 'boolean') {
    throw new BadRequestException(`${fieldName} must be a boolean.`);
  }
  return value;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
