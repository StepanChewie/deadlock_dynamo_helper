import { GUARDS_METADATA } from '@nestjs/common/constants';
import { InternalApiGuard } from '../src/common/internal-api.guard';
import { RateLimitGuard, readRateLimit } from '../src/common/rate-limit.guard';
import { LiveIngestController } from '../src/deadlock-live/live-ingest.controller';
import { AdaptiveFeedbackV1Controller } from '../src/statlocker-adaptive/adaptive-feedback-v1.controller';
import { AdaptiveRecommendationV2Controller } from '../src/statlocker-adaptive/adaptive-recommendation-v2.controller';
import { AdaptiveStatusCompatibilityV1Controller } from '../src/statlocker-adaptive/adaptive-status-compatibility-v1.controller';
import { StatlockerProbeController } from '../src/statlocker-probe/statlocker-probe.controller';

function handlerOf(controller: object, method: string): object {
  const prototype = (controller as { prototype?: Record<string, unknown> }).prototype;
  const handler = prototype?.[method];
  if (typeof handler !== 'function') {
    throw new Error(`Method ${method} does not exist on the controller prototype`);
  }
  return handler;
}

function guardNamesOnMethod(controller: object, method: string): string[] {
  const guards = (Reflect.getMetadata(GUARDS_METADATA, handlerOf(controller, method)) as unknown[]) ?? [];
  return guards.map((guard) => (guard as { name?: string })?.name ?? String(guard));
}

/**
 * Peak requests per minute from a single address, measured across 181,142 nginx
 * access-log lines (6-16 Sep 2026). The limits must clear these, because the
 * shipped client retries any non-2xx response, so a limit set below real
 * traffic costs data rather than merely being a no-op.
 */
const MEASURED_PEAK_PER_MINUTE = {
  'POST /deadlock/live/events': 245,
  'POST /deadlock/adaptive/v2/recommend': 35,
  'POST /deadlock/adaptive/v1/feedback': 1,
  'GET /deadlock/adaptive/v1/status': 2,
} as const;

describe('RateLimitGuard wiring', () => {
  const limited: Array<[string, object, string, number]> = [
    ['POST /deadlock/live/events', LiveIngestController, 'ingestEvents', MEASURED_PEAK_PER_MINUTE['POST /deadlock/live/events']],
    ['POST /deadlock/adaptive/v2/recommend', AdaptiveRecommendationV2Controller, 'recommend', MEASURED_PEAK_PER_MINUTE['POST /deadlock/adaptive/v2/recommend']],
    ['POST /deadlock/adaptive/v1/feedback', AdaptiveFeedbackV1Controller, 'submit', MEASURED_PEAK_PER_MINUTE['POST /deadlock/adaptive/v1/feedback']],
    ['GET /deadlock/adaptive/v1/status', AdaptiveStatusCompatibilityV1Controller, 'status', MEASURED_PEAK_PER_MINUTE['GET /deadlock/adaptive/v1/status']],
  ];

  describe('public routes carry a limit', () => {
    it.each(limited)('%s', (_route, controller, method) => {
      expect(guardNamesOnMethod(controller, method)).toContain(RateLimitGuard.name);
    });

    it.each(limited)('%s is limited above measured peak traffic', (route, controller, method, peak) => {
      const options = readRateLimit(handlerOf(controller, method));
      expect(options).toBeDefined();
      expect(options?.windowMs).toBe(60_000);
      expect(options?.limit).toBeGreaterThan(peak);
      expect(route).toBeTruthy();
    });
  });

  describe('routes that must not be limited', () => {
    it('does not rate limit the internal-key operator routes', () => {
      // These are already behind the internal key, and the debug tooling polls
      // them in bursts. A 429 here would break the operator's own tooling.
      for (const method of ['getStates', 'getRecentEvents']) {
        expect(guardNamesOnMethod(LiveIngestController, method)).not.toContain(
          RateLimitGuard.name,
        );
      }
    });

    it('does not rate limit the Statlocker probe', () => {
      for (const method of ['getPresets', 'discover', 'request', 'browserRequest']) {
        expect(guardNamesOnMethod(StatlockerProbeController, method)).not.toContain(
          RateLimitGuard.name,
        );
      }
    });
  });

  it('keeps ingest public while still limiting it', () => {
    const guards = guardNamesOnMethod(LiveIngestController, 'ingestEvents');
    expect(guards).toContain(RateLimitGuard.name);
    expect(guards).not.toContain(InternalApiGuard.name);
  });
});
