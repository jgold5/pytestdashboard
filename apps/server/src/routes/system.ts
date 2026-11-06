import type { FastifyInstance } from 'fastify';
import { LoginRequest, ReportQuery, ScopeBranchQuery, Settings, type SessionInfo } from '@ptd/shared';
import { SESSION_COOKIE, createSession } from '../auth/session.js';
import { roleForToken, sessionRole } from '../auth/plugin.js';
import type { Deps } from '../deps.js';
import { parseWith, unauthorized } from '../errors.js';
import { getMeta } from '../domain/meta.js';
import { getReport } from '../domain/report.js';
import { getSettings, putSettings } from '../domain/settings.js';
import { getSummary } from '../domain/summary.js';

export function systemRoutes(app: FastifyInstance, { config, db }: Deps): void {
  const authRequired = Boolean(config.dashboardToken);
  // Secure whenever browsers use https (PUBLIC_URL scheme, else production default).
  const secureCookie = config.httpsOnly;

  app.get('/api/health', { config: { access: 'public' } }, async () => ({ ok: true }));

  app.get('/api/auth/session', { config: { access: 'public' } }, async (req): Promise<SessionInfo> => {
    if (!authRequired) return { authenticated: true, role: 'editor', authRequired: false };
    const raw = req.auth.method === 'bearer' ? req.auth.role : sessionRole(config, req);
    // the CI-only ingest token is not a UI identity
    const role = raw === 'ingest' ? null : raw;
    return { authenticated: role !== null, role, authRequired: true };
  });

  app.post(
    '/api/auth/login',
    { config: { access: 'public', rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const { token } = parseWith(LoginRequest, req.body);
      if (!authRequired) return reply.status(204).send();
      const role = roleForToken(config, token);
      // the ingest token (CI uploads) can never sign into the UI
      if (!role || role === 'ingest') throw unauthorized('Invalid access token');
      const ttl = config.sessionTtlHours * 3600;
      reply.setCookie(SESSION_COOKIE, createSession(config.sessionSecret, role, token, ttl), {
        httpOnly: true,
        sameSite: 'strict',
        secure: secureCookie,
        path: '/',
        maxAge: ttl,
      });
      return reply.status(204).send();
    },
  );

  app.post('/api/auth/logout', { config: { access: 'public' } }, async (_req, reply) => {
    reply.clearCookie(SESSION_COOKIE, { path: '/', httpOnly: true, sameSite: 'strict', secure: secureCookie });
    return reply.status(204).send();
  });

  app.get('/api/summary', async (req) => {
    const q = parseWith(ScopeBranchQuery, req.query);
    return getSummary(db, q.branch, q.folder);
  });
  app.get('/api/meta', async () => getMeta(db));

  app.get('/api/report', { config: { access: 'viewer' } }, async (req) => {
    const q = parseWith(ReportQuery, req.query);
    return getReport(db, q.periodDays, new Date(), q.branch, q.folder);
  });
  app.get('/api/settings', { config: { access: 'viewer' } }, async () => getSettings(db));
  app.put('/api/settings', async (req) => putSettings(db, parseWith(Settings, req.body)));
}
