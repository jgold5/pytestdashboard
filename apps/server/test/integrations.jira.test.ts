import { afterEach, describe, expect, it } from 'vitest';
import type { Bug, BugList, IntegrationStatus, TestCase, TestCaseList } from '@ptd/shared';
import { loadConfig, type JiraConfig } from '../src/config.js';
import {
  automationFieldText,
  createJiraProvider,
  isAutomatedTestType,
  linkedDefectKeys,
  mapBugStatus,
  mapSeverity,
} from '../src/integrations/jira.js';
import { createTestApp, type TestApp } from './helpers/app.js';
import { daysAgo, importResults } from './helpers/allure.js';
import {
  notFoundReply,
  startMockServer,
  type MockReply,
  type MockRequest,
  type MockServer,
} from './helpers/mockServer.js';

const EMAIL = 'qa@acme.io';
const API_TOKEN = 'ATATT3xFfGF0SuperSecretJiraApiToken0123456789';
const PAT = 'NjQ2MTY0OTk0MjM3OkSuperSecretServerPAT';
const XRAY_ID = 'XRAYCLIENTID0123456789';
const XRAY_SECRET = 'xray-client-secret-0123456789abcdef';
const XRAY_JWT = 'eyJhbGciOiJIUzI1NiJ9.xray-jwt-payload.signature';
const AUTOMATION_FIELD = 'customfield_10123';

type Fields = Record<string, unknown>;
const issue = (key: string, fields: Fields) => ({ id: key.replace(/\D/g, ''), key, fields });
const status = (category: 'new' | 'indeterminate' | 'done', name: string = category) => ({
  name,
  statusCategory: { key: category },
});

const TESTS = [
  issue('TC-1', {
    summary: 'Pay with card',
    components: [{ name: 'Payments' }],
    labels: ['smoke', 'api'],
    priority: { name: 'High' },
    assignee: { displayName: 'Ann' },
    [AUTOMATION_FIELD]: { value: 'Automated' },
    issuelinks: [],
  }),
  issue('TC-2', {
    summary: 'Refund',
    labels: [],
    components: [],
    priority: { name: 'Medium' },
    [AUTOMATION_FIELD]: null,
  }),
  issue('TC-3', { summary: 'Login (has allure results)', [AUTOMATION_FIELD]: { value: 'Manual' } }),
  issue('TC-4', { summary: 'Logout (spreadsheet)', [AUTOMATION_FIELD]: [{ value: 'Manual' }] }),
  issue('TC-5', {
    summary: 'Search',
    issuelinks: [
      {
        type: { name: 'Defect', inward: 'created by', outward: 'created' },
        outwardIssue: { key: 'BUG-10', fields: { issuetype: { name: 'Bug' } } },
      },
      {
        type: { name: 'Tests', inward: 'is tested by', outward: 'tests' },
        outwardIssue: { key: 'STORY-1', fields: { issuetype: { name: 'Story' } } },
      },
      {
        type: { name: 'Relates', inward: 'relates to', outward: 'relates to' },
        inwardIssue: { key: 'BUG-11', fields: { issuetype: { name: 'Bug' } } },
      },
    ],
  }),
  issue('TC-6', { summary: 'Checkout (cucumber)', [AUTOMATION_FIELD]: 'maybe?' }),
];

const BUGS: Record<string, ReturnType<typeof issue>> = {
  'BUG-1': issue('BUG-1', {
    summary: "Won't fix this",
    status: status('done', 'Closed'),
    resolution: { name: 'Won’t Fix' },
    priority: { name: 'Highest' },
    resolutiondate: '2026-10-02T08:00:00.000+0000',
  }),
  'BUG-2': issue('BUG-2', {
    summary: 'Being worked on',
    status: status('indeterminate', 'In Progress'),
    priority: { name: 'Medium' },
    assignee: { displayName: 'Bob' },
  }),
  'BUG-3': issue('BUG-3', {
    summary: 'Fixed it',
    status: status('done', 'Done'),
    resolution: { name: 'Done' },
    priority: { name: 'Low' },
    resolutiondate: '2026-10-01T10:00:00.000+0000',
  }),
  'BUG-10': issue('BUG-10', {
    summary: 'Search crashes',
    status: status('new', 'To Do'),
    priority: { name: 'Lowest' },
  }),
};

const XRAY_TYPES: Record<string, { name: string; kind: string }> = {
  'TC-2': { name: 'Generic', kind: 'Unstructured' },
  'TC-3': { name: 'Manual', kind: 'Steps' },
  'TC-5': { name: 'Manual', kind: 'Steps' },
  'TC-6': { name: 'Cucumber', kind: 'Gherkin' },
};

interface JiraMockOpts {
  /** Server/DC: no /rest/api/3/search/jql. */
  server?: boolean;
  pageSize?: number;
  expectAuth?: string;
}

function jiraHandler(opts: JiraMockOpts = {}) {
  const pageSize = opts.pageSize ?? 4;
  const expectAuth =
    opts.expectAuth ?? `Basic ${Buffer.from(`${EMAIL}:${API_TOKEN}`).toString('base64')}`;
  const keysFromJql = (jql: string) => /^key in \(([^)]*)\)$/.exec(jql)?.[1]?.split(',') ?? null;
  const searchIssues = (jql: string, res: MockRequest) => {
    const keys = keysFromJql(jql);
    if (keys) {
      const missing = keys.filter((k) => !BUGS[k]);
      if (missing.length)
        return {
          error: {
            status: 400,
            json: {
              errorMessages: [`An issue with key '${missing[0]}' does not exist for field 'key'.`],
            },
          },
        };
      return { issues: keys.map((k) => BUGS[k]!) };
    }
    expect(jql).toBe('issuetype = Test ORDER BY key');
    const fields = (res.body as { fields: string[] }).fields;
    expect(fields).toEqual(
      expect.arrayContaining([
        'summary',
        'labels',
        'components',
        'priority',
        'assignee',
        'status',
        'issuelinks',
        AUTOMATION_FIELD,
      ]),
    );
    return { issues: TESTS };
  };
  return (req: MockRequest): MockReply => {
    if (req.path.startsWith('/xray/')) return xrayHandler(req);
    if (req.headers.authorization !== expectAuth)
      return { status: 401, json: { errorMessages: ['Unauthorized'] } };
    const body = (req.body ?? {}) as {
      jql: string;
      nextPageToken?: string;
      startAt?: number;
      maxResults: number;
    };
    if (req.method === 'POST' && req.path === '/rest/api/3/search/jql' && !opts.server) {
      const r = searchIssues(body.jql, req);
      if (r.error) return r.error;
      const start = body.nextPageToken ? Number(body.nextPageToken.replace('tok-', '')) : 0;
      const slice = r.issues.slice(start, start + pageSize);
      const more = start + pageSize < r.issues.length;
      return {
        json: {
          issues: slice,
          ...(more
            ? { nextPageToken: `tok-${start + pageSize}`, isLast: false }
            : { isLast: true }),
        },
      };
    }
    if (req.method === 'POST' && req.path === '/rest/api/2/search') {
      const r = searchIssues(body.jql, req);
      if (r.error) return r.error;
      const start = body.startAt ?? 0;
      return {
        json: {
          startAt: start,
          maxResults: pageSize,
          total: r.issues.length,
          issues: r.issues.slice(start, start + pageSize),
        },
      };
    }
    const one = /^\/rest\/api\/([23])\/issue\/([A-Z0-9_]+-\d+)$/.exec(req.path);
    if (req.method === 'GET' && one) {
      const b = BUGS[one[2]!];
      return b
        ? { json: b }
        : {
            status: 404,
            json: {
              errorMessages: ['Issue does not exist or you do not have permission to see it.'],
            },
          };
    }
    return notFoundReply(req);
  };
}

function xrayHandler(req: MockRequest): MockReply {
  if (req.path === '/xray/authenticate') {
    const b = req.body as { client_id: string; client_secret: string };
    if (b.client_id !== XRAY_ID || b.client_secret !== XRAY_SECRET)
      return { status: 401, json: { error: 'Authentication failed. Invalid client credentials!' } };
    return { json: XRAY_JWT };
  }
  if (req.path === '/xray/graphql') {
    if (req.headers.authorization !== `Bearer ${XRAY_JWT}`)
      return { status: 401, json: { error: 'unauthorized' } };
    const { query, variables } = req.body as {
      query: string;
      variables: { jql: string; start: number; limit: number };
    };
    expect(query).toContain('getTests(jql: $jql, limit: $limit, start: $start)');
    expect(query).toContain('testType { name kind }');
    expect(query).toContain('jira(fields: ["key"])');
    const all = Object.entries(XRAY_TYPES).map(([key, testType]) => ({
      issueId: key.slice(2),
      testType,
      jira: { key },
    }));
    const limit = 2; // force pagination regardless of requested limit
    return {
      json: {
        data: {
          getTests: {
            total: all.length,
            start: variables.start,
            limit,
            results: all.slice(variables.start, variables.start + limit),
          },
        },
      },
    };
  }
  return notFoundReply(req);
}

describe('Jira mappings', () => {
  it('maps bug status by statusCategory and resolution', () => {
    expect(mapBugStatus('new', null)).toBe('open');
    expect(mapBugStatus('indeterminate', null)).toBe('in_progress');
    expect(mapBugStatus('done', 'Done')).toBe('resolved');
    expect(mapBugStatus('done', null)).toBe('resolved');
    expect(mapBugStatus('done', "Won't Fix")).toBe('wont_fix');
    expect(mapBugStatus('done', 'Won’t Do')).toBe('wont_fix');
    expect(mapBugStatus('done', 'Duplicate')).toBe('wont_fix');
    expect(mapBugStatus(undefined, null)).toBe('open');
  });

  it('maps severity from priority', () => {
    expect(mapSeverity('Highest')).toBe('critical');
    expect(mapSeverity('Blocker')).toBe('critical');
    expect(mapSeverity('High')).toBe('major');
    expect(mapSeverity('Medium')).toBe('minor');
    expect(mapSeverity('Low')).toBe('trivial');
    expect(mapSeverity('Lowest')).toBe('trivial');
    expect(mapSeverity('Whatever')).toBeNull();
    expect(mapSeverity(null)).toBeNull();
  });

  it('maps Xray test types and automation field values', () => {
    expect(isAutomatedTestType({ name: 'Cucumber', kind: 'Gherkin' })).toBe(true);
    expect(isAutomatedTestType({ name: 'Generic', kind: 'Unstructured' })).toBe(true);
    expect(isAutomatedTestType({ name: 'Robot', kind: 'Generic' })).toBe(true);
    expect(isAutomatedTestType({ name: 'Manual', kind: 'Steps' })).toBe(false);
    expect(isAutomatedTestType(undefined)).toBe(false);
    expect(automationFieldText({ value: 'Automated', id: '1' })).toBe('Automated');
    expect(automationFieldText([{ value: 'Yes' }])).toBe('Yes');
    expect(automationFieldText('  ')).toBeNull();
    expect(automationFieldText(null)).toBeNull();
    expect(automationFieldText(true)).toBe('true');
  });

  it('finds linked defects only for Bug issues via defect/tests/blocks links', () => {
    expect(linkedDefectKeys(TESTS[4]!)).toEqual(['BUG-10']);
    expect(
      linkedDefectKeys({
        key: 'TC-9',
        fields: {
          issuelinks: [
            {
              type: { name: 'Blocks', inward: 'is blocked by', outward: 'blocks' },
              inwardIssue: { key: 'BUG-7', fields: { issuetype: { name: 'Bug' } } },
            },
          ],
        },
      }),
    ).toEqual(['BUG-7']);
  });
});

describe('Jira sync', () => {
  let t: TestApp | undefined;
  let mock: MockServer | undefined;
  afterEach(async () => {
    await t?.close();
    await mock?.close();
    t = undefined;
    mock = undefined;
  });

  const jiraConfig = (url: string, extra: Partial<JiraConfig> = {}): JiraConfig => ({
    baseUrl: url,
    email: EMAIL,
    apiToken: API_TOKEN,
    pat: undefined,
    jql: 'issuetype = Test ORDER BY key',
    automationField: AUTOMATION_FIELD,
    xrayClientId: XRAY_ID,
    xrayClientSecret: XRAY_SECRET,
    xrayBaseUrl: 'https://xray.cloud.getxray.app',
    intervalMinutes: null,
    ...extra,
  });

  const appWith = async (cfg: JiraConfig) => {
    const secrets = {
      JIRA_API_TOKEN: API_TOKEN,
      JIRA_PAT: PAT,
      XRAY_CLIENT_SECRET: XRAY_SECRET,
      XRAY_CLIENT_ID: XRAY_ID,
    };
    // env only feeds the runner's secret list (JIRA_BASE_URL must be https in loadConfig, so the
    // provider gets its config directly, pointing at the http loopback mock)
    return createTestApp(secrets, {
      providers: [
        createJiraProvider(cfg, {
          xrayBaseUrl: `${mock!.url}/xray`,
          http: { sleep: async () => undefined, backoffBaseMs: 1 },
        }),
      ],
    });
  };

  const sync = async () => {
    const res = await t!.app.inject({ method: 'POST', url: '/api/integrations/jira/sync' });
    expect(res.statusCode, res.body).toBe(202);
    await t!.runner.waitForIdle();
    return (await t!.app.inject({ url: '/api/integrations' }))
      .json<IntegrationStatus[]>()
      .find((s) => s.name === 'jira')!;
  };

  const cases = async () =>
    (await t!.app.inject({ url: '/api/test-cases?pageSize=100' })).json<TestCaseList>().items;
  const bugsList = async () =>
    (await t!.app.inject({ url: '/api/bugs?pageSize=100&bucket=all' })).json<BugList>().items;
  const post = async (url: string, payload: object) => {
    const r = await t!.app.inject({ method: 'POST', url, payload });
    expect(r.statusCode, r.body).toBe(201);
    return r.json();
  };

  it('Jira Cloud: paginated search, Xray types, case upserts, never-downgrade, bug sync', async () => {
    mock = await startMockServer(jiraHandler());
    t = await appWith(jiraConfig(mock.url));

    // existing data
    await importResults(t, [
      { fullName: 'tests.test_login#test_login', status: 'passed', start: daysAgo(1) },
    ]);
    const allureCase = (await cases()).find((c) => c.key === 'tests.test_login#test_login')!;
    await t.app.inject({
      method: 'PATCH',
      url: `/api/test-cases/${allureCase.id}`,
      payload: { jiraKey: 'TC-3' },
    });
    const t2 = (await post('/api/test-cases', {
      key: 'TC-2',
      title: 'old title',
      suite: 'Keep me',
      owner: 'Zed',
    })) as TestCase;
    const t4 = (await post('/api/test-cases', {
      key: 'sheet-4',
      jiraKey: 'TC-4',
      title: 'Logout',
      automationStatus: 'automated',
    })) as TestCase;
    const b1 = (await post('/api/bugs', { title: 'from note', jiraKey: 'BUG-1' })) as Bug;
    await post('/api/bugs', { title: 'b2', jiraKey: 'BUG-2', testCaseIds: [t2.id] });
    await post('/api/bugs', { title: 'b3', jiraKey: 'BUG-3' });
    await post('/api/bugs', { title: 'gone', jiraKey: 'BUG-99' });
    await post('/api/bugs', { title: 'manual, no key' });

    const s = await sync();
    expect(s.lastError).toBeNull();
    expect(s.state).toBe('idle');
    // fetched: 6 tests + 4 bugs (BUG-99 missing); created: TC-1,TC-5,TC-6 + BUG-10; updated: TC-2,TC-3?,TC-4 + BUG-1,2,3
    expect(s.lastStats).toMatchObject({ fetched: 10, linked: 1 });
    expect(s.lastStats!.created).toBe(4);

    // pagination: 6 tests / pageSize 4 → 2 pages via nextPageToken
    const testSearches = mock.requests.filter(
      (r) =>
        r.path === '/rest/api/3/search/jql' &&
        !(r.body as { jql: string }).jql.startsWith('key in'),
    );
    expect(testSearches.map((r) => (r.body as { nextPageToken?: string }).nextPageToken)).toEqual([
      undefined,
      'tok-4',
    ]);
    // Xray: authenticated once, 2 GraphQL pages
    expect(mock.requests.filter((r) => r.path === '/xray/authenticate')).toHaveLength(1);
    expect(mock.requests.filter((r) => r.path === '/xray/graphql').length).toBeGreaterThanOrEqual(
      2,
    );
    // bug batch failed (BUG-99 missing, named in the error) → retried once without it, no per-issue requests
    const bugSearches = mock.requests
      .filter((r) => r.path === '/rest/api/3/search/jql' && (r.body as { jql: string }).jql.startsWith('key in'))
      .map((r) => (r.body as { jql: string }).jql);
    expect(bugSearches).toHaveLength(2);
    expect(bugSearches[0]).toContain('BUG-99');
    expect(bugSearches[1]).not.toContain('BUG-99');
    expect(mock.requests.some((r) => r.path.startsWith('/rest/api/3/issue/'))).toBe(false);

    const all = await cases();
    const byJira = (k: string) => all.find((c) => c.jiraKey === k)!;
    expect(byJira('TC-1')).toMatchObject({
      key: 'TC-1',
      title: 'Pay with card',
      suite: 'Payments',
      tags: ['smoke', 'api'],
      owner: 'Ann',
      priority: 'P1',
      automationStatus: 'automated',
      externalUrl: `${mock.url}/browse/TC-1`,
      source: 'jira',
    });
    // matched by key, Xray Generic → automated; suite/owner kept (Jira has none)
    expect(byJira('TC-2')).toMatchObject({
      id: t2.id,
      title: 'Refund',
      automationStatus: 'automated',
      suite: 'Keep me',
      owner: 'Zed',
      priority: 'P2',
    });
    // never downgrade automated with real allure results
    expect(byJira('TC-3')).toMatchObject({
      id: allureCase.id,
      automationStatus: 'automated',
      title: 'Login (has allure results)',
    });
    // automated without results (spreadsheet): field says Manual → applied
    expect(byJira('TC-4')).toMatchObject({
      id: t4.id,
      key: 'sheet-4',
      automationStatus: 'not_automated',
    });
    // Xray Manual → unchanged (new → not_automated)
    expect(byJira('TC-5').automationStatus).toBe('not_automated');
    // unrecognized field value falls through to Xray Cucumber
    expect(byJira('TC-6').automationStatus).toBe('automated');

    const bl = await bugsList();
    const bug = (k: string) => bl.find((b) => b.jiraKey === k)!;
    expect(bug('BUG-1')).toMatchObject({
      id: b1.id,
      status: 'wont_fix',
      severity: 'critical',
      title: "Won't fix this",
      source: 'jira',
    });
    expect(bug('BUG-1').resolvedAt).toBe('2026-10-02T08:00:00.000Z');
    expect(bug('BUG-2')).toMatchObject({
      status: 'in_progress',
      severity: 'minor',
      assignee: 'Bob',
      resolvedAt: null,
    });
    expect(bug('BUG-2').testCases.map((c) => c.id)).toEqual([t2.id]); // manual links kept
    expect(bug('BUG-3')).toMatchObject({
      status: 'resolved',
      severity: 'trivial',
      resolvedAt: '2026-10-01T10:00:00.000Z',
    });
    expect(bug('BUG-10')).toMatchObject({
      status: 'open',
      severity: 'trivial',
      title: 'Search crashes',
      url: `${mock.url}/browse/BUG-10`,
    });
    expect(bug('BUG-10').testCases.map((c) => c.id)).toEqual([byJira('TC-5').id]);
    expect(bug('BUG-99')).toMatchObject({ status: 'open', title: 'gone' }); // untouched
    expect(bl.find((b) => b.jiraKey === 'BUG-11')).toBeUndefined(); // "Relates" link ignored

    // second sync: idempotent — nothing created, unchanged cases not counted as updated
    const s2 = await sync();
    expect(s2.lastStats).toMatchObject({ created: 0, fetched: 10 });
    expect(s2.lastStats!.updated).toBe(4); // bugs are always refreshed; cases unchanged
  });

  it('Server/DC: PAT bearer auth and /rest/api/2/search (startAt pagination)', async () => {
    mock = await startMockServer(
      jiraHandler({ server: true, pageSize: 4, expectAuth: `Bearer ${PAT}` }),
    );
    t = await appWith(
      jiraConfig(mock.url, {
        email: undefined,
        apiToken: undefined,
        pat: PAT,
        xrayClientId: undefined,
        xrayClientSecret: undefined,
      }),
    );
    const s = await sync();
    expect(s.lastError).toBeNull();
    expect(s.lastStats).toMatchObject({ fetched: 7, created: 7 }); // 6 tests + BUG-10
    expect(mock.requests.some((r) => r.path.startsWith('/rest/api/3'))).toBe(false);
    expect(mock.requests.some((r) => r.path.startsWith('/xray'))).toBe(false);
    const starts = mock.requests
      .filter((r) => r.path === '/rest/api/2/search')
      .map((r) => (r.body as { startAt: number }).startAt);
    // test issues: two pages; the single bug key is fetched directly (GET), not with a one-key search
    expect(starts).toEqual([0, 4]);
    expect(mock.requests.some((r) => r.method === 'GET' && r.path === '/rest/api/2/issue/BUG-10')).toBe(true);
    // without Xray, TC-2 (no field value) stays not_automated
    expect((await cases()).find((c) => c.jiraKey === 'TC-2')!.automationStatus).toBe(
      'not_automated',
    );
  });

  it('many stale bug keys: still syncs the real bugs, at most one request per key', async () => {
    mock = await startMockServer(jiraHandler({ pageSize: 4 }));
    t = await appWith(jiraConfig(mock.url, { xrayClientId: undefined, xrayClientSecret: undefined }));
    // 60 bug keys in the dashboard that Jira no longer has, plus the real ones
    for (let i = 0; i < 60; i++) await post('/api/bugs', { title: `gone ${i}`, jiraKey: `OLD-${100 + i}` });
    const s = await sync();
    expect(s.lastError).toBeNull();
    const bugRequests = mock.requests.filter(
      (r) =>
        r.path.includes('/issue/') ||
        (r.path === '/rest/api/3/search/jql' && (r.body as { jql: string }).jql.startsWith('key in')),
    );
    // dropping named keys never costs more than the per-key fallback (one request per key + the failed searches)
    expect(bugRequests.length).toBeLessThanOrEqual(64 + 4);
    const all = (await t!.app.inject({ url: '/api/bugs?pageSize=100&bucket=all' })).json<BugList>().items;
    expect(all.find((b) => b.jiraKey === 'BUG-10')).toBeTruthy(); // a real bug still synced
  });

  it('Cloud credentials against a Server: falls back from v3 to v2 search', async () => {
    mock = await startMockServer(jiraHandler({ server: true }));
    t = await appWith(
      jiraConfig(mock.url, { xrayClientId: undefined, xrayClientSecret: undefined }),
    );
    const s = await sync();
    expect(s.lastError).toBeNull();
    expect(s.lastStats!.fetched).toBe(7);
    expect(mock.requests[0]!.path).toBe('/rest/api/3/search/jql');
    expect(mock.requests.filter((r) => r.path === '/rest/api/3/search/jql')).toHaveLength(1);
  });

  it('retries 429/500 from Jira', async () => {
    const handler = jiraHandler({});
    let n = 0;
    mock = await startMockServer((req) => {
      n++;
      if (n === 1) return { status: 429, headers: { 'retry-after': '1' } };
      if (n === 2) return { status: 503, text: 'unavailable' };
      return handler(req);
    });
    t = await appWith(jiraConfig(mock.url));
    const s = await sync();
    expect(s.lastError).toBeNull();
    expect(s.lastStats!.fetched).toBe(7);
  });

  it('stores sanitized errors without tokens (Jira and Xray)', async () => {
    mock = await startMockServer((req) => ({
      status: 401,
      json: {
        errorMessages: [`Bad auth header ${String(req.headers.authorization)} token ${API_TOKEN}`],
      },
    }));
    t = await appWith(jiraConfig(mock.url));
    let s = await sync();
    expect(s.state).toBe('error');
    expect(s.lastError).toContain('HTTP 401');
    const b64 = Buffer.from(`${EMAIL}:${API_TOKEN}`).toString('base64');
    for (const secret of [API_TOKEN, b64, 'SuperSecret']) expect(s.lastError).not.toContain(secret);

    // Xray auth failure: client secret / JWT never leak
    await mock.close();
    mock = await startMockServer((req) =>
      req.path === '/xray/authenticate'
        ? { status: 401, json: { error: `Invalid client credentials ${XRAY_SECRET}` } }
        : jiraHandler()(req),
    );
    await t.close();
    t = await appWith(jiraConfig(mock.url));
    s = await sync();
    expect(s.state).toBe('error');
    expect(s.lastError).toMatch(/Xray POST \/xray\/authenticate → HTTP 401/);
    expect(s.lastError).not.toContain(XRAY_SECRET);
    const row = t.dbHandle.sqlite
      .prepare('SELECT last_error FROM integration_state WHERE name = ?')
      .get('jira') as { last_error: string };
    expect(row.last_error).not.toContain(XRAY_SECRET);
  });

  it('describes the target and reports configuration from env', async () => {
    const cfg = loadConfig({
      NODE_ENV: 'test',
      JIRA_BASE_URL: 'https://acme.atlassian.net',
      JIRA_EMAIL: EMAIL,
      JIRA_API_TOKEN: API_TOKEN,
    });
    const p = createJiraProvider(cfg.jira);
    expect(p.isConfigured()).toBe(true);
    expect(p.describeTarget()).toBe('https://acme.atlassian.net — issuetype = Test ORDER BY key');
    expect(createJiraProvider({ ...cfg.jira, apiToken: undefined }).isConfigured()).toBe(false);
  });
});

describe('XRAY_BASE_URL config', () => {
  const load = (v?: string) => loadConfig({ NODE_ENV: 'test', ...(v === undefined ? {} : { XRAY_BASE_URL: v }) }).jira.xrayBaseUrl;

  it('defaults to the global Xray Cloud endpoint', () => {
    expect(load()).toBe('https://xray.cloud.getxray.app');
    expect(load('')).toBe('https://xray.cloud.getxray.app');
  });

  it('accepts regional subdomains (normalised, trailing slash ok)', () => {
    expect(load('https://eu.xray.cloud.getxray.app')).toBe('https://eu.xray.cloud.getxray.app');
    expect(load('https://US.xray.cloud.getxray.app/')).toBe('https://us.xray.cloud.getxray.app');
  });

  it.each([
    'http://xray.cloud.getxray.app',
    'https://xray.cloud.getxray.app.evil.com',
    'https://evilxray.cloud.getxray.app',
    'https://getxray.app',
    'https://xray.cloud.getxray.app:8443',
    'https://user:pw@xray.cloud.getxray.app',
    'https://xray.cloud.getxray.app/api/v2',
    'https://xray.cloud.getxray.app?x=1',
    'https://169.254.169.254',
    'not a url',
  ])('rejects %s', (v) => {
    expect(() => load(v)).toThrow(/XRAY_BASE_URL/);
  });
});
