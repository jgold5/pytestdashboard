/**
 * Authentication, role enforcement and CSRF origin checks for /api/*.
 *
 * Route policy via `config.access`: 'public' (no auth), 'viewer' (editor or
 * viewer), default 'editor'. Bearer tokens (CI) are CSRF-exempt; cookie
 * sessions must send a matching Origin/Referer on state-changing requests.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type {} from '@fastify/cookie';
import type { Role } from '@ptd/shared';
import type { AppConfig } from '../config.js';
import { forbidden, unauthorized } from '../errors.js';
import { SESSION_COOKIE, tokenFingerprint, tokenMatches, verifySession } from './session.js';

export type Access = 'public' | 'viewer' | 'editor';

declare module 'fastify' {
  interface FastifyContextConfig {
    access?: Access;
  }
  interface FastifyRequest {
    auth: { role: Role | null; method: 'bearer' | 'cookie' | 'none' };
  }
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function roleForToken(config: AppConfig, token: string): Role | null {
  // check both (no early exit) to keep timing uniform
  const editor = tokenMatches(token, config.dashboardToken);
  const viewer = tokenMatches(token, config.viewerToken);
  if (editor) return 'editor';
  if (viewer) return 'viewer';
  return null;
}

export function sessionRole(config: AppConfig, req: FastifyRequest): Role | null {
  const p = verifySession(config.sessionSecret, req.cookies[SESSION_COOKIE]);
  if (!p) return null;
  const token = p.role === 'editor' ? config.dashboardToken : config.viewerToken;
  if (!token || tokenFingerprint(token) !== p.fp) return null;
  return p.role;
}

function requestOrigin(req: FastifyRequest): string | null {
  const origin = req.headers.origin;
  if (typeof origin === 'string' && origin !== 'null') return origin.replace(/\/+$/, '');
  const referer = req.headers.referer;
  if (typeof referer === 'string') {
    try {
      return new URL(referer).origin;
    } catch {
      return null;
    }
  }
  return typeof origin === 'string' ? origin : null;
}

function normalizeOrigin(v: string): string | null {
  try {
    return new URL(v).origin;
  } catch {
    return null;
  }
}

function originAllowed(config: AppConfig, req: FastifyRequest, origin: string): boolean {
  const presented = normalizeOrigin(origin);
  if (presented === null) return false;
  const own = normalizeOrigin(`${req.protocol}://${req.host}`);
  return presented === own || config.allowedOrigins.some((o) => normalizeOrigin(o) === presented);
}

export function registerAuth(app: FastifyInstance, config: AppConfig): void {
  const authRequired = Boolean(config.dashboardToken);
  // Fastify's recommended pattern: initialise reference-typed decorators to null, assign per request.
  app.decorateRequest('auth', null as unknown as FastifyRequest['auth']);

  app.addHook('onRequest', async (req) => {
    req.auth = { role: null, method: 'none' };
    if (!req.url.startsWith('/api/')) return;
    const access: Access = req.routeOptions.config.access ?? 'editor';

    let role: Role | null = null;
    let method: 'bearer' | 'cookie' | 'none' = 'none';
    const authz = req.headers.authorization;
    if (!authRequired) {
      role = 'editor';
    } else if (typeof authz === 'string' && /^bearer\s+/i.test(authz)) {
      role = roleForToken(config, authz.replace(/^bearer\s+/i, '').trim());
      if (!role) throw unauthorized('Invalid token');
      method = 'bearer';
    } else {
      role = sessionRole(config, req);
      if (role) method = 'cookie';
    }
    req.auth = { role, method };

    // CSRF: state-changing, non-bearer requests must come from an allowed origin.
    if (!SAFE_METHODS.has(req.method) && method !== 'bearer') {
      const origin = requestOrigin(req);
      if (origin === null) {
        if (method === 'cookie') throw forbidden('Missing Origin header');
      } else if (!originAllowed(config, req, origin)) {
        throw forbidden('Cross-origin request rejected');
      }
    }

    if (access === 'public') return;
    if (!role) throw unauthorized();
    if (access === 'editor' && role !== 'editor') throw forbidden('This action requires editor access');
  });
}
