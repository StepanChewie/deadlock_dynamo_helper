import {
  PREFERENCE_KEYS,
  persistDismissed,
  persistPreference,
  readDismissed,
  readPreference,
} from './player-preferences';

function installStorage(initial: Record<string, string> = {}): Map<string, string> {
  const store = new Map(Object.entries(initial));
  (globalThis as any).localStorage = {
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
  };
  return store;
}

afterEach(() => {
  delete (globalThis as any).localStorage;
});

describe('readPreference', () => {
  it('returns the stored value', () => {
    installStorage({ 'dynamo-lab.overlay.autoShow': 'true' });

    expect(readPreference(PREFERENCE_KEYS.overlayAutoShow, false)).toBe(true);
  });

  it('falls back when the key was never written', () => {
    installStorage();

    expect(readPreference(PREFERENCE_KEYS.overlayAutoShow, false)).toBe(false);
  });

  it('falls back when storage is unavailable', () => {
    delete (globalThis as any).localStorage;

    expect(readPreference(PREFERENCE_KEYS.overlayAutoShow, false)).toBe(false);
  });

  it('falls back when the stored value is malformed', () => {
    installStorage({ 'dynamo-lab.overlay.autoShow': 'not json' });

    expect(readPreference(PREFERENCE_KEYS.overlayAutoShow, false)).toBe(false);
  });

  it('namespaces keys so a preference cannot collide with another one', () => {
    const store = installStorage();

    persistPreference(PREFERENCE_KEYS.overlayAutoShow, true);

    expect(store.has('dynamo-lab.overlay.autoShow')).toBe(true);
    expect(store.has('overlay.autoShow')).toBe(false);
  });
});

describe('persistPreference', () => {
  it('round-trips a value', () => {
    installStorage();

    persistPreference(PREFERENCE_KEYS.overlayAutoShow, true);

    expect(readPreference(PREFERENCE_KEYS.overlayAutoShow, false)).toBe(true);
  });

  it('does not throw when storage is unavailable', () => {
    delete (globalThis as any).localStorage;

    expect(() => persistPreference(PREFERENCE_KEYS.overlayAutoShow, true)).not.toThrow();
  });
});

describe('dismissals', () => {
  it('still reads dismissals written by the previous implementation', () => {
    // The old code wrote the bare literal 'true'. Anything already on a
    // player's machine has to keep working after the generic pair replaced it.
    installStorage({ 'dynamo-lab.first-run': 'true' });

    expect(readDismissed('first-run')).toBe(true);
  });

  it('writes the same literal the previous implementation wrote', () => {
    const store = installStorage();

    persistDismissed('first-run');

    expect(store.get('dynamo-lab.first-run')).toBe('true');
  });

  it('treats an explicit false as not dismissed', () => {
    installStorage({ 'dynamo-lab.first-run': 'false' });

    expect(readDismissed('first-run')).toBe(false);
  });

  it('treats an absent key as not dismissed', () => {
    installStorage();

    expect(readDismissed('first-run')).toBe(false);
  });
});
