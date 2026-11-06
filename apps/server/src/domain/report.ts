/**
 * Management report: aggregates only — never note text, messages, traces or
 * author names (viewers can read this).
 */
import { and, asc, desc, eq, gte, inArray, isNotNull, lt, lte, sql } from 'drizzle-orm';
import type { CoverageTotals, Report, Settings } from '@ptd/shared';
import type { Db } from '../db/client.js';
import { coverageSnapshots, notes, pullRequests, runs, testCasePullRequests, testCases, type RunRow } from '../db/schema.js';
import { addDays, isoDate } from '../util/time.js';
import { automationRate, computeCoverage } from './coverage.js';
import { FLAKY_THRESHOLD } from './flakiness.js';
import { computePrPipeline } from './pullRequests.js';
import { computePipelineCounts, countProjectedAutomated } from './pipeline.js';
import { passRate } from './runs.js';
import { getSettings } from './settings.js';
import { bugTrend, computeVerifications, meanDaysToResolve, openBySeverity } from './bugs.js';
import { bugs } from '../db/schema.js';
import { bySuite, countUntriagedFailures, coverageTrend } from './summary.js';

type Goal = Settings['goal'];
type Projection = Report['projection'];

const DAY = 86_400_000;

export function computeProjection(args: {
  coverage: Pick<CoverageTotals, 'total' | 'automated' | 'notAutomatable'>;
  automatedAtStart: number;
  periodDays: number;
  goal: Goal;
  today: Date;
}): Projection {
  const { coverage, automatedAtStart, periodDays, goal, today } = args;
  const weeklyVelocity = Math.round(((coverage.automated - automatedAtStart) / (periodDays / 7)) * 100) / 100;
  if (!goal) return { weeklyVelocity, remainingToGoal: null, projectedGoalDate: null, status: null };

  const remaining = Math.max(
    0,
    Math.ceil(goal.targetRate * (coverage.total - coverage.notAutomatable) - 1e-9) - coverage.automated,
  );
  let projected: Date | null = null;
  if (remaining === 0) projected = today;
  else if (weeklyVelocity > 0) projected = new Date(today.getTime() + (remaining / weeklyVelocity) * 7 * DAY);

  const target = new Date(`${goal.targetDate}T00:00:00.000Z`).getTime();
  let status: Projection['status'];
  if (projected === null) status = 'behind';
  else {
    const p = Date.UTC(projected.getUTCFullYear(), projected.getUTCMonth(), projected.getUTCDate());
    if (p <= target - 14 * DAY) status = 'ahead';
    else if (p <= target) status = 'on_track';
    else if (p <= target + 30 * DAY) status = 'at_risk';
    else status = 'behind';
  }
  return {
    weeklyVelocity,
    remainingToGoal: remaining,
    projectedGoalDate: projected ? isoDate(projected) : null,
    status,
  };
}

function avg(values: Array<number | null>): number | null {
  const v = values.filter((x): x is number => x !== null);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

/** Monday (UTC) of the week containing d. */
function weekStart(d: Date): Date {
  const day = (d.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day));
}

function pooledPassRate(rs: RunRow[]): number | null {
  let passed = 0;
  let executed = 0;
  for (const r of rs) {
    passed += r.passed;
    executed += r.total - r.skipped;
  }
  return executed > 0 ? passed / executed : null;
}

export function getReport(db: Db, periodDays: number, today: Date = new Date(), branch?: string, folder?: string): Report {
  const settings = getSettings(db);
  const startDate = addDays(today, -periodDays);
  const startIso = startDate.toISOString();
  const startDay = isoDate(startDate);
  const prevStartIso = addDays(today, -2 * periodDays).toISOString();
  const coverage = computeCoverage(db, branch, folder);

  // coverage at period start: latest snapshot on/before start, else earliest one after it
  const startSnap =
    db
      .select()
      .from(coverageSnapshots)
      .where(lte(coverageSnapshots.date, startDay))
      .orderBy(desc(coverageSnapshots.date))
      .limit(1)
      .get() ??
    db.select().from(coverageSnapshots).orderBy(asc(coverageSnapshots.date)).limit(1).get();
  const atStart = startSnap
    ? {
        total: startSnap.total,
        automated: startSnap.automated,
        automationRate: automationRate(startSnap.total, startSnap.automated, startSnap.notAutomatable),
      }
    : { total: coverage.total, automated: coverage.automated, automationRate: coverage.automationRate };

  const projection = computeProjection({
    coverage,
    automatedAtStart: atStart.automated,
    periodDays,
    goal: settings.goal,
    today,
  });

  // --- quality -------------------------------------------------------------
  const periodRuns = db.select().from(runs).where(gte(runs.sortAt, startIso)).orderBy(asc(runs.sortAt)).all();
  const prevRuns = db
    .select()
    .from(runs)
    .where(and(gte(runs.sortAt, prevStartIso), lt(runs.sortAt, startIso)))
    .all();
  const latestRun = db.select().from(runs).orderBy(desc(runs.sortAt), desc(runs.id)).limit(1).get();

  const weekly: Report['quality']['weeklyPassRate'] = [];
  for (let w = weekStart(startDate); w.getTime() <= today.getTime(); w = addDays(w, 7)) {
    const from = w.toISOString();
    const to = addDays(w, 7).toISOString();
    const inWeek = periodRuns.filter((r) => r.sortAt >= from && r.sortAt < to);
    weekly.push({ weekStart: isoDate(w), passRate: pooledPassRate(inWeek), runs: inWeek.length });
  }

  const groups = db
    .select({ g: runs.runGroup, lastRunAt: sql<string>`max(${runs.sortAt})` })
    .from(runs)
    .groupBy(runs.runGroup)
    .orderBy(desc(sql`max(${runs.sortAt})`))
    .all();
  const byRunGroup = groups.map(({ g, lastRunAt }) => {
    const latestInGroup = db
      .select()
      .from(runs)
      .where(eq(runs.runGroup, g))
      .orderBy(desc(runs.sortAt), desc(runs.id))
      .limit(1)
      .get();
    const inPeriod = periodRuns.filter((r) => r.runGroup === g);
    return {
      runGroup: g,
      latestPassRate: latestInGroup ? passRate(latestInGroup) : null,
      periodAvgPassRate: avg(inPeriod.map((r) => passRate(r))),
      runsInPeriod: inPeriod.length,
      lastRunAt: lastRunAt ?? null,
    };
  });

  // --- suites ----------------------------------------------------------------
  const goalRate = settings.goal?.targetRate ?? 0.8;
  const healthRank = { red: 0, amber: 1, unknown: 2, green: 3 } as const;
  const suites = bySuite(db)
    .map((s) => {
      const rate = automationRate(s.total, s.automated, s.notAutomatable);
      const executed = s.passing + s.failing;
      const lastPassRate = executed > 0 ? s.passing / executed : null;
      let health: 'green' | 'amber' | 'red' | 'unknown';
      if (lastPassRate === null) health = 'unknown';
      else if ((rate ?? 0) >= goalRate && lastPassRate >= 0.95) health = 'green';
      else if (lastPassRate >= 0.85) health = 'amber';
      else health = 'red';
      return { suite: s.suite, total: s.total, automated: s.automated, automatable: s.total - s.notAutomatable, automationRate: rate, lastPassRate, health };
    })
    .sort(
      (a, b) =>
        healthRank[a.health] - healthRank[b.health] ||
        (a.automationRate ?? 0) - (b.automationRate ?? 0) ||
        a.suite.localeCompare(b.suite),
    );

  // --- highlights / risks ------------------------------------------------------
  const firstImportAt = db.select({ v: sql<string | null>`min(${runs.importedAt})` }).from(runs).get()?.v ?? null;
  const count = (q: { get(): { n: number } | undefined }) => q.get()?.n ?? 0;
  const linked = sql`EXISTS (SELECT 1 FROM ${testCasePullRequests} WHERE ${testCasePullRequests.pullRequestId} = ${pullRequests.id})`;
  const prPipeline = computePrPipeline(db);
  const failingNow = inArray(testCases.lastStatus, ['failed', 'broken']);
  const allBugs = db.select().from(bugs).all();
  const bugVer = computeVerifications(db, allBugs);
  const bySev = openBySeverity(db);

  return {
    generatedAt: today.toISOString(),
    periodDays,
    teamName: settings.teamName,
    coverage,
    coverageAtPeriodStart: atStart,
    coverageTrend: coverageTrend(db, startDay),
    goal: settings.goal,
    projection,
    quality: {
      latestPassRate: latestRun ? passRate(latestRun) : null,
      periodAvgPassRate: avg(periodRuns.map((r) => passRate(r))),
      previousPeriodAvgPassRate: avg(prevRuns.map((r) => passRate(r))),
      runsInPeriod: periodRuns.length,
      weeklyPassRate: weekly,
      byRunGroup,
    },
    suites,
    highlights: {
      newlyAutomated: count(
        db
          .select({ n: sql<number>`count(*)` })
          .from(testCases)
          .where(
            and(
              eq(testCases.automationStatus, 'automated'),
              gte(testCases.automatedAt, startIso),
              // Only real progress: a tracked case that *became* automated, or a new test
              // discovered by a later allure import. Cases that arrived already automated
              // (spreadsheet/Jira bootstrap, manual create, the very first allure import)
              // are counted in casesAdded instead.
              firstImportAt === null
                ? sql`${testCases.automatedAt} > ${testCases.createdAt}`
                : sql`(${testCases.automatedAt} > ${testCases.createdAt} OR (${testCases.source} = 'allure' AND ${testCases.createdAt} > ${firstImportAt}))`,
            ),
          ),
      ),
      casesAdded: count(db.select({ n: sql<number>`count(*)` }).from(testCases).where(gte(testCases.createdAt, startIso))),
      prsMerged: count(
        db
          .select({ n: sql<number>`count(*)` })
          .from(pullRequests)
          .where(
            and(
              eq(pullRequests.state, 'merged'),
              sql`coalesce(${pullRequests.mergedAt}, ${pullRequests.updatedAt}) >= ${startIso}`,
              linked,
            ),
          ),
      ),
      failuresTriaged: count(
        db
          .select({ n: sql<number>`count(*)` })
          .from(notes)
          .where(and(isNotNull(notes.triage), gte(notes.createdAt, startIso))),
      ),
      bugsFoundByAutomation: allBugs.filter((b) => b.foundByAutomation && b.createdAt >= startIso).length,
      bugsResolved: allBugs.filter((b) => b.resolvedAt !== null && b.resolvedAt >= startIso).length,
      bugsVerifiedFixed: allBugs.filter((b) => {
        const v = bugVer.get(b.id);
        return v?.verification === 'verified_fixed' && (v.verifiedAt ?? '') >= startIso;
      }).length,
    },
    risks: {
      untriagedFailures: countUntriagedFailures(db),
      flakyTests: count(
        db.select({ n: sql<number>`count(*)` }).from(testCases).where(gte(testCases.flakiness, FLAKY_THRESHOLD)),
      ),
      productBugsOpen: count(
        db
          .select({ n: sql<number>`count(*)` })
          .from(testCases)
          .where(and(eq(testCases.triage, 'product_bug'), failingNow)),
      ),
      prsNeedingAttention: prPipeline.needsAttention,
      openBugs: allBugs.filter((b) => b.status === 'open' || b.status === 'in_progress').length,
      openCriticalBugs: allBugs.filter((b) => (b.status === 'open' || b.status === 'in_progress') && b.severity === 'critical')
        .length,
      stillFailingAfterFix: allBugs.filter((b) => bugVer.get(b.id)?.verification === 'still_failing').length,
    },
    bugs: {
      bySeverity: bySev,
      trend: bugTrend(db, startDate, today),
      meanDaysToResolve: meanDaysToResolve(db, today),
    },
    prPipeline,
    automationInFlight: (() => {
      // routes: what tests on PR branches already cover lands with those PRs
      const projectedAutomated =
        coverage.unit === 'routes' ? coverage.automated + coverage.inProgress : countProjectedAutomated(db);
      return {
        stages: computePipelineCounts(db),
        projectedAutomated,
        projectedAutomationRate: automationRate(coverage.total, projectedAutomated, coverage.notAutomatable),
      };
    })(),
  };
}
