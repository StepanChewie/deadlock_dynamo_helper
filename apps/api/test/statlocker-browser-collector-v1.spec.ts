import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  StatlockerBrowserCollectorService,
  StatlockerCollectionAccessError,
  StatlockerCollectionError,
} from '../src/statlocker-adaptive/statlocker-browser-collector.service';

function createHarness(overrides: Record<string, { status: number; data: unknown }> = {}) {
  const calls: string[] = [];
  const inputs: Array<{ path: string; timeoutMs: number; statlockerPatchId?: string }> = [];
  const close = jest.fn().mockResolvedValue(undefined);
  // A disk-backed fetch never sends its payload through the devtools protocol:
  // chromium writes the file itself. The stub captures the download directory from
  // the CDP call and writes the payload there, so the collector reads a real file
  // exactly as it would in production.
  let downloadDir = '';
  const page = {
    goto: jest.fn().mockResolvedValue(undefined),
    createCDPSession: jest.fn().mockResolvedValue({
      send: jest.fn(async (_method: string, params: { downloadPath?: string }) => {
        if (params?.downloadPath) downloadDir = params.downloadPath;
        return undefined;
      }),
    }),
    evaluate: jest.fn(async (
      _fn: unknown,
      input: { path: string; timeoutMs?: number; statlockerPatchId?: string; name?: string },
    ) => {
      calls.push(input.path);
      const overridden = overrides[input.path];
      // The disk-backed call wants a status number back and a file to appear.
      if (input.name) {
        const payload = overridden ?? { status: 200, data: { path: input.path } };
        mkdirSync(downloadDir, { recursive: true });
        writeFileSync(join(downloadDir, input.name), JSON.stringify(payload.data));
        return payload.status;
      }
      inputs.push(input as { path: string; timeoutMs: number; statlockerPatchId?: string });
      if (overridden) return overridden;
      if (input.path === '/api/info/wpa-patches') {
        return {
          status: 200,
          data: {
            current_minor_patch_id: 'patch_15-1',
            patches: [{ minor_patch_id: '15-1' }],
          },
        };
      }
      return { status: 200, data: { path: input.path } };
    }),
  };
  const launch = jest.fn().mockResolvedValue({
    newPage: jest.fn().mockResolvedValue(page),
    close,
  });

  return {
    service: new StatlockerBrowserCollectorService({ launch }),
    launch,
    close,
    calls,
    inputs,
  };
}

describe('StatlockerBrowserCollectorService', () => {
  it('uses the first patch from the live Statlocker array contract', async () => {
    const harness = createHarness({
      '/api/info/wpa-patches': {
        status: 200,
        data: [
          {
            minorPatchId: '676255623445218601',
            majorPatchDate: '2026-03-11',
            metadataSummary: '{}',
            createdAt: '2026-08-27 15:05:24',
          },
          {
            minorPatchId: '146261',
            majorPatchDate: '2026-03-11',
            metadataSummary: '{}',
            createdAt: '2026-08-04 17:15:43',
          },
        ],
      },
    });

    const result = await harness.service.collectBatch([
      { dataset: 'WPA_PATCH_DATA', scopeKey: 'patch:current' },
    ]);

    expect(result.statlockerPatchId).toBe('676255623445218601');
    expect(result.datasets[0]?.path).toBe(
      '/api/info/wpa-patch-data/676255623445218601',
    );
  });

  it('does not silently fall back to a historical patch when the first live row is invalid', async () => {
    const harness = createHarness({
      '/api/info/wpa-patches': {
        status: 200,
        data: [
          { minorPatchId: '', majorPatchDate: '2026-03-11' },
          { minorPatchId: '146261', majorPatchDate: '2026-03-11' },
        ],
      },
    });

    await expect(harness.service.collectBatch([
      { dataset: 'T4_CHAINS', scopeKey: 'global' },
    ])).rejects.toBeInstanceOf(StatlockerCollectionError);
  });

  it('uses one browser session for a multi-dataset batch and closes it once', async () => {
    const harness = createHarness();

    const result = await harness.service.collectBatch([
      { dataset: 'WPA_PATCH_DATA', scopeKey: 'patch:current' },
      { dataset: 'VS_HERO_WPA', scopeKey: 'global' },
      { dataset: 'T4_CHAINS', scopeKey: 'global' },
      { dataset: 'PRO_BUILD_ANALYSIS', scopeKey: 'hero:10:account:101', heroId: 10, accountId: '101' },
    ]);

    expect(harness.launch).toHaveBeenCalledTimes(1);
    expect(harness.close).toHaveBeenCalledTimes(1);
    expect(result.statlockerPatchId).toBe('15-1');
    expect(harness.calls).toContain('/api/info/wpa-patch-data/15-1');
    expect(harness.calls).not.toContain('/api/info/wpa-patch-data/patch_15-1');
    expect(result.datasets.map((entry) => entry.dataset)).toEqual([
      'WPA_PATCH_DATA',
      'VS_HERO_WPA',
      'T4_CHAINS',
      'PRO_BUILD_ANALYSIS',
    ]);
  });

  it('uses the live hero leaderboard route and allows large responses to finish', async () => {
    const harness = createHarness();

    await harness.service.collectBatch([
      { dataset: 'HERO_LEADERBOARD', scopeKey: 'hero:6', heroId: 6 },
      { dataset: 'VS_HERO_WPA', scopeKey: 'global' },
    ]);

    expect(harness.calls).toContain('/api/leaderboard/get-statlocker-leaderboard/6');
    expect(harness.inputs.filter((input) => input.path !== '/api/info/wpa-patches'))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ timeoutMs: 60_000 }),
      ]));
    expect(harness.inputs.find((input) => input.path === '/api/info/vs-hero-wpa-data'))
      .toMatchObject({ statlockerPatchId: '15-1' });
  });

  it('uses the verified hero-scoped Item Meta Model query for lifecycle collection', async () => {
    const harness = createHarness();

    const result = await harness.service.collectBatch([
      { dataset: 'WPA_FILTERED_ITEMS', scopeKey: 'hero:72', heroId: 72 },
    ]);

    expect(result.datasets[0]?.path).toBe(
      '/api/info/wpa-filtered-items?hero=Billy&tier=all&rank=ranked&category=all&gameState=all'
      + '&purchaseTime=all&teamComp=Average+Comp&buildType=all&patch=patch_15-1'
      + '&minSampleSize=500&searchTerm=&sortBy=wpa',
    );
  });

  it('returns only the current patch from the live multi-patch VS response', async () => {
    const close = jest.fn().mockResolvedValue(undefined);
    const fetchMock = jest.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const path = String(input);
      const data = path === '/api/info/wpa-patches'
        ? [{ minorPatchId: '676255623445218601' }]
        : {
            metadata: { timestamp: '2026-08-30T04:15:05.619205' },
            by_patch: {
              patch_146261: { by_rank: { historical: true } },
              patch_676255623445218601: { by_rank: { current: true } },
            },
            lane_matchup: { large: 'not returned' },
          };
      return {
        status: 200,
        text: async () => JSON.stringify(data),
      } as Response;
    });
    const page = {
      goto: jest.fn().mockResolvedValue(undefined),
      evaluate: jest.fn(async (fn: (input: unknown) => unknown, input: unknown) => fn(input)),
    };
    const service = new StatlockerBrowserCollectorService({
      launch: jest.fn().mockResolvedValue({
        newPage: jest.fn().mockResolvedValue(page),
        close,
      }),
    });

    try {
      const result = await service.collectBatch([
        { dataset: 'VS_HERO_WPA', scopeKey: 'global' },
      ]);

      expect(result.datasets[0]?.data).toEqual({
        metadata: { timestamp: '2026-08-30T04:15:05.619205' },
        by_patch: {
          patch_676255623445218601: { by_rank: { current: true } },
        },
      });
    } finally {
      fetchMock.mockRestore();
    }
    expect(close).toHaveBeenCalledTimes(1);
  });

  it.each([401, 403])('treats HTTP %s as an access collection failure', async (status) => {
    const harness = createHarness({
      '/api/info/wpa-patches': { status, data: { error: 'restricted' } },
    });

    await expect(harness.service.collectBatch([
      { dataset: 'T4_CHAINS', scopeKey: 'global' },
    ])).rejects.toBeInstanceOf(StatlockerCollectionAccessError);
    expect(harness.close).toHaveBeenCalledTimes(1);
  });

  it('does not expose browser session or authentication material in collector results', async () => {
    const harness = createHarness();
    const result = await harness.service.collectBatch([
      { dataset: 'T4_CHAINS', scopeKey: 'global' },
    ]);

    const serialized = JSON.stringify(result).toLowerCase();
    expect(serialized).not.toContain('cookie');
    expect(serialized).not.toContain('header');
    expect(serialized).not.toContain('localstorage');
    expect(serialized).not.toContain('token');
    expect(serialized).not.toContain('api-key');
    expect(serialized).not.toContain('apikey');
  });
});
