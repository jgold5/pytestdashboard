/**
 * Run history: baselines (previousRunId), change tagging, compare and the
 * tests × runs matrix. Baselines never cross (runGroup, branch).
 */
import { and, asc, desc, eq, inArray, isNull, lt, gt, or, sql, type SQL } from 'drizzle-orm';
import type {
  HistoryMatrix,
  HistoryMatrixQuery,
  ResultChange,
  ResultStatus,
  RunCompareEntry,
  RunComparison,
} from '@ptd/shared';
import type { Db } from '../db/client.js';
import { runs, testCases, testResults, type RunRow } from '../db/schema.js';
import { badRequest } from '../errors.js';
import { containsPattern } from '../util/sql.js';
import { getRunRow, passRate, serializeRun } from './runs.js';

export const isFailing = (s: ResultStatus | null | undefined): boolean => s === 'failed' || s === 'broken';

const SEVERITY: Record<ResultStatus, number> = { broken: 0, failed: 1, passed: 2, unknown: 3, skipped: 4 };
/** When a case has several results in a run (parametrized), its "worst" one represents it. */
export function worse(a: ResultStatus, b: ResultStatus): ResultStatus {
  return SEVERITY[a] <= SEVERITY[b] ? a : b;
}

export function classifyChange(current: ResultStatus, previous: ResultStatus | undefined): ResultChange {
  if (previous === undefined) return 'new_test';
  if (isFailing(current)) return isFailing(previous) ? 'still_failing' : 'new_failure';
  if (current === 'passed') {
    if (isFailing(previous)) return 'fixed';
    if (previous === 'passed') return 'stable_pass';
  }
  return 'other';
}

type RunKey = Pick<RunRow, 'id' | 'runGroup' | 'branch' | 'sortAt'>;

const sameLine = (r: Pick<RunRow, 'runGroup' | 'branch'>): SQL => {
  const branch = r.branch === null ? isNull(runs.branch) : eq(runs.branch, r.branch);
  const cond = and(eq(runs.runGroup, r.runGroup), branch);
  if (!cond) throw new Error('unreachable');
  return cond;
};

export function findPreviousRun(db: Db, r: RunKey): number | null {
  const before = or(lt(runs.sortAt, r.sortAt), and(eq(runs.sortAt, r.sortAt), lt(runs.id, r.id)));
  return (
    db
      .select({ id: runs.id })
      .from(runs)
      .where(and(sameLine(r), before))
      .orderBy(desc(runs.sortAt), desc(runs.id))
      .limit(1)
      .get()?.id ?? null
  );
}

export function findNextRun(db: Db, r: RunKey): number | null {
  const after = or(gt(runs.sortAt, r.sortAt), and(eq(runs.sortAt, r.sortAt), gt(runs.id, r.id)));
  return (
    db
      .select({ id: runs.id })
      .from(runs)
      .where(and(sameLine(r), after))
      .orderBy(asc(runs.sortAt), asc(runs.id))
      .limit(1)
      .get()?.id ?? null
  );
}

/** Worst status per test case in a run. */
function caseStatuses(db: Db, runId: number): Map<number, ResultStatus> {
  const map = new Map<number, ResultStatus>();
  for (const r of db
    .select({ caseId: testResults.testCaseId, status: testResults.status })
    .from(testResults)
    .where(eq(testResults.runId, runId))
    .all()) {
    const prev = map.get(r.caseId);
    map.set(r.caseId, prev ? worse(prev, r.status) : r.status);
  }
  return map;
}

/** (Re)compute previousRunId, every result's `change` and the run's change counts. */
export function linkRun(db: Db, runId: number): void {
  const run = getRunRow(db, runId);
  const previousRunId = findPreviousRun(db, run);
  const prev = previousRunId !== null ? caseStatuses(db, previousRunId) : new Map<number, ResultStatus>();

  const results = db
    .select({ id: testResults.id, caseId: testResults.testCaseId, status: testResults.status, change: testResults.change })
    .from(testResults)
    .where(eq(testResults.runId, runId))
    .all();

  const byChange = new Map<ResultChange, number[]>();
  const counts = { newFailures: 0, stillFailing: 0, fixed: 0, newTests: 0, missing: 0 };
  const seen = new Set<number>();
  for (const r of results) {
    seen.add(r.caseId);
    const change = classifyChange(r.status, prev.get(r.caseId));
    if (change === 'new_failure') counts.newFailures++;
    else if (change === 'still_failing') counts.stillFailing++;
    else if (change === 'fixed') counts.fixed++;
    else if (change === 'new_test') counts.newTests++;
    if (change !== r.change) {
      const list = byChange.get(change) ?? [];
      list.push(r.id);
      byChange.set(change, list);
    }
  }
  for (const caseId of prev.keys()) if (!seen.has(caseId)) counts.missing++;

  for (const [change, ids] of byChange) {
    for (let i = 0; i < ids.length; i += 500) {
      db.update(testResults)
        .set({ change })
        .where(inArray(testResults.id, ids.slice(i, i + 500)))
        .run();
    }
  }
  db.update(runs)
    .set({ previousRunId, ...counts })
    .where(eq(runs.id, runId))
    .run();
}

/** Link a newly inserted (possibly out-of-order) run, then re-link its successor. */
export function linkInsertedRun(db: Db, runId: number): void {
  linkRun(db, runId);
  const next = findNextRun(db, getRunRow(db, runId));
  if (next !== null) linkRun(db, next);
}

// ---------------------------------------------------------------------------
// Compare
// ---------------------------------------------------------------------------

interface CaseInRun {
  status: ResultStatus;
  durationMs: number | null;
  message: string | null;
  resultId: number;
}

function casesInRun(db: Db, runId: number): Map<number, CaseInRun> {
  const map = new Map<number, CaseInRun>();
  for (const r of db
    .select({
      id: testResults.id,
      caseId: testResults.testCaseId,
      status: testResults.status,
      durationMs: testResults.durationMs,
      message: testResults.message,
    })
    .from(testResults)
    .where(eq(testResults.runId, runId))
    .orderBy(asc(testResults.id))
    .all()) {
    const prev = map.get(r.caseId);
    if (!prev || worse(r.status, prev.status) !== prev.status) {
      map.set(r.caseId, { status: r.status, durationMs: r.durationMs, message: r.message, resultId: r.id });
    } else if (prev.durationMs !== null && r.durationMs !== null) {
      prev.durationMs = Math.max(prev.durationMs, r.durationMs);
    }
  }
  return map;
}

const COMPARE_LIST_CAP = 500;

export function compareRuns(db: Db, headId: number, baseId?: number): RunComparison {
  const head = getRunRow(db, headId);
  const resolvedBase = baseId ?? head.previousRunId;
  if (resolvedBase === null || resolvedBase === undefined) {
    throw badRequest('Run has no previous run to compare with; pass ?base=<runId>');
  }
  const base = getRunRow(db, resolvedBase);
  const h = casesInRun(db, head.id);
  const b = casesInRun(db, base.id);

  const ids = [...new Set([...h.keys(), ...b.keys()])];
  const meta = new Map<number, RunCompareEntry['testCase']>();
  for (let i = 0; i < ids.length; i += 500) {
    for (const c of db
      .select({ id: testCases.id, key: testCases.key, title: testCases.title, suite: testCases.suite })
      .from(testCases)
      .where(inArray(testCases.id, ids.slice(i, i + 500)))
      .all()) {
      meta.set(c.id, c);
    }
  }

  const lists = {
    newFailures: [] as RunCompareEntry[],
    fixed: [] as RunCompareEntry[],
    stillFailing: [] as RunCompareEntry[],
    added: [] as RunCompareEntry[],
    removed: [] as RunCompareEntry[],
    slower: [] as RunCompareEntry[],
  };
  let unchangedPass = 0;
  for (const id of ids) {
    const tc = meta.get(id);
    if (!tc) continue;
    const hr = h.get(id);
    const br = b.get(id);
    const entry: RunCompareEntry = {
      testCase: tc,
      baseStatus: br?.status ?? null,
      headStatus: hr?.status ?? null,
      baseDurationMs: br?.durationMs ?? null,
      headDurationMs: hr?.durationMs ?? null,
      headMessage: hr?.message ? (hr.message.split(/\r?\n/)[0] ?? '').slice(0, 300) : null,
      headResultId: hr?.resultId ?? null,
    };
    if (!br && hr) lists.added.push(entry);
    else if (br && !hr) lists.removed.push(entry);
    else if (br && hr) {
      if (isFailing(hr.status) && isFailing(br.status)) lists.stillFailing.push(entry);
      else if (isFailing(hr.status)) lists.newFailures.push(entry);
      else if (hr.status === 'passed' && isFailing(br.status)) lists.fixed.push(entry);
      else if (hr.status === 'passed' && br.status === 'passed') unchangedPass++;
      if (
        hr.durationMs !== null &&
        br.durationMs !== null &&
        hr.durationMs >= 1.5 * br.durationMs &&
        hr.durationMs - br.durationMs >= 1000
      ) {
        lists.slower.push(entry);
      }
    }
  }
  const byKey = (a: RunCompareEntry, c: RunCompareEntry) => a.testCase.key.localeCompare(c.testCase.key);
  const increase = (e: RunCompareEntry) => (e.headDurationMs ?? 0) - (e.baseDurationMs ?? 0);
  for (const l of [lists.newFailures, lists.fixed, lists.stillFailing, lists.added, lists.removed]) l.sort(byKey);
  lists.slower.sort((a, c) => increase(c) - increase(a));

  return {
    base: serializeRun(base),
    head: serializeRun(head),
    counts: {
      newFailures: lists.newFailures.length,
      fixed: lists.fixed.length,
      stillFailing: lists.stillFailing.length,
      added: lists.added.length,
      removed: lists.removed.length,
      slower: lists.slower.length,
      unchangedPass,
    },
    newFailures: lists.newFailures.slice(0, COMPARE_LIST_CAP),
    fixed: lists.fixed.slice(0, COMPARE_LIST_CAP),
    stillFailing: lists.stillFailing.slice(0, COMPARE_LIST_CAP),
    added: lists.added.slice(0, COMPARE_LIST_CAP),
    removed: lists.removed.slice(0, COMPARE_LIST_CAP),
    slower: lists.slower.slice(0, COMPARE_LIST_CAP),
  };
}

// ---------------------------------------------------------------------------
// Matrix (3 queries: runs, cells, page metadata)
// ---------------------------------------------------------------------------


export function historyMatrix(db: Db, q: HistoryMatrixQuery): HistoryMatrix {
  let runGroup = q.runGroup ?? null;
  if (runGroup === null) {
    runGroup =
      db.select({ g: runs.runGroup }).from(runs).orderBy(desc(runs.sortAt), desc(runs.id)).limit(1).get()?.g ?? null;
  }
  const empty: HistoryMatrix = { runGroup, runs: [], rows: [], total: 0, page: q.page, pageSize: q.pageSize };
  if (runGroup === null) return empty;

  const runConds: SQL[] = [eq(runs.runGroup, runGroup)];
  if (q.branch !== undefined) runConds.push(eq(runs.branch, q.branch));
  const runRows = db
    .select()
    .from(runs)
    .where(and(...runConds))
    .orderBy(desc(runs.sortAt), desc(runs.id))
    .limit(q.runs)
    .all()
    .reverse();
  if (runRows.length === 0) return empty;
  const runIndex = new Map(runRows.map((r, i) => [r.id, i]));

  // One query for all cells; raw arrays keep it fast on large windows.
  const caseConds: SQL[] = [inArray(testResults.runId, runRows.map((r) => r.id))];
  if (q.suite !== undefined) caseConds.push(eq(testCases.suite, q.suite));
  if (q.search) {
    const p = containsPattern(q.search);
    const s = or(sql`${testCases.key} LIKE ${p} ESCAPE '\\'`, sql`${testCases.title} LIKE ${p} ESCAPE '\\'`);
    if (s) caseConds.push(s);
  }
  const needsCaseJoin = q.suite !== undefined || Boolean(q.search);
  const base = db
    .select({ caseId: testResults.testCaseId, runId: testResults.runId, status: testResults.status, id: testResults.id })
    .from(testResults);
  const cellRows = (
    needsCaseJoin ? base.innerJoin(testCases, eq(testCases.id, testResults.testCaseId)) : base
  )
    .where(and(...caseConds))
    .all();

  interface Acc {
    cells: Array<{ status: ResultStatus | null; resultId: number | null }>;
  }
  const n = runRows.length;
  const byCase = new Map<number, Acc>();
  for (const c of cellRows) {
    const idx = runIndex.get(c.runId);
    if (idx === undefined) continue;
    let acc = byCase.get(c.caseId);
    if (!acc) {
      acc = { cells: Array.from({ length: n }, () => ({ status: null, resultId: null })) };
      byCase.set(c.caseId, acc);
    }
    const cell = acc.cells[idx];
    if (!cell) continue;
    if (cell.status === null || worse(c.status, cell.status) !== cell.status) {
      cell.status = c.status;
      cell.resultId = c.id;
    }
  }

  const scored: Array<{ caseId: number; flips: number; failures: number; acc: Acc }> = [];
  for (const [caseId, acc] of byCase) {
    let flips = 0;
    let failures = 0;
    let prev: 'P' | 'F' | null = null;
    for (const cell of acc.cells) {
      if (cell.status === null) continue;
      if (isFailing(cell.status)) failures++;
      const s = cell.status === 'passed' ? 'P' : isFailing(cell.status) ? 'F' : null;
      if (s === null) continue;
      if (prev !== null && s !== prev) flips++;
      prev = s;
    }
    if (q.onlyUnstable && failures === 0) continue;
    scored.push({ caseId, flips, failures, acc });
  }

  // need keys for the tie-break sort: fetch minimal metadata for all candidates
  const keys = new Map<number, { key: string; title: string; suite: string | null }>();
  const ids = scored.map((s) => s.caseId);
  for (let i = 0; i < ids.length; i += 900) {
    for (const c of db
      .select({ id: testCases.id, key: testCases.key, title: testCases.title, suite: testCases.suite })
      .from(testCases)
      .where(inArray(testCases.id, ids.slice(i, i + 900)))
      .all()) {
      keys.set(c.id, c);
    }
  }
  scored.sort(
    (a, b) =>
      b.flips - a.flips ||
      b.failures - a.failures ||
      (keys.get(a.caseId)?.key ?? '').localeCompare(keys.get(b.caseId)?.key ?? ''),
  );
  const page = scored.slice((q.page - 1) * q.pageSize, q.page * q.pageSize);

  return {
    runGroup,
    runs: runRows.map((r) => ({
      id: r.id,
      name: r.name,
      runGroup: r.runGroup,
      branch: r.branch,
      startedAt: r.startedAt,
      importedAt: r.importedAt,
      passRate: passRate(r),
    })),
    rows: page.map((s) => {
      const m = keys.get(s.caseId);
      return {
        testCase: { id: s.caseId, key: m?.key ?? '', title: m?.title ?? '', suite: m?.suite ?? null },
        cells: s.acc.cells,
        flips: s.flips,
        failures: s.failures,
      };
    }),
    total: scored.length,
    page: q.page,
    pageSize: q.pageSize,
  };
}

