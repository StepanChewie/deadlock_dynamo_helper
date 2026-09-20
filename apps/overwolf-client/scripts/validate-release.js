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
// 30 KB, not 40: Overwolf's asset documentation states "max 30KB" for `icon` and
// `icon_gray`, and a limit looser than the platform's would let an icon pass here
// and be rejected at submission - the validator would be reporting readiness it
// cannot actually guarantee. `window_icon` has no published limit; holding it to
// the same ceiling is deliberate and safe.
const STORE_ICON_MAX_BYTES = 30 * 1024;
const STORE_ICON_FIELDS = ['icon', 'icon_gray', 'window_icon'];
// Overwolf's release guide: "Make sure that your icon's layer sizes include all of
// (and only) the above sizes (16x16, 32x32, 48x48, 256x256)". Both halves matter -
// extra layers are a defect, not a bonus.
const LAUNCHER_ICON_SIZES = [16, 32, 48, 256];

// Origins that can never be part of a shipped build.
//
// `duckdns.org` is deliberately NOT listed. DuckDNS is the current production
// host (decided 2026-09-16), so rejecting it would fail a legitimate build.
// What PR 10 needs to assert is that the build received an explicit
// OVERWOLF_API_BASE_URL, which is a different statement from "the origin is not
// DuckDNS" -- see docs/roadmap.md section 6, decision 3.
const RETIRED_API_HOSTS = [/^localhost$/i, /^127\.0\.0\.1$/i, /^\[::1\]$/i];

// Reserved names from RFC 2606 / RFC 6761. A packaged build that reaches one of
// these is pointing at a placeholder, whichever placeholder it is - so this
// catches the intent rather than one specific string. It is the second line of
// defence behind the build refusing to run without OVERWOLF_API_BASE_URL: it
// also covers a manifest edited by hand after the build.
const RESERVED_API_HOST_SUFFIXES = ['.invalid', '.example', '.test', '.localhost'];
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

// Nor a placeholder. A build without OVERWOLF_API_BASE_URL cannot be produced at
// all any more, but a manifest can still be edited by hand afterwards.
for (const value of externalMatches || []) {
  const host = (safeHost(value) || '').toLowerCase();
  assert(
    !RESERVED_API_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix)),
    `externally_connectable points at a placeholder origin: ${value}`,
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

  // "at least 72 PPI" is a documented requirement, so it is asserted rather than
  // left to whatever a viewer assumes.
  const ppi = readPngPpi(filePath);
  assert(
    ppi !== undefined && ppi >= 72,
    ppi === undefined
      ? `meta.${field} declares no resolution (no pHYs chunk); at least 72 PPI is required.`
      : `meta.${field} declares ${Math.round(ppi)} PPI; at least 72 is required.`,
  );
}

// The launcher icon must be a real ICO container, not a PNG with a new name.
if (typeof manifest.meta?.launcher_icon === 'string') {
  const icoPath = path.join(publicDir, manifest.meta.launcher_icon);
  assert(fs.existsSync(icoPath), 'manifest.meta.launcher_icon is missing.');
  if (fs.existsSync(icoPath)) {
    const ico = fs.readFileSync(icoPath);
    const head = ico.subarray(0, 4).toString('hex');
    assert(head === '00000100', 'manifest.meta.launcher_icon must be a real ICO file.');

    // The size set is checked, not just the container magic. Overwolf's release
    // guide requires "all of (and only)" 16, 32, 48 and 256 - so a six-size icon,
    // which is the ordinary Windows practice, is a submission defect. Checking
    // only the magic let exactly that ship.
    const count = ico.readUInt16LE(4);
    const sizes = [];
    for (let index = 0; index < count; index += 1) {
      const width = ico[6 + index * 16] || 256;
      const height = ico[6 + index * 16 + 1] || 256;
      sizes.push(width === height ? width : `${width}x${height}`);
    }
    assert(
      sizes.length === LAUNCHER_ICON_SIZES.length
        && LAUNCHER_ICON_SIZES.every((size) => sizes.includes(size)),
      `manifest.meta.launcher_icon must contain exactly the layers `
      + `${LAUNCHER_ICON_SIZES.join(', ')}; found ${sizes.join(', ')}.`,
    );
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

// The client reads `gep_internal.version_info` to report Overwolf's GEP version
// (see readGepVersion in src/overwolf/listen-overwolf-events.ts). GEP only
// delivers data for features that were explicitly requested, so reading a
// feature that is never requested yields an empty value forever with no error.
//
// PR 3 deferred this check: it would have been red until PR 6 added the request
// together with the graceful-degradation path that keeps an unsupported
// optional feature from taking game_info/match_info down with it.
const requiredFeaturesSource = fs.readFileSync(
  path.join(appRoot, 'src', 'overwolf', 'set-required-features.ts'),
  'utf8',
);
assert(
  requiredFeaturesSource.includes("'gep_internal'"),
  "src/overwolf/set-required-features.ts does not request 'gep_internal', so the GEP version line in diagnostics can never be populated.",
);
assert(
  requiredFeaturesSource.includes('CORE_FEATURES'),
  'set-required-features.ts must keep a separate core feature set, so an unsupported optional feature can be dropped without losing game_info/match_info.',
);

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

/**
 * Read the resolution a PNG declares in its pHYs chunk, in dots per inch.
 *
 * Returns undefined when the chunk is absent. That is not the same as 72 DPI: it
 * means no resolution is declared at all, and Overwolf's asset requirements ask
 * for "256x256 pixels with at least 72 PPI" on the store icons, so a reviewer
 * checking that line would have nothing to read.
 */
function readPngPpi(filePath) {
  const buffer = fs.readFileSync(filePath);
  let offset = 8;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString('ascii');
    if (type === 'pHYs' && length >= 9) {
      const unit = buffer.readUInt8(offset + 16);
      if (unit !== 1) return undefined;
      return buffer.readUInt32BE(offset + 8) * 0.0254;
    }
    if (type === 'IDAT' || type === 'IEND') break;
    offset += 12 + length;
  }
  return undefined;
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
