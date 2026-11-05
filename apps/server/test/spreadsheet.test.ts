import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import writeXlsxFile from 'write-excel-file/node';
import type { ImportCommitResponse, ImportPreviewResponse, ImportStatusValuesResponse, TestCaseList } from '@ptd/shared';
import { normalizeAutomationStatus, normalizePriority, splitTags } from '../src/domain/normalize.js';
import { suggestMapping } from '../src/import/spreadsheet/headers.js';
import { UploadStore } from '../src/import/spreadsheet/store.js';
import { createTestApp, multipart, type TestApp } from './helpers/app.js';
import { makeZip } from './helpers/zip.js';

describe('normalizers', () => {
  it('maps automation status values', () => {
    for (const v of ['Yes', 'y', 'TRUE', 'Automated', 'done', 'Complete', '✓', 'x']) expect(normalizeAutomationStatus(v)).toBe('automated');
    for (const v of ['WIP', 'in progress', 'In-Progress', 'ongoing', 'Started']) expect(normalizeAutomationStatus(v)).toBe('in_progress');
    for (const v of ['no', 'N', 'false', 'Manual', 'todo', 'Not started', '', '  ']) expect(normalizeAutomationStatus(v)).toBe('not_automated');
    for (const v of ['N/A', 'na', 'Not automatable', 'not possible', "Won't automate", 'won’t automate']) {
      expect(normalizeAutomationStatus(v)).toBe('not_automatable');
    }
    expect(normalizeAutomationStatus(null)).toBe('not_automated');
    expect(normalizeAutomationStatus('banana')).toBeNull();
    expect(normalizeAutomationStatus('not_automatable')).toBe('not_automatable');
  });

  it('maps priorities', () => {
    expect(['P0', 'p1', 'P2', 'p3'].map(normalizePriority)).toEqual(['P0', 'P1', 'P2', 'P3']);
    expect(['Critical', 'Blocker', 'High', 'Medium', 'Low'].map(normalizePriority)).toEqual(['P0', 'P0', 'P1', 'P2', 'P3']);
    expect(['0', '1', '2', '3', 3].map(normalizePriority)).toEqual(['P0', 'P1', 'P2', 'P3', 'P3']);
    expect(normalizePriority('urgent-ish?')).toBe('P0');
    expect(normalizePriority('whatever')).toBeNull();
    expect(normalizePriority('')).toBeNull();
    expect(normalizePriority('7')).toBeNull();
  });

  it('splits tags', () => {
    expect(splitTags('a, b;c | a ,, ')).toEqual(['a', 'b', 'c']);
  });

  it('suggests header mappings', () => {
    expect(
      suggestMapping(['Test ID', 'Test Case', 'Module', 'Automated?', 'Owner', 'Severity', 'Labels', 'Jira', 'Notes']),
    ).toEqual({
      'Test ID': 'key',
      'Test Case': 'title',
      Module: 'suite',
      'Automated?': 'automationStatus',
      Owner: 'owner',
      Severity: 'priority',
      Labels: 'tags',
      Jira: 'externalUrl',
    });
    expect(suggestMapping(['TC', 'Summary', 'Automation Status', 'Jira Key', 'Assignee'])).toEqual({
      TC: 'key',
      Summary: 'title',
      'Automation Status': 'automationStatus',
      'Jira Key': 'jiraKey',
      Assignee: 'owner',
    });
  });

  it('upload store expires and evicts (LRU)', () => {
    let now = 0;
    const s = new UploadStore(2, 1000, () => now);
    const a = s.put('a', []);
    const b = s.put('b', []);
    s.get(a); // a most recently used
    s.put('c', []);
    expect(s.get(b)).toBeUndefined();
    expect(s.get(a)).toBeDefined();
    now = 5000;
    expect(s.get(a)).toBeUndefined();
  });
});

describe('spreadsheet import API', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await createTestApp();
  });
  afterEach(async () => t.close());

  async function preview(filename: string, content: Buffer | string) {
    const mp = multipart({}, [{ field: 'file', filename, content }]);
    return t.app.inject({ method: 'POST', url: '/api/test-cases/import/preview', payload: mp.payload, headers: mp.headers });
  }

  it('imports a real .xlsx: preview → status values → dry run → commit → re-commit updates', async () => {
    const header = ['Test ID', 'Name', 'Feature', 'Automated?', 'QA', 'Priority', 'Tags', 'Jira', 'Created'];
    const rows: Array<Array<string | number | boolean | Date | null>> = [
      ['TC-1', 'Login works', 'Auth', 'Yes', 'Priya', 'High', 'smoke, api', 'https://jira.example.com/browse/QA-1', new Date(Date.UTC(2026, 0, 15))],
      ['TC-2', 'Logout', 'Auth', 'WIP', 'Marco', 1, 'api', 'QA-2', null],
      ['TC-3', 'Refund', 'Payments', 'N/A', null, 'Low', null, null, null],
      [null, null, null, null, null, null, null, null, null],
      ['TC-4', null, 'Payments', 'manual', null, null, null, 'not a url', null],
      ['TC-1', 'Duplicate', 'Auth', 'Yes', null, null, null, null, null],
      ['TC-5', 'Bool status', 'Search', true, null, 'P3', null, null, null],
    ];
    const toCell = (v: string | number | boolean | Date | null) => (v === null ? null : v instanceof Date ? { value: v, format: 'yyyy-mm-dd' } : { value: v });
    const xlsx = await writeXlsxFile([
      { sheet: 'Cases', data: [header.map((h) => ({ value: h })), ...rows.map((r) => r.map(toCell))] },
      { sheet: 'Other', data: [[{ value: 'x' }]] },
    ]).toBuffer();

    const res = await preview('tracker.xlsx', xlsx);
    expect(res.statusCode, res.body).toBe(200);
    const p = res.json<ImportPreviewResponse>();
    expect(p.sheets.map((s) => s.name)).toEqual(['Cases', 'Other']);
    const sheet = p.sheets[0]!;
    expect(sheet.headers).toEqual(header);
    expect(sheet.rowCount).toBe(6);
    expect(sheet.sampleRows[0]?.[8]).toBe('2026-01-15');
    expect(sheet.sampleRows[1]?.[5]).toBe('1');
    expect(sheet.suggestedMapping).toMatchObject({ 'Test ID': 'key', Name: 'title', Feature: 'suite', 'Automated?': 'automationStatus', QA: 'owner' });

    const sv = (
      await t.app.inject({
        method: 'POST',
        url: '/api/test-cases/import/status-values',
        payload: { uploadId: p.uploadId, sheet: 'Cases', column: 'Automated?' },
      })
    ).json<ImportStatusValuesResponse>();
    expect(sv.values).toContainEqual({ raw: 'Yes', count: 2, suggested: 'automated' });
    expect(sv.values).toContainEqual({ raw: 'TRUE', count: 1, suggested: 'automated' });

    const commitBody = {
      uploadId: p.uploadId,
      sheet: 'Cases',
      mapping: sheet.suggestedMapping,
      statusValueMap: { manual: 'not_automatable' },
    };
    const dry = (
      await t.app.inject({ method: 'POST', url: '/api/test-cases/import/commit', payload: { ...commitBody, dryRun: true } })
    ).json<ImportCommitResponse>();
    expect(dry).toMatchObject({ created: 5, updated: 0, skipped: 1, dryRun: true });
    expect((await t.app.inject({ url: '/api/test-cases' })).json<TestCaseList>().total).toBe(0);

    const done = (
      await t.app.inject({ method: 'POST', url: '/api/test-cases/import/commit', payload: commitBody })
    ).json<ImportCommitResponse>();
    expect(done).toMatchObject({ created: 5, updated: 0, skipped: 1, dryRun: false });
    expect(done.errors).toContainEqual({ row: 7, message: expect.stringContaining('Duplicate key') });

    const cases = (await t.app.inject({ url: '/api/test-cases?pageSize=50' })).json<TestCaseList>().items;
    const byKey = Object.fromEntries(cases.map((c) => [c.key, c]));
    expect(byKey['TC-1']).toMatchObject({
      title: 'Login works',
      suite: 'Auth',
      automationStatus: 'automated',
      owner: 'Priya',
      priority: 'P1',
      tags: ['smoke', 'api'],
      externalUrl: 'https://jira.example.com/browse/QA-1',
      source: 'spreadsheet',
    });
    expect(byKey['TC-2']).toMatchObject({ automationStatus: 'in_progress', priority: 'P1', jiraKey: 'QA-2', externalUrl: null });
    expect(byKey['TC-3']).toMatchObject({ automationStatus: 'not_automatable', priority: 'P3' });
    expect(byKey['TC-4']).toMatchObject({ title: 'TC-4', automationStatus: 'not_automatable', externalUrl: null });
    expect(byKey['TC-5']).toMatchObject({ automationStatus: 'automated' });

    // re-commit with onConflict=skip, then update
    const skip = (
      await t.app.inject({ method: 'POST', url: '/api/test-cases/import/commit', payload: { ...commitBody, onConflict: 'skip' } })
    ).json<ImportCommitResponse>();
    expect(skip).toMatchObject({ created: 0, updated: 0, skipped: 6 });
    const upd = (
      await t.app.inject({ method: 'POST', url: '/api/test-cases/import/commit', payload: commitBody })
    ).json<ImportCommitResponse>();
    expect(upd).toMatchObject({ created: 0, updated: 5 });
  });

  it('imports CSV with semicolons, falls back key → title when key unmapped', async () => {
    const csv = '﻿Name;Status;Area\nCheckout;done;Shop\n;;\nSearch;n/a;Shop\nWeird;banana;Shop\n';
    const p = (await preview('cases.csv', csv)).json<ImportPreviewResponse>();
    expect(p.sheets[0]).toMatchObject({ name: 'Sheet1', headers: ['Name', 'Status', 'Area'], rowCount: 3 });
    const res = (
      await t.app.inject({
        method: 'POST',
        url: '/api/test-cases/import/commit',
        payload: { uploadId: p.uploadId, sheet: 'Sheet1', mapping: { Name: 'title', Status: 'automationStatus', Area: 'suite' } },
      })
    ).json<ImportCommitResponse>();
    expect(res).toMatchObject({ created: 3, errors: [] });
    const cases = (await t.app.inject({ url: '/api/test-cases' })).json<TestCaseList>().items;
    expect(cases.map((c) => [c.key, c.automationStatus])).toEqual([
      ['Checkout', 'automated'],
      ['Search', 'not_automatable'],
      ['Weird', 'not_automated'],
    ]);
  });

  it('rejects bad files', async () => {
    expect((await preview('x.xls', Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 1, 2]))).statusCode).toBe(415);
    expect((await preview('x.xlsx', 'not really')).statusCode).toBe(415);
    expect((await preview('bin.csv', Buffer.from([1, 0, 2, 0]))).statusCode).toBe(415);
    const bomb = makeZip([{ name: 'xl/worksheets/sheet1.xml', data: Buffer.alloc(3 * 1024 * 1024) }]);
    expect((await preview('bomb.xlsx', bomb)).statusCode).toBe(413);
    const wide = `${Array.from({ length: 201 }, (_, i) => `c${i}`).join(',')}\n${'x,'.repeat(200)}x\n`;
    expect((await preview('wide.csv', wide)).statusCode).toBe(413);
    const expired = await t.app.inject({
      method: 'POST',
      url: '/api/test-cases/import/commit',
      payload: { uploadId: 'nope', sheet: 'x', mapping: {} },
    });
    expect(expired.statusCode).toBe(404);
    const notMultipart = await t.app.inject({ method: 'POST', url: '/api/test-cases/import/preview', payload: { a: 1 } });
    expect(notMultipart.statusCode).toBe(415);
  });
});
