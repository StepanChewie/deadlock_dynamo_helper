# Situational Items Mode — Client Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Overwolf client a second recommendation mode: a toggle that switches which endpoint is polled, and a panel showing exactly five situational items, each labelled with the two or three enemy heroes it is best against.

**Architecture:** A dedicated `SituationalRecommendationClient` owns the new endpoint on its own 30-second loop, so the existing event-driven recommendation loop is untouched and only one loop is ever active. The panel reuses the existing purchase-row renderer; the only new presentation work is an "against whom" sub-label, built from the endpoint's `against[]` array. Both windows render it — the desktop panel and the in-game overlay — through the single existing in-game publish channel, tagged with the active mode.

**Tech Stack:** TypeScript, vanilla DOM (no framework), webpack, Jest with a hand-rolled fake DOM.

**Spec:** `docs/superpowers/specs/2026-09-27-situational-items-mode-design.md`
**Server side (already built and deployed to UAT):** `docs/superpowers/plans/2026-09-27-situational-items-mode-api.md`

## Global Constraints

- **Production must keep working exactly as it works.** `main` deploys production. Nothing in this plan changes the existing recommendation mode's behaviour, its endpoint, or its polling.
- **The existing recommendation loop must not change.** `src/adaptive-recommendation-client.ts` is not modified by this plan; the new mode gets its own client.
- **`POST /deadlock/adaptive/v2/situational`** takes `{matchId, localSteamId?}` and returns `{mode:'situational', ready, blockers, decisionId, stateRevision, heroId?, lock?, situationalItems:[{itemId, score, confidence, coverage, against:[{enemyHeroId, deltaWpa, count}]}], degradedReasons}`. The type already exists in `@dynamo-lab/shared` — **do not redeclare it**.
- **Only one loop is active at a time.** The mode toggle starts one and stops the other.
- **The client never invents an item or hero name.** Names come from `ADAPTIVE_ITEM_CATALOG` (via `presentItem`) and `getAdaptiveHeroDisplayName`.
- **No new npm dependencies.**
- **`player-surface-contract.spec.ts` is a hard gate.** It reads the real HTML and asserts: every `getMainWindow().<name>?.` in markup has a `mainWindow.<name> =` assignment in `src/index.ts`; a hardcoded panel list restates `[hidden] { display: none; }`; a hardcoded id list appears exactly once per file. New ids and handlers must be added to those lists **in the same commit as the markup**, or the suite is red.
- **Do not add a hotkey.** `player-surface-contract.spec.ts` pins the manifest's hotkeys to exactly three.
- **Do not reuse the ids `rec-plan` or `situational-recommendation-panel`** — both are pinned to appear exactly once, and both belong to the existing mode.
- **Tests:** `yarn workspace @dynamo-lab/overwolf-client test`; jest flag is `--testPathPatterns` (plural). Typecheck: `cd apps/overwolf-client && ../../node_modules/.bin/tsc --noEmit -p tsconfig.json`.
- **Node 22** for every command: `export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH";`
- **`Edit` writes CRLF** — after any edit run `sed -i 's/\r$//' <file>`.
- **Mutation-test every new guard.**

---

## File Structure

**Create:**

- `apps/overwolf-client/src/situational-recommendation-client.ts` — the new endpoint's client, owning its own 30-second loop.
- `apps/overwolf-client/src/situational-recommendation-presentation.ts` — turns a situational response into `AdaptivePurchaseRouteRow[]` plus the against-label.
- Tests: `situational-recommendation-client.spec.ts`, `situational-recommendation-presentation.spec.ts`.

**Modify:**

- `apps/overwolf-client/src/adaptive-recommendation-presentation.ts` — export `presentItem`; it is currently module-private.
- `apps/overwolf-client/src/player-preferences.ts` — one new preference key.
- `apps/overwolf-client/src/ui.ts` — export the row renderer, add the situational panel's show/hide, the mode-toggle sync, and the against sub-label in `createPurchaseRow`.
- `apps/overwolf-client/public/desktop.html` — the mode toggle and the new panel.
- `apps/overwolf-client/public/in_game.html` — the overlay's situational panel.
- `apps/overwolf-client/src/index.ts` — construct the new client, wire the toggle, own the loop lifecycle, tag the in-game channel with the mode.
- `apps/overwolf-client/src/player-surface-contract.spec.ts`, `src/ui.spec.ts` — the new ids, the new panel in the `[hidden]` list, the new handler.

---

### Task 1: The situational client and its 30-second loop

**Files:**
- Create: `apps/overwolf-client/src/situational-recommendation-client.ts`
- Test: `apps/overwolf-client/src/situational-recommendation-client.spec.ts`

**Interfaces:**
- Consumes: `AdaptiveSituationalResultV2` from `@dynamo-lab/shared`.
- Produces:
  - `interface SituationalRecommendationHandlers { onResult: (result: AdaptiveSituationalResultV2) => void; onError?: (error: Error) => void; }`
  - `const SITUATIONAL_POLL_INTERVAL_MS = 30_000`
  - `class SituationalRecommendationClient { constructor(apiBaseUrl: string, fetcher: FetchLike, intervalMs?: number); start(request, handlers): void; stop(): void; refreshNow(): void; }`

The existing `AdaptiveRecommendationClient` is deliberately **not** reused or modified: its endpoint literal, its result type and its single-slot dedupe are all bound to the old mode, and threading a second endpoint through them would rewrite the whole class.

- [ ] **Step 1: Write the failing tests**

Create `apps/overwolf-client/src/situational-recommendation-client.spec.ts`:

```ts
import {
  SituationalRecommendationClient,
  SITUATIONAL_POLL_INTERVAL_MS,
} from './situational-recommendation-client';

const REQUEST = { matchId: 'match-1', localSteamId: 'steam-1' };

function situationalPayload(overrides: Record<string, unknown> = {}) {
  return {
    mode: 'situational',
    ready: true,
    blockers: [],
    decisionId: 'decision-1',
    stateRevision: 'rev-1',
    situationalItems: [
      { itemId: 101, score: 0.4, confidence: 0.5, coverage: 1, against: [{ enemyHeroId: 7, deltaWpa: 0.1, count: 2000 }] },
    ],
    degradedReasons: [],
    ...overrides,
  };
}

function okFetcher(payload: unknown = situationalPayload()) {
  return jest.fn(async () => ({ ok: true, status: 200, json: async () => payload })) as never;
}

describe('SituationalRecommendationClient', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('fetches the situational endpoint immediately on start', async () => {
    const fetcher = okFetcher();
    const onResult = jest.fn();
    const client = new SituationalRecommendationClient('https://api.test', fetcher);

    client.start(REQUEST, { onResult });
    await jest.advanceTimersByTimeAsync(0);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect((fetcher as unknown as jest.Mock).mock.calls[0][0])
      .toBe('https://api.test/deadlock/adaptive/v2/situational');
    expect(onResult).toHaveBeenCalledWith(expect.objectContaining({ mode: 'situational' }));
  });

  it('polls again on the interval', async () => {
    const fetcher = okFetcher();
    const client = new SituationalRecommendationClient('https://api.test', fetcher);

    client.start(REQUEST, { onResult: jest.fn() });
    await jest.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(SITUATIONAL_POLL_INTERVAL_MS);
    expect(fetcher).toHaveBeenCalledTimes(2);

    await jest.advanceTimersByTimeAsync(SITUATIONAL_POLL_INTERVAL_MS);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('stops polling after stop', async () => {
    const fetcher = okFetcher();
    const client = new SituationalRecommendationClient('https://api.test', fetcher);

    client.start(REQUEST, { onResult: jest.fn() });
    await jest.advanceTimersByTimeAsync(0);
    client.stop();

    await jest.advanceTimersByTimeAsync(SITUATIONAL_POLL_INTERVAL_MS * 3);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('reports an HTTP failure without stopping the loop', async () => {
    const fetcher = jest.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })) as never;
    const onError = jest.fn();
    const client = new SituationalRecommendationClient('https://api.test', fetcher);

    client.start(REQUEST, { onResult: jest.fn(), onError });
    await jest.advanceTimersByTimeAsync(0);

    expect(onError).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(SITUATIONAL_POLL_INTERVAL_MS);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('keeps polling when a fetch rejects', async () => {
    const fetcher = jest.fn(async () => { throw new Error('network down'); }) as never;
    const onError = jest.fn();
    const client = new SituationalRecommendationClient('https://api.test', fetcher);

    client.start(REQUEST, { onResult: jest.fn(), onError });
    await jest.advanceTimersByTimeAsync(0);
    expect(onError).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(SITUATIONAL_POLL_INTERVAL_MS);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('refreshNow issues an extra request without disturbing the interval', async () => {
    const fetcher = okFetcher();
    const client = new SituationalRecommendationClient('https://api.test', fetcher);

    client.start(REQUEST, { onResult: jest.fn() });
    await jest.advanceTimersByTimeAsync(0);

    client.refreshNow();
    await jest.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledTimes(2);

    await jest.advanceTimersByTimeAsync(SITUATIONAL_POLL_INTERVAL_MS);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `yarn workspace @dynamo-lab/overwolf-client test --testPathPatterns=situational-recommendation-client`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `apps/overwolf-client/src/situational-recommendation-client.ts`:

```ts
import { AdaptiveSituationalResultV2 } from '@dynamo-lab/shared';

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export const SITUATIONAL_POLL_INTERVAL_MS = 30_000;

export interface SituationalRecommendationHandlers {
  onResult: (result: AdaptiveSituationalResultV2) => void;
  onError?: (error: Error) => void;
}

export interface SituationalRequestV1 {
  matchId: string;
  localSteamId?: string;
}

/**
 * Polls the situational endpoint on a fixed interval.
 *
 * Deliberately separate from `AdaptiveRecommendationClient` rather than a mode
 * inside it: that class hardcodes its endpoint, binds its handlers and dedupe
 * state to `AdaptiveRecommendationResultV2`, and keeps a single dedupe slot — so
 * two modes sharing one instance would let one mode's request suppress the
 * other's. A parallel class is the smaller and safer change.
 *
 * The interval is fixed rather than event-driven on purpose (owner's decision):
 * the list is allowed to lag a purchase by up to one interval, in exchange for a
 * loop that is trivial to reason about. A failed request never stops the loop —
 * the next tick tries again.
 */
export class SituationalRecommendationClient {
  private timer?: ReturnType<typeof setInterval>;
  private request?: SituationalRequestV1;
  private handlers?: SituationalRecommendationHandlers;

  constructor(
    private readonly apiBaseUrl: string,
    private readonly fetcher: FetchLike,
    private readonly intervalMs = SITUATIONAL_POLL_INTERVAL_MS,
  ) {}

  start(request: SituationalRequestV1, handlers: SituationalRecommendationHandlers): void {
    this.stop();
    this.request = request;
    this.handlers = handlers;
    void this.fetchOnce();
    this.timer = setInterval(() => { void this.fetchOnce(); }, this.intervalMs);
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    this.request = undefined;
    this.handlers = undefined;
  }

  /** An out-of-band fetch, for a manual refresh. Does not reset the interval. */
  refreshNow(): void {
    if (!this.request) return;
    void this.fetchOnce();
  }

  private async fetchOnce(): Promise<void> {
    const request = this.request;
    const handlers = this.handlers;
    if (!request || !handlers) return;

    try {
      const response = await this.fetcher(`${this.apiBaseUrl}/deadlock/adaptive/v2/situational`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          matchId: request.matchId,
          ...(request.localSteamId ? { localSteamId: request.localSteamId } : {}),
        }),
      });
      if (!response.ok) throw new Error(`Situational recommendation HTTP ${response.status}`);
      const result = await response.json() as AdaptiveSituationalResultV2;
      // The request may have been stopped or replaced while this was in flight.
      if (this.request !== request) return;
      handlers.onResult(result);
    } catch (error) {
      if (this.request !== request) return;
      try {
        handlers.onError?.(error instanceof Error ? error : new Error(String(error)));
      } catch {
        // A throwing handler must not take the loop down with it.
      }
    }
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `yarn workspace @dynamo-lab/overwolf-client test --testPathPatterns=situational-recommendation-client`
Expected: PASS, 6 tests.

If `jest.useFakeTimers()` plus `advanceTimersByTimeAsync` misbehaves in this repo's Jest version, the fallback is to inject a tiny interval (`new SituationalRecommendationClient(url, fetcher, 5)`) and use real timers with `await new Promise((r) => setTimeout(r, 20))`. Prefer fake timers; say so in the report if you fall back.

- [ ] **Step 5: Typecheck**

Run: `cd apps/overwolf-client && ../../node_modules/.bin/tsc --noEmit -p tsconfig.json`
Expected: no output.

- [ ] **Step 6: Mutation-test the two guards**

Back the file up. Make each change separately, run the focused suite, restore between them, confirm `sha256sum` matches:

1. Change `if (!response.ok) throw ...` to `if (false) throw ...` → `reports an HTTP failure without stopping the loop` must fail.
2. The stale-request guard `if (this.request !== request) return;` before `handlers.onResult(result)` is untested. Add this test first, confirm it passes, then delete the guard and confirm it fails:

```ts
  it('drops a result that arrives after stop', async () => {
    let release: (value: unknown) => void = () => {};
    const gate = new Promise((resolve) => { release = resolve; });
    const fetcher = jest.fn(async () => {
      await gate;
      return { ok: true, status: 200, json: async () => situationalPayload() };
    }) as never;
    const onResult = jest.fn();
    const client = new SituationalRecommendationClient('https://api.test', fetcher);

    client.start(REQUEST, { onResult });
    client.stop();
    release(undefined);
    await jest.advanceTimersByTimeAsync(0);

    expect(onResult).not.toHaveBeenCalled();
  });
```

Restore from the backup after each mutation and confirm `sha256sum` matches.

- [ ] **Step 7: Commit**

```bash
git add apps/overwolf-client/src/situational-recommendation-client.ts apps/overwolf-client/src/situational-recommendation-client.spec.ts
git commit -m "feat(overwolf): poll the situational endpoint on its own interval"
```

---

### Task 2: Presentation — rows and the against label

**Files:**
- Create: `apps/overwolf-client/src/situational-recommendation-presentation.ts`
- Modify: `apps/overwolf-client/src/adaptive-recommendation-presentation.ts` — export `presentItem`
- Test: `apps/overwolf-client/src/situational-recommendation-presentation.spec.ts`

**Interfaces:**
- Consumes: `AdaptiveSituationalResultV2`; `presentItem(itemId): AdaptivePresentedItem`; `getAdaptiveHeroDisplayName(heroId): string | undefined`; `AdaptivePurchaseRouteRow`.
- Produces:
  - `function presentSituationalAgainst(against: readonly { enemyHeroId: number; deltaWpa: number; count: number }[]): string | undefined` — returns e.g. `"vs Haze, Wraith"`, or `undefined` when nothing is positive.
  - `function buildSituationalRows(result: AdaptiveSituationalResultV2): readonly AdaptivePurchaseRouteRow[]`

`presentAgainst` in `adaptive-recommendation-presentation.ts` **cannot** be reused: it reads the v1 `AdaptiveSituationalContextV1.targetEnemies` shape (`role`/`score`/`confidence`), whereas this endpoint returns `{enemyHeroId, deltaWpa, count}`. The label format is copied from it deliberately, so the two modes read the same to a player.

- [ ] **Step 1: Write the failing tests**

Create `apps/overwolf-client/src/situational-recommendation-presentation.spec.ts`:

```ts
import {
  buildSituationalRows,
  presentSituationalAgainst,
} from './situational-recommendation-presentation';

// Real catalogue ids, so the item name resolution is exercised for real rather
// than through a stub. 7409189 is "Improved Spirit" in the generated catalogue.
const REAL_ITEM_ID = 7409189;

function resultWith(against: Array<{ enemyHeroId: number; deltaWpa: number; count: number }>) {
  return {
    mode: 'situational' as const,
    ready: true,
    blockers: [],
    decisionId: 'decision-1',
    stateRevision: 'rev-1',
    heroId: 13,
    situationalItems: [
      { itemId: REAL_ITEM_ID, score: 0.4, confidence: 0.5, coverage: 1, against },
    ],
    degradedReasons: [],
  };
}

describe('presentSituationalAgainst', () => {
  it('names the enemy heroes, strongest contribution first', () => {
    const label = presentSituationalAgainst([
      { enemyHeroId: 7, deltaWpa: 0.02, count: 2000 },
      { enemyHeroId: 8, deltaWpa: 0.10, count: 2000 },
    ]);

    expect(label).toMatch(/^vs .+, .+$/);
  });

  it('drops entries that do not help', () => {
    const label = presentSituationalAgainst([
      { enemyHeroId: 7, deltaWpa: 0.10, count: 2000 },
      { enemyHeroId: 8, deltaWpa: -0.10, count: 2000 },
    ]);

    expect(label?.split(',').length).toBe(1);
  });

  it('returns undefined when nothing helps', () => {
    expect(presentSituationalAgainst([{ enemyHeroId: 7, deltaWpa: -0.1, count: 2000 }]))
      .toBeUndefined();
    expect(presentSituationalAgainst([])).toBeUndefined();
  });

  it('falls back to a readable label for an unknown hero id', () => {
    expect(presentSituationalAgainst([{ enemyHeroId: 999_999, deltaWpa: 0.1, count: 2000 }]))
      .toBeDefined();
  });
});

describe('buildSituationalRows', () => {
  it('builds one row per item, numbered from one, with a resolved name', () => {
    const rows = buildSituationalRows(resultWith([{ enemyHeroId: 7, deltaWpa: 0.1, count: 2000 }]));

    expect(rows).toHaveLength(1);
    expect(rows[0].position).toBe(1);
    expect(rows[0].item.id).toBe(REAL_ITEM_ID);
    expect(rows[0].item.name).not.toBe('Unknown item');
    expect(rows[0].item.known).toBe(true);
  });

  it('carries the against label on the row', () => {
    const rows = buildSituationalRows(resultWith([{ enemyHeroId: 7, deltaWpa: 0.1, count: 2000 }]));

    expect(rows[0].againstLabel).toMatch(/^vs /);
  });

  it('marks no row as the current action', () => {
    const rows = buildSituationalRows(resultWith([{ enemyHeroId: 7, deltaWpa: 0.1, count: 2000 }]));

    expect(rows[0].isCurrent).toBe(false);
  });

  it('returns an empty list for a not-ready result', () => {
    const rows = buildSituationalRows({
      ...resultWith([]),
      ready: false,
      situationalItems: [],
    });

    expect(rows).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `yarn workspace @dynamo-lab/overwolf-client test --testPathPatterns=situational-recommendation-presentation`
Expected: FAIL — module not found.

- [ ] **Step 3: Export `presentItem`**

In `apps/overwolf-client/src/adaptive-recommendation-presentation.ts`, add `export` to `function presentItem(`. Nothing else in that file changes.

- [ ] **Step 4: Write the implementation**

Create `apps/overwolf-client/src/situational-recommendation-presentation.ts`. Read `AdaptivePresentedPlanItem` in `adaptive-recommendation-presentation.ts` for the exact row fields — the `currentRow` literal at roughly line 193 is a working example of a complete row. Fill `planActionId` with `situational:${itemId}`, `position` with the 1-based index, `isCurrent: false`, and `againstLabel` from `presentSituationalAgainst`. For `status`/`statusLabel`/`actionLabel`/`requirements`/`sourceItems`, use the same values the `currentRow` example uses, so the existing row renderer keeps working unchanged.

`presentSituationalAgainst` sorts by `deltaWpa` descending, filters to `deltaWpa > 0`, maps through `getAdaptiveHeroDisplayName(enemyHeroId)` falling back to `Hero ${enemyHeroId}`, de-duplicates, caps at 3, and returns `vs ${names.join(', ')}` or `undefined`.

- [ ] **Step 5: Run to verify pass, then typecheck**

Run: `yarn workspace @dynamo-lab/overwolf-client test --testPathPatterns=situational-recommendation-presentation`
Expected: PASS, 8 tests.

Run: `cd apps/overwolf-client && ../../node_modules/.bin/tsc --noEmit -p tsconfig.json`
Expected: no output.

- [ ] **Step 6: Mutation-test the filter**

Change `deltaWpa > 0` to `deltaWpa > -Infinity` and confirm `drops entries that do not help` and `returns undefined when nothing helps` both go red. Restore and compare `sha256`.

- [ ] **Step 7: Commit**

```bash
git add apps/overwolf-client/src/situational-recommendation-presentation.ts \
        apps/overwolf-client/src/situational-recommendation-presentation.spec.ts \
        apps/overwolf-client/src/adaptive-recommendation-presentation.ts
git commit -m "feat(overwolf): present situational items as purchase rows with an against label"
```

---

### Task 3: The UI shell — the mode toggle and the panel

Markup and the contract test move together: a new `getMainWindow().<name>?.` in `desktop.html` fails `player-surface-contract.spec.ts` until `index.ts` assigns that handler, so this task also adds the assignment (as a preference-only stub) and Task 4 makes it drive the loop.

**Files:**
- Modify: `apps/overwolf-client/public/desktop.html`, `public/in_game.html`
- Modify: `apps/overwolf-client/src/player-preferences.ts`, `src/ui.ts`, `src/index.ts`
- Modify: `apps/overwolf-client/src/player-surface-contract.spec.ts`, `src/ui.spec.ts`

**Interfaces:**
- Produces:
  - `PREFERENCE_KEYS.recommendationMode = 'recommendation.mode'`
  - `type RecommendationMode = 'full' | 'situational'` (exported from `ui.ts`)
  - `ui.syncRecommendationModePreference(): void`
  - `mainWindow.setRecommendationMode = (mode: RecommendationMode) => void`
  - new ids: `setting-recommendation-mode` (desktop toggle), `situational-mode-panel` (desktop panel), `situational-mode-plan` (desktop list), `situational-mode-panel-overlay` / `situational-mode-plan-overlay` (overlay)

- [ ] **Step 1: Add the preference key**

In `player-preferences.ts`, extend `PREFERENCE_KEYS`:

```ts
export const PREFERENCE_KEYS = {
  overlayAutoShow: 'overlay.autoShow',
  recommendationMode: 'recommendation.mode',
} as const;
```

- [ ] **Step 2: Add the markup**

In `desktop.html`, inside `.topbar-actions` next to the Refresh button, add a two-state switch. Use a checkbox styled like the existing settings toggle, with its own id and its own handler:

```html
<label class="mode-toggle" for="setting-recommendation-mode">
  <input type="checkbox" id="setting-recommendation-mode" class="settings-toggle"
         onchange="overwolf.windows.getMainWindow().setRecommendationMode?.(this.checked ? 'situational' : 'full')" />
  <span>Situational items</span>
</label>
```

Inside `#build-workspace`, after the existing `#guide-active` section, add the new panel with **its own ids**:

```html
<section id="situational-mode-panel" class="situational-mode-panel" hidden>
  <header class="build-head"><h1>Situational items</h1><span>Best against this team</span></header>
  <div id="situational-mode-plan" aria-label="Situational items" data-route-limit="5"></div>
</section>
```

Add the `[hidden]` restatement beside the existing one, matching its shape exactly — a class selector, because the panel carries a class:

```css
.situational-mode-panel[hidden] { display: none; }
```

In `in_game.html`, add the overlay's own container inside the existing `.hud-container`:

```html
<section id="situational-mode-panel-overlay" hidden>
  <div id="situational-mode-plan-overlay" aria-label="Situational items" data-route-limit="5"></div>
</section>
```

- [ ] **Step 3: Extend the contract test — same commit**

In `player-surface-contract.spec.ts`:
- add `'situational-mode-panel'` to the `[hidden]` panel array at line 77;
- add `'setting-recommendation-mode'`, `'situational-mode-panel'`, `'situational-mode-plan'` to the desktop id list at line 100;
- add `'situational-mode-panel-overlay'`, `'situational-mode-plan-overlay'` to the overlay id list at line 184.

Do **not** touch the hotkey assertion, the manifest assertions, or the `rec-plan` pins.

In `ui.spec.ts`, add the same new ids to the `elementIds` allow-list (line 86), or any new assertion against them will see `undefined`.

- [ ] **Step 4: Add the mode preference plumbing**

In `ui.ts`:

```ts
export type RecommendationMode = 'full' | 'situational';

export function readRecommendationMode(): RecommendationMode {
  return readPreference<RecommendationMode>(PREFERENCE_KEYS.recommendationMode, 'full') === 'situational'
    ? 'situational'
    : 'full';
}

export function syncRecommendationModePreference(): void {
  const checkbox = document.getElementById('setting-recommendation-mode') as
    | (HTMLElement & { checked: boolean })
    | null;
  if (checkbox) checkbox.checked = readRecommendationMode() === 'situational';
}
```

The `=== 'situational' ? … : 'full'` shape is deliberate: a corrupted stored value must resolve to the existing mode, never to the new one.

- [ ] **Step 5: Assign the handler**

In `index.ts`, beside `mainWindow.setOverlayAutoShow`:

```ts
mainWindow.setRecommendationMode = (mode: RecommendationMode): void => {
  persistPreference(PREFERENCE_KEYS.recommendationMode, mode === 'situational' ? 'situational' : 'full');
  ui.syncRecommendationModePreference();
};
```

Task 4 replaces the body with the loop switch; for now it persists and re-syncs, which keeps the contract test green and the toggle honest about what it stores.

- [ ] **Step 6: Run the suites**

Run: `yarn workspace @dynamo-lab/overwolf-client test`
Expected: all suites pass, including `player-surface-contract` and `ui`.

- [ ] **Step 7: Mutation-test the contract additions**

Remove `'situational-mode-panel'` from the `[hidden]` panel array and confirm the contract suite goes red. Restore and compare `sha256`.

- [ ] **Step 8: Commit**

```bash
git add apps/overwolf-client/public/desktop.html apps/overwolf-client/public/in_game.html \
        apps/overwolf-client/src/player-preferences.ts apps/overwolf-client/src/ui.ts \
        apps/overwolf-client/src/index.ts apps/overwolf-client/src/player-surface-contract.spec.ts \
        apps/overwolf-client/src/ui.spec.ts
git commit -m "feat(overwolf): add the recommendation mode toggle and the situational panel"
```

---

### Task 4: The render path, the loop switch, and the overlay

**Files:**
- Modify: `apps/overwolf-client/src/ui.ts`, `src/index.ts`
- Test: `apps/overwolf-client/src/ui.spec.ts`

**Interfaces:**
- Consumes: `SituationalRecommendationClient` (Task 1), `buildSituationalRows` (Task 2), `RecommendationMode` (Task 3).
- Produces:
  - `ui.showSituationalRecommendation(result: AdaptiveSituationalResultV2): void`
  - `ui.hideSituationalMode(): void`
  - `mainWindow.inGameAdaptiveUpdate` now receives `{ mode, payload }` instead of the bare payload.

- [ ] **Step 1: Write the failing UI tests**

In `ui.spec.ts`, add tests asserting:
- `showSituationalRecommendation` with a ready result renders one row per item into `situational-mode-plan`, shows `situational-mode-panel`, and hides the full-build panel;
- the against label appears in the rendered row's text;
- a not-ready result hides the panel rather than rendering an empty list;
- `showAdaptiveRecommendation` (the existing mode) still hides the situational panel.

- [ ] **Step 2: Run to verify they fail**

Run: `yarn workspace @dynamo-lab/overwolf-client test --testPathPatterns=ui`
Expected: FAIL — `showSituationalRecommendation is not a function`.

- [ ] **Step 3: Implement the render path in `ui.ts`**

Add `showSituationalRecommendation` and `hideSituationalMode`, and have each mode's show hide the other's panel so the two can never be on screen together. Export `renderPurchaseRoute` and `createPurchaseRow` (both currently module-private) so the situational path can reuse them, and extend `createPurchaseRow` so the `small` sub-line under the item name renders `planned.againstLabel` when it is set, falling back to the current `'Buy now'` text otherwise. That sub-line is the only markup difference between a situational row and a build row.

- [ ] **Step 4: Wire the loop switch and the overlay channel in `index.ts`**

- Construct `const situationalClient = new SituationalRecommendationClient(apiBaseUrl, customFetch, SITUATIONAL_POLL_INTERVAL_MS);`
- Replace `mainWindow.setRecommendationMode`'s body so it persists the preference, calls `ui.syncRecommendationModePreference()`, and **switches loops**: `'situational'` stops the existing `adaptiveClient` and starts `situationalClient`; `'full'` does the reverse. Exactly one runs.
- On start-up, read the stored mode and start the matching loop.
- Publish the situational result through a `publishSituationalRecommendation` that mirrors `publishAdaptiveRecommendation`'s shape (refresh-pending off, latest payload, diagnostics, in-game push).
- Change the in-game channel to carry the mode: `mainWindow.inGameAdaptiveUpdate?.({ mode, payload })`, and update the in-game handler in the same file to branch on `mode` — calling `ui.showSituationalRecommendation` or `ui.showAdaptiveRecommendation` — and to call the matching hide when `payload` is null. One channel, tagged, rather than a second channel: the overlay must show whichever mode is active, and it should not have to know the preference.

- [ ] **Step 5: Run the full client suite**

Run: `yarn workspace @dynamo-lab/overwolf-client test`
Expected: all pass.

- [ ] **Step 6: Typecheck and build**

Run: `cd apps/overwolf-client && ../../node_modules/.bin/tsc --noEmit -p tsconfig.json`
Then: `OVERWOLF_API_BASE_URL=https://aboba-telegramovich.duckdns.org/deadlock-uat yarn workspace @dynamo-lab/overwolf-client build`
Expected: the store-ready validator passes and the bundle syncs to the Windows folder.

**After this build, rebuild the repo's own artifact so it points at production again**: `yarn workspace @dynamo-lab/overwolf-client build:bundle`. `configure:api` cannot do it — it substitutes a literal that is a prefix of the already-substituted URL, so it reports "0 bundle replacements" and changes nothing.

- [ ] **Step 7: Commit**

```bash
git add apps/overwolf-client/src/ui.ts apps/overwolf-client/src/index.ts apps/overwolf-client/src/ui.spec.ts
git commit -m "feat(overwolf): switch recommendation modes and render situational items in both windows"
```

---

## Self-Review

**Spec coverage:**

| Spec requirement | Task |
|---|---|
| Mode switch that selects which flow is polled | 3 (markup, preference), 4 (loop switch) |
| Dedicated 30-second poll | 1 |
| Exactly five items, core excluded | Server-side; the client renders what it is given |
| Top 2–3 enemies with magnitudes, shown per item | 2 |
| Item and hero names resolved client-side | 2 |
| A purchased item leaves the list | Server-side exclusion; the client drops it on the next tick, so within one interval |
| Panel reuses the existing row rendering | 2, 4 |
| `[hidden]` restatement | 3 |
| Contract-test updates | 3 |
| Only one loop active | 4 |
| Existing mode's behaviour unchanged | 1 (separate client), 4 (the existing loop is only started/stopped, never altered) |

**Known gaps, stated rather than hidden:**

- **No end-to-end client test against a live endpoint.** The unit tests pin the client's loop, the presentation and the UI separately; whether a real match produces five sensible items is only answerable in a real game, which is what the local UAT build is for.
- **The 30-second lag is accepted, not mitigated.** A purchased item can sit in the list for up to one interval. The inventory event that the existing loop uses for an immediate refresh is deliberately not wired to the new loop — the owner chose a fixed interval. Wiring it is a one-line follow-up.
- **No hotkey.** The manifest's hotkeys are pinned to exactly three by the contract test, and the owner asked for a UI toggle.
