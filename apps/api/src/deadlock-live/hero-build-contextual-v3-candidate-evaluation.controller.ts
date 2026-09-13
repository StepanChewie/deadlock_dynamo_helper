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
  ContextualV3CandidateEvaluationStartRequest,
  HeroBuildContextualV3CandidateEvaluationService,
} from './hero-build-contextual-v3-candidate-evaluation.service';

export class StartContextualV3CandidateEvaluationDto {
  candidateLimit?: number;
}

@Controller('deadlock/analysis/contextual-v3-candidate-evaluation')
export class HeroBuildContextualV3CandidateEvaluationController {
  constructor(
    private readonly evaluationService: HeroBuildContextualV3CandidateEvaluationService,
  ) {}

  @Post('start')
  @HttpCode(202)
  async start(@Body() dto: StartContextualV3CandidateEvaluationDto) {
    if (this.evaluationService.getStatus().state === 'RUNNING') {
      throw new ConflictException('Contextual V3 candidate evaluation is already running.');
    }
    try {
      const request: ContextualV3CandidateEvaluationStartRequest = {
        candidateLimit: dto?.candidateLimit,
      };
      return await this.evaluationService.start(request);
    } catch (error) {
      throw new BadRequestException(getErrorMessage(error));
    }
  }

  @Get('status')
  getStatus() {
    return this.evaluationService.getStatus();
  }

  @Get('evaluation')
  getEvaluation() {
    this.assertNotRunning();
    const evaluation = this.evaluationService.getEvaluation();
    if (!evaluation) {
      throw new NotFoundException(
        'No completed Contextual V3 candidate evaluation is available.',
      );
    }
    return evaluation;
  }

  @Get('audit')
  getAudit() {
    this.assertNotRunning();
    const audit = this.evaluationService.getAudit();
    if (!audit) {
      throw new NotFoundException(
        'No completed Contextual V3 candidate evaluation audit is available.',
      );
    }
    return audit;
  }

  @Get('manifest')
  getManifest() {
    this.assertNotRunning();
    const manifest = this.evaluationService.getManifest();
    if (!manifest) {
      throw new NotFoundException(
        'No completed Contextual V3 candidate evaluation manifest is available.',
      );
    }
    return manifest;
  }

  private assertNotRunning(): void {
    if (this.evaluationService.getStatus().state === 'RUNNING') {
      throw new ConflictException('Contextual V3 candidate evaluation is still running.');
    }
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
