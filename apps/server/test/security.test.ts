/**
 * Regression tests for docs/SECURITY_REVIEW.md findings F-01..F-10.
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isApiPath } from '../src/app.js';
import { loadConfig, ConfigError } from '../src/config.js';
import { normalizeAutomationStatus, normalizePriority, splitTags } from '../src/domain/normalize.js';
import { normalizeFailureMessage } from '../src/domain/signature.js';
import { AllureBundle, parseProperties } from '../src/import/allure/parse.js';
import { canonHeader, suggestMapping } from '../src/import/spreadsheet/headers.js';
import { scanSheetXml } from '../src/import/spreadsheet/parse.js';
import { UploadStore } from '../src/import/spreadsheet/store.js';
import { readZip } from '../src/import/zip.js';
import { sanitizeError } from '../src/integrations/sanitize.js';
import { EDITOR_TOKEN, VIEWER_TOKEN, authEnv, createTestApp, multipart, type TestApp } from './helpers/app.js';
import { makeZip } from './helpers/zip.js';

const FIXTURES = path.join(import.meta.dirname, 'fixtures');

const ENCODED_PATHS = [
  '/%61pi/test-cases',
  '/ap%69/test-cases',
  '/%61%70%69/test-cases',
  '/api/%74est-cases',
  '/API/test-cases',
  '//api/test-cases',
  '/api/./test-cases',
  '/x/../api/test-cases',
  '/api/test-cases/',
  'http://localhost/api/test-cases',
];

describe('F-01: auth is decided by the matched route, not the raw URL', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp(authEnv({ VIEWER_TOKEN }));
  });
  afterAll(async () => t.close());

  for (const who of ['anonymous', 'viewer'] as const) {
    it(`never returns 2xx for encoded /api variants (${who})`, async () => {
      const headers: Record<string, string> = { origin: 'https://evil.example' };
      if (who === 'viewer') headers.authorization = `Bearer ${VIEWER_TOKEN}`;
      for (const url of ENCODED_PATHS) {
        for (const method of ['GET', 'POST', 'DELETE'] as const) {
          const target = method === 'DELETE' ? url.replace('test-cases', 'test-cases/1') : url;
          const res = await t.app.inject({ method, url: target, headers, payload: method === 'POST' ? { key: 'PWN', title: 'x' } : undefined });
          expect([401, 403, 404], `${who} ${method} ${target} → ${res.statusCode}`).toContain(res.statusCode);
        }
      }
      const reads = ['/%61pi/summary', '/ap%69/test-cases/export.csv', '/%61pi/integrations'];
      if (who === 'anonymous') reads.push('/%61pi/settings'); // viewers may read settings
      for (const url of reads) {
        const res = await t.app.inject({ url, headers });
        expect([401, 403], url).toContain(res.statusCode);
      }
      const put = await t.app.inject({ method: 'PUT', url: '/%61pi/settings', headers, payload: { teamName: 'PWNED', goal: null } });
      expect([401, 403]).toContain(put.statusCode);
      const settings = await t.app.inject({ url: '/api/settings', headers: { authorization: `Bearer ${VIEWER_TOKEN}` } });
      expect(settings.json().teamName).toBeNull();
    });
  }

  it('still serves encoded paths to a properly authenticated editor (routing unchanged)', async () => {
    const res = await t.app.inject({ url: '/%61pi/test-cases', headers: { authorization: `Bearer ${EDITOR_TOKEN}` } });
    expect(res.statusCode).toBe(200);
  });

  it('rejects absolute-form request targets over a real socket', async () => {
    await t.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (t.app.server.address() as net.AddressInfo).port;
    const raw = (line: string) =>
      new Promise<string>((resolve) => {
        const s = net.connect(port, '127.0.0.1', () =>
          s.write(`${line}\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`),
        );
        let d = '';
        s.on('data', (c) => (d += String(c)));
        s.on('end', () => resolve(d.split('\r\n')[0] ?? ''));
      });
    for (const line of [
      `GET http://127.0.0.1:${port}/api/test-cases HTTP/1.1`,
      'GET /%61pi/test-cases HTTP/1.1',
      'GET /ap%69/runs HTTP/1.1',
      'DELETE /%61pi/test-cases/1 HTTP/1.1',
    ]) {
      expect(await raw(line), line).toMatch(/ 40[134] /);
    }
  });

  it('SPA fallback never treats encoded /api paths as SPA routes', () => {
    for (const u of ['/api/x', '/%61pi/x', '//api', '/API/x', '/a%2fpi', '/%2e/api/x', 'http://h/api/x']) {
      if (u === '/a%2fpi') expect(isApiPath(u)).toBe(false);
      else expect(isApiPath(u), u).toBe(true);
    }
    expect(isApiPath('/tests/1')).toBe(false);
    expect(isApiPath('/%E0%A4%A')).toBe(true); // undecodable → treated as API (no SPA)
  });
});

async function xlsxWithSheet(sheetXml: string): Promise<Buffer> {
  const entries: Array<{ name: string; data: Buffer }> = [];
  await readZip({ buffer: fs.readFileSync(path.join(FIXTURES, 'tracker.xlsx')) }, () => true, (name, data) => {
    entries.push({ name, data });
  });
  return makeZip(
    entries.map((e) =>
      /worksheets\/sheet1\.xml$/.test(e.name)
        ? {
            name: e.name,
            data: Buffer.from(
              e.data
                .toString('utf8')
                .replace(/<sheetData[\s\S]*<\/sheetData>|<sheetData\/>/, sheetXml)
                .replace(/<dimension[^>]*\/>/, ''),
            ),
          }
        : e,
    ),
  );
}

describe('F-02/F-05: spreadsheet parsing is bounded', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => t.close());

  const preview = (filename: string, content: Buffer | string) => {
    const mp = multipart({}, [{ field: 'file', filename, content }]);
    return t.app.inject({ method: 'POST', url: '/api/test-cases/import/preview', payload: mp.payload, headers: mp.headers });
  };
  const cell = (ref: string, v: string) => `<c r="${ref}" t="inlineStr"><is><t>${v}</t></is></c>`;

  it('rejects a 4 KB xlsx with a huge row index before parsing (no OOM)', async () => {
    const file = await xlsxWithSheet(`<sheetData><row r="1">${cell('A1', 'Key')}</row><row r="60000000">${cell('A60000000', 'x')}</row></sheetData>`);
    expect(file.length).toBeLessThan(10_000);
    const t0 = performance.now();
    const res = await preview('bomb.xlsx', file);
    expect(res.statusCode).toBe(413);
    expect(res.json().error).toBe('too_many_rows');
    expect(performance.now() - t0).toBeLessThan(2000);
  });

  it('rejects a huge column reference', async () => {
    const file = await xlsxWithSheet(`<sheetData><row r="1">${cell('A1', 'Key')}${cell('ZZZZZ1', 'x')}</row></sheetData>`);
    const res = await preview('bomb.xlsx', file);
    expect(res.statusCode).toBe(413);
    expect(res.json().error).toBe('too_many_columns');
  });

  it('scanner handles namespaced tags and implicit refs; stays linear on junk', () => {
    expect(scanSheetXml(Buffer.from('<x:row><x:c/><x:c/></x:row><x:row r="2"><x:c r="B2"/></x:row>'))).toBe(3);
    const junk = Buffer.from('<row'.repeat(200_000));
    const t0 = performance.now();
    expect(() => scanSheetXml(junk)).not.toThrow();
    expect(performance.now() - t0).toBeLessThan(500);
  });

  it('still parses a normal xlsx (worker thread)', async () => {
    const res = await preview('tracker.xlsx', fs.readFileSync(path.join(FIXTURES, 'tracker.xlsx')));
    expect(res.statusCode).toBe(200);
    expect(res.json().sheets[0].rowCount).toBe(24);
  });

  it('enforces caps while streaming CSV and the 20 MB file cap', async () => {
    const wide = `${Array.from({ length: 300 }, (_, i) => `c${i}`).join(',')}\n`;
    const r1 = await preview('wide.csv', wide);
    expect(r1.statusCode).toBe(413);
    expect(r1.json().error).toBe('too_many_columns');
    const many = 'a\n'.repeat(52_000);
    expect((await preview('many.csv', many)).json().error).toBe('too_many_rows');
    const big = Buffer.alloc(21 * 1024 * 1024, 0x61);
    expect((await preview('big.csv', big)).statusCode).toBe(413);
  });

  it('upload store enforces a byte budget', () => {
    const sheet = (chars: number) => [
      { name: 's', headers: ['a'], rows: Array.from({ length: 10 }, (_, i) => ({ n: i + 2, cells: ['x'.repeat(chars)] })) },
    ];
    const store = new UploadStore(20, 3_600_000, Date.now, 100_000);
    const a = store.put('a', sheet(3000)); // ~60 KB
    const b = store.put('b', sheet(3000)); // would exceed → evicts a
    expect(store.get(a)).toBeUndefined();
    expect(store.get(b)).toBeDefined();
    expect(store.bytes).toBeLessThanOrEqual(100_000);
    expect(() => store.put('huge', sheet(10_000))).toThrow(/too large/);
  });
});

describe('F-03: allure import amplification', () => {
  it('rejects zips whose read entries expand too much overall', async () => {
    const t = await createTestApp(authEnv());
    try {
      const body = JSON.stringify({ name: 't', status: 'failed', statusDetails: { message: 'A'.repeat(900_000) } });
      const zip = makeZip(Array.from({ length: 40 }, (_, i) => ({ name: `r${i}-result.json`, data: body.replace('"t"', `"t${i}"`) })));
      const mp = multipart({}, [{ filename: 'a.zip', content: zip, contentType: 'application/zip' }]);
      const res = await t.app.inject({
        method: 'POST',
        url: '/api/runs/import',
        payload: mp.payload,
        headers: { ...mp.headers, authorization: `Bearer ${EDITOR_TOKEN}` },
      });
      expect(res.statusCode).toBe(413);
      expect(res.json().message).toMatch(/expands too much/);
    } finally {
      await t.close();
    }
  });

  it('caps stored labels/parameters/trace per result', () => {
    const b = new AllureBundle();
    const labels = Array.from({ length: 200 }, (_, j) => ({ name: `l${j}`, value: 'C'.repeat(1000) }));
    b.addFile(
      'x-result.json',
      Buffer.from(JSON.stringify({ name: 't', status: 'failed', statusDetails: { message: 'm', trace: 'B'.repeat(64_000) }, labels, parameters: labels })),
    );
    const r = b.results[0]!;
    expect(r.labels.length).toBeLessThanOrEqual(50);
    expect(r.labels.reduce((n, l) => n + l.name.length + l.value.length, 0)).toBeLessThanOrEqual(16 * 1024 + 600);
    expect(r.trace?.length).toBe(16 * 1024);
    expect(b.storedBytes).toBeLessThan(60_000);
  });

  it('rejects oversized result JSON and environment.properties', () => {
    const b = new AllureBundle();
    b.addFile('big-result.json', Buffer.alloc(6 * 1024 * 1024, 0x20));
    b.addFile('environment.properties', Buffer.from(`a=${'x'.repeat(70_000)}`));
    expect(b.results).toHaveLength(0);
    expect(b.environment).toEqual({});
    expect(b.warnings.join(' ')).toMatch(/too large/);
  });

  it('lowers the import rate limit to 10/min', async () => {
    const t = await createTestApp();
    try {
      let last = 0;
      for (let i = 0; i < 11; i++) {
        const mp = multipart({}, [{ filename: 'n.txt', content: 'x' }]);
        last = (await t.app.inject({ method: 'POST', url: '/api/runs/import', payload: mp.payload, headers: mp.headers })).statusCode;
      }
      expect(last).toBe(429);
    } finally {
      await t.close();
    }
  });
});

describe('F-04: no super-linear regexes on untrusted input (100 KB lines < 50 ms)', () => {
  const time = (fn: () => unknown) => {
    const t0 = performance.now();
    fn();
    return performance.now() - t0;
  };
  const hostile = ['a' + ' '.repeat(100_000) + 'b', ' '.repeat(100_000), '='.repeat(100_000), '"' + '\\a'.repeat(50_000), '/a'.repeat(50_000) + '!', '0x'.repeat(50_000)];

  it('parseProperties', () => {
    for (const line of hostile) expect(time(() => parseProperties(line))).toBeLessThan(50);
    expect(parseProperties('a = 1\nb: two\nc=x=y\n:nokey\n')).toEqual({ a: '1', b: 'two', c: 'x=y' });
  });

  it('normalizers, signatures, header matching, sanitizer', () => {
    for (const s of hostile) {
      expect(time(() => normalizeAutomationStatus(s))).toBeLessThan(50);
      expect(time(() => normalizePriority(s))).toBeLessThan(50);
      expect(time(() => splitTags(s))).toBeLessThan(50);
      expect(time(() => normalizeFailureMessage(s))).toBeLessThan(50);
      expect(time(() => suggestMapping([s, canonHeader(s)]))).toBeLessThan(50);
      expect(time(() => sanitizeError(new Error(`authorization: ${s}`), []))).toBeLessThan(50);
    }
  });
});

describe('F-06/F-07/F-08: config hardening', () => {
  it('TRUST_PROXY accepts hops or IP/CIDR lists, rejects true', () => {
    expect(() => loadConfig({ TRUST_PROXY: 'true' })).toThrow(ConfigError);
    expect(() => loadConfig({ TRUST_PROXY: 'example.com' })).toThrow(/TRUST_PROXY/);
    expect(loadConfig({ TRUST_PROXY: '1' }).trustProxy).toBe(1);
    expect(loadConfig({ TRUST_PROXY: '10.0.0.0/8, 127.0.0.1' }).trustProxy).toEqual(['10.0.0.0/8', '127.0.0.1']);
    expect(loadConfig({ TRUST_PROXY: 'false' }).trustProxy).toBe(false);
  });

  it('rate limits cannot be bypassed with spoofed X-Forwarded-For when trusting one hop', async () => {
    const t = await createTestApp(authEnv({ TRUST_PROXY: '1' }));
    try {
      const codes: number[] = [];
      for (let i = 0; i < 12; i++) {
        const res = await t.app.inject({
          method: 'POST',
          url: '/api/auth/login',
          payload: { token: 'x'.repeat(40) },
          remoteAddress: '10.0.0.9',
          headers: { 'x-forwarded-for': `1.2.3.${i}, 5.6.7.8` },
        });
        codes.push(res.statusCode);
      }
      expect(codes.at(-1)).toBe(429);
    } finally {
      await t.close();
    }
  });

  it('binds loopback when auth is disabled; caps session TTL', () => {
    expect(loadConfig({ HOST: '0.0.0.0' }).host).toBe('127.0.0.1');
    expect(loadConfig({ HOST: '0.0.0.0', DASHBOARD_TOKEN: EDITOR_TOKEN }).host).toBe('0.0.0.0');
    expect(() => loadConfig({ SESSION_TTL_HOURS: '8760' })).toThrow(ConfigError);
    expect(loadConfig({ SESSION_TTL_HOURS: '720' }).sessionTtlHours).toBe(720);
  });

  it('rejects DNS-rebinding Host headers when auth is disabled', async () => {
    const t = await createTestApp();
    try {
      const rebind = await t.app.inject({
        method: 'PUT',
        url: '/api/settings',
        payload: { teamName: 'rebound', goal: null },
        headers: { host: 'evil.example:3000', origin: 'http://evil.example:3000' },
      });
      expect(rebind.statusCode).toBe(403);
      expect((await t.app.inject({ url: '/api/summary', headers: { host: 'evil.example' } })).statusCode).toBe(403);
      expect((await t.app.inject({ url: '/api/summary', headers: { host: 'localhost:3000' } })).statusCode).toBe(200);
      expect((await t.app.inject({ url: '/api/summary', headers: { host: '127.0.0.1:3000' } })).statusCode).toBe(200);
    } finally {
      await t.close();
    }
  });

  it('PUBLIC_URL defines the own origin and the Host allowlist', async () => {
    const t = await createTestApp(authEnv({ PUBLIC_URL: 'https://qa.example.com' }));
    try {
      const login = await t.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { token: EDITOR_TOKEN },
        headers: { host: 'qa.example.com', origin: 'https://qa.example.com' },
      });
      expect(login.statusCode).toBe(204);
      expect(String(login.headers['set-cookie'])).toMatch(/Secure/);
      const cookie = String(login.headers['set-cookie']).split(';')[0]!;
      const ok = await t.app.inject({
        method: 'PUT',
        url: '/api/settings',
        payload: { teamName: 'ok', goal: null },
        headers: { cookie, host: 'qa.example.com', origin: 'https://qa.example.com' },
      });
      expect(ok.statusCode).toBe(200);
      const wrongHost = await t.app.inject({ url: '/api/health', headers: { host: 'evil.example' } });
      expect(wrongHost.statusCode).toBe(403);
    } finally {
      await t.close();
    }
  });
});

describe('F-09/F-10', () => {
  it('sends X-Frame-Options: DENY', async () => {
    const t = await createTestApp();
    try {
      expect((await t.app.inject({ url: '/api/health' })).headers['x-frame-options']).toBe('DENY');
    } finally {
      await t.close();
    }
  });

  it('prototype-chain keys are plain values', () => {
    expect(normalizeAutomationStatus('constructor')).toBeNull();
    expect(normalizeAutomationStatus('toString')).toBeNull();
    expect(suggestMapping(['constructor', 'toString', 'ID'])).toEqual({ ID: 'key' });
  });
});
