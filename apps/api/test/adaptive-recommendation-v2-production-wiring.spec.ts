import { MODULE_METADATA } from '@nestjs/common/constants';
import { AdaptiveLiveStateNotReadyError } from '../src/statlocker-adaptive/adaptive-decision-state-v1.service';
import { AdaptiveRecommendationV1Controller } from '../src/statlocker-adaptive/adaptive-recommendation-v1.controller';
import { AdaptiveRecommendationV1Service } from '../src/statlocker-adaptive/adaptive-recommendation-v1.service';
import { AdaptiveRecommendationV2Controller } from '../src/statlocker-adaptive/adaptive-recommendation-v2.controller';
import { AdaptiveRecommendationV2Service } from '../src/statlocker-adaptive/adaptive-recommendation-v2.service';
import { BuildStrategyCompilerV1Service } from '../src/statlocker-adaptive/build-strategy-compiler-v1.service';
import { ConsensusStrategyFallbackV1Service } from '../src/statlocker-adaptive/consensus-strategy-fallback-v1.service';
import { StatlockerAdaptiveModule } from '../src/statlocker-adaptive/statlocker-adaptive.module';
import { StrategyFirstBuildPlannerV1Service } from '../src/statlocker-adaptive/strategy-first-build-planner-v1.service';

describe('Adaptive Recommendation V2 production wiring', () => {
  it('exposes V2 recommendation serving without the V1 recommendation controller/service', () => {
    const controllers = Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, StatlockerAdaptiveModule) ?? [];
    const providers = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, StatlockerAdaptiveModule) ?? [];
    const exports = Reflect.getMetadata(MODULE_METADATA.EXPORTS, StatlockerAdaptiveModule) ?? [];

    expect(controllers).toContain(AdaptiveRecommendationV2Controller);
    expect(providers).toContain(AdaptiveRecommendationV2Service);
    expect(controllers).not.toContain(AdaptiveRecommendationV1Controller);
    expect(providers).not.toContain(AdaptiveRecommendationV1Service);
    expect(exports).not.toContain(AdaptiveRecommendationV1Service);
  });

  it('does not inject V1 compiler/planner/fallback authorities into the V2 service', () => {
    const dependencies = Reflect.getMetadata('design:paramtypes', AdaptiveRecommendationV2Service) ?? [];

    expect(dependencies).not.toContain(ConsensusStrategyFallbackV1Service);
    expect(dependencies).not.toContain(BuildStrategyCompilerV1Service);
    expect(dependencies).not.toContain(StrategyFirstBuildPlannerV1Service);
  });

  it('returns a native V2 waiting response without mapping any V1 plan/result fields', async () => {
    const recommendation = {
      recommend: jest.fn(async () => {
        throw new AdaptiveLiveStateNotReadyError('match-a', 'LIVE_MATCH_STATE_UNAVAILABLE');
      }),
    };
    const controller = new AdaptiveRecommendationV2Controller(recommendation as any);

    const result = await controller.recommend({ matchId: 'match-a' });

    expect(recommendation.recommend).toHaveBeenCalledWith({ matchId: 'match-a' });
    expect(result).toMatchObject({
      ready: false,
      blockers: ['LIVE_STATE_NOT_READY', 'LIVE_MATCH_STATE_UNAVAILABLE'],
      nextAction: { type: 'HOLD' },
      score: { total: 0, confidence: 0 },
    });
    expect(result).not.toHaveProperty('recommendedBuild');
    expect(result).not.toHaveProperty('planActions');
    expect(result).not.toHaveProperty('gameState');
    expect(result).not.toHaveProperty('strategy');
  });
});
