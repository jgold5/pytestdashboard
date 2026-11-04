import { and, asc, desc, eq, gt, gte, inArray, isNotNull, sql } from 'drizzle-orm';
import type { Summary, TriageCategory } from '@ptd/shared';
import type { Db } from '../db/client.js';
import { coverageSnapshots, runs, testCases } from '../db/schema.js';
import { addDays, isoDate } from '../util/time.js';
import { computeCoverage } from './coverage.js';
import { coveredByOpenBug } from './bugs.js';
import { computePrPipeline } from './pullRequests.js';
import { serializeRun } from './runs.js';

const failing = inArray(testCases.lastStatus, ['failed', 'broken']);

/** Cases failing now with no triage, or whose newest triage predates the failing run's import. */
export function countUntriagedFailures(db: Db): number {
  return (
    db
      .select({ n: sql<number>`count(*)` })
      .from(testCases)
      .leftJoin(runs, eq(runs.id, testCases.lastRunId))
      .where(
        and(
          failing,
          sql`(${testCases.triage} IS NULL OR ${testCases.triageAt} < ${runs.importedAt})`,
          sql`NOT ${coveredByOpenBug()}`,
        ),
      )
      .get()?.n ?? 0
  );
}

export function triageBreakdown(db: Db): Summary['triageBreakdown'] {
  return db
    .select({ triage: testCases.triage, count: sql<number>`count(*)` })
    .from(testCases)
    .where(and(failing, isNotNull(testCases.triage)))
    .groupBy(testCases.triage)
    .orderBy(desc(sql`count(*)`))
    .all()
    .map((r) => ({ triage: r.triage as TriageCategory, count: r.count }));
}

export function bySuite(db: Db): Summary['bySuite'] {
  return db
    .select({
      suite: sql<string>`coalesce(${testCases.suite}, '(none)')`,
      total: sql<number>`count(*)`,
      automated: sql<number>`sum(${testCases.automationStatus} = 'automated')`,
      inProgress: sql<number>`sum(${testCases.automationStatus} = 'in_progress')`,
      notAutomatable: sql<number>`sum(${testCases.automationStatus} = 'not_automatable')`,
      passing: sql<number>`sum(${testCases.lastStatus} = 'passed')`,
      failing: sql<number>`sum(${testCases.lastStatus} IN ('failed', 'broken'))`,
    })
    .from(testCases)
    .groupBy(sql`coalesce(${testCases.suite}, '(none)')`)
    .orderBy(sql`coalesce(${testCases.suite}, '(none)')`)
    .all()
    .map((r) => ({
      suite: r.suite,
      total: r.total,
      automated: r.automated ?? 0,
      inProgress: r.inProgress ?? 0,
      notAutomatable: r.notAutomatable ?? 0,
      passing: r.passing ?? 0,
      failing: r.failing ?? 0,
    }));
}

export function coverageTrend(db: Db, sinceDate: string): Summary['coverageTrend'] {
  return db
    .select({ date: coverageSnapshots.date, total: coverageSnapshots.total, automated: coverageSnapshots.automated })
    .from(coverageSnapshots)
    .where(gte(coverageSnapshots.date, sinceDate))
    .orderBy(asc(coverageSnapshots.date))
    .all();
}

const TREND_RUNS_PER_GROUP = 30;
const TREND_MAX_GROUPS = 12;

export function getSummary(db: Db): Summary {
  const latest = db.select().from(runs).orderBy(desc(runs.sortAt), desc(runs.id)).limit(1).get();
  // Last 30 runs *per run group* (the UI shows one group at a time; a global
  // "last 30" left only a handful of bars per group). Most recently active
  // groups first, capped so auto-derived groups can't blow up the payload.
  const groups = db
    .select({ g: runs.runGroup, last: sql<string>`max(${runs.sortAt})` })
    .from(runs)
    .groupBy(runs.runGroup)
    .orderBy(desc(sql`max(${runs.sortAt})`))
    .limit(TREND_MAX_GROUPS)
    .all();
  const runTrend = groups
    .flatMap(({ g }) =>
      db
        .select()
        .from(runs)
        .where(eq(runs.runGroup, g))
        .orderBy(desc(runs.sortAt), desc(runs.id))
        .limit(TREND_RUNS_PER_GROUP)
        .all(),
    )
    .sort((a, b) => a.sortAt.localeCompare(b.sortAt) || a.id - b.id)
    .map((r) => {
      const s = serializeRun(r);
      return {
        id: s.id,
        name: s.name,
        runGroup: s.runGroup,
        branch: s.branch,
        startedAt: s.startedAt,
        importedAt: s.importedAt,
        counts: s.counts,
        passRate: s.passRate,
        changes: s.changes,
      };
    });
  const topFlaky = db
    .select({ id: testCases.id, key: testCases.key, title: testCases.title, flakiness: testCases.flakiness })
    .from(testCases)
    .where(gt(testCases.flakiness, 0))
    .orderBy(desc(testCases.flakiness), asc(testCases.key))
    .limit(10)
    .all();
  const byOwner = db
    .select({
      owner: sql<string>`${testCases.owner}`,
      total: sql<number>`count(*)`,
      automated: sql<number>`sum(${testCases.automationStatus} = 'automated')`,
      notAutomatable: sql<number>`sum(${testCases.automationStatus} = 'not_automatable')`,
    })
    .from(testCases)
    .where(isNotNull(testCases.owner))
    .groupBy(testCases.owner)
    .orderBy(desc(sql`count(*)`), asc(testCases.owner))
    .all()
    .map((r) => ({ ...r, automated: r.automated ?? 0, notAutomatable: r.notAutomatable ?? 0 }));

  return {
    coverage: computeCoverage(db),
    coverageTrend: coverageTrend(db, isoDate(addDays(new Date(), -180))),
    latestRun: latest ? serializeRun(latest) : null,
    runTrend,
    bySuite: bySuite(db),
    untriagedFailures: countUntriagedFailures(db),
    triageBreakdown: triageBreakdown(db),
    topFlaky,
    byOwner,
    prPipeline: computePrPipeline(db),
  };
}
