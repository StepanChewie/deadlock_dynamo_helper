import { OverwolfLiveBatchDto, OverwolfLiveEventDto } from '@dynamo-lab/shared';

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
type MatchIdProvider = () => string | undefined;
type InventoryFlushCallback = (batch: OverwolfLiveBatchDto) => void;

const MAX_RETRY_DELAY_MS = 30_000;

/**
 * How many times one batch may fail before it is thrown away.
 *
 * Without a ceiling the queue can never recover: only `pendingBatches[0]` is
 * ever sent, so a batch the server will never accept blocks every later batch
 * forever. That is exactly what happened in production — a single client
 * produced 2,004 rejected requests over five days and silently stopped
 * ingesting for the rest of that period.
 *
 * Ten attempts is roughly three minutes of backoff (1s, 2s, 4s … capped at 30s).
 * That comfortably outlasts a container recreate during a deploy, which a
 * shorter ceiling would turn into silent data loss, while still guaranteeing
 * the queue recovers instead of stalling for days.
 */
const MAX_ATTEMPTS_PER_BATCH = 10;

/**
 * Events per request. A reconnect can leave a large backlog queued, and an
 * unbounded body eventually exceeds the server limit, which is how the stuck
 * batches got stuck in the first place. The API accepts more than this; the
 * client simply never sends more.
 */
const MAX_EVENTS_PER_REQUEST = 500;

/** Unsent batches held in memory. Beyond this the oldest queued batch is dropped. */
const MAX_PENDING_BATCHES = 10;

export class LiveEventBuffer {
  private readonly events: OverwolfLiveEventDto[] = [];
  private readonly pendingBatches: OverwolfLiveEventDto[][] = [];
  private timerId?: ReturnType<typeof setTimeout>;
  private flushing = false;
  private consecutiveFailures = 0;
  private retryScheduled = false;
  private droppedBatches = 0;
  private droppedEvents = 0;

  constructor(
    private readonly clientId: string,
    private readonly apiBaseUrl: string,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly flushDelayMs = 1000,
    private readonly matchIdProvider: MatchIdProvider = readCurrentMatchId,
    private readonly onInventoryFlushSuccess: InventoryFlushCallback =
      refreshCurrentBuildRecommendation,
  ) {}

  push(event: OverwolfLiveEventDto): void {
    const providedMatchId = this.matchIdProvider()?.trim();
    const eventMatchId = event.matchId?.trim();
    const matchId = eventMatchId || providedMatchId;

    this.events.push(matchId ? { ...event, matchId } : event);

    if (isImmediateEvent(event)) {
      if (this.retryScheduled) {
        return;
      }
      this.scheduleFlush(0, true);
      return;
    }

    this.scheduleFlush(this.flushDelayMs, false);
  }

  private scheduleFlush(
    delayMs: number,
    replaceExisting: boolean,
    retry = false,
  ): void {
    if (this.timerId) {
      if (!replaceExisting) {
        return;
      }
      clearTimeout(this.timerId);
      this.timerId = undefined;
    }

    this.retryScheduled = retry;
    this.timerId = setTimeout(() => {
      this.timerId = undefined;
      if (retry) {
        this.retryScheduled = false;
      }
      void this.flush();
    }, delayMs);
  }

  private async flush(): Promise<void> {
    this.timerId = undefined;

    const queuedEvents = this.events.splice(0);
    if (queuedEvents.length > 0) {
      for (const chunk of chunkEvents(queuedEvents, MAX_EVENTS_PER_REQUEST)) {
        this.pendingBatches.push(chunk);
      }
    }

    if (this.flushing) {
      // A request is in flight, so `pendingBatches[0]` is the batch being sent
      // and must not be trimmed away. Everything behind it is still unsent.
      this.trimPendingBatches(true);
      return;
    }

    const events = this.pendingBatches[0];
    if (!events) {
      return;
    }

    const body: OverwolfLiveBatchDto = {
      clientId: this.clientId,
      events,
    };

    this.flushing = true;
    let outcome: FlushOutcome = 'retry';
    try {
      let response: Response;
      try {
        response = await this.fetchImpl(`${this.apiBaseUrl}/deadlock/live/events`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      } catch (err) {
        // Network-level failure: the batch is still valid, so it stays queued.
        console.error('Failed to flush event batch:', err);
        return;
      }

      if (response.ok) {
        outcome = 'accepted';
        if (events.some(isInventoryEvent)) {
          try {
            this.onInventoryFlushSuccess(body);
          } catch (error) {
            console.warn('Failed to refresh recommendation after inventory ingest:', error);
          }
        }
      } else if (isRetryableStatus(response.status)) {
        outcome = 'retry';
      } else {
        // A rejection such as 400/413/422 will never succeed on a retry with
        // the same body, so retrying it only costs memory and blocks the queue.
        outcome = 'dropped';
      }
    } finally {
      this.flushing = false;
      this.settleAttempt(events, outcome);
      this.rescheduleAfterAttempt();
    }
  }

  /**
   * Removes the attempted batch and updates the failure counter.
   *
   * The batch is located by identity rather than by index, because a batch
   * queued while the request was in flight could otherwise shift positions.
   */
  private settleAttempt(events: OverwolfLiveEventDto[], outcome: FlushOutcome): void {
    const index = this.pendingBatches.indexOf(events);
    const removeAttempted = (): void => {
      if (index !== -1) {
        this.pendingBatches.splice(index, 1);
      }
    };

    if (outcome === 'accepted') {
      removeAttempted();
      this.consecutiveFailures = 0;
      this.trimPendingBatches(false);
      return;
    }

    this.consecutiveFailures += 1;

    const exhausted =
      outcome === 'dropped' || this.consecutiveFailures >= MAX_ATTEMPTS_PER_BATCH;
    if (!exhausted) {
      return;
    }

    removeAttempted();
    this.recordDrop(
      events.length,
      outcome === 'dropped'
        ? 'the server rejected it permanently'
        : `${MAX_ATTEMPTS_PER_BATCH} attempts failed`,
    );
    this.consecutiveFailures = 0;
    this.trimPendingBatches(false);
  }

  private rescheduleAfterAttempt(): void {
    if (this.pendingBatches.length > 0) {
      if (this.consecutiveFailures > 0) {
        this.scheduleFlush(this.getRetryDelayMs(), true, true);
      } else {
        this.scheduleFlush(0, true);
      }
      return;
    }

    if (this.events.length > 0 && this.timerId === undefined) {
      this.scheduleFlush(this.flushDelayMs, false);
    }
  }

  /**
   * Drops the oldest unsent batches once the queue exceeds its ceiling, so a
   * server that stops responding cannot grow client memory without limit. The
   * newest events are the ones worth keeping.
   *
   * @param keepInFlight whether `pendingBatches[0]` is currently being sent
   */
  private trimPendingBatches(keepInFlight: boolean): void {
    const oldestUnsentIndex = keepInFlight ? 1 : 0;

    while (this.pendingBatches.length - oldestUnsentIndex > MAX_PENDING_BATCHES) {
      const [dropped] = this.pendingBatches.splice(oldestUnsentIndex, 1);
      if (dropped) {
        this.recordDrop(dropped.length, `the queue exceeded ${MAX_PENDING_BATCHES} batches`);
      }
    }
  }

  private recordDrop(eventCount: number, reason: string): void {
    this.droppedBatches += 1;
    this.droppedEvents += eventCount;
    console.error(
      `Dropped ${eventCount} live events because ${reason} ` +
        `(total dropped: ${this.droppedEvents} events in ${this.droppedBatches} batches)`,
    );
  }

  private getRetryDelayMs(): number {
    const exponent = Math.max(0, this.consecutiveFailures - 1);
    return Math.min(this.flushDelayMs * (2 ** exponent), MAX_RETRY_DELAY_MS);
  }
}

type FlushOutcome = 'accepted' | 'retry' | 'dropped';

/**
 * 408 and 429 are explicitly retryable; every other 4xx means the request
 * itself is unacceptable and will be rejected again unchanged.
 */
function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function chunkEvents(
  events: OverwolfLiveEventDto[],
  size: number,
): OverwolfLiveEventDto[][] {
  if (events.length <= size) {
    return [events];
  }

  const chunks: OverwolfLiveEventDto[][] = [];
  for (let index = 0; index < events.length; index += size) {
    chunks.push(events.slice(index, index + size));
  }
  return chunks;
}

function isImmediateEvent(event: OverwolfLiveEventDto): boolean {
  return event.feature === 'state_safety_poll' || isInventoryEvent(event);
}

function isInventoryEvent(event: OverwolfLiveEventDto): boolean {
  return typeof event.key === 'string' && event.key.startsWith('items');
}

function refreshCurrentBuildRecommendation(): void {
  try {
    const ow = (globalThis as any).overwolf;
    const mainWindow = ow?.windows?.getMainWindow?.();
    if (typeof mainWindow?.forceLiveBuildRecommendationRefresh === 'function') {
      mainWindow.forceLiveBuildRecommendationRefresh();
    }
  } catch (error) {
    console.warn('Failed to refresh build recommendation after inventory ingest:', error);
  }
}

function readCurrentMatchId(): string | undefined {
  const globalMatchId = (globalThis as any).__deadlockLiveMatchId;
  if (typeof globalMatchId === 'string' && globalMatchId.trim()) {
    return globalMatchId.trim();
  }

  try {
    const ow = (globalThis as any).overwolf;
    const mainWindow = ow?.windows?.getMainWindow?.();
    const mainWindowMatchId = mainWindow?.__deadlockLiveMatchId;
    return typeof mainWindowMatchId === 'string' && mainWindowMatchId.trim()
      ? mainWindowMatchId.trim()
      : undefined;
  } catch {
    return undefined;
  }
}
