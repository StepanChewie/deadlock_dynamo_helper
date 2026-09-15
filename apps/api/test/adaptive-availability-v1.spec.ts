import { AdaptiveAvailabilityV1Service } from '../src/statlocker-adaptive/adaptive-availability-v1.service';
import { AdaptiveRecommendationV2Controller } from '../src/statlocker-adaptive/adaptive-recommendation-v2.controller';
import { AdaptiveStatusCompatibilityV1Controller } from '../src/statlocker-adaptive/adaptive-status-compatibility-v1.controller';

function disabledAvailability(message?: string) {
  return {
    getAvailability: () => ({
      recommendationsEnabled: false,
      maintenanceMessage: message,
      disabledHeroIds: [],
      disabledRulesetIds: [],
      disabledCatalogSha: [],
    }),
  };
}

describe('AdaptiveAvailabilityV1Service', () => {
  const service = new AdaptiveAvailabilityV1Service();

  it('serves recommendations when nothing is configured', () => {
    const availability = service.getAvailability({} as NodeJS.ProcessEnv);

    expect(availability.recommendationsEnabled).toBe(true);
    expect(availability.maintenanceMessage).toBeUndefined();
    expect(availability.disabledHeroIds).toEqual([]);
  });

  it('switches recommendations off from the environment', () => {
    const availability = service.getAvailability({
      ADAPTIVE_RECOMMENDATIONS_ENABLED: 'false',
      ADAPTIVE_MAINTENANCE_MESSAGE: 'Deadlock patch in progress',
      ADAPTIVE_MINIMUM_CLIENT_VERSION: '0.2.0',
    } as NodeJS.ProcessEnv);

    expect(availability.recommendationsEnabled).toBe(false);
    expect(availability.maintenanceMessage).toBe('Deadlock patch in progress');
    expect(availability.minimumClientVersion).toBe('0.2.0');
  });

  it('accepts the usual truthy spellings', () => {
    for (const value of ['1', 'true', 'TRUE', 'yes', 'on']) {
      expect(service.getAvailability({
        ADAPTIVE_RECOMMENDATIONS_ENABLED: value,
      } as NodeJS.ProcessEnv).recommendationsEnabled).toBe(true);
    }
  });

  it('parses comma separated disable lists and drops blanks', () => {
    const availability = service.getAvailability({
      ADAPTIVE_DISABLED_HERO_IDS: '7, 12 ,',
      ADAPTIVE_DISABLED_RULESET_IDS: '2026-09-14',
      ADAPTIVE_DISABLED_CATALOG_SHA: 'abc,def',
    } as NodeJS.ProcessEnv);

    expect(availability.disabledHeroIds).toEqual(['7', '12']);
    expect(availability.disabledRulesetIds).toEqual(['2026-09-14']);
    expect(availability.disabledCatalogSha).toEqual(['abc', 'def']);
  });
});

describe('Adaptive status kill switch reporting', () => {
  it('reports a disabled recommendation state with a maintenance message', () => {
    const controller = new AdaptiveStatusCompatibilityV1Controller(
      { getStatus: () => ({}) } as never,
      { getLocalStatus: () => ({ families: [] }) } as never,
      { getStatus: () => ({}) } as never,
      { getStatus: () => ({}) } as never,
      disabledAvailability('Deadlock patch in progress') as never,
    );

    const status = controller.status();

    expect(status).toHaveProperty('recommendationsEnabled');
    expect(status.recommendationsEnabled).toBe(false);
    expect(status.maintenanceMessage).toBe('Deadlock patch in progress');
  });

  it('reports recommendations as enabled by default', () => {
    const controller = new AdaptiveStatusCompatibilityV1Controller(
      { getStatus: () => ({}) } as never,
      { getLocalStatus: () => ({ families: [] }) } as never,
      { getStatus: () => ({}) } as never,
      { getStatus: () => ({}) } as never,
      new AdaptiveAvailabilityV1Service(),
    );

    expect(controller.status().recommendationsEnabled).toBe(true);
  });
});

describe('Adaptive recommendation kill switch', () => {
  function controllerWith(recommend: jest.Mock, availability: unknown) {
    return new AdaptiveRecommendationV2Controller(
      { recommend } as never,
      { record: jest.fn().mockResolvedValue(undefined) } as never,
      { getState: () => undefined } as never,
      availability as never,
    );
  }

  it('never builds a route while recommendations are switched off', async () => {
    const recommend = jest.fn();
    const controller = controllerWith(
      recommend,
      disabledAvailability('Deadlock patch in progress'),
    );

    const result = await controller.recommend({ matchId: 'match-1' });

    expect(result.ready).toBe(false);
    expect(result.blockers).toContain('RECOMMENDATIONS_DISABLED');
    expect(result.degradedReasons).toContain('Deadlock patch in progress');
    expect(result.nextAction.type).toBe('HOLD');
    expect(result.fullBuild).toBeUndefined();
    expect(recommend).not.toHaveBeenCalled();
  });

  it('still builds a route when the switch is on', async () => {
    const recommend = jest.fn().mockResolvedValue({
      ready: true,
      blockers: [],
      decisionId: 'decision-1',
      stateRevision: 'revision-1',
      nextAction: { type: 'BUY', actionKey: 'BUY:1', buyItemId: 1, targetItemId: 1, reasonCodes: [] },
      score: { total: 1, confidence: 1 },
      degradedReasons: [],
    });
    const controller = controllerWith(recommend, {
      getAvailability: () => ({
        recommendationsEnabled: true,
        disabledHeroIds: [],
        disabledRulesetIds: [],
        disabledCatalogSha: [],
      }),
    });

    const result = await controller.recommend({ matchId: 'match-1' });

    expect(result.ready).toBe(true);
    expect(recommend).toHaveBeenCalled();
  });
});
