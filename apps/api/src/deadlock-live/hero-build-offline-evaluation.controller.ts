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
import {
  HERO_BUILD_OFFLINE_EVALUATION_DEFAULT_ERROR_EXAMPLE_LIMIT,
  HERO_BUILD_OFFLINE_EVALUATION_DEFAULT_MAX_MATCHES,
  HERO_BUILD_OFFLINE_EVALUATION_DEFAULT_TRAIN_FRACTION,
  HERO_BUILD_OFFLINE_EVALUATION_MAX_ERROR_EXAMPLE_LIMIT,
  HERO_BUILD_OFFLINE_EVALUATION_MAX_MATCHES,
  HeroBuildOfflineEvaluationService,
  HeroBuildOfflineEvaluationStartRequest,
} from './hero-build-offline-evaluation.service';

export class StartHeroBuildOfflineEvaluationDto {
  trainFraction?: number;
  maxMatches?: number;
  errorExampleLimit?: number;
}

@Controller('deadlock/analysis/build-evaluation')
export class HeroBuildOfflineEvaluationController {
  constructor(
    private readonly heroBuildOfflineEvaluationService:
      HeroBuildOfflineEvaluationService,
  ) {}

  @Post('start')
  @HttpCode(202)
  start(@Body() dto: StartHeroBuildOfflineEvaluationDto) {
    return this.heroBuildOfflineEvaluationService.start(parseRequest(dto ?? {}));
  }

  @Get('status')
  getStatus() {
    return this.heroBuildOfflineEvaluationService.getStatus();
  }

  @Get('report')
  getReport() {
    const status = this.heroBuildOfflineEvaluationService.getStatus();
    if (status.state === 'RUNNING') {
      throw new ConflictException('Offline build evaluation is still running.');
    }

    const report = this.heroBuildOfflineEvaluationService.getReport();
    if (!report) {
      throw new NotFoundException('No completed offline build evaluation report is available.');
    }
    return report;
  }
}

function parseRequest(
  dto: StartHeroBuildOfflineEvaluationDto,
): HeroBuildOfflineEvaluationStartRequest {
  return {
    trainFraction: parseTrainFraction(dto.trainFraction),
    maxMatches: parseInteger(
      dto.maxMatches,
      'maxMatches',
      HERO_BUILD_OFFLINE_EVALUATION_DEFAULT_MAX_MATCHES,
      2,
      HERO_BUILD_OFFLINE_EVALUATION_MAX_MATCHES,
    ),
    errorExampleLimit: parseInteger(
      dto.errorExampleLimit,
      'errorExampleLimit',
      HERO_BUILD_OFFLINE_EVALUATION_DEFAULT_ERROR_EXAMPLE_LIMIT,
      0,
      HERO_BUILD_OFFLINE_EVALUATION_MAX_ERROR_EXAMPLE_LIMIT,
    ),
  };
}

function parseTrainFraction(value: unknown): number {
  if (value === undefined) {
    return HERO_BUILD_OFFLINE_EVALUATION_DEFAULT_TRAIN_FRACTION;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0.5 || value > 0.95) {
    throw new BadRequestException('trainFraction must be a finite number from 0.5 to 0.95.');
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
