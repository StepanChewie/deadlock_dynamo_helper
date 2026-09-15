# Dynamo Lab Overwolf UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the approved Dynamo Lab desktop shell and compact in-game overlay with one authoritative current purchase plus four ordered next purchases, real Deadlock item artwork, and no player-facing debug UI.

**Architecture:** Keep the existing Overwolf controller and adaptive client untouched except for truthful refresh-state notifications. Extend the existing presentation boundary with explicit current-action identity, derive a pure five-row purchase route, and let both HTML windows render that same route through `src/ui.ts`. Use the existing Deadlock UI web component by item ID for artwork, with a category fallback tile underneath; do not add a framework or a new application state layer.

**Tech Stack:** TypeScript 5.9, Jest/ts-jest, plain HTML/CSS, webpack 5, Overwolf manifest v1, Deadlock UI Web Components.

**Spec:** `docs/superpowers/specs/2026-09-15-dynamo-lab-overwolf-ui-design.md`

## Global Constraints

- The approved Resonance Blueprint mockup is the visual source of truth; do not redesign the shell.
- Visual references are `.superpowers/brainstorm/173834-1789431149/content/dynamo-blueprint-build-only.html` and `.superpowers/brainstorm/173834-1789431149/content/dynamo-resonance-blueprint-base.png` in the original checkout; copy only the approved measurements/styles, not the rasterized full-page screenshot.
- Player-facing product name is `Dynamo Lab`; `Statlocker` must not appear in desktop or overlay copy.
- Live Build is the only active destination; Overview, Matches, Match Analysis, and Settings are disabled and contain no fake data.
- Render at most five purchase rows: one current action plus four subsequent legal actions.
- Preserve planner order and transaction identity; never deduplicate by item ID or invent an action.
- Preserve polling, event ingestion, recommendation publication, window restoration, and hotkeys.
- Desktop minimum remains usable at 600x400; overlay remains exactly 340 px wide and no taller than 700 px.
- Category must use both text and color. Refresh must be keyboard reachable and show its busy state.
- Use no frontend framework and no new runtime state library.

---

### Task 1: Pure five-row purchase route

**Files:**
- Modify: `apps/overwolf-client/src/adaptive-recommendation-presentation.ts`
- Modify: `apps/overwolf-client/src/adaptive-recommendation-presentation.spec.ts`

**Interfaces:**
- Consumes: `AdaptiveRecommendationPresentation`, `AdaptivePresentedPlanItem`, and the existing catalog-backed `AdaptivePresentedItem`.
- Produces: `AdaptivePurchaseRouteRow`, `buildAdaptivePurchaseRoute(view): readonly AdaptivePurchaseRouteRow[]`, `AdaptiveRecommendationPresentation.currentPlanActionId`, and `AdaptivePresentedPlanItem.isCurrent`.

- [ ] **Step 1: Write failing route tests**

Add tests that prove current identity, the 1+4 limit, owned/completed filtering, and preservation of repeated item transactions:

```ts
it('projects one current action plus four ordered future actions', () => {
  const view = buildAdaptiveRecommendationPresentation(recommendation({
    planActions: [
      planAction('current-buy', 1, 3862866912, 'READY'),
      planAction('next-1', 2, 968099481, 'PLANNED'),
      planAction('next-2', 3, 1342610602, 'PLANNED'),
      planAction('next-3', 4, 1437614329, 'PLANNED'),
      planAction('next-4', 5, 7409189, 'PLANNED'),
      planAction('later', 6, 26002154, 'PLANNED'),
    ],
  }));

  expect(buildAdaptivePurchaseRoute(view).map((row) => row.planActionId))
    .toEqual(['current-buy', 'next-1', 'next-2', 'next-3', 'next-4']);
  expect(buildAdaptivePurchaseRoute(view)[0].isCurrent).toBe(true);
});

it('keeps two different transactions for the same item', () => {
  const view = buildAdaptiveRecommendationPresentation(recommendation({
    planActions: [
      planAction('buy-first', 1, 3862866912, 'READY'),
      planAction('buy-again', 2, 3862866912, 'PLANNED'),
    ],
  }));

  expect(buildAdaptivePurchaseRoute(view).map((row) => row.planActionId))
    .toEqual(['buy-first', 'buy-again']);
});
```

The local `planAction()` test helper must return a complete semantic action with `planActionId`, `sequence`, `status`, `action`, `targetItemId`, `sourceItemIds`, `requirements`, and `reasonCodes`.

- [ ] **Step 2: Run the focused test and witness RED**

Run:

```bash
yarn workspace @deadlock-live-probe/overwolf-client test adaptive-recommendation-presentation.spec.ts
```

Expected: FAIL because `buildAdaptivePurchaseRoute` and `isCurrent` do not exist.

- [ ] **Step 3: Implement the minimal pure projection**

Add `readonly isCurrent: boolean;` to the existing `AdaptivePresentedPlanItem` interface, then add the route type and projection:

```ts
export interface AdaptivePurchaseRouteRow extends AdaptivePresentedPlanItem {}

export function buildAdaptivePurchaseRoute(
  view: AdaptiveRecommendationPresentation,
): readonly AdaptivePurchaseRouteRow[] {
  const purchasable = view.plan.items.filter(
    (item) => item.status !== 'OWNED' && item.status !== 'COMPLETED',
  );
  const current = purchasable.find((item) => item.isCurrent);
  const currentRow = current ?? (view.primaryItem ? {
    planActionId: view.currentPlanActionId ?? `current:${view.primaryItem.id}`,
    item: view.primaryItem,
    position: 0,
    status: 'READY' as const,
    statusLabel: 'Ready',
    actionLabel: view.actionLabel,
    requirements: view.primaryRequirements,
    sourceItems: [],
    replacedItem: view.replacedItem,
    situationalPurposeLabel: view.situationalPurposeLabel,
    againstLabel: view.againstLabel,
    isCurrent: true,
  } : undefined);
  if (!currentRow) return purchasable.slice(0, 5);
  return [currentRow, ...purchasable.filter((item) => item.planActionId !== currentRow.planActionId)]
    .slice(0, 5);
}
```

Set `currentPlanActionId` from `primaryPlanAction?.planActionId`. Set `isCurrent` from the exact semantic action in `presentPlanAction()`. For `recommendedBuild`, set it from `plannedItem.status === 'NEXT'`. Do not compare or deduplicate `item.id`. Add a test where `recommendedBuild` and `planActions` are empty and assert that the authoritative primary item still produces one current row.

- [ ] **Step 4: Run focused and full presentation tests**

Run:

```bash
yarn workspace @deadlock-live-probe/overwolf-client test adaptive-recommendation-presentation.spec.ts
```

Expected: PASS, including the existing duplicate-transaction regression.

- [ ] **Step 5: Commit the route projection**

```bash
git add apps/overwolf-client/src/adaptive-recommendation-presentation.ts apps/overwolf-client/src/adaptive-recommendation-presentation.spec.ts
git commit -m "feat(overwolf): project five-item purchase route"
```

---

### Task 2: Player-facing route renderer and artwork fallback

**Files:**
- Modify: `apps/overwolf-client/src/ui.ts`
- Modify: `apps/overwolf-client/src/ui.spec.ts`

**Interfaces:**
- Consumes: `buildAdaptivePurchaseRoute(view)` from Task 1 and existing `updateStatus`, `updateIndicator`, `showAdaptiveRecommendation`, `showAdaptiveError`, and `hideSituationalPanel` calls from `src/index.ts`.
- Produces: DOM rows in `#rec-plan` and the optional desktop `#overlay-preview-plan`, each with `data-plan-action-id`, `data-current`, a `dl-item-card[item-id]`, item name, numeric price, and category label; also `setRefreshPending(pending: boolean)`.

- [ ] **Step 1: Replace old DOM expectations with failing player-route tests**

Extend `FakeElement` with `tagName`, `disabled`, `toggleAttribute()`, and `classList.toggle()`. Make `document.createElement(tagName)` preserve the tag name. Register only the new shell IDs: `status`, `indicator-dot`, `indicator-text`, `refresh-build`, `guide-empty`, `guide-empty-title`, `guide-empty-copy`, `guide-active`, `situational-recommendation-panel`, `rec-plan`, `overlay-preview-plan`, and `rec-update-note`.

Add assertions equivalent to:

```ts
it('renders five aligned purchase rows with item artwork, price, and category', () => {
  showAdaptiveRecommendation(fiveItemRecommendation());

  const rows = elements.get('rec-plan')?.children ?? [];
  expect(rows).toHaveLength(5);
  expect(rows[0].attributes.get('data-current')).toBe('true');
  expect(rows[0].children.some((child) => child.tagName === 'DL-ITEM-CARD')).toBe(true);
  expect(flatText(rows[0])).toContain('Restorative Shot');
  expect(flatText(rows[0])).toContain('800');
  expect(flatText(rows[0])).toContain('WEAPON');
  expect(elements.get('overlay-preview-plan')?.children).toHaveLength(5);
});

it('exposes refresh busy state without clearing the route', () => {
  showAdaptiveRecommendation(fiveItemRecommendation());
  setRefreshPending(true);
  expect(elements.get('refresh-build')?.disabled).toBe(true);
  expect(elements.get('refresh-build')?.textContent).toBe('Refreshing');
  expect(elements.get('rec-plan')?.children).toHaveLength(5);
});
```

- [ ] **Step 2: Run the UI test and witness RED**

Run:

```bash
yarn workspace @deadlock-live-probe/overwolf-client test ui.spec.ts
```

Expected: FAIL because the old renderer has no item cards, price/category columns, or refresh state API.

- [ ] **Step 3: Replace debug-oriented rendering with the shared route renderer**

Keep the exported controller-facing functions but reduce `showAdaptiveRecommendation()` to state visibility plus `renderPurchaseRoute(buildAdaptivePurchaseRoute(view), 'rec-plan')` and a second call for the optional `overlay-preview-plan`. Remove decision-debug, reason, alternative, confidence, source, and glyph rendering from this player-facing module.

Create each row with this structure:

```html
<div class="purchase-row slot-weapon is-current" data-current="true">
  <span class="purchase-position">0</span>
  <span class="item-art">
    <span class="item-art-fallback">W</span>
    <dl-item-card item-id="3862866912" variant="icon" show-tier-badge="false" tooltip-trigger="none"></dl-item-card>
  </span>
  <span class="purchase-copy">
    <strong>Restorative Shot</strong>
    <small>Buy now</small>
  </span>
  <strong class="purchase-price">800</strong>
  <span class="purchase-category">WEAPON</span>
</div>
```

Use `planned.item.costLabel?.replace(/\s*souls$/i, '') || '—'` for price text, uppercase slot text for known categories, and `W`, `V`, `S`, or `•` only as the covered fallback tile. Set the `dl-item-card` `aria-label` to `${planned.item.name} item icon` even though its visual wrapper is otherwise decorative.

Implement refresh state with native properties:

```ts
export function setRefreshPending(pending: boolean): void {
  const button = document.getElementById('refresh-build') as HTMLButtonElement | null;
  if (!button) return;
  button.disabled = pending;
  button.textContent = pending ? 'Refreshing' : 'Refresh';
  button.setAttribute('aria-busy', String(pending));
}
```

Player-facing reconnect copy must say `Dynamo Lab is reconnecting` and `The build route will appear when fresh match data is available.`

- [ ] **Step 4: Run the focused UI tests**

Run:

```bash
yarn workspace @deadlock-live-probe/overwolf-client test ui.spec.ts
```

Expected: PASS with five rows, artwork attributes, price/category text, retained last-safe route, empty state, and refresh busy state.

- [ ] **Step 5: Commit the renderer**

```bash
git add apps/overwolf-client/src/ui.ts apps/overwolf-client/src/ui.spec.ts
git commit -m "feat(overwolf): render Dynamo Lab purchase route"
```

---

### Task 3: Approved desktop shell

**Files:**
- Modify: `apps/overwolf-client/public/desktop.html`
- Create: `apps/overwolf-client/src/player-surface-contract.spec.ts`

**Interfaces:**
- Consumes: the IDs and row classes produced by Task 2.
- Produces: the Dynamo Lab app shell, functional Live Build surface, disabled future navigation, top-bar connection state, and Refresh button.

- [ ] **Step 1: Add a failing static surface-contract test**

Read the HTML with `node:fs` and assert the contract:

```ts
const desktop = readFileSync(join(__dirname, '../public/desktop.html'), 'utf8');

it('ships Dynamo Lab desktop chrome without player-facing diagnostics', () => {
  expect(desktop).toContain('<title>Dynamo Lab</title>');
  expect(desktop).toContain('id="refresh-build"');
  expect(desktop).toContain('aria-current="page"');
  expect(desktop.match(/aria-disabled="true"/g)).toHaveLength(4);
  expect(desktop).not.toMatch(/Statlocker|Decision trace|API sends|Last event/i);
});
```

- [ ] **Step 2: Run the contract test and witness RED**

Run:

```bash
yarn workspace @deadlock-live-probe/overwolf-client test player-surface-contract.spec.ts
```

Expected: FAIL on the old title, branding, missing app navigation, and debug copy.

- [ ] **Step 3: Replace `desktop.html` with the approved shell**

Use this semantic skeleton and preserve the exact IDs consumed by TypeScript:

```html
<body class="desktop-surface">
  <div class="app-shell">
    <aside class="app-nav" aria-label="Dynamo Lab navigation">
      <a class="brand" aria-label="Dynamo Lab home"><img src="dynamo.png" alt="" /><span>Dynamo Lab</span></a>
      <nav>
        <button type="button" aria-disabled="true">Overview <small>Coming soon</small></button>
        <button type="button" class="is-active" aria-current="page">Live Build</button>
        <button type="button" aria-disabled="true">Matches <small>Coming soon</small></button>
        <button type="button" aria-disabled="true">Match Analysis <small>Coming soon</small></button>
        <button type="button" aria-disabled="true">Settings <small>Coming soon</small></button>
      </nav>
    </aside>
    <main class="workspace">
      <header class="topbar">
        <span id="status" class="connection-state"><span id="indicator-dot"></span><span id="indicator-text">Connecting</span></span>
        <button id="refresh-build" type="button" onclick="overwolf.windows.getMainWindow().refreshBuild?.()">Refresh</button>
      </header>
      <section class="build-workspace" aria-labelledby="build-title">
        <header><h1 id="build-title">Build Route</h1><span>1 current + 4 next</span></header>
        <section id="guide-empty"><h2 id="guide-empty-title">Waiting for match data</h2><p id="guide-empty-copy">Your route appears automatically when Deadlock is detected.</p></section>
        <section id="guide-active"><div id="situational-recommendation-panel"><div id="rec-update-note"></div><div id="rec-plan" aria-label="Five-item purchase route"></div></div></section>
      </section>
      <aside class="overlay-preview" aria-label="In-game overlay preview">
        <header><strong>Dynamo Lab</strong><span>Live</span></header>
        <div id="overlay-preview-plan"></div>
      </aside>
    </main>
  </div>
  <pre id="console" hidden></pre>
  <script type="module" src="https://unpkg.com/@deadlock-api/ui-core/dist/main/main.esm.js"></script>
  <script src="dist/index.js"></script>
</body>
```

Implement the Resonance Blueprint styling with a restrained token set: `--canvas: #041b25`, `--nav: #062631`, `--surface: #08222b`, `--line: #28505a`, `--text: #e7eff0`, `--muted: #91aeb4`, `--amber: #e4a24d`, `--weapon: #d99a3a`, `--vitality: #63b77a`, and `--spirit: #a778d4`. Use one sans family plus tabular numerals. The purchase grid columns at full width are `32px 64px minmax(180px, 1fr) 96px 104px`; the current row uses the same grid and height as future rows.

At widths below 980 px, hide the decorative overlay preview and reduce the nav to 168 px. At the 600 px minimum, collapse nav labels while keeping Live Build identifiable, and collapse category beneath price rather than allowing horizontal clipping. Do not add decorative animations.

- [ ] **Step 4: Run the contract and UI suites**

Run:

```bash
yarn workspace @deadlock-live-probe/overwolf-client test player-surface-contract.spec.ts ui.spec.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the desktop shell**

```bash
git add apps/overwolf-client/public/desktop.html apps/overwolf-client/src/player-surface-contract.spec.ts
git commit -m "feat(overwolf): add Dynamo Lab desktop shell"
```

---

### Task 4: Compact 340 px overlay and truthful refresh lifecycle

**Files:**
- Modify: `apps/overwolf-client/public/in_game.html`
- Modify: `apps/overwolf-client/src/player-surface-contract.spec.ts`
- Modify: `apps/overwolf-client/src/index.ts`
- Modify: `apps/overwolf-client/src/ui.spec.ts`

**Interfaces:**
- Consumes: Task 2 route DOM and `setRefreshPending()`.
- Produces: a five-row compact overlay and lifecycle calls that clear the busy state on either result or error.

- [ ] **Step 1: Add failing overlay and lifecycle expectations**

Add static assertions:

```ts
const overlay = readFileSync(join(__dirname, '../public/in_game.html'), 'utf8');

it('ships the compact Dynamo Lab overlay contract', () => {
  expect(overlay).toContain('<title>Dynamo Lab Overlay</title>');
  expect(overlay).toContain('id="rec-plan"');
  expect(overlay).toContain('--overlay-width: 340px');
  expect(overlay).not.toMatch(/Statlocker|Confidence|Why this move|Also viable|Compact/i);
});
```

Extend the UI test so a successful recommendation and an error both restore `Refresh` from the busy state.

- [ ] **Step 2: Run focused tests and witness RED**

Run:

```bash
yarn workspace @deadlock-live-probe/overwolf-client test player-surface-contract.spec.ts ui.spec.ts
```

Expected: FAIL on the old overlay chrome and missing refresh reset.

- [ ] **Step 3: Replace overlay markup/styles and connect refresh state**

The overlay body contains only a draggable header, status, empty/error note, and `#rec-plan`. Load the same Deadlock UI module as desktop. Use `--overlay-width: 340px`, 8 px outer padding, 52 px artwork, 8 px row gaps, and 10 px vertical row padding. Use a 15–16 px semibold `.purchase-price` with tabular numerals; secondary action/category labels remain 9–10 px. Remove the Compact toggle and all reasons, confidence, alternatives, footer, and debug sections.

In `src/index.ts`, wrap manual refresh and publication without changing scheduling:

```ts
mainWindow.refreshBuild = (): void => {
  ui.setRefreshPending(true);
  scheduleAdaptiveRecommendation(true);
};

const publishAdaptiveRecommendation = (data: any): void => {
  ui.setRefreshPending(false);
  // existing publication body remains
};

const publishAdaptiveError = (error: Error): void => {
  ui.setRefreshPending(false);
  // existing last-safe error body remains
};
```

Keep the existing drag behavior and `ensureOverlayHeight()`. Remove `toggleHudMode()` because there is only one approved compact overlay mode.

- [ ] **Step 4: Run focused tests and the full Overwolf suite**

Run:

```bash
yarn workspace @deadlock-live-probe/overwolf-client test
```

Expected: all Overwolf suites PASS.

- [ ] **Step 5: Commit the overlay slice**

```bash
git add apps/overwolf-client/public/in_game.html apps/overwolf-client/src/player-surface-contract.spec.ts apps/overwolf-client/src/index.ts apps/overwolf-client/src/ui.spec.ts
git commit -m "feat(overwolf): add compact Dynamo Lab overlay"
```

---

### Task 5: Manifest, release validation, and real-browser proof

**Files:**
- Modify: `apps/overwolf-client/public/manifest.json`
- Modify: `apps/overwolf-client/src/player-surface-contract.spec.ts`
- Modify if detector reports an actual issue: `apps/overwolf-client/public/desktop.html`
- Modify if detector reports an actual issue: `apps/overwolf-client/public/in_game.html`

**Interfaces:**
- Consumes: completed player surfaces from Tasks 1–4.
- Produces: sideload-valid Dynamo Lab metadata and recorded visual verification artifacts.

- [ ] **Step 1: Add failing manifest assertions**

Add:

```ts
const manifest = JSON.parse(readFileSync(join(__dirname, '../public/manifest.json'), 'utf8'));

it('declares Dynamo Lab and the exact artwork origins', () => {
  expect(manifest.meta.name).toBe('Dynamo Lab');
  expect(manifest.meta.description).not.toMatch(/telemetry|Statlocker/i);
  expect(manifest.data.externally_connectable.matches).toEqual(expect.arrayContaining([
    'https://unpkg.com',
    'https://api.deadlock-api.com',
  ]));
});
```

- [ ] **Step 2: Run the contract test and witness RED**

Run:

```bash
yarn workspace @deadlock-live-probe/overwolf-client test player-surface-contract.spec.ts
```

Expected: FAIL on old metadata and missing artwork origins.

- [ ] **Step 3: Update only user-facing manifest metadata and required origins**

Set `meta.name` to `Dynamo Lab`, title/description to player-facing build guidance, preserve version/game IDs/permissions/hotkeys, and add `https://unpkg.com` plus `https://api.deadlock-api.com` to `externally_connectable.matches`. Keep desktop and overlay window names unchanged so lifecycle lookups continue to work.

- [ ] **Step 4: Run complete automated verification**

Run in order:

```bash
yarn workspace @deadlock-live-probe/overwolf-client test
yarn workspace @deadlock-live-probe/overwolf-client build
git diff --check
graphify update .
```

Expected: Jest exits 0, production webpack/release validation exits 0, diff check emits no errors, and Graphify reports an incremental update.

- [ ] **Step 5: Run Impeccable and Chromium visual verification**

Run the project Impeccable detector against both HTML files. Start a local static server from `apps/overwolf-client/public`, then capture:

- desktop at 600x600;
- desktop at 1440x900;
- overlay at 340x700.

Inject a deterministic five-item recommendation through the already-built `showAdaptiveRecommendation()` entry point before each capture. Inspect the browser console and confirm:

- no uncaught errors;
- exactly five aligned rows;
- official Deadlock artwork appears for Restorative Shot, Extra Spirit, Close Quarters, Melee Lifesteal, and Improved Spirit;
- fallback tile remains readable when the Deadlock UI script is blocked;
- current row is not taller than the future rows;
- desktop Refresh is inside the top bar;
- overlay prices are visually larger than category/action labels;
- overlay content fits 340 px without horizontal scrolling;
- keyboard focus is visible on Refresh and disabled destinations do not navigate.

- [ ] **Step 6: Review the final diff and commit release metadata**

```bash
git status --short
git diff --stat HEAD~4..HEAD
git diff -- apps/overwolf-client/public/manifest.json apps/overwolf-client/public/desktop.html apps/overwolf-client/public/in_game.html
git add apps/overwolf-client/public/manifest.json apps/overwolf-client/src/player-surface-contract.spec.ts apps/overwolf-client/public/desktop.html apps/overwolf-client/public/in_game.html graphify-out
git commit -m "chore(overwolf): finalize Dynamo Lab release surface"
```

Do not stage unrelated files from the original checkout. If Graphify produces no tracked change, omit `graphify-out` from `git add`.

---

## Final Review Gate

After Task 5, use `superpowers:requesting-code-review` and `agent-skills:code-review-and-quality`. Resolve correctness, accessibility, lifecycle, and scope findings; rerun the affected focused tests after each fix. Then use `superpowers:verification-before-completion` and report the exact branch, HEAD SHA, Jest suite/test counts, build result, browser viewport evidence, detector findings, and any verification that remains impossible outside a live Deadlock match.
