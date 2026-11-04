import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api, parseApiError, setUnauthorizedHandler } from '../api/client';

afterEach(() => vi.unstubAllGlobals());

describe('parseApiError', () => {
  it('uses the API error shape when present', () => {
    const e = parseApiError(409, JSON.stringify({ error: 'conflict', message: 'Key exists' }));
    expect(e).toBeInstanceOf(ApiError);
    expect(e.status).toBe(409);
    expect(e.code).toBe('conflict');
    expect(e.message).toBe('Key exists');
  });
  it('never surfaces raw non-JSON bodies (e.g. proxy HTML / stack traces)', () => {
    const e = parseApiError(502, '<html>Bad gateway at /srv/app.js:12</html>');
    expect(e.message).not.toContain('<html>');
    expect(e.code).toBe('http_502');
  });
});

describe('request', () => {
  it('sends same-origin credentials and JSON bodies', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: 1 }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await api.post('/api/notes', { a: 1 });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/notes');
    expect(init.credentials).toBe('same-origin');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(init.body).toBe('{"a":1}');
  });

  it('calls the unauthorized handler on 401 and throws ApiError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'unauthorized', message: 'Sign in' }), { status: 401 })));
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    await expect(api.get('/api/summary')).rejects.toMatchObject({ status: 401 });
    expect(handler).toHaveBeenCalledOnce();
  });

  it('does not redirect for auth endpoints (login failures show inline)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'unauthorized', message: 'Invalid token' }), { status: 401 })));
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    await expect(api.post('/api/auth/login', { token: 'x' })).rejects.toThrow('Invalid token');
    expect(handler).not.toHaveBeenCalled();
  });

  it('maps network failures to a friendly error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    await expect(api.get('/api/meta')).rejects.toMatchObject({ code: 'network_error' });
  });
});
