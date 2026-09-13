import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CrawlerRun } from './entities/crawler-run.entity';
import { CrawlerState } from './entities/crawler-state.entity';
import { Hero } from './entities/hero.entity';
import { Item } from './entities/item.entity';
import { Match } from './entities/match.entity';
import { MatchPlayer } from './entities/match-player.entity';
import { HeroBuildTransitionAggregationService } from './hero-build-transition-aggregation.service';
import { RecentMatchCrawlerService } from './recent-match-crawler.service';

@Injectable()
export class IngestStatusService {
  constructor(
    @InjectRepository(Match)
    private readonly matchRepo: Repository<Match>,
    @InjectRepository(MatchPlayer)
    private readonly matchPlayerRepo: Repository<MatchPlayer>,
    @InjectRepository(Hero)
    private readonly heroRepo: Repository<Hero>,
    @InjectRepository(Item)
    private readonly itemRepo: Repository<Item>,
    @InjectRepository(CrawlerState)
    private readonly crawlerStateRepo: Repository<CrawlerState>,
    @InjectRepository(CrawlerRun)
    private readonly crawlerRunRepo: Repository<CrawlerRun>,
    private readonly recentMatchCrawlerService: RecentMatchCrawlerService,
    private readonly heroBuildTransitionAggregationService:
      HeroBuildTransitionAggregationService,
  ) {}

  async getStatus() {
    const [
      matchesTotal,
      matchPlayersTotal,
      heroesTotal,
      itemsTotal,
      crawlerStates,
      latestRuns,
    ] = await Promise.all([
      this.matchRepo.count(),
      this.matchPlayerRepo.count(),
      this.heroRepo.count(),
      this.itemRepo.count(),
      this.crawlerStateRepo.find({ order: { crawlerType: 'ASC' } }),
      this.crawlerRunRepo.find({ order: { startedAt: 'DESC' }, take: 5 }),
    ]);

    return {
      matchesTotal,
      matchPlayersTotal,
      heroesTotal,
      itemsTotal,
      crawlerStates,
      latestRuns,
      liveProgress: {
        recentMatches: this.recentMatchCrawlerService.getProgress(),
        graphPolicy: this.heroBuildTransitionAggregationService.getStatus(),
      },
    };
  }
}
