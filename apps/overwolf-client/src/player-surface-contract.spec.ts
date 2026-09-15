import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OVERLAY_MAX_HEIGHT, OVERLAY_TOP_OFFSET } from './overlay-geometry';

const desktop = readFileSync(join(__dirname, '../public/desktop.html'), 'utf8');
const overlay = readFileSync(join(__dirname, '../public/in_game.html'), 'utf8');
const manifest = JSON.parse(readFileSync(join(__dirname, '../public/manifest.json'), 'utf8'));

describe('Dynamo Lab desktop surface contract', () => {
  it('ships Dynamo Lab desktop chrome without player-facing diagnostics', () => {
    expect(desktop).toContain('<title>Dynamo Lab</title>');
    expect(desktop).toContain('id="refresh-build"');
    expect(desktop).toContain('aria-current="page"');
    expect(desktop.match(/aria-disabled="true"/g)).toHaveLength(4);
    expect(desktop).not.toMatch(/Statlocker|Decision trace|API sends|Last event/i);
  });

  it('makes future navigation unavailable and identifies the live page', () => {
    const buttons = desktop.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) ?? [];
    for (const label of ['Overview', 'Matches', 'Match Analysis', 'Settings']) {
      const button = buttons.find((markup) => markup.includes(`>${label}<`));
      expect(button).toMatch(/<button[^>]*aria-disabled="true"[^>]*\sdisabled[\s>]/);
      expect(button).toContain('Coming soon');
    }
    expect(desktop).toMatch(/<button[^>]*aria-current="page"[^>]*>[\s\S]*?Live Build[\s\S]*?<\/button>/);
  });

  it('preserves unique rendering targets and keeps the console hidden', () => {
    for (const id of [
      'status', 'indicator-dot', 'indicator-text', 'refresh-build',
      'build-title', 'guide-empty', 'guide-empty-title', 'guide-empty-copy',
      'guide-active', 'situational-recommendation-panel', 'rec-update-note',
      'rec-plan', 'ow-ad-container', 'console',
    ]) {
      expect(desktop.match(new RegExp(`id="${id}"`, 'g'))).toHaveLength(1);
    }
    expect(desktop).toMatch(/<pre\b[^>]*id="console"[^>]*hidden/);
    expect(desktop).toMatch(/id="rec-plan"[^>]*aria-label="Full build route"[^>]*data-route-limit="all"/);
    expect(desktop).toContain('Full build');
    expect(desktop).not.toMatch(/overlay-preview-plan|1 current \+ 4 next/i);
  });

  it('wires Refresh and loads item artwork before the application bundle', () => {
    expect(desktop).toContain('onclick="overwolf.windows.getMainWindow().refreshBuild?.()"');
    expect(desktop).toContain('<img src="dynamo.png" alt=""');
    expect(desktop).toMatch(/<script type="module" src="https:\/\/unpkg.com\/@deadlock-api\/ui-core@\d+\.\d+\.\d+\/dist\/main\/main.esm.js"><\/script>\s*<script src="dist\/index.js"><\/script>/);
  });
});

describe('Dynamo Lab overlay surface contract', () => {
  it('ships the compact Dynamo Lab overlay without player-facing diagnostics', () => {
    expect(overlay).toContain('<title>Dynamo Lab Overlay</title>');
    expect(overlay).toMatch(/id="rec-plan"[^>]*aria-label="Five-item purchase route"[^>]*data-route-limit="5"/);
    expect(overlay).toContain('--overlay-width: 340px');
    expect(overlay).not.toMatch(/Statlocker|Confidence|Why this move|Also viable|Compact/i);
  });

  it('keeps one rendering target per overlay state element', () => {
    for (const id of [
      'indicator-dot', 'indicator-text', 'guide-empty', 'guide-empty-title',
      'guide-empty-copy', 'guide-active', 'situational-recommendation-panel',
      'rec-update-note', 'rec-plan',
    ]) {
      expect(overlay.match(new RegExp(`id="${id}"`, 'g'))).toHaveLength(1);
    }
    expect(overlay).toMatch(/<script type="module" src="https:\/\/unpkg.com\/@deadlock-api\/ui-core@\d+\.\d+\.\d+\/dist\/main\/main.esm.js"><\/script>\s*<script src="dist\/index.js"><\/script>/);
  });

  it('keeps the overlay on a 340px grid with prominent prices and 52px artwork', () => {
    expect(overlay).toMatch(/\.item-art\s*\{[^}]*width:\s*52px/);
    expect(overlay).toMatch(/\.purchase-price\s*\{[^}]*font-size:\s*1[56]px/);
    expect(overlay).toMatch(/\.purchase-price\s*\{[^}]*font-weight:\s*600/);
    expect(overlay).toMatch(/\.purchase-price\s*\{[^}]*tabular-nums/);
    expect(overlay).toMatch(/\.purchase-category\s*\{[^}]*font-size:\s*(9|10)px/);
  });
});

describe('Dynamo Lab release manifest contract', () => {
  it('declares Dynamo Lab and the exact artwork origins', () => {
    expect(manifest.meta.name).toBe('Dynamo Lab');
    expect(manifest.meta.description).not.toMatch(/telemetry|Statlocker/i);
    expect(manifest.data.externally_connectable.matches).toEqual(expect.arrayContaining([
      'https://unpkg.com',
      'https://api.deadlock-api.com',
    ]));
  });

  it('pins declared windows, game targeting, permissions, and hotkeys', () => {
    expect(manifest.data.start_window).toBe('desktop');
    expect(Object.keys(manifest.data.windows)).toEqual(['desktop', 'in_game', 'dynamo_warning']);
    expect(manifest.data.windows.in_game.size).toEqual({
      width: 340,
      height: OVERLAY_MAX_HEIGHT,
    });
    expect(manifest.data.windows.in_game.default_position.y).toBe(OVERLAY_TOP_OFFSET);
    expect(manifest.data.game_targeting.game_ids).toEqual([24482]);
    expect(manifest.permissions).toEqual(['GameInfo', 'Hotkeys']);
    expect(Object.keys(manifest.data.hotkeys))
      .toEqual(['toggle_overlay', 'show_desktop_build', 'reset_desktop_build']);
  });
});

describe('Dynamo Lab third-party runtime dependency contract', () => {
  it('pins the Deadlock UI dependency to an exact version', () => {
    for (const surface of [desktop, overlay]) {
      const match = surface.match(/unpkg\.com\/@deadlock-api\/ui-core@([^/]+)\//);
      expect(match?.[1]).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });

  it('loads the same pinned version on both player surfaces', () => {
    const versionOf = (surface: string): string | undefined =>
      surface.match(/unpkg\.com\/@deadlock-api\/ui-core@([^/]+)\//)?.[1];
    expect(versionOf(desktop)).toBe(versionOf(overlay));
  });
});

describe('Dynamo Lab hotkey reminder contract', () => {
  it('exposes the registered hotkeys to the player', () => {
    expect(desktop).toContain('Ctrl+Tab');
    expect(overlay).toContain('Ctrl+Tab');
    expect(desktop).toContain('Ctrl+Shift+B');
  });
});
