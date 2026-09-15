import { OverwolfLiveEventDto } from '@dynamo-lab/shared';
import { DiagnosticCapture } from '../diagnostics/diagnostic-capture';
import { parseJsonSafely } from './parse-json-safely';

export type EventCallback = (event: OverwolfLiveEventDto) => void;

const STATE_SAFETY_POLL_INTERVAL_MS = 3_000;
const STATE_SAFETY_CATEGORIES = new Set([
  'match_info',
  'game_info',
  'roster',
  'items',
]);
const STATE_SAFETY_TRANSITION_KEYS = new Set([
  'match_end',
  'match_outcome',
  'match_state',
]);

interface MatchContext {
  currentMatchId?: string;
}

let diagnosticCapture: DiagnosticCapture | undefined;
let stateSafetyTimer: ReturnType<typeof setInterval> | undefined;
let stateSafetyPollInFlight = false;

function matchIdFromValue(value: unknown): string | undefined {
  const parsed = parseJsonSafely(value);
  if (typeof parsed === 'string' && parsed.trim().length > 0) {
    return parsed.trim().replace(/^"|"$/g, '');
  }

  if (typeof parsed === 'number' && Number.isFinite(parsed)) {
    return String(parsed);
  }

  return undefined;
}

function extractMatchIdFromInfo(info: unknown): string | undefined {
  if (!info || typeof info !== 'object') {
    return undefined;
  }

  const record = info as Record<string, any>;
  return matchIdFromValue(record.match_info?.match_id)
    ?? matchIdFromValue(record.match_info?.matchId);
}

let lastSnapshotShape = '';
let lastPhase: string | undefined;
let lastGepVersion: string | undefined;

/**
 * Describes the shape of a GEP snapshot using key NAMES only, never values.
 *
 * When `match_info` stops arriving, nothing throws: the match id simply never
 * appears, so the overlay is never restored and no recommendation is ever
 * requested. Both symptoms look identical to "still loading". Recording the
 * shape makes the missing category visible in the diagnostics block.
 */
function describeSnapshot(info: unknown): string {
  if (!info || typeof info !== 'object') {
    return 'none';
  }

  const parts: string[] = [];
  for (const [category, categoryData] of Object.entries(info as Record<string, unknown>)) {
    if (!categoryData || typeof categoryData !== 'object') {
      continue;
    }

    const keys = Object.keys(categoryData as Record<string, unknown>).sort();
    parts.push(`${category}(${keys.length > 0 ? keys.join(',') : 'empty'})`);
  }

  return parts.length > 0 ? parts.sort().join(' ') : 'empty';
}

function recordSnapshot(info: unknown): void {
  lastSnapshotShape = describeSnapshot(info);

  const record = info as Record<string, any> | undefined;

  const phase = matchIdFromValue(record?.game_info?.phase);
  if (phase) {
    lastPhase = phase;
  }

  const versionInfo = parseJsonSafely(record?.gep_internal?.version_info);
  if (versionInfo && typeof versionInfo === 'object') {
    const local = matchIdFromValue((versionInfo as Record<string, unknown>).local_version);
    const published = matchIdFromValue((versionInfo as Record<string, unknown>).public_version);
    if (local || published) {
      lastGepVersion = `local ${local ?? '?'} / public ${published ?? '?'}`;
    }
  }
}

/** Shape of the most recent GEP snapshot, key names only. */
export function readGepSnapshotShape(): string {
  return lastSnapshotShape;
}

/** Last observed `game_info.phase`, e.g. `GameInProgress`. */
export function readGepPhase(): string | undefined {
  return lastPhase;
}

/** Overwolf's reported GEP version, from `gep_internal.version_info`. */
export function readGepVersion(): string | undefined {
  return lastGepVersion;
}

function isTerminalMatchSnapshot(info: unknown): boolean {  if (!info || typeof info !== 'object') {
    return false;
  }

  const matchInfo = (info as Record<string, any>).match_info;
  if (!matchInfo || typeof matchInfo !== 'object') {
    return false;
  }

  const matchEnd = parseJsonSafely(matchInfo.match_end);
  if (
    matchEnd === true
    || matchEnd === 1
    || matchEnd === '1'
    || (typeof matchEnd === 'string' && matchEnd.trim().toLowerCase() === 'true')
  ) {
    return true;
  }

  const matchState = matchIdFromValue(matchInfo.match_state)?.toLowerCase();
  if (matchState && ['ended', 'complete', 'completed'].includes(matchState)) {
    return true;
  }

  const matchOutcome = matchInfo.match_outcome;
  return matchOutcome !== undefined
    && matchOutcome !== null
    && String(matchOutcome).trim() !== '';
}

export function listenOverwolfEvents(onEvent: EventCallback): void {
  if (typeof overwolf === 'undefined' || !overwolf.games || !overwolf.games.events) {
    console.warn('Overwolf API is not available; events listener registration skipped.');
    return;
  }

  diagnosticCapture ??= new DiagnosticCapture(`capture-${Math.random().toString(36).slice(2, 10)}`);
  const capture = diagnosticCapture;
  const matchContext: MatchContext = {};
  capture.initialize(overwolf);

  overwolf.games.events.onInfoUpdates2.addListener((infoUpdate: any) => {
    try {
      emitInfoEntries(
        infoUpdate?.info,
        infoUpdate?.feature,
        onEvent,
        capture,
        false,
        matchContext,
      );
    } catch (err) {
      console.error('Error handling onInfoUpdates2 event:', err);
    }
  });

  overwolf.games.events.onNewEvents.addListener((eventsEvent: any) => {
    try {
      const { events, feature } = eventsEvent;
      if (!Array.isArray(events)) {
        return;
      }

      for (const e of events) {
        if (!e || typeof e !== 'object') {
          continue;
        }

        const receivedAt = Date.now();
        capture.captureRaw({
          receivedAt,
          source: 'onNewEvents',
          feature,
          key: e.name,
          rawPayload: e.data,
        });
        const parsedData = parseJsonSafely(e.data);
        if (e.name === 'match_id') {
          matchContext.currentMatchId = matchIdFromValue(parsedData) ?? matchContext.currentMatchId;
        }

        onEvent({
          matchId: matchContext.currentMatchId,
          receivedAt,
          source: 'onNewEvents',
          feature,
          key: e.name,
          payload: parsedData,
        });
      }
    } catch (err) {
      console.error('Error handling onNewEvents event:', err);
    }
  });

  startStateSafetyPolling(onEvent, capture, matchContext);
}

function startStateSafetyPolling(
  onEvent: EventCallback,
  capture: DiagnosticCapture,
  matchContext: MatchContext,
): void {
  const eventsApi = overwolf.games.events as any;
  if (stateSafetyTimer || typeof eventsApi.getInfo !== 'function') {
    return;
  }

  const reconcileCurrentState = (): void => {
    if (stateSafetyPollInFlight) {
      return;
    }

    stateSafetyPollInFlight = true;
    eventsApi.getInfo((result: any) => {
      stateSafetyPollInFlight = false;
      try {
        if (
          !result ||
          (result.success !== true && result.status !== 'success') ||
          !result.res
        ) {
          return;
        }

        if (isTerminalMatchSnapshot(result.res)) {
          matchContext.currentMatchId = undefined;
          return;
        }

        matchContext.currentMatchId = extractMatchIdFromInfo(result.res) ?? matchContext.currentMatchId;
        emitInfoEntries(
          result.res,
          'state_safety_poll',
          onEvent,
          capture,
          true,
          matchContext,
        );
      } catch (err) {
        console.error('Error handling live state safety snapshot:', err);
      }
    });
  };

  stateSafetyTimer = setInterval(
    reconcileCurrentState,
    STATE_SAFETY_POLL_INTERVAL_MS,
  );
  reconcileCurrentState();
}

function emitInfoEntries(
  info: unknown,
  feature: string | undefined,
  onEvent: EventCallback,
  capture: DiagnosticCapture,
  stateSafetyOnly: boolean,
  matchContext: MatchContext,
): void {
  if (!info || typeof info !== 'object') {
    return;
  }

  recordSnapshot(info);
  matchContext.currentMatchId = extractMatchIdFromInfo(info) ?? matchContext.currentMatchId;

  for (const [category, categoryData] of Object.entries(info)) {
    if (!categoryData || typeof categoryData !== 'object') {
      continue;
    }

    if (stateSafetyOnly && !STATE_SAFETY_CATEGORIES.has(category)) {
      continue;
    }

    for (const [key, rawValue] of Object.entries(categoryData)) {
      if (stateSafetyOnly && STATE_SAFETY_TRANSITION_KEYS.has(key)) {
        continue;
      }

      const receivedAt = Date.now();
      capture.captureRaw({
        receivedAt,
        source: 'onInfoUpdates2',
        feature,
        category,
        key,
        rawPayload: rawValue,
      });
      const parsedValue = parseJsonSafely(rawValue);
      if (key === 'match_id') {
        matchContext.currentMatchId = matchIdFromValue(parsedValue) ?? matchContext.currentMatchId;
      }

      onEvent({
        matchId: matchContext.currentMatchId,
        receivedAt,
        source: 'onInfoUpdates2',
        feature,
        category,
        key,
        payload: parsedValue,
      });
    }
  }
}
