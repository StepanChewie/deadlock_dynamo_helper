import { Injectable } from '@nestjs/common';
import { CanonicalBuildSequenceService } from './canonical-build-sequence.service';
import { HeroBuildTransitionAggregationService } from './hero-build-transition-aggregation.service';
import { InventoryTimelineReplayService } from './inventory-timeline-replay.service';
import { MatchTimelineNormalizationService } from './match-timeline-normalization.service';
import { RecentMatchesWindowService } from './recent-matches-window.service';
import { RecipeAwareTimelineReconciliationService } from './recipe-aware-timeline-reconciliation.service';

@Injectable()
export class LazyBuildTransitionAggregationService extends HeroBuildTransitionAggregationService {
  constructor(
    recentMatchesWindowService: RecentMatchesWindowService,
    matchTimelineNormalizationService: MatchTimelineNormalizationService,
    inventoryTimelineReplayService: InventoryTimelineReplayService,
    canonicalBuildSequenceService: CanonicalBuildSequenceService,
    recipeAwareTimelineReconciliationService: RecipeAwareTimelineReconciliationService,
  ) {
    super(
      recentMatchesWindowService,
      matchTimelineNormalizationService,
      inventoryTimelineReplayService,
      canonicalBuildSequenceService,
      recipeAwareTimelineReconciliationService,
    );
  }

  override onModuleInit(): void {}

  override refreshOnInterval(): void {}
}
