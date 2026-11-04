import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readZip, isUnsafeEntryName, type ZipLimits } from '../src/import/zip.js';
import { createTestApp, multipart, type TestApp } from './helpers/app.js';
import { makeZip } from './helpers/zip.js';

const result = (name: string) => JSON.stringify({ name, fullName: `tests.z#${name}`, status: 'passed', historyId: name });

const SMALL: ZipLimits = { maxEntries: 50, maxEntryBytes: 64 * 1024, maxTotalBytes: 512 * 1024, maxRatio: 100, ratioMinBytes: 16 * 1024 };

async function upload(t: TestApp, zip: Buffer) {
  const mp = multipart({}, [{ filename: 'results.zip', content: zip, contentType: 'application/zip' }]);
  return t.app.inject({ method: 'POST', url: '/api/runs/import', payload: mp.payload, headers: mp.headers });
}

describe('zip safety', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await createTestApp({}, { zipLimits: SMALL });
  });
  afterEach(async () => t.close());

  it('detects unsafe names', () => {
    for (const n of ['../a-result.json', 'x/../../a', '/etc/passwd', 'C:/x', 'a\\b', 'ok/../../x']) {
      expect(isUnsafeEntryName(n)).toBe(true);
    }
    expect(isUnsafeEntryName('allure-results/a-result.json')).toBe(false);
  });

  it('rejects zip-slip entries', async () => {
    const zip = makeZip([
      { name: 'ok-result.json', data: result('ok') },
      { name: '../../evil-result.json', data: result('evil') },
    ]);
    const res = await upload(t, zip);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/unsafe_archive/);
    // nothing imported (atomic)
    const runs = await t.app.inject({ url: '/api/runs' });
    expect(runs.json().total).toBe(0);
  });

  it('rejects absolute paths', async () => {
    const res = await upload(t, makeZip([{ name: '/tmp/a-result.json', data: result('a') }]));
    expect(res.statusCode).toBe(400);
  });

  it('rejects compression-ratio bombs', async () => {
    const zeros = Buffer.alloc(60 * 1024); // 60 KiB of zeros → ratio ≫ 100
    const res = await upload(t, makeZip([{ name: 'big-result.json', data: zeros }]));
    expect(res.statusCode).toBe(413);
    expect(res.json().message).toMatch(/bomb|ratio/i);
  });

  it('rejects entries whose declared size exceeds the per-entry cap', async () => {
    const random = Buffer.from(Array.from({ length: 70 * 1024 }, (_, i) => (i * 7919) % 251));
    const res = await upload(t, makeZip([{ name: 'big-result.json', data: random, compress: false }]));
    expect(res.statusCode).toBe(413);
  });

  it('rejects entries that inflate beyond their declared size (lying header)', async () => {
    const data = Buffer.from(result('x').padEnd(4000, ' '));
    const res = await upload(t, makeZip([{ name: 'lie-result.json', data, declaredSize: 100 }]));
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
  });

  it('rejects too many entries and too large totals', async () => {
    const many = makeZip(Array.from({ length: 60 }, (_, i) => ({ name: `f${i}.txt`, data: 'x' })));
    expect((await upload(t, many)).statusCode).toBe(413);
  });

  it('rejects non-zip content with .zip name (magic bytes)', async () => {
    const res = await upload(t, Buffer.from('this is not a zip'));
    expect(res.statusCode).toBe(400);
  });

  it('only reads allowed entries', async () => {
    const seen: string[] = [];
    const zip = makeZip([
      { name: 'r/a-result.json', data: result('a') },
      { name: 'r/attachment.png', data: Buffer.alloc(10) },
      { name: 'r/', data: '' },
    ]);
    const res = await readZip({ buffer: zip }, (n) => n.endsWith('-result.json'), (n) => void seen.push(n));
    expect(seen).toEqual(['r/a-result.json']);
    expect(res.skipped).toBe(1);
  });

  it('imports a valid nested zip', async () => {
    const zip = makeZip([
      { name: 'allure-results/a-result.json', data: result('a') },
      { name: 'allure-results/b-result.json', data: result('b') },
    ]);
    const res = await upload(t, zip);
    expect(res.statusCode).toBe(201);
    expect(res.json().run.counts.total).toBe(2);
  });
});
