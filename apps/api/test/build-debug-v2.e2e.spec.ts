import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { BuildDebugAuthV2Guard } from '../src/build-debug-v2/build-debug-auth-v2.guard';
import { BuildDebugAuthV2Service } from '../src/build-debug-v2/build-debug-auth-v2.service';
import { BuildDebugV2Controller } from '../src/build-debug-v2/build-debug-v2.controller';
import { BUILD_DEBUG_V2_CLIENT_JS } from '../src/build-debug-v2/build-debug-v2.client';
import { BuildDebugTraceStoreV2Service } from '../src/statlocker-adaptive/build-debug-trace-store-v2.service';
import { BuildDecisionTraceV2 } from '../src/statlocker-adaptive/build-decision-trace-v2';

const MATCH_ID = 'match-debug-v2';
const STEAM_ID = 'steam-111';
const PASSWORD = 'debug-password-test';
const SESSION_SECRET = 'debug-session-secret-test';

function trace(revision = 1, steamId = STEAM_ID): BuildDecisionTraceV2 {
  return {
    matchId: MATCH_ID,
    steamId,
    revision,
    stateRevision: `state-${revision}`,
    generatedAt: new Date(1_700_000_000_000 + revision * 1000).toISOString(),
    stages: [{
      stage: 'FINAL_PLAN',
      reasonCodes: [],
      payload: {
        planRevision: `plan-${revision}`,
        stepCount: 1,
        degradedReasons: [],
        valid: true,
        validationReasonCodes: [],
      },
    }],
  };
}

function renderFixtureTrace(revision = 7): BuildDecisionTraceV2 {
  return {
    matchId: MATCH_ID,
    steamId: STEAM_ID,
    revision,
    stateRevision: `fixture-state-${revision}`,
    generatedAt: new Date(1_700_001_000_000 + revision * 1000).toISOString(),
    stages: [
      {
        stage: 'SOURCE',
        reasonCodes: [],
        payload: {
          heroId: 72,
          statlockerPatchId: 'patch-fixture',
          profileAccountIds: Array.from({ length: 10 }, (_, index) => `profile-${index + 1}`),
          profileCount: 10,
          wpaRowCount: 48,
          t4Available: false,
        },
      },
      {
        stage: 'ARCHETYPE_MINING',
        reasonCodes: [],
        payload: {
          candidates: [
            {
              candidateId: 'gun-core',
              profileAccountIds: ['profile-1', 'profile-2', 'profile-3', 'profile-4', 'profile-5', 'profile-6'],
              support: 0.6,
              coherence: 0.91,
              separation: 0.37,
              disposition: 'SELECTED',
              reasonCodes: ['COHERENT_CLUSTER'],
            },
            {
              candidateId: 'spirit-control',
              profileAccountIds: ['profile-7', 'profile-8', 'profile-9', 'profile-10'],
              support: 0.4,
              coherence: 0.73,
              separation: 0.31,
              disposition: 'REJECTED',
              reasonCodes: ['LOW_CLUSTER_COHERENCE'],
            },
          ],
        },
      },
      {
        stage: 'ARCHETYPE_QUALITY_GATE',
        reasonCodes: [],
        payload: {
          results: [
            { archetypeId: 'gun-core', accepted: true, reasonCodes: ['QUALITY_GATE_PASS'] },
            { archetypeId: 'spirit-control', accepted: false, reasonCodes: ['QUALITY_GATE_LOW_SUPPORT'] },
          ],
        },
      },
      {
        stage: 'ARCHETYPE_SELECTION',
        reasonCodes: ['IMMUTABLE_MATCH_LOCK'],
        payload: {
          enemyHeroIds: [1, 2, 3, 4, 5, 6],
          wpaQueryCount: 42,
          candidates: [
            {
              candidateId: 'gun-core',
              archetypeId: 'gun-core',
              score: 0.32,
              confidence: 0.88,
              coverage: 0.83,
              sampleCount: 190,
              disposition: 'SELECTED',
              reasonCodes: ['BEST_MATCHUP_WPA'],
            },
            {
              candidateId: 'spirit-control',
              archetypeId: 'spirit-control',
              score: 0.17,
              confidence: 0.66,
              coverage: 0.67,
              sampleCount: 102,
              disposition: 'REJECTED',
              reasonCodes: ['MATCHUP_SCORE_BELOW_SELECTED'],
            },
          ],
          selectedArchetypeId: 'gun-core',
          fallbackUsed: false,
        },
      },
      {
        stage: 'LIVE_CONTEXT',
        reasonCodes: [],
        payload: {
          gameTimeSec: 915,
          inventoryItemIds: [11, 22, 33],
          capacity: 12,
          enemyThreats: [
            { heroId: 1, threatMultiplier: 1.31, completeness: 1, reasonCodes: ['HIGH_SOULS_THREAT'] },
            { heroId: 2, threatMultiplier: 0.91, completeness: 0.8, reasonCodes: [] },
          ],
        },
      },
      {
        stage: 'CANDIDATE_DISCOVERY',
        reasonCodes: [],
        payload: {
          candidates: [
            {
              candidateId: 'inside-101',
              itemId: 101,
              score: 0.61,
              confidence: 0.84,
              insideLockedArchetype: true,
              disposition: 'SELECTED',
              reasonCodes: ['LOCKED_ARCHETYPE_MEMBER'],
            },
            {
              candidateId: 'outside-909',
              itemId: 909,
              score: 0.19,
              confidence: 0.44,
              insideLockedArchetype: false,
              disposition: 'REJECTED',
              reasonCodes: ['OUTSIDE_ARCHETYPE_IMPROVEMENT_TOO_LOW'],
            },
          ],
        },
      },
      {
        stage: 'CHOICE_RESOLUTION',
        reasonCodes: [],
        payload: {
          groups: [{
            groupId: 'A_OR_B',
            minSelect: 1,
            maxSelect: 1,
            candidates: [
              {
                candidateId: 'A',
                itemId: 101,
                score: 0.72,
                confidence: 0.82,
                disposition: 'SELECTED',
                reasonCodes: ['BEST_CHOICE_MATCHUP'],
              },
              {
                candidateId: 'B',
                itemId: 202,
                score: 0.49,
                confidence: 0.78,
                disposition: 'REJECTED',
                reasonCodes: ['MATCHUP_SCORE_BELOW_SELECTED'],
              },
            ],
            selectedItemIds: [101],
          }],
        },
      },
      {
        stage: 'ITEM_SCORING',
        reasonCodes: [],
        payload: {
          items: [
            {
              itemId: 101,
              total: 1.34,
              confidence: 0.87,
              layers: { structure: 0.7, matchup: 0.42, progression: 0.35, transition: 0.13 },
              reasonCodes: ['CORE_STRUCTURE', 'EXACT_ENEMY_WPA'],
            },
            {
              itemId: 404,
              total: 1.1,
              confidence: 0.81,
              layers: { structure: 0.41, matchup: 0.54, progression: 0.31, transition: 0.16 },
              reasonCodes: ['OUTSIDE_MATCHUP_SUPPORTED'],
            },
          ],
        },
      },
      {
        stage: 'PLAN_SEARCH',
        reasonCodes: [],
        payload: {
          branches: [
            {
              sequence: 1,
              targetItemId: 101,
              action: 'BUY',
              score: 1.34,
              disposition: 'SELECTED',
              reasonCodes: ['BEST_PLAN_BRANCH'],
            },
            {
              sequence: 1,
              targetItemId: 202,
              action: 'BUY',
              score: 1.29,
              disposition: 'SUPPRESSED_BY_HYSTERESIS',
              reasonCodes: ['PLAN_SWITCH_MARGIN_NOT_MET'],
            },
          ],
          hysteresis: {
            action: 'KEEP_PREVIOUS',
            improvement: 0.05,
            requiredImprovement: 0.12,
            reasonCodes: ['PLAN_SWITCH_MARGIN_NOT_MET'],
          },
        },
      },
      {
        stage: 'REPLACEMENT_SEARCH',
        reasonCodes: [],
        payload: {
          targetItemId: 404,
          candidates: [
            {
              sellItemId: 11,
              buyItemId: 404,
              marginalGain: 0.27,
              requiredImprovement: 0.2,
              disposition: 'SELECTED',
              reasonCodes: ['REPLACEMENT_BEST'],
            },
            {
              sellItemId: 22,
              buyItemId: 404,
              marginalGain: 0.08,
              requiredImprovement: 0.2,
              disposition: 'REJECTED',
              reasonCodes: ['REPLACEMENT_THRESHOLD_NOT_MET'],
            },
          ],
        },
      },
      {
        stage: 'FINAL_PLAN',
        reasonCodes: ['T4_CHAINS_UNAVAILABLE'],
        payload: {
          planRevision: `fixture-plan-${revision}`,
          stepCount: 3,
          degradedReasons: ['T4_CHAINS_UNAVAILABLE'],
          valid: true,
          validationReasonCodes: ['INVENTORY_SIMULATION_PASS'],
        },
      },
    ],
    finalPlan: {
      planRevision: `fixture-plan-${revision}`,
      matchId: MATCH_ID,
      heroId: 72,
      archetypeId: 'gun-core',
      stateRevision: `fixture-state-${revision}`,
      steps: [
        {
          sequence: 1,
          action: 'BUY',
          buyItemId: 101,
          consumedItemIds: [],
          inventoryBefore: [11, 22, 33],
          inventoryAfter: [11, 22, 33, 101],
          reasonCodes: ['CORE_PROGRESS'],
        },
        {
          sequence: 2,
          action: 'UPGRADE',
          buyItemId: 303,
          recipeId: 'recipe-303',
          consumedItemIds: [101],
          inventoryBefore: [11, 22, 33, 101],
          inventoryAfter: [11, 22, 33, 303],
          reasonCodes: ['RECIPE_UPGRADE'],
        },
        {
          sequence: 3,
          action: 'REPLACE',
          sellItemId: 11,
          buyItemId: 404,
          consumedItemIds: [],
          inventoryBefore: [11, 22, 33, 303],
          inventoryAfter: [22, 33, 303, 404],
          reasonCodes: ['MATCHUP_REPLACEMENT'],
        },
      ],
      degradedReasons: ['T4_CHAINS_UNAVAILABLE'],
      validation: { valid: true, reasonCodes: ['INVENTORY_SIMULATION_PASS'] },
    },
  };
}

describe('Build debugger V2 HTTP API', () => {
  let app: INestApplication;
  let baseUrl: string;
  let traceStore: BuildDebugTraceStoreV2Service;
  let previousPassword: string | undefined;
  let previousSecret: string | undefined;
  let previousNodeEnv: string | undefined;

  beforeAll(async () => {
    previousPassword = process.env.BUILD_DEBUG_PASSWORD;
    previousSecret = process.env.BUILD_DEBUG_SESSION_SECRET;
    previousNodeEnv = process.env.NODE_ENV;
    process.env.BUILD_DEBUG_PASSWORD = PASSWORD;
    process.env.BUILD_DEBUG_SESSION_SECRET = SESSION_SECRET;
    process.env.NODE_ENV = 'test';

    const moduleRef = await Test.createTestingModule({
      controllers: [BuildDebugV2Controller],
      providers: [
        BuildDebugTraceStoreV2Service,
        BuildDebugAuthV2Service,
        BuildDebugAuthV2Guard,
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address();
    if (!address || typeof address === 'string') throw new Error('Test HTTP server did not expose a TCP port');
    baseUrl = `http://127.0.0.1:${address.port}`;
    traceStore = moduleRef.get(BuildDebugTraceStoreV2Service);
  });

  afterAll(async () => {
    await app?.close();
    restoreEnv('BUILD_DEBUG_PASSWORD', previousPassword);
    restoreEnv('BUILD_DEBUG_SESSION_SECRET', previousSecret);
    restoreEnv('NODE_ENV', previousNodeEnv);
  });

  it('serves a no-store browser UI shell and client asset without requiring an authenticated data session', async () => {
    const htmlResponse = await fetch(`${baseUrl}/debug/build-v2`);
    expect(htmlResponse.status).toBe(200);
    expect(htmlResponse.headers.get('content-type')).toContain('text/html');
    expect(htmlResponse.headers.get('cache-control')).toContain('no-store');
    const html = await htmlResponse.text();
    expect(html).toContain('id="debugLoginForm"');
    expect(html).toContain('id="activeMatchSelect"');
    expect(html).toContain('id="traceStages"');
    expect(html).toContain('id="fullBuildPanel"');
    expect(html).toContain('id="traceRevision"');

    const clientResponse = await fetch(`${baseUrl}/debug/build-v2/client.js`);
    expect(clientResponse.status).toBe(200);
    expect(clientResponse.headers.get('content-type')).toContain('application/javascript');
    expect(clientResponse.headers.get('cache-control')).toContain('no-store');
    expect(await clientResponse.text()).toContain('EventSource');
  });

  it('rejects unauthenticated debugger data routes', async () => {
    expect((await fetch(`${baseUrl}/debug/build-v2/matches`)).status).toBe(401);
    expect((await fetch(`${baseUrl}/debug/build-v2/matches/${MATCH_ID}`)).status).toBe(401);
    expect((await fetch(`${baseUrl}/debug/build-v2/matches/${MATCH_ID}/stream`)).status).toBe(401);
  });

  it('rejects a wrong password and creates an HttpOnly strict session cookie for the correct password', async () => {
    const wrong = await fetch(`${baseUrl}/debug/build-v2/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'wrong-password' }),
    });
    expect(wrong.status).toBe(401);

    const correct = await login();
    expect(correct.response.status).toBe(201);
    const setCookie = correct.response.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('build_debug_v2_session=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');
    expect(setCookie).toContain('Path=/debug/build-v2');
    expect(setCookie).toContain('Max-Age=');
    expect(setCookie).not.toContain('Secure');
  });

  it('lists active matches and returns the current structured trace after authentication', async () => {
    traceStore.put(trace(1));
    const { cookie } = await login();

    const matches = await fetch(`${baseUrl}/debug/build-v2/matches`, {
      headers: { cookie },
    });
    expect(matches.status).toBe(200);
    expect(await matches.json()).toEqual([
      expect.objectContaining({ matchId: MATCH_ID, revision: 1, stateRevision: 'state-1' }),
    ]);

    const snapshot = await fetch(`${baseUrl}/debug/build-v2/matches/${MATCH_ID}?steamId=${STEAM_ID}`, {
      headers: { cookie },
    });
    expect(snapshot.status).toBe(200);
    expect(await snapshot.json()).toEqual(expect.objectContaining({
      matchId: MATCH_ID,
      revision: 1,
      stateRevision: 'state-1',
    }));
  });

  it('streams realtime trace revisions over authenticated SSE', async () => {
    traceStore.put(trace(2));
    const { cookie } = await login();
    const controller = new AbortController();
    const response = await fetch(`${baseUrl}/debug/build-v2/matches/${MATCH_ID}/stream?steamId=${STEAM_ID}`, {
      headers: { cookie },
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');

    const reader = response.body?.getReader();
    if (!reader) throw new Error('SSE response body is unavailable');
    const first = await reader.read();
    const body = new TextDecoder().decode(first.value);
    controller.abort();

    expect(body).toContain('"matchId":"match-debug-v2"');
    expect(body).toContain('"revision":2');
  });

  it('renders the complete trace fixture after selecting the addressed player and updates from SSE', async () => {
    const fixture = renderFixtureTrace(7);
    const harness = createBrowserHarness(fixture);
    const matchSelect = harness.element('activeMatchSelect');

    await harness.element('refreshMatches').dispatch('click');
    await flushMicrotasks();

    const options = matchSelect.children;
    expect(options.map((option) => option.textContent)).toEqual([
      `${MATCH_ID} - player steam-111 - revision 7`,
      `${MATCH_ID} - player steam-222 - revision 7`,
    ]);

    matchSelect.value = options[1].value;
    await matchSelect.dispatch('change');
    await flushMicrotasks();

    expect(harness.operations.slice(0, 3)).toEqual([
      'fetch:/debug/build-v2/matches',
      `fetch:/debug/build-v2/matches/${MATCH_ID}?steamId=steam-222`,
      `sse:/debug/build-v2/matches/${MATCH_ID}/stream?steamId=steam-222`,
    ]);

    const traceHtml = harness.element('traceStages').innerHTML;
    const buildHtml = harness.element('fullBuildPanel').innerHTML;
    const navigationHtml = harness.element('stageNavigation').innerHTML;

    expect(navigationHtml).toContain('SOURCE');
    expect(navigationHtml).toContain('ARCHETYPE_SELECTION');
    expect(navigationHtml).toContain('FINAL_PLAN');
    expect(traceHtml).toContain('profile-10');
    expect(traceHtml).toContain('gun-core');
    expect(traceHtml).toContain('spirit-control');
    expect(traceHtml).toContain('A OR B');
    expect(traceHtml).toContain('OUTSIDE_ARCHETYPE_IMPROVEMENT_TOO_LOW');
    expect(traceHtml).toContain('REPLACEMENT_BEST');
    expect(traceHtml).toContain('SUPPRESSED_BY_HYSTERESIS');
    expect(traceHtml).toContain('PLAN_SWITCH_MARGIN_NOT_MET');
    expect(traceHtml).toContain('STRUCTURE');
    expect(traceHtml).toContain('MATCHUP');
    expect(traceHtml).toContain('PROGRESSION');
    expect(traceHtml).toContain('TRANSITION');
    expect(traceHtml).toContain('T4_CHAINS_UNAVAILABLE');
    expect(buildHtml).toContain('BUY');
    expect(buildHtml).toContain('UPGRADE');
    expect(buildHtml).toContain('REPLACE');
    expect(buildHtml).toContain('SELL 11');
    expect(buildHtml).toContain('BUY 404');
    expect(buildHtml).toContain('Inventory simulation: PASS');
    expect(harness.element('traceRevision').textContent).toContain('revision: 7');

    harness.streams[0].emitTrace(renderFixtureTrace(8));
    await flushMicrotasks();
    expect(harness.element('traceRevision').textContent).toContain('revision: 8');
    expect(harness.element('fullBuildPanel').innerHTML).toContain('fixture-plan-8');
  });

  it('bounds SSE reconnect attempts instead of reconnecting forever', async () => {
    const harness = createBrowserHarness(renderFixtureTrace(9));
    const matchSelect = harness.element('activeMatchSelect');
    await harness.element('refreshMatches').dispatch('click');
    await flushMicrotasks();
    matchSelect.value = matchSelect.children[0].value;
    await matchSelect.dispatch('change');
    await flushMicrotasks();

    for (let index = 0; index < 12; index += 1) {
      const current = harness.streams[harness.streams.length - 1];
      current.fail();
      harness.runNextTimer();
      await flushMicrotasks();
    }

    expect(harness.streams.length).toBeLessThanOrEqual(6);
    expect(harness.element('debugStatus').textContent).toContain('reconnect limit');
  });

  it('invalidates the server-side session on logout', async () => {
    const { cookie } = await login();
    expect((await fetch(`${baseUrl}/debug/build-v2/matches`, { headers: { cookie } })).status).toBe(200);

    const logout = await fetch(`${baseUrl}/debug/build-v2/logout`, {
      method: 'POST',
      headers: { cookie },
    });
    expect(logout.status).toBe(201);
    expect(logout.headers.get('set-cookie') ?? '').toContain('Max-Age=0');

    expect((await fetch(`${baseUrl}/debug/build-v2/matches`, { headers: { cookie } })).status).toBe(401);
  });

  it('lists and serves each player of a shared match independently', async () => {
    const sharedMatchId = 'match-debug-v2-shared';
    traceStore.put({ ...trace(1, 'steam-111'), matchId: sharedMatchId });
    traceStore.put({ ...trace(1, 'steam-222'), matchId: sharedMatchId });
    const { cookie } = await login();

    const matches = await (await fetch(`${baseUrl}/debug/build-v2/matches`, { headers: { cookie } })).json();
    expect(matches.filter((row: { matchId: string }) => row.matchId === sharedMatchId)).toEqual([
      expect.objectContaining({ matchId: sharedMatchId, steamId: 'steam-111', revision: 1 }),
      expect.objectContaining({ matchId: sharedMatchId, steamId: 'steam-222', revision: 1 }),
    ]);

    const first = await fetch(`${baseUrl}/debug/build-v2/matches/${sharedMatchId}?steamId=steam-111`, {
      headers: { cookie },
    });
    const second = await fetch(`${baseUrl}/debug/build-v2/matches/${sharedMatchId}?steamId=steam-222`, {
      headers: { cookie },
    });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect((await first.json()).steamId).toBe('steam-111');
    expect((await second.json()).steamId).toBe('steam-222');
  });

  async function login(): Promise<{ response: Response; cookie: string }> {
    const response = await fetch(`${baseUrl}/debug/build-v2/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: PASSWORD }),
    });
    const setCookie = response.headers.get('set-cookie');
    if (!setCookie) throw new Error('Login response did not set a session cookie');
    return { response, cookie: setCookie.split(';')[0] };
  }
});

interface FakeBrowserEvent {
  data?: string;
  preventDefault(): void;
}

type FakeBrowserListener = (event: FakeBrowserEvent) => void | Promise<void>;

class FakeBrowserElement {
  value = '';
  textContent = '';
  innerHTML = '';
  disabled = false;
  open = false;
  readonly children: FakeBrowserElement[] = [];
  private readonly listeners = new Map<string, FakeBrowserListener[]>();

  constructor(readonly id: string) {}

  addEventListener(type: string, listener: FakeBrowserListener): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  appendChild(child: FakeBrowserElement): void {
    this.children.push(child);
  }

  async dispatch(type: string, data?: string): Promise<void> {
    const event: FakeBrowserEvent = { data, preventDefault: () => undefined };
    for (const listener of this.listeners.get(type) ?? []) await listener(event);
  }
}

class FakeBrowserEventSource {
  onopen?: () => void;
  onerror?: () => void;
  closed = false;
  private readonly listeners = new Map<string, FakeBrowserListener[]>();

  constructor(readonly url: string) {}

  addEventListener(type: string, listener: FakeBrowserListener): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  emitTrace(traceValue: BuildDecisionTraceV2): void {
    const event: FakeBrowserEvent = {
      data: JSON.stringify(traceValue),
      preventDefault: () => undefined,
    };
    for (const listener of this.listeners.get('trace') ?? []) void listener(event);
  }

  fail(): void {
    this.onerror?.();
  }

  close(): void {
    this.closed = true;
  }
}

function createBrowserHarness(snapshot: BuildDecisionTraceV2): {
  element: (id: string) => FakeBrowserElement;
  operations: string[];
  streams: FakeBrowserEventSource[];
  runNextTimer: () => void;
} {
  const ids = [
    'debugLoginForm',
    'debugPassword',
    'debugStatus',
    'activeMatchSelect',
    'refreshMatches',
    'stageNavigation',
    'traceStages',
    'fullBuildPanel',
    'traceRevision',
  ];
  const elements = new Map(ids.map((id) => [id, new FakeBrowserElement(id)]));
  const operations: string[] = [];
  const streams: FakeBrowserEventSource[] = [];
  const timers: Array<() => void> = [];

  const documentStub = {
    getElementById: (id: string) => elements.get(id),
    createElement: (tagName: string) => new FakeBrowserElement(tagName),
    querySelectorAll: () => [],
  };

  const fetchStub = async (input: string): Promise<Response> => {
    const url = new URL(input, 'http://debug.test');
    const pathname = url.pathname;
    operations.push(`fetch:${pathname}${url.search}`);
    if (pathname === `/debug/build-v2/matches/${MATCH_ID}`) {
      return new Response(JSON.stringify(snapshot), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (pathname === '/debug/build-v2/matches') {
      return new Response(JSON.stringify([
        { matchId: MATCH_ID, steamId: 'steam-111', revision: snapshot.revision },
        { matchId: MATCH_ID, steamId: 'steam-222', revision: snapshot.revision },
      ]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`Unexpected browser fetch ${pathname}`);
  };

  class HarnessEventSource extends FakeBrowserEventSource {
    constructor(url: string) {
      super(url);
      const parsed = new URL(url, 'http://debug.test');
      operations.push(`sse:${parsed.pathname}${parsed.search}`);
      streams.push(this);
    }
  }

  const setTimeoutStub = (callback: () => void): number => {
    timers.push(callback);
    return timers.length;
  };
  const clearTimeoutStub = (_timerId: number): void => undefined;

  const execute = new Function(
    'document',
    'fetch',
    'EventSource',
    'setTimeout',
    'clearTimeout',
    BUILD_DEBUG_V2_CLIENT_JS,
  );
  execute(documentStub, fetchStub, HarnessEventSource, setTimeoutStub, clearTimeoutStub);

  return {
    element: (id: string) => {
      const element = elements.get(id);
      if (!element) throw new Error(`Unknown fake browser element ${id}`);
      return element;
    },
    operations,
    streams,
    runNextTimer: () => {
      const timer = timers.shift();
      if (timer) timer();
    },
  };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function restoreEnv(name: string, previous: string | undefined): void {
  if (previous === undefined) delete process.env[name];
  else process.env[name] = previous;
}
