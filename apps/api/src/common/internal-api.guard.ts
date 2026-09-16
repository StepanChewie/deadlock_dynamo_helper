import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';

export const INTERNAL_API_KEY_HEADER = 'x-dynamo-internal-key';

interface InternalRequestV1 {
  headers?: Record<string, string | string[] | undefined>;
}

/**
 * Guards operator-only routes: reference-data imports, ruleset mutations, live
 * match inspection, the live debug page and the Statlocker research probe.
 *
 * The routes the shipped Overwolf client uses must NEVER carry this guard --
 * that client holds no key. It calls exactly three endpoints:
 *   POST /deadlock/adaptive/v2/recommend
 *   POST /deadlock/adaptive/v1/feedback
 *   POST /deadlock/live/events
 *
 * Do not register this globally via APP_GUARD. `GET /deadlock/adaptive/v1/status`
 * is the container healthcheck in docker-compose.yml and is asserted over the
 * public origin in deploy.yml, so it has to stay reachable without a key. The
 * deploy also asserts that retired /deadlock/analysis/* routes return 404 -- a
 * global guard would turn those into 401 and fail the deploy.
 */
@Injectable()
export class InternalApiGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    // Read per call rather than caching in a field: a NestJS provider is built
    // once at bootstrap, so caching would freeze whatever the environment held
    // at that moment and make the guard awkward to test.
    const expected = readExpectedKey();

    if (!expected) {
      // Fail closed. An unset key must never mean "route is public".
      throw new UnauthorizedException('Internal API key is not configured');
    }

    const request = context.switchToHttp().getRequest<InternalRequestV1>();
    const provided = readHeader(request.headers?.[INTERNAL_API_KEY_HEADER]);

    if (!provided || !constantTimeEquals(provided, expected)) {
      throw new UnauthorizedException('Internal API authentication required');
    }
    return true;
  }
}

function readExpectedKey(): string {
  return process.env.INTERNAL_API_KEY?.trim() ?? '';
}

function readHeader(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0]?.trim() ?? '';
  return value?.trim() ?? '';
}

function constantTimeEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'utf8');
  const rightBuffer = Buffer.from(right, 'utf8');
  // timingSafeEqual throws on length mismatch, so compare lengths first. This
  // leaks the key length, which is not considered sensitive here.
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
