import {
  advanceFirstRunGuide,
  applyStoredPreferences,
  copyDiagnostics,
  dismissFirstRunGuide,
  dismissHotkeyHint,
  dismissPostMatchFeedback,
  EXPIRED_AFTER_MS,
  formatRecommendationAge,
  hasRecommendationOnScreen,
  hideSituationalPanel,
  markRecommendationFresh,
  openExternal,
  readActiveWorkspace,
  readRecommendationAgeMs,
  readRecommendationFreshness,
  renderHotkeyBindings,
  revealPostMatchReasons,
  setRefreshPending,
  showAdaptiveError,
  setGameEventsDegraded,
  showAdaptiveRecommendation,
  showFirstRunGuide,
  showPostMatchFeedback,
  showWorkspace,
  STALE_AFTER_MS,
  syncOverlayAutoShowPreference,
  updateDiagnosticContext,
} from './ui';
import { APP_VERSION } from './app-version';

class FakeElement {
  textContent = '';
  className = '';
  title = '';
  disabled = false;
  hidden = false;
  checked = false;
  style: Record<string, string> = {};
  children: FakeElement[] = [];
  attributes = new Map<string, string>();

  constructor(readonly tagName = 'DIV') {}

  classList = {
    toggle: (token: string, force?: boolean): boolean => {
      const tokens = new Set(this.className.split(/\s+/).filter(Boolean));
      const enabled = force ?? !tokens.has(token);
      if (enabled) tokens.add(token);
      else tokens.delete(token);
      this.className = [...tokens].join(' ');
      return enabled;
    },
  };

  appendChild(child: FakeElement): FakeElement {
    this.children.push(child);
    return child;
  }

  append(...children: FakeElement[]): void {
    this.children.push(...children);
  }

  replaceChildren(...children: FakeElement[]): void {
    this.children = children;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
    if (name === 'title') this.title = '';
  }

  toggleAttribute(name: string, force?: boolean): boolean {
    const enabled = force ?? !this.attributes.has(name);
    if (enabled) this.attributes.set(name, '');
    else this.attributes.delete(name);
    return enabled;
  }
}

const elementIds = [
  'status',
  'indicator-dot',
  'indicator-text',
  'refresh-build',
  'guide-empty',
  'guide-empty-title',
  'guide-empty-copy',
  'guide-active',
  'situational-recommendation-panel',
  'rec-plan',
  'overlay-preview-plan',
  'rec-update-note',
  'hotkey-hint',
  'first-run',
  'first-run-step-1',
  'first-run-step-2',
  'diagnostic-summary',
  'post-match-feedback',
  'post-match-feedback-reasons',
  'build-workspace',
  'settings-workspace',
  'nav-build',
  'nav-settings',
  'hint-hotkey-toggle',
  'hint-hotkey-desktop',
  'setting-overlay-auto-show',
  'setting-hotkey',
  'setting-app-version',
  'setting-backend-status',
  'setting-gep-status',
  'setting-gep-version',
  'setting-gep-features',
  'setting-gep-snapshot',
  'setting-recommendation-status',
  'setting-route-age',
];

function recommendation(overrides: Record<string, unknown> = {}): any {
  return {
    ready: true,
    blockers: [],
    decisionId: 'decision-a',
    stateRevision: 'revision-a',
    gameState: 'EVEN',
    nextAction: {
      actionKey: 'BUY:3862866912',
      type: 'BUY',
      buyItemId: 3862866912,
      targetItemId: 3862866912,
      reasonCodes: ['CORE_TARGET_PENDING'],
    },
    recommendedBuild: [],
    changes: [],
    rankedImmediateCandidates: [],
    totalScore: 0.8,
    confidence: 0.8,
    scorerVersion: 'scorer',
    plannerVersion: 'planner',
    configVersion: 'config',
    evidence: {
      rulesetVersion: 'rules',
      catalogSha256: 'catalog',
      snapshotIds: [],
      families: [{ dataset: 'builds', freshness: 'FRESH', confidence: 0.9 }],
      degradedReasons: [],
    },
    ...overrides,
  };
}

function fiveItemRecommendation(): any {
  const itemIds = [3862866912, 968099481, 1342610602, 1437614329, 7409189];
  return recommendation({
    planActions: itemIds.map((itemId, index) => ({
      planActionId: `decision-a:${index + 1}`,
      sequence: index + 1,
      status: index === 0 ? 'READY' : 'PLANNED',
      action: {
        actionKey: `BUY:${itemId}`,
        type: 'BUY',
        buyItemId: itemId,
        targetItemId: itemId,
        reasonCodes: [],
      },
      targetItemId: itemId,
      sourceItemIds: [],
      requirements: [],
      reasonCodes: [],
    })),
  });
}

function nineItemRecommendation(): any {
  const itemIds = [3862866912, 968099481, 1342610602, 1437614329, 7409189, 26002154, 64550694, 668299740, 3633614685];
  return recommendation({
    planActions: itemIds.map((itemId, index) => ({
      planActionId: `decision-a:${index + 1}`,
      sequence: index + 1,
      status: index === 0 ? 'READY' : 'PLANNED',
      action: {
        actionKey: `BUY:${itemId}`,
        type: 'BUY',
        buyItemId: itemId,
        targetItemId: itemId,
        reasonCodes: [],
      },
      targetItemId: itemId,
      sourceItemIds: [],
      requirements: [],
      reasonCodes: [],
    })),
  });
}

function flatText(element: FakeElement): string {
  return [element.textContent, ...element.children.map(flatText)].join(' ');
}

function findByTagName(element: FakeElement, tagName: string): FakeElement | undefined {
  return element.tagName === tagName
    ? element
    : element.children.map((child) => findByTagName(child, tagName)).find(Boolean);
}

describe('adaptive recommendation UI state', () => {
  let elements: Map<string, FakeElement>;
  const originalDocument = globalThis.document;

  beforeEach(() => {
    elements = new Map(elementIds.map((id) => [id, new FakeElement()]));
    globalThis.document = {
      getElementById: (id: string) => elements.get(id) || null,
      createElement: (tagName: string) => new FakeElement(tagName.toUpperCase()),
    } as unknown as Document;
    hideSituationalPanel();
  });

  afterAll(() => {
    globalThis.document = originalDocument;
  });

  it('renders five aligned purchase rows with item artwork, price, and category', () => {
    showAdaptiveRecommendation(fiveItemRecommendation());

    const rows = elements.get('rec-plan')?.children ?? [];
    expect(rows).toHaveLength(5);
    expect(rows[0].attributes.get('data-plan-action-id')).toBe('decision-a:1');
    expect(rows[0].attributes.get('data-current')).toBe('true');
    expect(findByTagName(rows[0], 'DL-ITEM-CARD')).toBeDefined();
    expect(flatText(rows[0])).toContain('Restorative Shot');
    expect(flatText(rows[0])).toContain('800');
    expect(flatText(rows[0])).toContain('WEAPON');
    expect(elements.get('overlay-preview-plan')?.children).toHaveLength(5);
  });

  it('renders the whole build when the desktop container asks for every step', () => {
    elements.get('rec-plan')?.setAttribute('data-route-limit', 'all');

    showAdaptiveRecommendation(nineItemRecommendation());

    expect(elements.get('rec-plan')?.children).toHaveLength(9);
    expect(elements.get('overlay-preview-plan')?.children).toHaveLength(5);
  });

  it('keeps the compact five-row route when the container does not ask for all steps', () => {
    showAdaptiveRecommendation(nineItemRecommendation());

    expect(elements.get('rec-plan')?.children).toHaveLength(5);
    expect(elements.get('overlay-preview-plan')?.children).toHaveLength(5);
  });

  it('renders the route when the optional desktop preview is absent', () => {
    elements.delete('overlay-preview-plan');

    expect(() => showAdaptiveRecommendation(fiveItemRecommendation())).not.toThrow();
    expect(elements.get('rec-plan')?.children).toHaveLength(5);
  });

  it('exposes refresh busy state without clearing the route', () => {
    showAdaptiveRecommendation(fiveItemRecommendation());

    setRefreshPending(true);

    expect(elements.get('refresh-build')?.disabled).toBe(true);
    expect(elements.get('refresh-build')?.textContent).toBe('Refreshing');
    expect(elements.get('refresh-build')?.attributes.get('aria-busy')).toBe('true');
    expect(elements.get('rec-plan')?.children).toHaveLength(5);
  });

  it('clears the refresh busy state on both publication outcomes', () => {
    showAdaptiveRecommendation(fiveItemRecommendation());
    setRefreshPending(true);
    setRefreshPending(false);

    expect(elements.get('refresh-build')?.disabled).toBe(false);
    expect(elements.get('refresh-build')?.textContent).toBe('Refresh');
    expect(elements.get('refresh-build')?.attributes.get('aria-busy')).toBe('false');

    setRefreshPending(true);
    setRefreshPending(false);
    showAdaptiveError('Adaptive recommendation HTTP 502');

    expect(elements.get('refresh-build')?.disabled).toBe(false);
    expect(elements.get('refresh-build')?.textContent).toBe('Refresh');
    expect(elements.get('rec-plan')?.children).toHaveLength(5);
  });

  it('keeps the last safe purchase route visible during a transient failure', () => {
    showAdaptiveRecommendation(fiveItemRecommendation());
    showAdaptiveError('Adaptive recommendation HTTP 502');

    expect(elements.get('guide-active')?.style.display).toBe('flex');
    expect(elements.get('guide-empty')?.style.display).toBe('none');
    expect(elements.get('rec-plan')?.children).toHaveLength(5);
    expect(elements.get('rec-update-note')?.style.display).toBe('flex');
  });

  it('shows Dynamo Lab reconnect copy before a route is available', () => {
    showAdaptiveError();

    expect(elements.get('guide-empty')?.style.display).toBe('flex');
    expect(elements.get('guide-empty-title')?.textContent).toBe('Dynamo Lab is reconnecting');
    expect(elements.get('guide-empty-copy')?.textContent)
      .toBe('The build route will appear when fresh match data is available.');
  });

  it('uses Dynamo Lab copy when the player-facing route resets', () => {
    hideSituationalPanel();

    expect(elements.get('guide-empty-title')?.textContent).toBe('Waiting for match data');
    expect(elements.get('guide-empty-copy')?.textContent)
      .toBe('Your Dynamo Lab build route will appear automatically when the match is detected.');
  });
});

describe('Dynamo Lab hotkey reminder state', () => {
  let elements: Map<string, FakeElement>;
  const originalDocument = globalThis.document;
  const originalLocalStorage = (globalThis as any).localStorage;
  let store: Map<string, string>;

  beforeEach(() => {
    elements = new Map(elementIds.map((id) => [id, new FakeElement()]));
    globalThis.document = {
      getElementById: (id: string) => elements.get(id) || null,
      createElement: (tagName: string) => new FakeElement(tagName.toUpperCase()),
    } as unknown as Document;
    store = new Map();
    (globalThis as any).localStorage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    };
  });

  afterAll(() => {
    globalThis.document = originalDocument;
    (globalThis as any).localStorage = originalLocalStorage;
  });

  it('keeps the reminder visible until the player dismisses it', () => {
    applyStoredPreferences();
    expect(elements.get('hotkey-hint')?.hidden).toBe(false);

    dismissHotkeyHint();
    expect(elements.get('hotkey-hint')?.hidden).toBe(true);
  });

  it('remembers the dismissal across launches', () => {
    dismissHotkeyHint();

    elements.get('hotkey-hint')!.hidden = false;
    applyStoredPreferences();

    expect(elements.get('hotkey-hint')?.hidden).toBe(true);
  });

  it('still dismisses when storage is unavailable', () => {
    delete (globalThis as any).localStorage;

    expect(() => dismissHotkeyHint()).not.toThrow();
    expect(elements.get('hotkey-hint')?.hidden).toBe(true);
    expect(() => applyStoredPreferences()).not.toThrow();
  });
});

describe('Dynamo Lab first-run guide state', () => {
  let elements: Map<string, FakeElement>;
  const originalDocument = globalThis.document;
  const originalLocalStorage = (globalThis as any).localStorage;
  let store: Map<string, string>;

  beforeEach(() => {
    elements = new Map(elementIds.map((id) => [id, new FakeElement()]));
    globalThis.document = {
      getElementById: (id: string) => elements.get(id) || null,
      createElement: (tagName: string) => new FakeElement(tagName.toUpperCase()),
    } as unknown as Document;
    store = new Map();
    (globalThis as any).localStorage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    };
  });

  afterAll(() => {
    globalThis.document = originalDocument;
    (globalThis as any).localStorage = originalLocalStorage;
  });

  it('shows the first-run guide only until it is dismissed', () => {
    showFirstRunGuide();
    expect(elements.get('first-run')?.hidden).toBe(false);

    dismissFirstRunGuide();
    expect(elements.get('first-run')?.hidden).toBe(true);
  });

  it('reveals the guide on a first launch and stays on the opening screen', () => {
    applyStoredPreferences();

    expect(elements.get('first-run')?.hidden).toBe(false);
    expect(elements.get('first-run-step-1')?.hidden).toBe(false);
    expect(elements.get('first-run-step-2')?.hidden).toBe(true);
  });

  it('advances to the second screen without ending the guide', () => {
    showFirstRunGuide();
    advanceFirstRunGuide();

    expect(elements.get('first-run')?.hidden).toBe(false);
    expect(elements.get('first-run-step-1')?.hidden).toBe(true);
    expect(elements.get('first-run-step-2')?.hidden).toBe(false);
  });

  it('never shows the guide again once it has been dismissed', () => {
    dismissFirstRunGuide();

    elements.get('first-run')!.hidden = false;
    applyStoredPreferences();

    expect(elements.get('first-run')?.hidden).toBe(true);
  });

  it('restarts on the opening screen when shown again', () => {
    showFirstRunGuide();
    advanceFirstRunGuide();
    dismissFirstRunGuide();

    showFirstRunGuide();

    expect(elements.get('first-run-step-1')?.hidden).toBe(false);
    expect(elements.get('first-run-step-2')?.hidden).toBe(true);
  });
});

describe('Dynamo Lab diagnostic summary state', () => {
  let elements: Map<string, FakeElement>;
  const originalDocument = globalThis.document;
  const originalNavigator = (globalThis as any).navigator;

  beforeEach(() => {
    elements = new Map(elementIds.map((id) => [id, new FakeElement()]));
    globalThis.document = {
      getElementById: (id: string) => elements.get(id) || null,
      createElement: (tagName: string) => new FakeElement(tagName.toUpperCase()),
    } as unknown as Document;
  });

  afterAll(() => {
    globalThis.document = originalDocument;
    (globalThis as any).navigator = originalNavigator;
  });

  it('renders the summary into the page so it can still be copied by hand', async () => {
    updateDiagnosticContext({
      backendStatus: 'HTTP 200',
      gepStatus: 'REGISTERED',
      matchId: 'match-1',
      heroId: '72',
      recommendationStatus: 'READY',
      archetype: 'weapon-spirit',
      rulesetVersion: '2026-09-14',
      catalogSha256: 'abc',
    });

    await copyDiagnostics();

    const rendered = elements.get('diagnostic-summary')?.textContent ?? '';
    expect(rendered).toContain('Recommendation status: READY');
    expect(rendered).toContain('Match id: match-1');
    expect(rendered).toContain('Archetype: weapon-spirit');
    expect(rendered).not.toContain('sourceProfileAccountIds');
  });

  it('still renders when the clipboard API is unavailable', async () => {
    delete (globalThis as any).navigator;

    await expect(copyDiagnostics()).resolves.toBeUndefined();
    expect(elements.get('diagnostic-summary')?.textContent)
      .toContain('Recommendation status');
  });
});

describe('Dynamo Lab post-match feedback state', () => {
  let elements: Map<string, FakeElement>;
  const originalDocument = globalThis.document;

  beforeEach(() => {
    elements = new Map(elementIds.map((id) => [id, new FakeElement()]));
    globalThis.document = {
      getElementById: (id: string) => elements.get(id) || null,
      createElement: (tagName: string) => new FakeElement(tagName.toUpperCase()),
    } as unknown as Document;
  });

  afterAll(() => {
    globalThis.document = originalDocument;
  });

  it('renders the post-match usefulness prompt', () => {
    showPostMatchFeedback();

    expect(elements.get('post-match-feedback')?.hidden).toBe(false);
  });

  it('keeps the reasons collapsed until the player answers no', () => {
    showPostMatchFeedback();
    expect(elements.get('post-match-feedback-reasons')?.hidden).toBe(true);

    revealPostMatchReasons();
    expect(elements.get('post-match-feedback-reasons')?.hidden).toBe(false);
  });

  it('collapses the reasons again the next time it opens', () => {
    revealPostMatchReasons();
    showPostMatchFeedback();

    expect(elements.get('post-match-feedback-reasons')?.hidden).toBe(true);
  });

  it('closes the prompt when it is answered or dismissed', () => {
    showPostMatchFeedback();
    dismissPostMatchFeedback();
    expect(elements.get('post-match-feedback')?.hidden).toBe(true);

    showPostMatchFeedback();
    dismissPostMatchFeedback();
    expect(elements.get('post-match-feedback')?.hidden).toBe(true);
  });
});

describe('Dynamo Lab maintenance state', () => {
  let elements: Map<string, FakeElement>;
  const originalDocument = globalThis.document;

  beforeEach(() => {
    elements = new Map(elementIds.map((id) => [id, new FakeElement()]));
    globalThis.document = {
      getElementById: (id: string) => elements.get(id) || null,
      createElement: (tagName: string) => new FakeElement(tagName.toUpperCase()),
    } as unknown as Document;
    hideSituationalPanel();
  });

  afterAll(() => {
    globalThis.document = originalDocument;
  });

  function disabledRecommendation(message?: string): any {
    return recommendation({
      ready: false,
      blockers: ['RECOMMENDATIONS_DISABLED'],
      degradedReasons: message
        ? ['RECOMMENDATIONS_DISABLED', message]
        : ['RECOMMENDATIONS_DISABLED'],
      planActions: [],
    });
  }

  it('replaces the purchase route with the maintenance notice', () => {
    showAdaptiveRecommendation(disabledRecommendation('Deadlock patch in progress'));

    expect(elements.get('guide-empty')?.style.display).toBe('flex');
    expect(elements.get('guide-empty-title')?.textContent).toBe('Recommendations are paused');
    expect(elements.get('guide-empty-copy')?.textContent).toBe('Deadlock patch in progress');
  });

  it('clears a route that was rendered before the switch flipped', () => {
    showAdaptiveRecommendation(fiveItemRecommendation());
    expect(elements.get('rec-plan')?.children ?? []).toHaveLength(5);

    showAdaptiveRecommendation(disabledRecommendation('Deadlock patch in progress'));

    expect(elements.get('rec-plan')?.children ?? []).toHaveLength(0);
  });

  it('falls back to generic copy when no maintenance message is supplied', () => {
    showAdaptiveRecommendation(disabledRecommendation());

    expect(elements.get('guide-empty-copy')?.textContent).toContain('paused');
  });

  it('still renders a normal route when the switch is on', () => {
    showAdaptiveRecommendation(fiveItemRecommendation());

    expect(elements.get('guide-active')?.style.display).toBe('flex');
    expect(elements.get('rec-plan')?.children ?? []).toHaveLength(5);
  });
});

describe('Dynamo Lab degraded game events notice', () => {
  let elements: Map<string, FakeElement>;
  const originalDocument = globalThis.document;

  beforeEach(() => {
    elements = new Map(elementIds.map((id) => [id, new FakeElement()]));
    globalThis.document = {
      getElementById: (id: string) => elements.get(id) || null,
      createElement: (tagName: string) => new FakeElement(tagName.toUpperCase()),
    } as unknown as Document;
    setGameEventsDegraded(false);
    hideSituationalPanel();
  });

  afterAll(() => {
    globalThis.document = originalDocument;
    setGameEventsDegraded(false);
  });

  it('explains a stalled Overwolf instead of waiting forever', () => {
    setGameEventsDegraded(true);

    expect(elements.get('guide-empty')?.style.display).toBe('flex');
    expect(elements.get('guide-empty-title')?.textContent).toBe('Overwolf is not passing game data');
    expect(elements.get('guide-empty-copy')?.textContent).toMatch(/restart Overwolf/i);
  });

  it('names the reinstall, because a restart alone does not fix a dead game plugin', () => {
    setGameEventsDegraded(true);

    const copy = elements.get('guide-empty-copy')?.textContent ?? '';
    expect(copy).toMatch(/reinstall/i);
    expect(copy).toMatch(/repair|re-fetch/i);
  });

  it('goes back to the normal waiting copy once data resumes', () => {
    setGameEventsDegraded(true);
    setGameEventsDegraded(false);

    expect(elements.get('guide-empty-title')?.textContent).toBe('Waiting for match data');
  });

  it('does not claim a fault while a recommendation is on screen', () => {
    setGameEventsDegraded(true);
    showAdaptiveRecommendation(fiveItemRecommendation());

    expect(elements.get('guide-active')?.style.display).toBe('flex');
    expect(elements.get('guide-empty')?.style.display).toBe('none');
  });
});

describe('Dynamo Lab external link handling', () => {
  const originalOverwolf = (globalThis as any).overwolf;
  const originalOpen = (globalThis as any).open;

  afterEach(() => {
    (globalThis as any).overwolf = originalOverwolf;
    (globalThis as any).open = originalOpen;
  });

  it('hands the URL to Overwolf so it opens outside the app', () => {
    const openUrlInDefaultBrowser = jest.fn();
    (globalThis as any).overwolf = { utils: { openUrlInDefaultBrowser } };

    openExternal('https://discord.gg/yR4TNN2GDH');

    expect(openUrlInDefaultBrowser).toHaveBeenCalledWith('https://discord.gg/yR4TNN2GDH');
  });

  it('falls back to a window open when the Overwolf helper is missing', () => {
    const open = jest.fn();
    (globalThis as any).overwolf = undefined;
    (globalThis as any).open = open;

    openExternal('https://discord.gg/yR4TNN2GDH');

    expect(open).toHaveBeenCalledWith('https://discord.gg/yR4TNN2GDH', '_blank');
  });

  it('stays silent when nothing can open the link', () => {
    (globalThis as any).overwolf = undefined;
    (globalThis as any).open = undefined;

    expect(() => openExternal('https://discord.gg/yR4TNN2GDH')).not.toThrow();
  });
});

describe('Dynamo Lab recommendation freshness', () => {
  let elements: Map<string, FakeElement>;
  const originalDocument = globalThis.document;
  const RENDERED_AT = new Date('2026-09-17T00:00:00Z');

  beforeEach(() => {
    elements = new Map(elementIds.map((id) => [id, new FakeElement()]));
    globalThis.document = {
      getElementById: (id: string) => elements.get(id) || null,
      createElement: (tagName: string) => new FakeElement(tagName.toUpperCase()),
    } as unknown as Document;
    hideSituationalPanel();

    jest.useFakeTimers();
    jest.setSystemTime(RENDERED_AT);
    // Start from "no route has ever been rendered", so each case has a known
    // age instead of whatever the previous suite left behind.
    markRecommendationFresh(0);
  });

  afterEach(() => {
    jest.useRealTimers();
    markRecommendationFresh();
  });

  afterAll(() => {
    globalThis.document = originalDocument;
  });

  it('treats a route rendered moments ago as fresh', () => {
    showAdaptiveRecommendation(fiveItemRecommendation());
    jest.setSystemTime(new Date('2026-09-17T00:00:09Z'));

    expect(readRecommendationFreshness()).toBe('FRESH');
  });

  it('crosses from fresh to stale to expired at the documented ages', () => {
    showAdaptiveRecommendation(fiveItemRecommendation());
    const renderedAt = Date.now();

    expect(readRecommendationFreshness(renderedAt + 9_999)).toBe('FRESH');
    expect(readRecommendationFreshness(renderedAt + STALE_AFTER_MS)).toBe('STALE');
    expect(readRecommendationFreshness(renderedAt + EXPIRED_AFTER_MS - 1)).toBe('STALE');
    expect(readRecommendationFreshness(renderedAt + EXPIRED_AFTER_MS)).toBe('EXPIRED');
  });

  it('keeps the original note while the route is still fresh', () => {
    showAdaptiveRecommendation(fiveItemRecommendation());
    jest.setSystemTime(new Date('2026-09-17T00:00:05Z'));

    showAdaptiveError('HTTP 502');

    expect(elements.get('rec-update-note')?.textContent)
      .toBe('Connection interrupted - showing the last safe recommendation.');
    expect(elements.get('rec-update-note')?.style.display).toBe('flex');
  });

  it('warns that a stale route may be outdated', () => {
    showAdaptiveRecommendation(fiveItemRecommendation());
    jest.setSystemTime(new Date('2026-09-17T00:00:15Z'));

    showAdaptiveError('HTTP 502');

    expect(elements.get('rec-update-note')?.textContent)
      .toBe('Connection interrupted - this route may be outdated.');
    expect(elements.get('guide-active')?.style.display).toBe('flex');
  });

  it('hides an expired route rather than letting the player follow it', () => {
    showAdaptiveRecommendation(fiveItemRecommendation());
    jest.setSystemTime(new Date('2026-09-17T00:00:31Z'));

    showAdaptiveError('HTTP 502');

    expect(elements.get('guide-active')?.style.display).toBe('none');
    expect(elements.get('situational-recommendation-panel')?.style.display).toBe('none');
    expect(elements.get('guide-empty')?.style.display).toBe('flex');
    expect(hasRecommendationOnScreen()).toBe(false);
  });

  it('reports expired before anything has been rendered, and still shows reconnect copy', () => {
    // The age is unbounded before the first render. That must not be read as
    // "a route went stale", which would hide a screen that was never shown.
    expect(readRecommendationFreshness()).toBe('EXPIRED');

    showAdaptiveError();

    expect(elements.get('guide-empty-title')?.textContent).toBe('Dynamo Lab is reconnecting');
    expect(elements.get('guide-empty-copy')?.textContent)
      .toBe('The build route will appear when fresh match data is available.');
  });

  it('does not keep the stale note on screen after the route expires', () => {
    showAdaptiveRecommendation(fiveItemRecommendation());
    jest.setSystemTime(new Date('2026-09-17T00:00:15Z'));
    showAdaptiveError('HTTP 502');
    expect(elements.get('rec-update-note')?.textContent)
      .toBe('Connection interrupted - this route may be outdated.');

    jest.setSystemTime(new Date('2026-09-17T00:00:45Z'));
    showAdaptiveError('HTTP 502');

    expect(hasRecommendationOnScreen()).toBe(false);
  });
});

describe('Dynamo Lab desktop workspaces', () => {
  let elements: Map<string, FakeElement>;
  const originalDocument = globalThis.document;
  const originalLocalStorage = (globalThis as any).localStorage;

  beforeEach(() => {
    elements = new Map(elementIds.map((id) => [id, new FakeElement()]));
    globalThis.document = {
      getElementById: (id: string) => elements.get(id) || null,
      createElement: (tagName: string) => new FakeElement(tagName.toUpperCase()),
    } as unknown as Document;
    // Start from "no route has ever been rendered" so the route-age cell has a
    // known value instead of whatever the previous suite left behind.
    markRecommendationFresh(0);
  });

  afterEach(() => {
    (globalThis as any).localStorage = originalLocalStorage;
  });

  afterAll(() => {
    globalThis.document = originalDocument;
  });

  it('shows the build page and marks its nav entry as current on startup', () => {
    showWorkspace('build');

    expect(readActiveWorkspace()).toBe('build');
    expect(elements.get('build-workspace')?.hidden).toBe(false);
    expect(elements.get('settings-workspace')?.hidden).toBe(true);
    expect(elements.get('nav-build')?.attributes.get('aria-current')).toBe('page');
    expect(elements.get('nav-settings')?.attributes.has('aria-current')).toBe(false);
  });

  it('moves both the highlight and aria-current to Settings', () => {
    // Switch away from an already-current page, so the stale marker has to be
    // actively cleared rather than simply never having been set.
    showWorkspace('build');
    showWorkspace('settings');

    expect(readActiveWorkspace()).toBe('settings');
    expect(elements.get('build-workspace')?.hidden).toBe(true);
    expect(elements.get('settings-workspace')?.hidden).toBe(false);
    expect(elements.get('nav-settings')?.attributes.get('aria-current')).toBe('page');
    expect(elements.get('nav-build')?.attributes.has('aria-current')).toBe(false);
    expect(elements.get('nav-settings')?.className).toContain('is-active');
    expect(elements.get('nav-build')?.className).not.toContain('is-active');
  });

  it('leaves the rendered route in place when the player visits Settings', () => {
    // Both pages stay mounted. Tearing the build page down on navigation would
    // blank the route until the next poll, which is several seconds of nothing.
    elements.get('rec-plan')?.replaceChildren(new FakeElement('LI'));

    showWorkspace('settings');
    showWorkspace('build');

    expect(elements.get('rec-plan')?.children).toHaveLength(1);
  });

  it('renders the status group from the diagnostic accumulator', () => {
    updateDiagnosticContext({
      backendStatus: 'HTTP 200',
      gepStatus: 'REGISTERED without gep_internal',
      gepFeatures: 'game_info,match_info',
      gepSnapshot: 'game_info(steam_id)',
      gepVersion: '305.1',
      recommendationStatus: 'READY',
    });

    showWorkspace('settings');

    // Same accumulator as the diagnostics block, so the panel and the copied
    // report cannot disagree about what the client is doing.
    expect(elements.get('setting-app-version')?.textContent).toBe(APP_VERSION);
    expect(elements.get('setting-backend-status')?.textContent).toBe('HTTP 200');
    expect(elements.get('setting-gep-status')?.textContent).toBe('REGISTERED without gep_internal');
    expect(elements.get('setting-gep-features')?.textContent).toBe('game_info,match_info');
    expect(elements.get('setting-gep-snapshot')?.textContent).toBe('game_info(steam_id)');
    expect(elements.get('setting-gep-version')?.textContent).toBe('305.1');
    expect(elements.get('setting-recommendation-status')?.textContent).toBe('READY');
  });

  it('reports an unknown status as an em dash rather than an empty cell', () => {
    updateDiagnosticContext({ backendStatus: '', gepSnapshot: undefined });

    showWorkspace('settings');

    expect(elements.get('setting-backend-status')?.textContent).toBe('—');
    expect(elements.get('setting-gep-snapshot')?.textContent).toBe('—');
  });

  it('reports no route age until a route has been rendered', () => {
    expect(readRecommendationAgeMs()).toBeNull();
    expect(formatRecommendationAge(null)).toBe('—');

    showWorkspace('settings');

    expect(elements.get('setting-route-age')?.textContent).toBe('—');
  });

  it('formats the route age in seconds, minutes, and hours', () => {
    expect(formatRecommendationAge(0)).toBe('0s ago');
    expect(formatRecommendationAge(12_000)).toBe('12s ago');
    expect(formatRecommendationAge(59_000)).toBe('59s ago');
    expect(formatRecommendationAge(90_000)).toBe('1m ago');
    expect(formatRecommendationAge(59 * 60_000)).toBe('59m ago');
    expect(formatRecommendationAge(3 * 3_600_000)).toBe('3h ago');
  });

  it('reads the route age back from the last render', () => {
    markRecommendationFresh(1_000_000);

    expect(readRecommendationAgeMs(1_012_500)).toBe(12_500);
    // A clock that moved backwards must not produce a negative age.
    expect(readRecommendationAgeMs(999_000)).toBe(0);
  });

  it('reflects the stored overlay preference in the Settings checkbox', () => {
    const store = new Map<string, string>();
    (globalThis as any).localStorage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
    };

    syncOverlayAutoShowPreference();
    expect(elements.get('setting-overlay-auto-show')?.checked).toBe(false);

    store.set('dynamo-lab.overlay.autoShow', 'true');
    syncOverlayAutoShowPreference();
    expect(elements.get('setting-overlay-auto-show')?.checked).toBe(true);
  });

  it('leaves the checkbox alone when storage is unavailable', () => {
    delete (globalThis as any).localStorage;

    expect(() => syncOverlayAutoShowPreference()).not.toThrow();
    expect(elements.get('setting-overlay-auto-show')?.checked).toBe(false);
  });

  it('writes the bound hotkeys into the banner and the Settings row together', () => {
    renderHotkeyBindings({ toggle_overlay: 'Ctrl+F5', show_desktop_build: 'Ctrl+F6' });

    expect(elements.get('hint-hotkey-toggle')?.textContent).toBe('Ctrl+F5');
    expect(elements.get('hint-hotkey-desktop')?.textContent).toBe('Ctrl+F6');
    expect(elements.get('setting-hotkey')?.textContent).toBe('Ctrl+F5');
  });

  it('keeps the shipped default for any hotkey Overwolf did not report', () => {
    elements.get('hint-hotkey-toggle')!.textContent = 'Ctrl+Shift+D';

    renderHotkeyBindings({});

    expect(elements.get('hint-hotkey-toggle')?.textContent).toBe('Ctrl+Shift+D');
  });
});
