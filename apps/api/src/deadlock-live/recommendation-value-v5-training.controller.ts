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
  RecommendationValueV5TrainingService,
  type RecommendationValueV5TrainingStartRequest,
} from './recommendation-value-v5-training.service';

export class StartRecommendationValueV5TrainingDto {
  trainFraction?: number;
  tuningFraction?: number;
  statePriorStrength?: number;
  actionPriorStrength?: number;
  minimumEffectiveObservations?: number;
  maximumAbsoluteStateLogitResidual?: number;
  maximumAbsoluteActionLogitResidual?: number;
  actionResidualScales?: number[];
  expectedSourceSha256?: string;
}

@Controller('deadlock/analysis/recommendation-value-v5-training')
export class RecommendationValueV5TrainingController {
  constructor(
    private readonly trainingService: RecommendationValueV5TrainingService,
  ) {}

  @Post('start')
  @HttpCode(202)
  async start(@Body() dto: StartRecommendationValueV5TrainingDto) {
    try {
      return await this.trainingService.start(parseRequest(dto ?? {}));
    } catch (error) {
      throw new BadRequestException(getErrorMessage(error));
    }
  }

  @Get('status')
  getStatus() {
    return this.trainingService.getStatus();
  }

  @Get('manifest')
  getManifest() {
    this.assertNotRunning();
    const manifest = this.trainingService.getManifest();
    if (!manifest) {
      throw new NotFoundException(
        'No completed Recommendation Value V5 training manifest is available.',
      );
    }
    return manifest;
  }

  @Get('audit')
  getAudit() {
    this.assertNotRunning();
    const audit = this.trainingService.getAudit();
    if (!audit) {
      throw new NotFoundException(
        'No completed Recommendation Value V5 training audit is available.',
      );
    }
    return audit;
  }

  @Get('evaluation')
  getEvaluation() {
    this.assertNotRunning();
    const evaluation = this.trainingService.getEvaluation();
    if (!evaluation) {
      throw new NotFoundException(
        'No completed Recommendation Value V5 evaluation is available.',
      );
    }
    return evaluation;
  }

  @Get('model')
  getModel() {
    this.assertNotRunning();
    const model = this.trainingService.getModel();
    if (!model) {
      throw new NotFoundException(
        'No completed Recommendation Value V5 model is available.',
      );
    }
    return model;
  }

  private assertNotRunning(): void {
    if (this.trainingService.getStatus().state === 'RUNNING') {
      throw new ConflictException(
        'Recommendation Value V5 training is still running.',
      );
    }
  }
}

function parseRequest(
  dto: StartRecommendationValueV5TrainingDto,
): RecommendationValueV5TrainingStartRequest {
  return {
    trainFraction: dto.trainFraction,
    tuningFraction: dto.tuningFraction,
    statePriorStrength: dto.statePriorStrength,
    actionPriorStrength: dto.actionPriorStrength,
    minimumEffectiveObservations: dto.minimumEffectiveObservations,
    maximumAbsoluteStateLogitResidual:
      dto.maximumAbsoluteStateLogitResidual,
    maximumAbsoluteActionLogitResidual:
      dto.maximumAbsoluteActionLogitResidual,
    actionResidualScales: dto.actionResidualScales,
    expectedSourceSha256: dto.expectedSourceSha256,
  };
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
