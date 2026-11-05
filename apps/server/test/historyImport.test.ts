import fs from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HistoryImportResponse, RunImportResponse, TestCase, TestResultList } from '@ptd/shared';
import { AllureBundle, splitDisplayName, sessionId, type ParsedResult } from '../src/import/allure/parse.js';
import { dedupeRetries } from '../src/import/allure/importRun.js';
import { detectRuns } from '../src/import/allure/sessions.js';
import { computeFlakiness } from '../src/domain/flakiness.js';
import { authEnv, createTestApp, multipart, type TestApp, type UploadFile } from './helpers/app.js';
import { allureResult, importResults } from './helpers/allure.js';
import { makeZip } from './helpers/zip.js';

const FIXTURES = path.join(import.meta.dirname, 'fixtures');
/** Written by allureparser itself: `allure-history snapshot fixtures/allure-results --order 412 --label '#412' --url …`. */
const REAL_SNAPSHOT = fs.readFileSync(path.join(FIXTURES, 'build-412.snapshot.json.gz'));
const T0 = Date.UTC(2026, 9, 1, 2);
const HOUR = 3_600_000;

type Attempt = [string, number | null, number | null, string?, string?, string?];
function snapshot(label: string, tests: Array<{ k: string; n: string; a: Attempt[] }>, extra: Record<string, unknown> = {}): Buffer {
  return gzipSync(JSON.stringify({ format: 'allure-history-snapshot', version: 2, label, order: null, url: null, start: null, tests, ...extra }));
}

/** A raw allure-pytest result recorded by process `pid` on `host`. */
function raw(fullName: string, status: 'passed' | 'failed' | 'broken' | 'skipped', start: number, host = 'ci-1', pid = 100): UploadFile {
  const r = allureResult({
    fullName,
    status,
    start,
    message: status === 'passed' ? undefined : 'AssertionError: boom',
    labels: [
      { name: 'host', value: host },
      { name: 'thread', value: `${pid}-MainThread` },
    ],
  });
  return { filename: r.filename, content: r.content };
}

async function importHistory(t: TestApp, files: UploadFile[], fields: Record<string, string> = {}, headers: Record<string, string> = {}) {
  const mp = multipart(fields, files);
  const res = await t.app.inject({ method: 'POST', url: '/api/runs/import-history', payload: mp.payload, headers: { ...mp.headers, ...headers } });
  return res;
}

async function importHistoryOk(t: TestApp, files: UploadFile[], fields: Record<string, string> = {}): Promise<HistoryImportResponse> {
  const res = await importHistory(t, files, fields);
  if (res.statusCode !== 201) throw new Error(`history import failed ${res.statusCode}: ${res.body}`);
  return res.json<HistoryImportResponse>();
}

describe('allure-history snapshot names', () => {
  it('splits the parameter suffix off the display name', () => {
    expect(splitDisplayName('tests.api.test_orders#test_create_order')).toEqual({
      fullName: 'tests.api.test_orders#test_create_order',
      name: 'test_create_order',
    });
    expect(splitDisplayName('tests.api.test_orders.TestOrders#test_pay[currency=EUR, amount=10]')).toEqual({
      fullName: 'tests.api.test_orders.TestOrders#test_pay',
      name: 'test_pay[currency=EUR, amount=10]',
    });
    expect(splitDisplayName('tests/test_x.py::TestA::test_y[a-b]')).toEqual({ fullName: 'tests/test_x.py::TestA::test_y', name: 'test_y[a-b]' });
    expect(splitDisplayName('plain name')).toEqual({ fullName: 'plain name', name: 'plain name' });
  });

  it('reads host:pid sessions from allure-pytest labels', () => {
    expect(sessionId([{ name: 'host', value: 'ci-7' }, { name: 'thread', value: '1234-MainThread' }])).toBe('ci-7:1234');
    expect(sessionId([{ name: 'host', value: 'ci-7' }])).toBeNull();
    expect(sessionId([{ name: 'thread', value: 'gw0-x' }, { name: 'host', value: 'h' }])).toBeNull();
  });

  it('parses a snapshot written by allureparser, keeping retries and failure locations', () => {
    const b = new AllureBundle({ snapshots: true });
    b.addFile('build-412.snapshot.json.gz', REAL_SNAPSHOT);
    expect(b.snapshots).toHaveLength(1);
    const s = b.snapshots[0]!;
    expect(s).toMatchObject({ label: '#412', order: 412, url: 'https://ci.example.com/job/412' });
    expect(s.results).toHaveLength(15); // 14 tests, one retried
    const retried = s.results.filter((r) => r.fullName === 'tests.routes.test_order_route.TestOrderRoute#test_order_route_publishes_to_queue');
    expect(retried.map((r) => r.status)).toEqual(['failed', 'passed']);
    expect(retried[0]!.session).toBe('ci-runner-7:1234');
  });

  it('ignores snapshots unless asked, and skips broken ones with a warning', () => {
    const plain = new AllureBundle();
    plain.addFile('build-1.snapshot.json.gz', REAL_SNAPSHOT);
    expect(plain.snapshots).toHaveLength(0);

    const b = new AllureBundle({ snapshots: true });
    b.addFile('a.snapshot.json.gz', Buffer.from('not gzip'));
    b.addFile('b.snapshot.json.gz', gzipSync('{"format":"something-else"}'));
    b.addFile('c.snapshot.json.gz', snapshot('#9', [], { version: 99 }));
    b.addFile('d.snapshot.json.gz', gzipSync(Buffer.alloc(70 * 1024 * 1024))); // decompression bomb
    expect(b.snapshots).toHaveLength(0);
    expect(b.skippedFiles).toBe(4);
    expect(b.warnings.join('\n')).toMatch(/unsupported snapshot version 99/);
  });
});

describe('run detection (one folder holding many runs)', () => {
  const r = (key: string, start: number, session: string | null, status: ParsedResult['status'] = 'passed'): ParsedResult => ({
    file: `${key}-${start}`,
    uuid: null,
    historyId: key,
    testCaseId: null,
    fullName: key,
    name: key,
    status,
    message: null,
    trace: null,
    start,
    stop: start + 10,
    labels: [],
    parameters: [],
    links: [],
    source: '',
    session,
  });

  it('splits by process, merges xdist workers, and splits a reused pid', () => {
    const runs = detectRuns([
      // run 1: two xdist workers on ci-1, overlapping in time, disjoint tests
      r('a', T0, 'ci-1:10'),
      r('b', T0 + 20, 'ci-1:10'),
      r('c', T0 + 5, 'ci-1:11'),
      r('d', T0 + 25, 'ci-1:11'),
      // run 2: pid 10 reused later — `a` shows up again after other tests ran
      r('a', T0 + HOUR, 'ci-1:10'),
      r('b', T0 + HOUR + 20, 'ci-1:10', 'failed'),
      r('b', T0 + HOUR + 40, 'ci-1:10'), // immediate rerun stays in the same run
      // run 3: another host at the same time is a separate run
      r('a', T0 + 3, 'ci-2:10'),
    ]);
    expect(runs.map((x) => [x.host, x.workers, x.results.map((y) => y.historyId).join('')])).toEqual([
      ['ci-1', 2, 'abcd'],
      ['ci-2', 1, 'a'],
      ['ci-1', 1, 'abb'],
    ]);
  });

  it('groups results without session info by folder', () => {
    const runs = detectRuns([{ ...r('a', T0, null), source: 'x' }, { ...r('b', T0 + HOUR, null), source: 'x' }]);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.workers).toBe(0);
  });
});

describe('retries', () => {
  it('keeps every attempt in order', () => {
    const base = { uuid: null, testCaseId: null, fullName: 't', name: 't', message: null, trace: null, labels: [], parameters: [], links: [] };
    const out = dedupeRetries([
      { ...base, file: '2', historyId: 'h', status: 'passed', start: T0 + 20, stop: T0 + 30 },
      { ...base, file: '1', historyId: 'h', status: 'failed', start: T0, stop: T0 + 10 },
      { ...base, file: '3', historyId: 'once', status: 'passed', start: T0, stop: T0 + 10 },
    ]);
    expect(out.map((x) => [x.historyId, x.status, x.retries, x.attempts])).toEqual([
      ['h', 'passed', 1, ['failed', 'passed']],
      ['once', 'passed', 0, null],
    ]);
  });

  it('a fail-then-pass retry counts as a flip', () => {
    // newest first: run 3 passed after a failed attempt, runs 2 and 1 passed
    expect(computeFlakiness(['passed', 'failed', 'passed', 'passed'])).toBeCloseTo(2 / 3);
  });
});

describe('POST /api/runs/import-history', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await createTestApp();
  });
  afterEach(async () => t.close());

  it('imports an allureparser snapshot as a run that links to the same cases as a raw import', async () => {
    const res = await importHistoryOk(t, [{ filename: 'build-412.snapshot.json.gz', content: REAL_SNAPSHOT, contentType: 'application/gzip' }], {
      runGroup: 'routes',
    });
    expect(res.mode).toBe('per_source');
    expect(res.runs).toHaveLength(1);
    const run = res.runs[0]!;
    expect(run).toMatchObject({ name: '#412', runGroup: 'routes', buildUrl: 'https://ci.example.com/job/412' });
    expect(run.counts.total).toBe(14);
    expect(res.createdTestCases).toBe(13); // two parameterized variants share one case, as in a raw import

    const results = (await t.app.inject({ url: `/api/runs/${run.id}/results?pageSize=100` })).json<TestResultList>().items;
    const retried = results.find((x) => x.name === 'test_order_route_publishes_to_queue')!;
    expect(retried).toMatchObject({ status: 'passed', retries: 1, attempts: ['failed', 'passed'] });
    const broken = results.find((x) => x.status === 'broken')!;
    expect(broken.message).toMatch(/ORA-12541/);
    expect(broken.failureSignature).toBeTruthy();

    // the raw folder of the same run is recognised as already imported…
    const files = fs.readdirSync(path.join(FIXTURES, 'allure-results')).map((f) => ({
      filename: f,
      content: fs.readFileSync(path.join(FIXTURES, 'allure-results', f)),
    }));
    const again = await importHistoryOk(t, files, { runGroup: 'routes' });
    expect(again.runs).toHaveLength(0);
    expect(again.duplicateRuns).toBe(1);

    // …and a regular import of it lands on the same cases (no new ones)
    const mp = multipart({ runGroup: 'other' }, files);
    const plain = (await t.app.inject({ method: 'POST', url: '/api/runs/import', payload: mp.payload, headers: mp.headers })).json<RunImportResponse>();
    expect(plain.createdTestCases).toBe(0);
  });

  it('treats each folder and snapshot as one run (zip with build folders)', async () => {
    const zip = makeZip([
      { name: 'ci/build-1/allure-results/1-result.json', data: raw('tests.api.test_a#test_x', 'passed', T0).content },
      { name: 'ci/build-1/allure-results/2-result.json', data: raw('tests.api.test_a#test_y', 'failed', T0 + 100).content },
      { name: 'ci/build-1/allure-results/executor.json', data: JSON.stringify({ buildName: 'Nightly #1', buildUrl: 'https://ci.example.com/1' }) },
      { name: 'ci/build-2/allure-results/1-result.json', data: raw('tests.api.test_a#test_x', 'passed', T0 + 24 * HOUR).content },
      { name: 'ci/build-2/allure-results/2-result.json', data: raw('tests.api.test_a#test_y', 'passed', T0 + 24 * HOUR + 100).content },
      { name: 'ci/build-2/allure-results/shot.png', data: 'png' },
      {
        name: 'ci/history/build-3.snapshot.json.gz',
        data: snapshot('#3', [
          { k: 'h-tests.api.test_a#test_x', n: 'tests.api.test_a#test_x', a: [['passed', T0 + 48 * HOUR, T0 + 48 * HOUR + 50]] },
          { k: 'h-tests.api.test_a#test_y', n: 'tests.api.test_a#test_y', a: [['failed', T0 + 48 * HOUR + 60, T0 + 48 * HOUR + 90, 'AssertionError: boom', 'tests/api/test_a.py:12']] },
        ]),
        compress: false,
      },
    ]);
    const res = await importHistoryOk(t, [{ filename: 'history.zip', content: zip, contentType: 'application/zip' }], { branch: 'main' });
    expect(res.mode).toBe('per_source');
    expect(res.runs.map((r) => [r.name, r.runGroup, r.branch, r.counts.total, r.counts.failed])).toEqual([
      ['Nightly #1', 'tests/api', 'main', 2, 1],
      ['build-2', 'tests/api', 'main', 2, 0],
      ['#3', 'tests/api', 'main', 2, 1],
    ]);
    expect(res.runs[0]!.buildUrl).toBe('https://ci.example.com/1');
    expect(res.createdTestCases).toBe(2);
    // runs are linked into one history: the third run's failure is new vs the second
    expect(res.runs[2]!.previousRunId).toBe(res.runs[1]!.id);
    expect(res.runs[2]!.changes.newFailures).toBe(1);
    expect(res.warnings.join('\n')).toMatch(/auto-detected as tests\/api \(3 runs\)/);
  });

  it('keeps multipart folders apart via file:<folder> field names', async () => {
    const files = [
      { ...raw('tests.a#t1', 'passed', T0), field: 'file:results/build-1' },
      { ...raw('tests.a#t1', 'failed', T0 + HOUR), field: 'file:results/build-2' },
    ];
    const res = await importHistoryOk(t, files, { runGroup: 'g' });
    expect(res.runs.map((r) => r.name)).toEqual(['build-1', 'build-2']);
  });

  it('recovers runs from one folder that collected many pytest runs', async () => {
    const files = [
      raw('tests.a#t1', 'passed', T0, 'ci-1', 10),
      raw('tests.a#t2', 'passed', T0 + 50, 'ci-1', 10),
      raw('tests.a#t1', 'failed', T0 + HOUR, 'ci-1', 11),
      raw('tests.a#t1', 'passed', T0 + HOUR + 200, 'ci-1', 11), // rerun in the same run
      raw('tests.a#t2', 'passed', T0 + HOUR + 400, 'ci-1', 11),
      raw('tests.a#t1', 'passed', T0 + 2 * HOUR, 'ci-1', 10), // pid 10 reused
      raw('tests.a#t2', 'passed', T0 + 2 * HOUR + 50, 'ci-1', 10),
    ];
    const res = await importHistoryOk(t, files, { runGroup: 'g' });
    expect(res.mode).toBe('detected');
    expect(res.runs.map((r) => r.name)).toEqual([
      'Run 2026-10-01 02:00:00 UTC · ci-1',
      'Run 2026-10-01 03:00:00 UTC · ci-1',
      'Run 2026-10-01 04:00:00 UTC · ci-1',
    ]);
    expect(res.runs.map((r) => r.counts.total)).toEqual([2, 2, 2]);

    // the retry that failed first makes t1 flaky although every final status passed
    const cases = (await t.app.inject({ url: '/api/test-cases?flakyOnly=true' })).json<{ items: TestCase[] }>().items;
    expect(cases.map((c) => c.key)).toEqual(['tests.a#t1']);
    expect(cases[0]!.lastResult?.status).toBe('passed');

    // importing the same folder again adds nothing
    const again = await importHistoryOk(t, files, { runGroup: 'g' });
    expect(again.runs).toHaveLength(0);
    expect(again.duplicateRuns).toBe(3);
  });

  it('rejects an upload with nothing to import', async () => {
    const res = await importHistory(t, [{ filename: 'notes.txt', content: 'x' }]);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('no_results');
  });

  it('the regular import still treats one folder as one run', async () => {
    const res = await importResults(t, [
      { fullName: 'tests.a#t1', status: 'passed', start: T0 },
      { fullName: 'tests.a#t1', status: 'passed', start: T0 + 2 * HOUR },
    ]);
    expect(res.run.counts.total).toBe(1);
  });
});

describe('POST /api/runs/import-history auth', () => {
  const INGEST_TOKEN = 'ingest-token-0123456789abcdef0123456789';
  let t: TestApp;
  beforeEach(async () => {
    t = await createTestApp(authEnv({ INGEST_TOKEN }));
  });
  afterEach(async () => t.close());

  it('accepts the CI ingest token and rejects anonymous uploads', async () => {
    const files = [{ filename: 'b.snapshot.json.gz', content: REAL_SNAPSHOT }];
    expect((await importHistory(t, files)).statusCode).toBe(401);
    const ok = await importHistory(t, files, { runGroup: 'routes' }, { authorization: `Bearer ${INGEST_TOKEN}` });
    expect(ok.statusCode).toBe(201);
  });
});
