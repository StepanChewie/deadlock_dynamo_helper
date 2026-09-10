import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { BuildDebugAuthV2Guard } from '../src/build-debug-v2/build-debug-auth-v2.guard';
import { BuildDebugAuthV2Service } from '../src/build-debug-v2/build-debug-auth-v2.service';
import { BuildDebugV2Controller } from '../src/build-debug-v2/build-debug-v2.controller';
import { BuildDebugTraceStoreV2Service } from '../src/statlocker-adaptive/build-debug-trace-store-v2.service';
import { BuildDecisionTraceV2 } from '../src/statlocker-adaptive/build-decision-trace-v2';

const MATCH_ID = 'match-debug-v2';
const PASSWORD = 'debug-password-test';
const SESSION_SECRET = 'debug-session-secret-test';

function trace(revision = 1): BuildDecisionTraceV2 {
  return {
    matchId: MATCH_ID,
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

    const snapshot = await fetch(`${baseUrl}/debug/build-v2/matches/${MATCH_ID}`, {
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
    const response = await fetch(`${baseUrl}/debug/build-v2/matches/${MATCH_ID}/stream`, {
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

function restoreEnv(name: string, previous: string | undefined): void {
  if (previous === undefined) delete process.env[name];
  else process.env[name] = previous;
}
