import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  appendFile,
  mkdir,
  readFile,
  rename,
  stat,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { sha256StableJson } from './stable-json';

export const MATCH_TIMELINE_SCHEMA_VERSION = 1;
export const MATCH_TIMELINE_VERSION = 'MATCH_TIMELINE_V1' as const;

const DEFAULT_STORAGE_DIR = '/app/apps/api/storage/match-timeline-events-v1';
const DEFAULT_LIVE_EVENTS_URL = 'http://deadlock-live-events:3000';
const DEFAULT_API_URL = 'https://api.deadlock-api.com';
const OBJECTIVE_TYPES = new Set([
  'destroyable_building',
  'mid_boss',
  'boss_tier2',
  'boss_tier3',
  'base_defense_sentry',
  'trooper_boss',
  'trooper_barrack_boss',
  'sinners_sacrifice',
]);
const SUBSCRIBED_ENTITIES = [
  'player_controller',
  'player_pawn',
  'team',
  ...OBJECTIVE_TYPES,
].join(',');

export interface SseMessage {
  eventName: string;
  data: string;
  id?: string;
}

export interface MatchTimelineRawEvent {
  schemaVersion: typeof MATCH_TIMELINE_SCHEMA_VERSION;
  timelineVersion: typeof MATCH_TIMELINE_VERSION;
  eventId: string;
  matchId: number;
  sequence: number;
  receivedAt: string;
  eventName: string;
  gameTimeS: number;
  tick: number;
  payload: Record<string, unknown>;
}

export interface MatchTimelinePlayerSnapshot {
  schemaVersion: typeof MATCH_TIMELINE_SCHEMA_VERSION;
  timelineVersion: typeof MATCH_TIMELINE_VERSION;
  snapshotId: string;
  sourceEventId: string;
  matchId: number;
  gameTimeS: number;
  tick: number;
  steamId: string;
  heroId: number;
  teamId?: number;
  kills: number;
  deaths: number;
  assists: number;
  netWorth: number;
  heroDamage: number;
  health?: number;
  maxHealth?: number;
  level?: number;
  receivedAt: string;
}

export interface MatchTimelineObjectiveEvent {
  schemaVersion: typeof MATCH_TIMELINE_SCHEMA_VERSION;
  timelineVersion: typeof MATCH_TIMELINE_VERSION;
  objectiveEventId: string;
  sourceEventId: string;
  matchId: number;
  gameTimeS: number;
  tick: number;
  eventName: string;
  objectiveType: string;
  entityIndex: number;
  teamId?: number;
  receivedAt: string;
}

export interface MatchTimelineSessionStatus {
  matchId: number;
  state:
    | 'STARTING'
    | 'STREAMING'
    | 'RECONNECTING'
    | 'COMPLETE'
    | 'STOPPED'
    | 'FAILED';
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  eventCount: number;
  playerSnapshotCount: number;
  objectiveEventCount: number;
  reconnectCount: number;
  lastGameTimeS?: number;
  lastError?: string;
  outputDirectory: string;
}

export interface MatchTimelineCollectorStatus {
  enabled: boolean;
  storageDirectory: string;
  liveEventsBaseUrl: string;
  deadlockApiBaseUrl: string;
  maxConcurrentMatches: number;
  activeMatchCount: number;
  completedMatchCount: number;
  failedMatchCount: number;
  lastPollAt?: string;
  lastPollError?: string;
  sessions: MatchTimelineSessionStatus[];
}

interface Session {
  status: MatchTimelineSessionStatus;
  abortController: AbortController;
  seenEventIds: Set<string>;
  entityStates: Map<string, Record<string, unknown>>;
  sequence: number;
  ended: boolean;
  finalized: boolean;
  writeErrorCount: number;
}

interface Paths {
  directory: string;
  events: string;
  snapshots: string;
  objectives: string;
  checkpoint: string;
  manifest: string;
  audit: string;
}

@Injectable()
export class MatchTimelineCollectorService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(MatchTimelineCollectorService.name);
  private readonly storageDirectory =
    process.env.DEADLOCK_TIMELINE_STORAGE_DIR?.trim() || DEFAULT_STORAGE_DIR;
  private readonly liveEventsBaseUrl = trimSlash(
    process.env.DEADLOCK_LIVE_EVENTS_BASE_URL?.trim() ||
      DEFAULT_LIVE_EVENTS_URL,
  );
  private readonly deadlockApiBaseUrl = trimSlash(
    process.env.DEADLOCK_API_BASE_URL?.trim() || DEFAULT_API_URL,
  );
  private readonly enabled =
    process.env.DEADLOCK_TIMELINE_COLLECTOR_ENABLED?.trim().toLowerCase() ===
    'true';
  private readonly maxConcurrentMatches = boundedInteger(
    process.env.DEADLOCK_TIMELINE_MAX_CONCURRENT_MATCHES,
    2,
    1,
    16,
  );
  private readonly sessions = new Map<number, Session>();
  private lastPollAt?: string;
  private lastPollError?: string;

  async onModuleInit(): Promise<void> {
    await mkdir(this.storageDirectory, { recursive: true });
    if (this.enabled) {
      void this.pollActiveMatches().catch((error) => {
        this.logger.warn(`Initial timeline poll failed: ${errorMessage(error)}`);
      });
    }
  }

  onModuleDestroy(): void {
    for (const session of this.sessions.values()) {
      session.abortController.abort();
    }
  }

  @Cron('0 */2 * * * *', { name: 'match-timeline-active-match-poll' })
  async scheduledPoll(): Promise<void> {
    if (this.enabled) {
      await this.pollActiveMatches();
    }
  }

  getStatus(): MatchTimelineCollectorStatus {
    const sessions = [...this.sessions.values()]
      .map((entry) => clone(entry.status))
      .sort((left, right) => right.matchId - left.matchId);
    return {
      enabled: this.enabled,
      storageDirectory: this.storageDirectory,
      liveEventsBaseUrl: this.liveEventsBaseUrl,
      deadlockApiBaseUrl: this.deadlockApiBaseUrl,
      maxConcurrentMatches: this.maxConcurrentMatches,
      activeMatchCount: sessions.filter((entry) =>
        ['STARTING', 'STREAMING', 'RECONNECTING'].includes(entry.state),
      ).length,
      completedMatchCount: sessions.filter((entry) => entry.state === 'COMPLETE')
        .length,
      failedMatchCount: sessions.filter((entry) => entry.state === 'FAILED')
        .length,
      lastPollAt: this.lastPollAt,
      lastPollError: this.lastPollError,
      sessions,
    };
  }

  async pollActiveMatches(): Promise<void> {
    this.lastPollAt = new Date().toISOString();
    this.lastPollError = undefined;
    try {
      const payload = await fetchJson(
        `${this.deadlockApiBaseUrl}/v1/matches/active`,
        this.apiHeaders(),
      );
      for (const matchId of extractActiveMatchIds(payload)) {
        if (this.activeCount() >= this.maxConcurrentMatches) {
          break;
        }
        if (!this.sessions.has(matchId)) {
          await this.startMatch(matchId);
        }
      }
    } catch (error) {
      this.lastPollError = errorMessage(error);
      throw error;
    }
  }

  async startMatch(matchId: number): Promise<MatchTimelineSessionStatus> {
    if (!Number.isSafeInteger(matchId) || matchId <= 0) {
      throw new Error('matchId must be a positive safe integer.');
    }
    const existing = this.sessions.get(matchId);
    if (existing) {
      return clone(existing.status);
    }
    if (this.activeCount() >= this.maxConcurrentMatches) {
      throw new Error(
        `Timeline collector concurrency limit ${this.maxConcurrentMatches} is reached.`,
      );
    }

    const paths = timelinePaths(this.storageDirectory, matchId);
    await mkdir(paths.directory, { recursive: true });
    const now = new Date().toISOString();
    const session: Session = {
      status: {
        matchId,
        state: 'STARTING',
        startedAt: now,
        updatedAt: now,
        eventCount: 0,
        playerSnapshotCount: 0,
        objectiveEventCount: 0,
        reconnectCount: 0,
        outputDirectory: paths.directory,
      },
      abortController: new AbortController(),
      seenEventIds: new Set(),
      entityStates: new Map(),
      sequence: 0,
      ended: false,
      finalized: false,
      writeErrorCount: 0,
    };
    await this.restore(session, paths);
    this.sessions.set(matchId, session);
    void this.run(session, paths);
    return clone(session.status);
  }

  stopMatch(matchId: number): MatchTimelineSessionStatus {
    const session = this.sessions.get(matchId);
    if (!session) {
      throw new Error(`No timeline session exists for match ${matchId}.`);
    }
    if (!['COMPLETE', 'STOPPED', 'FAILED'].includes(session.status.state)) {
      session.status.state = 'STOPPED';
      session.status.updatedAt = new Date().toISOString();
      session.status.completedAt = session.status.updatedAt;
      session.abortController.abort();
      void this.finalize(session, timelinePaths(this.storageDirectory, matchId));
    }
    return clone(session.status);
  }

  private activeCount(): number {
    return [...this.sessions.values()].filter((entry) =>
      ['STARTING', 'STREAMING', 'RECONNECTING'].includes(entry.status.state),
    ).length;
  }

  private async run(session: Session, paths: Paths): Promise<void> {
    let attempt = 0;
    try {
      while (!session.abortController.signal.aborted && !session.ended) {
        try {
          session.status.state = attempt === 0 ? 'STREAMING' : 'RECONNECTING';
          session.status.updatedAt = new Date().toISOString();
          const response = await fetch(this.streamUrl(session.status.matchId), {
            headers: { accept: 'text/event-stream' },
            signal: session.abortController.signal,
          });
          if (!response.ok || !response.body) {
            throw new Error(`Live events returned HTTP ${response.status}.`);
          }
          session.status.state = 'STREAMING';
          await parseSseStream(response.body, async (message) => {
            await this.processMessage(session, paths, message);
          });
          if (!session.ended && !session.abortController.signal.aborted) {
            throw new Error('Timeline stream closed before the end event.');
          }
        } catch (error) {
          if (session.abortController.signal.aborted || session.ended) {
            break;
          }
          attempt += 1;
          session.status.state = 'RECONNECTING';
          session.status.reconnectCount += 1;
          session.status.lastError = errorMessage(error);
          session.status.updatedAt = new Date().toISOString();
          await delay(
            Math.min(30_000, 1_000 * 2 ** Math.min(attempt - 1, 5)),
            session.abortController.signal,
          );
        }
      }
      if (session.ended) {
        session.status.state = 'COMPLETE';
      } else if (session.status.state !== 'STOPPED') {
        session.status.state = 'STOPPED';
      }
      session.status.completedAt = new Date().toISOString();
      session.status.updatedAt = session.status.completedAt;
    } catch (error) {
      session.status.state = 'FAILED';
      session.status.lastError = errorMessage(error);
      session.status.completedAt = new Date().toISOString();
      session.status.updatedAt = session.status.completedAt;
    } finally {
      await this.finalize(session, paths);
    }
  }

  private async processMessage(
    session: Session,
    paths: Paths,
    message: SseMessage,
  ): Promise<void> {
    let payload: Record<string, unknown>;
    try {
      const value = JSON.parse(message.data) as unknown;
      payload = isRecord(value) ? value : { value };
    } catch {
      payload = { rawData: message.data };
    }
    if (message.eventName === 'end' || payload.event_type === 'end') {
      session.ended = true;
    }

    const eventId = sha256StableJson({
      matchId: session.status.matchId,
      eventName: message.eventName,
      tick: numberValue(payload.tick) ?? 0,
      gameTimeS: numberValue(payload.game_time) ?? 0,
      entityType: stringValue(payload.entity_type),
      entityIndex: integerValue(payload.entity_index),
      payload,
    });
    if (session.seenEventIds.has(eventId)) {
      return;
    }
    session.seenEventIds.add(eventId);
    session.sequence += 1;
    const rawEvent: MatchTimelineRawEvent = {
      schemaVersion: MATCH_TIMELINE_SCHEMA_VERSION,
      timelineVersion: MATCH_TIMELINE_VERSION,
      eventId,
      matchId: session.status.matchId,
      sequence: session.sequence,
      receivedAt: new Date().toISOString(),
      eventName: message.eventName,
      gameTimeS: numberValue(payload.game_time) ?? 0,
      tick: integerValue(payload.tick) ?? 0,
      payload,
    };

    try {
      await appendLine(paths.events, rawEvent);
      session.status.eventCount += 1;
      session.status.lastGameTimeS = Math.max(
        session.status.lastGameTimeS ?? 0,
        rawEvent.gameTimeS,
      );
      const merged = mergeEntity(session, rawEvent);
      const snapshot = createPlayerSnapshot(merged);
      if (snapshot) {
        await appendLine(paths.snapshots, snapshot);
        session.status.playerSnapshotCount += 1;
      }
      const objective = createObjectiveEvent(merged);
      if (objective) {
        await appendLine(paths.objectives, objective);
        session.status.objectiveEventCount += 1;
      }
      session.status.updatedAt = rawEvent.receivedAt;
      if (session.status.eventCount % 100 === 0 || session.ended) {
        await this.checkpoint(session, paths);
      }
    } catch (error) {
      session.writeErrorCount += 1;
      throw error;
    }
  }

  private async restore(session: Session, paths: Paths): Promise<void> {
    if (!(await exists(paths.events))) {
      return;
    }
    for await (const value of readLines(paths.events)) {
      if (!isRecord(value) || typeof value.eventId !== 'string') {
        continue;
      }
      const event = value as unknown as MatchTimelineRawEvent;
      session.seenEventIds.add(event.eventId);
      session.sequence = Math.max(session.sequence, event.sequence);
      session.status.eventCount += 1;
      session.status.lastGameTimeS = Math.max(
        session.status.lastGameTimeS ?? 0,
        event.gameTimeS,
      );
      mergeEntity(session, event);
    }
    session.status.playerSnapshotCount = await countLines(paths.snapshots);
    session.status.objectiveEventCount = await countLines(paths.objectives);
  }

  private async checkpoint(session: Session, paths: Paths): Promise<void> {
    await atomicJson(paths.checkpoint, {
      schemaVersion: MATCH_TIMELINE_SCHEMA_VERSION,
      timelineVersion: MATCH_TIMELINE_VERSION,
      matchId: session.status.matchId,
      updatedAt: new Date().toISOString(),
      sequence: session.sequence,
      eventCount: session.status.eventCount,
      playerSnapshotCount: session.status.playerSnapshotCount,
      objectiveEventCount: session.status.objectiveEventCount,
      reconnectCount: session.status.reconnectCount,
      lastGameTimeS: session.status.lastGameTimeS,
      streamEnded: session.ended,
    });
  }

  private async finalize(session: Session, paths: Paths): Promise<void> {
    if (session.finalized) {
      return;
    }
    session.finalized = true;
    await mkdir(paths.directory, { recursive: true });
    await Promise.all([
      appendFile(paths.events, '', 'utf8'),
      appendFile(paths.snapshots, '', 'utf8'),
      appendFile(paths.objectives, '', 'utf8'),
    ]);
    await this.checkpoint(session, paths);
    const generatedAt = new Date().toISOString();
    const artifacts = {
      events: await artifact(paths.events),
      playerSnapshots: await artifact(paths.snapshots),
      objectiveEvents: await artifact(paths.objectives),
    };
    const warnings = session.ended
      ? []
      : ['The stream did not emit an end event; the timeline may be incomplete.'];
    const audit = {
      schemaVersion: MATCH_TIMELINE_SCHEMA_VERSION,
      timelineVersion: MATCH_TIMELINE_VERSION,
      generatedAt,
      passed:
        session.ended &&
        session.status.eventCount > 0 &&
        session.writeErrorCount === 0 &&
        session.status.state === 'COMPLETE',
      matchId: session.status.matchId,
      stream: {
        ended: session.ended,
        reconnectCount: session.status.reconnectCount,
        writeErrorCount: session.writeErrorCount,
      },
      rows: {
        eventCount: session.status.eventCount,
        playerSnapshotCount: session.status.playerSnapshotCount,
        objectiveEventCount: session.status.objectiveEventCount,
      },
      integrity: {
        uniqueEventIdCount: session.seenEventIds.size,
        duplicateEventsWritten: 0,
      },
      warnings,
    };
    const manifest = {
      schemaVersion: MATCH_TIMELINE_SCHEMA_VERSION,
      timelineVersion: MATCH_TIMELINE_VERSION,
      generatedAt,
      matchId: session.status.matchId,
      source: {
        kind: 'SELF_HOSTED_DEADLOCK_LIVE_EVENTS_SSE',
        baseUrl: this.liveEventsBaseUrl,
        endpoint: `/v1/matches/${session.status.matchId}/live/demo/events`,
        subscribedEntities: SUBSCRIBED_ENTITIES.split(','),
      },
      artifacts,
      auditPassed: audit.passed,
      warnings,
    };
    await Promise.all([
      atomicJson(paths.audit, audit),
      atomicJson(paths.manifest, manifest),
    ]);
  }

  private streamUrl(matchId: number): string {
    const query = new URLSearchParams({
      subscribed_entities: SUBSCRIBED_ENTITIES,
      subscribed_chat_messages: 'false',
    });
    return `${this.liveEventsBaseUrl}/v1/matches/${matchId}/live/demo/events?${query.toString()}`;
  }

  private apiHeaders(): Record<string, string> {
    const key = process.env.DEADLOCK_API_KEY?.trim();
    return key ? { 'X-API-Key': key } : {};
  }
}

export function extractActiveMatchIds(value: unknown): number[] {
  const result = new Set<number>();
  const visit = (entry: unknown): void => {
    if (Array.isArray(entry)) {
      entry.forEach(visit);
      return;
    }
    if (!isRecord(entry)) {
      return;
    }
    for (const [key, nested] of Object.entries(entry)) {
      if (key === 'match_id' || key === 'matchId') {
        const matchId = positiveInteger(nested);
        if (matchId !== undefined) {
          result.add(matchId);
        }
      }
      visit(nested);
    }
  };
  visit(value);
  return [...result].sort((left, right) => right - left);
}

export async function parseSseStream(
  stream: ReadableStream<Uint8Array>,
  onMessage: (message: SseMessage) => Promise<void> | void,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const value = await reader.read();
      if (value.done) {
        buffer += decoder.decode();
        break;
      }
      buffer += decoder.decode(value.value, { stream: true });
      buffer = buffer.replace(/\r\n/g, '\n');
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const message = parseBlock(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
        if (message) {
          await onMessage(message);
        }
        boundary = buffer.indexOf('\n\n');
      }
    }
    const finalMessage = parseBlock(buffer.trim());
    if (finalMessage) {
      await onMessage(finalMessage);
    }
  } finally {
    reader.releaseLock();
  }
}

export function createPlayerSnapshot(
  event: MatchTimelineRawEvent,
): MatchTimelinePlayerSnapshot | undefined {
  if (stringValue(event.payload.entity_type) !== 'player_controller') {
    return undefined;
  }
  const heroId = positiveInteger(event.payload.hero_id);
  const steamId = identifier(event.payload.steam_id);
  if (heroId === undefined || !steamId) {
    return undefined;
  }
  return {
    schemaVersion: MATCH_TIMELINE_SCHEMA_VERSION,
    timelineVersion: MATCH_TIMELINE_VERSION,
    snapshotId: sha256StableJson({ eventId: event.eventId, steamId, heroId }),
    sourceEventId: event.eventId,
    matchId: event.matchId,
    gameTimeS: event.gameTimeS,
    tick: event.tick,
    steamId,
    heroId,
    teamId: integerValue(event.payload.team),
    kills: integerValue(event.payload.kills) ?? 0,
    deaths: integerValue(event.payload.deaths) ?? 0,
    assists: integerValue(event.payload.assists) ?? 0,
    netWorth: integerValue(event.payload.net_worth) ?? 0,
    heroDamage: integerValue(event.payload.hero_damage) ?? 0,
    health: integerValue(event.payload.health),
    maxHealth: integerValue(event.payload.max_health),
    level: integerValue(event.payload.level),
    receivedAt: event.receivedAt,
  };
}

export function createObjectiveEvent(
  event: MatchTimelineRawEvent,
): MatchTimelineObjectiveEvent | undefined {
  const objectiveType = stringValue(event.payload.entity_type);
  const entityIndex = integerValue(event.payload.entity_index);
  const deleted =
    event.eventName.endsWith('_entity_deleted') ||
    event.payload.event_type === 'entity_delete';
  if (
    !deleted ||
    !objectiveType ||
    !OBJECTIVE_TYPES.has(objectiveType) ||
    entityIndex === undefined
  ) {
    return undefined;
  }
  return {
    schemaVersion: MATCH_TIMELINE_SCHEMA_VERSION,
    timelineVersion: MATCH_TIMELINE_VERSION,
    objectiveEventId: sha256StableJson({
      eventId: event.eventId,
      objectiveType,
      entityIndex,
    }),
    sourceEventId: event.eventId,
    matchId: event.matchId,
    gameTimeS: event.gameTimeS,
    tick: event.tick,
    eventName: event.eventName,
    objectiveType,
    entityIndex,
    teamId: integerValue(event.payload.team),
    receivedAt: event.receivedAt,
  };
}

function mergeEntity(session: Session, event: MatchTimelineRawEvent): MatchTimelineRawEvent {
  const type = stringValue(event.payload.entity_type);
  const index = integerValue(event.payload.entity_index);
  if (!type || index === undefined) {
    return event;
  }
  const key = `${type}:${index}`;
  const merged = { ...(session.entityStates.get(key) ?? {}), ...event.payload };
  if (
    event.eventName.endsWith('_entity_deleted') ||
    event.payload.event_type === 'entity_delete'
  ) {
    session.entityStates.delete(key);
  } else {
    session.entityStates.set(key, merged);
  }
  return { ...event, payload: merged };
}

function parseBlock(block: string): SseMessage | undefined {
  if (!block || block.startsWith(':')) {
    return undefined;
  }
  let eventName = 'message';
  let id: string | undefined;
  const data: string[] = [];
  for (const line of block.split('\n')) {
    const separator = line.indexOf(':');
    const field = separator >= 0 ? line.slice(0, separator) : line;
    const value =
      separator >= 0 ? line.slice(separator + 1).replace(/^ /, '') : '';
    if (field === 'event') {
      eventName = value || 'message';
    } else if (field === 'data') {
      data.push(value);
    } else if (field === 'id') {
      id = value;
    }
  }
  return data.length > 0 ? { eventName, data: data.join('\n'), id } : undefined;
}

function timelinePaths(root: string, matchId: number): Paths {
  const directory = join(root, String(matchId));
  return {
    directory,
    events: join(directory, 'events.ndjson'),
    snapshots: join(directory, 'player-snapshots.ndjson'),
    objectives: join(directory, 'objective-events.ndjson'),
    checkpoint: join(directory, 'checkpoint.json'),
    manifest: join(directory, 'manifest.json'),
    audit: join(directory, 'audit.json'),
  };
}

async function fetchJson(
  url: string,
  headers: Record<string, string>,
): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(url, { headers, signal: controller.signal });
    if (!response.ok) {
      throw new Error(`Request returned HTTP ${response.status}.`);
    }
    return (await response.json()) as unknown;
  } finally {
    clearTimeout(timeout);
  }
}

async function appendLine(path: string, value: unknown): Promise<void> {
  await appendFile(path, `${JSON.stringify(value)}\n`, 'utf8');
}

async function* readLines(path: string): AsyncGenerator<unknown> {
  const lines = createInterface({
    input: createReadStream(path, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    if (!line.trim()) {
      continue;
    }
    try {
      yield JSON.parse(line) as unknown;
    } catch {
      continue;
    }
  }
}

async function countLines(path: string): Promise<number> {
  if (!(await exists(path))) {
    return 0;
  }
  let count = 0;
  for await (const _value of readLines(path)) {
    count += 1;
  }
  return count;
}

async function artifact(path: string): Promise<Record<string, unknown>> {
  const metadata = await stat(path);
  return {
    fileName: path.split('/').pop(),
    byteLength: metadata.size,
    sha256: await hashFile(path),
    rowCount: await countLines(path),
  };
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  const partial = `${path}.partial`;
  await writeFile(partial, `${JSON.stringify(value, undefined, 2)}\n`, 'utf8');
  await rename(partial, path);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timeout = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
  });
}

function boundedInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed)
    ? Math.min(maximum, Math.max(minimum, parsed))
    : fallback;
}

function positiveInteger(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function integerValue(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : undefined;
}

function numberValue(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function identifier(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(Math.trunc(value));
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
