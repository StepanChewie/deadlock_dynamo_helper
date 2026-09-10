import { firstValueFrom } from 'rxjs';
import { take } from 'rxjs/operators';
import { BuildDecisionTraceV2 } from '../src/statlocker-adaptive/build-decision-trace-v2';
import { BuildDebugTraceStoreV2Service } from '../src/statlocker-adaptive/build-debug-trace-store-v2.service';

function trace(matchId: string, revision: number): BuildDecisionTraceV2 {
  return {
    matchId,
    revision,
    stateRevision: `state-${revision}`,
    generatedAt: new Date(1_000 + revision).toISOString(),
    stages: [],
  };
}

describe('BuildDebugTraceStoreV2Service', () => {
  const originalTail = process.env.BUILD_DEBUG_TRACE_TAIL_SIZE;
  const originalTtl = process.env.BUILD_DEBUG_TRACE_TTL_MS;
  let nowSpy: jest.SpyInstance<number, []>;
  let nowMs: number;

  beforeEach(() => {
    process.env.BUILD_DEBUG_TRACE_TAIL_SIZE = '2';
    process.env.BUILD_DEBUG_TRACE_TTL_MS = '1000';
    nowMs = 10_000;
    nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => nowMs);
  });

  afterEach(() => {
    nowSpy.mockRestore();
    if (originalTail === undefined) delete process.env.BUILD_DEBUG_TRACE_TAIL_SIZE;
    else process.env.BUILD_DEBUG_TRACE_TAIL_SIZE = originalTail;
    if (originalTtl === undefined) delete process.env.BUILD_DEBUG_TRACE_TTL_MS;
    else process.env.BUILD_DEBUG_TRACE_TTL_MS = originalTtl;
  });

  it('returns the current trace and retains only the configured revision tail', () => {
    const store = new BuildDebugTraceStoreV2Service();

    store.put(trace('match-1', 1));
    store.put(trace('match-1', 2));
    store.put(trace('match-1', 3));

    expect(store.get('match-1')?.revision).toBe(3);
    expect(store.revisions('match-1').map((entry) => entry.revision)).toEqual([2, 3]);
    expect(store.listActive()).toEqual([
      expect.objectContaining({ matchId: 'match-1', revision: 3, stateRevision: 'state-3' }),
    ]);
  });

  it('rejects duplicate or decreasing revisions for an active match', () => {
    const store = new BuildDebugTraceStoreV2Service();
    store.put(trace('match-1', 2));

    expect(() => store.put(trace('match-1', 2))).toThrow(/revision/i);
    expect(() => store.put(trace('match-1', 1))).toThrow(/revision/i);
    expect(store.get('match-1')?.revision).toBe(2);
  });

  it('expires inactive matches from current, revision, and active-match views', () => {
    const store = new BuildDebugTraceStoreV2Service();
    store.put(trace('match-1', 1));

    nowMs += 1001;

    expect(store.get('match-1')).toBeUndefined();
    expect(store.revisions('match-1')).toEqual([]);
    expect(store.listActive()).toEqual([]);
  });

  it('emits the new trace revision to realtime observers', async () => {
    const store = new BuildDebugTraceStoreV2Service();
    const nextRevision = firstValueFrom(store.observe('match-1').pipe(take(1)));

    store.put(trace('match-1', 1));

    await expect(nextRevision).resolves.toMatchObject({ matchId: 'match-1', revision: 1 });
  });
});
