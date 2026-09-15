import type { AdaptiveRecommendationResultV1 } from '@deadlock-live-probe/shared';
import type {
  AdaptivePurchaseRouteRow,
  AdaptiveRecommendationPresentation,
} from './adaptive-recommendation-presentation';
import {
  buildAdaptivePurchaseRoute,
  buildAdaptiveRecommendationPresentation,
} from './adaptive-recommendation-presentation';
import { persistDismissed, readDismissed } from './player-preferences';

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
}

let hasAdaptiveRecommendation = false;

export function showAdaptiveRecommendation(data: AdaptiveRecommendationResultV1): void {
  const view = buildAdaptiveRecommendationPresentation(data);
  const emptyEl = document.getElementById('guide-empty');
  const activeEl = document.getElementById('guide-active');
  const panel = document.getElementById('situational-recommendation-panel');

  hasAdaptiveRecommendation = true;
  if (emptyEl) emptyEl.style.display = 'none';
  if (activeEl) activeEl.style.display = 'flex';
  if (panel) panel.style.display = 'flex';

  renderContainerRoute('rec-plan', view);
  renderContainerRoute('overlay-preview-plan', view);
  clearAdaptiveError();
}

export function showAdaptiveError(message = 'Recommendation is updating'): void {
  const note = document.getElementById('rec-update-note');
  if (hasAdaptiveRecommendation) {
    if (note) {
      note.textContent = 'Connection interrupted - showing the last safe recommendation.';
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

export function hideSituationalPanel(): void {
  const emptyEl = document.getElementById('guide-empty');
  const activeEl = document.getElementById('guide-active');
  const panel = document.getElementById('situational-recommendation-panel');

  if (panel) panel.style.display = 'none';
  if (activeEl) activeEl.style.display = 'none';
  if (emptyEl) emptyEl.style.display = 'flex';
  setText('guide-empty-title', 'Waiting for match data');
  setText('guide-empty-copy', 'Your Dynamo Lab build route will appear automatically when the match is detected.');
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
