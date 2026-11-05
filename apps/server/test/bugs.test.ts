import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Bug, BugList, BugStats, FailureGroup, Summary, TestCase, TestCaseList } from '@ptd/shared';
import { bugTitleFromNote, jiraKeyFromUrl } from '../src/domain/bugs.js';
import { authEnv, createTestApp, EDITOR_TOKEN, VIEWER_TOKEN, type TestApp } from './helpers/app.js';
import { daysAgo, importResults, type ResultSpec } from './helpers/allure.js';

const r = (name: string, status: ResultSpec['status'], start: number, message = 'AssertionError: payment declined'): ResultSpec => ({
  fullName: `tests.api.test_pay#${name}`,
  status,
  start,
  message: status === 'failed' ? message : undefined,
});

describe('bugs', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await createTestApp();
  });
  afterEach(async () => t.close());

  const cases = async () => (await t.app.inject({ url: '/api/test-cases?pageSize=100' })).json<TestCaseList>().items;
  const caseByName = async (n: string) => (await cases()).find((c) => c.key.endsWith(n))!;
  const createBug = async (body: object) => {
    const res = await t.app.inject({ method: 'POST', url: '/api/bugs', payload: body });
    expect(res.statusCode, res.body).toBe(201);
    return res.json<Bug>();
  };
  const patchBug = async (id: number, body: object) =>
    (await t.app.inject({ method: 'PATCH', url: `/api/bugs/${id}`, payload: body })).json<Bug>();
  const getBug = async (id: number) => (await t.app.inject({ url: `/api/bugs/${id}` })).json<Bug>();

  it('parses Jira keys from ticket URLs', () => {
    expect(jiraKeyFromUrl('https://acme.atlassian.net/browse/PAY-123')).toBe('PAY-123');
    expect(jiraKeyFromUrl('https://acme.atlassian.net/jira/software/projects/PAY/boards/1?selectedIssue=PAY-7')).toBe('PAY-7');
    expect(jiraKeyFromUrl('https://example.com/issues/12')).toBeNull();
    expect(jiraKeyFromUrl('nonsense')).toBeNull();
  });

  it('computes verification states from results after resolvedAt', async () => {
    await importResults(t, [r('a', 'failed', daysAgo(5)), r('b', 'failed', daysAgo(5))]);
    const a = await caseByName('#a');
    const b = await caseByName('#b');

    const bugA = await createBug({ title: 'Declined cards', jiraKey: 'PAY-1', severity: 'critical', testCaseIds: [a.id] });
    const bugB = await createBug({ title: 'Other', testCaseIds: [b.id] });
    expect(bugA.verification).toBe('n/a');
    expect(bugA.foundByAutomation).toBe(false);
    expect((await t.app.inject({ method: 'POST', url: '/api/bugs', payload: { title: 'dup', jiraKey: 'PAY-1' } })).statusCode).toBe(409);

    // open bugs show on the case
    expect((await caseByName('#a')).openBugs.map((x) => x.jiraKey)).toEqual(['PAY-1']);

    const resolvedA = await patchBug(bugA.id, { status: 'resolved' });
    expect(resolvedA.resolvedAt).not.toBeNull();
    expect(resolvedA.verification).toBe('awaiting_run'); // results so far predate resolvedAt
    await patchBug(bugB.id, { status: 'closed' });

    // a later run: a passes, b still fails
    const later = Date.now() + 60_000;
    await importResults(t, [r('a', 'passed', later), r('b', 'failed', later)]);
    expect((await getBug(bugA.id)).verification).toBe('verified_fixed');
    expect((await getBug(bugB.id)).verification).toBe('still_failing');
    // verified bug no longer listed as open on the case; still-failing one is
    expect((await caseByName('#a')).openBugs).toEqual([]);
    expect((await caseByName('#b')).openBugs.map((x) => x.verification)).toEqual(['still_failing']);

    const stats = (await t.app.inject({ url: '/api/bugs/stats' })).json<BugStats>();
    expect(stats).toMatchObject({ open: 0, verifiedFixed: 1, stillFailingAfterFix: 1, resolvedAwaitingVerification: 0 });
    expect(stats.trend).toHaveLength(26);
    expect(stats.meanDaysToResolve).not.toBeNull();

    const resolvedList = (await t.app.inject({ url: '/api/bugs?bucket=resolved&verification=still_failing' })).json<BugList>();
    expect(resolvedList.items.map((x) => x.id)).toEqual([bugB.id]);

    // reopening clears resolvedAt
    expect((await patchBug(bugA.id, { status: 'open' })).resolvedAt).toBeNull();
  });

  it('auto-creates a bug from a product_bug note with a Jira URL and excludes the case from untriaged', async () => {
    const run = await importResults(t, [r('a', 'failed', daysAgo(2)), r('c', 'failed', daysAgo(2))]);
    const a = await caseByName('#a');
    let summary = (await t.app.inject({ url: '/api/summary' })).json<Summary>();
    expect(summary.untriagedFailures).toBe(2);

    const results = (await t.app.inject({ url: `/api/runs/${run.run.id}/results?search=%23a` })).json<{ items: Array<{ id: number; failureSignature: string }> }>();
    const result = results.items[0]!;
    const note = await t.app.inject({
      method: 'POST',
      url: '/api/notes',
      payload: {
        testCaseId: a.id,
        resultId: result.id,
        author: 'qa',
        body: 'Card payments declined on staging\nmore details',
        triage: 'product_bug',
        ticketUrl: 'https://acme.atlassian.net/browse/PAY-42',
      },
    });
    expect(note.statusCode).toBe(201);
    const list = (await t.app.inject({ url: '/api/bugs?bucket=all' })).json<BugList>();
    expect(list.total).toBe(1);
    const bug = list.items[0]!;
    expect(bug).toMatchObject({
      jiraKey: 'PAY-42',
      title: 'Card payments declined on staging',
      status: 'open',
      foundByAutomation: true,
      failureSignatures: [result.failureSignature],
    });
    expect(bug.foundInRun?.id).toBe(run.run.id);
    expect(bug.testCases.map((c) => c.id)).toEqual([a.id]);

    // both a (triaged + bug) and c (same signature linked to open bug) are no longer untriaged
    summary = (await t.app.inject({ url: '/api/summary' })).json<Summary>();
    expect(summary.untriagedFailures).toBe(0);

    const groups = (await t.app.inject({ url: `/api/runs/${run.run.id}/failures` })).json<FailureGroup[]>();
    expect(groups[0]?.bugs.map((b) => b.jiraKey)).toEqual(['PAY-42']);

    // a second note with the same ticket links to the existing bug
    const c: TestCase = await caseByName('#c');
    await t.app.inject({
      method: 'POST',
      url: '/api/notes/bulk',
      payload: { testCaseIds: [c.id], author: 'qa', body: 'same', triage: 'product_bug', ticketUrl: 'https://acme.atlassian.net/browse/PAY-42' },
    });
    const again = (await t.app.inject({ url: '/api/bugs?bucket=all' })).json<BugList>();
    expect(again.total).toBe(1);
    expect(again.items[0]?.testCases).toHaveLength(2);
  });

  it('validates and deletes', async () => {
    expect((await t.app.inject({ method: 'POST', url: '/api/bugs', payload: { title: 'x', testCaseIds: [999] } })).statusCode).toBe(404);
    expect((await t.app.inject({ method: 'POST', url: '/api/bugs', payload: { title: 'x', url: 'javascript:1' } })).statusCode).toBe(400);
    const b = await createBug({ title: 'x' });
    expect((await t.app.inject({ method: 'DELETE', url: `/api/bugs/${b.id}` })).statusCode).toBe(204);
    expect((await t.app.inject({ url: `/api/bugs/${b.id}` })).statusCode).toBe(404);
  });

  it('bug title from a markdown note is plain text', () => {
    expect(bugTitleFromNote('## **Checkout** fails with `500` on [staging](https://x.example)\nmore')).toBe('Checkout fails with 500 on staging');
    expect(bugTitleFromNote('\n\n> - _Card_ ~~declined~~ ![img](a.png) <https://jira.example/browse/A-1>')).toBe('Card declined img https://jira.example/browse/A-1');
    expect(bugTitleFromNote('```\ncode first\n```')).toBe('code first');
    expect(bugTitleFromNote('1. snake_case_name stays')).toBe('snake_case_name stays');
    const long = bugTitleFromNote('# ' + 'a'.repeat(500));
    expect(long.length).toBeLessThanOrEqual(200);
    expect(bugTitleFromNote('   \n---\n')).toBe('');
  });

  it('auto-created bug title strips markdown', async () => {
    await importResults(t, [r('a', 'failed', daysAgo(1))]);
    const a = await caseByName('#a');
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/notes',
      payload: { testCaseId: a.id, author: 'qa', body: '### **Refund** API returns `500`\nsee [logs](https://x.example)', triage: 'product_bug', ticketUrl: 'https://acme.atlassian.net/browse/PAY-7' },
    });
    expect(res.statusCode).toBe(201);
    const list = (await t.app.inject({ url: '/api/bugs?bucket=all' })).json<BugList>();
    expect(list.items[0]?.title).toBe('Refund API returns 500');
  });

  it('GET /api/results/:id returns one result with trace (404 for unknown)', async () => {
    const run = await importResults(t, [r('a', 'failed', daysAgo(1))]);
    const results = (await t.app.inject({ url: `/api/runs/${run.run.id}/results` })).json<{ items: Array<{ id: number }> }>();
    const id = results.items[0]!.id;
    const res = await t.app.inject({ url: `/api/results/${id}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id, runId: run.run.id, status: 'failed', testCaseKey: 'tests.api.test_pay#a' });
    expect((await t.app.inject({ url: '/api/results/999999' })).statusCode).toBe(404);
    expect((await t.app.inject({ url: '/api/results/abc' })).statusCode).toBe(400);
  });
});

describe('GET /api/results/:id access', () => {
  it('is editor only', async () => {
    const t = await createTestApp(authEnv({ VIEWER_TOKEN }));
    try {
      expect((await t.app.inject({ url: '/api/results/1' })).statusCode).toBe(401);
      expect((await t.app.inject({ url: '/api/results/1', headers: { authorization: `Bearer ${VIEWER_TOKEN}` } })).statusCode).toBe(403);
      expect((await t.app.inject({ url: '/api/results/1', headers: { authorization: `Bearer ${EDITOR_TOKEN}` } })).statusCode).toBe(404);
    } finally {
      await t.close();
    }
  });
});
