/**
 * Small persistence layer for one-time player-facing hints.
 *
 * Storage can be unavailable (private mode, a blocked origin, or a test
 * environment without `localStorage`), so every access is guarded. When
 * persistence fails the dismissal still applies for the current session;
 * it is simply not remembered across restarts.
 */
const STORAGE_PREFIX = 'dynamo-lab.';

function storageKey(key: string): string {
  return `${STORAGE_PREFIX}${key}`;
}

export function readDismissed(key: string): boolean {
  try {
    return globalThis.localStorage?.getItem(storageKey(key)) === 'true';
  } catch {
    return false;
  }
}

export function persistDismissed(key: string): void {
  try {
    globalThis.localStorage?.setItem(storageKey(key), 'true');
  } catch {
    // Storage unavailable — the hint stays dismissed for this session only.
  }
}
