import { and, desc, eq, inArray, type SQL } from 'drizzle-orm';
import type { Note, NoteBulkCreate, NoteCreate, NoteQuery, NoteUpdate } from '@ptd/shared';
import type { Db } from '../db/client.js';
import { notes, runs, testCases, testResults, type NoteRow } from '../db/schema.js';
import { badRequest, notFound } from '../errors.js';
import { nowIso } from '../util/time.js';
import { refreshCaseStats } from './caseStats.js';
import { upsertBugFromNote } from './bugs.js';

export function serializeNote(r: NoteRow): Note {
  return {
    id: r.id,
    testCaseId: r.testCaseId,
    resultId: r.resultId,
    runId: r.runId,
    author: r.author,
    body: r.body,
    triage: r.triage,
    ticketUrl: r.ticketUrl,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

export function listNotes(db: Db, q: NoteQuery): Note[] {
  const conds: SQL[] = [];
  if (q.testCaseId) conds.push(eq(notes.testCaseId, q.testCaseId));
  if (q.runId) conds.push(eq(notes.runId, q.runId));
  return db
    .select()
    .from(notes)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(notes.createdAt), desc(notes.id))
    .limit(q.limit)
    .all()
    .map(serializeNote);
}

export function createNote(db: Db, input: NoteCreate): Note {
  const tc = db.select({ id: testCases.id }).from(testCases).where(eq(testCases.id, input.testCaseId)).get();
  if (!tc) throw notFound('Test case');
  let runId: number | null = null;
  if (input.resultId) {
    const res = db
      .select({ runId: testResults.runId, testCaseId: testResults.testCaseId })
      .from(testResults)
      .where(eq(testResults.id, input.resultId))
      .get();
    if (!res) throw notFound('Result');
    if (res.testCaseId !== input.testCaseId) throw badRequest('resultId does not belong to this test case');
    runId = res.runId;
  }
  const now = nowIso();
  const row = db
    .insert(notes)
    .values({
      testCaseId: input.testCaseId,
      resultId: input.resultId ?? null,
      runId,
      author: input.author,
      body: input.body,
      triage: input.triage ?? null,
      ticketUrl: input.ticketUrl ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
  if (row.triage === 'product_bug') upsertBugFromNote(db, row);
  refreshCaseStats(db, [input.testCaseId]);
  return serializeNote(row);
}

export function bulkCreateNotes(db: Db, input: NoteBulkCreate): number {
  const ids = [...new Set(input.testCaseIds)];
  const existing = db.select({ id: testCases.id }).from(testCases).where(inArray(testCases.id, ids)).all();
  if (existing.length !== ids.length) throw notFound('One or more test cases');
  const runId = input.runId ?? null;
  const resultByCase = new Map<number, number>();
  if (runId !== null) {
    if (!db.select({ id: runs.id }).from(runs).where(eq(runs.id, runId)).get()) throw notFound('Run');
    for (const r of db
      .select({ id: testResults.id, caseId: testResults.testCaseId })
      .from(testResults)
      .where(and(eq(testResults.runId, runId), inArray(testResults.testCaseId, ids)))
      .all()) {
      if (!resultByCase.has(r.caseId)) resultByCase.set(r.caseId, r.id);
    }
  }
  const now = nowIso();
  const inserted = db
    .insert(notes)
    .values(
      ids.map((testCaseId) => ({
        testCaseId,
        resultId: resultByCase.get(testCaseId) ?? null,
        runId,
        author: input.author,
        body: input.body,
        triage: input.triage ?? null,
        ticketUrl: input.ticketUrl ?? null,
        createdAt: now,
        updatedAt: now,
      })),
    )
    .returning()
    .all();
  if (input.triage === 'product_bug') for (const n of inserted) upsertBugFromNote(db, n);
  refreshCaseStats(db, ids);
  return ids.length;
}

export function updateNote(db: Db, id: number, patch: NoteUpdate): Note {
  const current = db.select().from(notes).where(eq(notes.id, id)).get();
  if (!current) throw notFound('Note');
  const set: Partial<typeof notes.$inferInsert> = {};
  if (patch.body !== undefined) set.body = patch.body;
  if (patch.triage !== undefined) set.triage = patch.triage;
  if (patch.ticketUrl !== undefined) set.ticketUrl = patch.ticketUrl;
  if (Object.keys(set).length === 0) return serializeNote(current);
  set.updatedAt = nowIso();
  const row = db.update(notes).set(set).where(eq(notes.id, id)).returning().get() ?? current;
  refreshCaseStats(db, [row.testCaseId]);
  return serializeNote(row);
}

export function deleteNote(db: Db, id: number): void {
  const current = db.select({ testCaseId: notes.testCaseId }).from(notes).where(eq(notes.id, id)).get();
  if (!current) throw notFound('Note');
  db.delete(notes).where(eq(notes.id, id)).run();
  refreshCaseStats(db, [current.testCaseId]);
}
