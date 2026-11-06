/**
 * Labels of the scans the GitHub sync makes of the test repo's PR branches:
 * `<repo> PR #<n> → <base>`, where base is the branch the PR targets.
 */
export const prLabel = (repo: string, n: number, base: string) => `${repo} PR #${n} → ${base}`;

const RE = /^(.+) PR #(\d+)(?: → (.+))?$/;

/** For a PR scan label: its repo and target branch (null when the label has none); else null. */
export function parsePrLabel(label: string | null): { repo: string; number: number; base: string | null } | null {
  const m = label ? RE.exec(label) : null;
  return m ? { repo: m[1]!, number: Number(m[2]), base: m[3] ?? null } : null;
}
