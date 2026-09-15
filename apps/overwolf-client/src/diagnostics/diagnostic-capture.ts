import { analyzeShopSignalCandidatesV1 } from './shop-signal-candidate-analysis';

export type DiagnosticRawSource = 'onInfoUpdates2' | 'onNewEvents';

export interface DiagnosticRawEvent {
  receivedAt: number;
  source: DiagnosticRawSource;
  feature?: string;
  category?: string;
  key?: string;
  rawPayload: unknown;
}

type EntrySource = DiagnosticRawSource | 'getInfo' | 'runningGameInfo' | 'manifest' | 'system';
type StorageStatus = 'INITIALIZING' | 'RECORDING' | 'COMPLETE' | 'STORAGE_ERROR';

type DiagnosticEntry = {
  id?: number;
  sequence: number;
  appSessionId: string;
  receivedAt: string;
  source: EntrySource;
  matchId?: string;
  feature?: string;
  category?: string;
  key?: string;
  rawPayload: unknown;
};

type DiagnosticNote = {
  id: string;
  createdAt: string;
  matchId?: string;
  approximateGameTime?: string;
  action: string;
  item?: string;
  note?: string;
};

type AppSession = {
  id: string;
  clientId: string;
  startedAt: string;
};

type DiagnosticState = {
  schemaVersion: 2;
  createdAt: string;
  updatedAt: string;
  currentMatchId?: string;
  manualSteamBuildId?: string;
  legacyTruncated: boolean;
  sequence: number;
  persistedEntryCount: number;
  estimatedBytes: number;
  appSessions: AppSession[];
  notes: DiagnosticNote[];
};

type LegacyDiagnosticState = {
  schemaVersion: 1;
  createdAt: string;
  updatedAt: string;
  currentMatchId?: string;
  manualSteamBuildId?: string;
  truncated: boolean;
  sequence: number;
  appSessions: AppSession[];
  entries: DiagnosticEntry[];
  notes: DiagnosticNote[];
};

type StoredMetaRecord = {
  key: 'state';
  value: DiagnosticState;
};

type ZipFile = { name: string; content: string; modifiedAt?: Date };

const LEGACY_STORAGE_KEY = 'deadlock-live-probe-diagnostics-v1';
const DATABASE_NAME = 'deadlock-live-probe-diagnostics';
const DATABASE_VERSION = 2;
const ENTRY_STORE = 'entries';
const META_STORE = 'meta';
const META_KEY = 'state';
const FLUSH_DELAY_MS = 500;
const MAX_BATCH_SIZE = 250;
const ROSTER_THROTTLE_MS = 1_000;
const MAX_SANITIZE_DEPTH = 24;

const nowIso = (): string => new Date().toISOString();
const randomId = (prefix: string): string =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;

function sanitize(value: unknown, seen = new WeakSet<object>(), depth = 0): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (depth > MAX_SANITIZE_DEPTH) return '[MaxDepth]';

  const valueType = typeof value;
  if (valueType === 'bigint') return String(value);
  if (valueType === 'symbol') return `[Symbol ${String((value as symbol).description || '')}]`;
  if (valueType === 'function') {
    const name = (value as (...args: unknown[]) => unknown).name;
    return `[Function${name ? ` ${name}` : ''}]`;
  }
  if (valueType !== 'object') return value;

  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? '[Invalid Date]' : value.toISOString();
  }
  if (value instanceof ArrayBuffer) {
    return Array.from(new Uint8Array(value));
  }
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView;
    return Array.from(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
  }
  if (value instanceof Map) {
    return Array.from(value.entries()).map(([key, item]) => [
      sanitize(key, seen, depth + 1),
      sanitize(item, seen, depth + 1),
    ]);
  }
  if (value instanceof Set) {
    return Array.from(value.values()).map((item) => sanitize(item, seen, depth + 1));
  }
  if (typeof Blob !== 'undefined' && value instanceof Blob) {
    return { type: value.type, size: value.size };
  }
  if (seen.has(value)) return '[Circular]';

  seen.add(value);
  if (Array.isArray(value)) {
    const result = value.map((item) => sanitize(item, seen, depth + 1));
    seen.delete(value);
    return result;
  }

  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    result[key] = sanitize(item, seen, depth + 1);
  }
  seen.delete(value);
  return result;
}

const stringify = (value: unknown, space?: number): string => JSON.stringify(sanitize(value), null, space);

function estimateBytes(value: unknown): number {
  return new TextEncoder().encode(stringify(value)).byteLength + 1;
}

function primitiveString(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const trimmed = value.trim();
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed === 'string' || (typeof parsed === 'number' && Number.isFinite(parsed))) {
      return String(parsed);
    }
  } catch {
    // Keep raw non-JSON strings.
  }
  return trimmed;
}

function findMatchId(value: unknown, depth = 0): string | undefined {
  if (depth > 8 || value === null || value === undefined) return undefined;
  if (typeof value === 'string') {
    try {
      return findMatchId(JSON.parse(value), depth + 1);
    } catch {
      return undefined;
    }
  }
  if (typeof value !== 'object') return undefined;

  const record = value as Record<string, unknown>;
  for (const key of ['match_id', 'matchId']) {
    const matchId = primitiveString(record[key]);
    if (matchId) return matchId;
  }
  for (const nested of Object.values(record)) {
    const matchId = findMatchId(nested, depth + 1);
    if (matchId) return matchId;
  }
  return undefined;
}

function collectVersionCandidates(value: unknown, result = new Set<string>(), depth = 0): Set<string> {
  if (depth > 8 || value === null || value === undefined) return result;
  if (typeof value === 'string') {
    try {
      collectVersionCandidates(JSON.parse(value), result, depth + 1);
    } catch {
      // Parent keys are inspected below.
    }
    return result;
  }
  if (typeof value !== 'object') return result;

  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (/(build|version)/i.test(key) && (typeof nested === 'string' || typeof nested === 'number')) {
      result.add(`${key}: ${String(nested)}`);
    }
    collectVersionCandidates(nested, result, depth + 1);
  }
  return result;
}

export function shouldCaptureDiagnosticEvent(event: DiagnosticRawEvent): boolean {
  if (event.source === 'onNewEvents') return true;
  return Boolean(event.category || event.key || event.feature);
}

export function createDiagnosticChannel(event: DiagnosticRawEvent): string {
  return [event.category || '', event.key || event.feature || ''].join('|');
}

export function isCriticalDiagnosticEvent(
  event: Pick<DiagnosticRawEvent, 'source' | 'category' | 'key'>,
): boolean {
  const key = (event.key || '').toLowerCase();
  const category = (event.category || '').toLowerCase();
  return (
    event.source === 'onNewEvents' ||
    key === 'match_id' ||
    key === 'match_start' ||
    key === 'match_end' ||
    key === 'match_outcome' ||
    key === 'match_state' ||
    key.startsWith('items_') ||
    category === 'items'
  );
}

function isRosterEvent(event: Pick<DiagnosticRawEvent, 'category' | 'key'>): boolean {
  const category = (event.category || '').toLowerCase();
  const key = (event.key || '').toLowerCase();
  return category === 'roster' || key.startsWith('roster_');
}

function isMatchCompleteKey(key?: string): boolean {
  const normalized = (key || '').toLowerCase();
  return normalized === 'match_end' || normalized === 'match_outcome';
}

function write16(view: DataView, offset: number, value: number): void {
  view.setUint16(offset, value & 0xffff, true);
}

function write32(view: DataView, offset: number, value: number): void {
  view.setUint32(offset, value >>> 0, true);
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date: Date): { date: number; time: number } {
  const year = Math.max(1980, date.getFullYear());
  return {
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
  };
}

function concat(parts: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

export function createStoredZipBytes(files: ZipFile[]): Uint8Array {
  const encoder = new TextEncoder();
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let localOffset = 0;

  for (const file of files) {
    const name = encoder.encode(file.name);
    const content = encoder.encode(file.content);
    const checksum = crc32(content);
    const dos = dosDateTime(file.modifiedAt || new Date());

    const local = new Uint8Array(30 + name.length);
    const localView = new DataView(local.buffer);
    write32(localView, 0, 0x04034b50);
    write16(localView, 4, 20);
    write16(localView, 6, 0x0800);
    write16(localView, 8, 0);
    write16(localView, 10, dos.time);
    write16(localView, 12, dos.date);
    write32(localView, 14, checksum);
    write32(localView, 18, content.length);
    write32(localView, 22, content.length);
    write16(localView, 26, name.length);
    write16(localView, 28, 0);
    local.set(name, 30);
    localParts.push(local, content);

    const central = new Uint8Array(46 + name.length);
    const centralView = new DataView(central.buffer);
    write32(centralView, 0, 0x02014b50);
    write16(centralView, 4, 20);
    write16(centralView, 6, 20);
    write16(centralView, 8, 0x0800);
    write16(centralView, 10, 0);
    write16(centralView, 12, dos.time);
    write16(centralView, 14, dos.date);
    write32(centralView, 16, checksum);
    write32(centralView, 20, content.length);
    write32(centralView, 24, content.length);
    write16(centralView, 28, name.length);
    write16(centralView, 30, 0);
    write16(centralView, 32, 0);
    write16(centralView, 34, 0);
    write16(centralView, 36, 0);
    write32(centralView, 38, 0);
    write32(centralView, 42, localOffset);
    central.set(name, 46);
    centralParts.push(central);
    localOffset += local.length + content.length;
  }

  const localData = concat(localParts);
  const centralData = concat(centralParts);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  write32(endView, 0, 0x06054b50);
  write16(endView, 4, 0);
  write16(endView, 6, 0);
  write16(endView, 8, files.length);
  write16(endView, 10, files.length);
  write32(endView, 12, centralData.length);
  write32(endView, 16, localData.length);
  write16(endView, 20, 0);
  return concat([localData, centralData, end]);
}

function initialState(clientId: string, appSessionId: string): DiagnosticState {
  const timestamp = nowIso();
  return {
    schemaVersion: 2,
    createdAt: timestamp,
    updatedAt: timestamp,
    legacyTruncated: false,
    sequence: 0,
    persistedEntryCount: 0,
    estimatedBytes: 0,
    appSessions: [{ id: appSessionId, clientId, startedAt: timestamp }],
    notes: [],
  };
}

function indexedDbError(error: DOMException | null, fallback: string): Error {
  if (!error) return new Error(fallback);
  return new Error(`${error.name}: ${error.message || fallback}`);
}

function requestResult<T>(request: IDBRequest<T>, context: string): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(indexedDbError(request.error, `${context} request failed`));
  });
}

function transactionComplete(
  transaction: IDBTransaction,
  context: string,
  getRequestError?: () => Error | undefined,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (fallback: string): void => {
      if (settled) return;
      settled = true;
      reject(getRequestError?.() || indexedDbError(transaction.error, fallback));
    };

    transaction.oncomplete = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    transaction.onerror = () => fail(`${context} transaction failed`);
    transaction.onabort = () => fail(`${context} transaction aborted`);
  });
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is not available'));
      return;
    }

    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      let entries: IDBObjectStore;

      if (!database.objectStoreNames.contains(ENTRY_STORE)) {
        entries = database.createObjectStore(ENTRY_STORE, { keyPath: 'id', autoIncrement: true });
      } else {
        const upgradeTransaction = request.transaction;
        if (!upgradeTransaction) throw new Error('IndexedDB upgrade transaction is unavailable');
        entries = upgradeTransaction.objectStore(ENTRY_STORE);
      }

      if (entries.indexNames.contains('sequence')) {
        entries.deleteIndex('sequence');
      }

      if (!database.objectStoreNames.contains(META_STORE)) {
        database.createObjectStore(META_STORE, { keyPath: 'key' });
      }
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => database.close();
      resolve(database);
    };
    request.onerror = () => reject(indexedDbError(request.error, 'Failed to open IndexedDB'));
    request.onblocked = () => reject(new Error('IndexedDB upgrade is blocked by another app window'));
  });
}

async function readStoredState(database: IDBDatabase): Promise<DiagnosticState | undefined> {
  const transaction = database.transaction(META_STORE, 'readonly');
  const completed = transactionComplete(transaction, 'read metadata');
  const record = await requestResult(
    transaction.objectStore(META_STORE).get(META_KEY) as IDBRequest<StoredMetaRecord | undefined>,
    'read metadata',
  );
  await completed;
  return record?.value;
}

async function readAllEntries(database: IDBDatabase): Promise<DiagnosticEntry[]> {
  const transaction = database.transaction(ENTRY_STORE, 'readonly');
  const completed = transactionComplete(transaction, 'read entries');
  const entries = await requestResult(
    transaction.objectStore(ENTRY_STORE).getAll() as IDBRequest<DiagnosticEntry[]>,
    'read entries',
  );
  await completed;
  return entries.sort(compareEntries);
}

function compareEntries(left: DiagnosticEntry, right: DiagnosticEntry): number {
  if (left.id !== undefined && right.id !== undefined && left.id !== right.id) {
    return left.id - right.id;
  }
  if (left.receivedAt !== right.receivedAt) {
    return left.receivedAt.localeCompare(right.receivedAt);
  }
  if (left.sequence !== right.sequence) {
    return left.sequence - right.sequence;
  }
  return left.appSessionId.localeCompare(right.appSessionId);
}

function loadLegacyState(): LegacyDiagnosticState | undefined {
  try {
    const raw = window.localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as LegacyDiagnosticState;
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.entries) || !Array.isArray(parsed.notes)) {
      return undefined;
    }
    return parsed;
  } catch (error) {
    console.error('Failed to read legacy diagnostic state:', error);
    return undefined;
  }
}

function entryIdentity(entry: DiagnosticEntry): string {
  return [
    entry.appSessionId,
    entry.sequence,
    entry.receivedAt,
    entry.source,
    entry.category || '',
    entry.key || '',
  ].join('|');
}

function mergeEntries(...groups: DiagnosticEntry[][]): DiagnosticEntry[] {
  const result: DiagnosticEntry[] = [];
  const identities = new Set<string>();
  for (const group of groups) {
    for (const entry of group) {
      const identity = entryIdentity(entry);
      if (identities.has(identity)) continue;
      identities.add(identity);
      result.push(entry);
    }
  }
  return result.sort(compareEntries);
}

export class DiagnosticCapture {
  private readonly appSessionId = randomId('session');
  private state: DiagnosticState;
  private database?: IDBDatabase;
  private storageStatus: StorageStatus = 'INITIALIZING';
  private storageError?: string;
  private matchComplete = false;
  private initialized = false;
  private flushTimerId?: number;
  private pendingEntries: DiagnosticEntry[] = [];
  private memoryFallbackEntries: DiagnosticEntry[] = [];
  private storageChain: Promise<void> = Promise.resolve();
  private readonly fingerprints = new Map<string, string>();
  private readonly lastRosterCaptureAt = new Map<string, number>();
  private readonly ready: Promise<void>;

  constructor(private readonly clientId: string) {
    this.state = initialState(clientId, this.appSessionId);
    this.ready = this.initializeStorage();
    void this.ready.then(() => {
      this.captureSystem('system', 'app_session_started', {
        clientId,
        appSessionId: this.appSessionId,
      });
    });
  }

  initialize(overwolfApi: any): void {
    if (this.initialized) return;
    this.initialized = true;
    this.mountPanel();

    void this.ready.then(() => {
      overwolfApi?.games?.events?.getInfo?.((value: unknown) =>
        this.captureSystem('getInfo', 'initial_snapshot', value),
      );
      overwolfApi?.games?.getRunningGameInfo?.((value: unknown) =>
        this.captureSystem('runningGameInfo', 'running_game_info', value),
      );
      overwolfApi?.extensions?.current?.getManifest?.((value: unknown) =>
        this.captureSystem('manifest', 'overwolf_manifest', value),
      );
      this.refreshPanel();
    });
  }

  captureRaw(event: DiagnosticRawEvent): void {
    if (!shouldCaptureDiagnosticEvent(event)) return;

    const rawPayload = sanitize(event.rawPayload);
    const fingerprint = stringify(rawPayload);
    const channel = createDiagnosticChannel(event);
    if (this.fingerprints.get(channel) === fingerprint) return;

    if (isRosterEvent(event)) {
      const previousCaptureAt = this.lastRosterCaptureAt.get(channel) || 0;
      if (event.receivedAt - previousCaptureAt < ROSTER_THROTTLE_MS) return;
      this.lastRosterCaptureAt.set(channel, event.receivedAt);
    }

    this.fingerprints.set(channel, fingerprint);
    if (event.key === 'match_id') {
      this.state.currentMatchId = primitiveString(rawPayload) || this.state.currentMatchId;
    }
    if (isMatchCompleteKey(event.key)) {
      this.matchComplete = true;
    }

    this.append(
      {
        sequence: this.nextSequence(),
        appSessionId: this.appSessionId,
        receivedAt: new Date(event.receivedAt).toISOString(),
        source: event.source,
        matchId: this.state.currentMatchId,
        feature: event.feature,
        category: event.category,
        key: event.key,
        rawPayload,
      },
      isCriticalDiagnosticEvent(event),
    );
  }

  private nextSequence(): number {
    this.state.sequence += 1;
    return this.state.sequence;
  }

  private async initializeStorage(): Promise<void> {
    try {
      this.database = await openDatabase();
      const storedState = await readStoredState(this.database);
      const existingEntries = await readAllEntries(this.database);
      const legacyState = storedState ? undefined : loadLegacyState();

      if (legacyState) {
        await this.migrateLegacyState(legacyState, existingEntries);
      } else if (storedState?.schemaVersion === 2) {
        this.state = this.reconcileStoredState(storedState, existingEntries);
      } else if (existingEntries.length) {
        this.state = this.reconcileStoredState(this.state, existingEntries);
      }

      if (!this.state.appSessions.some((session) => session.id === this.appSessionId)) {
        this.state.appSessions.push({ id: this.appSessionId, clientId: this.clientId, startedAt: nowIso() });
      }
      this.state.appSessions = this.state.appSessions.slice(-100);
      this.matchComplete = existingEntries.some((entry) => isMatchCompleteKey(entry.key));
      this.storageStatus = this.matchComplete ? 'COMPLETE' : 'RECORDING';
      await this.persistMetadataNow();
    } catch (error) {
      this.enterStorageError(error);
    } finally {
      this.refreshPanel();
    }
  }

  private reconcileStoredState(state: DiagnosticState, entries: DiagnosticEntry[]): DiagnosticState {
    const maxSequence = entries.reduce((maximum, entry) => Math.max(maximum, entry.sequence || 0), 0);
    const latestMatchId = [...entries]
      .reverse()
      .map((entry) => entry.matchId || findMatchId(entry.rawPayload))
      .find((matchId): matchId is string => Boolean(matchId));

    return {
      ...state,
      schemaVersion: 2,
      currentMatchId: state.currentMatchId || latestMatchId,
      legacyTruncated: Boolean(state.legacyTruncated),
      sequence: Math.max(state.sequence || 0, maxSequence),
      persistedEntryCount: entries.length,
      estimatedBytes: entries.reduce((sum, entry) => sum + estimateBytes(entry), 0),
      appSessions: Array.isArray(state.appSessions) ? state.appSessions : [],
      notes: Array.isArray(state.notes) ? state.notes : [],
    };
  }

  private async migrateLegacyState(
    legacy: LegacyDiagnosticState,
    existingEntries: DiagnosticEntry[],
  ): Promise<void> {
    if (!this.database) return;

    const legacyEntries = Array.isArray(legacy.entries) ? legacy.entries : [];
    const entries = mergeEntries(existingEntries, legacyEntries);
    const migratedState: DiagnosticState = {
      schemaVersion: 2,
      createdAt: legacy.createdAt || nowIso(),
      updatedAt: legacy.updatedAt || nowIso(),
      currentMatchId: legacy.currentMatchId,
      manualSteamBuildId: legacy.manualSteamBuildId,
      legacyTruncated: Boolean(legacy.truncated),
      sequence: Math.max(legacy.sequence || 0, ...entries.map((entry) => entry.sequence || 0), 0),
      persistedEntryCount: entries.length,
      estimatedBytes: entries.reduce((sum, entry) => sum + estimateBytes(entry), 0),
      appSessions: Array.isArray(legacy.appSessions) ? legacy.appSessions : [],
      notes: Array.isArray(legacy.notes) ? legacy.notes : [],
    };

    let requestFailure: Error | undefined;
    const transaction = this.database.transaction([ENTRY_STORE, META_STORE], 'readwrite');
    const completed = transactionComplete(transaction, 'migrate legacy diagnostics', () => requestFailure);
    const entryStore = transaction.objectStore(ENTRY_STORE);
    entryStore.clear();
    for (const entry of entries) {
      const copy = { ...entry };
      delete copy.id;
      const request = entryStore.add(copy);
      request.onerror = () => {
        requestFailure ||= indexedDbError(request.error, 'Failed to migrate a diagnostic entry');
      };
    }
    const metadataRequest = transaction
      .objectStore(META_STORE)
      .put({ key: META_KEY, value: migratedState } as StoredMetaRecord);
    metadataRequest.onerror = () => {
      requestFailure ||= indexedDbError(metadataRequest.error, 'Failed to migrate diagnostic metadata');
    };
    await completed;

    this.state = migratedState;
    window.localStorage.removeItem(LEGACY_STORAGE_KEY);
  }

  private captureSystem(source: EntrySource, key: string, rawPayload: unknown): void {
    const payload = sanitize(rawPayload);
    this.state.currentMatchId = findMatchId(payload) || this.state.currentMatchId;
    this.append(
      {
        sequence: this.nextSequence(),
        appSessionId: this.appSessionId,
        receivedAt: nowIso(),
        source,
        matchId: this.state.currentMatchId,
        key,
        rawPayload: payload,
      },
      true,
    );
  }

  private append(entry: DiagnosticEntry, critical: boolean): void {
    this.pendingEntries.push(entry);
    this.state.updatedAt = nowIso();

    if (critical || this.pendingEntries.length >= MAX_BATCH_SIZE) {
      void this.flushPendingEntries();
    } else {
      this.scheduleFlush();
    }
    this.refreshPanel();
  }

  private scheduleFlush(): void {
    if (this.flushTimerId !== undefined) return;
    this.flushTimerId = window.setTimeout(() => {
      this.flushTimerId = undefined;
      void this.flushPendingEntries();
    }, FLUSH_DELAY_MS);
  }

  private flushPendingEntries(): Promise<void> {
    if (!this.pendingEntries.length) return this.storageChain;
    if (this.flushTimerId !== undefined) {
      window.clearTimeout(this.flushTimerId);
      this.flushTimerId = undefined;
    }

    const batch = this.pendingEntries.splice(0, this.pendingEntries.length);
    return this.enqueueStorageOperation(async () => {
      try {
        await this.writeBatchWithRetry(batch);
      } catch (error) {
        this.rememberFallback(batch);
        this.enterStorageError(error);
      }
    });
  }

  private enqueueStorageOperation(operation: () => Promise<void>): Promise<void> {
    this.storageChain = this.storageChain
      .then(() => this.ready)
      .then(operation)
      .catch((error) => this.enterStorageError(error));
    return this.storageChain;
  }

  private async writeBatchWithRetry(batch: DiagnosticEntry[]): Promise<void> {
    const entries = mergeEntries(this.memoryFallbackEntries, batch);
    if (!entries.length) return;

    let firstError: unknown;
    try {
      await this.ensureDatabase();
      await this.writeBatchOnce(entries);
    } catch (error) {
      firstError = error;
      await this.reopenDatabase();
      try {
        await this.writeBatchOnce(entries);
      } catch (retryError) {
        const firstMessage = firstError instanceof Error ? firstError.message : String(firstError);
        const retryMessage = retryError instanceof Error ? retryError.message : String(retryError);
        throw new Error(`IndexedDB write failed twice: ${firstMessage}; retry: ${retryMessage}`);
      }
    }

    this.memoryFallbackEntries = [];
    this.storageError = undefined;
    this.storageStatus = this.matchComplete ? 'COMPLETE' : 'RECORDING';
    this.refreshPanel();
  }

  private async writeBatchOnce(batch: DiagnosticEntry[]): Promise<void> {
    if (!this.database) throw new Error('IndexedDB connection is unavailable');

    const batchBytes = batch.reduce((sum, entry) => sum + estimateBytes(entry), 0);
    const nextState: DiagnosticState = {
      ...this.state,
      updatedAt: nowIso(),
      persistedEntryCount: this.state.persistedEntryCount + batch.length,
      estimatedBytes: this.state.estimatedBytes + batchBytes,
      appSessions: [...this.state.appSessions],
      notes: [...this.state.notes],
    };

    let requestFailure: Error | undefined;
    const transaction = this.database.transaction([ENTRY_STORE, META_STORE], 'readwrite');
    const completed = transactionComplete(transaction, 'write diagnostic batch', () => requestFailure);
    const entryStore = transaction.objectStore(ENTRY_STORE);
    for (const entry of batch) {
      const copy = { ...entry };
      delete copy.id;
      const request = entryStore.add(copy);
      request.onerror = () => {
        requestFailure ||= indexedDbError(
          request.error,
          `Failed to store diagnostic entry ${entry.appSessionId}/${entry.sequence}`,
        );
      };
    }
    const metadataRequest = transaction
      .objectStore(META_STORE)
      .put({ key: META_KEY, value: nextState } as StoredMetaRecord);
    metadataRequest.onerror = () => {
      requestFailure ||= indexedDbError(metadataRequest.error, 'Failed to store diagnostic metadata');
    };
    await completed;

    this.state = nextState;
  }

  private rememberFallback(entries: DiagnosticEntry[]): void {
    this.memoryFallbackEntries = mergeEntries(this.memoryFallbackEntries, entries);
  }

  private async ensureDatabase(): Promise<void> {
    if (this.database) return;
    this.database = await openDatabase();
  }

  private async reopenDatabase(): Promise<void> {
    this.database?.close();
    this.database = undefined;
    this.database = await openDatabase();
  }

  private async persistMetadataNow(): Promise<void> {
    await this.ensureDatabase();
    if (!this.database) throw new Error('IndexedDB connection is unavailable');

    let requestFailure: Error | undefined;
    const transaction = this.database.transaction(META_STORE, 'readwrite');
    const completed = transactionComplete(transaction, 'write diagnostic metadata', () => requestFailure);
    const request = transaction
      .objectStore(META_STORE)
      .put({ key: META_KEY, value: this.state } as StoredMetaRecord);
    request.onerror = () => {
      requestFailure ||= indexedDbError(request.error, 'Failed to store diagnostic metadata');
    };
    await completed;
  }

  private queueMetadataPersist(): void {
    void this.enqueueStorageOperation(async () => {
      try {
        await this.persistMetadataNow();
      } catch (error) {
        await this.reopenDatabase();
        await this.persistMetadataNow().catch((retryError) => {
          const firstMessage = error instanceof Error ? error.message : String(error);
          const retryMessage = retryError instanceof Error ? retryError.message : String(retryError);
          throw new Error(`IndexedDB metadata write failed twice: ${firstMessage}; retry: ${retryMessage}`);
        });
      }
    });
  }

  private enterStorageError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.storageStatus = 'STORAGE_ERROR';
    this.storageError = message;
    console.error('Diagnostic capture storage error:', error);
    this.refreshPanel();
  }

  private addNote(): void {
    const action = document.getElementById('diagnostic-action') as HTMLSelectElement | null;
    const item = document.getElementById('diagnostic-item') as HTMLInputElement | null;
    const gameTime = document.getElementById('diagnostic-game-time') as HTMLInputElement | null;
    const note = document.getElementById('diagnostic-note') as HTMLInputElement | null;
    if (!action) return;

    this.state.notes.push({
      id: randomId('note'),
      createdAt: nowIso(),
      matchId: this.state.currentMatchId,
      action: action.value,
      item: item?.value.trim() || undefined,
      approximateGameTime: gameTime?.value.trim() || undefined,
      note: note?.value.trim() || undefined,
    });
    this.state.updatedAt = nowIso();
    this.queueMetadataPersist();
    if (item) item.value = '';
    if (gameTime) gameTime.value = '';
    if (note) note.value = '';
    this.refreshPanel();
  }

  private async clear(): Promise<void> {
    if (!window.confirm('Clear all captured diagnostic events and notes?')) return;

    try {
      await this.flushPendingEntries();
      await this.storageChain;
      this.pendingEntries = [];
      this.memoryFallbackEntries = [];
      this.fingerprints.clear();
      this.lastRosterCaptureAt.clear();
      this.matchComplete = false;
      this.storageError = undefined;

      await this.ensureDatabase();
      if (!this.database) throw new Error('IndexedDB connection is unavailable');

      let requestFailure: Error | undefined;
      const transaction = this.database.transaction([ENTRY_STORE, META_STORE], 'readwrite');
      const completed = transactionComplete(transaction, 'clear diagnostics', () => requestFailure);
      const clearEntriesRequest = transaction.objectStore(ENTRY_STORE).clear();
      clearEntriesRequest.onerror = () => {
        requestFailure ||= indexedDbError(clearEntriesRequest.error, 'Failed to clear diagnostic entries');
      };
      const clearMetaRequest = transaction.objectStore(META_STORE).clear();
      clearMetaRequest.onerror = () => {
        requestFailure ||= indexedDbError(clearMetaRequest.error, 'Failed to clear diagnostic metadata');
      };
      await completed;

      this.state = initialState(this.clientId, this.appSessionId);
      this.storageStatus = 'RECORDING';
      await this.persistMetadataNow();
    } catch (error) {
      this.enterStorageError(error);
      window.alert(`Failed to clear diagnostics: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.refreshPanel();
    }
  }

  private async exportArchive(): Promise<void> {
    const exportButton = document.getElementById('diagnostic-export') as HTMLButtonElement | null;
    if (exportButton) {
      exportButton.disabled = true;
      exportButton.textContent = 'Exporting...';
    }

    try {
      await this.flushPendingEntries();
      await this.storageChain;
      const persistedEntries = this.database ? await readAllEntries(this.database) : [];
      const entries = mergeEntries(persistedEntries, this.memoryFallbackEntries);
      const matchIds = Array.from(
        new Set(entries.map((entry) => entry.matchId).filter((value): value is string => !!value)),
      );
      const candidates = Array.from(
        entries.reduce((result, entry) => collectVersionCandidates(entry.rawPayload, result), new Set<string>()),
      ).sort();
      const shopSignalAnalysis = analyzeShopSignalCandidatesV1(entries, this.state.notes);
      const sessionInfo = {
        schemaVersion: 2,
        createdAt: this.state.createdAt,
        updatedAt: this.state.updatedAt,
        exportedAt: nowIso(),
        currentMatchId: this.state.currentMatchId,
        matchIds,
        manualSteamBuildId: this.state.manualSteamBuildId,
        truncated: this.state.legacyTruncated,
        legacyTruncated: this.state.legacyTruncated,
        storageStatus: this.storageStatus,
        storageError: this.storageError,
        entryCount: entries.length,
        persistedEntryCount: persistedEntries.length,
        memoryFallbackEntryCount: this.memoryFallbackEntries.length,
        estimatedBytes: entries.reduce((sum, entry) => sum + estimateBytes(entry), 0),
        appSessions: this.state.appSessions,
      };
      const zipBytes = createStoredZipBytes([
        { name: 'overwolf-events.ndjson', content: entries.map((entry) => stringify(entry)).join('\n') },
        { name: 'session-info.json', content: stringify(sessionInfo, 2) },
        { name: 'notes.json', content: stringify(this.state.notes, 2) },
        { name: 'shop-signal-candidates.json', content: stringify(shopSignalAnalysis, 2) },
        {
          name: 'steam-build.txt',
          content: [
            `Manual Steam build ID: ${this.state.manualSteamBuildId || 'not provided'}`,
            '',
            'Detected build/version candidates:',
            ...(candidates.length ? candidates.map((candidate) => `- ${candidate}`) : ['- none']),
          ].join('\n'),
        },
        {
          name: 'README.txt',
          content: [
            'Deadlock Live Probe diagnostic capture',
            '',
            'Upload this ZIP without editing it.',
            'Events are stored in IndexedDB and exported in insertion order.',
            'The archive contains raw deduplicated GEP values, startup snapshots, match IDs, and manual action markers.',
            '',
            'Direct-shop discovery:',
            '- Add SHOP_AVAILABLE and SHOP_UNAVAILABLE markers immediately when you manually observe each state.',
            '- shop-signal-candidates.json only ranks correlated raw GEP channels.',
            '- A candidate is never promoted automatically to DIRECT_SOURCE_SIGNAL; independent validation is required.',
          ].join('\n'),
        },
      ]);

      const zipBuffer = new ArrayBuffer(zipBytes.byteLength);
      new Uint8Array(zipBuffer).set(zipBytes);
      const objectUrl = URL.createObjectURL(new Blob([zipBuffer], { type: 'application/zip' }));
      const anchor = document.createElement('a');
      const matchLabel =
        matchIds.length === 1 ? matchIds[0] : matchIds.length > 1 ? 'multiple-matches' : 'unknown-match';
      anchor.href = objectUrl;
      anchor.download = `deadlock-diagnostics-${matchLabel}-${nowIso().replace(/[:.]/g, '-')}.zip`;
      anchor.style.display = 'none';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    } catch (error) {
      this.enterStorageError(error);
      window.alert(`Failed to export diagnostics: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (exportButton) {
        exportButton.disabled = false;
        exportButton.textContent = 'Export ZIP';
      }
    }
  }

  private mountPanel(): void {
    // The player-facing Dynamo Lab windows must not expose diagnostic controls.
    // Capture keeps running; the marker/export panel only mounts on explicit opt-in
    // (a dedicated diagnostics window is the intended home for it).
    if ((globalThis as { __deadlockDiagnosticPanel?: boolean }).__deadlockDiagnosticPanel !== true) {
      return;
    }

    if (document.getElementById('diagnostic-capture-panel')) {
      this.refreshPanel();
      return;
    }

    const style = document.createElement('style');
    style.textContent = `
      #diagnostic-capture-panel{border:1px solid #3b3b4b;border-radius:10px;background:#14141a;padding:10px 12px;display:flex;flex-direction:column;gap:8px;font-family:'Outfit',sans-serif}
      #diagnostic-capture-panel .row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
      #diagnostic-capture-panel .title{font-size:12px;font-weight:700;color:#ff6b4a;margin-right:auto}
      #diagnostic-capture-panel .status{font-size:11px;color:#9ca3af}
      #diagnostic-capture-panel .badge{border-radius:999px;padding:2px 7px;font-size:10px;font-weight:700;letter-spacing:.04em}
      #diagnostic-capture-panel .badge.recording{background:#164e3d;color:#86efac}
      #diagnostic-capture-panel .badge.complete{background:#1e3a5f;color:#93c5fd}
      #diagnostic-capture-panel .badge.initializing{background:#3f3f46;color:#d4d4d8}
      #diagnostic-capture-panel .badge.error{background:#5f1d26;color:#fca5a5}
      #diagnostic-capture-panel input,#diagnostic-capture-panel select,#diagnostic-capture-panel button{border:1px solid #343444;border-radius:5px;background:#1b1b22;color:#f3f4f6;padding:5px 7px;font:inherit;font-size:11px}
      #diagnostic-capture-panel input{min-width:90px;flex:1}#diagnostic-capture-panel button{cursor:pointer}
      #diagnostic-capture-panel button:disabled{opacity:.6;cursor:default}
      #diagnostic-capture-panel .primary{background:#ff6b4a;border-color:#ff6b4a;color:#111;font-weight:700}
      #diagnostic-capture-panel .danger{color:#f87171}
    `;
    document.head.appendChild(style);

    const panel = document.createElement('section');
    panel.id = 'diagnostic-capture-panel';
    panel.innerHTML = `
      <div class="row"><span class="title">Diagnostic Capture</span><span class="badge initializing" id="diagnostic-storage-status">INITIALIZING</span><span class="status" id="diagnostic-status"></span><button class="primary" id="diagnostic-export">Export ZIP</button><button class="danger" id="diagnostic-clear">Clear</button></div>
      <div class="row"><input id="diagnostic-steam-build" placeholder="Steam build ID (optional)"><select id="diagnostic-action"><option>SHOP_AVAILABLE</option><option>SHOP_UNAVAILABLE</option><option>BUY</option><option>UPGRADE</option><option>SELL</option><option>REBUY</option><option>CONSUME</option><option>RECONNECT</option><option>OTHER</option></select><input id="diagnostic-item" placeholder="Item name"><input id="diagnostic-game-time" placeholder="Game time MM:SS"><input id="diagnostic-note" placeholder="Optional note"><button id="diagnostic-add-note">Add marker</button></div>
    `;
    const appLayout = document.querySelector('.app-layout');
    appLayout?.parentElement ? appLayout.parentElement.insertBefore(panel, appLayout) : document.body.prepend(panel);
    document.getElementById('diagnostic-export')?.addEventListener('click', () => void this.exportArchive());
    document.getElementById('diagnostic-clear')?.addEventListener('click', () => void this.clear());
    document.getElementById('diagnostic-add-note')?.addEventListener('click', () => this.addNote());
    document.getElementById('diagnostic-steam-build')?.addEventListener('input', (event) => {
      this.state.manualSteamBuildId = (event.target as HTMLInputElement).value.trim() || undefined;
      this.state.updatedAt = nowIso();
      this.queueMetadataPersist();
    });
    const buildInput = document.getElementById('diagnostic-steam-build') as HTMLInputElement | null;
    if (buildInput) buildInput.value = this.state.manualSteamBuildId || '';
    this.refreshPanel();
  }

  private refreshPanel(): void {
    const status = document.getElementById('diagnostic-status');
    const storageStatus = document.getElementById('diagnostic-storage-status');
    if (!status || !storageStatus) return;

    const totalEntries =
      this.state.persistedEntryCount + this.pendingEntries.length + this.memoryFallbackEntries.length;
    const pendingBytes = this.pendingEntries.reduce((sum, entry) => sum + estimateBytes(entry), 0);
    const fallbackBytes = this.memoryFallbackEntries.reduce((sum, entry) => sum + estimateBytes(entry), 0);
    const totalBytes = this.state.estimatedBytes + pendingBytes + fallbackBytes;
    const displayedStatus: StorageStatus =
      this.storageStatus === 'STORAGE_ERROR'
        ? 'STORAGE_ERROR'
        : this.matchComplete
          ? 'COMPLETE'
          : this.storageStatus;

    storageStatus.textContent = displayedStatus;
    storageStatus.className = `badge ${
      displayedStatus === 'STORAGE_ERROR'
        ? 'error'
        : displayedStatus === 'COMPLETE'
          ? 'complete'
          : displayedStatus === 'RECORDING'
            ? 'recording'
            : 'initializing'
    }`;
    storageStatus.title = this.storageError || '';
    status.textContent = `match ${this.state.currentMatchId || 'unknown'} | ${totalEntries} events | ${this.state.notes.length} markers | ~${(totalBytes / 1024 / 1024).toFixed(1)} MB${this.state.legacyTruncated ? ' | LEGACY TRUNCATED' : ''}`;
  }
}
