const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const source = path.resolve(__dirname, '..', 'public');
const target = process.env.OVERWOLF_PUBLIC_TARGET || '/mnt/c/Users/Chewbacca/Desktop/123/overwolf-client/public';

/**
 * True when the target game process is up.
 *
 * Writing into the live app folder while a match is running makes Overwolf
 * reload the app mid-session, which re-registers GEP required features in the
 * middle of a match. That is the one way a build can disturb live game data, so
 * refuse rather than risk it. Returns false when the check is unavailable, so
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

if (isGameRunning() && process.env.OVERWOLF_ALLOW_LIVE_SYNC !== '1') {
  throw new Error(
    'Deadlock is running. Syncing now would make Overwolf reload the app mid-match '
    + 'and re-register GEP features during a live session.\n'
    + 'Close Deadlock and build again, or set OVERWOLF_ALLOW_LIVE_SYNC=1 to override.',
  );
}

copyDirectory(source, target);
console.log(`Synced Overwolf public files to ${target}`);
