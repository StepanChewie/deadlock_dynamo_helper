# Overwolf Store Release Readiness Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Take Dynamo Lab from "code release-ready" to "submittable to the Overwolf Appstore": a compliant manifest with real store assets, window geometry that survives Overwolf's resolution matrix, a production domain instead of a DuckDNS host, pinned runtime dependencies, the compliance-required support channel and hotkey reminder, and the feedback loop that turns the per-match debugger into a product tool.

**Architecture:** Extend the existing manifest and release validator instead of adding new layers. Store metadata and asset constraints become assertions in `scripts/validate-release.js` so they cannot regress. Window geometry becomes named constants in `src/overlay-geometry.ts`, with the validator enforcing that every window fits inside Overwolf's smallest test screen (1366×720) — a lowered constant, not a display-derived runtime resolver (decision 5). New user-facing surfaces (FTUE, support, feedback) live in the existing `public/*.html` + `src/ui.ts` boundary with no new framework.

**Tech Stack:** TypeScript 5.9, Jest/ts-jest, plain HTML/CSS, webpack 5, Overwolf manifest v1, NestJS (API), PostgreSQL.

**Sources verified 2026-09-15:**

- `https://dev.overwolf.com/ow-native/getting-started/project-roadmap/` — whitelisting, public vs private apps, monetization gate
- `https://dev.overwolf.com/ow-native/getting-started/release-your-app` — pre-submission checklist, OPK packaging, store assets
- `https://dev.overwolf.com/ow-native/getting-started/submit-your-app` — `launcher_icon` / `window_icon` requirements
- `https://dev.overwolf.com/ow-native/reference/manifest/manifest-json/` — meta properties table, UID rule
- `https://dev.overwolf.com/ow-native/guides/game-compliance/overview` — overlay and ads behavior rules
- `https://dev.overwolf.com/ow-native/guides/test-your-app/how-to-test-your-app` — resolution matrix, UID stability, ad flags
- `https://dev.overwolf.com/ow-electron/guides/product-guidelines/onboarding/ftue/` — FTUE guidance
- `https://dev.overwolf.com/ow-electron/guides/product-guidelines/app-screen-behavior/in-game-overlays/` — in-game overlay types, hotkey reminders

## Global Constraints

- `meta.name` and `meta.author` generate the app UID. Overwolf states it "cannot be changed after publishing" and that both must be identical in every version. **Decide both before the first submission.**
- Do not rename existing windows (`desktop`, `in_game`, `dynamo_warning`); window lifecycle lookups depend on those keys.
- `Statlocker` must not appear in player-facing copy (`apps/overwolf-client/PRODUCT.md`).
- No new frontend framework and no new runtime state library.
- Every manifest change must keep `yarn workspace @deadlock-live-probe/overwolf-client build` green, including `validate-release.js`.
- Where a step requires artwork, an Overwolf account, or a domain registration, it is marked **MANUAL** and blocks the dependent task rather than being stubbed.

---

## Decisions taken 2026-09-15

These shape the plan below. Recorded so a later reader does not re-litigate them.

| # | Decision | Consequence |
|---|---|---|
| 1 | **No monetization at launch.** The reserved ad slot stays, but no ad or subscription integration is built now. | Task 9 keeps the placeholder only. See the risk note below — this is the single largest approval risk. |
| 2 | **No production domain yet.** Keep `aboba-telegramovich.duckdns.org` for development. | Task 5 is split: the "require an explicit origin" hardening happens now, the domain swap becomes a pre-submission gate rather than a Phase 0 prerequisite. |
| 3 | **No Discord yet.** | Task 9 is blocked. A communication channel is a compliance requirement, not a nice-to-have — see the alternative below. |
| 4 | **Geometry is the implementer's call.** | Task 3 adopts `desktop` 1100×680 (min 860×520) and `in_game` maximum height 620. |
| 5 | **Do not over-engineer the overlay height.** | Task 3 lowers the existing constant instead of adding a runtime display-derived resolver. |
| 6 | **Metrics, rate limiting and error reporting stay post-release.** | Phase 5 unchanged. |
| 7 | **Rename the product to Dynamo Lab everywhere.** | Task 2 covers user-facing naming; Task 2b covers workspace package names. |
| 8 | **Repo-local git identity is `StepanChewbacca`.** | Already applied (`.git/config`). The email is still the WSL global value. |

### Risk note on decision 1 (read before submitting)

Overwolf's own documentation is **self-contradictory** on whether an unmonetized app can be approved:

- The monetization step states flatly: *"Overwolf won't approve any app that doesn't integrate Overwolf ads or Overwolf subscriptions."*
- The pre-submission checklist states: *"Monetization — make sure you have designed your app to best utilize monetization strategies, **even if at first you are not planning to monetize your app**."*

The checklist wording implies a non-monetized launch is acceptable if the app is *designed* to accommodate monetization — which the reserved `#ow-ad-container` slot does. The step wording implies the opposite. **Resolve this in the proposal conversation with DevRel**, and record the answer here. Do not assume either reading.

### Alternative for decision 3

If running a Discord server is not wanted, Overwolf's requirement is a *communication channel*, not specifically Discord. An email address published on the store listing plus a GitHub Discussions or issues page satisfies "a communication channel with your audience" at much lower cost. Decide which, then Task 9 can proceed.

---

## Progress 2026-09-15

Everything below was implemented and verified green: 27 client suites / 139 tests, 99 API suites / 452 tests, and a full `yarn build`.

| Task | Commit | Note |
|---|---|---|
| Task 3 — window geometry | `c7650301` | Only Step 7 (manual display check) still open |
| Task 4 — ad window flags | `1fdb464d` | Flags asserted for every window, not just one |
| Task 6 — pin the UI dependency | `0529a2a1` | Pinned to `@deadlock-api/ui-core@1.5.0`. Self-hosting deferred — see below |
| Task 2 — product naming | `96f81557` | Runbook renamed to `docs/dynamo-lab-runbook.md`; link in `docs/architecture.md` updated |
| Task 7 — hotkey reminder | `6b70f352` | Dismissal persisted in `src/player-preferences.ts` |
| Task 8 — first-run guide | `37190352` | Two screens, skippable, shown once |
| Task 10 — diagnostic summary | `d3e2b457` | Allowlist-built summary; version injected by webpack `DefinePlugin` |
| Task 11 — post-match feedback | `9c386be8` | Includes a cross-package test that the client's reasons match the API allowlist |
| Task 12 — kill switch | `a2042ae4` | Env-driven, re-read per call; fail-closed with no route |
| Task 2b — package rename | `5a160a97` | 81 files, 94 specifiers. Data identifiers preserved — see below |
| Task 9 — support surface | `f92b27c3` | Discord invite + in-app privacy note + Copy diagnostics. Policy/terms links still open |
| — | — | Discord server `Dynamo Lab` created and structured (outside the repo); invite `https://discord.gg/yR4TNN2GDH` |

Also fixed: `apps/api/test/statlocker-only-serving-cutover.spec.ts` asserted the pre-rename product name and had been failing since `bc4a05eb`. Corrected in `0d501b66`.

### Deviations worth knowing

- **Task 6 — self-hosting deferred.** The plan prefers vendoring `@deadlock-api/ui-core` under `public/`. That package is a Stencil lazy-load bundle: `dist/index.js` is a 31-byte re-export and the real payload is 105 files / 1.4 MB. Vendoring is a repository-level decision, not a one-line change, so only the exact-version pin was applied. Revisit if a broad `unpkg.com` origin becomes a review problem.
- **Task 2b — two identifiers deliberately left alone.** `LEGACY_STORAGE_KEY = 'deadlock-live-probe-diagnostics-v1'` and `DATABASE_NAME = 'deadlock-live-probe-diagnostics'` in `src/diagnostics/diagnostic-capture.ts` are persisted data identifiers, not package names. Renaming them would orphan data already on players' machines. Only the `@deadlock-live-probe/` import prefix and the root package name were changed.
- **Task 8 — no `Join Discord` button.** Decision 3 means there is no invite yet, and a dead link would be worse than none. The second FTUE screen ends with `Start`; add the support link when Task 9 lands.
- **Task 11 — the API endpoint is not yet reachable by the client in production.** The client posts to `apiBaseUrl`, which is still the DuckDNS host (decision 2). This is covered by the Task 5 submission gate.

---

## Phase 0 — External gates

Not code, but the longest lead times. Start these before Phase 1 and run them in parallel.

- [ ] **Submit the app idea** via the Overwolf App proposal form (`https://dev.overwolf.com/app-idea-form`). It must be a **public** app — Overwolf does not approve private apps, and apps without an approved proposal are considered non-compliant and may not use Overwolf APIs.
- [ ] **Raise the monetization question in the proposal.** State that launch is unmonetized with an ad slot reserved, and ask DevRel to confirm whether that is approvable. Record the answer in the Decisions table above. See the risk note.
- [x] **Choose the communication channel.** Discord server, or the email + GitHub Discussions alternative. Required before submission by Task 9.
  **DONE 2026-09-16 — Discord.** Server `Dynamo Lab` (guild `1549527863483437187`), permanent invite `https://discord.gg/yR4TNN2GDH`, structure built and linked from the app in `f92b27c3`. Channels: `INFORMATION` (`#welcome`, `#how-to-use`, `#changelog`, read-only for `@everyone`), `SUPPORT` (`#support`, `#bug-reports`, `#recommendation-feedback`), `VOICE` (`General`). The invite is now the store listing's support URL.
- [ ] **Publish the privacy policy and terms.** They need a public URL; if there is no domain yet, a GitHub Pages or equivalent host is sufficient for submission. Required by Task 9.
  **Still open.** Neither document exists in the repo, and no URL has been chosen. Verified 2026-09-16 that `StepanChewie/deadlock_dynamo_helper` is a **public** repository, so a hosted page there is a working option today — GitHub Pages is not yet enabled (`has_pages: false`), so it would need turning on, or the docs can be linked as rendered GitHub blob URLs. Whichever is chosen, the links belong in the `#support` block next to `Join Discord`, and the same URLs go in the Developer Console listing. The in-app privacy note shipped in `f92b27c3` is a summary, not a replacement for these pages.
- [ ] **Verify Deadlock / Valve third-party compliance** separately. Overwolf defers to the game's EULA and ToS; an approved Overwolf app can still violate a game's terms.

Deferred out of Phase 0 by decision 2 — the production domain is no longer a prerequisite for development, only for the final OPK submission. It is now a gate in the Final Review Gate section instead.

---

## Phase 1 — Manifest, store assets and geometry

### Task 1: Store metadata and assets in the manifest

**Files:**
- Modify: `apps/overwolf-client/public/manifest.json`
- Modify: `apps/overwolf-client/scripts/validate-release.js`
- Create: `apps/overwolf-client/public/launcher_icon.ico`
- Create: `apps/overwolf-client/public/IconMouseNormal.png`
- Create: `apps/overwolf-client/public/IconMouseOver.png`
- Create: `apps/overwolf-client/public/WindowIcon.png`
- Create: `apps/overwolf-client/public/store_icon.png`

**Interfaces:**
- Consumes: the existing `meta` object and the `assert` / `assertPng` helpers in `validate-release.js`.
- Produces: a manifest that declares every store-required meta field, and validator assertions that fail the build when any of them regress.

- [ ] **Step 1: Write failing validator assertions**

Add to `validate-release.js`, after the existing required-meta loop:

```js
for (const field of ['dock_button_title', 'icon_gray', 'launcher_icon', 'window_icon', 'store_icon']) {
  assert(
    typeof manifest.meta?.[field] === 'string' && manifest.meta[field].trim().length > 0,
    `manifest.meta.${field} is required for Appstore submission.`,
  );
}

assert(
  (manifest.meta?.dock_button_title || '').length <= 18,
  'dock_button_title must be 18 characters or fewer.',
);
assert(
  (manifest.meta?.description || '').length <= 180,
  'description must be 180 characters or fewer.',
);
```

Add an asset-constraint block after the existing icon checks:

```js
for (const [field, expectedSize] of [
  ['icon', 256],
  ['icon_gray', 256],
  ['window_icon', 256],
  ['store_icon', 200],
]) {
  const assetPath = path.join(publicDir, manifest.meta?.[field] || '');
  assert(fs.existsSync(assetPath), `manifest.meta.${field} asset is missing.`);
  if (!fs.existsSync(assetPath)) continue;
  assertPng(assetPath, field);
  const buffer = fs.readFileSync(assetPath);
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  assert(
    width === expectedSize && height === expectedSize,
    `${field} must be ${expectedSize}x${expectedSize}, got ${width}x${height}.`,
  );
  if (field !== 'store_icon') {
    assert(buffer.length < 30 * 1024, `${field} must be smaller than 30KB.`);
  }
}

const launcherIconPath = path.join(publicDir, manifest.meta?.launcher_icon || '');
assert(fs.existsSync(launcherIconPath), 'manifest.meta.launcher_icon asset is missing.');
if (fs.existsSync(launcherIconPath)) {
  const buffer = fs.readFileSync(launcherIconPath);
  assert(buffer.length < 150 * 1024, 'launcher_icon must be smaller than 150KB.');
  assert(
    buffer.subarray(0, 4).toString('hex') === '00000100',
    'launcher_icon must be a real .ico file.',
  );
}
```

- [ ] **Step 2: Run the validator and witness RED**

Run:

```bash
yarn workspace @deadlock-live-probe/overwolf-client validate:release
```

Expected: FAIL listing `dock_button_title`, `icon_gray`, `launcher_icon`, `window_icon`, `store_icon` as required.

- [ ] **Step 3: MANUAL — produce the assets**

Two existing assets already violate the requirements and must be replaced, not just supplemented:

- `public/dynamo.png` is the current `meta.icon`. It is a real PNG but **447×447 and 236KB** — Overwolf requires 256×256 and under 30KB for `icon`.
- `public/icon.png` is **not a PNG at all** — its magic bytes are `ffd8ffe0`, i.e. a JPEG mislabelled with a `.png` extension, 578KB. It is unreferenced today, but it would ship inside the OPK. Replace it or delete it.

Exact Overwolf specifications:

| Asset | Format | Size | Limit |
|---|---|---|---|
| `IconMouseOver.png` (`icon`) | PNG, coloured | 256×256 | < 30KB |
| `IconMouseNormal.png` (`icon_gray`) | PNG, greyscale | 256×256 | < 30KB |
| `WindowIcon.png` (`window_icon`) | PNG, coloured | 256×256 | — |
| `store_icon.png` (`store_icon`) | PNG | 200×200 | — |
| `launcher_icon.ico` (`launcher_icon`) | multi-layer ICO from a 256×256 transparent PNG, layers 16/32/48/256 only | — | < 150KB |

`launcher_icon` should visually match the dock icon to avoid confusing users. Reuse the existing Dynamo artwork as the source; do not introduce new character art (`apps/overwolf-client/PRODUCT.md`).

- [ ] **Step 4: Add the meta fields**

In `manifest.json` `meta`, keeping `name`, `author`, `version` and the window keys untouched. Note `icon` is repointed from the non-compliant `dynamo.png` to the new asset:

```json
"icon": "IconMouseOver.png",
"icon_gray": "IconMouseNormal.png",
"launcher_icon": "launcher_icon.ico",
"window_icon": "WindowIcon.png",
"store_icon": "store_icon.png",
"dock_button_title": "Dynamo Lab"
```

Verified references:

- `public/dynamo.png` is used as the brand image by `public/desktop.html` (brand link) and `public/dynamo_warning.html` (popup image), and as `manifest.meta.icon`. **Keep the file for the UI**, but stop using it as `icon` — the brand image and the store icon have different requirements.
- `public/icon.png` has **zero references** in `public/` or `src/`. It is a mislabelled JPEG and should be deleted.

Delete the unreferenced file and leave the brand image in place:

```bash
git rm apps/overwolf-client/public/icon.png
```

- [ ] **Step 5: Run the validator and the full build**

```bash
yarn workspace @deadlock-live-probe/overwolf-client validate:release
yarn workspace @deadlock-live-probe/overwolf-client build
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/overwolf-client/public/manifest.json apps/overwolf-client/scripts/validate-release.js apps/overwolf-client/public/launcher_icon.ico apps/overwolf-client/public/IconMouseNormal.png apps/overwolf-client/public/IconMouseOver.png apps/overwolf-client/public/WindowIcon.png apps/overwolf-client/public/store_icon.png
git commit -m "feat(overwolf): add Appstore store metadata and assets"
```

---

### Task 2: Freeze the app identity and align product naming

**Files:**
- Modify: `apps/overwolf-client/public/manifest.json`
- Modify: `README.md`
- Modify: `apps/overwolf-client/PRODUCT.md`
- Modify: current docs under `docs/` (`architecture.md`, `database-migrations.md`, `overwolf-production-release.md`, `overwolf-deadlock-live-probe-runbook.md`)

- [x] **Step 1: Set `meta.author`** — DONE. `StepanChewbacca`, committed as `3264ee26`. Together with `meta.name = "Dynamo Lab"` this fixes the app UID, which cannot change after publishing.
- [x] **Step 2: Set the repo-local git identity** — DONE. `git config user.name "StepanChewbacca"` written to `.git/config`. The email is still the WSL global value (`oleksandrv@wizardsdev.com`); change it if the mismatch matters.

- [x] **Step 3: Align the product name in user-facing docs**

`README.md` still opens with `# Deadlock Live Probe`. Decision 7: rename to Dynamo Lab in the README and in current docs. **Do not** rewrite `docs/superpowers/plans/*.md` — those are historical records of what was true when they were written.

Watch out: `docs/overwolf-deadlock-live-probe-runbook.md` is a *filename*, not just a heading. If it is renamed, update the link from `README.md`.

- [x] **Step 4: Verify**

```bash
grep -rn "Deadlock Live Probe" README.md docs/architecture.md docs/overwolf-production-release.md || echo "ok: no stale product name in current docs"
```

- [x] **Step 5: Commit**

```bash
git add README.md apps/overwolf-client/PRODUCT.md docs/
git commit -m "docs: align product naming with Dynamo Lab"
```

---

### Task 2b: Rename the workspace packages

Decision 7. Internal only — the Overwolf Store sees `meta.name`, never package names. The cost is real: **366 occurrences across roughly 150 files**, including generated build output under `apps/api/dist/`.

Scope:

- `package.json` (root), `apps/api/package.json`, `apps/overwolf-client/package.json`, `packages/deadlock-build-domain/package.json`, `packages/shared/package.json` — the `name` field.
- `tsconfig.base.json` — path mappings.
- Import statements across `apps/**/*.ts` and `packages/**/*.ts`.
- **Do not** hand-edit `apps/api/dist/**` — it is build output, regenerate it.
- **Do not** touch `docs/superpowers/plans/*.md`.

- [x] **Step 1: Rename in source and manifests**

Mapping: `@deadlock-live-probe/api` → `@dynamo-lab/api`, `@deadlock-live-probe/overwolf-client` → `@dynamo-lab/overwolf-client`, `@deadlock-live-probe/shared` → `@dynamo-lab/shared`, `@deadlock-live-probe/deadlock-build-domain` → `@dynamo-lab/build-domain`.

- [x] **Step 2: Relink workspaces**

```bash
yarn install --ignore-engines
```

Without this the `node_modules` workspace symlinks still resolve the old names and every test fails.

- [x] **Step 3: Regenerate and verify**

```bash
yarn workspace @dynamo-lab/overwolf-client test
yarn workspace @dynamo-lab/api test
yarn build
```

Expected: all green. If this does not come back clean quickly, revert the rename — it buys nothing for the Store submission and is not worth delaying the release for.

- [x] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor: rename workspace packages to @dynamo-lab/*"
```

---

### Task 3: Window geometry for the 1366x720 test matrix

> **DONE 2026-09-15** — committed as `c7650301`. Steps 1–6 and 8 complete. Only Step 7 (manual check on a real 1366×720 display) is still open.

Overwolf's test procedure requires the app window to stay inside the screen borders at `1366x720 @100 DPI`, `1366x768 @100 DPI`, `1920x1080 @125 DPI` and `3840x2160 @150 DPI`. Two windows currently exceed a 720 px tall screen:

- `desktop`: declared `1100x760` → 40 px below the screen edge.
- `in_game`: `default_position.y = 80` plus a height that `ensureOverlayHeight()` clamps to a maximum of 700 → 780 px, 60 px below the screen edge.

Per decision 5 this is fixed by lowering the existing constants, not by adding a display-derived runtime resolver. The overlay becomes 80 + 620 = 700 ≤ 720; the desktop window becomes 1100x680.

**Files:**
- Create: `apps/overwolf-client/src/overlay-geometry.ts`
- Create: `apps/overwolf-client/src/overlay-geometry.spec.ts`
- Modify: `apps/overwolf-client/src/index.ts`
- Modify: `apps/overwolf-client/public/manifest.json`
- Modify: `apps/overwolf-client/scripts/validate-release.js`

**Interfaces:**
- Produces: `OVERLAY_MIN_HEIGHT`, `OVERLAY_TOP_OFFSET`, `OVERLAY_MAX_HEIGHT` exported from `src/overlay-geometry.ts` and consumed by `ensureOverlayHeight()`.

- [x] **Step 1: Write the failing geometry test**

```ts
import { OVERLAY_MAX_HEIGHT, OVERLAY_TOP_OFFSET } from './overlay-geometry';

const OVERWOLF_TEST_SCREEN_HEIGHT = 720;

it('keeps the overlay inside the smallest Overwolf test screen', () => {
  expect(OVERLAY_TOP_OFFSET + OVERLAY_MAX_HEIGHT).toBeLessThanOrEqual(OVERWOLF_TEST_SCREEN_HEIGHT);
});
```

- [x] **Step 2: Run the test and witness RED**

```bash
yarn workspace @deadlock-live-probe/overwolf-client test overlay-geometry.spec.ts
```

Expected: FAIL — module does not exist.

- [x] **Step 3: Add the constants and use them**

Create `src/overlay-geometry.ts`:

```ts
export const OVERLAY_MIN_HEIGHT = 190;
export const OVERLAY_TOP_OFFSET = 80;
export const OVERLAY_MAX_HEIGHT = 620;
```

In `src/index.ts`, delete the local `minimumHeight` / `maximumHeight` declarations inside `ensureOverlayHeight()` and import the two constants instead. The `changeSize(windowId, 340, targetHeight)` call and the clamp expression stay exactly as they are — no new logic.

- [x] **Step 4: Shrink the desktop window**

In `manifest.json`: `desktop.size` becomes `1100x680`, `desktop.min_size` becomes `860x520`. Also set `in_game.size.height` to `620` so the declared default matches the runtime maximum.

- [x] **Step 5: Add the validator assertions**

```js
const OVERWOLF_TEST_SCREEN_HEIGHT = 720;

const desktopSize = manifest.data?.windows?.desktop?.size;
assert(
  desktopSize?.height <= OVERWOLF_TEST_SCREEN_HEIGHT,
  `desktop window height ${desktopSize?.height} exceeds the ${OVERWOLF_TEST_SCREEN_HEIGHT}px Overwolf test screen.`,
);

const inGame = manifest.data?.windows?.in_game;
assert(
  (inGame?.default_position?.y || 0) + (inGame?.size?.height || 0) <= OVERWOLF_TEST_SCREEN_HEIGHT,
  'in_game offset plus declared height exceeds the 720px Overwolf test screen.',
);
```

- [x] **Step 6: Run the tests and the build**

```bash
yarn workspace @deadlock-live-probe/overwolf-client test
yarn workspace @deadlock-live-probe/overwolf-client build
```

Expected: PASS.

- [ ] **Step 7: MANUAL — verify on a real 1366x720 display**

Confirm the fifth purchase row is fully visible in the overlay and that the desktop window fits without clipping at 1366x720 and 1366x768.

- [x] **Step 8: Commit**

```bash
git add apps/overwolf-client/src/overlay-geometry.ts apps/overwolf-client/src/overlay-geometry.spec.ts apps/overwolf-client/src/index.ts apps/overwolf-client/public/manifest.json apps/overwolf-client/scripts/validate-release.js
git commit -m "fix(overwolf): fit windows inside the 1366x720 Overwolf test screen"
```

---

### Task 4: Ad window flags

**Files:**
- Modify: `apps/overwolf-client/public/manifest.json`
- Modify: `apps/overwolf-client/scripts/validate-release.js`

- [x] **Step 1: Add the assertions**

```js
for (const [windowName, windowConfig] of Object.entries(manifest.data?.windows || {})) {
  assert(
    windowConfig.block_top_window_navigation === true,
    `Window ${windowName} must set block_top_window_navigation: true.`,
  );
  assert(
    windowConfig.popup_blocker === true,
    `Window ${windowName} must set popup_blocker: true.`,
  );
  assert(windowConfig.mute === true, `Window ${windowName} must set mute: true.`);
}
```

- [x] **Step 2: Witness RED, then set the flags**

Run `yarn workspace @deadlock-live-probe/overwolf-client validate:release` and confirm the failure, then add `"block_top_window_navigation": true`, `"popup_blocker": true` and `"mute": true` to every window in `manifest.json`.

- [x] **Step 3: Verify and commit**

```bash
yarn workspace @deadlock-live-probe/overwolf-client build
git add apps/overwolf-client/public/manifest.json apps/overwolf-client/scripts/validate-release.js
git commit -m "chore(overwolf): declare advertising window flags"
```

---

## Phase 2 — Domain and supply chain

### Task 5: API origin — deferred to the submission gate

Decision 2: there is no production domain yet, so `https://aboba-telegramovich.duckdns.org` stays for development and sideloading. Nothing to implement now.

What matters is that the dev origin must never reach the Store. So this is recorded as a gate rather than a task:

- Before building the OPK, `OVERWOLF_API_BASE_URL` must be set to the production HTTPS origin, and `data.externally_connectable.matches` in the manifest must be updated to match it.
- The current `configure-api-base-url.js` falls back to the DuckDNS host when the variable is unset. That is fine while the host is intentional, but it means a release build can silently ship a dev origin. Do not rely on remembering — the gate check below is the safeguard.

- [ ] **Gate check — run before the OPK build**

```bash
grep -rn "duckdns" apps/overwolf-client/public/manifest.json apps/overwolf-client/src/index.ts \
  && echo "BLOCKED: dev origin still present" \
  || echo "ok: no dev origin"
```

---

### Task 6: Pin the Deadlock UI dependency

Both player surfaces load `https://unpkg.com/@deadlock-api/ui-core/dist/main/main.esm.js` — unpinned, no integrity check, on the critical path for item artwork.

**Files:**
- Modify: `apps/overwolf-client/public/desktop.html`
- Modify: `apps/overwolf-client/public/in_game.html`
- Modify: `apps/overwolf-client/src/player-surface-contract.spec.ts`

- [x] **Step 1: Add a failing contract assertion**

```ts
it('pins the Deadlock UI dependency to an exact version', () => {
  for (const surface of [desktop, overlay]) {
    const match = surface.match(/unpkg\.com\/@deadlock-api\/ui-core@([^/]+)\//);
    expect(match?.[1]).toMatch(/^\d+\.\d+\.\d+$/);
  }
});
```

- [x] **Step 2: Witness RED, then pin**

Replace both script tags with an exact version, for example `https://unpkg.com/@deadlock-api/ui-core@<resolved-version>/dist/main/main.esm.js`. Prefer self-hosting the bundle under `public/` if the package's licence permits it — that removes the third-party runtime dependency entirely.

- [x] **Step 3: Verify and commit**

```bash
yarn workspace @deadlock-live-probe/overwolf-client test player-surface-contract.spec.ts
git add apps/overwolf-client/public/desktop.html apps/overwolf-client/public/in_game.html apps/overwolf-client/src/player-surface-contract.spec.ts
git commit -m "fix(overwolf): pin the Deadlock UI dependency"
```

---

## Phase 3 — Compliance UX

### Task 7: Hotkey reminder

Overwolf's pre-submission checklist requires a hotkey reminder "accessible in the settings or game window", and the in-game overlay guidance repeats it. No reminder exists in any surface today.

**Files:**
- Modify: `apps/overwolf-client/public/desktop.html`
- Modify: `apps/overwolf-client/public/in_game.html`
- Modify: `apps/overwolf-client/src/player-surface-contract.spec.ts`

- [x] **Step 1: Add failing contract assertions**

```ts
it('exposes the registered hotkeys to the player', () => {
  expect(desktop).toContain('Ctrl+Tab');
  expect(overlay).toContain('Ctrl+Tab');
  expect(desktop).toContain('Ctrl+Shift+B');
});
```

- [x] **Step 2: Witness RED, then add the reminder**

Add a dismissible hint line to both surfaces naming the registered hotkeys, matching `manifest.data.hotkeys`: `Ctrl+Tab` toggles the overlay, `Ctrl+Shift+B` opens the desktop window. Keep it skippable and out of the way of the purchase route.

- [x] **Step 3: Verify and commit**

```bash
yarn workspace @deadlock-live-probe/overwolf-client test player-surface-contract.spec.ts
git add apps/overwolf-client/public/desktop.html apps/overwolf-client/public/in_game.html apps/overwolf-client/src/player-surface-contract.spec.ts
git commit -m "feat(overwolf): add the required hotkey reminder"
```

---

### Task 8: First-time user experience

Overwolf lists FTUE in the pre-submission checklist and in the product guidelines. Dynamo Lab currently drops a new user into an empty build workspace with no explanation.

**Files:**
- Modify: `apps/overwolf-client/public/desktop.html`
- Modify: `apps/overwolf-client/src/ui.ts`
- Modify: `apps/overwolf-client/src/ui.spec.ts`

**Interfaces:**
- Produces: `showFirstRunGuide(): void` and `dismissFirstRunGuide(): void`, persisting dismissal so the guide appears once.

- [x] **Step 1: Write failing tests**

```ts
it('shows the first-run guide only until it is dismissed', () => {
  showFirstRunGuide();
  expect(elements.get('first-run')?.hidden).toBe(false);
  dismissFirstRunGuide();
  expect(elements.get('first-run')?.hidden).toBe(true);
});
```

- [x] **Step 2: Witness RED, then implement**

Two screens maximum, skippable:

1. What Dynamo Lab does, and the four steps: launch Deadlock → enter a match → the app detects hero and inventory → `Ctrl+Tab` toggles the overlay.
2. What is sent to the server, that recommendations are built from the current match state, a `Join Discord` button, and `Start`.

Persist the dismissal so it never reappears.

- [x] **Step 3: Verify and commit**

```bash
yarn workspace @deadlock-live-probe/overwolf-client test ui.spec.ts
git add apps/overwolf-client/public/desktop.html apps/overwolf-client/src/ui.ts apps/overwolf-client/src/ui.spec.ts
git commit -m "feat(overwolf): add first-run guide"
```

---

### Task 9: Support surface

Overwolf's game compliance rules require that "the app should have a communication channel with your audience". The store listing also supports a dedicated support link. **MANUAL prerequisite:** the Discord invite and the privacy/terms pages (Phase 0).

**Files:**
- Modify: `apps/overwolf-client/public/desktop.html`
- Modify: `apps/overwolf-client/public/manifest.json` (if a support URL field is accepted by the schema)
- Modify: `apps/overwolf-client/src/player-surface-contract.spec.ts`

- [x] **Step 1: Add failing assertions**

```ts
it('links to the support channel', () => {
  expect(desktop).toMatch(/discord\.gg\//);
  expect(desktop).toMatch(/privacy/i);
});
```

- [x] **Step 2: Witness RED, then add the surfaces**

Add a support section to the desktop window with: `Join Discord`, a link to the privacy policy and terms, and a `Copy diagnostics` action (Task 10). Set the support URL in the Developer Console store listing to the same invite.

**DONE (`f92b27c3`) — except the two policy links.** The section now carries `Join Discord` (invite `https://discord.gg/yR4TNN2GDH`), `Copy diagnostics`, and an in-app privacy note stating exactly what leaves the machine: raw game events, match id and Steam ID to the recommendation API, plus feedback stored without any player identifier. The note is grounded in the real outbound calls, not boilerplate.

Two findings worth keeping:

- The link **cannot** be a plain `<a href>`. Every window sets `block_top_window_navigation: true` (Task 4), so in-app navigation is blocked by design. The button routes through `ui.openExternal()`, which prefers `overwolf.utils.openUrlInDefaultBrowser` and falls back to `window.open`.
- **A link to the privacy policy and terms is still missing**, because neither document exists yet and no public URL has been chosen. The in-app note satisfies the "privacy" assertion but is not a substitute for the two pages Phase 0 requires. Drafting and hosting them is tracked under Phase 0.

- [x] **Step 3: Verify and commit**

```bash
yarn workspace @deadlock-live-probe/overwolf-client test player-surface-contract.spec.ts
git add apps/overwolf-client/public/desktop.html apps/overwolf-client/src/player-surface-contract.spec.ts
git commit -m "feat(overwolf): add the support surface"
```

---

## Phase 4 — Feedback loop

### Task 10: Report a problem with a diagnostic summary

The product loop that makes the per-match debugger valuable: the player reports a bad recommendation, copies a diagnostic ID, and posts it to Discord. `src/diagnostics/diagnostic-capture.ts` already records raw evidence; what is missing is a bounded, player-safe summary.

**Files:**
- Create: `apps/overwolf-client/src/diagnostics/diagnostic-summary.ts`
- Create: `apps/overwolf-client/src/diagnostics/diagnostic-summary.spec.ts`
- Modify: `apps/overwolf-client/public/desktop.html`
- Modify: `apps/overwolf-client/src/ui.ts`

**Interfaces:**
- Produces: `buildDiagnosticSummary(input): string` — a compact key/value block.

- [x] **Step 1: Write failing tests**

```ts
it('summarises identity and status without raw telemetry', () => {
  const summary = buildDiagnosticSummary({
    appVersion: '0.1.15',
    backendStatus: 'READY',
    gepStatus: 'REGISTERED',
    matchId: 'match-1',
    heroId: '7',
    recommendationStatus: 'READY',
    archetype: 'weapon-spirit',
    rulesetVersion: '2026-09-14',
    catalogSha256: 'abc',
    lastRequestId: 'req-1',
    lastError: undefined,
  });

  expect(summary).toContain('App version: 0.1.15');
  expect(summary).toContain('Recommendation status: READY');
  expect(summary).not.toContain('rawPayload');
});
```

- [x] **Step 2: Witness RED, then implement**

Render only the summary fields — never the raw event payload — and wire a `Copy diagnostics` button plus a `Report a problem` entry that opens Discord. Optionally add `overwolf.io.createLogsZip` / `overwolf.utils.openFile` for an explicit `Upload logs` action, since Overwolf recommends in-app bug reporting with logs.

- [x] **Step 3: Verify and commit**

```bash
yarn workspace @deadlock-live-probe/overwolf-client test
git add apps/overwolf-client/src/diagnostics apps/overwolf-client/public/desktop.html apps/overwolf-client/src/ui.ts
git commit -m "feat(overwolf): add diagnostic summary and report flow"
```

---

### Task 11: Post-match feedback

**Files:**
- Modify: `apps/overwolf-client/public/desktop.html`
- Modify: `apps/overwolf-client/src/ui.ts`
- Modify: `apps/overwolf-client/src/ui.spec.ts`
- Create: `apps/api/src/statlocker-adaptive/adaptive-feedback-v1.controller.ts`
- Modify: `apps/api/src/statlocker-adaptive/statlocker-adaptive.module.ts`

**Interfaces:**
- Produces: `POST /deadlock/adaptive/v1/feedback` accepting `{ appVersion, matchId, useful, reason?, requestId? }`, and a `useful: boolean` prompt rendered after a match ends.

- [x] **Step 1: Write the failing client test**

```ts
it('renders the post-match usefulness prompt', () => {
  showPostMatchFeedback();
  expect(elements.get('post-match-feedback')?.hidden).toBe(false);
});
```

- [x] **Step 2: Witness RED, then implement the prompt and endpoint**

Prompt: `Were today's build recommendations useful?` with `Yes` / `No`, and on `No` the reasons `Bad item recommendation`, `Bad order`, `Recommendation changed too much`, `Recommendation was too late`, `App didn't detect my state correctly`, `Other`.

Persist the votes as a **product signal only**. Decision 007 (`docs/decisions/007-no-self-training-on-own-match-data.md`) forbids using own match data for policy learning; keep feedback out of the recommendation pipeline.

- [x] **Step 3: Verify and commit**

```bash
yarn workspace @deadlock-live-probe/overwolf-client test
yarn workspace @deadlock-live-probe/api test
git add apps/overwolf-client/src/ui.ts apps/overwolf-client/src/ui.spec.ts apps/overwolf-client/public/desktop.html apps/api/src/statlocker-adaptive
git commit -m "feat: add post-match recommendation feedback"
```

---

### Task 12: Remote kill switch and minimum client version

Deadlock patches break item data without warning. The API is already authoritative and fail-closed, so this belongs in the existing status path.

**Files:**
- Modify: `apps/api/src/statlocker-adaptive/adaptive-status-compatibility-v1.controller.ts`
- Modify: `apps/api/src/statlocker-adaptive/adaptive-recommendation-v2.controller.ts`
- Modify: `apps/overwolf-client/src/adaptive-recommendation-client.ts`
- Modify: `apps/overwolf-client/src/ui.ts`

**Interfaces:**
- Produces: status fields `recommendationsEnabled: boolean`, `maintenanceMessage?: string`, `minimumClientVersion?: string`, `disabledHeroIds?: readonly string[]`, `disabledRulesetIds?: readonly string[]`, `disabledCatalogSha?: readonly string[]`; and a client-side maintenance state that replaces the purchase route with `maintenanceMessage`.

- [x] **Step 1: Write the failing API test**

```ts
it('reports a disabled recommendation state with a maintenance message', async () => {
  const status = await controller.status();
  expect(status).toHaveProperty('recommendationsEnabled');
});
```

- [x] **Step 2: Witness RED, then implement**

Source the flags from configuration (environment or a small persisted row) so they can be flipped without a deploy. When `recommendationsEnabled` is false, the client shows the maintenance message instead of a route, and never a fabricated recommendation.

- [x] **Step 3: Verify and commit**

```bash
yarn workspace @deadlock-live-probe/api test
yarn workspace @deadlock-live-probe/overwolf-client test
git add apps/api/src/statlocker-adaptive apps/overwolf-client/src
git commit -m "feat: add remote recommendation kill switch"
```

---

## Phase 5 — Post-release

Do these immediately after the first users arrive, not before. They are recorded here so they are not lost.

### Task 13: Product metrics

`adaptive-recommendation-observability-v1.service.ts` currently exposes only in-process WPA counters. Add the product-level series: active installs per day, matches detected, recommendation requests, `READY` ratio, not-ready ratio, average and p95 recommendation latency, GEP registration failures, backend 4xx/5xx, Statlocker stale rate, catalog/ruleset mismatch count, client versions, and the top blocker reason. The headline number is **recommendation-ready matches divided by detected matches**.

### Task 14: Backend hardening

`apps/api/src/main.ts` currently calls `app.enableCors()` with no origin restriction and accepts 10 MB JSON bodies, and there is no throttling layer. Add rate limiting with separate budgets for event ingest and recommendation, batch size and count caps, sane request timeouts, structured request IDs, per-endpoint metrics, and tighter CORS where the Overwolf origin model permits it.

### Task 15: Centralized error reporting

There is no Sentry-equivalent integration. Add one so that a single failing client version surfaces before users report it in Discord.

---

## Final Review Gate

Before submitting the OPK:

- [ ] **Production domain in place.** `OVERWOLF_API_BASE_URL` set to the production HTTPS origin, `data.externally_connectable.matches` updated to match it, and the Task 5 gate check reporting `ok: no dev origin`.
- [ ] **Monetization question answered by DevRel** and the answer recorded in the Decisions table. Do not submit until this is resolved — see the risk note.
- [ ] **Communication channel live** (Discord, or the email + GitHub Discussions alternative) and linked from the store listing.
- [ ] `yarn workspace @dynamo-lab/overwolf-client build` exits 0.
- [ ] The manifest validates against the official Overwolf schema (`https://dev.overwolf.com/ow-native/reference/manifest/manifest-json/`).
- [ ] `meta.name` and `meta.author` are final and will not change after publishing.
- [ ] Manual test pass at 1366x720, 1366x768, 1920x1080 @125 DPI and 3840x2160 @150 DPI, including the alt-tab check (no app window on the desktop while the game is unfocused).
- [ ] The overlay is user-controlled and dismissible, and never displays a persistent overlay during active gameplay.
- [ ] OPK built as a ZIP at **normal** compression renamed to `.opk`, with `manifest.json` at the package root.
- [ ] Store assets, support link and screenshots uploaded to the Developer Console.
- [ ] Privacy policy and terms live and linked from both the app and the store listing.

## Out of scope

- **Monetization (decision 1).** The reserved `#ow-ad-container` stays a placeholder; no ad or subscription integration is built. Caveat: Overwolf's own docs contradict each other on whether an unmonetized app can be approved, so the DevRel answer may pull this back into scope. This is the plan's largest open risk.
- Any new recommender work, personalization, accounts, social features or paid tiers. The first real users should decide the next large feature.
