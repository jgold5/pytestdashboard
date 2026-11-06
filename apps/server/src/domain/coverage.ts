import { and, eq, inArray, sql } from 'drizzle-orm';
import type { CoverageTotals } from '@ptd/shared';
import type { Db } from '../db/client.js';
import { coverageSnapshots, pullRequests, testCasePullRequests, testCases } from '../db/schema.js';
import { routeCoverage } from '../triggers/routeCoverage.js';
import { isoDate } from '../util/time.js';

export function automationRate(total: number, automated: number, notAutomatable: number): number | null {
  const denom = total - notAutomatable;
  return denom > 0 ? automated / denom : null;
}

export function computeCoverage(db: Db): CoverageTotals {
  // the source code defines the scope once it has been scanned; nothing else adds to it.
  // A trigger counts as tested when a test covers it on any scanned branch, merged or not.
  const routes = routeCoverage(db);
  if (routes) {
    const tested = routes.automated + routes.inProgress;
    return {
      unit: 'routes',
      total: routes.total,
      automated: tested,
      inProgress: 0,
      notAutomated: routes.total - tested,
      notAutomatable: 0,
      inOpenPr: 0,
      automationRate: automationRate(routes.total, tested, 0),
      unmerged: routes.inProgress,
    };
  }
  const rows = db
    .select({ status: testCases.automationStatus, n: sql<number>`count(*)` })
    .from(testCases)
    .groupBy(testCases.automationStatus)
    .all();
  const by = (s: string) => rows.find((r) => r.status === s)?.n ?? 0;
  const automated = by('automated');
  const inProgress = by('in_progress');
  const notAutomated = by('not_automated');
  const notAutomatable = by('not_automatable');
  const total = automated + inProgress + notAutomated + notAutomatable;

  const inOpenPr =
    db
      .select({ n: sql<number>`count(distinct ${testCases.id})` })
      .from(testCases)
      .innerJoin(testCasePullRequests, eq(testCasePullRequests.testCaseId, testCases.id))
      .innerJoin(pullRequests, eq(pullRequests.id, testCasePullRequests.pullRequestId))
      .where(
        and(
          inArray(testCases.automationStatus, ['in_progress', 'not_automated']),
          inArray(pullRequests.state, ['open', 'draft']),
        ),
      )
      .get()?.n ?? 0;

  return {
    unit: 'cases',
    total,
    automated,
    inProgress,
    notAutomated,
    notAutomatable,
    inOpenPr,
    automationRate: automationRate(total, automated, notAutomatable),
  };
}

/** Upsert today's (UTC) coverage snapshot. Call after any mutation that may change counts. */
export function recordCoverageSnapshot(db: Db, date: string = isoDate()): void {
  const c = computeCoverage(db);
  const values = {
    date,
    total: c.total,
    automated: c.automated,
    inProgress: c.inProgress,
    notAutomatable: c.notAutomatable,
  };
  db.insert(coverageSnapshots)
    .values(values)
    .onConflictDoUpdate({ target: coverageSnapshots.date, set: values })
    .run();
}
