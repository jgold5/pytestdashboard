import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Report } from '@ptd/shared';
import { computeProjection } from '../src/domain/report.js';
import { coverageSnapshots } from '../src/db/schema.js';
import { VIEWER_TOKEN, authEnv, createTestApp, type TestApp } from './helpers/app.js';

const today = new Date('2026-11-04T12:00:00Z');
const cov = { total: 110, automated: 50, notAutomatable: 10 };

describe('projection math', () => {
  it('computes velocity, remaining and status bands', () => {
    // +10 automated over 28 days → 2.5/week; goal 80% of 100 = 80 → remaining 30 → 12 weeks → 2027-01-27
    const base = { coverage: cov, automatedAtStart: 40, periodDays: 28, today };
    const p = computeProjection({ ...base, goal: { targetRate: 0.8, targetDate: '2027-03-31' } });
    expect(p).toEqual({ weeklyVelocity: 2.5, remainingToGoal: 30, projectedGoalDate: '2027-01-27', status: 'ahead' });
    expect(computeProjection({ ...base, goal: { targetRate: 0.8, targetDate: '2027-02-01' } }).status).toBe('on_track');
    expect(computeProjection({ ...base, goal: { targetRate: 0.8, targetDate: '2027-01-10' } }).status).toBe('at_risk');
    expect(computeProjection({ ...base, goal: { targetRate: 0.8, targetDate: '2026-12-01' } }).status).toBe('behind');
    const stalled = computeProjection({ ...base, automatedAtStart: 50, goal: { targetRate: 0.8, targetDate: '2027-12-31' } });
    expect(stalled).toMatchObject({ weeklyVelocity: 0, projectedGoalDate: null, status: 'behind' });
    const done = computeProjection({ ...base, goal: { targetRate: 0.5, targetDate: '2026-01-01' } });
    expect(done).toMatchObject({ remainingToGoal: 0, projectedGoalDate: '2026-11-04' });
    expect(computeProjection({ ...base, goal: null })).toEqual({
      weeklyVelocity: 2.5,
      remainingToGoal: null,
      projectedGoalDate: null,
      status: null,
    });
  });
});

describe('GET /api/report', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await createTestApp(authEnv({ VIEWER_TOKEN }));
  });
  afterEach(async () => t.close());

  it('is readable by viewers, uses settings and snapshots, contains no free text', async () => {
    const auth = { authorization: `Bearer ${authEnv().DASHBOARD_TOKEN}` };
    const put = await t.app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: auth,
      payload: { teamName: 'Payments QA', goal: { targetRate: 0.8, targetDate: '2027-02-01' } },
    });
    expect(put.statusCode).toBe(200);
    for (let i = 0; i < 4; i++) {
      await t.app.inject({
        method: 'POST',
        url: '/api/test-cases',
        headers: auth,
        payload: { key: `K${i}`, title: 'secret title', automationStatus: i < 2 ? 'automated' : 'not_automated' },
      });
    }
    const start = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
    t.dbHandle.db.insert(coverageSnapshots).values({ date: start, total: 4, automated: 1, inProgress: 0, notAutomatable: 0 }).run();

    const res = await t.app.inject({ url: '/api/report?periodDays=30', headers: { authorization: `Bearer ${VIEWER_TOKEN}` } });
    expect(res.statusCode).toBe(200);
    const r = res.json<Report>();
    expect(r.teamName).toBe('Payments QA');
    expect(r.coverage).toMatchObject({ total: 4, automated: 2, automationRate: 0.5 });
    expect(r.coverageAtPeriodStart).toMatchObject({ automated: 1, automationRate: 0.25 });
    expect(r.projection.weeklyVelocity).toBeCloseTo(1 / (30 / 7), 2);
    expect(r.projection.remainingToGoal).toBe(2);
    expect(r.highlights.casesAdded).toBe(4);
    expect(r.suites[0]).toMatchObject({ suite: '(none)', health: 'unknown' });
    expect(res.body).not.toContain('secret title');
    expect((await t.app.inject({ url: '/api/report?periodDays=12', headers: auth })).statusCode).toBe(400);
  });

  it('newly automated excludes cases that arrived already automated (bootstrap import)', async () => {
    const auth = { authorization: `Bearer ${authEnv().DASHBOARD_TOKEN}` };
    // bootstrap: 3 cases created already automated + 2 backlog cases
    for (let i = 0; i < 5; i++) {
      await t.app.inject({
        method: 'POST',
        url: '/api/test-cases',
        headers: auth,
        payload: { key: `B${i}`, title: `t${i}`, automationStatus: i < 3 ? 'automated' : 'not_automated' },
      });
    }
    let r = (await t.app.inject({ url: '/api/report?periodDays=30', headers: auth })).json<Report>();
    expect(r.highlights).toMatchObject({ newlyAutomated: 0, casesAdded: 5 });

    // a backlog case gets automated later → counts
    const list = (await t.app.inject({ url: '/api/test-cases?search=B3', headers: auth })).json<{ items: Array<{ id: number }> }>();
    await new Promise((res) => setTimeout(res, 5)); // automatedAt must be strictly after createdAt (ms resolution)
    const patch = await t.app.inject({ method: 'PATCH', url: `/api/test-cases/${list.items[0]!.id}`, headers: auth, payload: { automationStatus: 'automated' } });
    expect(patch.statusCode).toBe(200);
    r = (await t.app.inject({ url: '/api/report?periodDays=30', headers: auth })).json<Report>();
    expect(r.highlights.newlyAutomated).toBe(1);
  });
});
