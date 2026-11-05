import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { HttpClient, HttpError, nextLink, rateLimitWaitMs } from '../src/integrations/http.js';
import { createGlobMatcher } from '../src/integrations/glob.js';
import { startMockServer, type MockServer } from './helpers/mockServer.js';

const TOKEN = 'ghp_SuperSecretToken0123456789abcdefXYZ';
const Ok = z.object({ ok: z.boolean() });

describe('integrations HTTP client', () => {
  let mock: MockServer;
  let sleeps: number[];
  const client = (extra: Partial<ConstructorParameters<typeof HttpClient>[0]> = {}) =>
    new HttpClient({
      label: 'Test',
      baseUrl: `${mock.url}/api/v3`,
      headers: { authorization: `Bearer ${TOKEN}` },
      secrets: [TOKEN],
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      backoffBaseMs: 10,
      ...extra,
    });

  beforeEach(async () => {
    sleeps = [];
    mock = await startMockServer(() => ({ json: { ok: true } }));
  });
  afterEach(async () => mock.close());

  it('resolves paths against the pinned base URL and sends auth', async () => {
    const res = await client().get('/repos/a/b', { query: { per_page: 100 }, schema: Ok });
    expect(res.data).toEqual({ ok: true });
    expect(mock.requests[0]).toMatchObject({ path: '/api/v3/repos/a/b' });
    expect(mock.requests[0]!.query.get('per_page')).toBe('100');
    expect(mock.requests[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('refuses absolute URLs to other hosts (e.g. a malicious next link)', async () => {
    const c = client();
    await expect(c.get('https://evil.example.com/steal', { schema: Ok })).rejects.toThrow(
      /host other than the configured/,
    );
    await expect(c.get('//evil.example.com/steal', { schema: Ok })).rejects.toThrow(
      /host other than the configured/,
    );
    // same host, different port is a different origin
    await expect(c.get('http://127.0.0.1:1/x', { schema: Ok })).rejects.toThrow(/host other than/);
    expect(mock.requests).toHaveLength(0);
    // same-origin absolute URL is fine
    await c.get(`${mock.url}/api/v3/next?page=2`, { schema: Ok });
    expect(mock.requests[0]!.path).toBe('/api/v3/next');
  });

  it('refuses redirects to other hosts', async () => {
    mock.setHandler(() => ({ status: 302, headers: { location: 'https://evil.example.com/x' } }));
    await expect(client().get('/r', { schema: Ok })).rejects.toThrow(/refused redirect/);
  });

  it('follows same-origin redirects', async () => {
    mock.setHandler((req) =>
      req.path.endsWith('/old')
        ? { status: 301, headers: { location: '/api/v3/new' } }
        : { json: { ok: true } },
    );
    const res = await client().get('/old', { schema: Ok });
    expect(res.data.ok).toBe(true);
    expect(mock.requests.map((r) => r.path)).toEqual(['/api/v3/old', '/api/v3/new']);
  });

  it('enforces https except for loopback hosts', () => {
    expect(() => new HttpClient({ label: 'X', baseUrl: 'http://example.com' })).toThrow(/https/);
    expect(() => new HttpClient({ label: 'X', baseUrl: 'ftp://example.com' })).toThrow(/https/);
    expect(() => new HttpClient({ label: 'X', baseUrl: 'https://u:p@example.com' })).toThrow(
      /credentials/,
    );
    expect(() => new HttpClient({ label: 'X', baseUrl: 'http://localhost:8080' })).not.toThrow();
    expect(() => new HttpClient({ label: 'X', baseUrl: 'https://example.com' })).not.toThrow();
  });

  it('retries 429 honoring Retry-After', async () => {
    let n = 0;
    mock.setHandler(() =>
      n++ === 0
        ? { status: 429, headers: { 'retry-after': '2' }, json: { message: 'slow down' } }
        : { json: { ok: true } },
    );
    const res = await client().get('/x', { schema: Ok });
    expect(res.data.ok).toBe(true);
    expect(sleeps).toEqual([2000]);
    expect(mock.requests).toHaveLength(2);
  });

  it('retries 500 then succeeds, with exponential backoff', async () => {
    let n = 0;
    mock.setHandler(() =>
      n++ < 2 ? { status: n === 1 ? 500 : 503, text: 'oops' } : { json: { ok: true } },
    );
    const res = await client().get('/x', { schema: Ok });
    expect(res.data.ok).toBe(true);
    expect(sleeps).toHaveLength(2);
    expect(sleeps[0]!).toBeGreaterThanOrEqual(10);
    expect(sleeps[1]!).toBeGreaterThanOrEqual(20);
  });

  it('retries network errors and gives up after maxRetries', async () => {
    mock.setHandler(() => ({ raw: (res) => res.socket?.destroy() }));
    await expect(client({ maxRetries: 2 }).get('/x', { schema: Ok })).rejects.toThrow(
      /network error/,
    );
    expect(mock.requests).toHaveLength(3);
  });

  it('does not retry 4xx errors', async () => {
    mock.setHandler(() => ({ status: 404, json: { message: 'Not Found' } }));
    const err = await client()
      .get('/x', { schema: Ok })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(404);
    expect((err as Error).message).toBe('Test GET /api/v3/x → HTTP 404: Not Found');
    expect(mock.requests).toHaveLength(1);
  });

  it('honors GitHub X-RateLimit-Reset and fails fast when the wait exceeds 60s', async () => {
    let reset = Math.floor(Date.now() / 1000) + 2;
    let n = 0;
    mock.setHandler(() =>
      n++ === 0
        ? {
            status: 403,
            headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) },
            json: { message: 'API rate limit exceeded' },
          }
        : { json: { ok: true } },
    );
    await client().get('/x', { schema: Ok });
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]!).toBeGreaterThan(500);
    expect(sleeps[0]!).toBeLessThanOrEqual(3100);

    reset = Math.floor(Date.now() / 1000) + 3600;
    n = 0;
    sleeps = [];
    await expect(client().get('/x', { schema: Ok })).rejects.toThrow(
      /rate limited.*try again later/,
    );
    expect(sleeps).toEqual([]);
  });

  it('times out slow responses (per attempt) and retries', async () => {
    mock.setHandler(() => ({ raw: () => undefined })); // never responds
    await expect(
      client({ timeoutMs: 150, maxRetries: 1 }).get('/x', { schema: Ok }),
    ).rejects.toThrow(/timed out/);
    expect(mock.requests).toHaveLength(2);
  });

  it('honors the sync abort signal (no retries)', async () => {
    const ac = new AbortController();
    mock.setHandler(() => ({
      raw: () => setTimeout(() => ac.abort(new Error('Sync timed out')), 20),
    }));
    await expect(client({ signal: ac.signal }).get('/x', { schema: Ok })).rejects.toThrow(
      'Sync timed out',
    );
    expect(mock.requests).toHaveLength(1);
  });

  it('caps response size (declared and streamed)', async () => {
    const big = JSON.stringify({ ok: true, pad: 'x'.repeat(5000) });
    mock.setHandler(() => ({ text: big, headers: { 'content-type': 'application/json' } }));
    await expect(client({ maxBytes: 1000 }).get('/x', { schema: Ok })).rejects.toThrow(
      /response too large/,
    );
    // chunked, no content-length
    mock.setHandler(() => ({
      raw: (res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        for (let i = 0; i < 10; i++) res.write('x'.repeat(500));
        res.end();
      },
    }));
    await expect(client({ maxBytes: 1000 }).get('/x', { schema: Ok })).rejects.toThrow(
      /response too large/,
    );
  });

  it('validates JSON shape and rejects non-JSON', async () => {
    mock.setHandler(() => ({ json: { ok: 'yes' } }));
    await expect(client().get('/x', { schema: Ok })).rejects.toThrow(
      /unexpected response shape at ok/,
    );
    mock.setHandler(() => ({ text: '<html>' }));
    await expect(client().get('/x', { schema: Ok })).rejects.toThrow(/not valid JSON/);
  });

  it('never puts tokens, auth headers or full bodies into errors', async () => {
    mock.setHandler((req) => ({
      status: 401,
      json: {
        message: `Bad credentials for ${String(req.headers.authorization)}`,
        detail: 'SENSITIVE-BODY-CONTENT'.repeat(50),
      },
    }));
    const err = (await client()
      .get('/x', { schema: Ok })
      .catch((e: unknown) => e)) as Error;
    expect(err.message).toContain('HTTP 401');
    expect(err.message).toContain('Bad credentials');
    expect(err.message).not.toContain(TOKEN);
    expect(err.message).not.toContain('SENSITIVE-BODY-CONTENT');
    expect(err.message.length).toBeLessThan(400);
  });

  it('parses Link headers and rate-limit headers', () => {
    expect(
      nextLink(
        '<https://api.github.com/x?page=2>; rel="next", <https://api.github.com/x?page=5>; rel="last"',
      ),
    ).toBe('https://api.github.com/x?page=2');
    expect(nextLink('<https://api.github.com/x?page=1>; rel="prev"')).toBeNull();
    expect(nextLink(null)).toBeNull();
    const h = (o: Record<string, string>) => ({ headers: new Headers(o) });
    expect(rateLimitWaitMs(h({ 'retry-after': '5' }))).toBe(5000);
    expect(
      rateLimitWaitMs(h({ 'retry-after': new Date(Date.now() + 10_000).toUTCString() }))!,
    ).toBeGreaterThan(8000);
    expect(
      rateLimitWaitMs(h({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1000' }), 990_000),
    ).toBe(11_000);
    expect(rateLimitWaitMs(h({}))).toBeNull();
  });
});

describe('test path globs', () => {
  it('matches the default globs', () => {
    const m = createGlobMatcher(['**/test_*.py', '**/*_test.py', '**/tests/**']);
    expect(m('test_a.py')).toBe(true);
    expect(m('pkg/sub/test_a.py')).toBe(true);
    expect(m('pkg/a_test.py')).toBe(true);
    expect(m('tests/conftest.py')).toBe(true);
    expect(m('a/tests/b/c.json')).toBe(true);
    expect(m('src/app.py')).toBe(false);
    expect(m('src/test_a.pyc')).toBe(false);
    expect(m('src/contest_a.py')).toBe(false);
    const n = createGlobMatcher(['e2e/*.spec.ts', 'x?.py']);
    expect(n('e2e/a.spec.ts')).toBe(true);
    expect(n('e2e/sub/a.spec.ts')).toBe(false);
    expect(n('x1.py')).toBe(true);
  });
});
