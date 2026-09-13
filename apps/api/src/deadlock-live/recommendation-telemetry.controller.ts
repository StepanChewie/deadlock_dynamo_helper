import { Body, Controller, Post } from '@nestjs/common';
import {
  InventorySnapshotEventV8,
  PlayerStateEventV8,
  RecommendationDecisionEventV8,
  RecommendationExposureAckEventV8,
  RecommendationOutcomeEventV8,
  RecommendationRuntimeHealthEventV8,
} from '@deadlock-live-probe/shared';
import { RecommendationTelemetryIngestV8Service } from './recommendation-telemetry-ingest-v8.service';

type RecommendationTelemetryInputV8 =
  | PlayerStateEventV8
  | InventorySnapshotEventV8
  | RecommendationDecisionEventV8
  | RecommendationExposureAckEventV8
  | RecommendationOutcomeEventV8
  | RecommendationRuntimeHealthEventV8;

@Controller('deadlock-live/recommendation-telemetry/v8')
export class RecommendationTelemetryController {
  constructor(private readonly ingest: RecommendationTelemetryIngestV8Service) {}

  @Post()
  append(@Body() event: RecommendationTelemetryInputV8) {
    return this.ingest.appendExternal(event);
  }
}
