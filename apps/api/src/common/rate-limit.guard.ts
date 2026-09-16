import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

export interface RateLimitOptions {
  /** Requests allowed per client address per window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
}

const RATE_LIMIT_METADATA = 'dynamo:rate-limit';

/**
 * Marks a handler as rate limited. Limits are attached per route rather than
 * applied globally, because a single global budget cannot fit routes whose
 * legitimate rates differ by two orders of magnitude (see the limits below).
 *
 * The numbers are measured from the nginx access log, not guessed:
 *
 *   POST /deadlock/live/events           p90 64/min   max 245/min per address
 *   POST /deadlock/adaptive/v2/recommend p90 32/min   max  35/min per address
 *   POST /deadlock/adaptive/v1/feedback              max   1/min per address
 *   GET  /deadlock/adaptive/v1/status                max   2/min per address
 *
 * Every limit below is set several times above the observed maximum, so the
 * guard only ever fires on genuinely abnormal traffic.
 */
export const RateLimit = (options: RateLimitOptions) =>
  SetMetadata(RATE_LIMIT_METADATA, options);

/** Reads a handler's configured limit. Used by the wiring tests and diagnostics. */
export function readRateLimit(target: object): RateLimitOptions | undefined {
  return Reflect.getMetadata(RATE_LIMIT_METADATA, target) as RateLimitOptions | undefined;
}

/**
 * Ceiling on tracked addresses. Without it a flood of distinct source
 * addresses would grow this map without bound, turning a rate limiter into the
 * very memory problem it exists to prevent.
 */
const MAX_TRACKED_BUCKETS = 10_000;

interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * A fixed-window limiter keyed by client address and route.
 *
 * Deliberately hand-rolled instead of pulling in `@nestjs/throttler`: the
 * repository had no lockfile entry for it and no `yarn` available to add one
 * safely, and the behaviour needed here is small enough to read in one screen.
 *
 * This only keys on the real client address if Express trusts the nginx hop —
 * see the `trust proxy` setting in `main.ts`. Without it every request behind
 * nginx shares one bucket and the limits throttle everybody at once.
 *
 * Note for anyone adding a limit to a route the shipped Overwolf client calls:
 * the client treats any non-2xx as retryable and retries the same batch, so a
 * limit that is too tight costs real data rather than being a harmless no-op.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly buckets = new Map<string, Bucket>();

  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const options = this.reflector.getAllAndOverride<RateLimitOptions>(RATE_LIMIT_METADATA, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!options || options.limit <= 0 || options.windowMs <= 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest<{ ip?: string }>();
    const key = `${context.getClass().name}.${context.getHandler().name}:${request.ip ?? 'unknown'}`;
    const now = Date.now();

    const current = this.buckets.get(key);
    const bucket =
      current && current.resetAt > now ? current : { count: 0, resetAt: now + options.windowMs };

    if (bucket.count >= options.limit) {
      this.buckets.set(key, bucket);
      this.raiseTooManyRequests(context, bucket.resetAt - now);
    }

    bucket.count += 1;
    this.buckets.set(key, bucket);
    this.evictExpired(now);
    return true;
  }

  private raiseTooManyRequests(context: ExecutionContext, remainingMs: number): never {
    const retryAfterSeconds = Math.max(1, Math.ceil(remainingMs / 1000));
    const response = context.switchToHttp().getResponse<{
      setHeader?: (name: string, value: string) => void;
    }>();

    try {
      response?.setHeader?.('Retry-After', String(retryAfterSeconds));
    } catch {
      // The header is a courtesy; the status code is the contract.
    }

    throw new HttpException(
      {
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        message: 'Too many requests',
        retryAfterSeconds,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }

  private evictExpired(now: number): void {
    if (this.buckets.size <= MAX_TRACKED_BUCKETS) {
      return;
    }

    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) {
        this.buckets.delete(key);
      }
    }

    // Still over the ceiling: drop the oldest keys, which Map preserves in
    // insertion order. Those are the least recently seen addresses.
    while (this.buckets.size > MAX_TRACKED_BUCKETS) {
      const oldest = this.buckets.keys().next();
      if (oldest.done) {
        break;
      }
      this.buckets.delete(oldest.value);
    }
  }
}
