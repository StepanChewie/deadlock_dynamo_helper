import { readFileSync } from 'fs';
import { resolve } from 'path';
import { BuildDebugTraceStoreV2Service } from '../src/statlocker-adaptive/build-debug-trace-store-v2.service';
import { BuildDecisionTraceV2 } from '../src/statlocker-adaptive/build-decision-trace-v2';

function trace(revision: number): BuildDecisionTraceV2 {
  return {
    matchId: 'prod-debug-match',
    steamId: 'steam-111',
    revision,
    stateRevision: `state-${revision}`,
    generatedAt: new Date(1_700_000_000_000 + revision).toISOString(),
    stages: [],
  };
}

describe('Build debugger V2 production configuration', () => {
  const envNames = [
    'BUILD_DEBUG_TRACE_TAIL',
    'BUILD_DEBUG_TRACE_IDLE_TTL_SEC',
    'BUILD_DEBUG_TRACE_TAIL_SIZE',
    'BUILD_DEBUG_TRACE_TTL_MS',
  ] as const;
  const previous = new Map<string, string | undefined>();
  let nowSpy: jest.SpyInstance<number, []>;
  let nowMs: number;

  beforeEach(() => {
    for (const name of envNames) previous.set(name, process.env[name]);
    delete process.env.BUILD_DEBUG_TRACE_TAIL_SIZE;
    delete process.env.BUILD_DEBUG_TRACE_TTL_MS;
    process.env.BUILD_DEBUG_TRACE_TAIL = '2';
    process.env.BUILD_DEBUG_TRACE_IDLE_TTL_SEC = '1';
    nowMs = 20_000;
    nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => nowMs);
  });

  afterEach(() => {
    nowSpy.mockRestore();
    for (const name of envNames) {
      const value = previous.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    previous.clear();
  });

  it('uses the documented production trace tail and idle TTL settings', () => {
    const store = new BuildDebugTraceStoreV2Service();
    store.put(trace(1));
    store.put(trace(2));
    store.put(trace(3));

    expect(store.revisions('prod-debug-match', 'steam-111').map((entry) => entry.revision)).toEqual([2, 3]);

    nowMs += 1001;
    expect(store.get('prod-debug-match', 'steam-111')).toBeUndefined();
  });

  it('passes debugger secrets and runtime settings into the production API container', () => {
    const compose = readFileSync(resolve(__dirname, '../../..', 'docker-compose.yml'), 'utf8');

    expect(compose).toContain('- BUILD_DEBUG_PASSWORD=${BUILD_DEBUG_PASSWORD}');
    expect(compose).toContain('- BUILD_DEBUG_SESSION_SECRET=${BUILD_DEBUG_SESSION_SECRET}');
    expect(compose).toContain('- BUILD_DEBUG_SESSION_TTL_SEC=${BUILD_DEBUG_SESSION_TTL_SEC:-3600}');
    expect(compose).toContain('- BUILD_DEBUG_TRACE_TAIL=${BUILD_DEBUG_TRACE_TAIL:-5}');
    expect(compose).toContain('- BUILD_DEBUG_TRACE_IDLE_TTL_SEC=${BUILD_DEBUG_TRACE_IDLE_TTL_SEC:-1800}');
  });
});
