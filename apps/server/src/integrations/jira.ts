/**
 * Jira / Xray sync (SPEC "Jira / Xray" + "Bugs identified").
 *
 * 1. Test issues: JQL (JIRA_JQL) via Jira Cloud `/rest/api/3/search/jql`
 *    (nextPageToken pagination) — falls back to `/rest/api/2/search`
 *    (startAt pagination) on Server/DC. Cap 10,000.
 * 2. Optional Xray Cloud GraphQL (`getTests`) → test type per issue.
 * 3. Upsert test cases (match by jiraKey, then key). Automation status
 *    precedence: JIRA_AUTOMATION_FIELD value → Xray test type
 *    (Cucumber/Generic ⇒ automated) → unchanged; never downgrade an
 *    `automated` case that has real (allure) results.
 * 4. Bugs: every bug with a jiraKey + every Bug linked from a Test issue
 *    (issuelinks) is fetched in `key in (…)` batches of ≤100 and upserted via
 *    upsertBugFromJira (linked defects are also linked to the case).
 */
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { z } from 'zod';
import type { AutomationStatus, BugSeverity, BugStatus } from '@ptd/shared';
import { LIMITS } from '@ptd/shared';
import type { JiraConfig } from '../config.js';
import type { Db } from '../db/client.js';
import { bugs, testCases, testResults, type TestCaseRow } from '../db/schema.js';
import { upsertBugFromJira } from '../domain/bugs.js';
import { isJiraKey, normalizeAutomationStatus, normalizePriority } from '../domain/normalize.js';
import { nowIso } from '../util/time.js';
import { HttpClient, HttpError, type HttpClientOptions } from './http.js';
import type { IntegrationProvider, SyncContext, SyncStats } from './registry.js';

/** Xray Cloud GraphQL/REST API path, appended to `XRAY_BASE_URL` (config.xrayBaseUrl). */
export const XRAY_API_PATH = '/api/v2';

export const JIRA_LIMITS = {
  maxIssues: 10_000,
  pageSize: 100,
  bugBatch: 100,
  xrayPageSize: 100,
} as const;

export interface JiraProviderOptions {
  /** Test hook: full Xray API base URL (default `${config.xrayBaseUrl}/api/v2`). */
  xrayBaseUrl?: string;
  /** Test hooks: override HTTP client settings (backoff, sleep, timeouts). */
  http?: Partial<Omit<HttpClientOptions, 'baseUrl' | 'label' | 'headers' | 'signal'>>;
}

// ---------------------------------------------------------------------------
// Schemas (permissive)
// ---------------------------------------------------------------------------

const Named = z.object({ name: z.string().nullish() }).nullish();

const LinkedIssue = z
  .object({
    key: z.string(),
    fields: z.object({ issuetype: Named, summary: z.string().nullish() }).nullish(),
  })
  .nullish();

const IssueLink = z
  .object({
    type: z
      .object({
        name: z.string().nullish(),
        inward: z.string().nullish(),
        outward: z.string().nullish(),
      })
      .nullish(),
    inwardIssue: LinkedIssue,
    outwardIssue: LinkedIssue,
  })
  .nullish();

const IssueFields = z.looseObject({
  summary: z.string().nullish(),
  labels: z.array(z.string()).nullish(),
  components: z.array(Named).nullish(),
  priority: Named,
  assignee: z.object({ displayName: z.string().nullish() }).nullish(),
  status: z
    .object({
      name: z.string().nullish(),
      statusCategory: z.object({ key: z.string().nullish() }).nullish(),
    })
    .nullish(),
  resolution: Named,
  resolutiondate: z.string().nullish(),
  issuetype: Named,
  issuelinks: z.array(IssueLink).nullish(),
});

const Issue = z.object({
  id: z.string().nullish(),
  key: z.string(),
  fields: IssueFields.nullish(),
});
export type JiraIssue = z.infer<typeof Issue>;

const SearchResponse = z.object({
  issues: z.array(Issue).nullish(),
  // Cloud /search/jql
  nextPageToken: z.string().nullish(),
  isLast: z.boolean().nullish(),
  // Server /search
  startAt: z.number().nullish(),
  maxResults: z.number().nullish(),
  total: z.number().nullish(),
});

const XrayTests = z.object({
  data: z
    .object({
      getTests: z
        .object({
          total: z.number().nullish(),
          results: z
            .array(
              z
                .object({
                  issueId: z.string().nullish(),
                  testType: z
                    .object({ name: z.string().nullish(), kind: z.string().nullish() })
                    .nullish(),
                  jira: z.object({ key: z.string().nullish() }).nullish(),
                })
                .nullish(),
            )
            .nullish(),
        })
        .nullish(),
    })
    .nullish(),
  errors: z.array(z.object({ message: z.string().nullish() })).nullish(),
});

// ---------------------------------------------------------------------------
// Mappings (exported for tests)
// ---------------------------------------------------------------------------

const canon = (s: string | null | undefined) =>
  (s ?? '').replace(/[‘’ʼ]/g, "'").toLowerCase().replace(/\s+/g, ' ').trim();

const WONT_FIX_RESOLUTIONS = new Set([
  "won't do",
  "won't fix",
  'wont do',
  'wont fix',
  'duplicate',
  'will not fix',
  'will not do',
]);

/** statusCategory new → open, indeterminate → in_progress, done → resolved (or wont_fix for Won't Do/Won't Fix/Duplicate). */
export function mapBugStatus(
  statusCategoryKey: string | null | undefined,
  resolutionName: string | null | undefined,
): BugStatus {
  switch (canon(statusCategoryKey)) {
    case 'indeterminate':
      return 'in_progress';
    case 'done':
      return WONT_FIX_RESOLUTIONS.has(canon(resolutionName)) ? 'wont_fix' : 'resolved';
    default:
      return 'open';
  }
}

/** Highest/Blocker/Critical → critical, High/Major → major, Medium/Minor → minor, Low/Lowest/Trivial → trivial. */
export function mapSeverity(priorityName: string | null | undefined): BugSeverity | null {
  const p = canon(priorityName);
  if (!p) return null;
  if (/\b(highest|blocker|critical|urgent)\b/.test(p) || p === 'p0') return 'critical';
  if (/\b(high|major)\b/.test(p) || p === 'p1') return 'major';
  if (/\b(medium|minor|normal)\b/.test(p) || p === 'p2') return 'minor';
  if (/\b(low|lowest|trivial)\b/.test(p) || p === 'p3' || p === 'p4') return 'trivial';
  return null;
}

/** Xray test type → automated? Cucumber/Generic (kinds Gherkin/Unstructured) ⇒ true; Manual/Steps ⇒ false. */
export function isAutomatedTestType(
  t: { name?: string | null; kind?: string | null } | null | undefined,
): boolean {
  if (!t) return false;
  const name = canon(t.name);
  const kind = canon(t.kind);
  return (
    name === 'cucumber' ||
    name === 'generic' ||
    ['cucumber', 'generic', 'gherkin', 'unstructured'].includes(kind)
  );
}

/** Custom-field value → text: string, number, {value}, {name}, [first option]. null/empty ⇒ null (no opinion). */
export function automationFieldText(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) return v.length ? automationFieldText(v[0]) : null;
  if (typeof v === 'string') return v.trim() === '' ? null : v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    for (const k of ['value', 'name'])
      if (typeof o[k] === 'string' && (o[k] as string).trim()) return o[k] as string;
  }
  return null;
}

function toIso(s: string | null | undefined): string | null {
  if (!s) return null;
  const fixed = s.replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  const d = new Date(fixed);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

const LINK_TYPE_RE = /defect|\btests?\b|tested by|block/i;
const BUG_TYPE_RE = /^(bug|defect)$/i;

/** Bugs linked from a Test issue via a Defect / Tests / Blocks link. */
export function linkedDefectKeys(issue: JiraIssue): string[] {
  const out = new Set<string>();
  for (const l of issue.fields?.issuelinks ?? []) {
    if (!l) continue;
    const typeText = [l.type?.name, l.type?.inward, l.type?.outward].filter(Boolean).join(' | ');
    if (!LINK_TYPE_RE.test(typeText)) continue;
    for (const other of [l.inwardIssue, l.outwardIssue]) {
      if (other && BUG_TYPE_RE.test(other.fields?.issuetype?.name ?? '') && isJiraKey(other.key))
        out.add(other.key);
    }
  }
  return [...out];
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

type ApiVersion = '3' | '2';

export function createJiraProvider(
  config: JiraConfig,
  opts: JiraProviderOptions = {},
): IntegrationProvider {
  const hasBasic = Boolean(config.email && config.apiToken);
  const hasAuth = hasBasic || Boolean(config.pat);
  const xrayEnabled = Boolean(config.xrayClientId && config.xrayClientSecret);

  return {
    name: 'jira',
    isConfigured: () => Boolean(config.baseUrl) && hasAuth,
    describeTarget: () =>
      config.baseUrl ? `${config.baseUrl} — ${config.jql}${xrayEnabled ? ' (+ Xray)' : ''}` : null,
    intervalMinutes: () => config.intervalMinutes,
    sync: async (ctx) => {
      if (!config.baseUrl || !hasAuth) throw new Error('Jira is not configured');
      const secrets: string[] = [];
      let authorization: string;
      if (hasBasic) {
        const b64 = Buffer.from(`${config.email}:${config.apiToken}`).toString('base64');
        authorization = `Basic ${b64}`;
        secrets.push(config.apiToken!, b64);
      } else {
        authorization = `Bearer ${config.pat}`;
        secrets.push(config.pat!);
      }
      const jira = new HttpClient({
        label: 'Jira',
        baseUrl: config.baseUrl,
        headers: { authorization },
        secrets,
        signal: ctx.signal,
        ...opts.http,
      });
      // Cloud (email + API token) → v3 /search/jql with fallback; PAT → Server/DC v2.
      const state: { version: ApiVersion } = { version: hasBasic ? '3' : '2' };
      return runJiraSync(config, jira, state, ctx, opts);
    },
  };
}

async function search(
  jira: HttpClient,
  state: { version: ApiVersion },
  jql: string,
  fields: string[],
  cap: number,
): Promise<JiraIssue[]> {
  const out: JiraIssue[] = [];
  if (state.version === '3') {
    let token: string | undefined;
    const seen = new Set<string>();
    try {
      for (
        let page = 0;
        out.length < cap && page <= Math.ceil(cap / JIRA_LIMITS.pageSize);
        page++
      ) {
        const res = await jira.post('/rest/api/3/search/jql', {
          body: {
            jql,
            fields,
            maxResults: JIRA_LIMITS.pageSize,
            ...(token ? { nextPageToken: token } : {}),
          },
          schema: SearchResponse,
        });
        const issues = res.data.issues ?? [];
        out.push(...issues.slice(0, cap - out.length));
        const next = res.data.nextPageToken;
        if (res.data.isLast || !next || issues.length === 0 || seen.has(next)) break;
        seen.add(next);
        token = next;
      }
      return out;
    } catch (e) {
      // Server/DC has no /rest/api/3/search/jql → fall back to v2 /search.
      if (out.length === 0 && e instanceof HttpError && (e.status === 404 || e.status === 405)) {
        state.version = '2';
      } else {
        throw e;
      }
    }
  }
  let startAt = 0;
  for (let page = 0; out.length < cap && page <= Math.ceil(cap / JIRA_LIMITS.pageSize); page++) {
    const res = await jira.post('/rest/api/2/search', {
      body: { jql, fields, startAt, maxResults: JIRA_LIMITS.pageSize },
      schema: SearchResponse,
    });
    const issues = res.data.issues ?? [];
    out.push(...issues.slice(0, cap - out.length));
    startAt += issues.length;
    if (issues.length === 0 || (typeof res.data.total === 'number' && startAt >= res.data.total))
      break;
  }
  return out;
}

async function fetchXrayTypes(
  config: JiraConfig,
  ctx: SyncContext,
  opts: JiraProviderOptions,
): Promise<Map<string, { name: string | null; kind: string | null }>> {
  const xray = new HttpClient({
    label: 'Xray',
    baseUrl: opts.xrayBaseUrl ?? `${config.xrayBaseUrl}${XRAY_API_PATH}`,
    secrets: [config.xrayClientSecret!, config.xrayClientId!],
    signal: ctx.signal,
    ...opts.http,
  });
  const auth = await xray.post('/authenticate', {
    body: { client_id: config.xrayClientId, client_secret: config.xrayClientSecret },
    schema: z.string().min(1),
  });
  const jwt = auth.data;
  xray.addSecret(jwt);
  const types = new Map<string, { name: string | null; kind: string | null }>();
  const query = `query($jql: String!, $start: Int!, $limit: Int!) {
  getTests(jql: $jql, limit: $limit, start: $start) { total results { issueId testType { name kind } jira(fields: ["key"]) } }
}`;
  let start = 0;
  for (let page = 0; start < JIRA_LIMITS.maxIssues && page < JIRA_LIMITS.maxIssues; page++) {
    const res = await xray.post('/graphql', {
      headers: { authorization: `Bearer ${jwt}` },
      body: { query, variables: { jql: config.jql, start, limit: JIRA_LIMITS.xrayPageSize } },
      schema: XrayTests,
    });
    const tests = res.data.data?.getTests;
    if (!tests) {
      const msg = res.data.errors?.[0]?.message ?? 'no data returned';
      throw new HttpError(`Xray GraphQL error: ${msg.slice(0, 200)}`, res.status);
    }
    const results = tests.results ?? [];
    for (const r of results) {
      const key = r?.jira?.key;
      if (key) types.set(key, { name: r.testType?.name ?? null, kind: r.testType?.kind ?? null });
    }
    start += results.length;
    // Xray may return fewer than `limit` per page: continue until `total` (or an empty page)
    if (results.length === 0) break;
    if (
      typeof tests.total === 'number'
        ? start >= tests.total
        : results.length < JIRA_LIMITS.xrayPageSize
    )
      break;
  }
  return types;
}

async function runJiraSync(
  config: JiraConfig,
  jira: HttpClient,
  state: { version: ApiVersion },
  ctx: SyncContext,
  opts: JiraProviderOptions,
): Promise<SyncStats> {
  const { db } = ctx;
  const base = config.baseUrl!;
  const stats: SyncStats = { fetched: 0, created: 0, updated: 0, linked: 0 };

  // --- 1. Test issues ------------------------------------------------------
  const fields = [
    'summary',
    'labels',
    'components',
    'priority',
    'assignee',
    'status',
    'issuetype',
    'issuelinks',
  ];
  if (config.automationField) fields.push(config.automationField);
  const issues = (await search(jira, state, config.jql, fields, JIRA_LIMITS.maxIssues)).filter(
    (i) => isJiraKey(i.key),
  );
  stats.fetched += issues.length;

  // --- 2. Xray test types (optional) --------------------------------------
  const xrayTypes =
    config.xrayClientId && config.xrayClientSecret ? await fetchXrayTypes(config, ctx, opts) : null;

  // --- 3. Upsert test cases -------------------------------------------------
  const caseIdByJiraKey = upsertTestCases(
    db,
    base,
    config.automationField,
    issues,
    xrayTypes,
    stats,
  );

  // --- 4. Bugs ---------------------------------------------------------------
  const defectLinks: Array<{ bugKey: string; caseId: number }> = [];
  for (const issue of issues) {
    const caseId = caseIdByJiraKey.get(issue.key);
    if (caseId === undefined) continue;
    for (const bugKey of linkedDefectKeys(issue)) defectLinks.push({ bugKey, caseId });
  }
  const bugKeys = new Set(
    db
      .select({ k: bugs.jiraKey })
      .from(bugs)
      .where(isNotNull(bugs.jiraKey))
      .all()
      .map((r) => r.k!)
      .filter(isJiraKey),
  );
  for (const l of defectLinks) bugKeys.add(l.bugKey);

  const bugFields = ['summary', 'status', 'resolution', 'resolutiondate', 'assignee', 'priority'];
  const fetchedBugs = new Map<string, JiraIssue>();
  const keys = [...bugKeys].sort();
  for (let i = 0; i < keys.length; i += JIRA_LIMITS.bugBatch) {
    const batch = keys.slice(i, i + JIRA_LIMITS.bugBatch);
    for (const issue of await fetchBugBatch(jira, state, batch, bugFields))
      fetchedBugs.set(issue.key, issue);
  }
  stats.fetched += fetchedBugs.size;

  db.transaction((tx) => {
    for (const issue of fetchedBugs.values()) {
      const f = issue.fields;
      const outcome = upsertBugFromJira(tx, {
        jiraKey: issue.key,
        title: (f?.summary?.trim() || issue.key).slice(0, LIMITS.titleMax),
        url: `${base}/browse/${issue.key}`,
        status: mapBugStatus(f?.status?.statusCategory?.key, f?.resolution?.name),
        severity: mapSeverity(f?.priority?.name),
        assignee: f?.assignee?.displayName?.slice(0, LIMITS.shortTextMax) ?? null,
        resolvedAt: toIso(f?.resolutiondate),
      });
      stats[outcome === 'created' ? 'created' : 'updated']++;
    }
    for (const l of defectLinks) {
      if (!fetchedBugs.has(l.bugKey)) continue;
      const f = fetchedBugs.get(l.bugKey)!.fields;
      upsertBugFromJira(tx, {
        jiraKey: l.bugKey,
        title: (f?.summary?.trim() || l.bugKey).slice(0, LIMITS.titleMax),
        url: `${base}/browse/${l.bugKey}`,
        status: mapBugStatus(f?.status?.statusCategory?.key, f?.resolution?.name),
        severity: mapSeverity(f?.priority?.name),
        assignee: f?.assignee?.displayName?.slice(0, LIMITS.shortTextMax) ?? null,
        resolvedAt: toIso(f?.resolutiondate),
        linkTestCaseId: l.caseId,
      });
      stats.linked++;
    }
  });
  return stats;
}

/**
 * `key in (…)` fails with 400 on Jira when any key no longer exists (or isn't
 * visible) — fall back to per-issue GETs for that batch, skipping 404s.
 */
async function fetchBugBatch(
  jira: HttpClient,
  state: { version: ApiVersion },
  keys: string[],
  fields: string[],
): Promise<JiraIssue[]> {
  try {
    return await search(jira, state, `key in (${keys.join(',')})`, fields, keys.length);
  } catch (e) {
    if (!(e instanceof HttpError) || e.status !== 400) throw e;
  }
  const out: JiraIssue[] = [];
  for (const key of keys) {
    try {
      const res = await jira.get(`/rest/api/${state.version}/issue/${encodeURIComponent(key)}`, {
        query: { fields: fields.join(',') },
        schema: Issue,
      });
      out.push(res.data);
    } catch (e) {
      if (e instanceof HttpError && (e.status === 404 || e.status === 403)) continue;
      throw e;
    }
  }
  return out;
}

function upsertTestCases(
  db: Db,
  base: string,
  automationField: string | undefined,
  issues: JiraIssue[],
  xrayTypes: Map<string, { name: string | null; kind: string | null }> | null,
  stats: SyncStats,
): Map<string, number> {
  const ids = new Map<string, number>();
  if (issues.length === 0) return ids;
  return db.transaction((tx) => {
    const keys = issues.map((i) => i.key);
    const byJira = new Map<string, TestCaseRow>();
    const byKey = new Map<string, TestCaseRow>();
    for (let i = 0; i < keys.length; i += 500) {
      const chunk = keys.slice(i, i + 500);
      for (const r of tx.select().from(testCases).where(inArray(testCases.jiraKey, chunk)).all())
        byJira.set(r.jiraKey!, r);
      for (const r of tx.select().from(testCases).where(inArray(testCases.key, chunk)).all())
        byKey.set(r.key, r);
    }
    const hasResults = (caseId: number) =>
      Boolean(
        tx
          .select({ id: testResults.id })
          .from(testResults)
          .where(and(eq(testResults.testCaseId, caseId)))
          .limit(1)
          .get(),
      );

    for (const issue of issues) {
      const f = issue.fields;
      const now = nowIso();
      const title = (f?.summary?.trim() || issue.key).slice(0, LIMITS.titleMax);
      const suite =
        f?.components?.find((c) => c?.name)?.name?.slice(0, LIMITS.shortTextMax) ?? null;
      const tags = [
        ...new Set(
          (f?.labels ?? []).map((l) => l.trim().slice(0, LIMITS.shortTextMax)).filter(Boolean),
        ),
      ].slice(0, LIMITS.tagsMax);
      const owner = f?.assignee?.displayName?.slice(0, LIMITS.shortTextMax) ?? null;
      const priority = normalizePriority(f?.priority?.name ?? null);
      const externalUrl = `${base}/browse/${issue.key}`;

      let desired: AutomationStatus | null = null;
      if (automationField) {
        const raw = automationFieldText(
          (f as Record<string, unknown> | null | undefined)?.[automationField],
        );
        if (raw !== null) desired = normalizeAutomationStatus(raw); // unrecognized → null → fall through
      }
      if (desired === null && xrayTypes) {
        if (isAutomatedTestType(xrayTypes.get(issue.key))) desired = 'automated';
      }

      const existing = byJira.get(issue.key) ?? byKey.get(issue.key);
      if (!existing) {
        const status = desired ?? 'not_automated';
        const row = tx
          .insert(testCases)
          .values({
            key: issue.key,
            jiraKey: issue.key,
            title,
            suite,
            tags,
            owner,
            priority,
            externalUrl,
            automationStatus: status,
            automatedAt: status === 'automated' ? now : null,
            automatedVia: status === 'automated' ? 'jira' : null,
            source: 'jira',
            createdAt: now,
            updatedAt: now,
          })
          .returning({ id: testCases.id })
          .get();
        ids.set(issue.key, row.id);
        stats.created++;
        continue;
      }

      ids.set(issue.key, existing.id);
      // Never downgrade an `automated` case that has real (allure) results.
      if (
        existing.automationStatus === 'automated' &&
        desired !== null &&
        desired !== 'automated' &&
        hasResults(existing.id)
      ) {
        desired = null;
      }
      const set: Partial<typeof testCases.$inferInsert> = {};
      if (existing.title !== title) set.title = title;
      if (JSON.stringify(existing.tags) !== JSON.stringify(tags)) set.tags = tags;
      if (existing.externalUrl !== externalUrl) set.externalUrl = externalUrl;
      if (!existing.jiraKey) set.jiraKey = issue.key;
      // Jira fills these but never blanks values set elsewhere (e.g. spreadsheet import)
      if (suite !== null && existing.suite !== suite) set.suite = suite;
      if (owner !== null && existing.owner !== owner) set.owner = owner;
      if (priority !== null && existing.priority !== priority) set.priority = priority;
      if (desired !== null && desired !== existing.automationStatus) {
        set.automationStatus = desired;
        if (desired === 'automated') {
          set.automatedAt = now;
          set.automatedVia = 'jira';
        }
      }
      if (Object.keys(set).length > 0) {
        set.updatedAt = now;
        tx.update(testCases).set(set).where(eq(testCases.id, existing.id)).run();
        stats.updated++;
      }
    }
    return ids;
  });
}
