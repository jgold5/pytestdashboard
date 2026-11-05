/**
 * Stateless sessions: base64url(JSON payload) + "." + base64url(HMAC-SHA256).
 * The payload carries the role, issued-at, expiry and a fingerprint of the token
 * that was used to log in — rotating DASHBOARD_TOKEN / VIEWER_TOKEN therefore
 * invalidates existing sessions.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { Role } from '@ptd/shared';

export const SESSION_COOKIE = 'ptd_session';

export interface SessionPayload {
  v: 1;
  role: Role;
  iat: number; // seconds
  exp: number; // seconds
  fp: string; // token fingerprint
}

const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64url');

export function tokenFingerprint(token: string): string {
  return createHash('sha256').update(`ptd-fp:${token}`).digest('base64url').slice(0, 16);
}

function sign(secret: string, data: string): string {
  return createHmac('sha256', secret).update(data).digest('base64url');
}

export function createSession(secret: string, role: Role, token: string, ttlSeconds: number, nowMs = Date.now()): string {
  const iat = Math.floor(nowMs / 1000);
  const payload: SessionPayload = { v: 1, role, iat, exp: iat + ttlSeconds, fp: tokenFingerprint(token) };
  const data = b64(JSON.stringify(payload));
  return `${data}.${sign(secret, data)}`;
}

export function verifySession(secret: string, value: string | undefined, nowMs = Date.now()): SessionPayload | null {
  if (!value || value.length > 1024) return null;
  const dot = value.indexOf('.');
  if (dot <= 0) return null;
  const data = value.slice(0, dot);
  const sig = Buffer.from(value.slice(dot + 1));
  const expected = Buffer.from(sign(secret, data));
  if (sig.length !== expected.length || !timingSafeEqual(sig, expected)) return null;
  try {
    const p = JSON.parse(Buffer.from(data, 'base64url').toString('utf8')) as Partial<SessionPayload>;
    if (p.v !== 1 || (p.role !== 'editor' && p.role !== 'viewer')) return null;
    if (typeof p.iat !== 'number' || typeof p.exp !== 'number' || typeof p.fp !== 'string') return null;
    const now = Math.floor(nowMs / 1000);
    if (p.exp <= now || p.iat > now + 60) return null;
    return p as SessionPayload;
  } catch {
    return null;
  }
}

/** Constant-time comparison of a presented token with the configured one (hash both to equalize length). */
export function tokenMatches(presented: string, expected: string | undefined): boolean {
  if (!expected) return false;
  const a = createHash('sha256').update(presented).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}
