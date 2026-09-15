import {
  advanceFirstRunGuide,
  applyStoredPreferences,
  copyDiagnostics,
  dismissFirstRunGuide,
  dismissHotkeyHint,
  hideSituationalPanel,
  setRefreshPending,
  showAdaptiveError,
  showAdaptiveRecommendation,
  showFirstRunGuide,
  updateDiagnosticContext,
} from './ui';

class FakeElement {
  textContent = '';
  className = '';
  title = '';
  disabled = false;
  hidden = false;
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
