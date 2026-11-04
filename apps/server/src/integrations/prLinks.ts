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

const JIRA_KEY_G = /\b[A-Z][A-Z0-9_]+-\d+\b/g;
const MARKER_G = /@(?:allure\.(?:id|testcase|link)|pytest\.mark\.(?:xray|jira))\s*\(([^)]*)\)/g;
const DEF_TEST_G = /\bdef\s+(test_\w+)\s*\(/g;

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
    for (const m of src.matchAll(JIRA_KEY_G)) for (const id of this.byKeyOrJira.get(m[0]) ?? []) out.push(id);
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

/** Lines added by a unified diff patch (without the leading '+'). */
export function addedLines(patch: string | null | undefined): string[] {
  if (!patch) return [];
  const out: string[] = [];
  for (const line of patch.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) out.push(line.slice(1));
  }
  return out;
}

/** Candidate identifiers inside a marker's argument list: quoted/bare tokens, URL path pieces, Jira keys. */
export function markerTokens(args: string): string[] {
  const tokens = new Set<string>();
  for (const m of args.matchAll(/(["'])(.*?)\1/g)) {
    const v = m[2]!.trim();
    if (v) tokens.add(v);
  }
  for (const t of args.split(/[\s,()"'=/?#&]+/)) if (t) tokens.add(t);
  for (const m of args.matchAll(JIRA_KEY_G)) tokens.add(m[0]);
  return [...tokens];
}

export function linkPullRequest(pr: PrForLinking, index: CaseIndex): CaseLink[] {
  const links: CaseLink[] = [];
  const seen = new Set<number>();
  const push = (ids: Iterable<number>, linkedBy: LinkedBy) => {
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      links.push({ testCaseId: id, linkedBy });
    }
  };
  push(index.keyMatches(pr.title), 'key_in_title');
  push(index.keyMatches(pr.body), 'key_in_body');
  // branch names are usually lower-case (feature/pay-123-…): match case-insensitively
  push(index.keyMatches(pr.headBranch, { caseInsensitive: true }), 'key_in_branch');

  const nameHits: Array<[string, string]> = [];
  for (const f of pr.files) {
    for (const line of addedLines(f.patch)) {
      for (const m of line.matchAll(MARKER_G)) {
        for (const tok of markerTokens(m[1]!)) push(index.markerMatches(tok), 'marker_in_diff');
      }
      for (const m of line.matchAll(DEF_TEST_G)) nameHits.push([m[1]!, f.filename]);
    }
  }
  // markers take precedence over test names
  for (const [name, file] of nameHits) push(index.testNameMatches(name, file), 'test_name_in_diff');
  return links;
}
