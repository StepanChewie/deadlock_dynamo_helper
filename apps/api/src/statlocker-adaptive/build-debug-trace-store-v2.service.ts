import { Injectable } from '@nestjs/common';
import { Observable, ReplaySubject } from 'rxjs';
import { BuildDecisionTraceV2 } from './build-decision-trace-v2';

export interface BuildDebugMatchSummaryV2 {
  matchId: string;
  steamId: string;
  revision: number;
  stateRevision: string;
  generatedAt: string;
}

interface BuildDebugTraceMatchStateV2 {
  revisions: readonly BuildDecisionTraceV2[];
  updatedAtMs: number;
}

const DEFAULT_TRACE_TAIL_SIZE = 8;
const DEFAULT_TRACE_TTL_MS = 60 * 60 * 1000;

@Injectable()
export class BuildDebugTraceStoreV2Service {
  private readonly matches = new Map<string, BuildDebugTraceMatchStateV2>();
  private readonly streams = new Map<string, ReplaySubject<BuildDecisionTraceV2>>();

  put(trace: BuildDecisionTraceV2): void {
    this.purgeExpired();
    validateTrace(trace);

    const existing = this.matches.get(traceKey(trace.matchId, trace.steamId));
    const current = existing?.revisions[existing.revisions.length - 1];
    if (current && trace.revision <= current.revision) {
      throw new Error(
        `Build debug trace store v2: revision must increase for match ${trace.matchId}`,
      );
    }

    const immutableTrace = deepFreeze(copyTrace(trace));
    const tailSize = readPositiveInteger(
      process.env.BUILD_DEBUG_TRACE_TAIL ?? process.env.BUILD_DEBUG_TRACE_TAIL_SIZE,
      DEFAULT_TRACE_TAIL_SIZE,
    );
    const revisions = [...(existing?.revisions ?? []), immutableTrace].slice(-tailSize);
    this.matches.set(traceKey(trace.matchId, trace.steamId), {
      revisions,
      updatedAtMs: Date.now(),
    });
    this.stream(trace.matchId, trace.steamId).next(immutableTrace);
  }

  get(matchId: string, steamId: string): BuildDecisionTraceV2 | undefined {
    this.purgeExpired();
    validateMatchId(matchId);
    validateSteamId(steamId);
    const revisions = this.matches.get(traceKey(matchId, steamId))?.revisions ?? [];
    return revisions[revisions.length - 1];
  }

  listActive(): readonly BuildDebugMatchSummaryV2[] {
    this.purgeExpired();
    return [...this.matches.values()]
      .map((state) => {
        const current = state.revisions[state.revisions.length - 1];
        return {
          matchId: current.matchId,
          steamId: current.steamId,
          revision: current.revision,
          stateRevision: current.stateRevision,
          generatedAt: current.generatedAt,
        };
      })
      .sort((left, right) =>
        left.matchId.localeCompare(right.matchId) || left.steamId.localeCompare(right.steamId));
  }

  revisions(matchId: string, steamId: string): readonly BuildDecisionTraceV2[] {
    this.purgeExpired();
    validateMatchId(matchId);
    validateSteamId(steamId);
    return [...(this.matches.get(traceKey(matchId, steamId))?.revisions ?? [])];
  }

  observe(matchId: string, steamId: string): Observable<BuildDecisionTraceV2> {
    this.purgeExpired();
    validateMatchId(matchId);
    validateSteamId(steamId);
    const existingStream = this.streams.get(traceKey(matchId, steamId));
    if (existingStream) return existingStream.asObservable();

    const subject = new ReplaySubject<BuildDecisionTraceV2>(1);
    this.streams.set(traceKey(matchId, steamId), subject);
    const current = this.get(matchId, steamId);
    if (current) subject.next(current);
    return subject.asObservable();
  }

  private stream(matchId: string, steamId: string): ReplaySubject<BuildDecisionTraceV2> {
    const key = traceKey(matchId, steamId);
    const existing = this.streams.get(key);
    if (existing) return existing;
    const subject = new ReplaySubject<BuildDecisionTraceV2>(1);
    this.streams.set(key, subject);
    return subject;
  }

  private purgeExpired(): void {
    const nowMs = Date.now();
    const ttlMs = readTraceTtlMs();
    for (const [key, state] of this.matches) {
      if (nowMs - state.updatedAtMs <= ttlMs) continue;
      this.matches.delete(key);
      const stream = this.streams.get(key);
      stream?.complete();
      this.streams.delete(key);
    }
  }
}

function traceKey(matchId: string, steamId: string): string {
  return `${matchId}|${steamId}`;
}

function validateTrace(trace: BuildDecisionTraceV2): void {
  validateMatchId(trace.matchId);
  validateSteamId(trace.steamId);
  if (!Number.isInteger(trace.revision) || trace.revision <= 0) {
    throw new Error('Build debug trace store v2: revision must be a positive integer');
  }
  if (!trace.stateRevision.trim()) {
    throw new Error('Build debug trace store v2: stateRevision must not be empty');
  }
  if (!Number.isFinite(Date.parse(trace.generatedAt))) {
    throw new Error('Build debug trace store v2: generatedAt must be a valid ISO timestamp');
  }
}

function validateMatchId(matchId: string): void {
  if (!matchId.trim()) {
    throw new Error('Build debug trace store v2: matchId must not be empty');
  }
}

function validateSteamId(steamId: string): void {
  if (steamId.trim() === '' || steamId.length > 32) {
    throw new Error('Build debug trace store v2: steamId is invalid');
  }
}

function readTraceTtlMs(): number {
  const documentedSeconds = readPositiveInteger(process.env.BUILD_DEBUG_TRACE_IDLE_TTL_SEC, 0);
  if (documentedSeconds > 0) return documentedSeconds * 1000;
  return readPositiveInteger(process.env.BUILD_DEBUG_TRACE_TTL_MS, DEFAULT_TRACE_TTL_MS);
}

function readPositiveInteger(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function copyTrace(trace: BuildDecisionTraceV2): BuildDecisionTraceV2 {
  return JSON.parse(JSON.stringify(trace)) as BuildDecisionTraceV2;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}
