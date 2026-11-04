import type { ImportField } from '@ptd/shared';

/** Canonical header text: lowercase alphanumerics separated by single spaces. */
export function canonHeader(h: string): string {
  return h
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const SYNONYMS: Record<ImportField, string[]> = {
  key: ['test id', 'id', 'case id', 'tc', 'tc id', 'tcid', 'test case id', 'testcase id', 'key', 'test key', 'case key', 'case no', 'test no', 'tc no'],
  title: ['name', 'title', 'test case', 'testcase', 'summary', 'test name', 'test title', 'case name', 'test case name', 'scenario'],
  suite: ['module', 'feature', 'area', 'component', 'suite', 'test suite', 'feature area', 'functional area'],
  automationStatus: ['automated', 'automation status', 'status', 'automation', 'is automated', 'automation state', 'auto status'],
  owner: ['owner', 'assignee', 'qa', 'qa owner', 'assigned to', 'tester', 'author'],
  priority: ['priority', 'severity', 'prio'],
  tags: ['labels', 'tags', 'label', 'tag'],
  externalUrl: ['jira', 'link', 'url', 'jira link', 'ticket', 'external url', 'ticket url', 'reference'],
  allureFullName: ['allure full name', 'allure fullname', 'full name', 'fullname', 'allure name', 'test path'],
  allureId: ['allure id', 'as id', 'allureid', 'allure testcase id'],
  jiraKey: ['jira key', 'jira id', 'xray key', 'xray', 'xray id', 'issue key', 'jira issue', 'xray test'],
};

/** Score a header against a field: 100 exact synonym, else 50 + len for a whole-word containment. */
function score(header: string, field: ImportField): number {
  let best = 0;
  for (const syn of SYNONYMS[field]) {
    if (header === syn) return 100 + syn.length;
    if (syn.length >= 3 && new RegExp(`(^| )${syn}( |$)`).test(header)) best = Math.max(best, 50 + syn.length);
  }
  return best;
}

/** header → suggested field; each field is assigned to at most one header (best score wins). */
export function suggestMapping(headers: readonly string[]): Record<string, ImportField> {
  const candidates: Array<{ header: string; field: ImportField; score: number }> = [];
  for (const h of headers) {
    const c = canonHeader(h);
    if (!c) continue;
    for (const field of Object.keys(SYNONYMS) as ImportField[]) {
      const s = score(c, field);
      if (s > 0) candidates.push({ header: h, field, score: s });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  const out: Record<string, ImportField> = {};
  const usedFields = new Set<ImportField>();
  for (const c of candidates) {
    if (usedFields.has(c.field) || c.header in out) continue;
    out[c.header] = c.field;
    usedFields.add(c.field);
  }
  return out;
}
