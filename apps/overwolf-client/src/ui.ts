import type { AdaptiveRecommendationResultV1 } from '@dynamo-lab/shared';
import type {
  AdaptivePurchaseRouteRow,
  AdaptiveRecommendationPresentation,
} from './adaptive-recommendation-presentation';
import {
  buildAdaptivePurchaseRoute,
  buildAdaptiveRecommendationPresentation,
} from './adaptive-recommendation-presentation';
import { PREFERENCE_KEYS, persistDismissed, readDismissed, readPreference } from './player-preferences';
import { APP_VERSION } from './app-version';
import {
  buildDiagnosticSummary,
  type DiagnosticSummaryInput,
} from './diagnostics/diagnostic-summary';

export function updateStatus(text: string, statusClass?: 'connected' | 'error' | 'init'): void {
  const el = document.getElementById('status');
  if (el) {
    el.textContent = text;
    el.className = statusClass || '';
  }
}

export function updateLastEvent(text: string): void {
  const el = document.getElementById('last-event');
  if (el) el.textContent = text;
}

let sendCount = 0;

export function incrementSends(): void {
  sendCount++;
  const el = document.getElementById('last-send');
  if (el) el.textContent = String(sendCount);
}

export function logConsole(message: string): void {
  const el = document.getElementById('console');
  if (el) {
    const timestamp = new Date().toLocaleTimeString();
    el.textContent = `[${timestamp}] ${message}\n` + (el.textContent || '');
  }
  console.log(message);
}

export function updateIndicator(text: string, active: boolean): void {
  const textEl = document.getElementById('indicator-text');
  const dotEl = document.getElementById('indicator-dot');
  if (textEl) textEl.textContent = text;
  if (dotEl) dotEl.classList.toggle('active', active);
}

const HOTKEY_HINT_KEY = 'hotkey-hint';

function setHidden(id: string, hidden: boolean): void {
  const el = document.getElementById(id) as (HTMLElement & { hidden: boolean }) | null;
  if (el) el.hidden = hidden;
}

/**
 * Hides the hotkey reminder and remembers the dismissal so it does not nag on
 * every launch. Overwolf's pre-submission checklist requires the reminder to be
 * reachable, not permanent.
 */
export function dismissHotkeyHint(): void {
  persistDismissed(HOTKEY_HINT_KEY);
  setHidden('hotkey-hint', true);
}

/** Applies remembered dismissals on startup. Call once per window. */
export function applyStoredPreferences(): void {
  if (readDismissed(HOTKEY_HINT_KEY)) {
    setHidden('hotkey-hint', true);
  }
  if (readDismissed(FIRST_RUN_KEY)) {
    setHidden('first-run', true);
  } else {
    showFirstRunGuide();
  }
  syncOverlayAutoShowPreference();
}

const FIRST_RUN_KEY = 'first-run-guide';
let firstRunStep = 1;

function renderFirstRunStep(): void {
  setHidden('first-run-step-1', firstRunStep !== 1);
  setHidden('first-run-step-2', firstRunStep !== 2);
}

/**
 * Opens the first-run guide, always starting on the opening screen. Overwolf
 * lists FTUE in its pre-submission checklist, so a new player must be told what
 * the app does before it silently starts sending match state.
 */
export function showFirstRunGuide(): void {
  firstRunStep = 1;
  renderFirstRunStep();
  setHidden('first-run', false);
}

/** Moves the guide from the opening screen to the closing screen. */
export function advanceFirstRunGuide(): void {
  firstRunStep = 2;
  renderFirstRunStep();
}

/** Closes the guide and remembers the dismissal so it appears only once. */
export function dismissFirstRunGuide(): void {
  persistDismissed(FIRST_RUN_KEY);
  setHidden('first-run', true);
}

let diagnosticContext: DiagnosticSummaryInput = {};
/** Records the current client state that the diagnostic summary reports. */
export function updateDiagnosticContext(patch: DiagnosticSummaryInput): void {
  diagnosticContext = { ...diagnosticContext, ...patch };
}

/**
 * Renders the player-safe diagnostic block and copies it to the clipboard.
 *
 * The block is also written into the page, so a player can still select it by
 * hand when the clipboard API is unavailable or blocked.
 */
export async function copyDiagnostics(): Promise<void> {
  const summary = buildDiagnosticSummary({
    appVersion: APP_VERSION,
    ...diagnosticContext,
  });

  const el = document.getElementById('diagnostic-summary');
  if (el) {
    el.textContent = summary;
  }

  try {
    await globalThis.navigator?.clipboard?.writeText(summary);
  } catch {
    // Clipboard unavailable — the rendered block is the fallback.
  }
}

/**
 * Shows the post-match usefulness prompt, always with the reason list collapsed
 * so the common case stays a single click.
 */
export function showPostMatchFeedback(): void {
  setHidden('post-match-feedback-reasons', true);
  setHidden('post-match-feedback', false);
}

export function hidePostMatchFeedback(): void {
  setHidden('post-match-feedback', true);
}

/** Reveals the "what went wrong" reasons after a negative vote. */
export function revealPostMatchReasons(): void {
  setHidden('post-match-feedback-reasons', false);
}

/** Closes the prompt without recording a vote. */
export function dismissPostMatchFeedback(): void {
  setHidden('post-match-feedback', true);
}

/**
 * Opens an external link in the player's real browser.
 *
 * A plain `<a href>` cannot be used: every window declares
 * `block_top_window_navigation`, so in-app navigation is blocked on purpose.
 * Overwolf's own helper is the supported route out.
 */
export function openExternal(url: string): void {
  try {
    const overwolf = (globalThis as { overwolf?: any }).overwolf;
    if (typeof overwolf?.utils?.openUrlInDefaultBrowser === 'function') {
      overwolf.utils.openUrlInDefaultBrowser(url);
      return;
    }

    (globalThis as { open?: (u: string, target?: string) => unknown }).open?.(
      url,
      '_blank',
    );
  } catch {
    // No browser handoff available; the URL is also visible in the panel text.
  }
}

let hasAdaptiveRecommendation = false;

export const RECOMMENDATIONS_DISABLED_BLOCKER = 'RECOMMENDATIONS_DISABLED';

const MAINTENANCE_FALLBACK_COPY =
  'Recommendations are paused while Dynamo Lab is updated for a game patch.';

function isRecommendationsDisabled(data: AdaptiveRecommendationResultV1): boolean {
  const blockers = (data as { blockers?: unknown })?.blockers;
  return Array.isArray(blockers) && blockers.includes(RECOMMENDATIONS_DISABLED_BLOCKER);
}

function maintenanceMessageOf(data: AdaptiveRecommendationResultV1): string {
  const degraded = (data as { degradedReasons?: unknown })?.degradedReasons;
  if (!Array.isArray(degraded)) {
    return MAINTENANCE_FALLBACK_COPY;
  }

  const message = degraded.find(
    (entry): entry is string =>
      typeof entry === 'string' &&
      entry.trim().length > 0 &&
      entry !== RECOMMENDATIONS_DISABLED_BLOCKER,
  );

  return message ?? MAINTENANCE_FALLBACK_COPY;
}

/**
 * Replaces the purchase route with the maintenance notice while the remote kill
 * switch is off. It deliberately renders no route at all, so a disabled backend
 * can only ever produce "nothing to show" — never a stale plan.
 */
export function showMaintenanceState(message: string): void {
  const emptyEl = document.getElementById('guide-empty');
  const activeEl = document.getElementById('guide-active');
  const panel = document.getElementById('situational-recommendation-panel');

  if (panel) panel.style.display = 'none';
  if (activeEl) activeEl.style.display = 'none';
  if (emptyEl) emptyEl.style.display = 'flex';

  for (const containerId of ['rec-plan', 'overlay-preview-plan']) {
    const container = document.getElementById(containerId);
    if (container) container.replaceChildren();
  }

  setText('guide-empty-title', 'Recommendations are paused');
  setText('guide-empty-copy', message);
  hasAdaptiveRecommendation = false;
  clearAdaptiveError();
}

export function showAdaptiveRecommendation(data: AdaptiveRecommendationResultV1): void {
  if (isRecommendationsDisabled(data)) {
    showMaintenanceState(maintenanceMessageOf(data));
    return;
  }

  const view = buildAdaptiveRecommendationPresentation(data);
  const emptyEl = document.getElementById('guide-empty');
  const activeEl = document.getElementById('guide-active');
  const panel = document.getElementById('situational-recommendation-panel');

  hasAdaptiveRecommendation = true;
  // Rendering a route is what makes it fresh. Recording it here rather than at
  // the call site means no caller can forget, and the age always describes what
  // is actually on screen.
  markRecommendationFresh();
  if (emptyEl) emptyEl.style.display = 'none';
  if (activeEl) activeEl.style.display = 'flex';
  if (panel) panel.style.display = 'flex';

  renderContainerRoute('rec-plan', view);
  renderContainerRoute('overlay-preview-plan', view);
  clearAdaptiveError();
}

export type RecommendationFreshness = 'FRESH' | 'STALE' | 'EXPIRED';

/**
 * Age thresholds for the route currently on screen.
 *
 * Measured from the last successful render, not from the failure. The client
 * already retries on its own (1.5s debounce, 3s retry delay), so "how long has
 * this been failing" is not the useful question — "how old is what the player
 * is looking at" is.
 */
export const STALE_AFTER_MS = 10_000;
export const EXPIRED_AFTER_MS = 30_000;

let lastRecommendationRenderAt = 0;

/** Records that a route was rendered. Rendering is what makes it fresh. */
export function markRecommendationFresh(at: number = Date.now()): void {
  lastRecommendationRenderAt = at;
}

/**
 * How much trust the route on screen still deserves.
 *
 * With nothing rendered yet the answer is `EXPIRED`, which is correct: there is
 * no route to keep. Callers must not read that as "a route went stale" — check
 * whether a route is displayed first.
 */
export function readRecommendationFreshness(now: number = Date.now()): RecommendationFreshness {
  const age = now - lastRecommendationRenderAt;
  if (age < STALE_AFTER_MS) {
    return 'FRESH';
  }

  return age < EXPIRED_AFTER_MS ? 'STALE' : 'EXPIRED';
}

/**
 * Whether a route is currently on screen.
 *
 * Only a displayed route can age out, so this is what a periodic re-evaluation
 * should key off. Re-running the empty state on a timer would overwrite the
 * Overwolf-degraded copy — the one with the actionable restart hint — with a
 * generic message.
 */
export function hasRecommendationOnScreen(): boolean {
  return hasAdaptiveRecommendation;
}

export function showAdaptiveError(message = 'Recommendation is updating'): void {
  const note = document.getElementById('rec-update-note');

  if (hasAdaptiveRecommendation) {
    const freshness = readRecommendationFreshness();

    if (freshness === 'EXPIRED') {
      // Past the expiry window a stale route is more dangerous than no route:
      // the player would spend gold against a build the match has moved past.
      hideSituationalPanel();
      return;
    }

    if (note) {
      note.textContent = freshness === 'STALE'
        ? 'Connection interrupted - this route may be outdated.'
        : 'Connection interrupted - showing the last safe recommendation.';
      note.style.display = 'flex';
      note.title = message;
    }
    return;
  }

  const emptyEl = document.getElementById('guide-empty');
  if (emptyEl) emptyEl.style.display = 'flex';
  setText('guide-empty-title', 'Dynamo Lab is reconnecting');
  setText('guide-empty-copy', 'The build route will appear when fresh match data is available.');
}

let gameEventsDegraded = false;

/**
 * Switches the waiting state between "nothing yet" and "Overwolf is not passing
 * game data".
 *
 * The two are indistinguishable from inside the app — both are simply an empty
 * snapshot — but they are very different for a player. A healthy Deadlock GEP
 * always reports `game_info.phase`; when it is missing while `steam_id` still
 * arrives, Overwolf's game plugin has failed to attach. Overwolf's own guidance
 * is to surface event failures rather than absorb them.
 */
export function setGameEventsDegraded(degraded: boolean): void {
  if (gameEventsDegraded === degraded) {
    return;
  }

  gameEventsDegraded = degraded;

  if (!hasAdaptiveRecommendation) {
    hideSituationalPanel();
  }
}

export function hideSituationalPanel(): void {
  const emptyEl = document.getElementById('guide-empty');
  const activeEl = document.getElementById('guide-active');
  const panel = document.getElementById('situational-recommendation-panel');

  if (panel) panel.style.display = 'none';
  if (activeEl) activeEl.style.display = 'none';
  if (emptyEl) emptyEl.style.display = 'flex';

  if (gameEventsDegraded) {
    setText('guide-empty-title', 'Overwolf is not passing game data');
    setText(
      'guide-empty-copy',
      'Deadlock is running but Overwolf is not sending its game events, so there is nothing to build from. '
      + 'Restart Overwolf, then reopen Dynamo Lab. If that does not help, reinstall Overwolf: '
      + 'its game plugin can fail to attach, and a repair is the only thing that re-fetches it.',
    );
  } else {
    setText('guide-empty-title', 'Waiting for match data');
    setText('guide-empty-copy', 'Your Dynamo Lab build route will appear automatically when the match is detected.');
  }

  hasAdaptiveRecommendation = false;
  clearAdaptiveError();
}

export function setRefreshPending(pending: boolean): void {
  const button = document.getElementById('refresh-build') as HTMLButtonElement | null;
  if (!button) return;
  button.disabled = pending;
  button.textContent = pending ? 'Refreshing' : 'Refresh';
  button.setAttribute('aria-busy', String(pending));
}

function renderContainerRoute(containerId: string, view: AdaptiveRecommendationPresentation): void {
  const container = document.getElementById(containerId);
  if (!container) return;
  const limit = resolveRouteLimit(container);
  const rows = buildAdaptivePurchaseRoute(view, limit);
  renderPurchaseRoute(rows, containerId);
}

function resolveRouteLimit(container: HTMLElement): number {
  const raw = (
    typeof container.getAttribute === 'function'
      ? container.getAttribute('data-route-limit')
      : (container as unknown as { attributes?: Map<string, string> }).attributes?.get?.('data-route-limit')
  )?.trim().toLowerCase();
  if (raw === 'all') {
    return Number.POSITIVE_INFINITY;
  }
  if (raw) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return 5;
}

function renderPurchaseRoute(rows: readonly AdaptivePurchaseRouteRow[], containerId: string): void {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.replaceChildren(...rows.map(createPurchaseRow));
}

function createPurchaseRow(planned: AdaptivePurchaseRouteRow): HTMLElement {
  const row = document.createElement('div');
  row.className = `purchase-row slot-${planned.item.slot}${planned.isCurrent ? ' is-current' : ''}`;
  row.setAttribute('data-plan-action-id', planned.planActionId);
  row.setAttribute('data-current', String(planned.isCurrent));

  const position = document.createElement('span');
  position.className = 'purchase-position';
  position.textContent = String(planned.position);

  const art = document.createElement('span');
  art.className = 'item-art';
  const fallback = document.createElement('span');
  fallback.className = 'item-art-fallback';
  fallback.textContent = itemGlyph(planned.item.slot);
  fallback.setAttribute('aria-hidden', 'true');
  const card = document.createElement('dl-item-card');
  card.setAttribute('item-id', String(planned.item.id));
  card.setAttribute('variant', 'icon');
  card.setAttribute('show-tier-badge', 'false');
  card.setAttribute('tooltip-trigger', 'none');
  card.setAttribute('aria-label', `${planned.item.name} item icon`);
  art.append(fallback, card);

  const copy = document.createElement('span');
  copy.className = 'purchase-copy';
  const name = document.createElement('strong');
  name.textContent = planned.item.name;
  const action = document.createElement('small');
  action.textContent = 'Buy now';
  copy.append(name, action);

  const price = document.createElement('strong');
  price.className = 'purchase-price';
  price.textContent = planned.item.costLabel?.replace(/\s*souls$/i, '') || '—';

  const category = document.createElement('span');
  category.className = 'purchase-category';
  category.textContent = planned.item.slot.toUpperCase();

  row.append(position, art, copy, price, category);
  return row;
}

function clearAdaptiveError(): void {
  const note = document.getElementById('rec-update-note');
  if (note) {
    note.textContent = '';
    note.style.display = 'none';
    note.removeAttribute('title');
  }
}

function setText(id: string, text: string): void {
  const element = document.getElementById(id);
  if (element) element.textContent = text;
}

function itemGlyph(slot: string): string {
  return { weapon: 'W', vitality: 'V', spirit: 'S' }[slot] || '•';
}

/* Desktop shell ------------------------------------------------------------
 * The desktop window is a two-page shell: the live build, and Settings. Both
 * pages stay in the DOM so the route keeps updating while the player reads
 * Settings — switching back must not re-fetch or re-render anything.
 */

export type Workspace = 'build' | 'settings';

const WORKSPACE_NAV: ReadonlyArray<readonly [Workspace, string]> = [
  ['build', 'nav-build'],
  ['settings', 'nav-settings'],
];

let activeWorkspace: Workspace = 'build';

/** The workspace currently on screen. */
export function readActiveWorkspace(): Workspace {
  return activeWorkspace;
}

/**
 * Switches the visible workspace and moves the navigation highlight with it.
 *
 * `aria-current` moves too: it is what tells a screen reader which page it is
 * on, so leaving it behind on the first button would announce the wrong page.
 */
export function showWorkspace(workspace: Workspace): void {
  activeWorkspace = workspace;
  setHidden('build-workspace', workspace !== 'build');
  setHidden('settings-workspace', workspace !== 'settings');

  for (const [name, id] of WORKSPACE_NAV) {
    const button = document.getElementById(id);
    if (!button) continue;

    const isCurrent = name === workspace;
    button.classList.toggle('is-active', isCurrent);
    if (isCurrent) {
      button.setAttribute('aria-current', 'page');
    } else {
      button.removeAttribute('aria-current');
    }
  }

  if (workspace === 'settings') {
    renderSettingsStatus();
    syncOverlayAutoShowPreference();
  }
}

const EMPTY_SETTINGS_VALUE = '—';

const SETTINGS_STATUS_FIELDS: ReadonlyArray<
  readonly [string, keyof DiagnosticSummaryInput]
> = [
  ['setting-app-version', 'appVersion'],
  ['setting-backend-status', 'backendStatus'],
  ['setting-gep-status', 'gepStatus'],
  ['setting-gep-version', 'gepVersion'],
  ['setting-gep-features', 'gepFeatures'],
  ['setting-gep-snapshot', 'gepSnapshot'],
  ['setting-recommendation-status', 'recommendationStatus'],
];

/**
 * How long ago the route on screen was rendered, or `null` if none ever was.
 *
 * Shown next to the route because a player looking at a plan that quietly
 * stopped updating has no other way to tell that the client has gone quiet.
 */
export function readRecommendationAgeMs(now: number = Date.now()): number | null {
  return lastRecommendationRenderAt === 0
    ? null
    : Math.max(0, now - lastRecommendationRenderAt);
}

/** Formats an age from {@link readRecommendationAgeMs} for the status group. */
export function formatRecommendationAge(ageMs: number | null): string {
  if (ageMs === null) {
    return EMPTY_SETTINGS_VALUE;
  }

  const seconds = Math.round(ageMs / 1000);
  if (seconds < 60) {
    return `${seconds}s ago`;
  }

  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m ago` : `${Math.floor(minutes / 60)}h ago`;
}

/**
 * Renders the Settings status group from the same accumulator the diagnostics
 * block reads, so the panel and the copied report can never disagree.
 *
 * Read-only by design: this is the screen a player opens when something looks
 * wrong, and it must not be able to change any of the state it reports.
 */
export function renderSettingsStatus(now: number = Date.now()): void {
  const values: DiagnosticSummaryInput = { appVersion: APP_VERSION, ...diagnosticContext };

  for (const [id, key] of SETTINGS_STATUS_FIELDS) {
    const value = values[key];
    setText(id, typeof value === 'string' && value.trim() ? value : EMPTY_SETTINGS_VALUE);
  }

  setText('setting-route-age', formatRecommendationAge(readRecommendationAgeMs(now)));
}

/**
 * Mirrors the stored overlay preference into the Settings checkbox.
 *
 * Re-read rather than assumed: the same key is written elsewhere and survives
 * across sessions, so the box has to describe what is actually stored rather
 * than what the last click happened to be.
 */
export function syncOverlayAutoShowPreference(): void {
  const checkbox = document.getElementById('setting-overlay-auto-show') as
    | (HTMLElement & { checked: boolean })
    | null;

  if (checkbox) {
    // The explicit type argument is load-bearing: with the literal `false`
    // fallback the return type narrows to `false`.
    checkbox.checked = readPreference<boolean>(PREFERENCE_KEYS.overlayAutoShow, false);
  }
}

export type HotkeyName = 'toggle_overlay' | 'show_desktop_build';

const HOTKEY_LABEL_TARGETS: ReadonlyArray<readonly [HotkeyName, string]> = [
  ['toggle_overlay', 'hint-hotkey-toggle'],
  ['show_desktop_build', 'hint-hotkey-desktop'],
];

/**
 * Writes the hotkeys Overwolf actually has bound into every place that names
 * them.
 *
 * The markup ships the manifest defaults, which stay correct only until a
 * player rebinds one. The reminder banner and the Settings row are filled from
 * the same call so the two cannot end up contradicting each other.
 */
export function renderHotkeyBindings(bindings: Partial<Record<HotkeyName, string>>): void {
  for (const [name, id] of HOTKEY_LABEL_TARGETS) {
    const binding = bindings[name];
    if (!binding) continue;

    setText(id, binding);
    if (name === 'toggle_overlay') {
      setText('setting-hotkey', binding);
    }
  }
}
