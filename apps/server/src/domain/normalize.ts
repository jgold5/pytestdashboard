/**
 * Normalizers for free-text values coming from spreadsheets / Jira fields.
 * Shared by the spreadsheet import and the Jira integration.
 */
import type { AutomationStatus, Priority } from '@ptd/shared';

function canon(raw: string): string {
  return raw
    .normalize('NFKC')
    .replace(/[‘’ʼ]/g, "'")
    .toLowerCase()
    .replace(/[_\s]+/g, ' ')
    .trim();
}

const STATUS_WORDS: Record<string, AutomationStatus> = {};
const add = (status: AutomationStatus, words: string[]) => {
  for (const w of words) STATUS_WORDS[canon(w)] = status;
};
add('automated', ['yes', 'y', 'true', '1', 'automated', 'done', 'complete', 'completed', '✓', '✔', '✅', 'x', 'auto']);
add('in_progress', ['wip', 'in progress', 'in-progress', 'inprogress', 'ongoing', 'started', 'in development', 'in review']);
add('not_automated', [
  'no',
  'n',
  'false',
  '0',
  'manual',
  'todo',
  'to do',
  'not started',
  'not automated',
  'not-automated',
  'pending',
  'backlog',
  '',
]);
add('not_automatable', [
  'n/a',
  'na',
  'n.a.',
  'not automatable',
  'not-automatable',
  'not possible',
  "won't automate",
  'wont automate',
  'will not automate',
  'not applicable',
  'manual only',
]);

/**
 * Map a free-text status cell to an AutomationStatus.
 * - blank / null → 'not_automated'
 * - unrecognized → null (callers decide: spreadsheet import falls back to
 *   'not_automated'; Jira sync should treat null as "leave unchanged").
 */
export function normalizeAutomationStatus(raw: string | null | undefined): AutomationStatus | null {
  if (raw === null || raw === undefined) return 'not_automated';
  const c = canon(String(raw));
  const direct = STATUS_WORDS[c];
  if (direct) return direct;
  const enumLike = c.replace(/[\s-]+/g, '_');
  if (enumLike === 'automated' || enumLike === 'in_progress' || enumLike === 'not_automated' || enumLike === 'not_automatable') {
    return enumLike;
  }
  return null;
}

const PRIORITY_WORDS: Array<[RegExp, Priority]> = [
  [/\b(critical|blocker|highest|urgent|showstopper)\b/, 'P0'],
  [/\b(high|major)\b/, 'P1'],
  [/\b(medium|normal|moderate)\b/, 'P2'],
  [/\b(low|minor|trivial|lowest)\b/, 'P3'],
];

/** P0–P3, Critical/Blocker→P0, High→P1, Medium→P2, Low→P3, 0–3 → P0–P3; else null. */
export function normalizePriority(raw: string | number | null | undefined): Priority | null {
  if (raw === null || raw === undefined) return null;
  const c = canon(String(raw));
  if (c === '') return null;
  const m = /^p?\s*([0-3])(?:\b|$)/.exec(c);
  if (m?.[1]) return `P${m[1]}` as Priority;
  for (const [re, p] of PRIORITY_WORDS) if (re.test(c)) return p;
  return null;
}

const JIRA_KEY_RE = /^[A-Z][A-Z0-9_]+-\d+$/;
export function isJiraKey(v: string): boolean {
  return JIRA_KEY_RE.test(v);
}

/** Split a tags cell on , ; | — trimmed, deduplicated, empty removed. */
export function splitTags(raw: string | null | undefined, max = 50): string[] {
  if (!raw) return [];
  const out: string[] = [];
  for (const part of raw.split(/[,;|]/)) {
    const t = part.trim().slice(0, 200);
    if (t && !out.includes(t)) out.push(t);
    if (out.length >= max) break;
  }
  return out;
}
