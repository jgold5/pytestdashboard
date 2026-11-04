/**
 * Maintains the denormalized columns on test_cases (last result, flakiness,
 * triage, note count) so list/filter/sort queries stay simple and indexed.
 * Call inside the same transaction as the mutation.
 */
import { and, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import type { ResultStatus, TriageCategory } from '@ptd/shared';
import type { Db } from '../db/client.js';
import { notes, runs, testCases, testResults } from '../db/schema.js';
import { computeFlakiness } from './flakiness.js';

/** failed/broken first so a run's "worst" result represents it. */
const severity = sql`CASE ${testResults.status} WHEN 'broken' THEN 0 WHEN 'failed' THEN 1 WHEN 'passed' THEN 2 ELSE 3 END`;

export function refreshCaseStats(db: Db, caseIds?: Iterable<number>): void {
  const ids = caseIds ? [...new Set(caseIds)] : db.select({ id: testCases.id }).from(testCases).all().map((r) => r.id);
  for (const id of ids) refreshOne(db, id);
}

function refreshOne(db: Db, id: number): void {
  const recent = db
    .select({
      status: testResults.status,
      runId: testResults.runId,
      sortAt: runs.sortAt,
      runGroup: runs.runGroup,
      signature: testResults.failureSignature,
    })
    .from(testResults)
    .innerJoin(runs, eq(runs.id, testResults.runId))
    .where(eq(testResults.testCaseId, id))
    .orderBy(desc(runs.sortAt), desc(runs.id), severity, desc(testResults.id))
    .limit(300)
    .all();
  const last = recent[0];

  // one status per run (worst — rows are ordered by severity within a run), newest first, per run group
  const perGroup = new Map<string, ResultStatus[]>();
  let prevRun: number | null = null;
  for (const r of recent) {
    if (r.runId === prevRun) continue;
    prevRun = r.runId;
    const list = perGroup.get(r.runGroup) ?? [];
    list.push(r.status);
    perGroup.set(r.runGroup, list);
  }
  let flakiness = 0;
  for (const statuses of perGroup.values()) flakiness = Math.max(flakiness, computeFlakiness(statuses));

  const triageNote = db
    .select({ triage: notes.triage, createdAt: notes.createdAt })
    .from(notes)
    .where(and(eq(notes.testCaseId, id), isNotNull(notes.triage)))
    .orderBy(desc(notes.createdAt), desc(notes.id))
    .limit(1)
    .get();
  const noteCount = db.select({ n: sql<number>`count(*)` }).from(notes).where(eq(notes.testCaseId, id)).get()?.n ?? 0;

  db.update(testCases)
    .set({
      lastStatus: last?.status ?? null,
      lastRunId: last?.runId ?? null,
      lastRunAt: last?.sortAt ?? null,
      lastSignature: last?.signature ?? null,
      flakiness,
      triage: (triageNote?.triage as TriageCategory | null | undefined) ?? null,
      triageAt: triageNote?.createdAt ?? null,
      noteCount,
    })
    .where(eq(testCases.id, id))
    .run();
}

/** Case ids that have results in the given run (before deleting it). */
export function caseIdsInRun(db: Db, runId: number): number[] {
  return db
    .selectDistinct({ id: testResults.testCaseId })
    .from(testResults)
    .where(eq(testResults.runId, runId))
    .all()
    .map((r) => r.id);
}

export function existingCaseIds(db: Db, ids: number[]): number[] {
  if (ids.length === 0) return [];
  return db.select({ id: testCases.id }).from(testCases).where(inArray(testCases.id, ids)).all().map((r) => r.id);
}
