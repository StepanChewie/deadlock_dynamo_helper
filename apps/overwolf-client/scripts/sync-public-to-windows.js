const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const source = path.resolve(__dirname, '..', 'public');
const target = process.env.OVERWOLF_PUBLIC_TARGET || '/mnt/c/Users/Chewbacca/Desktop/123/overwolf-client/public';

/**
 * True when the target game process is up.
 *
 * Informational only. Overwolf reloads the app when these files change, and a
 * reload mid-match re-registers GEP required features during a live session.
 * The build is never blocked for it — the app gets relaunched anyway — but the
 * reminder is worth printing. Returns false when the check is unavailable, so
 * non-Windows hosts still build.
 */
function isGameRunning() {
  try {
    const output = execSync('tasklist.exe /FI "IMAGENAME eq deadlock.exe"', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return /deadlock\.exe/i.test(output);
  } catch {
    return false;
  }
}

function copyDirectory(src, dest) {
  fs.mkdirSync(dest, { recursive: true });

  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDirectory(srcPath, destPath);
      continue;
    }

    if (entry.isFile()) {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

if (!fs.existsSync(source)) {
  throw new Error(`Overwolf public source does not exist: ${source}`);
}

if (isGameRunning()) {
  console.warn(
    'Note: Deadlock is running — Overwolf reloads the app when these files change, '
    + 'so relaunch it before the next match.',
  );
}

copyDirectory(source, target);
console.log(`Synced Overwolf public files to ${target}`);
