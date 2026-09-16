import { GUARDS_METADATA } from '@nestjs/common/constants';
import { InternalApiGuard } from '../src/common/internal-api.guard';
import { DebugPageController } from '../src/deadlock-live/debug-page.controller';
import { LiveIngestController } from '../src/deadlock-live/live-ingest.controller';
import { ReferenceDataController } from '../src/deadlock-live/reference-data.controller';
import { AdaptiveFeedbackV1Controller } from '../src/statlocker-adaptive/adaptive-feedback-v1.controller';
import { AdaptiveRecommendationV2Controller } from '../src/statlocker-adaptive/adaptive-recommendation-v2.controller';
import { AdaptiveStatusCompatibilityV1Controller } from '../src/statlocker-adaptive/adaptive-status-compatibility-v1.controller';
import { StatlockerProbeController } from '../src/statlocker-probe/statlocker-probe.controller';

/**
 * Locks in which routes carry InternalApiGuard. The negative assertions matter
 * as much as the positive ones: guarding the healthcheck or the routes the
 * shipped Overwolf client uses would break production, and it would break it
 * silently at the edge rather than in a unit test.
 */
function guardNamesOn(target: object): string[] {
  const guards = (Reflect.getMetadata(GUARDS_METADATA, target) as unknown[]) ?? [];
  return guards.map((guard) => (guard as { name?: string })?.name ?? String(guard));
}

function guardNamesOnMethod(controller: object, method: string): string[] {
  // Handlers are declared on the prototype, not on the constructor itself.
  const prototype = (controller as { prototype?: Record<string, unknown> }).prototype;
  const handler = prototype?.[method];
  if (typeof handler !== 'function') {
    throw new Error(`Method ${method} does not exist on the controller prototype`);
  }
  return guardNamesOn(handler);
}

const GUARD = InternalApiGuard.name;

describe('InternalApiGuard wiring', () => {
  describe('guarded: operator-only surfaces', () => {
    it('guards the whole reference-data controller, including ruleset mutations', () => {
      expect(guardNamesOn(ReferenceDataController)).toContain(GUARD);
    });

    it.each([
      'getStates',
      'getState',
      'getInventoryShadow',
      'getPlayerInventoryShadow',
      'getRecentEvents',
    ])('guards LiveIngestController.%s', (method) => {
      expect(guardNamesOnMethod(LiveIngestController, method)).toContain(GUARD);
    });

    it.each(['getPresets', 'discover', 'request', 'browserRequest'])(
      'guards StatlockerProbeController.%s',
      (method) => {
        expect(guardNamesOnMethod(StatlockerProbeController, method)).toContain(GUARD);
      },
    );
  });

  describe('unguarded: routes that must stay reachable without a key', () => {
    it('does NOT guard POST /deadlock/live/events -- the client posts here', () => {
      expect(guardNamesOnMethod(LiveIngestController, 'ingestEvents')).not.toContain(GUARD);
    });

    it('does NOT guard POST /deadlock/adaptive/v2/recommend', () => {
      expect(guardNamesOnMethod(AdaptiveRecommendationV2Controller, 'recommend')).not.toContain(
        GUARD,
      );
    });

    it('does NOT guard POST /deadlock/adaptive/v1/feedback', () => {
      expect(guardNamesOnMethod(AdaptiveFeedbackV1Controller, 'submit')).not.toContain(GUARD);
    });

    it('does NOT guard GET /deadlock/adaptive/v1/status -- this is the container healthcheck', () => {
      expect(guardNamesOn(AdaptiveStatusCompatibilityV1Controller)).not.toContain(GUARD);
      expect(guardNamesOnMethod(AdaptiveStatusCompatibilityV1Controller, 'status')).not.toContain(
        GUARD,
      );
    });

    it('does NOT guard the debug page shell, so the browser can load it and ask for the key', () => {
      expect(guardNamesOn(DebugPageController)).not.toContain(GUARD);
      expect(guardNamesOnMethod(DebugPageController, 'getDebugPage')).not.toContain(GUARD);
    });

    it('does NOT guard the statelocker probe shell or its client bundle', () => {
      expect(guardNamesOn(StatlockerProbeController)).not.toContain(GUARD);
      expect(guardNamesOnMethod(StatlockerProbeController, 'getUi')).not.toContain(GUARD);
      expect(guardNamesOnMethod(StatlockerProbeController, 'getClient')).not.toContain(GUARD);
    });
  });

  it('never guards the live-ingest controller at class level', () => {
    // A class-level guard here would also cover POST events and break ingest.
    expect(guardNamesOn(LiveIngestController)).not.toContain(GUARD);
  });
});
