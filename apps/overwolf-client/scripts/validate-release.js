const fs = require('fs');
const path = require('path');

const appRoot = path.resolve(__dirname, '..');
const publicDir = path.join(appRoot, 'public');
const manifestPath = path.join(publicDir, 'manifest.json');
const packagePath = path.join(appRoot, 'package.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
const errors = [];
const DEADLOCK_GAME_ID = 24482;
// Overwolf's submission test procedure opens the app on a 1366x720 screen and
// requires every window to stay inside the screen borders.
const OVERWOLF_TEST_SCREEN_HEIGHT = 720;
// Appstore requires 256x256 icons. The previous icon was 447x447, so this is a
// real fix rather than a formality.
const STORE_ICON_SIZE = 256;
const STORE_ICON_MAX_BYTES = 40 * 1024;
const STORE_ICON_FIELDS = ['icon', 'icon_gray', 'window_icon'];

// Origins that can never be part of a shipped build.
//
// `duckdns.org` is deliberately NOT listed. DuckDNS is the current production
// host (decided 2026-09-16), so rejecting it would fail a legitimate build.
// What PR 10 needs to assert is that the build received an explicit
// OVERWOLF_API_BASE_URL, which is a different statement from "the origin is not
// DuckDNS" -- see docs/roadmap.md section 6, decision 3.
const RETIRED_API_HOSTS = [/^localhost$/i, /^127\.0\.0\.1$/i, /^\[::1\]$/i];
const RETIRED_HOTKEYS = [/Ctrl\+Tab/i];

assert(manifest.manifest_version === 1, 'manifest_version must be 1.');
assert(manifest.type === 'WebApp', 'manifest type must be WebApp.');
assert(manifest.meta?.version === packageJson.version, 'Manifest and package versions must match.');

for (const field of [
  'name',
  'version',
  'minimum-overwolf-version',
  'minimum-gep-version',
  'author',
  'description',
  'icon',
]) {
  assert(
    typeof manifest.meta?.[field] === 'string' && manifest.meta[field].trim().length > 0,
    `manifest.meta.${field} is required.`,
  );
}

for (const permission of ['GameInfo', 'Hotkeys']) {
  assert(
    Array.isArray(manifest.permissions) && manifest.permissions.includes(permission),
    `Manifest permission ${permission} is required.`,
  );
}

// Appstore submission requires these four meta fields on top of `icon`.
for (const field of ['dock_button_title', 'icon_gray', 'launcher_icon', 'window_icon']) {
  assert(
    typeof manifest.meta?.[field] === 'string' && manifest.meta[field].trim().length > 0,
    `manifest.meta.${field} is required for Appstore submission.`,
  );
}

assert(
  (manifest.meta?.dock_button_title || '').length <= 18,
  'manifest.meta.dock_button_title must be at most 18 characters.',
);

assert(
  manifest.data?.game_targeting?.type === 'dedicated' &&
    manifest.data.game_targeting.game_ids?.includes(DEADLOCK_GAME_ID),
  `game_targeting must include Deadlock game ID ${DEADLOCK_GAME_ID}.`,
);
assert(
  Array.isArray(manifest.data?.game_events) &&
    manifest.data.game_events.includes(DEADLOCK_GAME_ID),
  `game_events must include Deadlock game ID ${DEADLOCK_GAME_ID}.`,
);
assert(
  manifest.data?.launch_events?.some(
    (event) =>
      event?.event === 'GameLaunch' &&
      event.event_data?.game_ids?.includes(DEADLOCK_GAME_ID),
  ),
  'A Deadlock GameLaunch event is required.',
);

const externalMatches = manifest.data?.externally_connectable?.matches;
assert(
  Array.isArray(externalMatches) &&
    externalMatches.some((value) => /^https:\/\/[^/]+$/.test(value)),
  'externally_connectable must include the HTTPS API origin.',
);

// A shipped build must not reach a development host.
for (const value of externalMatches || []) {
  const host = safeHost(value);
  assert(
    !host || !RETIRED_API_HOSTS.some((pattern) => pattern.test(host)),
    `externally_connectable still contains a development origin: ${value}`,
  );
}

assert(
  typeof manifest.data?.start_window === 'string' &&
    manifest.data.windows?.[manifest.data.start_window],
  'start_window must reference a declared window.',
);

for (const [windowName, windowConfig] of Object.entries(manifest.data?.windows || {})) {
  assert(windowName.length <= 20, `Window name ${windowName} exceeds 20 characters.`);
  assert(
    typeof windowConfig.file === 'string' &&
      fs.existsSync(path.join(publicDir, windowConfig.file)),
    `Window ${windowName} references a missing file.`,
  );
  assert(
    windowConfig.block_top_window_navigation === true,
    `Window ${windowName} must set block_top_window_navigation: true.`,
  );
  assert(
    windowConfig.popup_blocker === true,
    `Window ${windowName} must set popup_blocker: true.`,
  );
  assert(
    windowConfig.mute === true,
    `Window ${windowName} must set mute: true.`,
  );
}

const desktopSize = manifest.data?.windows?.desktop?.size;
assert(
  desktopSize?.height <= OVERWOLF_TEST_SCREEN_HEIGHT,
  `desktop window height ${desktopSize?.height} exceeds the ${OVERWOLF_TEST_SCREEN_HEIGHT}px Overwolf test screen.`,
);

const inGameWindow = manifest.data?.windows?.in_game;
assert(
  (inGameWindow?.default_position?.y || 0) +
    (inGameWindow?.size?.height || 0) <=
    OVERWOLF_TEST_SCREEN_HEIGHT,
  `in_game offset ${inGameWindow?.default_position?.y} plus declared height ${inGameWindow?.size?.height} exceeds the ${OVERWOLF_TEST_SCREEN_HEIGHT}px Overwolf test screen.`,
);

// Store icons: must exist, be real PNGs, be exactly 256x256, and stay small
// enough for the store listing.
for (const field of STORE_ICON_FIELDS) {
  const value = manifest.meta?.[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    continue;
  }
  const filePath = path.join(publicDir, value);
  assert(fs.existsSync(filePath), `manifest.meta.${field} references a missing file: ${value}`);
  if (!fs.existsSync(filePath)) {
    continue;
  }
  assertPng(filePath, `meta.${field}`);
  assertSquareSize(filePath, `meta.${field}`, STORE_ICON_SIZE);
  assert(
    fs.statSync(filePath).size <= STORE_ICON_MAX_BYTES,
    `meta.${field} exceeds ${Math.round(STORE_ICON_MAX_BYTES / 1024)}KB.`,
  );
}

// The launcher icon must be a real ICO container, not a PNG with a new name.
if (typeof manifest.meta?.launcher_icon === 'string') {
  const icoPath = path.join(publicDir, manifest.meta.launcher_icon);
  assert(fs.existsSync(icoPath), 'manifest.meta.launcher_icon is missing.');
  if (fs.existsSync(icoPath)) {
    const head = fs.readFileSync(icoPath).subarray(0, 4).toString('hex');
    assert(head === '00000100', 'manifest.meta.launcher_icon must be a real ICO file.');
  }
}

// Retired bindings must not come back.
const hotkeys = manifest.data?.hotkeys || {};
for (const [name, config] of Object.entries(hotkeys)) {
  assert(
    !RETIRED_HOTKEYS.some((pattern) => pattern.test(config?.default || '')),
    `hotkey ${name} still uses a retired default binding: ${config?.default}`,
  );
}

// NOTE: the plan also asserts here that src/overwolf/set-required-features.ts
// requests 'gep_internal'. That assertion is deliberately NOT in this PR: the
// client reads gep_internal.version_info (listen-overwolf-events.ts) but never
// requests the feature, so the check would be red until PR 6 lands, and PR 3
// has to merge green. Add it in PR 6 together with the graceful-degradation
// path, so a feature Overwolf may not support cannot break game_info/match_info
// registration.

// Legal and support links must point at published documents, never at a local
// or development address.
const desktopHtml = fs.readFileSync(path.join(publicDir, 'desktop.html'), 'utf8');
for (const match of desktopHtml.matchAll(/openExternal\?\.\('([^']+)'\)/g)) {
  const host = safeHost(match[1]);
  assert(
    Boolean(host) && !RETIRED_API_HOSTS.some((pattern) => pattern.test(host)),
    `desktop.html links to a non-production URL: ${match[1]}`,
  );
}

const distDir = path.join(publicDir, 'dist');
assert(fs.existsSync(path.join(distDir, 'index.js')), 'Compiled dist/index.js is missing.');
assert(
  fs.existsSync(path.join(distDir, 'dynamo_warning.js')),
  'Compiled dist/dynamo_warning.js is missing.',
);

if (errors.length > 0) {
  throw new Error(`Overwolf release validation failed:\n- ${errors.join('\n- ')}`);
}

console.log(
  `Overwolf store-ready ${manifest.meta.version} validated for Deadlock ${DEADLOCK_GAME_ID}.`,
);

function assert(condition, message) {
  if (!condition) {
    errors.push(message);
  }
}

function assertPng(filePath, label) {
  const buffer = fs.readFileSync(filePath);
  const pngSignature = '89504e470d0a1a0a';
  assert(
    buffer.length >= 24 && buffer.subarray(0, 8).toString('hex') === pngSignature,
    `${label} must reference a real PNG file.`,
  );
  if (buffer.length < 24 || buffer.subarray(0, 8).toString('hex') !== pngSignature) {
    return;
  }

  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  assert(width > 0 && height > 0, `${label} has invalid dimensions.`);
  assert(width === height, `${label} must be square, got ${width}x${height}.`);
}

function assertSquareSize(filePath, label, expected) {
  const buffer = fs.readFileSync(filePath);
  if (buffer.length < 24 || buffer.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
    return;
  }
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  assert(
    width === expected && height === expected,
    `${label} must be ${expected}x${expected}, got ${width}x${height}.`,
  );
}

function safeHost(value) {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return '';
  }
}
