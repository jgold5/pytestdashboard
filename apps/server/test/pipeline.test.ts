import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AutomationStatus, PipelineStage } from '@ptd/shared';
import { pullRequests, runs, testCasePullRequests, testCases, testResults } from '../src/db/schema.js';
import {
  derivePipelineStage,
  isReadyToMerge,
  pipelineStagesForCases,
  type PrForStage,
  type StageInput,
} from '../src/domain/pipeline.js';
import { createTestApp, type TestApp } from './helpers/app.js';

const M = '2026-10-20T12:00:00.000Z'; // merge time
const BEFORE = '2026-10-10T00:00:00.000Z';
const AFTER = '2026-10-25T00:00:00.000Z';

const pr = (o: Partial<PrForStage>): PrForStage => ({
  state: 'open',
  reviewState: 'review_required',
  checks: 'passing',
  unresolvedThreads: 0,
  mergedAt: null,
  ...o,
});
const READY = pr({ reviewState: 'approved' });
const REVIEW = pr({});
const DRAFT = pr({ state: 'draft', reviewState: 'approved' }); // a draft is never "ready"
const MERGED = pr({ state: 'merged', reviewState: 'approved', mergedAt: M });
const CLOSED = pr({ state: 'closed', reviewState: 'approved' });

const stage = (o: Partial<StageInput>): PipelineStage =>
  derivePipelineStage({ automationStatus: 'not_automated', automatedAt: null, prs: [], lastExecutedAt: null, ...o });

describe('isReadyToMerge', () => {
  it('is exactly: open AND approved AND checks passing|none AND 0 unresolved threads', () => {
    const states = ['open', 'draft', 'merged', 'closed'] as const;
    const reviews = ['review_required', 'changes_requested', 'approved', 'none'] as const;
    const checks = ['passing', 'failing', 'pending', 'none'] as const;
    let ready = 0;
    for (const state of states)
      for (const reviewState of reviews)
        for (const c of checks)
          for (const unresolvedThreads of [0, 1, 3]) {
            const expected =
              state === 'open' && reviewState === 'approved' && (c === 'passing' || c === 'none') && unresolvedThreads === 0;
            expect(isReadyToMerge({ state, reviewState, checks: c, unresolvedThreads }), `${state}/${reviewState}/${c}/${unresolvedThreads}`).toBe(expected);
            if (expected) ready++;
          }
    expect(ready).toBe(2);
  });
});

describe('derivePipelineStage precedence', () => {
  it('base stages from automationStatus with no PRs', () => {
    expect(stage({ automationStatus: 'not_automated' })).toBe('not_started');
    expect(stage({ automationStatus: 'in_progress' })).toBe('in_progress');
    expect(stage({ automationStatus: 'automated', automatedAt: BEFORE })).toBe('automated');
    expect(stage({ automationStatus: 'not_automatable' })).toBe('not_automatable');
  });

  it('not_automatable always wins (open, ready or merged PRs)', () => {
    for (const prs of [[READY], [REVIEW], [DRAFT], [MERGED], [READY, MERGED]]) {
      expect(stage({ automationStatus: 'not_automatable', prs })).toBe('not_automatable');
    }
  });

  it('open PRs: most advanced wins — ready > in review > draft', () => {
    for (const s of ['not_automated', 'in_progress'] as const) {
      expect(stage({ automationStatus: s, prs: [DRAFT] })).toBe('pr_draft');
      expect(stage({ automationStatus: s, prs: [REVIEW] })).toBe('in_review');
      expect(stage({ automationStatus: s, prs: [READY] })).toBe('ready_to_merge');
      expect(stage({ automationStatus: s, prs: [DRAFT, REVIEW] })).toBe('in_review');
      expect(stage({ automationStatus: s, prs: [REVIEW, DRAFT, READY] })).toBe('ready_to_merge');
      expect(stage({ automationStatus: s, prs: [DRAFT, READY] })).toBe('ready_to_merge');
    }
  });

  it('in_review covers every not-ready open PR', () => {
    const notReady = [
      pr({ reviewState: 'review_required' }),
      pr({ reviewState: 'changes_requested' }),
      pr({ reviewState: 'none' }),
      pr({ reviewState: 'approved', unresolvedThreads: 2 }),
      pr({ reviewState: 'approved', checks: 'failing' }),
      pr({ reviewState: 'approved', checks: 'pending' }),
    ];
    for (const p of notReady) expect(stage({ prs: [p] })).toBe('in_review');
    expect(stage({ prs: [pr({ reviewState: 'approved', checks: 'none' })] })).toBe('ready_to_merge');
  });

  it('an open PR beats a merged one for a not-yet-automated case', () => {
    expect(stage({ automationStatus: 'in_progress', prs: [MERGED, DRAFT] })).toBe('pr_draft');
    expect(stage({ automationStatus: 'not_automated', prs: [MERGED, READY] })).toBe('ready_to_merge');
  });

  it('open PRs on an automated case are maintenance (stage stays automated)', () => {
    for (const p of [READY, REVIEW, DRAFT]) {
      expect(stage({ automationStatus: 'automated', automatedAt: BEFORE, prs: [p] })).toBe('automated');
    }
  });

  it('merged_awaiting_run until a passed/failed result in a run after the merge', () => {
    // auto-promoted at merge time
    const promoted = { automationStatus: 'automated' as const, automatedAt: M, prs: [MERGED] };
    expect(stage({ ...promoted, lastExecutedAt: null })).toBe('merged_awaiting_run');
    expect(stage({ ...promoted, lastExecutedAt: BEFORE })).toBe('merged_awaiting_run');
    expect(stage({ ...promoted, lastExecutedAt: M })).toBe('merged_awaiting_run'); // strictly after
    expect(stage({ ...promoted, lastExecutedAt: AFTER })).toBe('automated');
    // never promoted (e.g. promotion skipped) still shows the merge
    expect(stage({ automationStatus: 'not_automated', prs: [MERGED] })).toBe('merged_awaiting_run');
    expect(stage({ automationStatus: 'in_progress', prs: [MERGED], lastExecutedAt: AFTER })).toBe('in_progress');
    // automated long before the merge → maintenance PR, not new automation
    expect(stage({ automationStatus: 'automated', automatedAt: BEFORE, prs: [MERGED] })).toBe('automated');
    expect(stage({ automationStatus: 'automated', automatedAt: null, prs: [MERGED] })).toBe('automated');
    // the latest merge decides
    const older = pr({ state: 'merged', mergedAt: BEFORE });
    expect(stage({ automationStatus: 'automated', automatedAt: M, prs: [older, MERGED], lastExecutedAt: '2026-10-15T00:00:00.000Z' })).toBe(
      'merged_awaiting_run',
    );
  });

  it('closed (unmerged) PRs and merged PRs without mergedAt are ignored', () => {
    expect(stage({ prs: [CLOSED] })).toBe('not_started');
    expect(stage({ automationStatus: 'in_progress', prs: [CLOSED] })).toBe('in_progress');
    expect(stage({ prs: [pr({ state: 'merged', mergedAt: null })] })).toBe('not_started');
  });
});

describe('pipelineStageSql agrees with derivePipelineStage on every combination', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => t.close());

  it('exhaustive grid: 4 statuses × 2^6 PR sets × automatedAt × last executed result', () => {
    const db = t.dbHandle.db;
    const now = new Date().toISOString();
    const PR_KINDS: Array<[string, PrForStage]> = [
      ['draft', DRAFT],
      ['ready', READY],
      ['review', REVIEW],
      ['threads', pr({ reviewState: 'approved', unresolvedThreads: 1 })],
      ['merged', MERGED],
      ['closed', CLOSED],
    ];
    const statuses: AutomationStatus[] = ['not_automated', 'in_progress', 'automated', 'not_automatable'];
    const automatedAts = [null, BEFORE, M];
    // [status of the result, run sortAt] or null = never executed
    const execs: Array<[('passed' | 'failed' | 'broken'), string] | null> = [
      null,
      ['passed', BEFORE],
      ['passed', AFTER],
      ['failed', AFTER],
      ['broken', AFTER],
    ];
    const runIds = new Map<string, number>();
    for (const at of [BEFORE, AFTER]) {
      const r = db.insert(runs).values({ name: at, importedAt: at, sortAt: at, startedAt: at }).returning({ id: runs.id }).get();
      runIds.set(at, r.id);
    }
    const expected = new Map<number, PipelineStage>();
    let prNo = 0;
    let n = 0;
    db.transaction((tx) => {
      for (const status of statuses)
        for (let mask = 0; mask < 1 << PR_KINDS.length; mask++)
          for (const automatedAt of automatedAts)
            for (const exec of execs) {
              n++;
              const c = tx
                .insert(testCases)
                .values({ key: `c${n}`, title: 't', automationStatus: status, automatedAt, createdAt: now, updatedAt: now })
                .returning({ id: testCases.id })
                .get();
              const prs: PrForStage[] = [];
              PR_KINDS.forEach(([, p], i) => {
                if (!(mask & (1 << i))) return;
                prs.push(p);
                const row = tx
                  .insert(pullRequests)
                  .values({
                    repo: 'acme/grid',
                    number: ++prNo,
                    title: 'x',
                    url: 'https://github.com/acme/grid/pull/1',
                    state: p.state,
                    reviewState: p.reviewState,
                    checks: p.checks,
                    unresolvedThreads: p.unresolvedThreads,
                    mergedAt: p.mergedAt,
                    createdAt: now,
                    updatedAt: now,
                  })
                  .returning({ id: pullRequests.id })
                  .get();
                tx.insert(testCasePullRequests).values({ testCaseId: c.id, pullRequestId: row.id, linkedBy: 'key_in_title' }).run();
              });
              let lastExecutedAt: string | null = null;
              if (exec) {
                tx.insert(testResults).values({ runId: runIds.get(exec[1])!, testCaseId: c.id, name: 't', status: exec[0] }).run();
                if (exec[0] !== 'broken') lastExecutedAt = exec[1];
              }
              expected.set(c.id, derivePipelineStage({ automationStatus: status, automatedAt, prs, lastExecutedAt }));
            }
    });
    expect(n).toBe(4 * 64 * 3 * 5);
    const actual = pipelineStagesForCases(db, [...expected.keys()]);
    const mismatches = [...expected].filter(([id, s]) => actual.get(id) !== s);
    expect(mismatches).toEqual([]);
    // every stage is reachable
    expect(new Set(expected.values())).toEqual(
      new Set(['not_started', 'in_progress', 'pr_draft', 'in_review', 'ready_to_merge', 'merged_awaiting_run', 'automated', 'not_automatable']),
    );
  });
});

describe('pipeline counts in Summary / Report and the test-case filter', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => t.close());

  it('counts every stage, filters by stage and projects the rate once ready PRs merge', async () => {
    const mk = async (key: string, automationStatus: AutomationStatus) =>
      (await t.app.inject({ method: 'POST', url: '/api/test-cases', payload: { key, title: key, jiraKey: key, automationStatus } })).json<{
        id: number;
      }>();
    for (let i = 1; i <= 6; i++) await mk(`AUT-${i}`, 'automated');
    await mk('RDY-1', 'not_automated');
    await mk('RDY-2', 'in_progress');
    await mk('REV-1', 'not_automated');
    await mk('DRF-1', 'in_progress');
    await mk('NEW-1', 'not_automated');
    await mk('MAN-1', 'not_automatable');
    const { replaceRepoPullRequests } = await import('../src/domain/pullRequests.js');
    const { testCases: tc } = await import('../src/db/schema.js');
    const ids = new Map(t.dbHandle.db.select({ id: tc.id, key: tc.key }).from(tc).all().map((r) => [r.key, r.id]));
    const now = new Date().toISOString();
    const base = { url: 'https://github.com/acme/routes/pull/1', author: 'dev', headBranch: 'b', requestedReviewers: [], createdAt: now, updatedAt: now, mergedAt: null };
    const res = replaceRepoPullRequests(
      t.dbHandle.db,
      'acme/routes',
      [
        { ...base, number: 1, title: 'ready', state: 'open', reviewState: 'approved', unresolvedThreads: 0, checks: 'passing', approvedAt: now },
        { ...base, number: 2, title: 'review', state: 'open', reviewState: 'changes_requested', unresolvedThreads: 2, checks: 'passing' },
        { ...base, number: 3, title: 'draft', state: 'draft', reviewState: 'none', unresolvedThreads: 0, checks: 'pending' },
      ],
      [
        { prNumber: 1, testCaseId: ids.get('RDY-1')!, linkedBy: 'key_in_title' },
        { prNumber: 1, testCaseId: ids.get('RDY-2')!, linkedBy: 'key_in_title' },
        { prNumber: 1, testCaseId: ids.get('MAN-1')!, linkedBy: 'key_in_title' },
        { prNumber: 2, testCaseId: ids.get('REV-1')!, linkedBy: 'key_in_title' },
        { prNumber: 2, testCaseId: ids.get('RDY-2')!, linkedBy: 'key_in_title' },
        { prNumber: 3, testCaseId: ids.get('DRF-1')!, linkedBy: 'key_in_title' },
      ],
    );
    expect(res).toEqual({ linked: 6, promoted: 0 });

    const summary = (await t.app.inject({ url: '/api/summary' })).json<{ pipeline: Record<string, number>; prPipeline: { readyToMerge: number } }>();
    expect(summary.pipeline).toEqual({
      not_started: 1,
      in_progress: 0,
      pr_draft: 1,
      in_review: 1,
      ready_to_merge: 2,
      merged_awaiting_run: 0,
      automated: 6,
      not_automatable: 1,
    });
    expect(summary.prPipeline.readyToMerge).toBe(1);

    const list = (await t.app.inject({ url: '/api/test-cases?pipelineStage=ready_to_merge' })).json<{ items: Array<{ key: string; pipelineStage: string }> }>();
    expect(list.items.map((c) => c.key)).toEqual(['RDY-1', 'RDY-2']);
    expect((await t.app.inject({ url: '/api/test-cases?pipelineStage=bogus' })).statusCode).toBe(400);

    const report = (await t.app.inject({ url: '/api/report?periodDays=30' })).json<{
      coverage: { automationRate: number };
      automationInFlight: { projectedAutomated: number; projectedAutomationRate: number; stages: Record<string, number> };
    }>();
    expect(report.coverage.automationRate).toBeCloseTo(6 / 11);
    expect(report.automationInFlight).toMatchObject({ projectedAutomated: 8, stages: { ready_to_merge: 2, in_review: 1 } });
    expect(report.automationInFlight.projectedAutomationRate).toBeCloseTo(8 / 11);

    const csv = (await t.app.inject({ url: '/api/test-cases/export.csv?pipelineStage=pr_draft' })).body;
    expect(csv).toContain('"pipelineStage"');
    expect(csv).toContain('"DRF-1"');
    expect(csv).not.toContain('"RDY-1"');
  });
});
