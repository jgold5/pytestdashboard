/**
 * Scope as the source code defines it: once the Camel repo has been scanned, the headline
 * coverage numbers count route triggers, not test cases (spreadsheet, Jira…):
 *   total       = triggers in the default branch's latest route scan
 *   automated   = those a test in the default branch's latest test scan covers
 *   inProgress  = the rest that a test on some other branch (a PR) already covers
 * Reads trigger_scans directly so the coverage module needn't depend on the trigger store.
 */
import { desc, inArray } from 'drizzle-orm';
import { TriggerKind, type RouteStatus, type ScopeSource, type TriggerOverviewQuery, type TriggerOverviewResponse, type TriggerOverviewRow } from '@ptd/shared';
import type { Db } from '../db/client.js';
import { triggerScans } from '../db/schema.js';
import { parsePrLabel } from './prLabel.js';
import { changedTests, testScope } from './testScope.js';
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
  /** Branches with a route scan, the default first, and the default (main/master/develop if scanned). */
  routeBranches: string[];
  defaultBranch: string;
  testBranches: string[];
  unmergedFrom: string[];
  looseTestBranches: string[];
  /** Where the two halves came from: the trigger repo's scan and the test repo's scan. */
  triggerRepo: ScopeSource;
  testRepo: (ScopeSource & { tests: number; testsLinked: number }) | null;
}

/** Per database (scan ids only identify a scan within one database), one entry per branch counted. */
const caches = new WeakMap<Db, Map<string, { key: string; value: RouteCoverage }>>();

const firesOn = (t: StoredTrigger): string => t.filePattern ?? t.schedule ?? t.condition ?? t.resolvedUri;

/**
 * `branch`: the trigger repo branch to count (falls back to the default when it has no route
 * scan). Its merged tests come from the same branch of the test repo, else from the test repo's
 * default branch. Not merged yet:
 *   - PR branches the GitHub sync scanned, only for the branch their PR targets;
 *   - other branches scanned by hand or from CI, only for the default line. A branch that is
 *     also scanned in the trigger repo, or is main/master/develop, is long-lived: never counted.
 */
export function routeCoverage(db: Db, branch?: string, testsBranch?: string): RouteCoverage | null {
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
  const testRows = new Map<string, (typeof rows)[number]>();
  const byId = new Map(rows.map((r) => [r.id, r] as const));
  for (const r of rows) {
    if (r.files.xml > 0 && !routes.has(r.branch)) routes.set(r.branch, r);
    if (r.files.tests > 0 && !testRows.has(r.branch)) testRows.set(r.branch, r);
  }
  if (routes.size === 0) return null;
  const byRank = [...routes.keys()].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  const defaultBranch = byRank[0]!;
  const mainBranch = branch && routes.has(branch) ? branch : defaultBranch;
  const mainScan = routes.get(mainBranch)!;
  // tests: the test repo branch picked (default: the same name as the routes branch)
  const scope = testScope(testsBranch || mainBranch, testRows, new Set(routes.keys()));
  // long-lived test branches only: the default ones and those also in the trigger repo (not PR or hand-scanned feature branches)
  const testBranches = [...testRows.values()]
    .filter((r) => !parsePrLabel(r.label) && (routes.has(r.branch) || rank(r.branch) < MAIN_BRANCHES.length))
    .map((r) => r.branch)
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  const mainTests = scope.merged?.id ?? null;
  const otherTests = scope.unmerged.map((s) => [s.branch, s.id] as const);

  const key = `${mainScan.id}:${mainTests}:${otherTests.map(([, id]) => id).join(',')}:${byRank.join(',')}`;
  let perBranch = caches.get(db);
  if (!perBranch) caches.set(db, (perBranch = new Map()));
  const cacheKey = `${mainBranch}\0${testsBranch ?? ''}`;
  const cached = perBranch.get(cacheKey);
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
  // a PR branch is mostly the same tests as the merged branch: only its changed ones are matched
  const onBranch = otherTests.map(([branch, id]) => [branch, coverTriggers(triggers, changedTests(testsOf(mainTests), testsOf(id)))] as const);

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
    routeBranches: byRank,
    defaultBranch,
    testBranches,
    unmergedFrom: otherTests.map(([b]) => b),
    looseTestBranches: [...testRows.values()]
      .filter((r) => !parsePrLabel(r.label) && !routes.has(r.branch) && rank(r.branch) === MAIN_BRANCHES.length)
      .map((r) => r.branch),
    triggerRepo: source(mainScan),
    testRepo: testScan ? { ...source(testScan), tests: mainTestLabels.length, testsLinked: linked.size } : null,
  };
  perBranch.set(cacheKey, { key, value });
  return value;
}

/** Which triggers count: one folder (none = the whole branch) and some kinds (none or empty = every kind). */
export interface ScopeFilter {
  folder?: string | null;
  kinds?: readonly TriggerKind[] | null;
}

export const inScope = (r: TriggerOverviewRow, f: ScopeFilter): boolean =>
  (!f.folder || r.module === f.folder) && (!f.kinds?.length || f.kinds.includes(r.kind));

/** Counts of a branch's triggers, optionally only those in one folder and of some kinds. */
export function scopeCounts(cov: RouteCoverage, filter: ScopeFilter = {}): { total: number; tested: number; branch: number; none: number } {
  const rows = cov.rows.filter((r) => inScope(r, filter));
  let tested = 0;
  let branch = 0;
  for (const r of rows) {
    if (r.status === 'tested') tested++;
    else if (r.status === 'branch') branch++;
  }
  return { total: rows.length, tested, branch, none: rows.length - tested - branch };
}

/** The branch's folders with their counts (tested = merged or not), of the kinds picked. */
function folderCounts(cov: RouteCoverage, kinds: ScopeFilter['kinds']): TriggerOverviewResponse['folders'] {
  const by = new Map<string, { triggers: number; tested: number; unmerged: number }>();
  for (const r of cov.rows) {
    if (!r.module || !inScope(r, { kinds })) continue;
    const f = by.get(r.module) ?? { triggers: 0, tested: 0, unmerged: 0 };
    f.triggers++;
    if (r.status !== 'none') f.tested++;
    if (r.status === 'branch') f.unmerged++;
    by.set(r.module, f);
  }
  return [...by].map(([folder, c]) => ({ folder, ...c })).sort((a, b) => a.folder.localeCompare(b.folder));
}

/** The kinds of trigger in the folder picked (every kind, whichever are picked), in TriggerKind order. */
function kindCounts(cov: RouteCoverage, folder: ScopeFilter['folder']): TriggerOverviewResponse['kindCounts'] {
  const by = new Map<TriggerKind, { triggers: number; tested: number }>();
  for (const r of cov.rows) {
    if (!inScope(r, { folder })) continue;
    const k = by.get(r.kind) ?? { triggers: 0, tested: 0 };
    k.triggers++;
    if (r.status !== 'none') k.tested++;
    by.set(r.kind, k);
  }
  return TriggerKind.options.filter((k) => by.has(k)).map((kind) => ({ kind, ...by.get(kind)! }));
}

/** The Overview's route table: one status at a time, the most urgent first by default. */
export function routeOverview(db: Db, q: TriggerOverviewQuery): TriggerOverviewResponse {
  const cov = routeCoverage(db, q.branch, q.tests);
  const filter: ScopeFilter = { folder: q.folder, kinds: q.kinds };
  const scoped = cov ? scopeCounts(cov, filter) : null;
  const counts = { tested: scoped?.tested ?? 0, branch: scoped?.branch ?? 0, none: scoped?.none ?? 0 };
  const status: RouteStatus = q.status ?? (counts.none > 0 ? 'none' : counts.branch > 0 ? 'branch' : 'tested');
  return {
    routeBranches: cov?.routeBranches ?? [],
    defaultBranch: cov?.defaultBranch ?? null,
    testBranches: cov?.testBranches ?? [],
    unmergedFrom: cov?.unmergedFrom ?? [],
    looseTestBranches: cov?.looseTestBranches ?? [],
    folders: cov ? folderCounts(cov, q.kinds) : [],
    folder: q.folder ?? null,
    kindCounts: cov ? kindCounts(cov, q.folder) : [],
    kinds: q.kinds?.length ? q.kinds : null,
    triggerRepo: cov
      ? {
          ...cov.triggerRepo,
          triggers: scoped!.total,
          routes: new Set(cov.rows.filter((r) => inScope(r, filter)).map((r) => `${r.module ?? ''}\0${r.routeId ?? r.key}`)).size,
        }
      : null,
    testRepo: cov?.testRepo ? { ...cov.testRepo, triggersTested: scoped!.tested } : null,
    branch: cov?.branch ?? null,
    commit: cov?.commit ?? null,
    scannedAt: cov?.scannedAt ?? null,
    counts,
    status,
    items: (cov?.rows ?? []).filter((r) => r.status === status && inScope(r, filter)).slice(0, q.limit),
  };
}
