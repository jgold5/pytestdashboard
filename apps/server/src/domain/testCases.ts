import { and, asc, desc, eq, inArray, ne, or, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import type {
  LastResult,
  PullRequestRef,
  TestCase,
  TestCaseBulkUpdate,
  TestCaseCreate,
  TestCaseDetail,
  TestCaseQuery,
  TestCaseUpdate,
} from '@ptd/shared';
import type { Db } from '../db/client.js';
import {
  notes,
  pullRequests,
  runs,
  testCasePullRequests,
  testCases,
  testResults,
  type CaseSource,
  type TestCaseRow,
} from '../db/schema.js';
import { conflict, notFound } from '../errors.js';
import { containsPattern } from '../util/sql.js';
import { nowIso } from '../util/time.js';
import { FLAKY_THRESHOLD } from './flakiness.js';
import { openBugRefsForCases } from './bugs.js';
import { serializeNote } from './notes.js';
import { recomputeRunCounts } from './runs.js';
import { caseHistory } from './caseHistory.js';
import { isReadyToMerge, pipelineStageFilter, pipelineStagesForCases } from './pipeline.js';

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

export function prRefsForCases(db: Db, caseIds: number[]): Map<number, PullRequestRef[]> {
  const map = new Map<number, PullRequestRef[]>();
  if (caseIds.length === 0) return map;
  const rows = db
    .select({ caseId: testCasePullRequests.testCaseId, linkedBy: testCasePullRequests.linkedBy, pr: pullRequests })
    .from(testCasePullRequests)
    .innerJoin(pullRequests, eq(pullRequests.id, testCasePullRequests.pullRequestId))
    .where(inArray(testCasePullRequests.testCaseId, caseIds))
    .orderBy(desc(pullRequests.updatedAt))
    .all();
  for (const r of rows) {
    const list = map.get(r.caseId) ?? [];
    list.push({
      repo: r.pr.repo,
      number: r.pr.number,
      title: r.pr.title,
      url: r.pr.url,
      state: r.pr.state,
      author: r.pr.author,
      updatedAt: r.pr.updatedAt,
      linkedBy: r.linkedBy,
      reviewState: r.pr.reviewState,
      requestedReviewers: r.pr.requestedReviewers,
      unresolvedThreads: r.pr.unresolvedThreads,
      checks: r.pr.checks,
      needsAttention: r.pr.needsAttention,
      mergedAt: r.pr.mergedAt,
      approvedAt: r.pr.approvedAt,
      readyToMerge: isReadyToMerge(r.pr),
    });
    map.set(r.caseId, list);
  }
  return map;
}

function runNames(db: Db, runIds: number[]): Map<number, string> {
  const ids = [...new Set(runIds)];
  if (ids.length === 0) return new Map();
  return new Map(
    db
      .select({ id: runs.id, name: runs.name })
      .from(runs)
      .where(inArray(runs.id, ids))
      .all()
      .map((r) => [r.id, r.name]),
  );
}

export function serializeCases(db: Db, rows: TestCaseRow[]): TestCase[] {
  const ids = rows.map((r) => r.id);
  const prs = prRefsForCases(db, ids);
  const openBugs = openBugRefsForCases(db, ids);
  const stages = pipelineStagesForCases(db, ids);
  const names = runNames(
    db,
    rows.flatMap((r) => (r.lastRunId ? [r.lastRunId] : [])),
  );
  return rows.map((r) => {
    const pullRequestsForCase = prs.get(r.id) ?? [];
    let lastResult: LastResult | null = null;
    if (r.lastStatus && r.lastRunId && r.lastRunAt) {
      lastResult = { status: r.lastStatus, runId: r.lastRunId, runName: names.get(r.lastRunId) ?? '', at: r.lastRunAt };
    }
    return {
      id: r.id,
      key: r.key,
      title: r.title,
      suite: r.suite,
      priority: r.priority,
      automationStatus: r.automationStatus,
      owner: r.owner,
      tags: r.tags,
      externalUrl: r.externalUrl,
      allureFullName: r.allureFullName,
      allureId: r.allureId,
      jiraKey: r.jiraKey,
      source: r.source,
      pullRequests: pullRequestsForCase,
      inOpenPr: pullRequestsForCase.some((p) => p.state === 'open' || p.state === 'draft'),
      pipelineStage: stages.get(r.id) ?? 'not_started',
      automatedVia: r.automatedVia,
      lastResult,
      triage: r.triage,
      openBugs: openBugs.get(r.id) ?? [],
      noteCount: r.noteCount,
      flakiness: r.flakiness,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  });
}

export function getCaseRow(db: Db, id: number): TestCaseRow {
  const row = db.select().from(testCases).where(eq(testCases.id, id)).get();
  if (!row) throw notFound('Test case');
  return row;
}

export function getCase(db: Db, id: number): TestCase {
  const [tc] = serializeCases(db, [getCaseRow(db, id)]);
  if (!tc) throw notFound('Test case');
  return tc;
}

export function getCaseDetail(db: Db, id: number): TestCaseDetail {
  const tc = getCase(db, id);
  const noteRows = db
    .select()
    .from(notes)
    .where(eq(notes.testCaseId, id))
    .orderBy(desc(notes.createdAt), desc(notes.id))
    .all();
  const { history, stats } = caseHistory(db, id);
  return { ...tc, history, stats, notes: noteRows.map(serializeNote) };
}

// ---------------------------------------------------------------------------
// Listing / filtering
// ---------------------------------------------------------------------------

export type CaseFilters = Omit<TestCaseQuery, 'sort' | 'order' | 'page' | 'pageSize'>;

const openPrExists = sql`EXISTS (SELECT 1 FROM ${testCasePullRequests} INNER JOIN ${pullRequests} ON ${pullRequests.id} = ${testCasePullRequests.pullRequestId} WHERE ${testCasePullRequests.testCaseId} = ${testCases.id} AND ${pullRequests.state} IN ('open', 'draft'))`;

export function buildCaseWhere(f: CaseFilters): SQL | undefined {
  const conds: SQL[] = [];
  if (f.search) {
    const p = containsPattern(f.search);
    const like = (col: SQLWrapper) => sql`${col} LIKE ${p} ESCAPE '\\'`;
    const anyOf = or(
      like(testCases.key),
      like(testCases.title),
      like(testCases.suite),
      like(testCases.owner),
      like(testCases.tags),
      like(testCases.jiraKey),
    );
    if (anyOf) conds.push(anyOf);
  }
  if (f.suite !== undefined) conds.push(eq(testCases.suite, f.suite));
  if (f.automationStatus) conds.push(eq(testCases.automationStatus, f.automationStatus));
  if (f.priority) conds.push(eq(testCases.priority, f.priority));
  if (f.lastStatus) conds.push(eq(testCases.lastStatus, f.lastStatus));
  if (f.triage) conds.push(eq(testCases.triage, f.triage));
  if (f.owner !== undefined) conds.push(eq(testCases.owner, f.owner));
  if (f.source) conds.push(eq(testCases.source, f.source));
  if (f.flakyOnly === true) conds.push(sql`${testCases.flakiness} >= ${FLAKY_THRESHOLD}`);
  if (f.inOpenPr === true) conds.push(openPrExists);
  if (f.inOpenPr === false) conds.push(sql`NOT ${openPrExists}`);
  if (f.pipelineStage) conds.push(pipelineStageFilter(f.pipelineStage));
  return conds.length ? and(...conds) : undefined;
}

function orderBy(sort: TestCaseQuery['sort'], order: TestCaseQuery['order']): SQL[] {
  const dir = order === 'desc' ? desc : asc;
  const nullsLast = (col: SQLWrapper) => sql`${col} IS NULL`;
  switch (sort) {
    case 'key':
      return [dir(testCases.key)];
    case 'title':
      return [dir(testCases.title), asc(testCases.id)];
    case 'suite':
      return [nullsLast(testCases.suite), dir(testCases.suite), asc(testCases.key)];
    case 'priority':
      return [nullsLast(testCases.priority), dir(testCases.priority), asc(testCases.key)];
    case 'automationStatus':
      return [dir(testCases.automationStatus), asc(testCases.key)];
    case 'lastRun':
      return [nullsLast(testCases.lastRunAt), dir(testCases.lastRunAt), asc(testCases.key)];
    case 'flakiness':
      return [dir(testCases.flakiness), asc(testCases.key)];
    case 'updatedAt':
      return [dir(testCases.updatedAt), asc(testCases.id)];
  }
}

export function listCases(db: Db, q: TestCaseQuery): { items: TestCase[]; total: number } {
  const where = buildCaseWhere(q);
  const total = db.select({ n: sql<number>`count(*)` }).from(testCases).where(where).get()?.n ?? 0;
  const rows = db
    .select()
    .from(testCases)
    .where(where)
    .orderBy(...orderBy(q.sort, q.order))
    .limit(q.pageSize)
    .offset((q.page - 1) * q.pageSize)
    .all();
  return { items: serializeCases(db, rows), total };
}

export function listCasesForExport(db: Db, q: TestCaseQuery, max: number): TestCase[] {
  const rows = db
    .select()
    .from(testCases)
    .where(buildCaseWhere(q))
    .orderBy(...orderBy(q.sort, q.order))
    .limit(max)
    .all();
  return serializeCases(db, rows);
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

function assertUnique(db: Db, field: 'key' | 'jiraKey', value: string, exceptId?: number): void {
  const col = field === 'key' ? testCases.key : testCases.jiraKey;
  const cond = exceptId === undefined ? eq(col, value) : and(eq(col, value), ne(testCases.id, exceptId));
  const hit = db.select({ id: testCases.id }).from(testCases).where(cond).get();
  if (hit) {
    throw conflict(`A test case with ${field === 'key' ? 'key' : 'Jira key'} "${value}" already exists`, {
      field,
      id: hit.id,
    });
  }
}

export function createCase(db: Db, input: TestCaseCreate, source: CaseSource = 'manual'): TestCaseRow {
  assertUnique(db, 'key', input.key);
  if (input.jiraKey) assertUnique(db, 'jiraKey', input.jiraKey);
  const now = nowIso();
  return db
    .insert(testCases)
    .values({
      key: input.key,
      title: input.title,
      suite: input.suite ?? null,
      priority: input.priority ?? null,
      automationStatus: input.automationStatus,
      owner: input.owner ?? null,
      tags: input.tags,
      externalUrl: input.externalUrl ?? null,
      allureFullName: input.allureFullName ?? null,
      allureId: input.allureId ?? null,
      jiraKey: input.jiraKey ?? null,
      source,
      automatedAt: input.automationStatus === 'automated' ? now : null,
      automatedVia: input.automationStatus === 'automated' ? 'manual' : null,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
}

type CaseUpdateSet = Partial<typeof testCases.$inferInsert>;

/** Only keys present in the patch are written — omitted fields are never reset. */
export function patchToSet(patch: TestCaseUpdate, current?: Pick<TestCaseRow, 'automationStatus'>): CaseUpdateSet {
  const set: CaseUpdateSet = {};
  if (patch.key !== undefined) set.key = patch.key;
  if (patch.title !== undefined) set.title = patch.title;
  if (patch.suite !== undefined) set.suite = patch.suite;
  if (patch.priority !== undefined) set.priority = patch.priority;
  if (patch.automationStatus !== undefined) {
    set.automationStatus = patch.automationStatus;
    if (patch.automationStatus === 'automated' && current?.automationStatus !== 'automated') {
      set.automatedAt = nowIso();
      set.automatedVia = 'manual';
    }
  }
  if (patch.owner !== undefined) set.owner = patch.owner;
  if (patch.tags !== undefined) set.tags = patch.tags;
  if (patch.externalUrl !== undefined) set.externalUrl = patch.externalUrl;
  if (patch.allureFullName !== undefined) set.allureFullName = patch.allureFullName;
  if (patch.allureId !== undefined) set.allureId = patch.allureId;
  if (patch.jiraKey !== undefined) set.jiraKey = patch.jiraKey;
  return set;
}

export function updateCase(db: Db, id: number, patch: TestCaseUpdate): TestCaseRow {
  const current = getCaseRow(db, id);
  if (patch.key !== undefined && patch.key !== current.key) assertUnique(db, 'key', patch.key, id);
  if (patch.jiraKey && patch.jiraKey !== current.jiraKey) assertUnique(db, 'jiraKey', patch.jiraKey, id);
  const set = patchToSet(patch, current);
  if (Object.keys(set).length === 0) return current;
  set.updatedAt = nowIso();
  return db.update(testCases).set(set).where(eq(testCases.id, id)).returning().get() ?? current;
}

export function bulkUpdateCases(db: Db, input: TestCaseBulkUpdate): number {
  const ids = [...new Set(input.ids)];
  const set = patchToSet(input.patch);
  delete set.automatedAt;
  delete set.automatedVia;
  const now = nowIso();
  set.updatedAt = now;
  if (input.patch.automationStatus === 'automated') {
    // stamp only the cases that transition into `automated`
    db.update(testCases)
      .set({ automatedAt: now, automatedVia: 'manual' })
      .where(and(inArray(testCases.id, ids), ne(testCases.automationStatus, 'automated')))
      .run();
  }
  return db.update(testCases).set(set).where(inArray(testCases.id, ids)).run().changes;
}

export function deleteCase(db: Db, id: number): void {
  getCaseRow(db, id);
  const affectedRuns = db
    .selectDistinct({ runId: testResults.runId })
    .from(testResults)
    .where(eq(testResults.testCaseId, id))
    .all()
    .map((r) => r.runId);
  db.delete(testCases).where(eq(testCases.id, id)).run(); // cascades results, notes, PR links
  for (const runId of affectedRuns) recomputeRunCounts(db, runId);
}
