import {
  AdaptiveRecommendationRequestV2,
  AdaptiveRecommendationResultV2,
} from '@deadlock-live-probe/shared';

export interface AdaptiveRecommendationClientHandlers {
  onResult: (result: AdaptiveRecommendationResultV2) => void;
  onError?: (error: Error) => void;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

interface PendingRequest {
  request: AdaptiveRecommendationRequestV2;
  payload: string;
  handlers: AdaptiveRecommendationClientHandlers;
  cancellationRevision: number;
}

export class AdaptiveRecommendationClient {
  private timer?: ReturnType<typeof setTimeout>;
  private pending?: PendingRequest;
  private pendingDelayMs = 0;
  private inFlight?: Promise<void>;
  private inFlightPayload?: string;
  private lastCompletedPayload?: string;
  private cancellationRevision = 0;

  constructor(
    private readonly apiBaseUrl: string,
    private readonly fetcher: FetchLike,
    private readonly debounceMs = 1500,
    private readonly retryDelayMs = 3000,
  ) {}

  schedule(
    request: AdaptiveRecommendationRequestV2,
    handlers: AdaptiveRecommendationClientHandlers,
    force = false,
  ): void {
    const normalized = normalizeRequest(request);
    const payload = JSON.stringify(normalized);

    if (payload === this.pending?.payload) return;
    if (payload === this.inFlightPayload && !force) return;

    if (force && this.lastCompletedPayload === payload) {
      this.lastCompletedPayload = undefined;
    }
    if (!force && payload === this.lastCompletedPayload) return;

    this.pending = {
      request: normalized,
      payload,
      handlers,
      cancellationRevision: this.cancellationRevision,
    };
    this.pendingDelayMs = 0;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flushPending();
    }, this.debounceMs);
  }

  cancel(): void {
    this.cancellationRevision += 1;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.pending = undefined;
    this.pendingDelayMs = 0;
  }

  private async flushPending(): Promise<void> {
    const pending = this.pending;
    if (!pending) return;
    if (this.inFlight) {
      this.inFlight.finally(() => this.schedulePendingAfterFlight());
      return;
    }

    this.pending = undefined;
    this.inFlightPayload = pending.payload;
    const requestPromise = this.execute(pending)
      .finally(() => {
        this.inFlight = undefined;
        this.inFlightPayload = undefined;
        this.schedulePendingAfterFlight();
      });
    this.inFlight = requestPromise;
    await requestPromise;
  }

  private schedulePendingAfterFlight(): void {
    if (!this.pending || this.timer !== undefined || this.inFlight) return;
    const delayMs = this.pendingDelayMs;
    this.pendingDelayMs = 0;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flushPending();
    }, delayMs);
  }

  private async execute(pending: PendingRequest): Promise<void> {
    let shouldRetry = true;
    let result: AdaptiveRecommendationResultV2;
    try {
      const response = await this.fetcher(`${this.apiBaseUrl}/deadlock/adaptive/v2/recommend`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: pending.payload,
      });
      if (!response.ok) {
        shouldRetry = response.status >= 500 || response.status === 429;
        throw new Error(`Adaptive recommendation HTTP ${response.status}`);
      }
      shouldRetry = false;
      const raw = await response.json() as AdaptiveRecommendationResultV2;
      result = projectAdaptiveRecommendationV2ForPresentation(raw);
    } catch (error) {
      if (pending.cancellationRevision !== this.cancellationRevision) return;
      if (
        shouldRetry &&
        !this.pending &&
        pending.cancellationRevision === this.cancellationRevision
      ) {
        this.pending = pending;
        this.pendingDelayMs = this.retryDelayMs;
      }
      try {
        pending.handlers.onError?.(toError(error));
      } catch (handlerError) {
        console.warn('Adaptive recommendation error observer failed:', handlerError);
      }
      return;
    }

    if (pending.cancellationRevision !== this.cancellationRevision) return;
    if (!result.ready && !this.pending) {
      this.pending = pending;
      this.pendingDelayMs = this.retryDelayMs;
    }
    this.lastCompletedPayload = result.ready ? pending.payload : undefined;
    pending.handlers.onResult(result);
  }
}

function normalizeRequest(request: AdaptiveRecommendationRequestV2): AdaptiveRecommendationRequestV2 {
  if (!request || typeof request.matchId !== 'string' || request.matchId.trim() === '') {
    throw new Error('Adaptive recommendation matchId is required');
  }
  const localSteamId = request.localSteamId?.trim();
  return {
    matchId: request.matchId.trim(),
    localSteamId: localSteamId || undefined,
  };
}

export function projectAdaptiveRecommendationV2ForPresentation(
  result: AdaptiveRecommendationResultV2,
): AdaptiveRecommendationResultV2 {
  if (!result || typeof result !== 'object' || !result.score) {
    return result;
  }

  const steps = [...(result.fullBuild?.steps ?? [])]
    .sort((left, right) => left.sequence - right.sequence);
  const firstStep = steps[0];
  const nextTargetItemId = result.nextAction.buyItemId ?? firstStep?.buyItemId;
  const nextActionKey = actionKey(
    result.nextAction.type,
    result.nextAction.buyItemId,
    result.nextAction.sellItemId,
    result.nextAction.recipeId,
  );

  const recommendedBuild = steps.map((step, index) => ({
    itemId: step.buyItemId,
    position: index + 1,
    status: index === 0 ? 'NEXT' : 'PLANNED',
    score: result.score.total,
    confidence: result.score.confidence,
    skeletonStrength: 0,
    contextualSupport: 0,
    reasonCodes: [...step.reasonCodes],
  }));

  const planActions = steps.map((step, index) => ({
    planActionId: `v2:${result.fullBuild?.planRevision ?? result.stateRevision}:${step.sequence}`,
    sequence: step.sequence,
    status: index === 0 ? 'READY' : 'PLANNED',
    action: {
      actionKey: actionKey(step.action, step.buyItemId, step.sellItemId, step.recipeId),
      type: step.action,
      buyItemId: step.buyItemId,
      sellItemId: step.sellItemId,
      targetItemId: step.buyItemId,
      reasonCodes: [...step.reasonCodes],
    },
    targetItemId: step.buyItemId,
    sourceItemIds: [...step.consumedItemIds],
    requirements: [],
    goalId: `v2-step:${step.sequence}`,
    reasonCodes: [...step.reasonCodes],
  }));

  const evidence = result.evidence
    ? {
        ...result.evidence,
        snapshotIds: result.lock?.snapshotId ? [result.lock.snapshotId] : [],
        families: result.evidence.families.map((family) => ({
          ...family,
          freshness: family.available ? 'FRESH' : 'UNAVAILABLE',
          confidence: family.confidence ?? (family.available ? 1 : 0),
        })),
      }
    : {
        rulesetVersion: '',
        catalogSha256: '',
        statlockerPatchId: '',
        sourceProfileCount: 0,
        sourceProfileAccountIds: [],
        families: [],
        degradedReasons: [...result.degradedReasons],
        snapshotIds: result.lock?.snapshotId ? [result.lock.snapshotId] : [],
      };

  return {
    ...result,
    gameState: 'UNKNOWN',
    nextAction: {
      ...result.nextAction,
      actionKey: nextActionKey,
      targetItemId: nextTargetItemId,
    },
    nextTargetItemId,
    planActions,
    recommendedBuild,
    changes: [],
    rankedImmediateCandidates: [],
    totalScore: result.score.total,
    confidence: result.score.confidence,
    scorerVersion: 'statlocker-family-first-v2',
    plannerVersion: 'family-first-full-build-v2',
    configVersion: 'statlocker-adaptive-v2',
    plannerMethod: 'STRATEGY_FIRST',
    evidence,
  } as AdaptiveRecommendationResultV2;
}

function actionKey(
  type: 'BUY' | 'UPGRADE' | 'REPLACE' | 'HOLD',
  buyItemId?: number,
  sellItemId?: number,
  recipeId?: string,
): string {
  if (type === 'REPLACE') return `REPLACE:${sellItemId ?? 0}->${buyItemId ?? 0}`;
  if (type === 'UPGRADE') return `UPGRADE:${buyItemId ?? 0}:${recipeId ?? 'direct'}`;
  return `${type}:${buyItemId ?? 0}`;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
