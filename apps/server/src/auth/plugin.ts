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
import { hostAllowed, type AppConfig } from '../config.js';
import { AppError, forbidden, unauthorized } from '../errors.js';
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

/**
 * The server's own origin: PUBLIC_URL when configured (correct behind TLS proxies),
 * otherwise protocol + Host — but only when Host passed the allowlist check.
 */
function ownOrigin(config: AppConfig, req: FastifyRequest): string | null {
  if (config.publicOrigin) return config.publicOrigin;
  return normalizeOrigin(`${req.protocol}://${req.host}`);
}

function originAllowed(config: AppConfig, req: FastifyRequest, origin: string): boolean {
  const presented = normalizeOrigin(origin);
  if (presented === null) return false;
  return presented === ownOrigin(config, req) || config.allowedOrigins.some((o) => normalizeOrigin(o) === presented);
}

/**
 * Tag every route at registration time. Anything whose path is under /api is
 * protected ('editor') unless it explicitly declares otherwise; everything else
 * (static files) is public. Must be registered BEFORE any route.
 */
export function registerRouteAccess(app: FastifyInstance): void {
  app.addHook('onRoute', (route) => {
    const config = (route.config ?? {}) as { access?: Access };
    if (config.access === undefined) {
      const isApi = route.url.toLowerCase().startsWith('/api');
      route.config = { ...config, access: isApi ? 'editor' : 'public' };
    }
  });
}

export function registerAuth(app: FastifyInstance, config: AppConfig): void {
  const authRequired = Boolean(config.dashboardToken);
  // Fastify's recommended pattern: initialise reference-typed decorators to null, assign per request.
  app.decorateRequest('auth', null as unknown as FastifyRequest['auth']);

  app.addHook('onRequest', async (req) => {
    req.auth = { role: null, method: 'none' };

    // DNS-rebinding defence: when auth is disabled (or hosts are configured), only
    // accept known Host headers.
    if ((!authRequired || config.hostsExplicit) && !hostAllowed(config, req.headers.host)) {
      throw new AppError(403, 'invalid_host', 'Unexpected Host header');
    }

    // Decide from the MATCHED route (never the raw URL — encodings / absolute-form
    // targets would otherwise slip past). Unmatched requests only reach the 404
    // handler, which never serves /api content.
    if (req.routeOptions.url === undefined) return;
    const access: Access = req.routeOptions.config.access ?? 'editor';

    let role: Role | null;
    let method: 'bearer' | 'cookie' | 'none' = 'none';
    const authz = req.headers.authorization;
    if (!authRequired) {
      role = 'editor';
    } else if (typeof authz === 'string' && /^bearer\s/i.test(authz)) {
      role = roleForToken(config, authz.slice(7).trim());
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
