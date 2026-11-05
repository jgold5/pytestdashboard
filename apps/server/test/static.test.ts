import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authEnv, createTestApp, EDITOR_TOKEN, type TestApp } from './helpers/app.js';

describe('production static serving', () => {
  let t: TestApp;
  let web: string;
  beforeAll(async () => {
    web = fs.mkdtempSync(path.join(os.tmpdir(), 'ptd-web-'));
    fs.mkdirSync(path.join(web, 'assets'));
    fs.writeFileSync(path.join(web, 'index.html'), '<!doctype html><title>spa</title>');
    fs.writeFileSync(path.join(web, 'assets', 'app-1.js'), 'console.log(1)');
    t = await createTestApp(authEnv({ NODE_ENV: 'production', WEB_DIST: web }));
  });
  afterAll(async () => {
    await t.close();
    fs.rmSync(web, { recursive: true, force: true });
  });

  it('serves index, assets and SPA routes', async () => {
    const root = await t.app.inject({ url: '/' });
    expect(root.statusCode).toBe(200);
    expect(root.body).toContain('spa');
    const asset = await t.app.inject({ url: '/assets/app-1.js' });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers['cache-control']).toContain('immutable');
    const deep = await t.app.inject({ url: '/runs/12?tab=failures' });
    expect(deep.statusCode).toBe(200);
    expect(deep.body).toContain('spa');
  });

  it('serves assets added after startup', async () => {
    fs.writeFileSync(path.join(web, 'assets', 'app-2.js'), 'console.log(2)');
    const res = await t.app.inject({ url: '/assets/app-2.js' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('console.log(2)');
  });

  it('never serves the SPA or files for /api paths and stays authenticated', async () => {
    for (const url of ['/api/nope', '/%61pi/summary', '/api/summary', '/API/summary', '//api/summary', '/x/../api/summary']) {
      const res = await t.app.inject({ url });
      expect(res.statusCode, url).toBeGreaterThanOrEqual(400);
      expect(res.body, url).not.toContain('spa');
    }
    for (const url of ['/assets/../../etc/passwd', '/..%2f..%2fetc%2fpasswd', '/%2e%2e/%2e%2e/etc/passwd']) {
      expect((await t.app.inject({ url })).body, url).not.toMatch(/root:/);
    }
    expect((await t.app.inject({ url: '/assets/missing.js' })).body).not.toContain('immutable');
  });
});

describe('rate limiting', () => {
  it('limits /api but not static SPA files', async () => {
    const web = fs.mkdtempSync(path.join(os.tmpdir(), 'ptd-web-'));
    fs.writeFileSync(path.join(web, 'index.html'), '<!doctype html><title>spa</title>');
    const t = await createTestApp(authEnv({ NODE_ENV: 'production', WEB_DIST: web }), { rateLimitMax: 3 });
    try {
      for (let i = 0; i < 6; i++) expect((await t.app.inject({ url: '/index.html' })).statusCode).toBe(200);
      const codes: number[] = [];
      for (let i = 0; i < 5; i++) codes.push((await t.app.inject({ url: '/api/summary', headers: { authorization: `Bearer ${EDITOR_TOKEN}` } })).statusCode);
      expect(codes).toContain(429);
    } finally {
      await t.close();
      fs.rmSync(web, { recursive: true, force: true });
    }
  });
});
