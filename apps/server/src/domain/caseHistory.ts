import { desc, eq } from 'drizzle-orm';
import type { ResultStatus, TestCaseDetail } from '@ptd/shared';
import type { Db } from '../db/client.js';
import { runs, testResults } from '../db/schema.js';
import { isFailing, worse } from './history.js';

type Stats = TestCaseDetail['stats'];
type RunRef = { runId: number; runName: string; at: string };

const HISTORY_LIMIT = 100;
const WINDOW = 30;

interface PerRun extends RunRef {
  runGroup: string;
  status: ResultStatus;
  durationMs: number | null;
}

/** History (newest first, ≤100) + streak/pass-rate/duration stats for one case. */
export function caseHistory(db: Db, caseId: number): Pick<TestCaseDetail, 'history' | 'stats'> {
  const rows = db
    .select({
      id: testResults.id,
      runId: testResults.runId,
      status: testResults.status,
      durationMs: testResults.durationMs,
      startedAt: testResults.startedAt,
      message: testResults.message,
      failureSignature: testResults.failureSignature,
      change: testResults.change,
      runName: runs.name,
      runGroup: runs.runGroup,
      branch: runs.branch,
      sortAt: runs.sortAt,
    })
    .from(testResults)
    .innerJoin(runs, eq(runs.id, testResults.runId))
    .where(eq(testResults.testCaseId, caseId))
    .orderBy(desc(runs.sortAt), desc(runs.id), desc(testResults.id))
    .all();

  const history = rows.slice(0, HISTORY_LIMIT).map(({ sortAt: _sortAt, ...r }) => r);
  return { history, stats: computeStats(rows) };
}

export function computeStats(
  rowsNewestFirst: ReadonlyArray<{
    runId: number;
    runName: string;
    sortAt: string;
    runGroup: string;
    status: ResultStatus;
    durationMs: number | null;
  }>,
): Stats {
  // collapse to one entry per run (worst status, max duration)
  const perRun: PerRun[] = [];
  for (const r of rowsNewestFirst) {
    const last = perRun[perRun.length - 1];
    if (last && last.runId === r.runId) {
      last.status = worse(last.status, r.status);
      if (r.durationMs !== null) last.durationMs = Math.max(last.durationMs ?? 0, r.durationMs);
      continue;
    }
    perRun.push({
      runId: r.runId,
      runName: r.runName,
      at: r.sortAt,
      runGroup: r.runGroup,
      status: r.status,
      durationMs: r.durationMs,
    });
  }
  const executed = perRun.filter((r) => r.status === 'passed' || isFailing(r.status));
  const ref = (r: PerRun): RunRef => ({ runId: r.runId, runName: r.runName, at: r.at });

  // failing streak within the group of the most recent execution
  let consecutiveFailures = 0;
  let failingSince: RunRef | null = null;
  const latest = executed[0];
  if (latest && isFailing(latest.status)) {
    for (const r of executed) {
      if (r.runGroup !== latest.runGroup) continue;
      if (!isFailing(r.status)) break;
      consecutiveFailures++;
      failingSince = ref(r);
    }
  }

  const lastPassedRun = executed.find((r) => r.status === 'passed');
  const window = executed.slice(0, WINDOW);
  const passRate = window.length ? window.filter((r) => r.status === 'passed').length / window.length : null;

  const passedDurations = executed
    .filter((r) => r.status === 'passed' && r.durationMs !== null)
    .map((r) => r.durationMs as number);
  const recent = passedDurations.slice(0, WINDOW);
  const avgDurationMs = recent.length ? Math.round(recent.reduce((a, b) => a + b, 0) / recent.length) : null;
  let durationRatio: number | null = null;
  const prior = passedDurations.slice(1, WINDOW + 1);
  const latestDuration = passedDurations[0];
  if (latestDuration !== undefined && prior.length >= 3) {
    const priorAvg = prior.reduce((a, b) => a + b, 0) / prior.length;
    if (priorAvg > 0) durationRatio = Math.round((latestDuration / priorAvg) * 100) / 100;
  }

  return {
    failingSince,
    consecutiveFailures,
    lastPassed: lastPassedRun ? ref(lastPassedRun) : null,
    passRate,
    executions: rowsNewestFirst.length,
    avgDurationMs,
    durationRatio,
  };
}
