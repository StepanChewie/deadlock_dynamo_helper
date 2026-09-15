import { LiveEventBuffer } from './overwolf/live-event-buffer';
import { listenOverwolfEvents } from './overwolf/listen-overwolf-events';
import { setRequiredFeatures } from './overwolf/set-required-features';
import { isSuccessfulOverwolfResult } from './overwolf/window-result';
import { InGameOverlayLifecycle } from './overwolf/in-game-overlay-lifecycle';
import * as ui from './ui';
import { AdaptiveRecommendationClient } from './adaptive-recommendation-client';
import { didAdaptiveMatchChange } from './adaptive-match-transition';

const clientId = `client-${Math.random().toString(36).substring(2, 8)}`;
const apiBaseUrl = 'https://aboba-telegramovich.duckdns.org';
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
      const minimumHeight = 190;
      const maximumHeight = 700;
      const contentHeight = Math.ceil(hud.scrollHeight + 24);
      const targetHeight = Math.max(
        minimumHeight,
        Math.min(maximumHeight, contentHeight),
      );
      ow.windows.changeSize(windowId, 340, targetHeight);
    });
  };

  (window as any).ensureOverlayHeight = ensureOverlayHeight;

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

  registerWindowHotkeys(mainWindow);

  const customFetch = async (
    url: string,
    init?: RequestInit,
  ): Promise<Response> => {
    try {
      const response = await fetch(url, init);
      if (response.ok) {
        ui.incrementSends();
        ui.updateIndicator('Connected', true);
      } else {
        ui.logConsole(`Ingest error: HTTP ${response.status}`);
        ui.updateIndicator('Connection issue', false);
      }
      return response;
    } catch (error: any) {
      ui.logConsole(`Network error: ${error?.message || error}`);
      ui.updateIndicator('Offline', false);
      throw error;
    }
  };

  const adaptiveClient = new AdaptiveRecommendationClient(apiBaseUrl, customFetch, 1500);
  let currentMatchId = readString((globalThis as any).__deadlockLiveMatchId);
  let currentLocalSteamId = '';
  const inGameOverlayLifecycle = new InGameOverlayLifecycle(restoreInGameOverlayWindow);
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

    mainWindow.inGameAdaptiveUpdate?.(data);
  };

  const publishAdaptiveError = (error: Error): void => {
    ui.setRefreshPending(false);
    const message = error.message || 'Adaptive recommendation unavailable';
    mainWindow.latestAdaptiveError = message;
    ui.showAdaptiveError(message);
    mainWindow.inGameAdaptiveError?.(message);
  };

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
      await setRequiredFeatures();
      ui.updateStatus('Ready', 'connected');
      ui.logConsole('Successfully registered GEP required features: game_info, match_info');

      listenOverwolfEvents((event) => {
        const eventDetails = `Source: ${event.source} | Key: ${event.key || 'n/a'} | Cat: ${event.category || 'n/a'}`;
        ui.updateLastEvent(eventDetails);

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
    } catch (error: any) {
      ui.updateStatus('Unavailable', 'error');
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
      showDesktopBuildWindow(mainWindow, false);
    }
  });
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
