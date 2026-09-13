import { Module } from '@nestjs/common';
import { RecommendationPolicyV6EvaluationController } from './recommendation-policy-v6-evaluation.controller';
import { RecommendationPolicyV6EvaluationService } from './recommendation-policy-v6-evaluation.service';

@Module({
  controllers: [RecommendationPolicyV6EvaluationController],
  providers: [RecommendationPolicyV6EvaluationService],
  exports: [RecommendationPolicyV6EvaluationService],
})
export class RecommendationPolicyV6EvaluationModule {}
