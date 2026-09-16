import { Inject, Injectable } from '@nestjs/common';
import { HERO_REFERENCE_SEED } from '../deadlock-live/reference-data.seed';
import { StatlockerDatasetV1 } from './statlocker-adaptive.types';

export const STATLOCKER_BROWSER_LAUNCHER_V1 = Symbol('STATLOCKER_BROWSER_LAUNCHER_V1');

export type StatlockerCollectableDatasetV1 = Exclude<StatlockerDatasetV1, 'CONSENSUS_SKELETON'>;

export interface StatlockerCollectionTargetV1 {
  dataset: StatlockerCollectableDatasetV1;
  scopeKey: string;
  heroId?: number;
  accountId?: string;
}

export interface StatlockerCollectedDatasetV1 {
  dataset: StatlockerCollectableDatasetV1;
  scopeKey: string;
  path: string;
  status: number;
  fetchedAt: string;
  statlockerPatchId: string;
  data: unknown;
}

export interface StatlockerBrowserCollectionResultV1 {
  statlockerPatchId: string;
  fetchedAt: string;
  datasets: readonly StatlockerCollectedDatasetV1[];
}

export interface StatlockerBrowserLauncherV1 {
  launch(options: Record<string, unknown>): Promise<StatlockerBrowserV1>;
}

interface StatlockerBrowserProcessV1 {
  kill(signal?: NodeJS.Signals | number): boolean;
}

interface StatlockerBrowserV1 {
  newPage(): Promise<StatlockerPageV1>;
  close(): Promise<void>;
  process?(): StatlockerBrowserProcessV1 | null;
}

interface StatlockerPageV1 {
  goto(url: string, options: Record<string, unknown>): Promise<unknown>;
  evaluate<T>(fn: (...args: any[]) => unknown, input: unknown): Promise<T>;
}

interface BrowserFetchResultV1 {
  status: number;
  data: unknown;
}

export class StatlockerCollectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StatlockerCollectionError';
  }
}

export class StatlockerCollectionAccessError extends StatlockerCollectionError {
  constructor(message: string) {
    super(message);
    this.name = 'StatlockerCollectionAccessError';
  }
}

@Injectable()
export class StatlockerBrowserCollectorService {
  private readonly baseUrl = 'https://statlocker.gg';
  private readonly pageTimeoutMs = 45_000;
  private readonly bodyTimeoutMs = 60_000;
  private readonly maxConcurrency = 3;
  private readonly closeTimeoutMs = 5_000;

  constructor(
    @Inject(STATLOCKER_BROWSER_LAUNCHER_V1)
    private readonly launcher: StatlockerBrowserLauncherV1,
  ) {}

  async collectBatch(targets: readonly StatlockerCollectionTargetV1[]): Promise<StatlockerBrowserCollectionResultV1> {
    const browser = await this.launcher.launch({
      executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium-browser',
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ],
    });

    try {
      const page = await browser.newPage();
      await page.goto(`${this.baseUrl}/items/meta-model/wpa-analysis/`, {
        waitUntil: 'domcontentloaded',
        timeout: this.pageTimeoutMs,
      });

      const patchControl = await this.fetchFromPage(page, '/api/info/wpa-patches');
      this.assertSuccessfulResponse('/api/info/wpa-patches', patchControl);
      const statlockerPatchId = resolveMinorPatchId(patchControl.data);
      const fetchedAt = new Date().toISOString();
      const datasets: StatlockerCollectedDatasetV1[] = [];

      for (let index = 0; index < targets.length; index += this.maxConcurrency) {
        const chunk = targets.slice(index, index + this.maxConcurrency);
        const chunkResults = await Promise.all(chunk.map(async (target) => {
          const path = buildDatasetPath(target, statlockerPatchId);
          const response = await this.fetchFromPage(page, path, statlockerPatchId);
          this.assertSuccessfulResponse(path, response);
          return {
            dataset: target.dataset,
            scopeKey: target.scopeKey,
            path,
            status: response.status,
            fetchedAt,
            statlockerPatchId,
            data: response.data,
          } satisfies StatlockerCollectedDatasetV1;
        }));
        datasets.push(...chunkResults);
      }

      return {
        statlockerPatchId,
        fetchedAt,
        datasets,
      };
    } finally {
      await this.closeBrowser(browser);
    }
  }

  /**
   * Close the browser without ever blocking the caller.
   *
   * `browser.close()` can hang indefinitely when chromium's own shutdown cannot fork, and a
   * bare `await browser.close()` then does two kinds of damage: it pins the refresh service's
   * `inFlight` key forever, so that scope never refreshes again, and it leaves the process tree
   * behind. Those leftovers re-parent to PID 1 and, without an init, accumulate as zombies until
   * the container's task ceiling is reached -- see `init: true` in docker-compose.yml.
   *
   * Same pattern as the probe's `closeBrowser` in
   * `statlocker-probe/statlocker-browser.service.ts`, with the timer cleared so a fast close
   * does not leave a pending 5 s handle behind.
   */
  private async closeBrowser(browser: StatlockerBrowserV1): Promise<void> {
    let timer: NodeJS.Timeout | undefined;

    const closed = await Promise.race([
      Promise.resolve()
        .then(() => browser.close())
        .then(() => true)
        .catch(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), this.closeTimeoutMs);
      }),
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });

    if (closed) return;

    try {
      browser.process?.()?.kill('SIGKILL');
    } catch {
      // Best-effort cleanup only.
    }
  }

  private async fetchFromPage(
    page: StatlockerPageV1,
    path: string,
    statlockerPatchId?: string,
  ): Promise<BrowserFetchResultV1> {
    return page.evaluate<BrowserFetchResultV1>(async (input: {
      path: string;
      timeoutMs: number;
      statlockerPatchId?: string;
    }) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), input.timeoutMs);
      try {
        const response = await fetch(input.path, {
          method: 'GET',
          credentials: 'same-origin',
          signal: controller.signal,
        });
        const body = await response.text();
        let data: unknown = body;
        if (body.length > 0) {
          try {
            data = JSON.parse(body);
          } catch {
            data = body;
          }
        }
        if (
          input.path === '/api/info/vs-hero-wpa-data' &&
          input.statlockerPatchId &&
          data !== null &&
          typeof data === 'object' &&
          !Array.isArray(data)
        ) {
          const root = data as Record<string, unknown>;
          const byPatch = root.by_patch;
          if (byPatch !== null && typeof byPatch === 'object' && !Array.isArray(byPatch)) {
            const patchKey = `patch_${input.statlockerPatchId}`;
            data = {
              metadata: root.metadata,
              by_patch: {
                [patchKey]: (byPatch as Record<string, unknown>)[patchKey],
              },
            };
          }
        }
        return {
          status: response.status,
          data,
        };
      } finally {
        clearTimeout(timer);
      }
    }, { path, timeoutMs: this.bodyTimeoutMs, statlockerPatchId });
  }

  private assertSuccessfulResponse(path: string, response: BrowserFetchResultV1): void {
    if (response.status === 401 || response.status === 403) {
      throw new StatlockerCollectionAccessError(`Statlocker access restricted for ${path}: HTTP ${response.status}`);
    }
    if (looksLikeAccessWall(response.data)) {
      throw new StatlockerCollectionAccessError(`Statlocker access wall detected for ${path}`);
    }
    if (response.status < 200 || response.status >= 300) {
      throw new StatlockerCollectionError(`Statlocker collection failed for ${path}: HTTP ${response.status}`);
    }
  }
}

export function createStatlockerBrowserLauncherV1(): StatlockerBrowserLauncherV1 {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const puppeteer = require('puppeteer-core') as StatlockerBrowserLauncherV1;
  return puppeteer;
}

function buildDatasetPath(target: StatlockerCollectionTargetV1, statlockerPatchId: string): string {
  if (target.dataset === 'WPA_PATCH_DATA') {
    return `/api/info/wpa-patch-data/${encodeURIComponent(statlockerPatchId)}`;
  }
  if (target.dataset === 'VS_HERO_WPA') return '/api/info/vs-hero-wpa-data';
  if (target.dataset === 'T4_CHAINS') return '/api/info/t4-chains-data';
  if (target.dataset === 'HERO_LEADERBOARD') {
    const heroId = requirePositiveInteger(target.heroId, target.dataset, 'heroId');
    return `/api/leaderboard/get-statlocker-leaderboard/${heroId}`;
  }
  if (target.dataset === 'PRO_BUILD_ANALYSIS') {
    const heroId = requirePositiveInteger(target.heroId, target.dataset, 'heroId');
    const accountId = requireNonEmptyString(target.accountId, target.dataset, 'accountId');
    return `/api/info/player-build-analysis/${encodeURIComponent(accountId)}/${heroId}`;
  }
  if (target.dataset === 'WPA_FILTERED_ITEMS') {
    const heroId = requirePositiveInteger(target.heroId, target.dataset, 'heroId');
    const heroName = HERO_NAME_BY_ID.get(heroId);
    if (!heroName) throw new StatlockerCollectionError(`Unknown Statlocker hero id ${heroId}`);
    return [
      '/api/info/wpa-filtered-items',
      `?hero=${encodeURIComponent(heroName)}`,
      '&tier=all',
      '&rank=ranked',
      '&category=all',
      '&gameState=all',
      '&purchaseTime=all',
      '&teamComp=Average+Comp',
      '&buildType=all',
      `&patch=patch_${encodeURIComponent(statlockerPatchId)}`,
      '&minSampleSize=500',
      '&searchTerm=',
      '&sortBy=wpa',
    ].join('');
  }
  throw new StatlockerCollectionError(`Unsupported Statlocker dataset: ${String(target.dataset)}`);
}

function resolveMinorPatchId(value: unknown): string {
  if (Array.isArray(value)) {
    const current = value[0];
    if (isRecord(current)) {
      const patchId = cleanPatchId(current.minorPatchId);
      if (patchId) return patchId;
    }
    throw new StatlockerCollectionError('Statlocker current minor patch ID is unavailable');
  }

  if (!isRecord(value)) {
    throw new StatlockerCollectionError('Statlocker patch control response is structurally invalid');
  }

  const direct = cleanPatchId(value.current_minor_patch_id);
  if (direct) return direct;

  if (Array.isArray(value.patches)) {
    for (const entry of value.patches) {
      if (!isRecord(entry)) continue;
      const patchId = cleanPatchId(entry.minor_patch_id);
      if (patchId) return patchId;
    }
  }

  throw new StatlockerCollectionError('Statlocker current minor patch ID is unavailable');
}

function cleanPatchId(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) return undefined;
  return value.trim().replace(/^patch_/i, '');
}

const HERO_NAME_BY_ID = new Map<number, string>(
  HERO_REFERENCE_SEED.map((hero) => [hero.hero_id, hero.name] as const),
);

function looksLikeAccessWall(value: unknown): boolean {  const text = typeof value === 'string' ? value : safeStringify(value);
  return /captcha|login wall|sign in|access denied|authentication required/i.test(text);
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

function requirePositiveInteger(value: number | undefined, dataset: string, field: string): number {
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new StatlockerCollectionError(`${dataset} requires a positive ${field}`);
  }
  return value as number;
}

function requireNonEmptyString(value: string | undefined, dataset: string, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new StatlockerCollectionError(`${dataset} requires ${field}`);
  }
  return value.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
