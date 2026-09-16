import { ExecutionContext, HttpException, HttpStatus } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RateLimit, RateLimitGuard } from '../src/common/rate-limit.guard';

class TestController {
  @RateLimit({ limit: 2, windowMs: 1_000 })
  limited(): void {
    // route body is irrelevant to the guard
  }

  @RateLimit({ limit: 1, windowMs: 60_000 })
  anotherRoute(): void {
    // a second route so bucket isolation can be asserted
  }

  unlimited(): void {
    // no @RateLimit: the guard must be a no-op
  }
}

interface StubResponse {
  headers: Record<string, string>;
}

function contextFor(
  handler: unknown,
  ip: string | undefined,
  response: StubResponse,
): ExecutionContext {
  return {
    getHandler: () => handler,
    getClass: () => TestController,
    switchToHttp: () => ({
      getRequest: () => ({ ip }),
      getResponse: () => ({
        setHeader: (name: string, value: string) => {
          response.headers[name] = value;
        },
      }),
    }),
  } as unknown as ExecutionContext;
}

describe('RateLimitGuard', () => {
  let guard: RateLimitGuard;

  beforeEach(() => {
    guard = new RateLimitGuard(new Reflector());
  });

  function activate(handler: unknown, ip: string | undefined = '10.0.0.1'): StubResponse {
    const response: StubResponse = { headers: {} };
    guard.canActivate(contextFor(handler, ip, response));
    return response;
  }

  it('allows requests up to the limit and rejects the next one', () => {
    const handler = TestController.prototype.limited;

    expect(activate(handler)).toBeDefined();
    expect(activate(handler)).toBeDefined();
    expect(() => activate(handler)).toThrow(HttpException);
  });

  it('answers a rejected request with 429 and a retry hint', () => {
    const handler = TestController.prototype.limited;
    activate(handler);
    activate(handler);

    try {
      activate(handler);
      throw new Error('expected the guard to reject');
    } catch (error) {
      expect(error).toBeInstanceOf(HttpException);
      const exception = error as HttpException;
      expect(exception.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
      expect(exception.getResponse()).toMatchObject({
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
      });
    }
  });

  it('sets a Retry-After header when it rejects', () => {
    const handler = TestController.prototype.limited;
    activate(handler);
    activate(handler);

    const response: StubResponse = { headers: {} };
    expect(() => guard.canActivate(contextFor(handler, '10.0.0.1', response))).toThrow(
      HttpException,
    );
    expect(Number(response.headers['Retry-After'])).toBeGreaterThan(0);
  });

  it('tracks each client address separately', () => {
    const handler = TestController.prototype.limited;
    activate(handler, '10.0.0.1');
    activate(handler, '10.0.0.1');
    expect(() => activate(handler, '10.0.0.1')).toThrow(HttpException);

    // A different address still has its full allowance.
    expect(activate(handler, '10.0.0.2')).toBeDefined();
    expect(activate(handler, '10.0.0.2')).toBeDefined();
  });

  it('tracks each route separately', () => {
    const limited = TestController.prototype.limited;
    const another = TestController.prototype.anotherRoute;

    activate(limited, '10.0.0.1');
    activate(limited, '10.0.0.1');
    expect(() => activate(limited, '10.0.0.1')).toThrow(HttpException);

    // A different route from the same address is unaffected.
    expect(activate(another, '10.0.0.1')).toBeDefined();
  });

  it('is a no-op on a handler without a limit', () => {
    const handler = TestController.prototype.unlimited;
    for (let index = 0; index < 50; index += 1) {
      expect(activate(handler)).toBeDefined();
    }
  });

  it('still limits a request with no resolvable address instead of letting it through', () => {
    const handler = TestController.prototype.limited;
    activate(handler, undefined);
    activate(handler, undefined);
    expect(() => activate(handler, undefined)).toThrow(HttpException);
  });

  it('allows traffic again once the window has passed', () => {
    jest.useFakeTimers();
    try {
      const handler = TestController.prototype.limited;
      activate(handler);
      activate(handler);
      expect(() => activate(handler)).toThrow(HttpException);

      jest.advanceTimersByTime(1_001);

      expect(activate(handler)).toBeDefined();
      expect(activate(handler)).toBeDefined();
      expect(() => activate(handler)).toThrow(HttpException);
    } finally {
      jest.useRealTimers();
    }
  });
});
