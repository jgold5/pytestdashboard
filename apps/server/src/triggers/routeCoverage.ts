/**
 * Scope as the source code defines it: once the Camel repo has been scanned, the headline
 * coverage numbers count route triggers, not test cases (spreadsheet, Jira…):
 *   total       = triggers in the default branch's latest route scan
 *   automated   = those a test in the default branch's latest test scan covers
 *   inProgress  = the rest that a test on some other branch (a PR) already covers
 * Reads trigger_scans directly so the coverage module needn't depend on the trigger store.
 */
import { desc, inArray } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { triggerScans } from '../db/schema.js';
import { coverTriggers, type StoredTrigger, type TestLabels } from './scan.js';

const MAIN_BRANCHES = ['main', 'master', 'develop'];
const rank = (b: string): number => {
  const i = MAIN_BRANCHES.indexOf(b);
  return i >= 0 ? i : MAIN_BRANCHES.length;
};

export interface RouteCoverage {
  total: number;
  automated: number;
  inProgress: number;
  /** Branch whose route scan defines the scope. */
  branch: string;
}

/** Per database: scan ids only identify a scan within one database. */
const caches = new WeakMap<Db, { key: string; value: RouteCoverage }>();

export function routeCoverage(db: Db): RouteCoverage | null {
  // latest scan per branch, separately for route and test scans (light columns first)
  const rows = db
    .select({ id: triggerScans.id, branch: triggerScans.branch, files: triggerScans.files })
    .from(triggerScans)
    .orderBy(desc(triggerScans.scannedAt), desc(triggerScans.id))
    .all();
  const routes = new Map<string, number>();
  const tests = new Map<string, number>();
  for (const r of rows) {
    if (r.files.xml > 0 && !routes.has(r.branch)) routes.set(r.branch, r.id);
    if (r.files.tests > 0 && !tests.has(r.branch)) tests.set(r.branch, r.id);
  }
  if (routes.size === 0) return null;
  const byRank = (m: Map<string, number>) => [...m].sort((a, b) => rank(a[0]) - rank(b[0]))[0];
  const [mainBranch, mainRoutesId] = byRank(routes)!;
  const mainTests = tests.get(mainBranch) ?? byRank(tests)?.[1] ?? null;
  const otherTests = [...tests].filter(([, id]) => id !== mainTests).map(([, id]) => id);

  const key = `${mainRoutesId}:${mainTests}:${otherTests.join(',')}`;
  const cached = caches.get(db);
  if (cached?.key === key) return cached.value;

  const ids = [mainRoutesId, ...(mainTests ? [mainTests] : []), ...otherTests];
  const full = new Map(
    db
      .select({ id: triggerScans.id, triggers: triggerScans.triggers, tests: triggerScans.tests })
      .from(triggerScans)
      .where(inArray(triggerScans.id, ids))
      .all()
      .map((r) => [r.id, r] as const),
  );
  const triggers: StoredTrigger[] = full.get(mainRoutesId)?.triggers ?? [];
  const testsOf = (id: number | null): TestLabels[] => (id ? (full.get(id)?.tests ?? []) : []);
  const onMain = coverTriggers(triggers, testsOf(mainTests));
  const onBranches = coverTriggers(triggers, otherTests.flatMap(testsOf));
  let automated = 0;
  let inProgress = 0;
  for (const t of triggers) {
    if ((onMain.get(t.key)?.length ?? 0) > 0) automated++;
    else if ((onBranches.get(t.key)?.length ?? 0) > 0) inProgress++;
  }
  const value = { total: triggers.length, automated, inProgress, branch: mainBranch };
  caches.set(db, { key, value });
  return value;
}
