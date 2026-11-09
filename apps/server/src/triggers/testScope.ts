/**
 * Which scans count, decided in one place for every page (Overview, Report, Triggers, the
 * coverage trend):
 *
 *   route scan   a scan made with only=routes; for a scan without `only`, one that found routes
 *   test scan    a scan made with only=tests; for a scan without `only`, one that found tests
 *   PR scan      a test scan labelled `<repo> PR #<n> → <base>` (Scan open PRs, or CI on a PR)
 *
 * For a branch of the trigger repo:
 *   merged       the test repo's branch of the same name (or the one picked), else its default
 *   not merged   PR scans whose PR targets that branch (or the merged tests' branch)
 *   not counted  test branches that are neither long-lived nor linked to a PR (scanned by
 *                hand or from CI without a PR label): which branch they would merge into is
 *                unknown, so they never add to the numbers. They are listed so they can be
 *                linked with Scan open PRs.
 *
 * The default branch of a repo: main, master, develop, else the long-lived-looking branch
 * scanned first (a name without `/`), so a PR branch uploaded from CI can't become it.
 */
import { parsePrLabel } from './prLabel.js';

/** Bumped when the scanner's rules change in a way that changes counts: older scans are flagged for a rescan. */
export const SCANNER_VERSION = 4;

export const MAIN_BRANCHES = ['main', 'master', 'develop'];
export const branchRank = (b: string): number => {
  const i = MAIN_BRANCHES.indexOf(b);
  return i >= 0 ? i : MAIN_BRANCHES.length;
};

export interface ScopeScan {
  id: number;
  branch: string;
  label: string | null;
  scannedAt: string;
  files: { xml: number; properties: number; tests: number; only?: 'routes' | 'tests'; scanner?: number };
  /** Triggers found (route scans). */
  triggerCount: number;
  otherRoutes: number;
  testsFound: number;
}

export const isRouteScan = (s: ScopeScan): boolean => (s.files.only ? s.files.only === 'routes' : s.triggerCount > 0 || s.otherRoutes > 0);
export const isTestScan = (s: ScopeScan): boolean => (s.files.only ? s.files.only === 'tests' : s.testsFound > 0);
export const isPrScan = (s: ScopeScan): boolean => parsePrLabel(s.label) !== null;
export const isOutdated = (s: ScopeScan): boolean => (s.files.scanner ?? 1) < SCANNER_VERSION;

export interface ScanIndex<T extends ScopeScan> {
  /** Latest route scan per branch. */
  routes: Map<string, T>;
  /** Latest test scan per branch that isn't a PR scan. */
  tests: Map<string, T>;
  /** Latest PR scan per branch. */
  prs: Map<string, T>;
  /** Default trigger repo branch (null without route scans). */
  defaultRoutes: string | null;
  /** Default test repo branch (null without test scans). */
  defaultTests: string | null;
  /** Long-lived test branches (main/master/develop, or also a trigger repo branch), the default first. */
  testBranches: string[];
}

/** main/master/develop first; then names without `/`; then the branch scanned first; then by name. */
function pickDefault(firstSeen: ReadonlyMap<string, string>, among: Iterable<string>): string | null {
  const list = [...among];
  list.sort(
    (a, b) =>
      branchRank(a) - branchRank(b) ||
      Number(a.includes('/')) - Number(b.includes('/')) ||
      (firstSeen.get(a) ?? '').localeCompare(firstSeen.get(b) ?? '') ||
      a.localeCompare(b),
  );
  return list[0] ?? null;
}

/** `rows`: every scan, newest first. */
export function indexScans<T extends ScopeScan>(rows: readonly T[]): ScanIndex<T> {
  const routes = new Map<string, T>();
  const tests = new Map<string, T>();
  const prs = new Map<string, T>();
  const routesFirst = new Map<string, string>();
  const testsFirst = new Map<string, string>();
  for (const r of rows) {
    if (isRouteScan(r)) {
      if (!routes.has(r.branch)) routes.set(r.branch, r);
      routesFirst.set(r.branch, r.scannedAt); // newest first: the last one seen is the earliest
    }
    if (isTestScan(r)) {
      if (isPrScan(r)) {
        if (!prs.has(r.branch)) prs.set(r.branch, r);
      } else {
        if (!tests.has(r.branch)) tests.set(r.branch, r);
        testsFirst.set(r.branch, r.scannedAt);
      }
    }
  }
  const longLived = (b: string) => routes.has(b) || branchRank(b) < MAIN_BRANCHES.length;
  const defaultRoutes = pickDefault(routesFirst, routes.keys());
  const longTests = [...tests.keys()].filter(longLived);
  const defaultTests = pickDefault(testsFirst, longTests.length ? longTests : tests.keys());
  const testBranches = longTests.sort((a, b) => (a === defaultTests ? -1 : b === defaultTests ? 1 : branchRank(a) - branchRank(b) || a.localeCompare(b)));
  return { routes, tests, prs, defaultRoutes, defaultTests, testBranches };
}

/**
 * The test scans that count for `branch` (the routes branch, or the tests branch picked):
 * its merged tests, the open PRs into it, and the test branches that don't count.
 */
export function testScope<T extends ScopeScan>(branch: string, idx: ScanIndex<T>): { merged: T | null; unmerged: T[]; loose: string[] } {
  const base = idx.tests.has(branch) ? branch : idx.defaultTests;
  const merged = base ? (idx.tests.get(base) ?? null) : null;
  const unmerged = [...idx.prs.values()].filter((s) => {
    if (merged && s.branch === merged.branch) return false;
    const pr = parsePrLabel(s.label)!;
    // a PR into this branch counts even when the test repo has no branch of that name (its merged tests then come from the default)
    return pr.base ? pr.base === branch || pr.base === base : base === idx.defaultTests;
  });
  const loose = [...idx.tests.keys()].filter((b) => b !== base && !idx.prs.has(b) && !idx.testBranches.includes(b));
  return { merged, unmerged, loose };
}

/** Tests of a not-merged branch that differ from the merged ones: the only ones worth matching. */
export function changedTests<T extends { id: string; strings: string[]; labels?: string[] }>(merged: readonly T[], other: readonly T[]): T[] {
  const sig = (t: T) => `${t.id}\0${t.strings.join('\u0001')}\0${(t.labels ?? []).join('\u0001')}`;
  const same = new Set(merged.map(sig));
  return other.filter((t) => !same.has(sig(t)));
}
