declare const __APP_VERSION__: string;

/**
 * The client version, injected by webpack's DefinePlugin from `package.json`.
 *
 * Falls back to `unknown` when the bundle is executed outside webpack (Jest, for
 * example), because `typeof` on an undefined identifier is safe.
 */
export const APP_VERSION: string =
  typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'unknown';
