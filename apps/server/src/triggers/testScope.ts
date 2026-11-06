/**
 * Which test scans count for a branch of the trigger repo, the same everywhere (Overview,
 * Report, Triggers):
 *   merged       the test repo's branch of the same name, else its default (main/master/develop)
 *   not merged   PR branches scanned with "Scan open PRs" whose PR targets that merged branch;
 *                for the default line also other branches scanned by hand or from CI. A branch
 *                that is also in the trigger repo, or is main/master/develop, is long-lived and
 *                never counts as not merged.
 */
import { parsePrLabel } from './prLabel.js';

export const MAIN_BRANCHES = ['main', 'master', 'develop'];
export const branchRank = (b: string): number => {
  const i = MAIN_BRANCHES.indexOf(b);
  return i >= 0 ? i : MAIN_BRANCHES.length;
};

export interface ScopeScan {
  id: number;
  branch: string;
  label: string | null;
}

/** `tests`: latest test scan per branch; `routeBranches`: branches with a route scan. */
export function testScope<T extends ScopeScan>(
  branch: string,
  tests: ReadonlyMap<string, T>,
  routeBranches: ReadonlySet<string>,
): { merged: T | null; unmerged: T[] } {
  const defaultTestBranch = [...tests.keys()].sort((a, b) => branchRank(a) - branchRank(b) || a.localeCompare(b))[0] ?? null;
  const base = tests.has(branch) ? branch : defaultTestBranch;
  const merged = base ? tests.get(base)! : null;
  const unmerged = [...tests.values()].filter((s) => {
    if (s === merged) return false;
    const pr = parsePrLabel(s.label);
    // a PR into this branch counts even when the test repo has no branch of that name (its merged tests then come from the default)
    if (pr) return pr.base ? pr.base === branch || pr.base === base : base === defaultTestBranch;
    if (routeBranches.has(s.branch) || MAIN_BRANCHES.includes(s.branch)) return false;
    return base === defaultTestBranch;
  });
  return { merged, unmerged };
}

/** Tests of a not-merged branch that differ from the merged ones: the only ones worth matching. */
export function changedTests<T extends { id: string; strings: string[] }>(merged: readonly T[], other: readonly T[]): T[] {
  const sig = (t: T) => `${t.id}\0${t.strings.join('\u0001')}`;
  const same = new Set(merged.map(sig));
  return other.filter((t) => !same.has(sig(t)));
}
