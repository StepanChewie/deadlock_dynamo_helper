const fs = require('fs');
const path = require('path');

const DEFAULT_API_BASE_URL = 'https://aboba-telegramovich.duckdns.org';
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

const apiBaseUrl = normalizeApiBaseUrl(
  process.env.OVERWOLF_API_BASE_URL || DEFAULT_API_BASE_URL,
);
const apiOrigin = new URL(apiBaseUrl).origin;

let replacementCount = 0;
for (const filePath of listJavaScriptFiles(distDir)) {
  const source = fs.readFileSync(filePath, 'utf8');
  const configured = source.split(DEFAULT_API_BASE_URL).join(apiBaseUrl);
  if (configured !== source) {
    replacementCount += source.split(DEFAULT_API_BASE_URL).length - 1;
    fs.writeFileSync(filePath, configured);
  }
}

if (apiBaseUrl !== DEFAULT_API_BASE_URL && replacementCount === 0) {
  throw new Error(
    `The compiled Overwolf bundle did not contain the expected API URL ${DEFAULT_API_BASE_URL}.`,
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
