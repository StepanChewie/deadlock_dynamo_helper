import { Injectable } from '@nestjs/common';
import {
  appendFile,
  mkdir,
  readdir,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { OverwolfLiveEventDto } from '@dynamo-lab/shared';

const DEFAULT_MAX_FILE_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_FILES = 32;
const DEFAULT_PRUNE_INTERVAL_MS = 60_000;

@Injectable()
export class RawEventLogService {
  private readonly baseDir = process.env.DEADLOCK_LIVE_RAW_LOG_DIR?.trim()
    || join(process.cwd(), 'storage', 'deadlock-live');
  private readonly maxFileBytes = readPositiveIntegerEnv(
    'DEADLOCK_LIVE_RAW_LOG_MAX_BYTES',
    DEFAULT_MAX_FILE_BYTES,
  );
  private readonly maxFiles = readPositiveIntegerEnv(
    'DEADLOCK_LIVE_RAW_LOG_MAX_FILES',
    DEFAULT_MAX_FILES,
  );
  private readonly pruneIntervalMs = readNonNegativeIntegerEnv(
    'DEADLOCK_LIVE_RAW_LOG_PRUNE_INTERVAL_MS',
    DEFAULT_PRUNE_INTERVAL_MS,
  );
  private writeQueue: Promise<void> = Promise.resolve();
  private lastPruneAt = 0;

  appendEvents(events: OverwolfLiveEventDto[]): Promise<void> {
    if (events.length === 0) {
      return Promise.resolve();
    }

    const work = this.writeQueue.then(() => this.appendEventsInternal(events));
    this.writeQueue = work.catch(() => undefined);
    return work;
  }

  private async appendEventsInternal(events: OverwolfLiveEventDto[]): Promise<void> {
    await mkdir(this.baseDir, { recursive: true });

    const eventsByMatchId = new Map<string, OverwolfLiveEventDto[]>();
    for (const event of events) {
      const matchId = sanitizeMatchId(event.matchId ?? 'unknown');
      const existingEvents = eventsByMatchId.get(matchId);
      if (existingEvents) {
        existingEvents.push(event);
      } else {
        eventsByMatchId.set(matchId, [event]);
      }
    }

    for (const [matchId, matchEvents] of eventsByMatchId.entries()) {
      const incoming = boundNdjson(
        matchEvents.map((event) => `${JSON.stringify(event)}\n`).join(''),
        this.maxFileBytes,
      );
      if (!incoming) {
        continue;
      }

      const filePath = join(this.baseDir, `${matchId}.ndjson`);
      const existingBytes = await readFileSize(filePath);
      const incomingBytes = Buffer.byteLength(incoming, 'utf8');
      if (existingBytes + incomingBytes > this.maxFileBytes) {
        await writeFile(filePath, incoming, 'utf8');
      } else {
        await appendFile(filePath, incoming, 'utf8');
      }
    }

    await this.pruneOldFilesWhenDue();
  }

  private async pruneOldFilesWhenDue(): Promise<void> {
    const now = Date.now();
    if (now - this.lastPruneAt < this.pruneIntervalMs) {
      return;
    }
    this.lastPruneAt = now;

    const entries = await readdir(this.baseDir, { withFileTypes: true });
    const files = (
      await Promise.all(
        entries
          .filter((entry) => entry.isFile() && entry.name.endsWith('.ndjson'))
          .map(async (entry) => {
            const filePath = join(this.baseDir, entry.name);
            const fileStat = await stat(filePath);
            return { filePath, mtimeMs: fileStat.mtimeMs };
          }),
      )
    ).sort((a, b) => b.mtimeMs - a.mtimeMs);

    for (const file of files.slice(this.maxFiles)) {
      await unlink(file.filePath);
    }
  }
}

async function readFileSize(filePath: string): Promise<number> {
  try {
    return (await stat(filePath)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return 0;
    }
    throw error;
  }
}

function boundNdjson(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) {
    return value;
  }

  const lines = value.split('\n').filter(Boolean);
  const kept: string[] = [];
  let bytes = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = `${lines[index]}\n`;
    const lineBytes = Buffer.byteLength(line, 'utf8');
    if (lineBytes > maxBytes) {
      continue;
    }
    if (bytes + lineBytes > maxBytes) {
      break;
    }
    kept.unshift(line);
    bytes += lineBytes;
  }
  return kept.join('');
}

function sanitizeMatchId(value: string): string {
  const normalized = value.trim().replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120);
  return normalized || 'unknown';
}

function readPositiveIntegerEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function readNonNegativeIntegerEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}
