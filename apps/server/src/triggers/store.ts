/**
 * Stores trigger scans and answers "what is the scope on this branch, how much of it
 * is automated, and what changed vs that branch".
 *
 * Routes and tests usually live in different repos, so a scan may hold routes, tests
 * or both. Coverage is matched when read: the branch's latest route scan (else the
 * default branch's) against its latest test scan (else the default branch's).
 */
import { and, desc, eq, inArray, lt, notInArray, or } from 'drizzle-orm';
import type { Trigger, TriggerListResponse, TriggerQuery, TriggerRow, TriggerScanFields, TriggerScanResponse, TriggerScanSummary } from '@ptd/shared';
import type { Db } from '../db/client.js';
import { testCases, triggerScans } from '../db/schema.js';
import { recordCoverageSnapshot } from '../domain/coverage.js';
import { badRequest } from '../errors.js';
import { coverTriggers, type ScanOutput, type StoredTrigger, type TestLabels } from './scan.js';

/** Scans kept per branch (the latest is the branch's scope; older ones are history). */
export const SCANS_KEPT_PER_BRANCH = 20;
/** Branches preferred as the default when a branch has no scan of its own. */
const MAIN_BRANCHES = ['main', 'master', 'develop'];

type ScanRow = typeof triggerScans.$inferSelect;
type Covered = TriggerRow['coveredBy'];
/** Fields that scans stored before they existed lack. */
const LEGACY_DEFAULTS = { patternKind: null, condition: null, target: null, input: 1, module: null, doneFile: null } as const;

const hasRoutes = (r: ScanRow): boolean => r.files.xml > 0;
const hasTests = (r: ScanRow): boolean => r.files.tests > 0;

function summary(r: ScanRow): TriggerScanSummary {
  return {
    id: r.id,
    branch: r.branch,
    commit: r.commit,
    label: r.label,
    scannedAt: r.scannedAt,
    total: r.triggers.length,
    files: r.files,
    testsFound: r.testsFound,
    otherRoutes: r.otherRoutes,
  };
}

export function saveScan(db: Db, fields: TriggerScanFields, out: ScanOutput, files: TriggerScanSummary['files'], now = new Date()): TriggerScanResponse {
  const row = db
    .insert(triggerScans)
    .values({
      branch: fields.branch,
      commit: fields.commit ?? null,
      label: fields.label ?? null,
      scannedAt: now.toISOString(),
      triggers: out.triggers.map((t) => ({ ...t, coveredBy: [] })),
      tests: out.tests,
      testsFound: out.testsFound,
      otherRoutes: out.otherRoutes,
      files,
    })
    .returning()
    .get();
  const keep = db
    .select({ id: triggerScans.id })
    .from(triggerScans)
    .where(eq(triggerScans.branch, fields.branch))
    .orderBy(desc(triggerScans.scannedAt), desc(triggerScans.id))
    .limit(SCANS_KEPT_PER_BRANCH)
    .all()
    .map((r) => r.id);
  db.delete(triggerScans)
    .where(and(eq(triggerScans.branch, fields.branch), notInArray(triggerScans.id, keep), lt(triggerScans.id, row.id)))
    .run();
  const cases = files.tests > 0 && rank(fields.branch) < MAIN_BRANCHES.length ? markAutomatedFromRepo(db, out.tests, now) : null;
  const view = listTriggers(db, { branch: fields.branch });
  return { ...summary(row), automated: view.items.filter((t) => t.coveredBy.length > 0).length, cases, warnings: out.warnings };
}

/**
 * The test repo's default branch is the source of truth for what is automated: a test that
 * names a case's Jira/Xray key (in a comment, docstring, marker or string) marks that case
 * automated. Never downgrades: a case whose key disappears from the repo keeps its status.
 */
export function markAutomatedFromRepo(db: Db, tests: readonly TestLabels[], now = new Date()): { referenced: number; newlyAutomated: number } {
  const keys = [...new Set(tests.flatMap((t) => t.keys ?? []))];
  if (keys.length === 0) return { referenced: 0, newlyAutomated: 0 };
  const found = new Map<number, string>();
  for (let i = 0; i < keys.length; i += 500) {
    const chunk = keys.slice(i, i + 500);
    for (const c of db
      .select({ id: testCases.id, status: testCases.automationStatus })
      .from(testCases)
      .where(or(inArray(testCases.jiraKey, chunk), inArray(testCases.key, chunk)))
      .all())
      found.set(c.id, c.status);
  }
  const promote = [...found].filter(([, st]) => st === 'not_automated' || st === 'in_progress').map(([id]) => id);
  const at = now.toISOString();
  for (let i = 0; i < promote.length; i += 500) {
    db.update(testCases)
      .set({ automationStatus: 'automated', automatedAt: at, automatedVia: 'repo_scan', updatedAt: at })
      .where(inArray(testCases.id, promote.slice(i, i + 500)))
      .run();
  }
  if (promote.length > 0) recordCoverageSnapshot(db);
  return { referenced: found.size, newlyAutomated: promote.length };
}

const rank = (branch: string): number => {
  const i = MAIN_BRANCHES.indexOf(branch);
  return i >= 0 ? i : MAIN_BRANCHES.length;
};

interface Latest {
  /** Every branch's latest scan, newest first. */
  all: ScanRow[];
  routes: Map<string, ScanRow>;
  tests: Map<string, ScanRow>;
}

/** Latest scan per branch, separately for route scans and test scans (a scan of both repos counts for both). */
function latestScans(db: Db): Latest {
  const rows = db.select().from(triggerScans).orderBy(desc(triggerScans.scannedAt), desc(triggerScans.id)).all();
  const routes = new Map<string, ScanRow>();
  const tests = new Map<string, ScanRow>();
  const all = new Map<string, ScanRow>();
  for (const r of rows) {
    if (!all.has(r.branch)) all.set(r.branch, r);
    if (hasRoutes(r) && !routes.has(r.branch)) routes.set(r.branch, r);
    if (hasTests(r) && !tests.has(r.branch)) tests.set(r.branch, r);
  }
  return { all: [...all.values()], routes, tests };
}

/** The branch's own scan, else the default branch's (main, master, develop, then the newest). */
function pick(scans: Map<string, ScanRow>, branch: string): ScanRow | null {
  const own = scans.get(branch);
  if (own) return own;
  return [...scans.values()].sort((a, b) => rank(a.branch) - rank(b.branch))[0] ?? null;
}

/** Matching is the costly part with thousands of triggers: cache it per (route scan, test scans). */
const coverageCache = new Map<string, Map<string, Covered>>();
function coverage(routes: ScanRow, tests: readonly TestLabels[], testsKey: string): Map<string, Covered> {
  const key = `${routes.id}:${testsKey}`;
  let hit = coverageCache.get(key);
  if (!hit) {
    hit = coverTriggers(routes.triggers, tests);
    coverageCache.set(key, hit);
    if (coverageCache.size > 32) coverageCache.delete(coverageCache.keys().next().value as string);
  }
  return hit;
}

/** What a trigger does, for "changed" detection across branches. */
const spec = (t: Trigger): string => JSON.stringify([t.kind, t.resolvedUri, t.filePattern, t.condition]);

/** pytest node id → allure-pytest fullName (`tests/x/test_a.py::TestB::test_c` → `tests.x.test_a.TestB#test_c`). */
function fullNameOf(nodeId: string): string {
  const [file = '', ...rest] = nodeId.split('::');
  const name = rest.pop() ?? '';
  const mod = file.replace(/\.py$/, '').split('/').filter(Boolean).join('.');
  return `${mod}${rest.length ? `.${rest.join('.')}` : ''}#${name}`;
}

/** Link covering tests to dashboard test cases by Allure full name (exact, else a unique module + name suffix). */
function caseLinker(db: Db): (nodeId: string) => number | null {
  let exact: Map<string, number> | null = null;
  let bySuffix: Map<string, number | null> | null = null;
  const suffix = (full: string): string => {
    const hash = full.lastIndexOf('#');
    return `${full.slice(0, hash).split('.').slice(-2).join('.')}${full.slice(hash)}`;
  };
  return (nodeId) => {
    if (!exact || !bySuffix) {
      exact = new Map();
      bySuffix = new Map();
      for (const c of db.select({ id: testCases.id, fullName: testCases.allureFullName }).from(testCases).all()) {
        if (!c.fullName) continue;
        exact.set(c.fullName, c.id);
        // the test repo root and the pytest rootdir may differ
        const key = suffix(c.fullName);
        bySuffix.set(key, bySuffix.has(key) ? null : c.id);
      }
    }
    const full = fullNameOf(nodeId);
    return exact.get(full) ?? bySuffix.get(suffix(full)) ?? null;
  };
}

interface View {
  triggers: StoredTrigger[];
  testsRead: number;
  covered: Map<string, Covered>;
  routesFrom: string | null;
  testsFrom: string | null;
}

function viewOf(latest: Latest, branch: string): View {
  const routes = pick(latest.routes, branch);
  const tests = pick(latest.tests, branch);
  const testsRead = tests?.tests.length ?? 0;
  if (!routes) return { triggers: [], testsRead, covered: new Map(), routesFrom: null, testsFrom: tests?.branch ?? null };
  return {
    triggers: routes.triggers,
    testsRead,
    covered: coverage(routes, tests?.tests ?? [], String(tests?.id ?? 0)),
    routesFrom: routes.branch,
    testsFrom: tests?.branch ?? null,
  };
}

/** Every branch merged: one row per trigger (as on the default branch, else the newest), covered by any branch's tests. */
function mergedView(latest: Latest): View {
  const order = [...latest.routes.values()].sort((a, b) => rank(a.branch) - rank(b.branch));
  const testScans = [...latest.tests.values()];
  const allTests = testScans.flatMap((s) => s.tests);
  const testsKey = `all:${testScans.map((s) => s.id).join(',')}`;
  const triggers = new Map<string, StoredTrigger>();
  const covered = new Map<string, Covered>();
  for (const s of order) {
    const c = coverage(s, allTests, testsKey);
    for (const t of s.triggers) {
      if (!triggers.has(t.key)) triggers.set(t.key, t);
      const have = covered.get(t.key) ?? [];
      for (const x of c.get(t.key) ?? []) if (!have.some((h) => h.test === x.test)) have.push(x);
      covered.set(t.key, have);
    }
  }
  return { triggers: [...triggers.values()], testsRead: new Set(allTests.map((t) => t.id)).size, covered, routesFrom: null, testsFrom: null };
}

export function listTriggers(db: Db, q: TriggerQuery): TriggerListResponse {
  const latest = latestScans(db);
  const known = new Set(latest.all.map((s) => s.branch));
  if (q.branch && !known.has(q.branch)) throw badRequest(`No trigger scan for branch "${q.branch}"`);
  if (q.compare && !known.has(q.compare)) throw badRequest(`No trigger scan for branch "${q.compare}"`);

  const branchesOf = new Map<string, string[]>();
  for (const s of latest.routes.values()) for (const t of s.triggers) branchesOf.set(t.key, [...(branchesOf.get(t.key) ?? []), s.branch]);

  const head = q.branch ? viewOf(latest, q.branch) : mergedView(latest);
  const base = q.compare ? viewOf(latest, q.compare) : null;
  const baseByKey = base ? new Map(base.triggers.map((t) => [t.key, t])) : null;
  const link = caseLinker(db);
  const row = (t: StoredTrigger, covered: Covered, change: TriggerRow['change'], before: StoredTrigger | undefined): TriggerRow => {
    const { match: _match, ...api } = t;
    return {
      ...LEGACY_DEFAULTS,
      ...api,
      coveredBy: covered.map((c) => ({ ...c, testCaseId: link(c.test) })),
      branches: branchesOf.get(t.key) ?? [],
      change,
      automatedBefore: base ? (before ? (base.covered.get(before.key)?.length ?? 0) > 0 : false) : null,
    };
  };

  const items: TriggerRow[] = head.triggers.map((t) => {
    const covered = head.covered.get(t.key) ?? [];
    if (!baseByKey) return row(t, covered, null, undefined);
    const before = baseByKey.get(t.key);
    return row(t, covered, !before ? 'added' : spec(before) === spec(t) ? 'unchanged' : 'changed', before);
  });
  if (base && baseByKey) {
    const keys = new Set(head.triggers.map((t) => t.key));
    for (const t of baseByKey.values()) if (!keys.has(t.key)) items.push(row(t, base.covered.get(t.key) ?? [], 'removed', t));
  }
  items.sort((a, b) => (a.module ?? '').localeCompare(b.module ?? '') || (a.routeId ?? a.key).localeCompare(b.routeId ?? b.key));

  return {
    branches: latest.all.map(summary),
    branch: q.branch ?? null,
    compare: q.compare ?? null,
    routesFrom: head.routesFrom,
    testsFrom: head.testsFrom,
    compareRoutesFrom: base?.routesFrom ?? null,
    compareTestsFrom: base?.testsFrom ?? null,
    tests: { read: head.testsRead, linked: new Set([...head.covered.values()].flat().map((c) => c.test)).size },
    items,
  };
}

/** Delete all scans of a branch (e.g. a merged PR branch). */
export function deleteBranchScans(db: Db, branch: string): number {
  return db.delete(triggerScans).where(inArray(triggerScans.branch, [branch])).run().changes;
}
