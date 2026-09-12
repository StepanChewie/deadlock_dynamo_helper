export const BUILD_DEBUG_V2_ENHANCEMENT_HEAD = `
  <style>
    .debug-item-icons { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-right: 6px; vertical-align: middle; }
    .debug-item-ref { display: inline-flex; align-items: center; gap: 5px; border: 1px solid #343d37; background: #0d110e; padding: 2px 5px 2px 2px; }
    .debug-item-icon { --dl-item-icon-size: 34px; display: inline-block; flex: none; vertical-align: middle; }
    .debug-item-name { color: var(--text); font: 9px ui-monospace, SFMono-Regular, Menlo, monospace; white-space: nowrap; }
    .debug-family-profiles { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 9px; padding-top: 8px; border-top: 1px solid rgba(42, 51, 45, .65); }
    .debug-family-profiles::before { content: 'source players'; width: 100%; color: var(--muted); font-size: 9px; text-transform: uppercase; letter-spacing: .05em; }
    .debug-family-profile { border: 1px solid #343d37; background: #0d110e; color: var(--accent); padding: 3px 5px; font: 9px ui-monospace, SFMono-Regular, Menlo, monospace; overflow-wrap: anywhere; }
  </style>
  <script type="module" src="https://unpkg.com/@deadlock-api/ui-core/dist/main/main.esm.js"></script>
`;

export const BUILD_DEBUG_V2_ENHANCEMENT_CLIENT_JS = String.raw`(() => {
  'use strict';

  const ITEM_ASSETS_URL = 'https://api.deadlock-api.com/v1/assets/items';
  const itemNames = new Map();
  let latestTrace;
  let scheduled = false;

  captureFetchTraces();
  captureEventSourceTraces();
  loadItemNames();

  const observer = new MutationObserver(scheduleEnhancement);
  const traceStages = document.getElementById('traceStages');
  const fullBuildPanel = document.getElementById('fullBuildPanel');
  if (traceStages) observer.observe(traceStages, { childList: true, subtree: true });
  if (fullBuildPanel) observer.observe(fullBuildPanel, { childList: true, subtree: true });

  async function loadItemNames() {
    try {
      const response = await window.fetch(ITEM_ASSETS_URL);
      if (!response.ok) return;
      const items = await response.json();
      if (!Array.isArray(items)) return;
      for (const item of items) {
        const itemId = Number(item.id ?? item.item_id ?? item.itemId);
        const name = typeof item.name === 'string' ? item.name.trim() : '';
        if (Number.isSafeInteger(itemId) && itemId > 0 && name) itemNames.set(itemId, name);
      }
      refreshItemNames();
    } catch (_error) {
      // Numeric fallback and item-card tooltips remain available when the public API is unreachable.
    }
  }

  function captureFetchTraces() {
    const nativeFetch = window.fetch.bind(window);
    window.fetch = async (...args) => {
      const response = await nativeFetch(...args);
      const url = typeof args[0] === 'string' ? args[0] : args[0]?.url;
      if (response.ok && typeof url === 'string' && /\/debug\/build-v2\/matches\/[^/]+$/.test(url)) {
        response.clone().json().then(captureTrace).catch(() => undefined);
      }
      return response;
    };
  }

  function captureEventSourceTraces() {
    const NativeEventSource = window.EventSource;
    if (!NativeEventSource) return;
    function DebugEventSource(url, eventSourceInitDict) {
      const source = new NativeEventSource(url, eventSourceInitDict);
      source.addEventListener('trace', (event) => {
        try {
          captureTrace(JSON.parse(event.data));
        } catch (_error) {
          // The base debugger owns invalid SSE payload reporting.
        }
      });
      return source;
    }
    DebugEventSource.prototype = NativeEventSource.prototype;
    Object.defineProperty(DebugEventSource, 'CONNECTING', { value: NativeEventSource.CONNECTING });
    Object.defineProperty(DebugEventSource, 'OPEN', { value: NativeEventSource.OPEN });
    Object.defineProperty(DebugEventSource, 'CLOSED', { value: NativeEventSource.CLOSED });
    window.EventSource = DebugEventSource;
  }

  function captureTrace(trace) {
    if (!trace || !Array.isArray(trace.stages)) return;
    latestTrace = trace;
    scheduleEnhancement();
  }

  function scheduleEnhancement() {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      enhanceItemReferences();
      enhanceFamilyProfiles();
      refreshItemNames();
    });
  }

  function enhanceItemReferences() {
    for (const row of document.querySelectorAll('.kv > div')) {
      const label = row.querySelector('dt')?.textContent?.trim().toLowerCase() || '';
      const value = row.querySelector('dd');
      if (!value) continue;
      if (label === 'item' || label.includes('terminal')) {
        addItemIcons(value, positiveIntegers(originalText(value)).slice(0, 1));
      } else if (label.includes('items')) {
        addItemIcons(value, positiveIntegers(originalText(value)));
      }
    }

    for (const metric of document.querySelectorAll('.metric')) {
      const label = metric.querySelector('span')?.textContent?.trim().toLowerCase();
      const value = metric.querySelector('strong');
      if (label === 'inventory' && value) addItemIcons(value, positiveIntegers(originalText(value)));
    }

    for (const title of document.querySelectorAll('.candidate-title strong, .build-step-head strong, .lock-banner')) {
      const text = originalText(title);
      if (!isItemTitle(text)) continue;
      addItemIcons(title, itemIdsFromTitle(text));
    }

    for (const label of document.querySelectorAll('.small-label, .inventory-diff span')) {
      const text = originalText(label);
      if (!/(selected items|consumes:|before \[|after \[)/i.test(text)) continue;
      addItemIcons(label, positiveIntegers(text));
    }
  }

  function enhanceFamilyProfiles() {
    if (!latestTrace) return;
    const desiredStage = latestTrace.stages.find((entry) => entry.stage === 'DESIRED_STATE');
    const families = desiredStage?.payload?.families || latestTrace.finalPlan?.desiredState?.families || [];
    const byFamilyId = new Map(families.map((family) => [String(family.familyId), family]));

    for (const title of document.querySelectorAll('.candidate-title strong')) {
      const match = /^Family\s+(\d+)$/.exec(originalText(title).trim());
      if (!match) continue;
      const family = byFamilyId.get(match[1]);
      const profiles = family?.sourceProfiles || [];
      const article = title.closest('.candidate');
      if (!article || profiles.length === 0 || article.querySelector('.debug-family-profiles')) continue;
      const container = document.createElement('div');
      container.className = 'debug-family-profiles';
      for (const profile of profiles) {
        const chip = document.createElement('span');
        chip.className = 'debug-family-profile';
        const nickname = typeof profile.playerName === 'string' ? profile.playerName.trim() : '';
        chip.textContent = nickname ? nickname + ' (' + profile.accountId + ')' : profile.accountId;
        container.appendChild(chip);
      }
      article.appendChild(container);
    }
  }

  function renderItemRef(itemId) {
    const reference = document.createElement('span');
    reference.className = 'debug-item-ref';
    reference.setAttribute('data-debug-item-id', String(itemId));

    const card = document.createElement('dl-item-card');
    card.className = 'debug-item-icon';
    card.setAttribute('item-id', String(itemId));
    card.setAttribute('variant', 'icon');
    card.setAttribute('tooltip-trigger', 'hover');
    card.setAttribute('aria-label', 'Item ' + itemId);
    reference.appendChild(card);

    const name = document.createElement('span');
    name.className = 'debug-item-name';
    name.setAttribute('data-debug-item-name-id', String(itemId));
    name.textContent = itemNames.get(itemId) || 'Item ' + itemId;
    reference.appendChild(name);
    return reference;
  }

  function addItemIcons(container, itemIds) {
    if (!container.hasAttribute('data-debug-original-text')) {
      container.setAttribute('data-debug-original-text', container.textContent || '');
    }
    const ids = [...new Set(itemIds.filter((itemId) => Number.isSafeInteger(itemId) && itemId > 0))];
    if (ids.length === 0) return;
    const existing = new Set(
      [...container.querySelectorAll('.debug-item-ref[data-debug-item-id]')]
        .map((reference) => Number(reference.getAttribute('data-debug-item-id'))),
    );
    const missing = ids.filter((itemId) => !existing.has(itemId));
    if (missing.length === 0) return;
    let strip = container.querySelector(':scope > .debug-item-icons');
    if (!strip) {
      strip = document.createElement('span');
      strip.className = 'debug-item-icons';
      container.prepend(strip);
    }
    for (const itemId of missing) strip.appendChild(renderItemRef(itemId));
  }

  function refreshItemNames() {
    for (const name of document.querySelectorAll('[data-debug-item-name-id]')) {
      const itemId = Number(name.getAttribute('data-debug-item-name-id'));
      name.textContent = itemNames.get(itemId) || 'Item ' + itemId;
    }
  }

  function originalText(element) {
    return element.getAttribute('data-debug-original-text') ?? element.textContent ?? '';
  }

  function positiveIntegers(value) {
    return (String(value).match(/\d+/g) || []).map(Number).filter((value) => value > 0);
  }

  function itemIdsFromTitle(value) {
    const text = String(value);
    if (/^Item\s+\d+$/i.test(text.trim())) return positiveIntegers(text);
    if (/^#\d+\s+\w+\s+item\s+\d+/i.test(text.trim())) return positiveIntegers(text).slice(1);
    if (/SELL\s+\d+\s*->\s*BUY\s+\d+/i.test(text)) return positiveIntegers(text);
    if (/^(BUY|UPGRADE)\b/i.test(text.trim())) return positiveIntegers(text).slice(0, 1);
    if (/Replacement target:\s*BUY\s+\d+/i.test(text)) return positiveIntegers(text).slice(0, 1);
    return [];
  }

  function isItemTitle(value) {
    const text = String(value).trim();
    return /^Item\s+\d+$/i.test(text) ||
      /^#\d+\s+\w+\s+item\s+\d+/i.test(text) ||
      /SELL\s+\d+\s*->\s*BUY\s+\d+/i.test(text) ||
      /^(BUY|UPGRADE)\b/i.test(text) ||
      /Replacement target:\s*BUY\s+\d+/i.test(text);
  }
})();`;
