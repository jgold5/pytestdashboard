/**
 * Bugs identified (manually, from failure groups, or via product_bug notes),
 * linked to test cases and failure signatures. `verification` is computed on
 * read from linked cases' results in runs started after resolvedAt.
 */
import { and, asc, desc, eq, gt, gte, inArray, isNotNull, or, sql, type SQL } from 'drizzle-orm';
import type {
  Bug,
  BugCreate,
  BugQuery,
  BugRef,
  BugStats,
  BugStatus,
  BugUpdate,
  BugVerification,
  ResultStatus,
} from '@ptd/shared';
import type { Db } from '../db/client.js';
import { bugSignatures, bugTestCases, bugs, runs, testCases, testResults, type BugRow } from '../db/schema.js';
import { conflict, notFound } from '../errors.js';
import { containsPattern } from '../util/sql.js';
import { addDays, isoDate, nowIso } from '../util/time.js';
import { isFailing, worse } from './history.js';

export const OPEN_STATUSES: readonly BugStatus[] = ['open', 'in_progress'];
const RESOLVED_STATUSES: readonly BugStatus[] = ['resolved', 'closed'];
const isTerminal = (s: BugStatus) => s === 'resolved' || s === 'closed' || s === 'wont_fix';

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

export interface VerificationInfo {
  verification: BugVerification;
  /** For verified_fixed: when the last confirming run happened. */
  verifiedAt: string | null;
}

/** Verification for each bug, computed from linked cases' results after resolvedAt (all run groups). */
export function computeVerifications(db: Db, rows: readonly BugRow[]): Map<number, VerificationInfo> {
  const out = new Map<number, VerificationInfo>();
  const resolved = rows.filter((b) => RESOLVED_STATUSES.includes(b.status) && b.resolvedAt);
  for (const b of rows) out.set(b.id, { verification: 'n/a', verifiedAt: null });
  if (resolved.length === 0) return out;

  const links = db
    .select({ bugId: bugTestCases.bugId, caseId: bugTestCases.testCaseId })
    .from(bugTestCases)
    .where(
      inArray(
        bugTestCases.bugId,
        resolved.map((b) => b.id),
      ),
    )
    .all();
  const casesByBug = new Map<number, number[]>();
  for (const l of links) casesByBug.set(l.bugId, [...(casesByBug.get(l.bugId) ?? []), l.caseId]);
  const caseIds = [...new Set(links.map((l) => l.caseId))];
  const minResolved = resolved.reduce((m, b) => ((b.resolvedAt ?? '') < m ? (b.resolvedAt ?? m) : m), '9999');

  // results of those cases after the earliest resolvedAt, newest first
  const results = new Map<number, Array<{ runId: number; at: string; status: ResultStatus }>>();
  for (let i = 0; i < caseIds.length; i += 500) {
    for (const r of db
      .select({ caseId: testResults.testCaseId, runId: runs.id, at: runs.sortAt, status: testResults.status })
      .from(testResults)
      .innerJoin(runs, eq(runs.id, testResults.runId))
      .where(and(inArray(testResults.testCaseId, caseIds.slice(i, i + 500)), gt(runs.sortAt, minResolved)))
      .orderBy(desc(runs.sortAt), desc(runs.id))
      .all()) {
      const list = results.get(r.caseId) ?? [];
      const last = list[list.length - 1];
      if (last && last.runId === r.runId) last.status = worse(last.status, r.status);
      else list.push({ runId: r.runId, at: r.at, status: r.status });
      results.set(r.caseId, list);
    }
  }

  for (const b of resolved) {
    const since = b.resolvedAt ?? '';
    let anyFailing = false;
    let allPassed = true;
    let anyResult = false;
    let verifiedAt = '';
    for (const caseId of casesByBug.get(b.id) ?? []) {
      const latest = (results.get(caseId) ?? []).find((r) => r.at > since && r.status !== 'skipped' && r.status !== 'unknown');
      if (!latest) {
        allPassed = false;
        continue;
      }
      anyResult = true;
      if (isFailing(latest.status)) anyFailing = true;
      if (latest.status !== 'passed') allPassed = false;
      if (latest.at > verifiedAt) verifiedAt = latest.at;
    }
    if (anyFailing) out.set(b.id, { verification: 'still_failing', verifiedAt: null });
    else if (anyResult && allPassed) out.set(b.id, { verification: 'verified_fixed', verifiedAt });
    else out.set(b.id, { verification: 'awaiting_run', verifiedAt: null });
  }
  return out;
}

/** A linked bug is "open" for a test case unless closed/wont_fix or verified fixed. */
export function isOpenForCase(status: BugStatus, verification: BugVerification): boolean {
  if (status === 'wont_fix') return false;
  if (status === 'open' || status === 'in_progress') return true;
  if (verification === 'still_failing') return true;
  return status === 'resolved' && verification === 'awaiting_run';
}

const toRef = (b: BugRow, verification: BugVerification): BugRef => ({
  id: b.id,
  jiraKey: b.jiraKey,
  title: b.title,
  url: b.url,
  status: b.status,
  severity: b.severity,
  verification,
});

export function openBugRefsForCases(db: Db, caseIds: number[]): Map<number, BugRef[]> {
  const out = new Map<number, BugRef[]>();
  if (caseIds.length === 0) return out;
  const rows = db
    .select({ caseId: bugTestCases.testCaseId, bug: bugs })
    .from(bugTestCases)
    .innerJoin(bugs, eq(bugs.id, bugTestCases.bugId))
    .where(and(inArray(bugTestCases.testCaseId, caseIds), sql`${bugs.status} <> 'wont_fix'`))
    .orderBy(desc(bugs.createdAt))
    .all();
  if (rows.length === 0) return out;
  const ver = computeVerifications(db, [...new Map(rows.map((r) => [r.bug.id, r.bug])).values()]);
  for (const r of rows) {
    const v = ver.get(r.bug.id)?.verification ?? 'n/a';
    if (!isOpenForCase(r.bug.status, v)) continue;
    out.set(r.caseId, [...(out.get(r.caseId) ?? []), toRef(r.bug, v)]);
  }
  return out;
}

/** Bugs linked to a signature, or linked to every one of the given cases. */
export function bugRefsForFailureGroups(
  db: Db,
  groups: ReadonlyArray<{ signature: string; caseIds: number[] }>,
): Map<string, BugRef[]> {
  const out = new Map<string, BugRef[]>();
  if (groups.length === 0) return out;
  const sigs = groups.map((g) => g.signature);
  const allCases = [...new Set(groups.flatMap((g) => g.caseIds))];
  const bySig = db
    .select({ sig: bugSignatures.signature, bugId: bugSignatures.bugId })
    .from(bugSignatures)
    .where(inArray(bugSignatures.signature, sigs))
    .all();
  const byCase = allCases.length
    ? db
        .select({ caseId: bugTestCases.testCaseId, bugId: bugTestCases.bugId })
        .from(bugTestCases)
        .where(inArray(bugTestCases.testCaseId, allCases))
        .all()
    : [];
  const bugIds = [...new Set([...bySig.map((r) => r.bugId), ...byCase.map((r) => r.bugId)])];
  if (bugIds.length === 0) return out;
  const rows = db.select().from(bugs).where(inArray(bugs.id, bugIds)).all();
  const ver = computeVerifications(db, rows);
  const byId = new Map(rows.map((b) => [b.id, b]));
  const casesOfBug = new Map<number, Set<number>>();
  for (const r of byCase) casesOfBug.set(r.bugId, (casesOfBug.get(r.bugId) ?? new Set()).add(r.caseId));

  for (const g of groups) {
    const ids = new Set(bySig.filter((r) => r.sig === g.signature).map((r) => r.bugId));
    if (g.caseIds.length > 0) {
      for (const [bugId, cases] of casesOfBug) if (g.caseIds.every((c) => cases.has(c))) ids.add(bugId);
    }
    const refs: BugRef[] = [];
    for (const id of ids) {
      const b = byId.get(id);
      if (b) refs.push(toRef(b, ver.get(id)?.verification ?? 'n/a'));
    }
    if (refs.length) out.set(g.signature, refs);
  }
  return out;
}

/** SQL condition on test_cases: has a linked open/in_progress bug, or its last signature is linked to one. */
export function coveredByOpenBug(): SQL {
  return sql`(EXISTS (SELECT 1 FROM ${bugTestCases} INNER JOIN ${bugs} ON ${bugs.id} = ${bugTestCases.bugId} WHERE ${bugTestCases.testCaseId} = ${testCases.id} AND ${bugs.status} IN ('open', 'in_progress'))
    OR (${testCases.lastSignature} IS NOT NULL AND EXISTS (SELECT 1 FROM ${bugSignatures} INNER JOIN ${bugs} ON ${bugs.id} = ${bugSignatures.bugId} WHERE ${bugSignatures.signature} = ${testCases.lastSignature} AND ${bugs.status} IN ('open', 'in_progress'))))`;
}

// ---------------------------------------------------------------------------
// Serialization / queries
// ---------------------------------------------------------------------------

export function serializeBugs(db: Db, rows: BugRow[], ver?: Map<number, VerificationInfo>): Bug[] {
  if (rows.length === 0) return [];
  const ids = rows.map((b) => b.id);
  const verifications = ver ?? computeVerifications(db, rows);
  const cases = new Map<number, Bug['testCases']>();
  for (const r of db
    .select({
      bugId: bugTestCases.bugId,
      id: testCases.id,
      key: testCases.key,
      title: testCases.title,
      lastStatus: testCases.lastStatus,
    })
    .from(bugTestCases)
    .innerJoin(testCases, eq(testCases.id, bugTestCases.testCaseId))
    .where(inArray(bugTestCases.bugId, ids))
    .orderBy(asc(testCases.key))
    .all()) {
    const { bugId, ...tc } = r;
    cases.set(bugId, [...(cases.get(bugId) ?? []), tc]);
  }
  const sigs = new Map<number, string[]>();
  for (const r of db.select().from(bugSignatures).where(inArray(bugSignatures.bugId, ids)).all()) {
    sigs.set(r.bugId, [...(sigs.get(r.bugId) ?? []), r.signature]);
  }
  const runIds = [...new Set(rows.flatMap((b) => (b.foundInRunId ? [b.foundInRunId] : [])))];
  const runInfo = new Map(
    (runIds.length
      ? db.select({ id: runs.id, name: runs.name, runGroup: runs.runGroup }).from(runs).where(inArray(runs.id, runIds)).all()
      : []
    ).map((r) => [r.id, r]),
  );
  return rows.map((b) => ({
    id: b.id,
    jiraKey: b.jiraKey,
    title: b.title,
    url: b.url,
    status: b.status,
    severity: b.severity,
    foundByAutomation: b.foundByAutomation,
    foundInRun: b.foundInRunId ? (runInfo.get(b.foundInRunId) ?? null) : null,
    failureSignatures: sigs.get(b.id) ?? [],
    testCases: cases.get(b.id) ?? [],
    verification: verifications.get(b.id)?.verification ?? 'n/a',
    source: b.source,
    assignee: b.assignee,
    createdAt: b.createdAt,
    updatedAt: b.updatedAt,
    resolvedAt: b.resolvedAt,
  }));
}

export function getBug(db: Db, id: number): Bug {
  const row = db.select().from(bugs).where(eq(bugs.id, id)).get();
  if (!row) throw notFound('Bug');
  const [bug] = serializeBugs(db, [row]);
  if (!bug) throw notFound('Bug');
  return bug;
}

export function listBugs(db: Db, q: BugQuery): { items: Bug[]; total: number } {
  const conds: SQL[] = [];
  if (q.status) conds.push(eq(bugs.status, q.status));
  else if (q.bucket === 'open') conds.push(inArray(bugs.status, [...OPEN_STATUSES]));
  else if (q.bucket === 'resolved') conds.push(inArray(bugs.status, [...RESOLVED_STATUSES]));
  if (q.severity) conds.push(eq(bugs.severity, q.severity));
  if (q.foundByAutomation !== undefined) conds.push(eq(bugs.foundByAutomation, q.foundByAutomation));
  if (q.testCaseId) {
    conds.push(
      sql`EXISTS (SELECT 1 FROM ${bugTestCases} WHERE ${bugTestCases.bugId} = ${bugs.id} AND ${bugTestCases.testCaseId} = ${q.testCaseId})`,
    );
  }
  if (q.search) {
    const p = containsPattern(q.search);
    const s = or(sql`${bugs.title} LIKE ${p} ESCAPE '\\'`, sql`${bugs.jiraKey} LIKE ${p} ESCAPE '\\'`);
    if (s) conds.push(s);
  }
  const where = conds.length ? and(...conds) : undefined;
  const order = [desc(bugs.createdAt), desc(bugs.id)];
  const offset = (q.page - 1) * q.pageSize;

  if (q.verification) {
    // verification is computed, so filter in memory (bug counts are small)
    const all = db.select().from(bugs).where(where).orderBy(...order).limit(10_000).all();
    const ver = computeVerifications(db, all);
    const matching = all.filter((b) => ver.get(b.id)?.verification === q.verification);
    return { items: serializeBugs(db, matching.slice(offset, offset + q.pageSize), ver), total: matching.length };
  }
  const total = db.select({ n: sql<number>`count(*)` }).from(bugs).where(where).get()?.n ?? 0;
  const rows = db.select().from(bugs).where(where).orderBy(...order).limit(q.pageSize).offset(offset).all();
  return { items: serializeBugs(db, rows), total };
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

function assertJiraKeyFree(db: Db, jiraKey: string, exceptId?: number): void {
  const hit = db.select({ id: bugs.id }).from(bugs).where(eq(bugs.jiraKey, jiraKey)).get();
  if (hit && hit.id !== exceptId) throw conflict(`A bug with Jira key ${jiraKey} already exists`, { id: hit.id });
}

function existingCaseIds(db: Db, ids: readonly number[]): number[] {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return [];
  const found = db.select({ id: testCases.id }).from(testCases).where(inArray(testCases.id, unique)).all().map((r) => r.id);
  if (found.length !== unique.length) throw notFound('One or more test cases');
  return found;
}

function replaceLinks(db: Db, bugId: number, caseIds?: readonly number[], signatures?: readonly string[]): void {
  if (caseIds !== undefined) {
    const ids = existingCaseIds(db, caseIds);
    db.delete(bugTestCases).where(eq(bugTestCases.bugId, bugId)).run();
    if (ids.length) db.insert(bugTestCases).values(ids.map((testCaseId) => ({ bugId, testCaseId }))).run();
  }
  if (signatures !== undefined) {
    const sigs = [...new Set(signatures.map((s) => s.trim()).filter(Boolean))];
    db.delete(bugSignatures).where(eq(bugSignatures.bugId, bugId)).run();
    if (sigs.length) db.insert(bugSignatures).values(sigs.map((signature) => ({ bugId, signature }))).run();
  }
}

/** resolvedAt follows status transitions into/out of a terminal state. */
function resolvedAtFor(prev: BugRow | undefined, next: BugStatus, now: string): string | null {
  if (!isTerminal(next)) return null;
  if (prev && isTerminal(prev.status) && prev.resolvedAt) return prev.resolvedAt;
  return now;
}

export function createBug(db: Db, input: BugCreate, source: 'manual' | 'jira' = 'manual'): Bug {
  if (input.jiraKey) assertJiraKeyFree(db, input.jiraKey);
  if (input.foundInRunId && !db.select({ id: runs.id }).from(runs).where(eq(runs.id, input.foundInRunId)).get()) {
    throw notFound('Run');
  }
  const now = nowIso();
  const row = db
    .insert(bugs)
    .values({
      jiraKey: input.jiraKey ?? null,
      title: input.title,
      url: input.url ?? null,
      status: input.status,
      severity: input.severity ?? null,
      foundByAutomation: Boolean(input.foundInRunId) || input.failureSignatures.length > 0,
      foundInRunId: input.foundInRunId ?? null,
      source,
      assignee: input.assignee ?? null,
      createdAt: now,
      updatedAt: now,
      resolvedAt: resolvedAtFor(undefined, input.status, now),
    })
    .returning()
    .get();
  replaceLinks(db, row.id, input.testCaseIds, input.failureSignatures);
  return getBug(db, row.id);
}

export function updateBug(db: Db, id: number, patch: BugUpdate): Bug {
  const current = db.select().from(bugs).where(eq(bugs.id, id)).get();
  if (!current) throw notFound('Bug');
  if (patch.jiraKey && patch.jiraKey !== current.jiraKey) assertJiraKeyFree(db, patch.jiraKey, id);
  const now = nowIso();
  const set: Partial<typeof bugs.$inferInsert> = { updatedAt: now };
  if (patch.title !== undefined) set.title = patch.title;
  if (patch.jiraKey !== undefined) set.jiraKey = patch.jiraKey;
  if (patch.url !== undefined) set.url = patch.url;
  if (patch.severity !== undefined) set.severity = patch.severity;
  if (patch.assignee !== undefined) set.assignee = patch.assignee;
  if (patch.status !== undefined && patch.status !== current.status) {
    set.status = patch.status;
    set.resolvedAt = resolvedAtFor(current, patch.status, now);
  }
  db.update(bugs).set(set).where(eq(bugs.id, id)).run();
  replaceLinks(db, id, patch.testCaseIds, patch.failureSignatures);
  return getBug(db, id);
}

export function deleteBug(db: Db, id: number): void {
  const res = db.delete(bugs).where(eq(bugs.id, id)).run();
  if (res.changes === 0) throw notFound('Bug');
}

// ---------------------------------------------------------------------------
// Auto-create from product_bug notes
// ---------------------------------------------------------------------------

/** Jira-like key at the end of a /browse/ path or in selectedIssue=. */
export function jiraKeyFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    const fromParam = u.searchParams.get('selectedIssue');
    const m =
      (fromParam && /^([A-Z][A-Z0-9_]+-\d+)$/.exec(fromParam)) || /\/browse\/([A-Z][A-Z0-9_]+-\d+)\/?$/.exec(u.pathname);
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * Plain-text bug title from a markdown note: first non-empty line with markdown
 * syntax removed (headings, emphasis, code, links/images, quotes, list markers),
 * whitespace collapsed, max 200 chars. Linear-time (no nested quantifiers).
 */
export function bugTitleFromNote(body: string): string {
  const lines = body.slice(0, 20_000).split(/\r?\n/);
  for (const raw of lines) {
    let l = raw.trim();
    if (!l || /^(```|~~~)/.test(l) || /^([-*_]\s*){3,}$/.test(l)) continue; // fences, rules
    l = l
      .replace(/^>+\s*/, '') // blockquote
      .replace(/^#{1,6}\s+/, '') // heading
      .replace(/^(?:[-*+]|\d{1,9}[.)])\s+/, '') // list marker
      .replace(/^\[[ xX]\]\s+/, '') // task checkbox
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1') // image → alt
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // link → text
      .replace(/<(https?:\/\/[^>\s]+)>/g, '$1') // autolink
      .replace(/`+([^`]*)`+/g, '$1') // inline code
      .replace(/\*{1,3}(?=\S)([^*]*?\S)\*{1,3}/g, '$1') // *em* / **bold**
      .replace(/(^|[^\w])_{1,3}(?=\S)([^_]*?\S)_{1,3}(?!\w)/g, '$1$2') // _em_ / __bold__ (not snake_case)
      .replace(/~~(?=\S)([^~]*?\S)~~/g, '$1') // strikethrough
      .replace(/\s+#+\s*$/, '') // closing heading hashes
      .replace(/\\([\\`*_{}[\]()#+\-.!>~|])/g, '$1') // escapes
      .replace(/\s+/g, ' ')
      .trim();
    if (l) return l.length > 200 ? `${l.slice(0, 199).trimEnd()}…` : l;
  }
  return '';
}

/**
 * Called when a note with triage=product_bug and a Jira ticket URL is created:
 * upsert the bug by jiraKey and link the case (+ the result's signature/run).
 */
export function upsertBugFromNote(
  db: Db,
  note: { testCaseId: number; body: string; ticketUrl: string | null; resultId: number | null; runId: number | null },
): number | null {
  const jiraKey = jiraKeyFromUrl(note.ticketUrl);
  if (!jiraKey) return null;
  let signature: string | null = null;
  let runId = note.runId;
  if (note.resultId) {
    const r = db
      .select({ sig: testResults.failureSignature, runId: testResults.runId })
      .from(testResults)
      .where(eq(testResults.id, note.resultId))
      .get();
    signature = r?.sig ?? null;
    runId = runId ?? r?.runId ?? null;
  }
  const now = nowIso();
  let bug = db.select().from(bugs).where(eq(bugs.jiraKey, jiraKey)).get();
  if (!bug) {
    const title = bugTitleFromNote(note.body) || jiraKey;
    bug = db
      .insert(bugs)
      .values({
        jiraKey,
        title,
        url: note.ticketUrl,
        status: 'open',
        foundByAutomation: Boolean(note.resultId || runId),
        foundInRunId: runId,
        source: 'manual',
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
  } else if (!bug.foundInRunId && runId) {
    db.update(bugs).set({ foundInRunId: runId, foundByAutomation: true, updatedAt: now }).where(eq(bugs.id, bug.id)).run();
  }
  db.insert(bugTestCases).values({ bugId: bug.id, testCaseId: note.testCaseId }).onConflictDoNothing().run();
  if (signature) db.insert(bugSignatures).values({ bugId: bug.id, signature }).onConflictDoNothing().run();
  return bug.id;
}

// ---------------------------------------------------------------------------
// Jira sync hook — for the integrations engineer (src/integrations/jira.ts)
// ---------------------------------------------------------------------------

export interface JiraBugFields {
  jiraKey: string;
  title: string;
  url: string | null;
  status: BugStatus;
  severity: Bug['severity'];
  assignee: string | null;
  /** Jira resolutiondate (ISO) when resolved. */
  resolvedAt: string | null;
  /** Optional: case to link (e.g. from Xray Test issue links). */
  linkTestCaseId?: number;
}

/**
 * JIRA SYNC HOOK: upsert a bug from Jira fields. Keeps manual links/signatures,
 * sets source='jira', maintains resolvedAt. Returns 'created' | 'updated'.
 */
export function upsertBugFromJira(db: Db, f: JiraBugFields): 'created' | 'updated' {
  const now = nowIso();
  const existing = db.select().from(bugs).where(eq(bugs.jiraKey, f.jiraKey)).get();
  const resolvedAt = isTerminal(f.status) ? (f.resolvedAt ?? existing?.resolvedAt ?? now) : null;
  let id: number;
  let outcome: 'created' | 'updated';
  if (existing) {
    db.update(bugs)
      .set({ title: f.title, url: f.url ?? existing.url, status: f.status, severity: f.severity, assignee: f.assignee, resolvedAt, source: 'jira', updatedAt: now })
      .where(eq(bugs.id, existing.id))
      .run();
    id = existing.id;
    outcome = 'updated';
  } else {
    id = db
      .insert(bugs)
      .values({ jiraKey: f.jiraKey, title: f.title, url: f.url, status: f.status, severity: f.severity, assignee: f.assignee, resolvedAt, source: 'jira', createdAt: now, updatedAt: now })
      .returning({ id: bugs.id })
      .get().id;
    outcome = 'created';
  }
  if (f.linkTestCaseId) db.insert(bugTestCases).values({ bugId: id, testCaseId: f.linkTestCaseId }).onConflictDoNothing().run();
  return outcome;
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

function weekStart(d: Date): Date {
  const day = (d.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day));
}

export function bugTrend(db: Db, from: Date, to: Date): BugStats['trend'] {
  const start = weekStart(from);
  const fromIso = start.toISOString();
  const created = db.select({ at: bugs.createdAt }).from(bugs).where(gte(bugs.createdAt, fromIso)).all();
  const resolved = db
    .select({ at: bugs.resolvedAt })
    .from(bugs)
    .where(and(isNotNull(bugs.resolvedAt), gte(bugs.resolvedAt, fromIso)))
    .all();
  const out: BugStats['trend'] = [];
  for (let w = start; w.getTime() <= to.getTime(); w = addDays(w, 7)) {
    const a = w.toISOString();
    const b = addDays(w, 7).toISOString();
    out.push({
      weekStart: isoDate(w),
      found: created.filter((r) => r.at >= a && r.at < b).length,
      resolved: resolved.filter((r) => (r.at ?? '') >= a && (r.at ?? '') < b).length,
    });
  }
  return out;
}

export function openBySeverity(db: Db): BugStats['bySeverity'] {
  const rows = db
    .select({ severity: bugs.severity, n: sql<number>`count(*)` })
    .from(bugs)
    .where(and(inArray(bugs.status, [...OPEN_STATUSES]), isNotNull(bugs.severity)))
    .groupBy(bugs.severity)
    .all();
  return (['critical', 'major', 'minor', 'trivial'] as const).map((severity) => ({
    severity,
    open: rows.find((r) => r.severity === severity)?.n ?? 0,
  }));
}

export function meanDaysToResolve(db: Db, now: Date = new Date()): number | null {
  const since = addDays(now, -90).toISOString();
  const rows = db
    .select({ c: bugs.createdAt, r: bugs.resolvedAt })
    .from(bugs)
    .where(and(isNotNull(bugs.resolvedAt), gte(bugs.resolvedAt, since), inArray(bugs.status, [...RESOLVED_STATUSES])))
    .all();
  if (rows.length === 0) return null;
  const days = rows.map((x) => (Date.parse(x.r ?? '') - Date.parse(x.c)) / 86_400_000);
  return Math.round((days.reduce((a, b) => a + b, 0) / days.length) * 10) / 10;
}

export function getBugStats(db: Db, now: Date = new Date()): BugStats {
  const all = db.select().from(bugs).all();
  const ver = computeVerifications(db, all);
  const count = (pred: (b: BugRow, v: BugVerification) => boolean) =>
    all.filter((b) => pred(b, ver.get(b.id)?.verification ?? 'n/a')).length;
  return {
    open: count((b) => b.status === 'open'),
    inProgress: count((b) => b.status === 'in_progress'),
    resolvedAwaitingVerification: count((_b, v) => v === 'awaiting_run'),
    stillFailingAfterFix: count((_b, v) => v === 'still_failing'),
    verifiedFixed: count((_b, v) => v === 'verified_fixed'),
    bySeverity: openBySeverity(db),
    trend: bugTrend(db, addDays(now, -7 * 25), now),
    meanDaysToResolve: meanDaysToResolve(db, now),
  };
}
