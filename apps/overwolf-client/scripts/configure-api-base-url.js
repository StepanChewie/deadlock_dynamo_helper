const fs = require('fs');
const path = require('path');

// The origin that `src/index.ts` compiles into the bundle.
//
// This is a *search string* for the substitution below, not a fallback. It used
// to double as the default when OVERWOLF_API_BASE_URL was unset, which meant a
// forgotten variable produced a working-looking build pointing at whatever this
// literal happened to be - the failure mode PR 10 exists to remove. The two
// roles are now separate and there is no default at all.
//
// It must stay byte-identical to the `apiBaseUrl` literal in src/index.ts:
// a divergence would make the search match nothing, and
// `src/api-base-url-contract.spec.ts` fails first, naming the cause.
const BUNDLE_SOURCE_API_BASE_URL = 'https://aboba-telegramovich.duckdns.org';
// Origins the shipped app must keep reachable: the Deadlock UI artwork module,
// its asset API, and the fonts used by the standalone warning window.
const RETAINED_ORIGIN_PATTERNS = [
  /fonts\.googleapis\.com/,
  /fonts\.gstatic\.com/,
  /unpkg\.com/,
  /api\.deadlock-api\.com/,
];
const appRoot = path.resolve(__dirname, '..');
const publicDir = path.join(appRoot, 'public');
const distDir = path.join(publicDir, 'dist');
const manifestPath = path.join(publicDir, 'manifest.json');

// Required, deliberately. A default here is how a build ends up pointing at the
// wrong host with nothing failing - see docs/roadmap.md section 6, decision 3.
// The release procedure sets it explicitly; see docs/overwolf-production-release.md.
const requestedApiBaseUrl = String(process.env.OVERWOLF_API_BASE_URL ?? '').trim();
if (!requestedApiBaseUrl) {
  throw new Error(
    'OVERWOLF_API_BASE_URL is required for an Overwolf client build. There is '
    + 'no default origin on purpose: a forgotten variable used to produce a '
    + 'working-looking build pointing at whatever the literal happened to be. '
    + 'Set it to the origin this build should talk to - the production API '
    + 'origin for a release. For a bundle aimed at a local origin, note that '
    + '`yarn build` also runs the store-ready validation, which rejects '
    + 'localhost: use `yarn build:bundle` then `yarn configure:api` instead.',
  );
}

const apiBaseUrl = normalizeApiBaseUrl(requestedApiBaseUrl);
const apiOrigin = new URL(apiBaseUrl).origin;

let replacementCount = 0;
for (const filePath of listJavaScriptFiles(distDir)) {
  const source = fs.readFileSync(filePath, 'utf8');
  const configured = source.split(BUNDLE_SOURCE_API_BASE_URL).join(apiBaseUrl);
  if (configured !== source) {
    replacementCount += source.split(BUNDLE_SOURCE_API_BASE_URL).length - 1;
    fs.writeFileSync(filePath, configured);
  }
}

if (apiBaseUrl !== BUNDLE_SOURCE_API_BASE_URL && replacementCount === 0) {
  throw new Error(
    `The compiled Overwolf bundle did not contain the expected API URL ${BUNDLE_SOURCE_API_BASE_URL}.`,
  );
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const existingMatches = Array.isArray(manifest.data?.externally_connectable?.matches)
  ? manifest.data.externally_connectable.matches
  : [];
const retainedMatches = existingMatches.filter(
  (value) =>
    typeof value === 'string' &&
    RETAINED_ORIGIN_PATTERNS.some((pattern) => pattern.test(value)),
);
manifest.data.externally_connectable = {
  matches: [apiOrigin, ...retainedMatches],
};
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(
  `Configured Overwolf API base URL ${apiBaseUrl} (${replacementCount} bundle replacements).`,
);

function normalizeApiBaseUrl(value) {
  const normalized = String(value).trim().replace(/\/+$/, '');
  const url = new URL(normalized);
  const isLocalHttp =
    url.protocol === 'http:' &&
    (url.hostname === 'localhost' || url.hostname === '127.0.0.1');

  if (url.protocol !== 'https:' && !isLocalHttp) {
    throw new Error('OVERWOLF_API_BASE_URL must use HTTPS outside localhost.');
  }
  if (url.search || url.hash) {
    throw new Error('OVERWOLF_API_BASE_URL must not contain query parameters or a fragment.');
  }

  return normalized;
}

function listJavaScriptFiles(directory) {
  if (!fs.existsSync(directory)) {
    throw new Error(`Compiled Overwolf directory does not exist: ${directory}`);
  }

  const result = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      result.push(...listJavaScriptFiles(entryPath));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      result.push(entryPath);
    }
  }
  return result;
}
