import {
  StatlockerBrowserCollectorService,
  StatlockerBrowserLauncherV1,
} from '../src/statlocker-adaptive/statlocker-browser-collector.service';

interface FakeBrowser {
  newPage: jest.Mock;
  close: jest.Mock;
  process: jest.Mock;
}

function createPage() {
  return {
    goto: jest.fn().mockResolvedValue(undefined),
    evaluate: jest.fn(async (_fn: unknown, input: { path: string }) => {
      if (input.path === '/api/info/wpa-patches') {
        return { status: 200, data: [{ minorPatchId: '7.3' }] };
      }
      return { status: 200, data: { ok: true } };
    }),
  };
}

function createFakeBrowser(overrides: Partial<FakeBrowser> = {}): FakeBrowser {
  return {
    newPage: jest.fn().mockResolvedValue(createPage()),
    close: jest.fn().mockResolvedValue(undefined),
    process: jest.fn().mockReturnValue({ kill: jest.fn().mockReturnValue(true) }),
    ...overrides,
  };
}

function createLauncher(browser: FakeBrowser): StatlockerBrowserLauncherV1 {
  return { launch: jest.fn().mockResolvedValue(browser) };
}

function buildService(browser: FakeBrowser): StatlockerBrowserCollectorService {
  return new StatlockerBrowserCollectorService(createLauncher(browser));
}

// Production uses 5 s; the tests only need the fallback to be observable.
function shortenCloseTimeout(service: StatlockerBrowserCollectorService, ms = 20): void {
  (service as unknown as { closeTimeoutMs: number }).closeTimeoutMs = ms;
}

function targets() {
  return [{ dataset: 'T4_CHAINS' as const, scopeKey: 'global' }];
}

describe('StatlockerBrowserCollectorService browser lifecycle', () => {
  it('closes the browser after a successful collection', async () => {
    const browser = createFakeBrowser();
    const service = buildService(browser);

    const result = await service.collectBatch(targets());

    expect(result.statlockerPatchId).toBe('7.3');
    expect(browser.close).toHaveBeenCalledTimes(1);
    expect(browser.process).not.toHaveBeenCalled();
  });

  it('closes the browser even when the collection throws', async () => {
    const browser = createFakeBrowser({
      newPage: jest.fn().mockResolvedValue({
        goto: jest.fn().mockRejectedValue(new Error('goto failed')),
        evaluate: jest.fn(),
      }),
    });
    const service = buildService(browser);

    await expect(service.collectBatch(targets())).rejects.toThrow('goto failed');
    expect(browser.close).toHaveBeenCalledTimes(1);
  });

  it('falls back to SIGKILL when close() never settles', async () => {
    const kill = jest.fn().mockReturnValue(true);
    const browser = createFakeBrowser({
      close: jest.fn().mockReturnValue(new Promise<void>(() => undefined)),
      process: jest.fn().mockReturnValue({ kill }),
    });
    const service = buildService(browser);
    shortenCloseTimeout(service);

    await service.collectBatch(targets());

    expect(browser.close).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('does not hang when close() never settles and process() is unavailable', async () => {
    const browser = createFakeBrowser({
      close: jest.fn().mockReturnValue(new Promise<void>(() => undefined)),
      process: jest.fn().mockReturnValue(null),
    });
    const service = buildService(browser);
    shortenCloseTimeout(service);

    await expect(service.collectBatch(targets())).resolves.toBeDefined();
    expect(browser.close).toHaveBeenCalledTimes(1);
  });

  it('treats a rejected close() as closed and does not kill', async () => {
    const kill = jest.fn();
    const browser = createFakeBrowser({
      close: jest.fn().mockRejectedValue(new Error('already closed')),
      process: jest.fn().mockReturnValue({ kill }),
    });
    const service = buildService(browser);

    await expect(service.collectBatch(targets())).resolves.toBeDefined();
    expect(kill).not.toHaveBeenCalled();
  });
});
