import { Injectable } from '@nestjs/common';
import { Observable, ReplaySubject } from 'rxjs';
import { BuildDecisionTraceV2 } from './build-decision-trace-v2';

export interface BuildDebugMatchSummaryV2 {
  matchId: string;
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

    const existing = this.matches.get(trace.matchId);
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
    this.matches.set(trace.matchId, {
      revisions,
      updatedAtMs: Date.now(),
    });
    this.stream(trace.matchId).next(immutableTrace);
  }

  get(matchId: string): BuildDecisionTraceV2 | undefined {
    this.purgeExpired();
    const revisions = this.matches.get(matchId)?.revisions ?? [];
    return revisions[revisions.length - 1];
  }

  listActive(): readonly BuildDebugMatchSummaryV2[] {
    this.purgeExpired();
    return [...this.matches.entries()]
      .map(([matchId, state]) => {
        const current = state.revisions[state.revisions.length - 1];
        return {
          matchId,
          revision: current.revision,
          stateRevision: current.stateRevision,
          generatedAt: current.generatedAt,
        };
      })
      .sort((left, right) => left.matchId.localeCompare(right.matchId));
  }

  revisions(matchId: string): readonly BuildDecisionTraceV2[] {
    this.purgeExpired();
    return [...(this.matches.get(matchId)?.revisions ?? [])];
  }

  observe(matchId: string): Observable<BuildDecisionTraceV2> {
    this.purgeExpired();
    validateMatchId(matchId);
    const existingStream = this.streams.get(matchId);
    if (existingStream) return existingStream.asObservable();

    const subject = new ReplaySubject<BuildDecisionTraceV2>(1);
    this.streams.set(matchId, subject);
    const current = this.get(matchId);
    if (current) subject.next(current);
    return subject.asObservable();
  }

  private stream(matchId: string): ReplaySubject<BuildDecisionTraceV2> {
    const existing = this.streams.get(matchId);
    if (existing) return existing;
    const subject = new ReplaySubject<BuildDecisionTraceV2>(1);
    this.streams.set(matchId, subject);
    return subject;
  }

  private purgeExpired(): void {
    const nowMs = Date.now();
    const ttlMs = readTraceTtlMs();
    for (const [matchId, state] of this.matches) {
      if (nowMs - state.updatedAtMs <= ttlMs) continue;
      this.matches.delete(matchId);
      const stream = this.streams.get(matchId);
      stream?.complete();
      this.streams.delete(matchId);
    }
  }
}

function validateTrace(trace: BuildDecisionTraceV2): void {
  validateMatchId(trace.matchId);
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
