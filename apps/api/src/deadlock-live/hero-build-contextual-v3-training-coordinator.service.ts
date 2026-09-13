import { Injectable } from '@nestjs/common';
import {
  ContextualV3TrainingStartRequest,
  ContextualV3TrainingStatus,
  HeroBuildContextualV3TrainingService,
} from './hero-build-contextual-v3-training.service';

@Injectable()
export class HeroBuildContextualV3TrainingCoordinatorService {
  private startInFlight?: Promise<ContextualV3TrainingStatus>;

  constructor(
    private readonly trainingService: HeroBuildContextualV3TrainingService,
  ) {}

  getStatus(): ContextualV3TrainingStatus {
    return this.trainingService.getStatus();
  }

  getManifest(): Record<string, unknown> | undefined {
    return this.trainingService.getManifest();
  }

  getAudit(): Record<string, unknown> | undefined {
    return this.trainingService.getAudit();
  }

  getEvaluation(): Record<string, unknown> | undefined {
    return this.trainingService.getEvaluation();
  }

  getArchetypes(): Record<string, unknown> | undefined {
    return this.trainingService.getArchetypes();
  }

  async start(
    request: ContextualV3TrainingStartRequest = {},
  ): Promise<ContextualV3TrainingStatus> {
    if (this.startInFlight || this.trainingService.getStatus().state === 'RUNNING') {
      throw new Error('Contextual V3 training pipeline is already running.');
    }

    const pending = this.trainingService.start(request);
    this.startInFlight = pending;
    try {
      return await pending;
    } finally {
      if (this.startInFlight === pending) {
        this.startInFlight = undefined;
      }
    }
  }
}
