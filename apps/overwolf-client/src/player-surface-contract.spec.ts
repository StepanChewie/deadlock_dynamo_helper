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
    // No sidebar entry is a placeholder. A disabled "Coming soon" item is a
    // promise the app does not keep, so there are none left to assert.
    expect(desktop).not.toContain('aria-disabled');
    expect(desktop).not.toMatch(/Coming soon/i);
    expect(desktop).not.toMatch(/Statlocker|Decision trace|API sends|Last event/i);
  });

  it('offers only navigation that works and identifies the live page', () => {
    const buttons = desktop.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) ?? [];

    for (const [label, workspace] of [['Live Build', 'build'], ['Settings', 'settings']] as const) {
      const button = buttons.find((markup) => markup.includes(`>${label}<`));
      expect(button).toBeDefined();
      expect(button).not.toMatch(/\sdisabled[\s>]/);
      expect(button).toContain(`showWorkspace?.('${workspace}')`);
    }

    expect(desktop).toMatch(/<button[^>]*aria-current="page"[^>]*>[\s\S]*?Live Build[\s\S]*?<\/button>/);
    expect(desktop).toMatch(/<section id="settings-workspace"[^>]*hidden/);
  });

  it('exposes the overlay preference and the live hotkey in Settings', () => {
    expect(desktop).toContain('id="setting-overlay-auto-show"');
    expect(desktop).toContain('setOverlayAutoShow?.(this.checked)');
    expect(desktop).toContain('openHotkeySettings?.()');
    // Asserted by name as well as by the generic handler sweep: that sweep
    // derives its names *from* the markup, so deleting this whole row would
    // shrink the sweep's input and still pass.
    expect(desktop).toContain('resetBuildWindowPosition?.()');
    // Deliberately not an `<a href="overwolf://...">`: the windows declare
    // `block_top_window_navigation` and `popup_blocker`, so an in-app link is
    // blocked on purpose and would silently do nothing.
    expect(desktop).not.toMatch(/<a\b[^>]*overwolf:\/\//);
  });

  it('keeps the Settings status group fully wired to rendering targets', () => {
    const status = desktop.match(/<dl class="settings-status">[\s\S]*?<\/dl>/)?.[0] ?? '';
    expect(status).not.toBe('');

    const cells = status.match(/<dd\b[^>]*>/g) ?? [];
    expect(cells).toHaveLength(8);
    for (const cell of cells) {
      expect(cell).toMatch(/id="setting-[a-z-]+"/);
    }
  });

  it('defines every main-window handler the desktop markup invokes', () => {
    // The markup calls handlers defensively (`handler?.()`), so a name that does
    // not exist is a silent no-op - a button that looks wired and does nothing.
    const source = readFileSync(join(__dirname, 'index.ts'), 'utf8');
    const invoked = new Set(
      [...desktop.matchAll(/getMainWindow\(\)\.([A-Za-z0-9_]+)\?\./g)].map((m) => m[1]),
    );
    expect(invoked.size).toBeGreaterThan(0);

    for (const name of invoked) {
      expect(source).toMatch(new RegExp(`mainWindow\\.${name}\\s*=`));
    }
  });

  it('restates [hidden] for every switchable panel', () => {
    // `display: flex` outranks the user-agent `[hidden]` rule, so a panel
    // without this override stays on screen after being told to hide.
    for (const panel of ['build-workspace', 'settings-workspace']) {
      expect(desktop).toMatch(
        new RegExp(`\\.${panel}\\[hidden\\][^{]*\\{[^}]*display:\\s*none`),
      );
    }
  });

  it('does not promise monitor targeting the app cannot perform', () => {
    // The reset hotkey used to be titled "Reset Full Build Window to Primary
    // Monitor" while the handler only restored and focused. Overwolf's monitor
    // enumeration needs the `DesktopStreaming` permission, which this app does
    // not declare, so the copy has to describe what actually happens: bringing
    // the window back into view. Asserted as a prohibition, not as an exact
    // string, so improving the wording is still allowed.
    const titles = Object.values(manifest.data.hotkeys as Record<string, { title: string }>)
      .map((hotkey) => hotkey.title)
      .join('\n');

    expect(titles).not.toMatch(/primary monitor/i);
    expect(manifest.data.hotkeys.reset_desktop_build.title).toMatch(/position/i);
  });

  it('preserves unique rendering targets and keeps the console hidden', () => {
    for (const id of [
      'status', 'indicator-dot', 'indicator-text', 'refresh-build',
      'build-title', 'guide-empty', 'guide-empty-title', 'guide-empty-copy',
      'guide-active', 'situational-recommendation-panel', 'rec-update-note',
      'rec-plan', 'ow-ad-container', 'console',
      'build-workspace', 'settings-workspace', 'nav-build', 'nav-settings',
      'hint-hotkey-toggle', 'hint-hotkey-desktop',
      'setting-overlay-auto-show', 'setting-hotkey',
      'setting-app-version', 'setting-backend-status', 'setting-gep-status',
      'setting-gep-version', 'setting-gep-features', 'setting-gep-snapshot',
      'setting-recommendation-status', 'setting-route-age',
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

  it('offers a diagnostics copy action without exposing raw telemetry', () => {
    expect(desktop).toContain('id="support"');
    expect(desktop).toContain('id="diagnostic-summary"');
    expect(desktop).toContain('copyDiagnostics');
  });

  it('links to the support channel', () => {
    expect(desktop).toMatch(/discord\.gg\//);
    expect(desktop).toMatch(/privacy/i);
  });

  it('links to the published privacy policy and terms', () => {
    expect(desktop).toMatch(/docs\/privacy\.md/);
    expect(desktop).toMatch(/docs\/terms\.md/);
  });

  it('insets every horizontal band to the same column', () => {
    const horizontal = (shorthand: string | undefined): string => {
      const parts = (shorthand ?? '').trim().split(/\s+/).filter(Boolean);
      return parts[1] ?? parts[0] ?? '';
    };

    const insetOf = (selector: string, property: 'padding' | 'margin'): string => {
      const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const rule = desktop.match(new RegExp(`${escaped}\\s*\\{[^}]*\\}`))?.[0] ?? '';
      return horizontal(rule.match(new RegExp(`${property}:\\s*([^;]+);`))?.[1]);
    };

    const contentInset = insetOf('.build-workspace', 'padding');
    expect(contentInset).not.toBe('');

    // Everything stacked in the workspace column must share one inset, or the
    // panels visibly step in and out against each other. Both workspaces, and
    // the bands above them, sit on that same column.
    expect(insetOf('.settings-workspace', 'padding')).toBe(contentInset);
    expect(insetOf('.topbar', 'padding')).toBe(contentInset);
    expect(insetOf('.hotkey-hint', 'padding')).toBe(contentInset);

    // Support now lives inside the settings column, so it must not inset itself
    // a second time on top of the padding it already sits in.
    expect(insetOf('.support', 'margin')).toBe('0');
  });

  it('states what leaves the machine without over-claiming', () => {
    expect(desktop).toMatch(/Steam ID/i);
    expect(desktop).toMatch(/no account|without an account/i);
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
    // `start_position`, not `default_position`: the latter is not an Overwolf
    // property at all, so asserting it proved nothing while the offset was in
    // fact never applied. See the manifest schema check.
    expect(manifest.data.windows.in_game.start_position.top).toBe(OVERLAY_TOP_OFFSET);
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
    expect(desktop).toContain('Ctrl+Shift+D');
    expect(overlay).toContain('Ctrl+Shift+D');
    expect(desktop).toContain('Ctrl+Shift+B');
  });

  it('does not advertise the retired toggle binding', () => {
    expect(desktop).not.toMatch(/Ctrl\+Tab/i);
    expect(overlay).not.toMatch(/Ctrl\+Tab/i);
  });
});
