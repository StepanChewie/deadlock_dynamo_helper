import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const clientRoot = join(__dirname, '..');
const scriptPath = join(clientRoot, 'scripts', 'configure-api-base-url.js');
const validatorPath = join(clientRoot, 'scripts', 'validate-release.js');
const script = readFileSync(scriptPath, 'utf8');
const indexSource = readFileSync(join(__dirname, 'index.ts'), 'utf8');

function literalAfter(source: string, marker: string): string {
  const match = source.match(new RegExp(`${marker}\\s*=\\s*'([^']+)'`));
  if (!match) {
    throw new Error(`could not find ${marker} in the source`);
  }
  return match[1];
}

describe('API base URL build contract', () => {
  it('searches the bundle for the origin index.ts actually compiles in', () => {
    // The substitution is a plain string replace, so these two must match
    // exactly. A divergence makes the search find nothing, and the failure
    // surfaces as "the bundle did not contain the expected API URL" - which
    // names the wrong cause. This test names the right one.
    expect(literalAfter(script, 'BUNDLE_SOURCE_API_BASE_URL')).toBe(
      literalAfter(indexSource, 'const apiBaseUrl'),
    );
  });

  it('has no silent fallback origin', () => {
    // The whole point of PR 10. `process.env.OVERWOLF_API_BASE_URL || 'https://...'`
    // is how a forgotten variable used to produce a working-looking build
    // pointing at whatever the literal happened to be.
    expect(script).not.toMatch(/process\.env\.OVERWOLF_API_BASE_URL\s*\|\|/);
  });

  it('refuses to build without OVERWOLF_API_BASE_URL', () => {
    // Behavioural, not structural: the script is run for real. It throws before
    // it writes anything - the check sits above the dist rewrite and the
    // manifest update - so this cannot corrupt the working tree.
    for (const value of ['', '   ']) {
      const result = spawnSync(process.execPath, [scriptPath], {
        env: { ...process.env, OVERWOLF_API_BASE_URL: value },
        encoding: 'utf8',
      });

      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toMatch(/OVERWOLF_API_BASE_URL is required/);
    }
  });

  it('keeps the packaged-origin guard in the release validator', () => {
    // Structural, and deliberately narrow. It catches the guard being deleted or
    // emptied, which a plain "the constant exists" check would not - the
    // guard's *behaviour* is covered by the test below.
    const validator = readFileSync(validatorPath, 'utf8');
    const declaration = validator.match(/RESERVED_API_HOST_SUFFIXES = \[([^\]]*)\]/);

    expect(declaration).not.toBeNull();
    for (const suffix of ['.invalid', '.example', '.test', '.localhost']) {
      expect(declaration?.[1]).toContain(`'${suffix}'`);
    }
  });

  it('rejects a packaged build pointing at a placeholder origin', () => {
    // The guard is exercised rather than inspected. A structural assertion only
    // proves the check still exists: deleting the call site while leaving the
    // constant in place kept the suite green.
    //
    // The manifest is tracked, so it is restored in a finally block and the
    // restoration is itself asserted.
    const manifestPath = join(clientRoot, 'public', 'manifest.json');
    const original = readFileSync(manifestPath, 'utf8');

    try {
      const manifest = JSON.parse(original);
      manifest.data.externally_connectable.matches = [
        'https://api.invalid',
        ...manifest.data.externally_connectable.matches.slice(1),
      ];
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

      const result = spawnSync(process.execPath, [validatorPath], { encoding: 'utf8' });

      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toMatch(/placeholder origin/);
    } finally {
      writeFileSync(manifestPath, original);
    }

    expect(readFileSync(manifestPath, 'utf8')).toBe(original);
  });
});
