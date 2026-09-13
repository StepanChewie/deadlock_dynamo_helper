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
  ContextualV3FinalTestStartRequest,
  HeroBuildContextualV3FinalTestService,
} from './hero-build-contextual-v3-final-test.service';

export class StartContextualV3FinalTestDto {
  batchSize?: number;
}

@Controller('deadlock/analysis/contextual-v3-final-test')
export class HeroBuildContextualV3FinalTestController {
  constructor(
    private readonly finalTestService: HeroBuildContextualV3FinalTestService,
  ) {}

  @Post('start')
  @HttpCode(202)
  async start(@Body() dto: StartContextualV3FinalTestDto) {
    if (this.finalTestService.getStatus().state === 'RUNNING') {
      throw new ConflictException('Contextual V3 future final test is already running.');
    }
    try {
      const request: ContextualV3FinalTestStartRequest = {
        batchSize: dto?.batchSize,
      };
      return await this.finalTestService.start(request);
    } catch (error) {
      throw new BadRequestException(getErrorMessage(error));
    }
  }

  @Get('status')
  getStatus() {
    return this.finalTestService.getStatus();
  }

  @Get('evaluation')
  getEvaluation() {
    this.assertNotRunning();
    const evaluation = this.finalTestService.getEvaluation();
    if (!evaluation) {
      throw new NotFoundException(
        'No completed Contextual V3 future final-test evaluation is available.',
      );
    }
    return evaluation;
  }

  @Get('audit')
  getAudit() {
    this.assertNotRunning();
    const audit = this.finalTestService.getAudit();
    if (!audit) {
      throw new NotFoundException(
        'No completed Contextual V3 future final-test audit is available.',
      );
    }
    return audit;
  }

  @Get('manifest')
  getManifest() {
    this.assertNotRunning();
    const manifest = this.finalTestService.getManifest();
    if (!manifest) {
      throw new NotFoundException(
        'No completed Contextual V3 future final-test manifest is available.',
      );
    }
    return manifest;
  }

  private assertNotRunning(): void {
    if (this.finalTestService.getStatus().state === 'RUNNING') {
      throw new ConflictException('Contextual V3 future final test is still running.');
    }
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
