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
  // the source code defines the scope once it has been scanned; nothing else adds to it
  const routes = routeCoverage(db);
  if (routes) {
    return {
      unit: 'routes',
      total: routes.total,
      automated: routes.automated,
      inProgress: routes.inProgress,
      notAutomated: routes.total - routes.automated - routes.inProgress,
      notAutomatable: 0,
      inOpenPr: routes.inProgress,
      automationRate: automationRate(routes.total, routes.automated, 0),
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
