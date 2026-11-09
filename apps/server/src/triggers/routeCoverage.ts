/**
 * Scope as the source code defines it: once the Camel repo has been scanned, the headline
 * coverage numbers count route triggers, not test cases (spreadsheet, Jira…):
 *   total       = triggers in the default branch's latest route scan
 *   automated   = those a test in the default branch's latest test scan covers
 *   inProgress  = the rest that a test on some other branch (a PR) already covers
 * Reads trigger_scans directly so the coverage module needn't depend on the trigger store.
 */
import { desc, inArray, sql } from 'drizzle-orm';
import { excludedBy, splitExclude, splitFolders, TriggerKind, type RouteStatus, type ScopeSource, type TriggerOverviewQuery, type TriggerOverviewResponse, type TriggerOverviewRow } from '@ptd/shared';
import type { Db } from '../db/client.js';
import { triggerScans } from '../db/schema.js';
import { changedTests, indexScans, isOutdated, testScope } from './testScope.js';
import { coverTriggers, type StoredTrigger, type TestLabels } from './scan.js';

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
  /** Branches with a route scan, the default first, and the default. */
  routeBranches: string[];
  defaultBranch: string;
  testBranches: string[];
  unmergedFrom: string[];
  looseTestBranches: string[];
  /** Where the two halves came from: the trigger repo's scan and the test repo's scan. */
  triggerRepo: ScopeSource;
  testRepo: (ScopeSource & { tests: number; testsLinked: number }) | null;
  outdated: TriggerOverviewResponse['outdated'];
}

/** Per database (scan ids only identify a scan within one database), one entry per branch counted. */
const caches = new WeakMap<Db, Map<string, { key: string; value: RouteCoverage }>>();

const firesOn = (t: StoredTrigger): string => t.filePattern ?? t.schedule ?? t.condition ?? t.resolvedUri;

/** A route, for counting routes: its id in its module, else (no id) its file and `from` (the key before the pattern part). */
export const routeOf = (r: Pick<TriggerOverviewRow, 'key' | 'module' | 'routeId'>): string =>
  r.routeId ? `${r.module ?? ''}\0${r.routeId}` : (r.key.split('::')[0] as string).replace(/~\d+$/, '').replace(/#\d+$/, '');

/**
 * `branch`: the trigger repo branch to count (falls back to the default when it has no route
 * scan); `testsBranch`: the test repo branch whose merged tests count (default: the same name).
 * Which scans count is decided by testScope.ts.
 */
export function routeCoverage(db: Db, branch?: string, testsBranch?: string): RouteCoverage | null {
  // every scan, newest first (light columns only)
  const rows = db
    .select({
      id: triggerScans.id,
      branch: triggerScans.branch,
      files: triggerScans.files,
      commit: triggerScans.commit,
      scannedAt: triggerScans.scannedAt,
      label: triggerScans.label,
      testsFound: triggerScans.testsFound,
      otherRoutes: triggerScans.otherRoutes,
      triggerCount: sql<number>`json_array_length(${triggerScans.triggers})`,
    })
    .from(triggerScans)
    .orderBy(desc(triggerScans.scannedAt), desc(triggerScans.id))
    .all();
  const idx = indexScans(rows);
  if (!idx.defaultRoutes) return null;
  const byRank = [idx.defaultRoutes, ...[...idx.routes.keys()].filter((b) => b !== idx.defaultRoutes).sort((a, b) => a.localeCompare(b))];
  const defaultBranch = idx.defaultRoutes;
  const mainBranch = branch && idx.routes.has(branch) ? branch : defaultBranch;
  const mainScan = idx.routes.get(mainBranch)!;
  // tests: the test repo branch picked (default: the same name as the routes branch)
  const scope = testScope(testsBranch || mainBranch, idx);
  const testBranches = idx.testBranches;
  const mainTests = scope.merged?.id ?? null;
  const otherTests = scope.unmerged.map((s) => [s.branch, s.id] as const);

  const key = `${mainScan.id}:${mainTests}:${otherTests.map(([, id]) => id).join(',')}:${byRank.join(',')}:${[mainScan, scope.merged, ...scope.unmerged].map((x) => (x && isOutdated(x) ? 1 : 0)).join('')}`;
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
  const testScan = scope.merged ?? undefined;
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
    looseTestBranches: scope.loose,
    triggerRepo: source(mainScan),
    testRepo: testScan ? { ...source(testScan), tests: mainTestLabels.length, testsLinked: linked.size } : null,
    outdated: {
      routes: isOutdated(mainScan) ? mainScan.branch : null,
      tests: testScan && isOutdated(testScan) ? testScan.branch : null,
      prs: scope.unmerged.filter(isOutdated).length,
    },
  };
  perBranch.set(cacheKey, { key, value });
  return value;
}

/** Which triggers count: some folders (none = the whole branch; several joined with commas) and some kinds (none or empty = every kind). */
export interface ScopeFilter {
  folder?: string | null;
  kinds?: readonly TriggerKind[] | null;
  /** Route ids left out (patterns, comma-separated: see excludedBy). */
  exclude?: string | null;
}

/** Whether a route's folder is in a folder pick (`common,ingest`; none = every folder). */
export function inFolders(module: string | null | undefined, folder: string | null | undefined): boolean {
  if (!folder) return true;
  const list = splitFolders(folder);
  return list.length === 0 || (!!module && list.includes(module));
}

export const inScope = (r: Pick<TriggerOverviewRow, 'module' | 'kind' | 'routeId'>, f: ScopeFilter): boolean =>
  inFolders(r.module, f.folder) && (!f.kinds?.length || f.kinds.includes(r.kind)) && !excludedBy(r.routeId, f.exclude);

/** Counts of a branch's triggers, optionally only those in some folders and of some kinds. */
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
function folderCounts(cov: RouteCoverage, kinds: ScopeFilter['kinds'], exclude: ScopeFilter['exclude']): TriggerOverviewResponse['folders'] {
  const by = new Map<string, { triggers: number; tested: number; unmerged: number }>();
  for (const r of cov.rows) {
    if (!r.module || !inScope(r, { kinds, exclude })) continue;
    const f = by.get(r.module) ?? { triggers: 0, tested: 0, unmerged: 0 };
    f.triggers++;
    if (r.status !== 'none') f.tested++;
    if (r.status === 'branch') f.unmerged++;
    by.set(r.module, f);
  }
  return [...by].map(([folder, c]) => ({ folder, ...c })).sort((a, b) => a.folder.localeCompare(b.folder));
}

/** The kinds of trigger in the folders picked (every kind, whichever are picked), in TriggerKind order. */
function kindCounts(cov: RouteCoverage, folder: ScopeFilter['folder'], exclude: ScopeFilter['exclude']): TriggerOverviewResponse['kindCounts'] {
  const by = new Map<TriggerKind, { triggers: number; tested: number }>();
  for (const r of cov.rows) {
    if (!inScope(r, { folder, exclude })) continue;
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
  const filter: ScopeFilter = { folder: q.folder, kinds: q.kinds, exclude: q.exclude };
  const scoped = cov ? scopeCounts(cov, filter) : null;
  const counts = { tested: scoped?.tested ?? 0, branch: scoped?.branch ?? 0, none: scoped?.none ?? 0 };
  const status: RouteStatus = q.status ?? (counts.none > 0 ? 'none' : counts.branch > 0 ? 'branch' : 'tested');
  return {
    routeBranches: cov?.routeBranches ?? [],
    defaultBranch: cov?.defaultBranch ?? null,
    testBranches: cov?.testBranches ?? [],
    unmergedFrom: cov?.unmergedFrom ?? [],
    looseTestBranches: cov?.looseTestBranches ?? [],
    folders: cov ? folderCounts(cov, q.kinds, q.exclude) : [],
    folder: splitFolders(q.folder).join(',') || null,
    kindCounts: cov ? kindCounts(cov, q.folder, q.exclude) : [],
    kinds: q.kinds?.length ? q.kinds : null,
    exclude: splitExclude(q.exclude).join(',') || null,
    fresh: null,
    excluded: cov ? cov.rows.filter((r) => inScope(r, { folder: q.folder, kinds: q.kinds }) && excludedBy(r.routeId, q.exclude)).length : 0,
    outdated: cov?.outdated ?? { routes: null, tests: null, prs: 0 },
    triggerRepo: cov
      ? {
          ...cov.triggerRepo,
          triggers: scoped!.total,
          routes: new Set(cov.rows.filter((r) => inScope(r, filter)).map(routeOf)).size,
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
