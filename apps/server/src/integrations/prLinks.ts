/**
 * PR → test case linking rules (SPEC "GitHub"), pure functions:
 * 1. Jira key (`[A-Z][A-Z0-9_]+-\d+`) equal to a case's jiraKey/key in the
 *    PR title → key_in_title, body → key_in_body, head branch → key_in_branch.
 * 2. Added diff lines with markers @allure.id("X"), @allure.testcase(…X…),
 *    @pytest.mark.xray("X"), @pytest.mark.jira("X"), @allure.link(…X…)
 *    where X equals a case's allureId/jiraKey/key → marker_in_diff.
 * 3. Added `def test_<name>(` where <name> is the last segment of a case's
 *    allureFullName/key, in a file whose path matches the case's module when
 *    that is determinable → test_name_in_diff.
 * 4. Any other added line in a test file (comment, docstring, string) that
 *    names a case's jiraKey/key, e.g. `# Xray: ABC-123` → key_in_test_diff.
 */
import type { LinkedBy } from '../db/schema.js';

export interface LinkableCase {
  id: number;
  key: string;
  jiraKey: string | null;
  allureId: string | null;
  allureFullName: string | null;
}

export interface PrFile {
  filename: string;
  patch?: string | null;
}

export interface PrForLinking {
  title: string;
  body: string | null;
  headBranch: string | null;
  /** Only files that already passed the test-path globs. */
  files: PrFile[];
}

export interface CaseLink {
  testCaseId: number;
  linkedBy: LinkedBy;
}

/**
 * Input caps — PR titles, bodies, branches and diffs are attacker-controlled
 * (anyone who can open a PR, incl. fork PRs on public repos). All scanning
 * below is linear and bounded; inputs are truncated before matching.
 */
export const LINK_LIMITS = {
  maxTitleChars: 1024,
  maxBodyChars: 64 * 1024,
  maxBranchChars: 512,
  /** Added diff lines longer than this are skipped (minified/generated content). */
  maxLineChars: 2048,
  /** Per-file patch text inspected. */
  maxPatchChars: 256 * 1024,
  /** Max chars between a marker's "(" and its ")". */
  maxMarkerArgs: 512,
  /** Links kept per PR (strongest kinds first). */
  maxLinksPerPr: 50,
} as const;

// Bounded quantifiers only: each match attempt does O(1) work → linear overall.
const JIRA_KEY_G = /\b[A-Z][A-Z0-9_]{1,50}-\d{1,12}\b/g;
const DEF_TEST_G = /\bdef[ \t]{1,16}(test_\w{1,200})[ \t]{0,16}\(/g;
const MARKER_PREFIXES = [
  'allure.id',
  'allure.testcase',
  'allure.link',
  'pytest.mark.xray',
  'pytest.mark.jira',
];

/** Strongest first — used to pick which links survive the per-PR cap. */
export const LINK_STRENGTH: readonly LinkedBy[] = [
  'marker_in_diff',
  'test_name_in_diff',
  'key_in_test_diff',
  'key_in_branch',
  'key_in_title',
  'key_in_body',
];

interface CaseName {
  id: number;
  /** Module path segments (e.g. ['tests','api','test_users','TestX']), null when not determinable. */
  moduleSegs: string[] | null;
}

export class CaseIndex {
  private readonly byKeyOrJira = new Map<string, Set<number>>();
  private readonly byMarker = new Map<string, Set<number>>();
  private readonly byTestName = new Map<string, CaseName[]>();

  constructor(cases: readonly LinkableCase[]) {
    for (const c of cases) {
      add(this.byKeyOrJira, c.key, c.id);
      if (c.jiraKey) add(this.byKeyOrJira, c.jiraKey, c.id);
      add(this.byMarker, c.key, c.id);
      if (c.jiraKey) add(this.byMarker, c.jiraKey, c.id);
      if (c.allureId) add(this.byMarker, c.allureId, c.id);
      const seen = new Set<string>();
      for (const name of [c.allureFullName, c.key]) {
        if (!name) continue;
        const parsed = parseTestName(name);
        if (!parsed || seen.has(parsed.test)) continue;
        seen.add(parsed.test);
        const list = this.byTestName.get(parsed.test) ?? [];
        list.push({ id: c.id, moduleSegs: parsed.moduleSegs });
        this.byTestName.set(parsed.test, list);
      }
    }
  }

  keyMatches(text: string | null, opts: { caseInsensitive?: boolean } = {}): number[] {
    if (!text) return [];
    const src = opts.caseInsensitive ? text.toUpperCase() : text;
    const out: number[] = [];
    for (const m of src.matchAll(JIRA_KEY_G))
      for (const id of this.byKeyOrJira.get(m[0]) ?? []) out.push(id);
    return out;
  }

  markerMatches(token: string): Iterable<number> {
    return this.byMarker.get(token) ?? [];
  }

  testNameMatches(testName: string, filePath: string): number[] {
    const out: number[] = [];
    for (const c of this.byTestName.get(testName) ?? []) {
      if (c.moduleSegs === null || moduleMatchesPath(c.moduleSegs, filePath)) out.push(c.id);
    }
    return out;
  }
}

function add(map: Map<string, Set<number>>, k: string, id: number): void {
  const s = map.get(k) ?? new Set<number>();
  s.add(id);
  map.set(k, s);
}

/**
 * `tests.api.test_users.TestX#test_ok` → test_ok, module [tests,api,test_users,TestX]
 * `tests/api/test_users.py::TestX::test_ok[param]` → test_ok, module [tests,api,test_users,TestX]
 * `module.test_ok` → test_ok, module not determinable (null)
 */
export function parseTestName(name: string): { test: string; moduleSegs: string[] | null } | null {
  const n = name.replace(/\[.*\]$/, '').trim();
  let test: string;
  let moduleSegs: string[] | null = null;
  if (n.includes('::')) {
    const parts = n.split('::');
    test = parts[parts.length - 1]!;
    const file = parts[0]!.replace(/\.py$/, '');
    moduleSegs = [...file.split(/[/\\.]/), ...parts.slice(1, -1)].filter(Boolean);
  } else if (n.includes('#')) {
    const idx = n.lastIndexOf('#');
    test = n.slice(idx + 1);
    moduleSegs = n.slice(0, idx).split(/[./]/).filter(Boolean);
  } else {
    test = n.split('.').pop()!;
  }
  if (!/^test_\w+$/.test(test)) return null;
  return { test, moduleSegs: moduleSegs && moduleSegs.length > 0 ? moduleSegs : null };
}

/**
 * True when the file's path (without .py) lines up with the module path: the
 * file stem equals a module segment and the preceding directories agree for as
 * far as both go (tolerates different roots and trailing class names).
 */
export function moduleMatchesPath(moduleSegs: readonly string[], filePath: string): boolean {
  const fileSegs = filePath.replace(/\.py$/, '').split('/').filter(Boolean);
  const stem = fileSegs[fileSegs.length - 1];
  if (!stem) return false;
  for (let i = moduleSegs.length - 1; i >= 0; i--) {
    if (moduleSegs[i] !== stem) continue;
    let ok = true;
    for (let k = 1; i - k >= 0 && fileSegs.length - 1 - k >= 0; k++) {
      if (moduleSegs[i - k] !== fileSegs[fileSegs.length - 1 - k]) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

/** Lines added by a unified diff patch (without the leading '+'); patch and line lengths capped. */
export function addedLines(patch: string | null | undefined): string[] {
  if (!patch) return [];
  const text =
    patch.length > LINK_LIMITS.maxPatchChars ? patch.slice(0, LINK_LIMITS.maxPatchChars) : patch;
  const out: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = text.indexOf('\n', start);
    if (end === -1) end = text.length;
    if (
      text.charCodeAt(start) === 43 /* + */ &&
      end - start - 1 <= LINK_LIMITS.maxLineChars &&
      !text.startsWith('+++', start)
    ) {
      out.push(text.slice(start + 1, end));
    }
    start = end + 1;
  }
  return out;
}

/**
 * Argument strings of test markers in a line — linear scan: indexOf('@'),
 * literal prefix check, then look for ')' only within maxMarkerArgs chars.
 */
export function markerArgs(line: string): string[] {
  const out: string[] = [];
  let at = line.indexOf('@');
  while (at !== -1) {
    const prefix = MARKER_PREFIXES.find((p) => line.startsWith(p, at + 1));
    if (prefix) {
      let i = at + 1 + prefix.length;
      // no further identifier chars (e.g. "@allure.idx(")
      if (!/[\w.]/.test(line.charAt(i))) {
        let ws = 0;
        while ((line[i] === ' ' || line[i] === '\t') && ws++ < 16) i++;
        if (line[i] === '(') {
          const window = line.slice(i + 1, i + 1 + LINK_LIMITS.maxMarkerArgs + 1);
          const close = window.indexOf(')');
          if (close !== -1 && close <= LINK_LIMITS.maxMarkerArgs) out.push(window.slice(0, close));
        }
      }
    }
    at = line.indexOf('@', at + 1);
  }
  return out;
}

/** Candidate identifiers inside a marker's argument list: quoted/bare tokens, URL path pieces, Jira keys. */
export function markerTokens(args: string): string[] {
  const a = args.slice(0, LINK_LIMITS.maxMarkerArgs);
  const tokens = new Set<string>();
  for (const m of a.matchAll(/(["'])([^"'\n]{0,512}?)\1/g)) {
    const v = m[2]!.trim();
    if (v) tokens.add(v);
  }
  for (const t of a.split(/[\s,()"'=/?#&]+/)) if (t) tokens.add(t);
  for (const m of a.matchAll(JIRA_KEY_G)) tokens.add(m[0]);
  return [...tokens];
}

export interface LinkResult {
  links: CaseLink[];
  /** Links dropped by the per-PR cap (0 normally). */
  dropped: number;
}

export function linkPullRequest(
  pr: PrForLinking,
  index: CaseIndex,
  maxLinks: number = LINK_LIMITS.maxLinksPerPr,
): LinkResult {
  // per case, keep the strongest way it was linked
  const best = new Map<number, LinkedBy>();
  const rank = (k: LinkedBy) => LINK_STRENGTH.indexOf(k);
  const push = (ids: Iterable<number>, linkedBy: LinkedBy) => {
    for (const id of ids) {
      const cur = best.get(id);
      if (cur === undefined || rank(linkedBy) < rank(cur)) best.set(id, linkedBy);
    }
  };
  push(index.keyMatches(pr.title.slice(0, LINK_LIMITS.maxTitleChars)), 'key_in_title');
  push(index.keyMatches(pr.body?.slice(0, LINK_LIMITS.maxBodyChars) ?? null), 'key_in_body');
  // branch names are usually lower-case (feature/pay-123-…): match case-insensitively
  push(
    index.keyMatches(pr.headBranch?.slice(0, LINK_LIMITS.maxBranchChars) ?? null, {
      caseInsensitive: true,
    }),
    'key_in_branch',
  );

  for (const f of pr.files) {
    for (const line of addedLines(f.patch)) {
      if (line.includes('@')) {
        for (const args of markerArgs(line)) {
          for (const tok of markerTokens(args)) push(index.markerMatches(tok), 'marker_in_diff');
        }
      }
      if (line.includes('def')) {
        for (const m of line.matchAll(DEF_TEST_G))
          push(index.testNameMatches(m[1]!, f.filename), 'test_name_in_diff');
      }
      // only test files reach here (GITHUB_TEST_PATH_GLOBS): a key in a comment or docstring links too
      if (line.includes('-')) push(index.keyMatches(line), 'key_in_test_diff');
    }
  }

  const all = [...best].map(([testCaseId, linkedBy]) => ({ testCaseId, linkedBy }));
  // stable: strongest kind first, then case id
  all.sort((a, b) => rank(a.linkedBy) - rank(b.linkedBy) || a.testCaseId - b.testCaseId);
  return { links: all.slice(0, maxLinks), dropped: Math.max(0, all.length - maxLinks) };
}
