import { AdaptiveRecommendationClient } from './adaptive-recommendation-client';

const result = {
  ready: true,
  blockers: [],
  decisionId: 'decision-a',
  stateRevision: 'revision-a',
  gameState: 'EVEN',
  nextAction: { actionKey: 'WAIT', type: 'WAIT', reasonCodes: [] },
  recommendedBuild: [],
  changes: [],
  rankedImmediateCandidates: [],
  totalScore: 0,
  confidence: 0.5,
  scorerVersion: 'adaptive-evidence-scorer-v1',
  plannerVersion: 'adaptive-build-planner-v1',
  configVersion: 'statlocker-adaptive-v1.0.0',
  evidence: {
    rulesetVersion: 'ruleset-a',
    catalogSha256: 'a'.repeat(64),
    statlockerPatchId: '15-1',
    snapshotIds: [],
    families: [],
    degradedReasons: [],
  },
} as any;

function response(data = result) {
  return {
    ok: true,
    status: 200,
    json: jest.fn().mockResolvedValue(data),
  } as any;
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('AdaptiveRecommendationClient', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('debounces and deduplicates identical payloads', async () => {
    const fetcher = jest.fn().mockResolvedValue(response());
    const onResult = jest.fn();
    const client = new AdaptiveRecommendationClient('https://api.example', fetcher, 250);

    client.schedule({ matchId: 'match-a', localSteamId: 'steam-a' }, { onResult });
    client.schedule({ matchId: 'match-a', localSteamId: 'steam-a' }, { onResult });
    jest.advanceTimersByTime(249);
    expect(fetcher).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1);
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(
      'https://api.example/deadlock/adaptive/v2/recommend',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ matchId: 'match-a', localSteamId: 'steam-a' }),
      }),
    );
    expect(onResult).toHaveBeenCalledWith(result);

    client.schedule({ matchId: 'match-a', localSteamId: 'steam-a' }, { onResult });
    jest.advanceTimersByTime(250);
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('does not overlap an identical request while the first one is in flight', async () => {
    let resolveFetch: ((value: any) => void) | undefined;
    const fetcher = jest.fn(() => new Promise<any>((resolve) => { resolveFetch = resolve; }));
    const client = new AdaptiveRecommendationClient('https://api.example', fetcher, 100);

    client.schedule({ matchId: 'match-a', localSteamId: 'steam-a' }, { onResult: jest.fn() });
    jest.advanceTimersByTime(100);
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(1);

    client.schedule({ matchId: 'match-a', localSteamId: 'steam-a' }, { onResult: jest.fn() });
    jest.advanceTimersByTime(100);
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(1);

    resolveFetch?.(response());
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('keeps only the latest changed payload while another request is in flight', async () => {
    let resolveFetch: ((value: any) => void) | undefined;
    const fetcher = jest.fn()
      .mockImplementationOnce(() => new Promise<any>((resolve) => { resolveFetch = resolve; }))
      .mockResolvedValue(response());
    const onResult = jest.fn();
    const client = new AdaptiveRecommendationClient('https://api.example', fetcher, 100);

    client.schedule({ matchId: 'match-a', localSteamId: 'steam-a' }, { onResult });
    jest.advanceTimersByTime(100);
    await flush();

    client.schedule({ matchId: 'match-b', localSteamId: 'steam-a' }, { onResult });
    client.schedule({ matchId: 'match-c', localSteamId: 'steam-a' }, { onResult });
    jest.advanceTimersByTime(100);
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(1);

    resolveFetch?.(response());
    await flush();
    jest.runOnlyPendingTimers();
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1][1].body).toBe(JSON.stringify({ matchId: 'match-c', localSteamId: 'steam-a' }));
  });

  it('allows a manual force refresh of an unchanged completed payload', async () => {
    const fetcher = jest.fn().mockResolvedValue(response());
    const handlers = { onResult: jest.fn() };
    const client = new AdaptiveRecommendationClient('https://api.example', fetcher, 50);
    const request = { matchId: 'match-a', localSteamId: 'steam-a' };

    client.schedule(request, handlers);
    jest.advanceTimersByTime(50);
    await flush();
    client.schedule(request, handlers, true);
    jest.advanceTimersByTime(50);
    await flush();

    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('retries the latest request after a transient server failure', async () => {
    const fetcher = jest.fn()
      .mockResolvedValueOnce({ ok: false, status: 502 } as Response)
      .mockResolvedValueOnce(response());
    const onResult = jest.fn();
    const onError = jest.fn();
    const client = new AdaptiveRecommendationClient(
      'https://api.example',
      fetcher,
      50,
      200,
    );

    client.schedule(
      { matchId: 'match-a', localSteamId: 'steam-a' },
      { onResult, onError },
    );
    jest.advanceTimersByTime(50);
    await flush();

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Adaptive recommendation HTTP 502' }),
    );

    jest.advanceTimersByTime(199);
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(1);
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(onResult).toHaveBeenCalledWith(result);
  });

  it('retries a successful waiting response without reporting an error', async () => {
    const waiting = { ...result, ready: false, blockers: ['LIVE_STATE_NOT_READY'] };
    const fetcher = jest.fn()
      .mockResolvedValueOnce(response(waiting))
      .mockResolvedValueOnce(response());
    const onResult = jest.fn();
    const onError = jest.fn();
    const client = new AdaptiveRecommendationClient(
      'https://api.example',
      fetcher,
      50,
      200,
    );

    client.schedule({ matchId: 'match-a', localSteamId: 'steam-a' }, { onResult, onError });
    jest.advanceTimersByTime(50);
    await flush();

    expect(onResult).toHaveBeenCalledWith(waiting);
    expect(onError).not.toHaveBeenCalled();
    jest.advanceTimersByTime(200);
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(onResult).toHaveBeenLastCalledWith(result);
  });

  it('does not retry a rejected client request', async () => {
    const fetcher = jest.fn().mockResolvedValue({ ok: false, status: 400 } as Response);
    const client = new AdaptiveRecommendationClient(
      'https://api.example',
      fetcher,
      50,
      200,
    );

    client.schedule(
      { matchId: 'match-a', localSteamId: 'steam-a' },
      { onResult: jest.fn(), onError: jest.fn() },
    );
    jest.advanceTimersByTime(50);
    await flush();
    jest.advanceTimersByTime(1000);
    await flush();

    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('still retries when the error observer throws', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fetcher = jest.fn()
      .mockResolvedValueOnce({ ok: false, status: 502 } as Response)
      .mockResolvedValueOnce(response());
    const onResult = jest.fn();
    const client = new AdaptiveRecommendationClient(
      'https://api.example',
      fetcher,
      50,
      200,
    );

    client.schedule(
      { matchId: 'match-a', localSteamId: 'steam-a' },
      {
        onResult,
        onError: () => {
          throw new Error('observer failed');
        },
      },
    );
    jest.advanceTimersByTime(50);
    await flush();
    jest.advanceTimersByTime(200);
    await flush();

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(onResult).toHaveBeenCalledWith(result);
    warn.mockRestore();
  });

  it('does not retry an in-flight request after the match is cancelled', async () => {
    let rejectFetch: ((error: Error) => void) | undefined;
    const onError = jest.fn();
    const fetcher = jest.fn(() => new Promise<Response>((_resolve, reject) => {
      rejectFetch = reject;
    }));
    const client = new AdaptiveRecommendationClient(
      'https://api.example',
      fetcher,
      50,
      200,
    );

    client.schedule(
      { matchId: 'match-a', localSteamId: 'steam-a' },
      { onResult: jest.fn(), onError },
    );
    jest.advanceTimersByTime(50);
    await flush();
    client.cancel();
    rejectFetch?.(new Error('offline'));
    await flush();
    jest.advanceTimersByTime(1000);
    await flush();

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it('does not publish an in-flight success after the match is cancelled', async () => {
    let resolveFetch: ((value: Response) => void) | undefined;
    const fetcher = jest.fn(() => new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    }));
    const onResult = jest.fn();
    const client = new AdaptiveRecommendationClient(
      'https://api.example',
      fetcher,
      50,
      200,
    );
    const request = { matchId: 'match-a', localSteamId: 'steam-a' };

    client.schedule(request, { onResult, onError: jest.fn() });
    jest.advanceTimersByTime(50);
    await flush();
    client.cancel();
    resolveFetch?.(response());
    await flush();

    expect(onResult).not.toHaveBeenCalled();

    client.schedule(request, { onResult, onError: jest.fn() });
    jest.advanceTimersByTime(50);
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
