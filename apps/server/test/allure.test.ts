import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunImportResponse, TestCase, TestCaseList, TestResultList } from '@ptd/shared';
import { AllureBundle, parseProperties } from '../src/import/allure/parse.js';
import { dedupeRetries, linkCandidates } from '../src/import/allure/importRun.js';
import { deriveRunGroup } from '../src/import/allure/runGroup.js';
import { failureSignature, normalizeFailureMessage } from '../src/domain/signature.js';
import { createTestApp, multipart, type TestApp } from './helpers/app.js';
import { importResults } from './helpers/allure.js';

const FIXTURES = path.join(import.meta.dirname, 'fixtures');

describe('failure signatures', () => {
  it('groups messages that differ only by ids, numbers, paths, quotes', () => {
    const a = 'AssertionError: expected status 201 but got 500 for user 4f3a9c1e-2b7d-4e8a-9f61-0c2d3e4f5a6b\nmore';
    const b = 'AssertionError: expected status 201 but got 500 for user 9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
    expect(failureSignature(a)).toBe(failureSignature(b));
    expect(failureSignature(a)).toMatch(/^[0-9a-f]{12}$/);
    expect(normalizeFailureMessage("KeyError: 'user_42' at 0x7f3b2c1d4e50 in /srv/app/x.py")).toBe(
      'keyerror: <str> at <addr> in <path>',
    );
    expect(failureSignature('Timeout after 30s')).toBe(failureSignature('Timeout after 45s'));
    expect(failureSignature('Timeout after 30s')).not.toBe(failureSignature('Connection refused'));
    expect(normalizeFailureMessage('hash deadbeef12 mismatch')).toBe('hash <hex> mismatch');
  });
});

describe('allure parsing', () => {
  it('keeps the latest retry per historyId and counts retries', () => {
    const b = new AllureBundle();
    const base = { historyId: 'h1', fullName: 'tests.a#t', name: 't', labels: [], parameters: [] };
    b.addFile('1-result.json', Buffer.from(JSON.stringify({ ...base, uuid: '1', status: 'failed', start: 1, stop: 10 })));
    b.addFile('2-result.json', Buffer.from(JSON.stringify({ ...base, uuid: '2', status: 'passed', start: 11, stop: 20 })));
    b.addFile('3-result.json', Buffer.from(JSON.stringify({ ...base, uuid: '3', status: 'broken', start: 5, stop: 9 })));
    const d = dedupeRetries(b.results);
    expect(d).toHaveLength(1);
    expect(d[0]?.status).toBe('passed');
    expect(d[0]?.retries).toBe(2);
  });

  it('turns bad files into warnings', () => {
    const b = new AllureBundle();
    b.addFile('x-result.json', Buffer.from('{not json'));
    b.addFile('y-result.json', Buffer.from('[1,2]'));
    b.addFile('z-result.json', Buffer.from('{"status":"passed"}'));
    expect(b.results).toHaveLength(0);
    expect(b.warnings).toHaveLength(3);
    expect(b.skippedFiles).toBe(3);
  });

  it('parses environment.properties safely', () => {
    expect(parseProperties('# c\nA=1\nB : two\n__proto__=x\n!bang\n')).toEqual({ A: '1', B: 'two' });
  });

  it('collects link candidates in precedence order', () => {
    const b = new AllureBundle();
    b.addFile(
      'r-result.json',
      Buffer.from(
        JSON.stringify({
          name: 'n',
          testCaseId: 'tcid',
          labels: [
            { name: 'jira', value: 'QA-9' },
            { name: 'AS_ID', value: '42' },
          ],
          links: [{ name: 'QA-1', type: 'tms' }],
        }),
      ),
    );
    expect(linkCandidates(b.results[0]!)).toEqual(['tcid', '42', 'QA-1', 'QA-9']);
  });

  it('derives run groups from the common test folder', () => {
    const r = (fullName: string | null, labels: Array<{ name: string; value: string }> = []) => ({ fullName, labels });
    expect(deriveRunGroup([r('tests.api.users.test_login#test_ok'), r('tests.api.users.test_x.TestY#test_z')])).toBe(
      'tests/api/users',
    );
    expect(deriveRunGroup([r('tests.api.users.test_login#a'), r('tests.api.orders.test_o#b')])).toBe('tests/api');
    expect(deriveRunGroup([r('tests.api.a.b.c.test_x#t')])).toBe('tests/api/a');
    expect(deriveRunGroup([r('tests/ui/checkout/test_pay.py::TestPay::test_ok')])).toBe('tests/ui/checkout');
    expect(deriveRunGroup([r('api.test_a#t'), r('ui.test_b#t')])).toBe('default');
    expect(deriveRunGroup([r(null, [{ name: 'parentSuite', value: 'x' }])])).toBe('default');
    expect(deriveRunGroup([r(null, [{ name: 'package', value: 'tests.smoke.test_a' }])])).toBe('tests/smoke');
  });
});

describe('POST /api/runs/import', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await createTestApp();
  });
  afterEach(async () => t.close());

  it('imports the fixture zip: retries, signatures, environment, executor defaults', async () => {
    const zip = fs.readFileSync(path.join(FIXTURES, 'allure-results.zip'));
    const mp = multipart({ branch: 'main' }, [{ filename: 'allure-results.zip', content: zip, contentType: 'application/zip' }]);
    const res = await t.app.inject({ method: 'POST', url: '/api/runs/import', payload: mp.payload, headers: mp.headers });
    expect(res.statusCode).toBe(201);
    const body = res.json<RunImportResponse>();
    expect(body.run.name).toBe('nightly #482');
    expect(body.run.buildUrl).toBe('https://github.com/acme/shop/actions/runs/123456');
    expect(body.run.runGroup).toBe('tests/api');
    expect(body.run.environment.Python).toBe('3.12.4');
    expect(body.run.counts).toMatchObject({ total: 14, passed: 10, failed: 2, broken: 1, skipped: 1 });
    expect(body.createdTestCases).toBe(13);
    expect(body.skippedFiles).toBe(2); // container + categories
    expect(body.warnings.some((w) => w.includes('auto-detected'))).toBe(true);

    const results = (
      await t.app.inject({ url: `/api/runs/${body.run.id}/results?search=cart_total` })
    ).json<TestResultList>();
    expect(results.items[0]?.retries).toBe(1);
    expect(results.items[0]?.status).toBe('passed');

    const failures = (await t.app.inject({ url: `/api/runs/${body.run.id}/failures` })).json<Array<{ count: number }>>();
    expect(failures[0]?.count).toBe(2); // create_user + delete_user share a signature
    expect(failures).toHaveLength(2);
  });

  it('links by allureId, jiraKey, allureFullName and key before auto-creating; promotes', async () => {
    const mk = async (body: object) =>
      (await t.app.inject({ method: 'POST', url: '/api/test-cases', payload: body })).json<TestCase>();
    const byAllureId = await mk({ key: 'TC-1', title: 'a', allureId: '1042', automationStatus: 'not_automated' });
    const byJira = await mk({ key: 'TC-2', title: 'b', jiraKey: 'QA-7', automationStatus: 'in_progress' });
    const byFullName = await mk({ key: 'TC-3', title: 'c', allureFullName: 'tests.x#c' });
    const byKey = await mk({ key: 'tests.x#d', title: 'd', automationStatus: 'not_automatable' });

    const out = await importResults(t, [
      { fullName: 'tests.x#a', status: 'passed', labels: [{ name: 'AS_ID', value: '1042' }] },
      { fullName: 'tests.x#b', status: 'failed', message: 'boom', links: [{ name: 'QA-7', type: 'tms' }] },
      { fullName: 'tests.x#c', status: 'passed' },
      { fullName: 'tests.x#d', status: 'passed' },
      { fullName: 'tests.x#e', status: 'passed', labels: [{ name: 'tag', value: 'smoke' }, { name: 'feature', value: 'Feat' }] },
    ]);
    expect(out.createdTestCases).toBe(1);
    expect(out.promotedTestCases).toBe(3); // TC-1/TC-3 not_automated, TC-2 in_progress; not_automatable untouched

    const list = (await t.app.inject({ url: '/api/test-cases?pageSize=200' })).json<TestCaseList>();
    const get = (id: number) => list.items.find((c) => c.id === id)!;
    expect(get(byAllureId.id).lastResult?.status).toBe('passed');
    expect(get(byAllureId.id).automationStatus).toBe('automated');
    expect(get(byJira.id).lastResult?.status).toBe('failed');
    expect(get(byFullName.id).lastResult?.status).toBe('passed');
    expect(get(byKey.id).automationStatus).toBe('not_automatable');
    const created = list.items.find((c) => c.key === 'tests.x#e')!;
    expect(created).toMatchObject({ source: 'allure', automationStatus: 'automated', suite: 'Feat', tags: ['smoke'] });
  });

  it('rejects uploads without results and ignores unknown files', async () => {
    const mp = multipart({}, [{ filename: 'notes.txt', content: 'hi' }]);
    const res = await t.app.inject({ method: 'POST', url: '/api/runs/import', payload: mp.payload, headers: mp.headers });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'no_results' });
  });

  it('validates form fields', async () => {
    const mp = multipart({ buildUrl: 'javascript:alert(1)' }, [
      { filename: '1-result.json', content: JSON.stringify({ name: 'x', status: 'passed' }) },
    ]);
    const res = await t.app.inject({ method: 'POST', url: '/api/runs/import', payload: mp.payload, headers: mp.headers });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'validation_error' });
  });
});
