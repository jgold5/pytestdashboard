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

  // Strategy (few queries, no N+1, index-friendly):
  //  1. ids of cases with ≥1 failure in the window (index run_id,status) — the "unstable" set;
  //  2. their cells (index test_case_id,run_id), scored and sorted in memory;
  //  3. only when onlyUnstable=false: stable cases (0 flips/0 failures) follow, ordered by
  //     key and paginated in SQL, and only the page's cells are fetched.
  const runIds = runRows.map((r) => r.id);
  const caseFilters: SQL[] = [];
  if (q.suite !== undefined) caseFilters.push(eq(testCases.suite, q.suite));
  if (q.search) {
    const p = containsPattern(q.search);
    const s = or(sql`${testCases.key} LIKE ${p} ESCAPE '\\'`, sql`${testCases.title} LIKE ${p} ESCAPE '\\'`);
    if (s) caseFilters.push(s);
  }
  const needsCaseJoin = caseFilters.length > 0;
  const n = runRows.length;

  type Cell = { status: ResultStatus | null; resultId: number | null };
  const fetchCells = (caseIds: number[]): Map<number, Cell[]> => {
    const byCase = new Map<number, Cell[]>();
    for (let i = 0; i < caseIds.length; i += 500) {
      const rows = db
        .select({ caseId: testResults.testCaseId, runId: testResults.runId, status: testResults.status, id: testResults.id })
        .from(testResults)
        .where(and(inArray(testResults.testCaseId, caseIds.slice(i, i + 500)), inArray(testResults.runId, runIds)))
        .values() as Array<[number, number, ResultStatus, number]>;
      for (const [caseId, runId, status, id] of rows) {
        const idx = runIndex.get(runId);
        if (idx === undefined) continue;
        let cells = byCase.get(caseId);
        if (!cells) {
          cells = Array.from({ length: n }, () => ({ status: null, resultId: null }));
          byCase.set(caseId, cells);
        }
        const cell = cells[idx];
        if (cell && (cell.status === null || worse(status, cell.status) !== cell.status)) {
          cell.status = status;
          cell.resultId = id;
        }
      }
    }
    return byCase;
  };
  const meta = (ids: number[]) => {
    const out = new Map<number, { key: string; title: string; suite: string | null }>();
    for (let i = 0; i < ids.length; i += 500) {
      for (const c of db
        .select({ id: testCases.id, key: testCases.key, title: testCases.title, suite: testCases.suite })
        .from(testCases)
        .where(inArray(testCases.id, ids.slice(i, i + 500)))
        .all()) {
        out.set(c.id, c);
      }
    }
    return out;
  };

  // 1 + 2: unstable cases
  const failingBase = db.selectDistinct({ caseId: testResults.testCaseId }).from(testResults);
  const failingIds = (needsCaseJoin ? failingBase.innerJoin(testCases, eq(testCases.id, testResults.testCaseId)) : failingBase)
    .where(and(inArray(testResults.runId, runIds), inArray(testResults.status, ['failed', 'broken']), ...caseFilters))
    .all()
    .map((r) => r.caseId);
  const unstableCells = fetchCells(failingIds);
  const unstableMeta = meta(failingIds);
  const scored = [...unstableCells].map(([caseId, cells]) => {
    let flips = 0;
    let failures = 0;
    let prev: 'P' | 'F' | null = null;
    for (const cell of cells) {
      if (cell.status === null) continue;
      if (isFailing(cell.status)) failures++;
      const s = cell.status === 'passed' ? 'P' : isFailing(cell.status) ? 'F' : null;
      if (s === null) continue;
      if (prev !== null && s !== prev) flips++;
      prev = s;
    }
    return { caseId, flips, failures, cells };
  });
  scored.sort(
    (a, b) =>
      b.flips - a.flips ||
      b.failures - a.failures ||
      (unstableMeta.get(a.caseId)?.key ?? '').localeCompare(unstableMeta.get(b.caseId)?.key ?? ''),
  );

  const offset = (q.page - 1) * q.pageSize;
  const rows: HistoryMatrix['rows'] = scored.slice(offset, offset + q.pageSize).map((s) => {
    const m = unstableMeta.get(s.caseId);
    return {
      testCase: { id: s.caseId, key: m?.key ?? '', title: m?.title ?? '', suite: m?.suite ?? null },
      cells: s.cells,
      flips: s.flips,
      failures: s.failures,
    };
  });
  let total = scored.length;

  // 3: stable cases (executed in the window, never failing there)
  if (!q.onlyUnstable) {
    const inWindow = sql`EXISTS (SELECT 1 FROM ${testResults} WHERE ${testResults.testCaseId} = ${testCases.id} AND ${inArray(testResults.runId, runIds)})`;
    const noFailure = sql`NOT EXISTS (SELECT 1 FROM ${testResults} WHERE ${testResults.testCaseId} = ${testCases.id} AND ${inArray(testResults.runId, runIds)} AND ${testResults.status} IN ('failed', 'broken'))`;
    const where = and(inWindow, noFailure, ...caseFilters);
    total += db.select({ n: sql<number>`count(*)` }).from(testCases).where(where).get()?.n ?? 0;
    const need = q.pageSize - rows.length;
    if (need > 0) {
      const stable = db
        .select({ id: testCases.id, key: testCases.key, title: testCases.title, suite: testCases.suite })
        .from(testCases)
        .where(where)
        .orderBy(asc(testCases.key))
        .limit(need)
        .offset(Math.max(0, offset - scored.length))
        .all();
      const cells = fetchCells(stable.map((c) => c.id));
      for (const c of stable) {
        rows.push({
          testCase: { id: c.id, key: c.key, title: c.title, suite: c.suite },
          cells: cells.get(c.id) ?? Array.from({ length: n }, () => ({ status: null, resultId: null })),
          flips: 0,
          failures: 0,
        });
      }
    }
  }

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
    rows,
    total,
    page: q.page,
    pageSize: q.pageSize,
  };
}

