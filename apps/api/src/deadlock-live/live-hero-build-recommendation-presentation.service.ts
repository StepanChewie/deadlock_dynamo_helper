import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Hero } from './entities/hero.entity';
import { Item } from './entities/item.entity';
import { HeroBuildRecommendationOwnershipFilterService } from './hero-build-recommendation-ownership-filter.service';
import {
  HeroBuildPresentedRecommendation,
  HeroBuildRecommendationPresentationService,
} from './hero-build-recommendation-presentation.service';
import { HeroBuildRecommendationResponse } from './hero-build-recommendation.service';

@Injectable()
export class LiveHeroBuildRecommendationPresentationService extends HeroBuildRecommendationPresentationService {
  constructor(
    @InjectRepository(Item)
    itemRepository: Repository<Item>,
    @InjectRepository(Hero)
    heroRepository: Repository<Hero>,
    private readonly ownershipFilterService:
      HeroBuildRecommendationOwnershipFilterService,
  ) {
    super(itemRepository, heroRepository);
  }

  override async present<T extends HeroBuildRecommendationResponse>(
    response: T,
  ): Promise<HeroBuildPresentedRecommendation<T>> {
    return super.present(this.ownershipFilterService.filter(response));
  }
}
