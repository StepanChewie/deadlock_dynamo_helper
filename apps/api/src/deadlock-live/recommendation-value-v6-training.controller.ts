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
  RecommendationValueV6TrainingService,
  type RecommendationValueV6TrainingStartRequest,
} from './recommendation-value-v6-training.service';

export class StartRecommendationValueV6TrainingDto {
  trainFraction?: number;
  tuningFraction?: number;
  statePriorStrength?: number;
  actionPriorStrength?: number;
  minimumObservations?: number;
  maximumAbsoluteStateResidual?: number;
  maximumAbsoluteActionResidual?: number;
  actionResidualScales?: number[];
  finalOutcomeWeight?: number;
  expectedSourceSha256?: string;
}

@Controller('deadlock/analysis/recommendation-value-v6-training')
export class RecommendationValueV6TrainingController {
  constructor(
    private readonly trainingService: RecommendationValueV6TrainingService,
  ) {}

  @Post('start')
  @HttpCode(202)
  async start(@Body() dto: StartRecommendationValueV6TrainingDto) {
    try {
      return await this.trainingService.start(parseRequest(dto ?? {}));
    } catch (error) {
      throw new BadRequestException(errorMessage(error));
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
        'No completed Recommendation Value V6 training manifest is available.',
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
        'No completed Recommendation Value V6 training audit is available.',
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
        'No completed Recommendation Value V6 evaluation is available.',
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
        'No completed Recommendation Value V6 model is available.',
      );
    }
    return model;
  }

  private assertNotRunning(): void {
    if (this.trainingService.getStatus().state === 'RUNNING') {
      throw new ConflictException(
        'Recommendation Value V6 training is still running.',
      );
    }
  }
}

function parseRequest(
  dto: StartRecommendationValueV6TrainingDto,
): RecommendationValueV6TrainingStartRequest {
  return {
    trainFraction: dto.trainFraction,
    tuningFraction: dto.tuningFraction,
    statePriorStrength: dto.statePriorStrength,
    actionPriorStrength: dto.actionPriorStrength,
    minimumObservations: dto.minimumObservations,
    maximumAbsoluteStateResidual: dto.maximumAbsoluteStateResidual,
    maximumAbsoluteActionResidual: dto.maximumAbsoluteActionResidual,
    actionResidualScales: dto.actionResidualScales,
    finalOutcomeWeight: dto.finalOutcomeWeight,
    expectedSourceSha256: dto.expectedSourceSha256,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
