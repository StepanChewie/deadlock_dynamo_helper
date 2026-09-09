import type { AdaptiveRecommendationResultV1 } from '@deadlock-live-probe/shared';
import type {
  AdaptivePresentedAlternative,
  AdaptivePresentedPlanItem,
} from './adaptive-recommendation-presentation';
import { buildAdaptiveRecommendationPresentation } from './adaptive-recommendation-presentation';
import {
  AdaptiveDecisionDebugPresentation,
  AdaptiveDecisionDebugReplacement,
  AdaptiveDecisionDebugRow,
  buildAdaptiveDecisionDebugPresentation,
} from './adaptive-decision-debug-presentation';

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

let hasAdaptiveRecommendation = false;

export function showAdaptiveRecommendation(data: AdaptiveRecommendationResultV1): void {
  const view = buildAdaptiveRecommendationPresentation(data);
  const emptyEl = document.getElementById('guide-empty');
  const activeEl = document.getElementById('guide-active');
  const panel = document.getElementById('situational-recommendation-panel');
  const nameEl = document.getElementById('rec-item-name');
  const headlineEl = document.getElementById('rec-headline');

  if (!panel || !nameEl || !headlineEl) return;

  hasAdaptiveRecommendation = true;
  if (emptyEl) emptyEl.style.display = 'none';
  if (activeEl) activeEl.style.display = 'flex';
  panel.style.display = 'flex';

  setText('rec-source', view.sourceLabel);
  setText('rec-game-state', view.stateLabel);
  setText('rec-health', view.healthLabel);
  setText('rec-action-label', view.actionLabel);
  setText('rec-confidence-label', view.confidence.label);
  setText('rec-evidence', view.evidenceLabel);
  headlineEl.textContent = view.headline;
  nameEl.textContent = view.primaryItem?.name || 'Adaptive plan';
  setText(
    'rec-item-meta',
    [
      view.primaryItem?.tierLabel,
      view.primaryItem?.costLabel,
      view.replacedItem
        ? `Sell ${view.replacedItem.known ? view.replacedItem.name : view.replacedItem.diagnosticLabel}`
        : undefined,
      view.situationalPurposeLabel ? `Situational - ${view.situationalPurposeLabel}` : undefined,
      view.againstLabel,
      ...view.primaryRequirements,
      view.primaryItem?.diagnosticLabel,
    ].filter(Boolean).join(' · '),
  );
  setText('rec-item-glyph', itemGlyph(view.primaryItem?.slot));

  panel.setAttribute('data-slot', view.primaryItem?.slot || 'unknown');
  setTone('rec-health', `health-${view.healthTone}`);
  setTone('rec-game-state', `state-${view.stateTone}`);

  const confidenceFill = document.getElementById('rec-confidence-fill');
  if (confidenceFill) confidenceFill.style.width = `${view.confidence.value}%`;

  const planItems = isInGameOverlay()
    ? view.plan.items.filter((item) => item.status !== 'OWNED' && item.status !== 'COMPLETED')
    : view.plan.items;

  renderReasons(view.reasons);
  renderPlan(planItems, view.plan.remainingCount);
  renderAlternatives(view.alternatives);
  renderDecisionDebug(buildAdaptiveDecisionDebugPresentation(data));
  clearAdaptiveError();
}

export function showAdaptiveError(message = 'Recommendation is updating'): void {
  const note = document.getElementById('rec-update-note');
  if (hasAdaptiveRecommendation) {
    setText('rec-health', 'Updating');
    setTone('rec-health', 'health-waiting');
    if (note) {
      note.textContent = 'Connection interrupted - showing the last safe recommendation.';
      note.style.display = 'flex';
      note.title = message;
    }
    return;
  }

  const emptyEl = document.getElementById('guide-empty');
  if (emptyEl) emptyEl.style.display = 'flex';
  setText('guide-empty-title', 'Statlocker is reconnecting');
  setText('guide-empty-copy', 'The recommendation will appear here as soon as fresh data arrives.');
}

export function hideSituationalPanel(): void {
  const emptyEl = document.getElementById('guide-empty');
  const activeEl = document.getElementById('guide-active');
  const panel = document.getElementById('situational-recommendation-panel');

  if (panel) panel.style.display = 'none';
  if (activeEl) activeEl.style.display = 'none';
  if (emptyEl) emptyEl.style.display = 'flex';
  setText('guide-empty-title', 'Waiting for match data');
  setText('guide-empty-copy', 'Your Statlocker recommendation will appear automatically when the match is detected.');
  hasAdaptiveRecommendation = false;
  renderDecisionDebug({ visible: false, sections: [], replacements: [] });
  clearAdaptiveError();
}

function renderReasons(reasons: readonly string[]): void {
  const container = document.getElementById('rec-reasons');
  if (!container) return;
  container.replaceChildren();
  const visibleReasons = reasons.length > 0
    ? reasons
    : ['Following the strongest available Statlocker plan'];
  visibleReasons.forEach((reason) => {
    const item = document.createElement('li');
    item.textContent = reason;
    container.appendChild(item);
  });
}

function renderPlan(
  items: readonly AdaptivePresentedPlanItem[],
  remainingCount: number,
): void {
  const container = document.getElementById('rec-plan');
  if (!container) return;
  container.replaceChildren();

  if (items.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-row';
    empty.textContent = 'Plan is being assembled';
    container.appendChild(empty);
  } else {
    items.forEach((planned) => container.appendChild(createPlanItem(planned)));
  }

  setText('rec-plan-more', remainingCount > 0 ? `+${remainingCount} later` : '');
}

function createPlanItem(planned: AdaptivePresentedPlanItem): HTMLElement {
  const row = document.createElement('div');
  row.className = `plan-item slot-${planned.item.slot} status-${planned.status.toLowerCase()}`;
  row.setAttribute('data-plan-action-id', planned.planActionId);

  const position = document.createElement('span');
  position.className = 'plan-position';
  position.textContent = String(planned.position).padStart(2, '0');

  const details = document.createElement('span');
  details.className = 'plan-details';
  const name = document.createElement('strong');
  name.textContent = planned.item.name;
  const meta = document.createElement('small');
  meta.textContent = [
    planned.statusLabel,
    planned.actionLabel,
    planned.situationalPurposeLabel ? `Situational - ${planned.situationalPurposeLabel}` : undefined,
    planned.againstLabel,
    ...planned.requirements,
  ].filter(Boolean).join(' · ');
  details.append(name, meta);

  row.append(position, details);
  return row;
}

function renderAlternatives(alternatives: readonly AdaptivePresentedAlternative[]): void {
  const container = document.getElementById('rec-alternatives');
  const section = document.getElementById('rec-alternatives-section');
  if (!container || !section) return;
  container.replaceChildren();
  section.style.display = alternatives.length > 0 ? 'block' : 'none';
  alternatives.forEach((alternative) => {
    const row = document.createElement('div');
    row.className = `alternative-row slot-${alternative.item?.slot || 'unknown'}`;

    const name = document.createElement('span');
    name.textContent = alternative.headline;
    const score = document.createElement('small');
    score.textContent = alternative.scoreLabel;
    row.append(name, score);
    container.appendChild(row);
  });
}

function renderDecisionDebug(view: AdaptiveDecisionDebugPresentation): void {
  const root = document.getElementById('decision-debug');
  if (!root) return;
  root.replaceChildren();
  root.style.display = view.visible ? 'block' : 'none';
  if (!view.visible) return;

  const heading = document.createElement('div');
  heading.className = 'debug-heading';
  heading.textContent = 'Decision trace';
  root.appendChild(heading);

  const grid = document.createElement('div');
  grid.className = 'debug-grid';
  for (const section of view.sections) {
    const card = document.createElement('section');
    card.className = 'debug-section';
    const title = document.createElement('h3');
    title.textContent = section.title;
    card.appendChild(title);
    if (section.rows.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'debug-empty';
      empty.textContent = 'Нет значимых кандидатов';
      card.appendChild(empty);
    } else {
      section.rows.forEach((row) => card.appendChild(createDebugRow(row)));
    }
    grid.appendChild(card);
  }
  root.appendChild(grid);

  if (view.replacements.length > 0) {
    const replacementDetails = document.createElement('details');
    replacementDetails.className = 'debug-details';
    const summary = document.createElement('summary');
    summary.textContent = 'Replacement math';
    replacementDetails.appendChild(summary);
    view.replacements.forEach((replacement) => replacementDetails.appendChild(createReplacementTrace(replacement)));
    root.appendChild(replacementDetails);
  }

  if (view.policy) {
    const details = document.createElement('details');
    details.className = 'debug-details';
    const summary = document.createElement('summary');
    summary.textContent = `Policy ${view.policy.version}`;
    details.appendChild(summary);
    const values: readonly [string, string][] = [
      ['Capacity', String(view.policy.heldItemCapacity)],
      ['Threat weights', JSON.stringify(view.policy.threatWeights)],
      ['Threat clamp', `${view.policy.threatClamp.min}..${view.policy.threatClamp.max}`],
      ['Shrink K', JSON.stringify(view.policy.shrinkK)],
      ['Plan switch', String(view.policy.planSwitchThreshold)],
      ['Sell+buy', String(view.policy.sellBuyThreshold)],
      ['Soft core replace', String(view.policy.softCoreReplaceThreshold)],
      ['Wildcard replace', String(view.policy.wildcardReplaceThreshold)],
      ['Matchup confidence', String(view.policy.matchupConfidenceThreshold)],
      ['Purchase protection ms', String(view.policy.recentPurchaseProtectionMs)],
      ['Sold rebuy penalty ms', String(view.policy.soldItemRebuyPenaltyMs)],
    ];
    values.forEach(([label, value]) => details.appendChild(createDebugKeyValue(label, value)));
    root.appendChild(details);
  }
}

function createDebugRow(row: AdaptiveDecisionDebugRow): HTMLElement {
  const wrapper = document.createElement('details');
  wrapper.className = `debug-row${row.selected ? ' selected' : ''}`;
  const summary = document.createElement('summary');
  summary.textContent = [row.headline, row.source, row.reason].filter(Boolean).join(' · ');
  wrapper.appendChild(summary);
  if (row.score !== undefined) wrapper.appendChild(createDebugKeyValue('Score', String(row.score)));
  if (row.confidence !== undefined) wrapper.appendChild(createDebugKeyValue('Confidence', String(row.confidence)));
  row.details.forEach((detail) => wrapper.appendChild(createDebugKeyValue(detail.label, detail.value)));
  return wrapper;
}

function createReplacementTrace(replacement: AdaptiveDecisionDebugReplacement): HTMLElement {
  const card = document.createElement('div');
  card.className = `debug-replacement verdict-${replacement.verdict.toLowerCase()}`;
  const title = document.createElement('strong');
  title.textContent = `${replacement.verdict} · ${replacement.headline}`;
  card.appendChild(title);
  const values: readonly [string, string | number][] = [
    ['inventory', replacement.inventory],
    ['utilityBefore', replacement.utilityBefore],
    ['utilityAfter', replacement.utilityAfter],
    ['rawImprovement', replacement.rawImprovement],
    ['matchupGain', replacement.matchupGain],
    ['skeletonDelta', replacement.skeletonDelta],
    ['synergyDelta', replacement.synergyDelta],
    ['timingDelta', replacement.timingDelta],
    ['economicLoss', replacement.economicLoss],
    ['transactionPenalty', replacement.transactionPenalty],
    ['churnPenalty', replacement.churnPenalty],
    ['netImprovement', replacement.netImprovement],
    ['requiredThreshold', replacement.requiredThreshold],
    ['reasonCodes', replacement.reasonCodes.join(', ')],
  ];
  values.forEach(([label, value]) => card.appendChild(createDebugKeyValue(label, String(value))));
  return card;
}

function createDebugKeyValue(label: string, value: string): HTMLElement {
  const row = document.createElement('div');
  row.className = 'debug-kv';
  const key = document.createElement('span');
  key.textContent = label;
  const val = document.createElement('code');
  val.textContent = value;
  row.append(key, val);
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

function isInGameOverlay(): boolean {
  return document.querySelector('.hud-container') !== null;
}

function setText(id: string, text: string): void {
  const element = document.getElementById(id);
  if (element) element.textContent = text;
}

function setTone(id: string, tone: string): void {
  const element = document.getElementById(id);
  if (element) element.className = tone;
}

function itemGlyph(slot: string | undefined): string {
  return { weapon: 'W', vitality: 'V', spirit: 'S' }[slot || ''] || '•';
}
