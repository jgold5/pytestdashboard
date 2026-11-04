import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, ConfigError } from '../src/config.js';
import { createSession, verifySession } from '../src/auth/session.js';
import { EDITOR_TOKEN, SESSION_SECRET, VIEWER_TOKEN, authEnv, createTestApp, type TestApp } from './helpers/app.js';

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

function cookieFrom(setCookie: string | string[] | undefined): string {
  const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  if (!raw) throw new Error('no set-cookie');
  return raw.split(';')[0]!;
}

describe('config', () => {
  it('refuses to start in production without secrets', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(ConfigError);
    expect(() => loadConfig({ NODE_ENV: 'production', DASHBOARD_TOKEN: EDITOR_TOKEN })).toThrow(/SESSION_SECRET/);
    expect(() => loadConfig({ NODE_ENV: 'production', DASHBOARD_TOKEN: 'short', SESSION_SECRET })).toThrow(/32/);
    expect(() =>
      loadConfig({ NODE_ENV: 'production', DASHBOARD_TOKEN: EDITOR_TOKEN, SESSION_SECRET, VIEWER_TOKEN: EDITOR_TOKEN }),
    ).toThrow(/differ/);
    expect(() => loadConfig({ JIRA_BASE_URL: 'http://jira.local' })).toThrow(/https/);
    const ok = loadConfig({ NODE_ENV: 'production', DASHBOARD_TOKEN: EDITOR_TOKEN, SESSION_SECRET });
    expect(ok.isProduction).toBe(true);
    expect(ok.allowedOrigins).toEqual([]);
  });
});

describe('sessions', () => {
  it('signs and verifies, rejects tampering and expiry', () => {
    const s = createSession('k'.repeat(32), 'viewer', 'tok', 60, 1_000_000);
    expect(verifySession('k'.repeat(32), s, 1_000_000)?.role).toBe('viewer');
    expect(verifySession('x'.repeat(32), s, 1_000_000)).toBeNull();
    const [data, sig] = s.split('.');
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(data!, 'base64url').toString()), role: 'editor' })).toString('base64url');
    expect(verifySession('k'.repeat(32), `${forged}.${sig}`, 1_000_000)).toBeNull();
    expect(verifySession('k'.repeat(32), s, 1_000_000 + 61_000)).toBeNull();
  });
});

describe('auth (token configured)', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await createTestApp(authEnv({ VIEWER_TOKEN }));
  });
  afterEach(async () => t.close());

  it('allows health/session without auth, 401 elsewhere', async () => {
    expect((await t.app.inject({ url: '/api/health' })).statusCode).toBe(200);
    expect((await t.app.inject({ url: '/api/auth/session' })).json()).toEqual({
      authenticated: false,
      role: null,
      authRequired: true,
    });
    const res = await t.app.inject({ url: '/api/test-cases' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: 'unauthorized' });
    expect((await t.app.inject({ url: '/api/test-cases', headers: bearer('wrong'.repeat(10)) })).statusCode).toBe(401);
  });

  it('accepts the bearer token (CI) without Origin, including POST', async () => {
    expect((await t.app.inject({ url: '/api/test-cases', headers: bearer(EDITOR_TOKEN) })).statusCode).toBe(200);
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/test-cases',
      headers: { ...bearer(EDITOR_TOKEN), origin: 'https://evil.example' },
      payload: { key: 'K-1', title: 'x' },
    });
    expect(res.statusCode).toBe(201);
  });

  it('login sets a hardened cookie that authenticates; CSRF origin check applies', async () => {
    const bad = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { token: 'nope' } });
    expect(bad.statusCode).toBe(401);
    const login = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { token: EDITOR_TOKEN } });
    expect(login.statusCode).toBe(204);
    const setCookie = String(login.headers['set-cookie']);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Strict/i);
    expect(setCookie).toMatch(/Path=\//);
    expect(setCookie).toMatch(/Max-Age=604800/);
    const cookie = cookieFrom(login.headers['set-cookie']);

    const session = await t.app.inject({ url: '/api/auth/session', headers: { cookie } });
    expect(session.json()).toEqual({ authenticated: true, role: 'editor', authRequired: true });
    expect((await t.app.inject({ url: '/api/test-cases', headers: { cookie } })).statusCode).toBe(200);

    const payload = { key: 'K-2', title: 'y' };
    const cross = await t.app.inject({
      method: 'POST',
      url: '/api/test-cases',
      headers: { cookie, origin: 'https://evil.example' },
      payload,
    });
    expect(cross.statusCode).toBe(403);
    const noOrigin = await t.app.inject({ method: 'POST', url: '/api/test-cases', headers: { cookie }, payload });
    expect(noOrigin.statusCode).toBe(403);
    const same = await t.app.inject({
      method: 'POST',
      url: '/api/test-cases',
      headers: { cookie, origin: 'http://localhost:80', host: 'localhost:80' },
      payload,
    });
    expect(same.statusCode).toBe(201);
    const viaReferer = await t.app.inject({
      method: 'PATCH',
      url: `/api/test-cases/${same.json().id}`,
      headers: { cookie, referer: 'http://localhost:80/tests', host: 'localhost:80' },
      payload: { title: 'z' },
    });
    expect(viaReferer.statusCode).toBe(200);
  });

  it('viewer role can only read report + settings', async () => {
    const v = bearer(VIEWER_TOKEN);
    expect((await t.app.inject({ url: '/api/report', headers: v })).statusCode).toBe(200);
    expect((await t.app.inject({ url: '/api/settings', headers: v })).statusCode).toBe(200);
    for (const url of ['/api/summary', '/api/test-cases', '/api/runs', '/api/meta', '/api/notes', '/api/bugs', '/api/integrations']) {
      const res = await t.app.inject({ url, headers: v });
      expect(res.statusCode, url).toBe(403);
    }
    const put = await t.app.inject({ method: 'PUT', url: '/api/settings', headers: v, payload: { teamName: 'x', goal: null } });
    expect(put.statusCode).toBe(403);

    const login = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { token: VIEWER_TOKEN } });
    const cookie = cookieFrom(login.headers['set-cookie']);
    expect((await t.app.inject({ url: '/api/auth/session', headers: { cookie } })).json().role).toBe('viewer');
    expect((await t.app.inject({ url: '/api/test-cases', headers: { cookie } })).statusCode).toBe(403);
    expect((await t.app.inject({ url: '/api/report?periodDays=90', headers: { cookie } })).statusCode).toBe(200);
  });

  it('logout clears the cookie', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/auth/logout' });
    expect(res.statusCode).toBe(204);
    expect(String(res.headers['set-cookie'])).toMatch(/ptd_session=;/);
  });

  it('sets security headers', async () => {
    const res = await t.app.inject({ url: '/api/health' });
    const csp = String(res.headers['content-security-policy']);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });
});

describe('auth disabled (dev)', () => {
  it('reports authRequired=false and allows access', async () => {
    const t = await createTestApp();
    try {
      expect((await t.app.inject({ url: '/api/auth/session' })).json()).toEqual({
        authenticated: true,
        role: 'editor',
        authRequired: false,
      });
      expect((await t.app.inject({ url: '/api/summary' })).statusCode).toBe(200);
      // a browser cross-origin POST is still rejected
      const res = await t.app.inject({
        method: 'POST',
        url: '/api/test-cases',
        headers: { origin: 'https://evil.example' },
        payload: { key: 'a', title: 'b' },
      });
      expect(res.statusCode).toBe(403);
      // Vite dev server origin is allowed outside production
      const vite = await t.app.inject({
        method: 'POST',
        url: '/api/test-cases',
        headers: { origin: 'http://localhost:5173' },
        payload: { key: 'a', title: 'b' },
      });
      expect(vite.statusCode).toBe(201);
    } finally {
      await t.close();
    }
  });
});

describe('rate limiting', () => {
  it('limits login attempts', async () => {
    const t = await createTestApp(authEnv());
    try {
      let last = 0;
      for (let i = 0; i < 11; i++) {
        last = (await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { token: 'x' } })).statusCode;
      }
      expect(last).toBe(429);
    } finally {
      await t.close();
    }
  });
});
