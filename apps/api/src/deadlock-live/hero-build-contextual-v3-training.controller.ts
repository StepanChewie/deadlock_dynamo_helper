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
import { HeroBuildContextualV3TrainingCoordinatorService } from './hero-build-contextual-v3-training-coordinator.service';
import { ContextualV3TrainingStartRequest } from './hero-build-contextual-v3-training.service';

export class StartContextualV3TrainingDto {
  trainFraction?: number;
  maxArchetypesPerHero?: number;
  minArchetypePlayers?: number;
  candidateLimit?: number;
  smoothing?: number;
  expectedSourceSha256?: string;
}

@Controller('deadlock/analysis/contextual-v3-training')
export class HeroBuildContextualV3TrainingController {
  constructor(
    private readonly trainingCoordinator:
      HeroBuildContextualV3TrainingCoordinatorService,
  ) {}

  @Post('start')
  @HttpCode(202)
  async start(@Body() dto: StartContextualV3TrainingDto) {
    try {
      return await this.trainingCoordinator.start(parseRequest(dto ?? {}));
    } catch (error) {
      throw new BadRequestException(getErrorMessage(error));
    }
  }

  @Get('status')
  getStatus() {
    return this.trainingCoordinator.getStatus();
  }

  @Get('manifest')
  getManifest() {
    this.assertNotRunning();
    const manifest = this.trainingCoordinator.getManifest();
    if (!manifest) {
      throw new NotFoundException(
        'No completed Contextual V3 training manifest is available.',
      );
    }
    return manifest;
  }

  @Get('audit')
  getAudit() {
    this.assertNotRunning();
    const audit = this.trainingCoordinator.getAudit();
    if (!audit) {
      throw new NotFoundException(
        'No completed Contextual V3 training audit is available.',
      );
    }
    return audit;
  }

  @Get('evaluation')
  getEvaluation() {
    this.assertNotRunning();
    const evaluation = this.trainingCoordinator.getEvaluation();
    if (!evaluation) {
      throw new NotFoundException(
        'No completed Contextual V3 validation evaluation is available.',
      );
    }
    return evaluation;
  }

  @Get('archetypes')
  getArchetypes() {
    this.assertNotRunning();
    const archetypes = this.trainingCoordinator.getArchetypes();
    if (!archetypes) {
      throw new NotFoundException(
        'No completed Contextual V3 archetype artifact is available.',
      );
    }
    return archetypes;
  }

  private assertNotRunning(): void {
    if (this.trainingCoordinator.getStatus().state === 'RUNNING') {
      throw new ConflictException('Contextual V3 training is still running.');
    }
  }
}

function parseRequest(
  dto: StartContextualV3TrainingDto,
): ContextualV3TrainingStartRequest {
  return {
    trainFraction: dto.trainFraction,
    maxArchetypesPerHero: dto.maxArchetypesPerHero,
    minArchetypePlayers: dto.minArchetypePlayers,
    candidateLimit: dto.candidateLimit,
    smoothing: dto.smoothing,
    expectedSourceSha256: dto.expectedSourceSha256,
  };
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
