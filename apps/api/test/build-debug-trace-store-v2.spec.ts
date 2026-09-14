import { firstValueFrom } from 'rxjs';
import { take } from 'rxjs/operators';
import { BuildDecisionTraceV2 } from '../src/statlocker-adaptive/build-decision-trace-v2';
import { BuildDebugTraceStoreV2Service } from '../src/statlocker-adaptive/build-debug-trace-store-v2.service';

function trace(overrides: Partial<BuildDecisionTraceV2>): BuildDecisionTraceV2 {
  const revision = overrides.revision ?? 1;
  return {
    matchId: 'match-1',
    steamId: 'steam-111',
    revision,
    stateRevision: `state-${revision}`,
    generatedAt: new Date(1_000 + revision).toISOString(),
    stages: [],
    ...overrides,
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

    store.put(trace({ matchId: 'match-1', revision: 1 }));
    store.put(trace({ matchId: 'match-1', revision: 2 }));
    store.put(trace({ matchId: 'match-1', revision: 3 }));

    expect(store.get('match-1', 'steam-111')?.revision).toBe(3);
    expect(store.revisions('match-1', 'steam-111').map((entry) => entry.revision)).toEqual([2, 3]);
    expect(store.listActive()).toEqual([
      expect.objectContaining({ matchId: 'match-1', steamId: 'steam-111', revision: 3, stateRevision: 'state-3' }),
    ]);
  });

  it('rejects duplicate or decreasing revisions for an active match', () => {
    const store = new BuildDebugTraceStoreV2Service();
    store.put(trace({ matchId: 'match-1', revision: 2 }));

    expect(() => store.put(trace({ matchId: 'match-1', revision: 2 }))).toThrow(/revision/i);
    expect(() => store.put(trace({ matchId: 'match-1', revision: 1 }))).toThrow(/revision/i);
    expect(store.get('match-1', 'steam-111')?.revision).toBe(2);
  });

  it('expires inactive matches from current, revision, and active-match views', () => {
    const store = new BuildDebugTraceStoreV2Service();
    store.put(trace({ matchId: 'match-1', revision: 1 }));

    nowMs += 1001;

    expect(store.get('match-1', 'steam-111')).toBeUndefined();
    expect(store.revisions('match-1', 'steam-111')).toEqual([]);
    expect(store.listActive()).toEqual([]);
  });

  it('emits the new trace revision to realtime observers', async () => {
    const store = new BuildDebugTraceStoreV2Service();
    const nextRevision = firstValueFrom(store.observe('match-1', 'steam-111').pipe(take(1)));

    store.put(trace({ matchId: 'match-1', revision: 1 }));

    await expect(nextRevision).resolves.toMatchObject({ matchId: 'match-1', revision: 1 });
  });

  it('keeps revisions of two players in one match apart', async () => {
    const store = new BuildDebugTraceStoreV2Service();
    store.put(trace({ matchId: 'match-1', steamId: 'steam-111', revision: 1 }));
    store.put(trace({ matchId: 'match-1', steamId: 'steam-111', revision: 2 }));
    store.put(trace({ matchId: 'match-1', steamId: 'steam-222', revision: 1 }));

    expect(store.get('match-1', 'steam-111')?.revision).toBe(2);
    expect(store.get('match-1', 'steam-222')?.revision).toBe(1);
    expect(store.revisions('match-1', 'steam-111')).toHaveLength(2);
  });

  it('rejects a revision that does not increase for the same player', async () => {
    const store = new BuildDebugTraceStoreV2Service();
    store.put(trace({ matchId: 'match-1', steamId: 'steam-111', revision: 2 }));
    expect(() => store.put(trace({ matchId: 'match-1', steamId: 'steam-111', revision: 2 })))
      .toThrow('revision must increase');
  });
});
