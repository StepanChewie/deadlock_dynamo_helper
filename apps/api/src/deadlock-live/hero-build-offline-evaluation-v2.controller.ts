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
  HERO_BUILD_OFFLINE_EVALUATION_V2_DEFAULT_CHANGED_PREDICTION_LIMIT,
  HERO_BUILD_OFFLINE_EVALUATION_V2_DEFAULT_MAX_MATCHES,
  HERO_BUILD_OFFLINE_EVALUATION_V2_MAX_CHANGED_PREDICTION_LIMIT,
  HERO_BUILD_OFFLINE_EVALUATION_V2_MAX_MATCHES,
  HeroBuildOfflineEvaluationV2ResilientService,
  HeroBuildOfflineEvaluationV2RunMode,
  HeroBuildOfflineEvaluationV2StartRequest,
} from './hero-build-offline-evaluation-v2-resilient.service';
import {
  HERO_BUILD_OFFLINE_EVALUATION_V2_DEFAULT_BOOTSTRAP_ITERATIONS,
  HERO_BUILD_OFFLINE_EVALUATION_V2_DEFAULT_BOOTSTRAP_SEED,
  HERO_BUILD_OFFLINE_EVALUATION_V2_DEFAULT_TRAIN_FRACTION,
  HERO_BUILD_OFFLINE_EVALUATION_V2_DEFAULT_VALIDATION_FRACTION,
} from './hero-build-offline-evaluation-v2';

export class StartHeroBuildOfflineEvaluationV2Dto {
  runMode?: HeroBuildOfflineEvaluationV2RunMode;
  trainFraction?: number;
  validationFraction?: number;
  maxMatches?: number;
  changedPredictionLimit?: number;
  bootstrapIterations?: number;
  bootstrapSeed?: number;
  finalTestNotBefore?: string;
}

@Controller('deadlock/analysis/build-evaluation-v2')
export class HeroBuildOfflineEvaluationV2Controller {
  constructor(
    private readonly evaluationService:
      HeroBuildOfflineEvaluationV2ResilientService,
  ) {}

  @Post('start')
  @HttpCode(202)
  async start(@Body() dto: StartHeroBuildOfflineEvaluationV2Dto) {
    try {
      return await this.evaluationService.start(
        parseRequest(dto ?? {}),
      );
    } catch (error) {
      throw new BadRequestException(getErrorMessage(error));
    }
  }

  @Get('status')
  getStatus() {
    return this.evaluationService.getStatus();
  }

  @Get('validation-report')
  getValidationReport() {
    this.assertNotRunning();
    const report = this.evaluationService.getValidationReport();
    if (!report) {
      throw new NotFoundException(
        'No completed Contextual V2 validation report is available.',
      );
    }
    return report;
  }

  @Get('selection')
  getSelection() {
    this.assertNotRunning();
    const selection = this.evaluationService.getSelection();
    if (!selection) {
      throw new NotFoundException(
        'No frozen Contextual V2 validation selection is available.',
      );
    }
    return selection;
  }

  @Get('final-report')
  getFinalReport() {
    this.assertNotRunning();
    const report = this.evaluationService.getFinalReport();
    if (!report) {
      throw new NotFoundException(
        'No completed Contextual V2 final-test report is available.',
      );
    }
    return report;
  }

  private assertNotRunning(): void {
    if (this.evaluationService.getStatus().state === 'RUNNING') {
      throw new ConflictException(
        'Contextual V2 offline evaluation is still running.',
      );
    }
  }
}

function parseRequest(
  dto: StartHeroBuildOfflineEvaluationV2Dto,
): HeroBuildOfflineEvaluationV2StartRequest {
  const trainFraction = parseFraction(
    dto.trainFraction,
    'trainFraction',
    HERO_BUILD_OFFLINE_EVALUATION_V2_DEFAULT_TRAIN_FRACTION,
  );
  const validationFraction = parseFraction(
    dto.validationFraction,
    'validationFraction',
    HERO_BUILD_OFFLINE_EVALUATION_V2_DEFAULT_VALIDATION_FRACTION,
  );
  if (trainFraction + validationFraction >= 1) {
    throw new BadRequestException(
      'trainFraction plus validationFraction must be below 1.',
    );
  }
  return {
    runMode: parseRunMode(dto.runMode),
    trainFraction,
    validationFraction,
    maxMatches: parseInteger(
      dto.maxMatches,
      'maxMatches',
      HERO_BUILD_OFFLINE_EVALUATION_V2_DEFAULT_MAX_MATCHES,
      3,
      HERO_BUILD_OFFLINE_EVALUATION_V2_MAX_MATCHES,
    ),
    changedPredictionLimit: parseInteger(
      dto.changedPredictionLimit,
      'changedPredictionLimit',
      HERO_BUILD_OFFLINE_EVALUATION_V2_DEFAULT_CHANGED_PREDICTION_LIMIT,
      0,
      HERO_BUILD_OFFLINE_EVALUATION_V2_MAX_CHANGED_PREDICTION_LIMIT,
    ),
    bootstrapIterations: parseInteger(
      dto.bootstrapIterations,
      'bootstrapIterations',
      HERO_BUILD_OFFLINE_EVALUATION_V2_DEFAULT_BOOTSTRAP_ITERATIONS,
      100,
      20_000,
    ),
    bootstrapSeed: parseInteger(
      dto.bootstrapSeed,
      'bootstrapSeed',
      HERO_BUILD_OFFLINE_EVALUATION_V2_DEFAULT_BOOTSTRAP_SEED,
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    finalTestNotBefore: parseOptionalIsoDate(
      dto.finalTestNotBefore,
    ),
  };
}

function parseRunMode(
  value: unknown,
): HeroBuildOfflineEvaluationV2RunMode {
  if (value === undefined) {
    return 'VALIDATION_ONLY';
  }
  if (value !== 'VALIDATION_ONLY' && value !== 'FINAL_TEST') {
    throw new BadRequestException(
      'runMode must be VALIDATION_ONLY or FINAL_TEST.',
    );
  }
  return value;
}

function parseFraction(
  value: unknown,
  fieldName: string,
  defaultValue: number,
): number {
  if (value === undefined) {
    return defaultValue;
  }
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value <= 0 ||
    value >= 1
  ) {
    throw new BadRequestException(
      `${fieldName} must be a finite number greater than 0 and below 1.`,
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

function parseOptionalIsoDate(
  value: unknown,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new BadRequestException(
      'finalTestNotBefore must be an ISO-8601 date string.',
    );
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new BadRequestException(
      'finalTestNotBefore must be a valid ISO-8601 date string.',
    );
  }
  return parsed.toISOString();
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
