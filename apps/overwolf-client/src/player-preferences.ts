/**
 * Small persistence layer for player preferences.
 *
 * Storage can be unavailable (private mode, a blocked origin, or a test
 * environment without `localStorage`), so every access is guarded. When
 * persistence fails the value still applies for the current session; it is
 * simply not remembered across restarts.
 */
const STORAGE_PREFIX = 'dynamo-lab.';

function storageKey(key: string): string {
  return `${STORAGE_PREFIX}${key}`;
}

/**
 * Reads a stored preference, falling back when it is absent, malformed, or
 * storage is unavailable. The fallback is deliberately also the answer for a
 * corrupted entry, so a bad value can never surface as something the caller did
 * not expect.
 */
export function readPreference<T>(key: string, fallback: T): T {
  try {
    const raw = globalThis.localStorage?.getItem(storageKey(key));
    if (raw === null || raw === undefined) {
      return fallback;
    }

    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** Stores a preference. A failed write leaves it session-only. */
export function persistPreference<T>(key: string, value: T): void {
  try {
    globalThis.localStorage?.setItem(storageKey(key), JSON.stringify(value));
  } catch {
    // Storage unavailable — the preference applies for this session only.
  }
}

/**
 * Preference keys. These are bare names: `storageKey` adds the namespace.
 *
 * `overlayAutoShow` defaults to **false** at every read site. Until Overwolf
 * confirms that putting the overlay on screen unasked is allowed, a new match
 * must not do it; the recommendation is still built in the background.
 */
export const PREFERENCE_KEYS = {
  overlayAutoShow: 'overlay.autoShow',
} as const;

/**
 * One-time dismissals, expressed in terms of the generic pair above.
 *
 * `JSON.stringify(true)` is the literal `'true'`, which is exactly what the
 * previous hand-rolled implementation wrote, so dismissals already stored on
 * players' machines keep working and no migration is needed.
 */
export function readDismissed(key: string): boolean {
  // The type argument is required: without it the fallback literal narrows the
  // return type to `false`, and the comparison below stops compiling.
  return readPreference<boolean>(key, false) === true;
}

export function persistDismissed(key: string): void {
  persistPreference(key, true);
}
