import { and, asc, desc, eq, inArray, or, sql, type SQL } from 'drizzle-orm';
import type {
  FailureGroup,
  ResultStatus,
  Run,
  RunQuery,
  RunResultsQuery,
  RunUpdate,
  TestResult,
  TriageCategory,
} from '@ptd/shared';
import type { Db } from '../db/client.js';
import { runs, testCases, testResults, type RunRow } from '../db/schema.js';
import { notFound } from '../errors.js';
import { containsPattern } from '../util/sql.js';
import { refreshCaseStats } from './caseStats.js';
import { findNextRun, linkRun } from './history.js';
import { bugRefsForFailureGroups } from './bugs.js';
import { anchorLine, messageLines, suggestTriage } from './signature.js';

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
    runGroup: r.runGroup,
    previousRunId: r.previousRunId,
    changes: {
      newFailures: r.newFailures,
      stillFailing: r.stillFailing,
      fixed: r.fixed,
      newTests: r.newTests,
      missing: r.missing,
    },
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
  const conds: SQL[] = [];
  if (q.branch !== undefined) conds.push(eq(runs.branch, q.branch));
  if (q.runGroup !== undefined) conds.push(eq(runs.runGroup, q.runGroup));
  if (q.search) {
    const p = containsPattern(q.search);
    const s = or(sql`${runs.name} LIKE ${p} ESCAPE '\\'`, sql`${runs.commit} LIKE ${p} ESCAPE '\\'`);
    if (s) conds.push(s);
  }
  if (q.from) conds.push(sql`substr(${runs.sortAt}, 1, 10) >= ${q.from}`);
  if (q.to) conds.push(sql`substr(${runs.sortAt}, 1, 10) <= ${q.to}`);
  const where = conds.length ? and(...conds) : undefined;
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
  const run = getRunRow(db, id);
  const next = findNextRun(db, run);
  const caseIds = db
    .selectDistinct({ id: testResults.testCaseId })
    .from(testResults)
    .where(eq(testResults.runId, id))
    .all()
    .map((r) => r.id);
  db.delete(runs).where(eq(runs.id, id)).run(); // cascades results; notes.run_id → null
  if (next !== null) linkRun(db, next);
  refreshCaseStats(db, caseIds);
}

/** PATCH /api/runs/:id — changing runGroup/branch re-links baselines on both lines. */
export function updateRun(db: Db, id: number, patch: RunUpdate): Run {
  const before = getRunRow(db, id);
  const set: Partial<typeof runs.$inferInsert> = {};
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.runGroup !== undefined) set.runGroup = patch.runGroup;
  if (patch.branch !== undefined) set.branch = patch.branch;
  if (Object.keys(set).length === 0) return serializeRun(before);
  const relink =
    (patch.runGroup !== undefined && patch.runGroup !== before.runGroup) ||
    (patch.branch !== undefined && patch.branch !== before.branch);
  const oldNext = relink ? findNextRun(db, before) : null;
  db.update(runs).set(set).where(eq(runs.id, id)).run();
  if (relink) {
    if (oldNext !== null) linkRun(db, oldNext);
    linkRun(db, id);
    const after = getRunRow(db, id);
    const newNext = findNextRun(db, after);
    if (newNext !== null) linkRun(db, newNext);
    refreshCaseStats(db, db.selectDistinct({ id: testResults.testCaseId }).from(testResults).where(eq(testResults.runId, id)).all().map((r) => r.id));
  }
  return serializeRun(getRunRow(db, id));
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
  if (q.change) conds.push(eq(testResults.change, q.change));
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
  return { total, items: rows.map(({ r, key }) => serializeResult(r, key)) };
}

function serializeResult(r: typeof testResults.$inferSelect, key: string): TestResult {
  return {
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
    suggestedTriage: r.status === 'failed' || r.status === 'broken' ? suggestTriage(r.message) : null,
    change: r.change,
    retries: r.retries,
    attempts: r.attempts ?? null,
    parameters: r.parameters,
    labels: r.labels,
  };
}

/** One result (incl. message + trace) by id — used for on-demand trace loading. */
export function getResult(db: Db, id: number): TestResult {
  const row = db
    .select({ r: testResults, key: testCases.key })
    .from(testResults)
    .innerJoin(testCases, eq(testCases.id, testResults.testCaseId))
    .where(eq(testResults.id, id))
    .get();
  if (!row) throw notFound('Result');
  return serializeResult(row.r, row.key);
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
      change: testResults.change,
    })
    .from(testResults)
    .innerJoin(testCases, eq(testCases.id, testResults.testCaseId))
    .where(and(eq(testResults.runId, runId), inArray(testResults.status, ['failed', 'broken'])))
    .orderBy(asc(testResults.id))
    .all();

  interface Acc {
    signature: string;
    sampleMessage: string;
    suggestedTriage: TriageCategory | null;
    count: number;
    newFailures: number;
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
        // the line that drives the signature (e.g. the ORA- line under a Camel wrapper)
        sampleMessage: anchorLine(messageLines(r.message)).line.slice(0, 500),
        suggestedTriage: suggestTriage(r.message),
        count: 0,
        newFailures: 0,
        failed: 0,
        broken: 0,
        cases: new Map(),
        triage: new Map(),
      };
      groups.set(sig, g);
    }
    g.count++;
    if (r.change === 'new_failure') g.newFailures++;
    if (r.status === 'broken') g.broken++;
    else g.failed++;
    if (!g.cases.has(r.caseId)) {
      g.cases.set(r.caseId, { id: r.caseId, key: r.key, title: r.title });
      if (r.triage) g.triage.set(r.triage, (g.triage.get(r.triage) ?? 0) + 1);
    }
  }
  const bugRefs = bugRefsForFailureGroups(
    db,
    [...groups.values()].map((g) => ({ signature: g.signature, caseIds: [...g.cases.keys()] })),
  );
  const firstSeen = firstSeenBySignature(
    db,
    [...groups.keys()].filter((k) => k !== 'unknown'),
  );
  return [...groups.values()]
    .map((g) => {
      let triage: TriageCategory | null = null;
      let best = 0;
      for (const [t, n] of g.triage) if (n > best) [triage, best] = [t, n];
      return {
        signature: g.signature,
        sampleMessage: g.sampleMessage,
        count: g.count,
        newFailures: g.newFailures,
        firstSeen: firstSeen.get(g.signature) ?? null,
        status: g.broken > g.failed ? ('broken' as const) : ('failed' as const),
        testCases: [...g.cases.values()],
        triage,
        suggestedTriage: g.suggestedTriage,
        bugs: bugRefs.get(g.signature) ?? [],
      };
    })
    .sort(
      (a, b) =>
        Number(b.newFailures > 0) - Number(a.newFailures > 0) ||
        b.count - a.count ||
        a.signature.localeCompare(b.signature),
    );
}

/** First run (any branch/group) in which each signature appeared. */
function firstSeenBySignature(db: Db, signatures: string[]): Map<string, NonNullable<FailureGroup['firstSeen']>> {
  const out = new Map<string, NonNullable<FailureGroup['firstSeen']>>();
  if (signatures.length === 0) return out;
  const rows = db
    .select({ sig: testResults.failureSignature, runId: runs.id, runName: runs.name, at: runs.sortAt })
    .from(testResults)
    .innerJoin(runs, eq(runs.id, testResults.runId))
    .where(inArray(testResults.failureSignature, signatures))
    .orderBy(asc(runs.sortAt), asc(runs.id))
    .all();
  for (const r of rows) {
    if (r.sig && !out.has(r.sig)) out.set(r.sig, { runId: r.runId, runName: r.runName, at: r.at });
  }
  return out;
}
