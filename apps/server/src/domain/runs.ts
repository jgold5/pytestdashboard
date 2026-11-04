import { and, asc, desc, eq, inArray, or, sql, type SQL } from 'drizzle-orm';
import type { FailureGroup, ResultStatus, Run, RunQuery, RunResultsQuery, TestResult, TriageCategory } from '@ptd/shared';
import type { Db } from '../db/client.js';
import { runs, testCases, testResults, type RunRow } from '../db/schema.js';
import { notFound } from '../errors.js';
import { containsPattern } from '../util/sql.js';
import { refreshCaseStats } from './caseStats.js';

export function passRate(c: { passed: number; skipped: number; total: number }): number | null {
  const executed = c.total - c.skipped;
  return executed > 0 ? c.passed / executed : null;
}

export function serializeRun(r: RunRow): Run {
  const counts = {
    passed: r.passed,
    failed: r.failed,
    broken: r.broken,
    skipped: r.skipped,
    unknown: r.unknown,
    total: r.total,
  };
  return {
    id: r.id,
    name: r.name,
    branch: r.branch,
    commit: r.commit,
    buildUrl: r.buildUrl,
    environment: r.environment,
    startedAt: r.startedAt,
    stoppedAt: r.stoppedAt,
    durationMs: r.durationMs,
    importedAt: r.importedAt,
    counts,
    passRate: passRate(counts),
  };
}

export function listRuns(db: Db, q: RunQuery): { items: Run[]; total: number } {
  const where = q.branch !== undefined ? eq(runs.branch, q.branch) : undefined;
  const total = db.select({ n: sql<number>`count(*)` }).from(runs).where(where).get()?.n ?? 0;
  const rows = db
    .select()
    .from(runs)
    .where(where)
    .orderBy(desc(runs.sortAt), desc(runs.id))
    .limit(q.pageSize)
    .offset((q.page - 1) * q.pageSize)
    .all();
  return { items: rows.map(serializeRun), total };
}

export function getRunRow(db: Db, id: number): RunRow {
  const row = db.select().from(runs).where(eq(runs.id, id)).get();
  if (!row) throw notFound('Run');
  return row;
}

export function deleteRun(db: Db, id: number): void {
  getRunRow(db, id);
  const caseIds = db
    .selectDistinct({ id: testResults.testCaseId })
    .from(testResults)
    .where(eq(testResults.runId, id))
    .all()
    .map((r) => r.id);
  db.delete(runs).where(eq(runs.id, id)).run(); // cascades results; notes.run_id → null
  refreshCaseStats(db, caseIds);
}

/** Recompute stored status counts from the run's results. */
export function recomputeRunCounts(db: Db, runId: number): void {
  const rows = db
    .select({ status: testResults.status, n: sql<number>`count(*)` })
    .from(testResults)
    .where(eq(testResults.runId, runId))
    .groupBy(testResults.status)
    .all();
  const by = (s: ResultStatus) => rows.find((r) => r.status === s)?.n ?? 0;
  const counts = {
    passed: by('passed'),
    failed: by('failed'),
    broken: by('broken'),
    skipped: by('skipped'),
    unknown: by('unknown'),
  };
  const total = counts.passed + counts.failed + counts.broken + counts.skipped + counts.unknown;
  db.update(runs)
    .set({ ...counts, total })
    .where(eq(runs.id, runId))
    .run();
}

export function listRunResults(db: Db, runId: number, q: RunResultsQuery): { items: TestResult[]; total: number } {
  getRunRow(db, runId);
  const conds: SQL[] = [eq(testResults.runId, runId)];
  if (q.status) conds.push(eq(testResults.status, q.status));
  if (q.search) {
    const p = containsPattern(q.search);
    const s = or(
      sql`${testResults.name} LIKE ${p} ESCAPE '\\'`,
      sql`${testResults.fullName} LIKE ${p} ESCAPE '\\'`,
      sql`${testCases.key} LIKE ${p} ESCAPE '\\'`,
    );
    if (s) conds.push(s);
  }
  const where = and(...conds);
  const total =
    db
      .select({ n: sql<number>`count(*)` })
      .from(testResults)
      .innerJoin(testCases, eq(testCases.id, testResults.testCaseId))
      .where(where)
      .get()?.n ?? 0;
  const statusOrder = sql`CASE ${testResults.status} WHEN 'broken' THEN 0 WHEN 'failed' THEN 1 WHEN 'unknown' THEN 2 WHEN 'skipped' THEN 3 ELSE 4 END`;
  const rows = db
    .select({ r: testResults, key: testCases.key })
    .from(testResults)
    .innerJoin(testCases, eq(testCases.id, testResults.testCaseId))
    .where(where)
    .orderBy(statusOrder, asc(testResults.name), asc(testResults.id))
    .limit(q.pageSize)
    .offset((q.page - 1) * q.pageSize)
    .all();
  return {
    total,
    items: rows.map(({ r, key }) => ({
      id: r.id,
      runId: r.runId,
      testCaseId: r.testCaseId,
      testCaseKey: key,
      name: r.name,
      fullName: r.fullName,
      status: r.status,
      durationMs: r.durationMs,
      startedAt: r.startedAt,
      message: r.message,
      trace: r.trace,
      failureSignature: r.failureSignature,
      retries: r.retries,
      parameters: r.parameters,
      labels: r.labels,
    })),
  };
}

export function runFailureGroups(db: Db, runId: number): FailureGroup[] {
  getRunRow(db, runId);
  const rows = db
    .select({
      signature: testResults.failureSignature,
      status: testResults.status,
      message: testResults.message,
      caseId: testCases.id,
      key: testCases.key,
      title: testCases.title,
      triage: testCases.triage,
    })
    .from(testResults)
    .innerJoin(testCases, eq(testCases.id, testResults.testCaseId))
    .where(and(eq(testResults.runId, runId), inArray(testResults.status, ['failed', 'broken'])))
    .orderBy(asc(testResults.id))
    .all();

  interface Acc {
    signature: string;
    sampleMessage: string;
    count: number;
    failed: number;
    broken: number;
    cases: Map<number, { id: number; key: string; title: string }>;
    triage: Map<TriageCategory, number>;
  }
  const groups = new Map<string, Acc>();
  for (const r of rows) {
    const sig = r.signature ?? 'unknown';
    let g = groups.get(sig);
    if (!g) {
      g = {
        signature: sig,
        sampleMessage: (r.message ?? '').split(/\r?\n/)[0]?.slice(0, 500) ?? '',
        count: 0,
        failed: 0,
        broken: 0,
        cases: new Map(),
        triage: new Map(),
      };
      groups.set(sig, g);
    }
    g.count++;
    if (r.status === 'broken') g.broken++;
    else g.failed++;
    if (!g.cases.has(r.caseId)) {
      g.cases.set(r.caseId, { id: r.caseId, key: r.key, title: r.title });
      if (r.triage) g.triage.set(r.triage, (g.triage.get(r.triage) ?? 0) + 1);
    }
  }
  return [...groups.values()]
    .map((g) => {
      let triage: TriageCategory | null = null;
      let best = 0;
      for (const [t, n] of g.triage) if (n > best) [triage, best] = [t, n];
      return {
        signature: g.signature,
        sampleMessage: g.sampleMessage,
        count: g.count,
        status: g.broken > g.failed ? ('broken' as const) : ('failed' as const),
        testCases: [...g.cases.values()],
        triage,
      };
    })
    .sort((a, b) => b.count - a.count || a.signature.localeCompare(b.signature));
}
