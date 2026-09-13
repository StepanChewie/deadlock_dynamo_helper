import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  HistoricalMatchReplayService,
  ReplayHistoricalMatchesDto,
} from './historical-match-replay.service';
import {
  NormalizeRawMatchMetadataDto,
  RawMatchMetadataNormalizerService,
} from './raw-match-metadata-normalizer.service';
import { RecentMatchCrawlerService } from './recent-match-crawler.service';
import { RecentMatchesWindowService } from './recent-matches-window.service';
import {
  ResolvePendingRulesetsDto,
  RulesetResolverService,
} from './ruleset-resolver.service';
import { RulesetResolutionRefreshService } from './ruleset-resolution-refresh.service';
import { SituationalRecommendationDiagnosticsService } from './situational-recommendation-diagnostics.service';
import { StoredMatchReprocessingService } from './stored-match-reprocessing.service';

@Controller('deadlock/analysis')
export class AnalysisOperationsController {
  constructor(
    private readonly recentMatchCrawlerService: RecentMatchCrawlerService,
    private readonly storedMatchReprocessingService: StoredMatchReprocessingService,
    private readonly recentMatchesWindowService: RecentMatchesWindowService,
    private readonly rulesetResolverService: RulesetResolverService,
    private readonly rulesetResolutionRefreshService: RulesetResolutionRefreshService,
    private readonly rawMatchMetadataNormalizerService: RawMatchMetadataNormalizerService,
    private readonly historicalMatchReplayService: HistoricalMatchReplayService,
    private readonly situationalRecommendationDiagnosticsService:
      SituationalRecommendationDiagnosticsService,
  ) {}

  @Get('crawl/progress')
  getCrawlProgress() {
    return this.recentMatchCrawlerService.getProgress();
  }

  @Post('crawl/start')
  async startCrawl() {
    await this.recentMatchCrawlerService.startCrawling();
    return { success: true, message: 'Background crawl initiated.' };
  }

  @Get('situational/examples')
  async getSituationalExamples(
    @Query('limit') limit?: string,
    @Query('maxEvaluatedActions') maxEvaluatedActions?: string,
    @Query('maxValidatedStates') maxValidatedStates?: string,
  ) {
    const result = await this.situationalRecommendationDiagnosticsService.findExamples({
      limit: parseOptionalPositiveInteger(limit, 'limit'),
      maxEvaluatedActions: parseOptionalPositiveInteger(
        maxEvaluatedActions,
        'maxEvaluatedActions',
      ),
      maxValidatedStates: parseOptionalPositiveInteger(
        maxValidatedStates,
        'maxValidatedStates',
      ),
    });
    const examples = result.examples.map((example) => ({
      ...example,
      wouldTriggerWarning: example.isPrimaryRecommendation,
    }));

    return {
      ...result,
      warningExampleCount: examples.filter(
        (example) => example.wouldTriggerWarning,
      ).length,
      examples,
    };
  }

  @Get('raw-matches/replay/status')
  async getHistoricalReplayStatus() {
    return this.historicalMatchReplayService.getStatus();
  }

  @Post('raw-matches/metadata/normalize-pending')
  async normalizePendingRawMetadata(@Body() dto: NormalizeRawMatchMetadataDto) {
    return this.rawMatchMetadataNormalizerService.normalizePending(dto ?? {});
  }

  @Post('raw-matches/replay-pending')
  async replayHistoricalMatches(@Body() dto: ReplayHistoricalMatchesDto) {
    return this.historicalMatchReplayService.replayPending(dto ?? {});
  }

  @Post('raw-matches/rulesets/resolve-pending')
  async resolvePendingRulesets(@Body() dto: ResolvePendingRulesetsDto) {
    return this.rulesetResolverService.resolvePending(dto ?? {});
  }

  @Get('raw-matches/:matchId/ruleset')
  async getStoredMatchRuleset(@Param('matchId', ParseIntPipe) matchId: number) {
    return this.rulesetResolverService.getLatestForMatch(matchId);
  }

  @Post('raw-matches/:matchId/ruleset/resolve')
  async resolveStoredMatchRuleset(@Param('matchId', ParseIntPipe) matchId: number) {
    return this.rulesetResolutionRefreshService.resolveLatestForMatch(matchId);
  }

  @Post('raw-matches/:matchId/normalize')
  async normalizeStoredMatchMetadata(@Param('matchId', ParseIntPipe) matchId: number) {
    return this.rawMatchMetadataNormalizerService.normalizeLatestForMatch(matchId);
  }

  @Post('raw-matches/:matchId/reprocess')
  async reprocessStoredMatch(@Param('matchId', ParseIntPipe) matchId: number) {
    const result = await this.storedMatchReprocessingService.reprocess(matchId);
    await this.recentMatchesWindowService.refresh();
    return result;
  }
}

function parseOptionalPositiveInteger(
  value: string | undefined,
  fieldName: string,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new BadRequestException(`${fieldName} must be a positive integer.`);
  }
  return parsed;
}
