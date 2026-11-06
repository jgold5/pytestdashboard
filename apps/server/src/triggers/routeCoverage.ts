/**
 * Scope as the source code defines it: once the Camel repo has been scanned, the headline
 * coverage numbers count route triggers, not test cases (spreadsheet, Jira…):
 *   total       = triggers in the default branch's latest route scan
 *   automated   = those a test in the default branch's latest test scan covers
 *   inProgress  = the rest that a test on some other branch (a PR) already covers
 * Reads trigger_scans directly so the coverage module needn't depend on the trigger store.
 */
import { desc, inArray } from 'drizzle-orm';
import type { RouteStatus, ScopeSource, TriggerOverviewQuery, TriggerOverviewResponse, TriggerOverviewRow } from '@ptd/shared';
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
  commit: string | null;
  scannedAt: string;
  /** Every trigger on that branch with its status, sorted by module then route. */
  rows: TriggerOverviewRow[];
  /** Where the two halves came from: the trigger repo's scan and the test repo's scan. */
  triggerRepo: ScopeSource;
  testRepo: (ScopeSource & { tests: number; testsLinked: number }) | null;
}

/** Per database: scan ids only identify a scan within one database. */
const caches = new WeakMap<Db, { key: string; value: RouteCoverage }>();

const firesOn = (t: StoredTrigger): string => t.filePattern ?? t.schedule ?? t.condition ?? t.resolvedUri;

export function routeCoverage(db: Db): RouteCoverage | null {
  // latest scan per branch, separately for route and test scans (light columns first)
  const rows = db
    .select({
      id: triggerScans.id,
      branch: triggerScans.branch,
      files: triggerScans.files,
      commit: triggerScans.commit,
      scannedAt: triggerScans.scannedAt,
      label: triggerScans.label,
    })
    .from(triggerScans)
    .orderBy(desc(triggerScans.scannedAt), desc(triggerScans.id))
    .all();
  const routes = new Map<string, (typeof rows)[number]>();
  const tests = new Map<string, number>();
  const byId = new Map(rows.map((r) => [r.id, r] as const));
  for (const r of rows) {
    if (r.files.xml > 0 && !routes.has(r.branch)) routes.set(r.branch, r);
    if (r.files.tests > 0 && !tests.has(r.branch)) tests.set(r.branch, r.id);
  }
  if (routes.size === 0) return null;
  const [mainBranch, mainScan] = [...routes].sort((a, b) => rank(a[0]) - rank(b[0]))[0]!;
  const mainTests = tests.get(mainBranch) ?? [...tests].sort((a, b) => rank(a[0]) - rank(b[0]))[0]?.[1] ?? null;
  const otherTests = [...tests].filter(([, id]) => id !== mainTests);

  const key = `${mainScan.id}:${mainTests}:${otherTests.map(([, id]) => id).join(',')}`;
  const cached = caches.get(db);
  if (cached?.key === key) return cached.value;

  const ids = [mainScan.id, ...(mainTests ? [mainTests] : []), ...otherTests.map(([, id]) => id)];
  const full = new Map(
    db
      .select({ id: triggerScans.id, triggers: triggerScans.triggers, tests: triggerScans.tests })
      .from(triggerScans)
      .where(inArray(triggerScans.id, ids))
      .all()
      .map((r) => [r.id, r] as const),
  );
  const triggers: StoredTrigger[] = full.get(mainScan.id)?.triggers ?? [];
  const testsOf = (id: number | null): TestLabels[] => (id ? (full.get(id)?.tests ?? []) : []);
  const onMain = coverTriggers(triggers, testsOf(mainTests));
  const onBranch = otherTests.map(([branch, id]) => [branch, coverTriggers(triggers, testsOf(id))] as const);

  let automated = 0;
  let inProgress = 0;
  const out: TriggerOverviewRow[] = triggers.map((t) => {
    const mainCov = onMain.get(t.key) ?? [];
    const branches = onBranch.filter(([, cov]) => (cov.get(t.key)?.length ?? 0) > 0).map(([b]) => b);
    const status: RouteStatus = mainCov.length > 0 ? 'tested' : branches.length > 0 ? 'branch' : 'none';
    if (status === 'tested') automated++;
    else if (status === 'branch') inProgress++;
    return {
      key: t.key,
      routeId: t.routeId,
      module: t.module,
      kind: t.kind,
      scheme: t.scheme,
      firesOn: firesOn(t),
      status,
      tests: [...new Set(mainCov.map((c) => c.test))].slice(0, 3),
      branches,
    };
  });
  const mainTestLabels = testsOf(mainTests);
  const linked = new Set([...onMain.values()].flatMap((cov) => cov.map((c) => c.test)));
  const source = (r: (typeof rows)[number]): ScopeSource => ({ repo: r.label, branch: r.branch, commit: r.commit, scannedAt: r.scannedAt });
  const testScan = mainTests ? byId.get(mainTests) : undefined;
  out.sort((a, b) => (a.module ?? '').localeCompare(b.module ?? '') || (a.routeId ?? a.key).localeCompare(b.routeId ?? b.key));
  const value: RouteCoverage = {
    total: triggers.length,
    automated,
    inProgress,
    branch: mainBranch,
    commit: mainScan.commit,
    scannedAt: mainScan.scannedAt,
    rows: out,
    triggerRepo: source(mainScan),
    testRepo: testScan ? { ...source(testScan), tests: mainTestLabels.length, testsLinked: linked.size } : null,
  };
  caches.set(db, { key, value });
  return value;
}

/** The Overview's route table: one status at a time, the most urgent first by default. */
export function routeOverview(db: Db, q: TriggerOverviewQuery): TriggerOverviewResponse {
  const cov = routeCoverage(db);
  const counts = { tested: cov?.automated ?? 0, branch: cov?.inProgress ?? 0, none: cov ? cov.total - cov.automated - cov.inProgress : 0 };
  const status: RouteStatus = q.status ?? (counts.none > 0 ? 'none' : counts.branch > 0 ? 'branch' : 'tested');
  return {
    triggerRepo: cov ? { ...cov.triggerRepo, triggers: cov.total } : null,
    testRepo: cov?.testRepo ? { ...cov.testRepo, triggersTested: cov.automated } : null,
    branch: cov?.branch ?? null,
    commit: cov?.commit ?? null,
    scannedAt: cov?.scannedAt ?? null,
    counts,
    status,
    items: (cov?.rows ?? []).filter((r) => r.status === status).slice(0, q.limit),
  };
}
