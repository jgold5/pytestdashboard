import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Summary, TestCase, TestCaseList } from '@ptd/shared';
import { csvSafeCell } from '../src/util/csv.js';
import { escapeLike } from '../src/util/sql.js';
import { createTestApp, type TestApp } from './helpers/app.js';

describe('test cases API', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await createTestApp();
  });
  afterEach(async () => t.close());

  const create = async (body: object) => {
    const res = await t.app.inject({ method: 'POST', url: '/api/test-cases', payload: body });
    expect(res.statusCode, res.body).toBe(201);
    return res.json<TestCase>();
  };
  const list = async (qs: string) => (await t.app.inject({ url: `/api/test-cases?${qs}` })).json<TestCaseList>();

  it('creates, rejects duplicates (409) and validates input (400)', async () => {
    const tc = await create({ key: 'TC-1', title: 'Login', tags: ['a'], jiraKey: 'QA-1' });
    expect(tc).toMatchObject({ automationStatus: 'not_automated', source: 'manual', pullRequests: [], inOpenPr: false, openBugs: [] });
    expect((await t.app.inject({ method: 'POST', url: '/api/test-cases', payload: { key: 'TC-1', title: 'x' } })).statusCode).toBe(409);
    expect((await t.app.inject({ method: 'POST', url: '/api/test-cases', payload: { key: 'TC-9', title: 'x', jiraKey: 'QA-1' } })).statusCode).toBe(409);
    const bad = await t.app.inject({ method: 'POST', url: '/api/test-cases', payload: { key: '', title: 'x', externalUrl: 'javascript:x' } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe('validation_error');
    const malformed = await t.app.inject({ method: 'POST', url: '/api/test-cases', payload: '{', headers: { 'content-type': 'application/json' } });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json().message).not.toMatch(/at .*\.js/);
    expect((await t.app.inject({ url: '/api/test-cases/999' })).json()).toEqual({ error: 'not_found', message: 'Test case not found' });
  });

  it('PATCH only changes provided fields (never resets omitted ones)', async () => {
    const tc = await create({
      key: 'TC-1',
      title: 'Login',
      suite: 'Auth',
      owner: 'Priya',
      priority: 'P1',
      tags: ['smoke'],
      automationStatus: 'in_progress',
      externalUrl: 'https://jira/QA-1',
    });
    const res = await t.app.inject({ method: 'PATCH', url: `/api/test-cases/${tc.id}`, payload: { title: 'Login v2', unknownField: 1 } });
    expect(res.statusCode).toBe(200);
    expect(res.json<TestCase>()).toMatchObject({
      title: 'Login v2',
      suite: 'Auth',
      owner: 'Priya',
      priority: 'P1',
      tags: ['smoke'],
      automationStatus: 'in_progress',
      externalUrl: 'https://jira/QA-1',
    });
    const cleared = await t.app.inject({ method: 'PATCH', url: `/api/test-cases/${tc.id}`, payload: { owner: null } });
    expect(cleared.json<TestCase>()).toMatchObject({ owner: null, suite: 'Auth' });
  });

  it('escapes LIKE wildcards in search', async () => {
    expect(escapeLike('50%_off\\')).toBe('50\\%\\_off\\\\');
    await create({ key: 'A-1', title: '100% coverage' });
    await create({ key: 'A-2', title: '1000 coverage' });
    await create({ key: 'B_1', title: 'underscore' });
    await create({ key: 'BX1', title: 'no underscore' });
    expect((await list('search=100%25')).items.map((c) => c.key)).toEqual(['A-1']);
    expect((await list('search=B_')).items.map((c) => c.key)).toEqual(['B_1']);
    expect((await list('search=%25')).total).toBe(1);
  });

  it('filters, sorts and paginates', async () => {
    for (let i = 1; i <= 7; i++) {
      await create({ key: `K-${i}`, title: `T${i}`, suite: i % 2 ? 'Odd' : 'Even', priority: i <= 2 ? 'P0' : null });
    }
    const page = await list('suite=Odd&pageSize=2&page=2&sort=key&order=desc');
    expect(page.total).toBe(4);
    expect(page.items.map((c) => c.key)).toEqual(['K-3', 'K-1']);
    const byPri = await list('sort=priority&order=asc&pageSize=3');
    expect(byPri.items.slice(0, 2).every((c) => c.priority === 'P0')).toBe(true);
    expect((await t.app.inject({ url: '/api/test-cases?pageSize=1000' })).statusCode).toBe(400);
  });

  it('bulk update + delete + coverage math', async () => {
    const ids: number[] = [];
    for (const s of ['automated', 'automated', 'in_progress', 'not_automated', 'not_automatable']) {
      ids.push((await create({ key: `C-${ids.length}`, title: 'x', automationStatus: s, owner: 'Ann' })).id);
    }
    let summary = (await t.app.inject({ url: '/api/summary' })).json<Summary>();
    expect(summary.coverage).toMatchObject({ total: 5, automated: 2, inProgress: 1, notAutomated: 1, notAutomatable: 1 });
    expect(summary.coverage.automationRate).toBeCloseTo(2 / 4);
    expect(summary.coverageTrend).toHaveLength(1);
    expect(summary.byOwner).toEqual([{ owner: 'Ann', total: 5, automated: 2 }]);

    const bulk = await t.app.inject({
      method: 'POST',
      url: '/api/test-cases/bulk-update',
      payload: { ids: [ids[2], ids[3]], patch: { automationStatus: 'automated' } },
    });
    expect(bulk.json()).toEqual({ updated: 2 });
    expect((await t.app.inject({ method: 'POST', url: '/api/test-cases/bulk-update', payload: { ids: [1], patch: {} } })).statusCode).toBe(400);
    expect((await t.app.inject({ method: 'DELETE', url: `/api/test-cases/${ids[4]}` })).statusCode).toBe(204);
    summary = (await t.app.inject({ url: '/api/summary' })).json<Summary>();
    expect(summary.coverage).toMatchObject({ total: 4, automated: 4, notAutomatable: 0, automationRate: 1 });
    expect(summary.coverageTrend.at(-1)).toMatchObject({ total: 4, automated: 4 });
  });

  it('exports CSV with formula injection neutralized', async () => {
    expect(csvSafeCell('=1+1')).toBe("'=1+1");
    expect(csvSafeCell('+cmd')).toBe("'+cmd");
    expect(csvSafeCell('-2')).toBe("'-2");
    expect(csvSafeCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvSafeCell('\tx')).toBe("'\tx");
    expect(csvSafeCell('safe')).toBe('safe');
    await create({ key: 'E-1', title: '=HYPERLINK("http://evil","click")', owner: '@admin', tags: ['+x'] });
    const res = await t.app.inject({ url: '/api/test-cases/export.csv' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="test-cases-/);
    const body = res.body.replace(/^﻿/, '');
    const line = body.split('\n')[1]!;
    expect(line).toContain(`"'=HYPERLINK(""http://evil"",""click"")"`);
    expect(line).toContain(`"'@admin"`);
    expect(line).toContain(`"'+x"`);
    expect(body).not.toMatch(/(^|,)"?=/m);
  });

  it('meta lists distinct values', async () => {
    await create({ key: 'M-1', title: 'x', suite: 'S1', owner: 'O1', tags: ['t1', 't2'] });
    await create({ key: 'M-2', title: 'x', suite: 'S2', tags: ['t2'] });
    const meta = (await t.app.inject({ url: '/api/meta' })).json();
    expect(meta).toEqual({ suites: ['S1', 'S2'], owners: ['O1'], tags: ['t1', 't2'], branches: [], runGroups: [] });
  });
});
