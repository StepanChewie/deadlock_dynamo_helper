import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { Injectable } from '@nestjs/common';

export const BUILD_DEBUG_SESSION_COOKIE = 'build_debug_v2_session';

interface BuildDebugSessionV2 {
  expiresAtMs: number;
}

@Injectable()
export class BuildDebugAuthV2Service {
  private readonly sessions = new Map<string, BuildDebugSessionV2>();

  login(password: string): string | undefined {
    const configuredPassword = this.requiredConfig('BUILD_DEBUG_PASSWORD');
    if (!safeEqual(password, configuredPassword)) return undefined;

    this.purgeExpired();
    const sessionId = randomBytes(24).toString('hex');
    const expiresAtMs = Date.now() + this.sessionTtlSec() * 1000;
    this.sessions.set(sessionId, { expiresAtMs });
    return this.sign(sessionId, expiresAtMs);
  }

  validate(token: string): boolean {
    this.purgeExpired();
    const parsed = this.parse(token);
    if (!parsed) return false;
    const session = this.sessions.get(parsed.sessionId);
    if (!session || session.expiresAtMs !== parsed.expiresAtMs || session.expiresAtMs <= Date.now()) {
      return false;
    }
    return safeEqual(parsed.signature, this.signature(parsed.sessionId, parsed.expiresAtMs));
  }

  revoke(token: string): void {
    const parsed = this.parse(token);
    if (!parsed) return;
    if (!safeEqual(parsed.signature, this.signature(parsed.sessionId, parsed.expiresAtMs))) return;
    this.sessions.delete(parsed.sessionId);
  }

  sessionCookie(token: string): string {
    return [
      `${BUILD_DEBUG_SESSION_COOKIE}=${encodeURIComponent(token)}`,
      'HttpOnly',
      'SameSite=Strict',
      'Path=/debug/build-v2',
      `Max-Age=${this.sessionTtlSec()}`,
      ...(process.env.NODE_ENV === 'production' ? ['Secure'] : []),
    ].join('; ');
  }

  expiredSessionCookie(): string {
    return [
      `${BUILD_DEBUG_SESSION_COOKIE}=`,
      'HttpOnly',
      'SameSite=Strict',
      'Path=/debug/build-v2',
      'Max-Age=0',
      ...(process.env.NODE_ENV === 'production' ? ['Secure'] : []),
    ].join('; ');
  }

  tokenFromCookieHeader(cookieHeader: string | undefined): string | undefined {
    if (!cookieHeader) return undefined;
    for (const part of cookieHeader.split(';')) {
      const separator = part.indexOf('=');
      if (separator < 0) continue;
      const name = part.slice(0, separator).trim();
      if (name !== BUILD_DEBUG_SESSION_COOKIE) continue;
      const raw = part.slice(separator + 1).trim();
      if (!raw) return undefined;
      try {
        return decodeURIComponent(raw);
      } catch {
        return undefined;
      }
    }
    return undefined;
  }

  private sign(sessionId: string, expiresAtMs: number): string {
    return `${sessionId}.${expiresAtMs}.${this.signature(sessionId, expiresAtMs)}`;
  }

  private signature(sessionId: string, expiresAtMs: number): string {
    const secret = this.requiredConfig('BUILD_DEBUG_SESSION_SECRET');
    return createHmac('sha256', secret)
      .update(`${sessionId}.${expiresAtMs}`)
      .digest('hex');
  }

  private parse(token: string): { sessionId: string; expiresAtMs: number; signature: string } | undefined {
    const [sessionId, expiresAtRaw, signature, extra] = token.split('.');
    const expiresAtMs = Number(expiresAtRaw);
    if (
      extra !== undefined ||
      !/^[a-f0-9]{48}$/i.test(sessionId ?? '') ||
      !Number.isInteger(expiresAtMs) ||
      expiresAtMs <= 0 ||
      !/^[a-f0-9]{64}$/i.test(signature ?? '')
    ) return undefined;
    return { sessionId, expiresAtMs, signature };
  }

  private purgeExpired(): void {
    const now = Date.now();
    for (const [sessionId, session] of this.sessions) {
      if (session.expiresAtMs <= now) this.sessions.delete(sessionId);
    }
  }

  private sessionTtlSec(): number {
    const parsed = Number(process.env.BUILD_DEBUG_SESSION_TTL_SEC ?? 3600);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : 3600;
  }

  private requiredConfig(name: 'BUILD_DEBUG_PASSWORD' | 'BUILD_DEBUG_SESSION_SECRET'): string {
    const value = process.env[name]?.trim();
    if (!value) throw new Error(`${name} is required for build debugger v2`);
    return value;
  }
}

function safeEqual(left: string, right: string): boolean {
  const leftDigest = createHmac('sha256', 'build-debug-v2-compare').update(left).digest();
  const rightDigest = createHmac('sha256', 'build-debug-v2-compare').update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}
