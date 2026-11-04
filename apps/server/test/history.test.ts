import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  FailureGroup,
  HistoryMatrix,
  Run,
  RunComparison,
  TestCaseDetail,
  TestCaseList,
  TestResultList,
} from '@ptd/shared';
import { classifyChange } from '../src/domain/history.js';
import { computeStats } from '../src/domain/caseHistory.js';
import { createTestApp, type TestApp } from './helpers/app.js';
import { daysAgo, importResults, type ResultSpec } from './helpers/allure.js';

const api = (name: string, status: ResultSpec['status'], start: number, extra: Partial<ResultSpec> = {}): ResultSpec => ({
  fullName: `tests.api.test_mod#${name}`,
  status,
  start,
  message: status === 'failed' || status === 'broken' ? `AssertionError: ${name} broke` : undefined,
  ...extra,
});
const ui = (name: string, status: ResultSpec['status'], start: number): ResultSpec => ({
  fullName: `tests.db.test_tables#${name}`,
  status,
  start,
  message: status === 'failed' ? 'TimeoutError: page did not load' : undefined,
});

describe('run history', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await createTestApp();
  });
  afterEach(async () => t.close());

  const getRun = async (id: number) => (await t.app.inject({ url: `/api/runs/${id}` })).json<Run>();

  it('classifies changes', () => {
    expect(classifyChange('failed', undefined)).toBe('new_test');
    expect(classifyChange('failed', 'passed')).toBe('new_failure');
    expect(classifyChange('broken', 'skipped')).toBe('new_failure');
    expect(classifyChange('failed', 'broken')).toBe('still_failing');
    expect(classifyChange('passed', 'failed')).toBe('fixed');
    expect(classifyChange('passed', 'passed')).toBe('stable_pass');
    expect(classifyChange('skipped', 'passed')).toBe('other');
    expect(classifyChange('passed', 'skipped')).toBe('other');
  });

  it('auto-derives run groups and never baselines across groups or branches', async () => {
    const a1 = await importResults(t, [api('t1', 'passed', daysAgo(5)), api('t2', 'passed', daysAgo(5))], { branch: 'main' });
    const u1 = await importResults(t, [ui('p1', 'passed', daysAgo(4))], { branch: 'main' });
    const a2 = await importResults(t, [api('t1', 'failed', daysAgo(3)), api('t2', 'passed', daysAgo(3))], { branch: 'main' });
    const f1 = await importResults(t, [api('t1', 'passed', daysAgo(2))], { branch: 'feature/x' });
    const u2 = await importResults(t, [ui('p1', 'failed', daysAgo(1))], { branch: 'main' });

    expect(a1.run.runGroup).toBe('tests/api');
    expect(u1.run.runGroup).toBe('tests/db');
    expect(a1.run.previousRunId).toBeNull();
    expect(a1.run.changes.newTests).toBe(2);
    expect(a2.run.previousRunId).toBe(a1.run.id);
    expect(a2.run.changes).toMatchObject({ newFailures: 1, newTests: 0, fixed: 0, missing: 0 });
    expect(f1.run.previousRunId).toBeNull(); // other branch
    expect(u2.run.previousRunId).toBe(u1.run.id); // not a2 even though a2 is more recent
    expect(u2.run.changes.newFailures).toBe(1);

    const results = (await t.app.inject({ url: `/api/runs/${a2.run.id}/results?change=new_failure` })).json<TestResultList>();
    expect(results.items.map((r) => r.name)).toEqual(['t1']);

    // explicit runGroup overrides derivation
    const s = await importResults(t, [api('t1', 'passed', daysAgo(0))], { runGroup: 'smoke', branch: 'main' });
    expect(s.run.runGroup).toBe('smoke');
    expect(s.run.previousRunId).toBeNull();
    expect(s.warnings.some((w) => w.includes('auto-detected'))).toBe(false);
  });

  it('re-links the following run when an older run is imported out of order', async () => {
    const r1 = await importResults(t, [api('t1', 'passed', daysAgo(10))]);
    const r3 = await importResults(t, [api('t1', 'failed', daysAgo(2)), api('t2', 'passed', daysAgo(2))]);
    expect((await getRun(r3.run.id)).changes.newFailures).toBe(1);

    const r2 = await importResults(t, [api('t1', 'failed', daysAgo(5)), api('t2', 'passed', daysAgo(5))]);
    expect(r2.run.previousRunId).toBe(r1.run.id);
    expect(r2.run.changes.newFailures).toBe(1);
    const r3b = await getRun(r3.run.id);
    expect(r3b.previousRunId).toBe(r2.run.id);
    expect(r3b.changes).toMatchObject({ newFailures: 0, stillFailing: 1, newTests: 0 });
  });

  it('re-links the next run after a delete, and on PATCH runGroup/branch', async () => {
    const r1 = await importResults(t, [api('t1', 'failed', daysAgo(3))], { branch: 'main' });
    const r2 = await importResults(t, [api('t1', 'passed', daysAgo(2))], { branch: 'main' });
    const r3 = await importResults(t, [api('t1', 'passed', daysAgo(1)), api('t9', 'passed', daysAgo(1))], { branch: 'main' });
    expect((await getRun(r2.run.id)).changes.fixed).toBe(1);
    expect((await getRun(r3.run.id)).changes.newTests).toBe(1);

    expect((await t.app.inject({ method: 'DELETE', url: `/api/runs/${r2.run.id}` })).statusCode).toBe(204);
    const r3b = await getRun(r3.run.id);
    expect(r3b.previousRunId).toBe(r1.run.id);
    expect(r3b.changes).toMatchObject({ fixed: 1, newTests: 1 });

    // move r3 to another branch → no baseline; moving back restores it
    const patched = await t.app.inject({ method: 'PATCH', url: `/api/runs/${r3.run.id}`, payload: { branch: 'release' } });
    expect(patched.statusCode).toBe(200);
    expect(patched.json<Run>()).toMatchObject({ branch: 'release', previousRunId: null });
    const back = await t.app.inject({ method: 'PATCH', url: `/api/runs/${r3.run.id}`, payload: { branch: 'main', name: 'renamed' } });
    expect(back.json<Run>()).toMatchObject({ name: 'renamed', previousRunId: r1.run.id });
  });

  it('compares runs by category', async () => {
    const base = await importResults(t, [
      api('fix', 'failed', daysAgo(2)),
      api('regress', 'passed', daysAgo(2)),
      api('still', 'broken', daysAgo(2)),
      api('gone', 'passed', daysAgo(2)),
      api('slow', 'passed', daysAgo(2), { durationMs: 1000 }),
      api('same', 'passed', daysAgo(2)),
    ]);
    const head = await importResults(t, [
      api('fix', 'passed', daysAgo(1)),
      api('regress', 'failed', daysAgo(1)),
      api('still', 'failed', daysAgo(1)),
      api('new', 'passed', daysAgo(1)),
      api('slow', 'passed', daysAgo(1), { durationMs: 2600 }),
      api('same', 'passed', daysAgo(1)),
    ]);
    const res = await t.app.inject({ url: `/api/runs/compare?head=${head.run.id}` });
    expect(res.statusCode).toBe(200);
    const c = res.json<RunComparison>();
    expect(c.base.id).toBe(base.run.id);
    expect(c.counts).toEqual({ newFailures: 1, fixed: 1, stillFailing: 1, added: 1, removed: 1, slower: 1, unchangedPass: 2 });
    expect(c.newFailures[0]?.testCase.key).toContain('regress');
    expect(c.newFailures[0]?.headMessage).toBe('AssertionError: regress broke');
    expect(c.removed[0]?.headStatus).toBeNull();
    expect(c.slower[0]).toMatchObject({ baseDurationMs: 1000, headDurationMs: 2600 });

    const noBase = await t.app.inject({ url: `/api/runs/compare?head=${base.run.id}` });
    expect(noBase.statusCode).toBe(400);
  });

  it('builds the history matrix (oldest→newest, unstable first)', async () => {
    const statuses: Array<[ResultSpec['status'], ResultSpec['status'], ResultSpec['status']]> = [
      ['passed', 'failed', 'passed'], // flaky: 2 flips
      ['failed', 'failed', 'failed'], // consistently failing: 0 flips, 3 failures
      ['passed', 'passed', 'passed'], // stable
    ];
    const ids: number[] = [];
    for (let run = 0; run < 3; run++) {
      const r = await importResults(
        t,
        statuses.map((s, i) => api(`m${i}`, s[run]!, daysAgo(10 - run))),
      );
      ids.push(r.run.id);
    }
    await importResults(t, [ui('p1', 'failed', daysAgo(0))]); // other group must not appear

    const m = (await t.app.inject({ url: '/api/history/matrix?runGroup=tests/api&runs=5' })).json<HistoryMatrix>();
    expect(m.runGroup).toBe('tests/api');
    expect(m.runs.map((r) => r.id)).toEqual(ids);
    expect(m.total).toBe(2); // onlyUnstable default
    expect(m.rows.map((r) => [r.testCase.key.split('#')[1], r.flips, r.failures])).toEqual([
      ['m0', 2, 1],
      ['m1', 0, 3],
    ]);
    expect(m.rows[0]?.cells.map((c) => c.status)).toEqual(['passed', 'failed', 'passed']);
    expect(m.rows[0]?.cells.every((c) => typeof c.resultId === 'number')).toBe(true);

    const all = (await t.app.inject({ url: '/api/history/matrix?runGroup=tests/api&onlyUnstable=false&runs=5' })).json<HistoryMatrix>();
    expect(all.total).toBe(3);
    // default group = group of latest run
    const def = (await t.app.inject({ url: '/api/history/matrix' })).json<HistoryMatrix>();
    expect(def.runGroup).toBe('tests/db');
  });

  it('computes case history stats and per-group flakiness', async () => {
    const days = [9, 8, 7, 6, 5, 4];
    const seq: ResultSpec['status'][] = ['passed', 'passed', 'failed', 'passed', 'failed', 'failed'];
    for (let i = 0; i < days.length; i++) {
      await importResults(t, [api('x', seq[i]!, daysAgo(days[i]!), { durationMs: 1000 + i * 10 })]);
    }
    const list = (await t.app.inject({ url: '/api/test-cases' })).json<TestCaseList>();
    const tc = list.items[0]!;
    // flips: P P F P F F → 3 flips / 5
    expect(tc.flakiness).toBeCloseTo(0.6);
    const d = (await t.app.inject({ url: `/api/test-cases/${tc.id}` })).json<TestCaseDetail>();
    expect(d.history).toHaveLength(6);
    expect(d.history[0]).toMatchObject({ status: 'failed', change: 'still_failing', runGroup: 'tests/api' });
    expect(d.stats.consecutiveFailures).toBe(2);
    expect(d.stats.failingSince?.at).toBe(new Date(daysAgo(5)).toISOString());
    expect(d.stats.lastPassed?.at).toBe(new Date(daysAgo(6)).toISOString());
    expect(d.stats.passRate).toBeCloseTo(0.5);
    expect(d.stats.executions).toBe(6);

    const flaky = (await t.app.inject({ url: '/api/test-cases?flakyOnly=true' })).json<TestCaseList>();
    expect(flaky.total).toBe(1);
  });

  it('duration ratio flags a slowing test', () => {
    const rows = [5000, 1000, 1000, 1000, 1000].map((d, i) => ({
      runId: 10 - i,
      runName: `r${i}`,
      sortAt: `2026-01-${String(20 - i).padStart(2, '0')}`,
      runGroup: 'g',
      status: 'passed' as const,
      durationMs: d,
    }));
    const s = computeStats(rows);
    expect(s.durationRatio).toBe(5);
    expect(s.avgDurationMs).toBe(1800);
    expect(s.failingSince).toBeNull();
  });

  it('failure groups put new failures first and report firstSeen', async () => {
    const r1 = await importResults(t, [
      api('old', 'failed', daysAgo(3)),
      api('old2', 'failed', daysAgo(3), { message: 'AssertionError: old broke' }),
      api('fresh', 'passed', daysAgo(3)),
    ]);
    const r2 = await importResults(t, [
      api('old', 'failed', daysAgo(1)),
      api('old2', 'failed', daysAgo(1), { message: 'AssertionError: old broke' }),
      api('fresh', 'failed', daysAgo(1), { message: 'KeyError: brand new' }),
    ]);
    const groups = (await t.app.inject({ url: `/api/runs/${r2.run.id}/failures` })).json<FailureGroup[]>();
    expect(groups[0]).toMatchObject({ newFailures: 1, count: 1 });
    expect(groups[0]?.firstSeen?.runId).toBe(r2.run.id);
    expect(groups[1]?.firstSeen?.runId).toBe(r1.run.id);
    expect(groups[1]?.count).toBe(2);
  });
});
