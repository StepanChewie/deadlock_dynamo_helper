import { OverwolfLiveEventDto } from '@dynamo-lab/shared';
import { LiveEventBuffer } from './live-event-buffer';

/**
 * These specs cover the failure mode that took live ingest down in production:
 * a batch the server refuses to accept was retried forever and blocked every
 * batch behind it, so the client kept sending the same rejected payload while
 * accumulating new events in memory without limit.
 */
describe('LiveEventBuffer rejected batch handling', () => {
  async function settleMicrotasks(): Promise<void> {
    for (let index = 0; index < 8; index += 1) {
      await Promise.resolve();
    }
  }

  async function drainTimers(rounds = 30): Promise<void> {
    for (let index = 0; index < rounds; index += 1) {
      jest.advanceTimersByTime(0);
      await settleMicrotasks();
    }
  }

  function event(receivedAt: number): OverwolfLiveEventDto {
    return {
      receivedAt,
      source: 'onInfoUpdates2',
      key: 'match_clock',
      payload: `${receivedAt}`,
    };
  }

  it('drops a batch the server rejects permanently instead of blocking the queue', async () => {
    jest.useFakeTimers();
    try {
      const calls: any[] = [];
      const fetchImpl = jest.fn(async (_url: string, init?: RequestInit): Promise<Response> => {
        calls.push(JSON.parse(String(init?.body)));
        return calls.length === 1
          ? ({ ok: false, status: 413 } as Response)
          : ({ ok: true, status: 201 } as Response);
      });
      const buffer = new LiveEventBuffer('client-1', 'http://localhost:3000', fetchImpl, 10);

      buffer.push(event(1));
      jest.advanceTimersByTime(10);
      await settleMicrotasks();
      expect(fetchImpl).toHaveBeenCalledTimes(1);

      // The rejected batch must be gone: the next event is sent, not the 413 again.
      buffer.push(event(2));
      jest.advanceTimersByTime(10);
      await settleMicrotasks();

      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(calls[1].events).toEqual([expect.objectContaining({ receivedAt: 2 })]);
    } finally {
      jest.useRealTimers();
    }
  });

  it('gives up on a batch after a bounded number of failed attempts', async () => {
    jest.useFakeTimers();
    try {
      const calls: any[] = [];
      const fetchImpl = jest.fn(async (_url: string, init?: RequestInit): Promise<Response> => {
        const body = JSON.parse(String(init?.body));
        calls.push(body);
        return body.events[0].receivedAt === 1
          ? ({ ok: false, status: 500 } as Response)
          : ({ ok: true, status: 201 } as Response);
      });
      const buffer = new LiveEventBuffer('client-1', 'http://localhost:3000', fetchImpl, 10);

      buffer.push(event(1));

      // Backoff for a 10ms flush delay doubles up to the 30s ceiling, so ten
      // attempts are spaced 10, 10, 20, 40, 80, 160, 320, 640, 1280, 2560ms.
      for (const delay of [10, 10, 20, 40, 80, 160, 320, 640, 1280, 2560]) {
        jest.advanceTimersByTime(delay);
        await settleMicrotasks();
      }

      expect(fetchImpl).toHaveBeenCalledTimes(10);
      expect(calls.every((call) => call.events[0].receivedAt === 1)).toBe(true);

      // The stuck batch has been discarded, so the queue can make progress again.
      buffer.push(event(2));
      jest.advanceTimersByTime(10);
      await settleMicrotasks();

      expect(fetchImpl).toHaveBeenCalledTimes(11);
      expect(calls[10].events).toEqual([expect.objectContaining({ receivedAt: 2 })]);
    } finally {
      jest.useRealTimers();
    }
  });

  it('still retries a rate-limited batch, because 429 is transient', async () => {
    jest.useFakeTimers();
    try {
      const calls: any[] = [];
      const fetchImpl = jest.fn(async (_url: string, init?: RequestInit): Promise<Response> => {
        calls.push(JSON.parse(String(init?.body)));
        return calls.length <= 2
          ? ({ ok: false, status: 429 } as Response)
          : ({ ok: true, status: 201 } as Response);
      });
      const buffer = new LiveEventBuffer('client-1', 'http://localhost:3000', fetchImpl, 10);

      buffer.push(event(1));
      jest.advanceTimersByTime(10);
      await settleMicrotasks();
      jest.advanceTimersByTime(10);
      await settleMicrotasks();
      jest.advanceTimersByTime(20);
      await settleMicrotasks();

      expect(fetchImpl).toHaveBeenCalledTimes(3);
      expect(calls[2].events).toEqual([expect.objectContaining({ receivedAt: 1 })]);
    } finally {
      jest.useRealTimers();
    }
  });

  it('splits a large backlog into requests instead of sending one oversized body', async () => {
    jest.useFakeTimers();
    try {
      const calls: any[] = [];
      const fetchImpl = jest.fn(async (_url: string, init?: RequestInit): Promise<Response> => {
        calls.push(JSON.parse(String(init?.body)));
        return { ok: true, status: 201 } as Response;
      });
      const buffer = new LiveEventBuffer('client-1', 'http://localhost:3000', fetchImpl, 10);

      for (let index = 1; index <= 1200; index += 1) {
        buffer.push(event(index));
      }

      jest.advanceTimersByTime(10);
      await settleMicrotasks();
      await drainTimers();

      expect(calls.map((call) => call.events.length)).toEqual([500, 500, 200]);
    } finally {
      jest.useRealTimers();
    }
  });

  it('bounds the queue while a request never settles, keeping the newest events', async () => {
    jest.useFakeTimers();
    try {
      const calls: any[] = [];
      let resolveFirst: ((response: Response) => void) | undefined;
      const fetchImpl = jest.fn((_url: string, init?: RequestInit): Promise<Response> => {
        calls.push(JSON.parse(String(init?.body)));
        if (calls.length === 1) {
          return new Promise<Response>((resolve) => {
            resolveFirst = resolve;
          });
        }
        return Promise.resolve({ ok: true, status: 201 } as Response);
      });
      const buffer = new LiveEventBuffer('client-1', 'http://localhost:3000', fetchImpl, 10);

      buffer.push(event(0));
      jest.advanceTimersByTime(10);
      await settleMicrotasks();
      expect(fetchImpl).toHaveBeenCalledTimes(1);

      // Queue far more batches than the ceiling while the first request hangs.
      for (let index = 1; index <= 15; index += 1) {
        buffer.push(event(index));
        jest.advanceTimersByTime(10);
        await settleMicrotasks();
      }
      expect(fetchImpl).toHaveBeenCalledTimes(1);

      resolveFirst?.({ ok: true, status: 201 } as Response);
      await settleMicrotasks();
      await drainTimers();

      // One in-flight request plus the capped backlog, not all sixteen batches.
      expect(fetchImpl).toHaveBeenCalledTimes(11);
      expect(calls[calls.length - 1].events).toEqual([
        expect.objectContaining({ receivedAt: 15 }),
      ]);
    } finally {
      jest.useRealTimers();
    }
  });
});
