import { LiveEventBuffer } from './overwolf/live-event-buffer';
import {
  listenOverwolfEvents,
  readGepPhase,
  readGepSnapshotShape,
  readGepVersion,
} from './overwolf/listen-overwolf-events';
import { setRequiredFeatures } from './overwolf/set-required-features';
import { isSuccessfulOverwolfResult } from './overwolf/window-result';
import { InGameOverlayLifecycle } from './overwolf/in-game-overlay-lifecycle';
import {
  resolveWindowPlacement,
  type WindowSize,
  type WorkArea,
} from './overwolf/window-placement';
import { PREFERENCE_KEYS, persistPreference, readPreference } from './player-preferences';
import * as ui from './ui';
import { AdaptiveRecommendationClient } from './adaptive-recommendation-client';
import { didAdaptiveMatchChange } from './adaptive-match-transition';
import { APP_VERSION } from './app-version';
import {
  OVERLAY_MAX_HEIGHT,
  OVERLAY_MIN_HEIGHT,
} from './overlay-geometry';

const clientId = `client-${Math.random().toString(36).substring(2, 8)}`;
const apiBaseUrl = 'https://aboba-telegramovich.duckdns.org';
/**
 * Deep link into Overwolf's Overlay & Hotkeys window, focused on the in-game
 * overlay binding. The `hotkey` value must be the manifest hotkey name; the
 * link cannot reach Overwolf's own hotkeys or another app's.
 */
const HOTKEY_SETTINGS_URL = 'overwolf://settings/games-overlay?hotkey=toggle_overlay';
const ow = (window as any).overwolf;

if (ow?.windows) {
  ow.windows.getCurrentWindow((windowResult: any) => {
    if (!isSuccessfulOverwolfResult(windowResult) || !windowResult.window) {
      ui.logConsole('Failed to resolve the current Overwolf window.');
      return;
    }

    if (windowResult.window.name === 'in_game') {
      initializeInGameWindow(windowResult.window.id);
      return;
    }

    initializeBackgroundWindow();
  });
}

function initializeInGameWindow(windowId: string): void {
  ui.logConsole('In-game Dynamo Lab overlay loaded.');

  const mainWindow = ow.windows.getMainWindow() as any;

  const ensureOverlayHeight = (): void => {
    const hud = document.querySelector('.hud-container') as HTMLElement | null;
    if (!hud) {
      return;
    }

    requestAnimationFrame(() => {
      const contentHeight = Math.ceil(hud.scrollHeight + 24);
      const targetHeight = Math.max(
        OVERLAY_MIN_HEIGHT,
        Math.min(OVERLAY_MAX_HEIGHT, contentHeight),
      );
      ow.windows.changeSize(windowId, 340, targetHeight);
    });
  };

  (window as any).ensureOverlayHeight = ensureOverlayHeight;
  (window as any).dismissHotkeyHint = ui.dismissHotkeyHint;
  ui.applyStoredPreferences();

  mainWindow.inGameAdaptiveUpdate = (data: any): void => {
    if (data) {
      ui.updateIndicator('Connected', true);
      ui.showAdaptiveRecommendation(data);
    } else {
      ui.updateIndicator('Waiting', false);
      ui.hideSituationalPanel();
    }
    ensureOverlayHeight();
  };

  mainWindow.inGameAdaptiveError = (message: string): void => {
    ui.updateIndicator('Reconnecting', false);
    ui.showAdaptiveError(message);
    ensureOverlayHeight();
  };

  if (mainWindow.latestAdaptiveRecommendation) {
    mainWindow.inGameAdaptiveUpdate(mainWindow.latestAdaptiveRecommendation);
  }
  if (mainWindow.latestAdaptiveError) {
    mainWindow.inGameAdaptiveError(mainWindow.latestAdaptiveError);
  }

  const setupDrag = (): void => {
    const container = document.querySelector('.hud-container');
    if (!container) {
      return;
    }

    container.addEventListener('mousedown', (event: any) => {
      if (
        event.target?.tagName === 'BUTTON' ||
        event.target?.closest?.('button')
      ) {
        return;
      }
      ow.windows.dragMove(windowId);
    });

    setTimeout(ensureOverlayHeight, 500);
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setupDrag, { once: true });
  } else {
    setupDrag();
  }
}

function initializeBackgroundWindow(): void {
  ui.logConsole(`Initializing background controller for clientId: ${clientId}`);

  const mainWindow = ow.windows.getMainWindow() as any;
  mainWindow.latestAdaptiveRecommendation = mainWindow.latestAdaptiveRecommendation || null;
  mainWindow.latestAdaptiveError = mainWindow.latestAdaptiveError || null;
  mainWindow.dismissHotkeyHint = ui.dismissHotkeyHint;
  mainWindow.advanceFirstRunGuide = ui.advanceFirstRunGuide;
  mainWindow.dismissFirstRunGuide = ui.dismissFirstRunGuide;
  mainWindow.copyDiagnostics = (): void => {
    void ui.copyDiagnostics();
  };
  mainWindow.openExternal = ui.openExternal;
  mainWindow.showWorkspace = ui.showWorkspace;
  /**
   * Opens Overwolf's own Overlay & Hotkeys window, focused on our binding.
   *
   * The documented mechanism is the `overwolf://settings/games-overlay` URL.
   * It goes out through `openExternal` rather than as an `<a href>`: every
   * window declares `block_top_window_navigation` and `popup_blocker`, so an
   * in-app link is blocked on purpose and would silently do nothing.
   */
  mainWindow.openHotkeySettings = (): void => {
    ui.openExternal(HOTKEY_SETTINGS_URL);
  };
  mainWindow.resetBuildWindowPosition = resetDesktopBuildWindow;
  /**
   * Persists the Settings toggle and re-reads it back into the checkbox.
   *
   * The re-read is not decoration: the write coerces its input to a real
   * boolean, and the box should show what was stored rather than what was
   * clicked.
   */
  mainWindow.setOverlayAutoShow = (enabled: boolean): void => {
    persistPreference(PREFERENCE_KEYS.overlayAutoShow, enabled === true);
    ui.syncOverlayAutoShowPreference();
  };
  mainWindow.revealPostMatchReasons = ui.revealPostMatchReasons;
  mainWindow.dismissPostMatchFeedback = ui.dismissPostMatchFeedback;
  mainWindow.answerPostMatchFeedback = (useful: boolean, reason?: string): void => {
    ui.hidePostMatchFeedback();
    if (!feedbackMatchId) {
      return;
    }

    void fetch(`${apiBaseUrl}/deadlock/adaptive/v1/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        appVersion: APP_VERSION,
        matchId: feedbackMatchId,
        useful,
        reason,
      }),
    }).catch((error) => {
      ui.logConsole(`Feedback submission failed: ${error?.message || error}`);
    });
  };
  ui.applyStoredPreferences();

  registerWindowHotkeys(mainWindow);
  watchHotkeyBindings();

  const customFetch = async (
    url: string,
    init?: RequestInit,
  ): Promise<Response> => {
    try {
      const response = await fetch(url, init);
      if (response.ok) {
        ui.incrementSends();
        ui.updateIndicator('Connected', true);
        ui.updateDiagnosticContext({ backendStatus: `HTTP ${response.status}` });
      } else {
        ui.logConsole(`Ingest error: HTTP ${response.status}`);
        ui.updateIndicator('Connection issue', false);
        ui.updateDiagnosticContext({ backendStatus: `HTTP ${response.status}` });
      }
      return response;
    } catch (error: any) {
      ui.logConsole(`Network error: ${error?.message || error}`);
      ui.updateIndicator('Offline', false);
      ui.updateDiagnosticContext({ backendStatus: 'unreachable' });
      throw error;
    }
  };

  const adaptiveClient = new AdaptiveRecommendationClient(apiBaseUrl, customFetch, 1500);
  let currentMatchId = readString((globalThis as any).__deadlockLiveMatchId);
  let currentLocalSteamId = '';
  let feedbackMatchId = '';
  const inGameOverlayLifecycle = new InGameOverlayLifecycle(
    restoreInGameOverlayWindow,
    // Read on every match, not cached: the player can change it in Settings
    // while the app is running. Defaults to false, so the overlay does not put
    // itself on screen until Overwolf confirms that is allowed.
    () => readPreference(PREFERENCE_KEYS.overlayAutoShow, false),
  );
  inGameOverlayLifecycle.sync(currentMatchId);

  const publishAdaptiveRecommendation = (data: any): void => {
    ui.setRefreshPending(false);
    mainWindow.latestAdaptiveRecommendation = data;
    mainWindow.latestAdaptiveError = null;

    if (data) {
      ui.showAdaptiveRecommendation(data);
    } else {
      ui.hideSituationalPanel();
    }

    ui.updateDiagnosticContext({
      matchId: data?.lock?.matchId ?? currentMatchId ?? undefined,
      heroId: data?.heroId != null ? String(data.heroId) : undefined,
      recommendationStatus: data ? (data.ready ? 'READY' : 'NOT_READY') : 'NO_MATCH',
      archetype: data?.lock?.archetypeId,
      rulesetVersion: data?.evidence?.rulesetVersion,
      catalogSha256: data?.evidence?.catalogSha256,
      lastError: undefined,
    });

    mainWindow.inGameAdaptiveUpdate?.(data);
  };

  const publishAdaptiveError = (error: Error): void => {
    ui.setRefreshPending(false);
    const message = error.message || 'Adaptive recommendation unavailable';
    mainWindow.latestAdaptiveError = message;
    ui.showAdaptiveError(message);
    ui.updateDiagnosticContext({ recommendationStatus: 'ERROR', lastError: message });
    mainWindow.inGameAdaptiveError?.(message);
  };

  /**
   * Ages the route on screen while the client is failing.
   *
   * `showAdaptiveError` runs on each failed attempt, but the retry loop stops
   * when a match ends — without this, the last note would stay frozen on screen
   * past the point where the route should have been hidden. Only a displayed
   * route is re-evaluated: with nothing on screen there is nothing to expire,
   * and re-running the empty state would overwrite the Overwolf-degraded copy.
   */
  const RECOMMENDATION_FRESHNESS_POLL_MS = 5_000;
  setInterval(() => {
    // Only while Settings is on screen. These are live readings, and writing
    // them into a hidden panel is work nobody ever sees.
    if (ui.readActiveWorkspace() === 'settings') {
      ui.renderSettingsStatus();
    }

    if (!mainWindow.latestAdaptiveError || !ui.hasRecommendationOnScreen()) {
      return;
    }

    ui.showAdaptiveError(mainWindow.latestAdaptiveError);
  }, RECOMMENDATION_FRESHNESS_POLL_MS);

  const scheduleAdaptiveRecommendation = (force = false): void => {
    if (!currentMatchId) {
      adaptiveClient.cancel();
      publishAdaptiveRecommendation(null);
      return;
    }

    adaptiveClient.schedule(
      {
        matchId: currentMatchId,
        localSteamId: currentLocalSteamId || undefined,
      },
      {
        onResult: publishAdaptiveRecommendation,
        onError: (error) => {
          ui.logConsole(`Failed to fetch adaptive recommendation: ${error.message}`);
          publishAdaptiveError(error);
        },
      },
      force,
    );
  };

  mainWindow.refreshBuild = (): void => {
    ui.setRefreshPending(true);
    scheduleAdaptiveRecommendation(true);
  };
  mainWindow.forceLiveBuildRecommendationRefresh = (): void => scheduleAdaptiveRecommendation(true);

  const buffer = new LiveEventBuffer(
    clientId,
    apiBaseUrl,
    customFetch,
    1000,
    () => currentMatchId || undefined,
    () => scheduleAdaptiveRecommendation(true),
  );

  const register = async (): Promise<void> => {
    try {
      ui.updateStatus('Connecting', 'init');
      const features = await setRequiredFeatures();
      ui.updateStatus('Ready', 'connected');
      // Clear any earlier registration failure. Without this, an app that was
      // started before the game keeps reporting "Not in a game" long after it
      // recovered, which reads like a live fault.
      ui.updateDiagnosticContext({
        // Name the shortfall instead of reporting a bare REGISTERED: a feature
        // the game does not expose is dropped silently by Overwolf, and the
        // only symptom is missing data further down the pipeline.
        gepStatus: features.degraded
          ? `REGISTERED without ${features.rejected.join(', ')}`
          : 'REGISTERED',
        gepFeatures: features.registered.join(','),
        lastError: undefined,
      });
      ui.logConsole(
        `Successfully registered GEP required features: ${features.registered.join(', ')}`,
      );
      if (features.degradedReason) {
        ui.logConsole(
          `Fell back to the core GEP feature set (${features.degradedReason})`,
        );
      }

      listenOverwolfEvents((event) => {
        const eventDetails = `Source: ${event.source} | Key: ${event.key || 'n/a'} | Cat: ${event.category || 'n/a'}`;
        ui.updateLastEvent(eventDetails);
        ui.updateDiagnosticContext({
          gepPhase: readGepPhase(),
          gepSnapshot: readGepSnapshotShape(),
          gepVersion: readGepVersion(),
        });

        if (readGepPhase()) {
          gepEventsWithoutPhase = 0;
          ui.setGameEventsDegraded(false);
        } else if (gepEventsWithoutPhase < GEP_DEGRADED_EVENT_THRESHOLD) {
          gepEventsWithoutPhase += 1;
          if (gepEventsWithoutPhase >= GEP_DEGRADED_EVENT_THRESHOLD) {
            ui.setGameEventsDegraded(true);
          }
        }

        const previousMatchId = currentMatchId;
        const context = extractAdaptiveContext(event);

        if (context.matchId) {
          if (didAdaptiveMatchChange(previousMatchId, context.matchId)) {
            adaptiveClient.cancel();
            currentLocalSteamId = '';
            publishAdaptiveRecommendation(null);
          }
          currentMatchId = context.matchId;
          mainWindow.__deadlockLiveMatchId = currentMatchId;
          (globalThis as any).__deadlockLiveMatchId = currentMatchId;
          inGameOverlayLifecycle.sync(currentMatchId);
        }

        if (context.localSteamId) {
          currentLocalSteamId = context.localSteamId;
        }

        if (context.matchEnded) {
          if (currentMatchId) {
            feedbackMatchId = currentMatchId;
            ui.showPostMatchFeedback();
          }
          currentMatchId = '';
          currentLocalSteamId = '';
          mainWindow.__deadlockLiveMatchId = undefined;
          (globalThis as any).__deadlockLiveMatchId = undefined;
          inGameOverlayLifecycle.sync('');
          adaptiveClient.cancel();
          publishAdaptiveRecommendation(null);
        }

        buffer.push(event);

        if (!context.matchEnded && currentMatchId) {
          scheduleAdaptiveRecommendation(previousMatchId === currentMatchId);
        }
      });

      watchGameLifecycle(() => {
        void register();
      });
    } catch (error: any) {
      ui.updateStatus('Unavailable', 'error');
      ui.updateDiagnosticContext({ gepStatus: 'FAILED', lastError: String(error?.message || error) });
      ui.logConsole(
        `GEP feature registration failed: ${error?.message || error}. Retrying in 5s...`,
      );
      setTimeout(() => {
        void register();
      }, 5000);
    }
  };

  void register();
}

let gameLifecycleWatched = false;

/**
 * Counts GEP events that arrived without `game_info.phase`.
 *
 * A healthy Deadlock GEP always reports `phase`, even between matches. When it
 * is missing while `steam_id` still arrives, Overwolf's game plugin has failed
 * to attach — the app then receives no `match_info`, so no match id, so nothing
 * can be recommended. Roughly a minute of that is a fault worth reporting.
 */
let gepEventsWithoutPhase = 0;
const GEP_DEGRADED_EVENT_THRESHOLD = 20;

/**
 * Re-requests GEP features whenever a game launches.
 *
 * Registering while no game is running can report success yet leave the feature
 * set unbound. The only visible symptom is a GEP snapshot that carries nothing
 * but `game_info.steam_id`, so the match id never arrives and both the overlay
 * and the recommendation stay silent with no error anywhere. Overwolf answers
 * `Not in a game` for exactly that case, which is how this was found.
 */
function watchGameLifecycle(onGameStarted: () => void): void {
  if (gameLifecycleWatched) {
    return;
  }

  try {
    const games = (globalThis as any).overwolf?.games;
    if (typeof games?.onGameLaunched?.addListener !== 'function') {
      return;
    }

    gameLifecycleWatched = true;
    games.onGameLaunched.addListener(() => {
      onGameStarted();
    });
  } catch {
    // Overwolf API unavailable; the initial registration still stands.
  }
}

function restoreInGameOverlayWindow(
  onComplete: (success: boolean) => void,
): void {
  ow.windows.obtainDeclaredWindow('in_game', (result: any) => {
    if (!isSuccessfulOverwolfResult(result) || !result.window?.id) {
      ui.logConsole('Failed to obtain the in_game overlay window.');
      onComplete(false);
      return;
    }

    ow.windows.restore(result.window.id, (restoreResult: any) => {
      if (!isSuccessfulOverwolfResult(restoreResult)) {
        const error = restoreResult?.error || restoreResult?.status || 'unknown error';
        ui.logConsole(`Failed to restore the in_game overlay window: ${error}`);
        onComplete(false);
        return;
      }

      ui.logConsole('In-game HUD overlay activated for live match.');
      onComplete(true);
    });
  });
}

function registerWindowHotkeys(mainWindow: any): void {
  ow.settings?.hotkeys?.onPressed?.addListener((info: any) => {
    if (info?.name === 'toggle_overlay') {
      ui.logConsole('Hotkey toggle_overlay pressed.');
      toggleInGameOverlayWindow();
      return;
    }

    if (info?.name === 'show_desktop_build') {
      ui.logConsole('Hotkey show_desktop_build pressed.');
      showDesktopBuildWindow(mainWindow, true);
      return;
    }

    if (info?.name === 'reset_desktop_build') {
      ui.logConsole('Hotkey reset_desktop_build pressed.');
      resetDesktopBuildWindow();
    }
  });
}

/** The display the window is currently on, as reported by the DOM Screen API. */
function readWorkArea(): WorkArea {
  // `globalThis.screen` is the DOM `Screen` interface, which does not declare
  // `availLeft`/`availTop`; go through `unknown` rather than widening the cast.
  const view = (globalThis as unknown as { screen?: Record<string, unknown> }).screen;
  return {
    left: typeof view?.availLeft === 'number' ? view.availLeft : 0,
    top: typeof view?.availTop === 'number' ? view.availTop : 0,
    width: typeof view?.availWidth === 'number' ? view.availWidth : 0,
    height: typeof view?.availHeight === 'number' ? view.availHeight : 0,
  };
}

/** The window's own size, or null when the platform does not report it. */
function readWindowSize(): WindowSize | null {
  const view = globalThis as unknown as { outerWidth?: unknown; outerHeight?: unknown };
  if (typeof view.outerWidth !== 'number' || typeof view.outerHeight !== 'number') {
    return null;
  }

  return { width: view.outerWidth, height: view.outerHeight };
}

/**
 * Brings the build window back onto a visible display.
 *
 * Deliberately *not* "move it to the primary monitor", which is what the hotkey
 * used to claim. Overwolf's monitor enumeration needs the `DesktopStreaming`
 * permission, and this app declares only `GameInfo` and `Hotkeys` — taking a
 * screen-capture-sounding permission for a window-reset key is not a trade
 * worth making. The DOM Screen API already reports the working area of the
 * display the window is on, which is what recovery actually needs.
 *
 * The move is best-effort. If the work area is unusable, or `changePosition` is
 * unavailable, the window is still restored and focused — exactly the old
 * behaviour — so the hotkey never does nothing.
 */
function resetDesktopBuildWindow(): void {
  ow.windows.obtainDeclaredWindow('desktop', (result: any) => {
    if (!isSuccessfulOverwolfResult(result) || !result.window?.id) {
      ui.logConsole('Failed to obtain the desktop build window for resetting.');
      return;
    }

    const windowId = result.window.id;

    const settle = (): void => {
      // Restore after moving: a minimized window would otherwise be moved and
      // left minimized, which reads as "the reset did nothing".
      ow.windows.restore(windowId, () => {
        if (typeof ow.windows.bringToFront === 'function') {
          ow.windows.bringToFront(windowId, true, () => {});
        }
      });
    };

    const placement = resolveWindowPlacement(readWorkArea(), readWindowSize());
    if (!placement || typeof ow.windows.changePosition !== 'function') {
      settle();
      return;
    }

    ow.windows.changePosition(windowId, placement.left, placement.top, (moveResult: any) => {
      if (isSuccessfulOverwolfResult(moveResult)) {
        ui.logConsole(`Reset the build window to ${placement.left},${placement.top}.`);
      } else {
        ui.logConsole('Failed to reposition the build window; restoring it instead.');
      }
      settle();
    });
  });
}

/**
 * Mirrors Overwolf's live hotkey bindings into the two places that name them.
 *
 * `binding` arrives already formatted ("Ctrl+Shift+D"), so no virtual-key table
 * is needed here. Hotkeys are declared at app level, but a game-targeted app can
 * still report them under the game id, so both collections are searched.
 */
function refreshHotkeyBindings(): void {
  ow.settings?.hotkeys?.get?.((result: any) => {
    if (!isSuccessfulOverwolfResult(result)) {
      return;
    }

    const games = result.games && typeof result.games === 'object' ? result.games : {};
    const assigned: any[] = [
      ...(Array.isArray(result.globals) ? result.globals : []),
      ...Object.values(games as Record<string, unknown>).flatMap((entries) =>
        (Array.isArray(entries) ? entries : []),
      ),
    ];

    const bindings: Partial<Record<ui.HotkeyName, string>> = {};
    for (const entry of assigned) {
      const name = readHotkeyName(entry?.name);
      if (!name) {
        continue;
      }

      const binding = typeof entry?.binding === 'string' ? entry.binding.trim() : '';
      if (binding) {
        bindings[name] = binding;
      }
    }

    ui.renderHotkeyBindings(bindings);
  });
}

/** Narrows a reported hotkey name to the two the desktop surface displays. */
function readHotkeyName(value: unknown): ui.HotkeyName | null {
  return value === 'toggle_overlay' || value === 'show_desktop_build' ? value : null;
}

/**
 * Keeps the displayed hotkeys honest after a rebind.
 *
 * The player changes the binding in Overwolf's own settings window, so the
 * change event is the only signal that the displayed value went stale.
 */
function watchHotkeyBindings(): void {
  refreshHotkeyBindings();
  ow.settings?.hotkeys?.onChanged?.addListener(() => refreshHotkeyBindings());
}

function showDesktopBuildWindow(
  mainWindow: any,
  preferSecondary: boolean,
): void {
  if (typeof mainWindow.showDesktopBuildWindow === 'function') {
    mainWindow.showDesktopBuildWindow(preferSecondary);
    return;
  }

  ow.windows.obtainDeclaredWindow('desktop', (result: any) => {
    if (!isSuccessfulOverwolfResult(result) || !result.window?.id) {
      ui.logConsole('Failed to obtain the desktop adaptive window.');
      return;
    }

    ow.windows.restore(result.window.id, () => {
      if (typeof ow.windows.bringToFront === 'function') {
        ow.windows.bringToFront(result.window.id, true, () => {});
      }
    });
  });
}

function toggleInGameOverlayWindow(): void {
  ow.windows.obtainDeclaredWindow('in_game', (result: any) => {
    if (!isSuccessfulOverwolfResult(result) || !result.window?.id) {
      ui.logConsole('Failed to obtain the in_game overlay window for toggling.');
      return;
    }

    const windowId = result.window.id;
    ow.windows.getWindowState(windowId, (stateResult: any) => {
      if (!isSuccessfulOverwolfResult(stateResult)) {
        ui.logConsole('Failed to read the in_game overlay window state.');
        return;
      }

      const state = stateResult.window_state ?? stateResult.windowState;
      if (state === 'minimized' || state === 'closed' || state === 'hidden') {
        ow.windows.restore(windowId, () => {});
        return;
      }

      ow.windows.minimize(windowId, () => {});
    });
  });
}

function extractAdaptiveContext(event: any): {
  matchId?: string;
  localSteamId?: string;
  matchEnded: boolean;
} {
  const key = readString(event?.key).toLowerCase();
  const payload = parsePayload(event?.payload);
  const matchId = readString(event?.matchId)
    || (key === 'match_id' ? readString(payload) : '')
    || findString(payload, ['match_id', 'matchId']);
  const isLocal = Boolean(payload?.is_local ?? payload?.isLocal ?? payload?.local);
  const localSteamId = isLocal
    ? findString(payload, ['steam_id', 'steamId', 'player_steam_id', 'playerSteamId'])
    : '';
  const matchEnded = ['match_end', 'match_outcome'].includes(key)
    || (key === 'match_state' && ['ended', 'complete', 'completed'].includes(readString(payload).toLowerCase()));

  return {
    matchId: matchId || undefined,
    localSteamId: localSteamId || undefined,
    matchEnded,
  };
}

function parsePayload(value: unknown): any {
  if (typeof value !== 'string') {
    return value || {};
  }

  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function findString(value: unknown, keys: readonly string[], depth = 0): string {
  if (!value || typeof value !== 'object' || depth > 6) {
    return '';
  }

  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const found = readString(record[key]);
    if (found) {
      return found;
    }
  }

  for (const nested of Object.values(record)) {
    const found = findString(nested, keys, depth + 1);
    if (found) {
      return found;
    }
  }

  return '';
}

function readString(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }

  if (typeof value !== 'string') {
    return '';
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }

  try {
    const parsed = JSON.parse(trimmed);
    return typeof parsed === 'string' || typeof parsed === 'number'
      ? String(parsed)
      : '';
  } catch {
    return trimmed;
  }
}
