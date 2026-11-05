/** Stores trigger scans and answers "what is the scope on this branch, and what changed vs that one". */
import { and, desc, eq, inArray, lt, notInArray } from 'drizzle-orm';
import type { Trigger, TriggerListResponse, TriggerQuery, TriggerRow, TriggerScanFields, TriggerScanResponse, TriggerScanSummary } from '@ptd/shared';
import type { Db } from '../db/client.js';
import { testCases, triggerScans } from '../db/schema.js';
import { badRequest } from '../errors.js';
import type { ScanOutput } from './scan.js';

/** Scans kept per branch (the latest is the branch's scope; older ones are history). */
export const SCANS_KEPT_PER_BRANCH = 20;
/** Branches preferred as the "main" view of a trigger when branches disagree. */
const MAIN_BRANCHES = ['main', 'master', 'develop'];

type ScanRow = typeof triggerScans.$inferSelect;

function summary(r: ScanRow): TriggerScanSummary {
  return {
    id: r.id,
    branch: r.branch,
    commit: r.commit,
    label: r.label,
    scannedAt: r.scannedAt,
    total: r.triggers.length,
    automated: r.triggers.filter((t) => t.coveredBy.length > 0).length,
    files: r.files,
    testsFound: r.testsFound,
    otherRoutes: r.otherRoutes,
  };
}

export function saveScan(
  db: Db,
  fields: TriggerScanFields,
  out: ScanOutput,
  files: TriggerScanSummary['files'],
  now = new Date(),
): TriggerScanResponse {
  const row = db
    .insert(triggerScans)
    .values({
      branch: fields.branch,
      commit: fields.commit ?? null,
      label: fields.label ?? null,
      scannedAt: now.toISOString(),
      triggers: out.triggers,
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
  return { ...summary(row), warnings: out.warnings };
}

/** Latest scan of every branch, newest first. */
function latestScans(db: Db): ScanRow[] {
  const all = db.select().from(triggerScans).orderBy(desc(triggerScans.scannedAt), desc(triggerScans.id)).all();
  const seen = new Set<string>();
  return all.filter((r) => (seen.has(r.branch) ? false : (seen.add(r.branch), true)));
}

/** What a trigger does, for "changed" detection across branches. */
const spec = (t: Trigger): string => JSON.stringify([t.kind, t.resolvedUri]);

/** pytest node id → allure-pytest fullName (`tests/x/test_a.py::TestB::test_c` → `tests.x.test_a.TestB#test_c`). */
function fullNameOf(nodeId: string): string {
  const [file = '', ...rest] = nodeId.split('::');
  const name = rest.pop() ?? '';
  const mod = file.replace(/\.py$/, '').split('/').filter(Boolean).join('.');
  return `${mod}${rest.length ? `.${rest.join('.')}` : ''}#${name}`;
}

/** Link covering tests to dashboard test cases by Allure full name (exact, else a unique suffix match). */
function caseLinker(db: Db): (nodeId: string) => number | null {
  let exact: Map<string, number> | null = null;
  let bySuffix: Map<string, number | null> | null = null;
  return (nodeId) => {
    if (!exact || !bySuffix) {
      exact = new Map();
      bySuffix = new Map();
      for (const c of db.select({ id: testCases.id, fullName: testCases.allureFullName }).from(testCases).all()) {
        if (!c.fullName) continue;
        exact.set(c.fullName, c.id);
        // module + class + name, without the leading package: the repo root and the pytest rootdir may differ
        const hash = c.fullName.lastIndexOf('#');
        const head = c.fullName.slice(0, hash);
        const tailMod = head.split('.').slice(-2).join('.');
        const key = `${tailMod}${c.fullName.slice(hash)}`;
        bySuffix.set(key, bySuffix.has(key) ? null : c.id);
      }
    }
    const full = fullNameOf(nodeId);
    const hit = exact.get(full);
    if (hit !== undefined) return hit;
    const hash = full.lastIndexOf('#');
    const key = `${full.slice(0, hash).split('.').slice(-2).join('.')}${full.slice(hash)}`;
    return bySuffix.get(key) ?? null;
  };
}

export function listTriggers(db: Db, q: TriggerQuery): TriggerListResponse {
  const latest = latestScans(db);
  const byBranch = new Map(latest.map((s) => [s.branch, s]));
  if (q.branch && !byBranch.has(q.branch)) throw badRequest(`No trigger scan for branch "${q.branch}"`);
  if (q.compare && !byBranch.has(q.compare)) throw badRequest(`No trigger scan for branch "${q.compare}"`);

  const branchesOf = new Map<string, string[]>();
  for (const s of latest) for (const t of s.triggers) branchesOf.set(t.key, [...(branchesOf.get(t.key) ?? []), s.branch]);

  let current: Trigger[];
  if (q.branch) current = (byBranch.get(q.branch) as ScanRow).triggers;
  else {
    // every branch merged: one row per trigger, shown as on the main branch (else the newest scan),
    // covered when a test covers it on any branch
    const order = [...latest].sort((a, b) => rank(a.branch) - rank(b.branch));
    const merged = new Map<string, Trigger>();
    for (const s of order) {
      for (const t of s.triggers) {
        const have = merged.get(t.key);
        if (!have) merged.set(t.key, { ...t, coveredBy: [...t.coveredBy] });
        else for (const c of t.coveredBy) if (!have.coveredBy.some((x) => x.test === c.test)) have.coveredBy.push(c);
      }
    }
    current = [...merged.values()];
  }

  const base = q.compare ? new Map((byBranch.get(q.compare) as ScanRow).triggers.map((t) => [t.key, t])) : null;
  const link = caseLinker(db);
  const row = (t: Trigger, change: TriggerRow['change'], before: Trigger | undefined): TriggerRow => ({
    ...t,
    coveredBy: t.coveredBy.map((c) => ({ ...c, testCaseId: link(c.test) })),
    branches: branchesOf.get(t.key) ?? [],
    change,
    automatedBefore: base ? (before ? before.coveredBy.length > 0 : false) : null,
  });

  const items: TriggerRow[] = current.map((t) => {
    if (!base) return row(t, null, undefined);
    const before = base.get(t.key);
    return row(t, !before ? 'added' : spec(before) === spec(t) ? 'unchanged' : 'changed', before);
  });
  if (base) {
    const keys = new Set(current.map((t) => t.key));
    for (const t of base.values()) if (!keys.has(t.key)) items.push(row(t, 'removed', t));
  }
  items.sort((a, b) => (a.routeId ?? a.key).localeCompare(b.routeId ?? b.key));

  return { branches: latest.map(summary), branch: q.branch ?? null, compare: q.compare ?? null, items };
}

function rank(branch: string): number {
  const i = MAIN_BRANCHES.indexOf(branch);
  return i >= 0 ? i : MAIN_BRANCHES.length;
}

/** Delete all scans of a branch (e.g. a merged PR branch). */
export function deleteBranchScans(db: Db, branch: string): number {
  return db.delete(triggerScans).where(inArray(triggerScans.branch, [branch])).run().changes;
}
