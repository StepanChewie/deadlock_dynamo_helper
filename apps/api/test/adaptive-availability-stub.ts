import type { AdaptiveAvailabilityV1Service } from '../src/statlocker-adaptive/adaptive-availability-v1.service';

/**
 * Test double for the kill switch service. Suites that are not about the kill
 * switch want the pre-existing permissive behaviour: recommendations on, no
 * maintenance message, nothing disabled.
 */
export function enabledAvailability(): AdaptiveAvailabilityV1Service {
  return {
    getAvailability: () => ({
      recommendationsEnabled: true,
      disabledHeroIds: [],
      disabledRulesetIds: [],
      disabledCatalogSha: [],
    }),
  } as unknown as AdaptiveAvailabilityV1Service;
}
