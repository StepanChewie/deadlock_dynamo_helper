import { isSuccessfulOverwolfResult } from './overwolf/window-result';
import {
  createSituationalItemWarning,
  SituationalItemWarning,
} from './situational-item-metadata';

const WARNING_DURATION_MS = 15_000;
const SNAPSHOT_CHECK_INTERVAL_MS = 500;
const ow = (window as any).overwolf;

if (ow?.windows) {
  ow.windows.getCurrentWindow((result: any) => {
    if (!isSuccessfulOverwolfResult(result) || !result.window) {
      return;
    }

    const windowId = result.window.id;
    const card = document.querySelector('.popup-card') as HTMLElement | null;
    const dragHandle = document.querySelector('.popup-drag-handle') as HTMLElement | null;
    const textElement = document.querySelector('.popup-text') as HTMLElement | null;
    const titleElement = document.querySelector('.popup-title') as HTMLElement | null;
    const mainWindow = ow.windows.getMainWindow() as any;
    const shownWarningKeys = new Set<string>();
    let currentMatchId = '';
    let pendingWarningKey = '';
    let warningTimer: ReturnType<typeof setTimeout> | undefined;

    const updateUI = (): void => {
      const isMenuOpen = Boolean(mainWindow?.overlayMenuActive);
      const warning = mainWindow?.situationalItemWarning as
        | SituationalItemWarning
        | undefined;

      ow.windows.setWindowMouseInputPassThrough?.(windowId, !isMenuOpen);

      if (!card) {
        return;
      }

      if (isMenuOpen) {
        card.style.display = 'flex';
        card.style.opacity = '0.75';
        card.style.border = '2px dashed #ff6b4a';
        if (titleElement) {
          titleElement.textContent = 'Настройка предупреждения';
        }
        if (textElement) {
          textElement.textContent =
            'Зажмите карточку мышкой и перетащите её в нужное место (Ctrl+Shift+D скрывает оверлей)';
        }
        return;
      }

      if (warning) {
        card.style.display = 'flex';
        card.style.opacity = '1';
        card.style.border = '2px solid #ff6b4a';
        if (titleElement) {
          titleElement.textContent = 'Внимание от Динамо';
        }
        if (textElement) {
          textElement.textContent = createWarningText(warning);
        }
        return;
      }

      card.style.display = 'none';
    };

    const clearWarningTimer = (): void => {
      if (!warningTimer) {
        return;
      }
      clearTimeout(warningTimer);
      warningTimer = undefined;
    };

    const scheduleWarningClear = (warning: SituationalItemWarning): void => {
      clearWarningTimer();
      warningTimer = setTimeout(() => {
        if (mainWindow.situationalItemWarning?.key === warning.key) {
          mainWindow.situationalItemWarning = undefined;
          updateUI();
        }
        warningTimer = undefined;
      }, WARNING_DURATION_MS);
    };

    const presentWarning = (warning: SituationalItemWarning): void => {
      if (
        shownWarningKeys.has(warning.key) ||
        pendingWarningKey === warning.key
      ) {
        return;
      }

      pendingWarningKey = warning.key;
      mainWindow.situationalItemWarning = warning;
      updateUI();

      ow.windows.restore(windowId, (restoreResult: any) => {
        pendingWarningKey = '';
        if (!isSuccessfulOverwolfResult(restoreResult)) {
          if (mainWindow.situationalItemWarning?.key === warning.key) {
            mainWindow.situationalItemWarning = undefined;
            updateUI();
          }
          return;
        }

        shownWarningKeys.add(warning.key);
        scheduleWarningClear(warning);
        if (typeof ow.windows.bringToFront === 'function') {
          ow.windows.bringToFront(windowId, false, () => undefined);
        }
      });
    };

    const checkLatestSnapshot = (): void => {
      const snapshot = mainWindow.latestLiveBuildRecommendation;
      const snapshotMatchId = typeof snapshot?.matchId === 'string'
        ? snapshot.matchId
        : '';

      if (snapshotMatchId !== currentMatchId) {
        currentMatchId = snapshotMatchId;
        shownWarningKeys.clear();
        pendingWarningKey = '';
        clearWarningTimer();
      }

      const existingWarning = mainWindow.situationalItemWarning as
        | SituationalItemWarning
        | undefined;
      if (existingWarning) {
        presentWarning(existingWarning);
        return;
      }

      if (!snapshot || typeof snapshot !== 'object') {
        return;
      }

      const warning = createSituationalItemWarning(
        snapshot,
        mainWindow.heroNamesMap || {},
      );
      if (warning) {
        presentWarning(warning);
      }
    };

    dragHandle?.addEventListener('mousedown', (event: MouseEvent) => {
      event.preventDefault();
      ow.windows.dragMove(windowId);
    });

    mainWindow.updateWarningUI = updateUI;
    mainWindow.replayCurrentSituationalWarning = () => {
      const snapshot = mainWindow.latestLiveBuildRecommendation;
      if (!snapshot || typeof snapshot !== 'object') {
        return false;
      }

      const warning = createSituationalItemWarning(
        snapshot,
        mainWindow.heroNamesMap || {},
      );
      if (!warning) {
        return false;
      }

      shownWarningKeys.delete(warning.key);
      pendingWarningKey = '';
      presentWarning(warning);
      return true;
    };

    updateUI();
    checkLatestSnapshot();
    setInterval(checkLatestSnapshot, SNAPSHOT_CHECK_INTERVAL_MS);
  });
}

export function createWarningText(warning: SituationalItemWarning): string {
  const details: string[] = [];
  if (Number.isFinite(warning.lower95OddsRatio)) {
    details.push(`нижняя граница эффекта x${warning.lower95OddsRatio!.toFixed(2)}`);
  }
  if (Number.isSafeInteger(warning.matchupObservationCount)) {
    details.push(`наблюдений: ${warning.matchupObservationCount}`);
  }

  const evidence = details.length > 0 ? ` (${details.join(', ')})` : '';
  if (warning.wasInsertedByMatchup) {
    return `Ситуативный предмет «${warning.itemName}» добавлен в билд против ${warning.enemyHeroName}${evidence}.`;
  }
  if (warning.wasPromotedByMatchup) {
    return `Ситуативный предмет «${warning.itemName}» поднят в билде против ${warning.enemyHeroName}${evidence}.`;
  }
  return `Рекомендуемый предмет «${warning.itemName}» особенно эффективен против ${warning.enemyHeroName}${evidence}.`;
}
