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
  RecommendationBehavioralV4TrainingService,
  RecommendationBehavioralV4TrainingStartRequest,
} from './recommendation-behavioral-v4-training.service';

export class StartRecommendationBehavioralV4TrainingDto {
  trainFraction?: number;
  smoothing?: number;
  minContextObservations?: number;
  maxCandidateActions?: number;
  expectedSourceSha256?: string;
}

@Controller('deadlock/analysis/recommendation-behavioral-v4-training')
export class RecommendationBehavioralV4TrainingController {
  constructor(
    private readonly trainingService:
      RecommendationBehavioralV4TrainingService,
  ) {}

  @Post('start')
  @HttpCode(202)
  async start(@Body() dto: StartRecommendationBehavioralV4TrainingDto) {
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
        'No completed Recommendation Behavioral V4 training manifest is available.',
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
        'No completed Recommendation Behavioral V4 training audit is available.',
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
        'No completed Recommendation Behavioral V4 validation evaluation is available.',
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
        'No completed Recommendation Behavioral V4 model is available.',
      );
    }
    return model;
  }

  private assertNotRunning(): void {
    if (this.trainingService.getStatus().state === 'RUNNING') {
      throw new ConflictException(
        'Recommendation Behavioral V4 training is still running.',
      );
    }
  }
}

function parseRequest(
  dto: StartRecommendationBehavioralV4TrainingDto,
): RecommendationBehavioralV4TrainingStartRequest {
  return {
    trainFraction: dto.trainFraction,
    smoothing: dto.smoothing,
    minContextObservations: dto.minContextObservations,
    maxCandidateActions: dto.maxCandidateActions,
    expectedSourceSha256: dto.expectedSourceSha256,
  };
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
