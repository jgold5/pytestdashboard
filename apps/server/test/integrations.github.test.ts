import { afterEach, describe, expect, it } from 'vitest';
import type { IntegrationStatus, PullRequest, TestCase } from '@ptd/shared';
import { loadConfig } from '../src/config.js';
import {
  createGithubProvider,
  deriveChecks,
  deriveReviewState,
  graphqlUrl,
  isMissingScope,
  maxPages,
  prState,
} from '../src/integrations/github.js';
import {
  CaseIndex,
  linkPullRequest,
  markerArgs,
  moduleMatchesPath,
  parseTestName,
} from '../src/integrations/prLinks.js';
import { createTestApp, type TestApp } from './helpers/app.js';
import { daysAgo, importResults } from './helpers/allure.js';
import {
  notFoundReply,
  startMockServer,
  type MockReply,
  type MockRequest,
  type MockServer,
} from './helpers/mockServer.js';

const TOKEN = 'github_pat_11ABCDEFG0123456789_secretsecretsecretsecret';
const iso = (daysBack: number) => new Date(Date.now() - daysBack * 86_400_000).toISOString();

interface FakePr {
  number: number;
  title: string;
  body?: string | null;
  branch: string;
  state?: 'open' | 'closed';
  draft?: boolean;
  merged_at?: string | null;
  updated_at?: string;
  files?: Array<{ filename: string; patch?: string }>;
  gql?: Record<string, unknown>;
}

const restPr = (repo: string, pr: FakePr) => ({
  number: pr.number,
  title: pr.title,
  body: pr.body ?? null,
  html_url: `https://github.com/${repo}/pull/${pr.number}`,
  state: pr.state ?? 'open',
  draft: pr.draft ?? false,
  merged_at: pr.merged_at ?? null,
  created_at: iso(20),
  updated_at: pr.updated_at ?? iso(1),
  user: { login: 'dev' },
  head: { ref: pr.branch },
  requested_reviewers: [],
  requested_teams: [],
});

const gqlNode = (o: {
  isDraft?: boolean;
  decision?: string | null;
  reviews?: Array<[string, string]>;
  requested?: Array<{ login?: string; name?: string }>;
  threads?: boolean[];
  rollup?: string | null;
}) => ({
  isDraft: o.isDraft ?? false,
  reviewDecision: o.decision ?? null,
  reviewRequests: { nodes: (o.requested ?? []).map((r) => ({ requestedReviewer: r })) },
  reviews: { nodes: (o.reviews ?? []).map(([login, state]) => ({ author: { login }, state })) },
  reviewThreads: { nodes: (o.threads ?? []).map((isResolved) => ({ isResolved })) },
  commits: { nodes: [{ commit: { statusCheckRollup: o.rollup ? { state: o.rollup } : null } }] },
});

/** Simulates GitHub Enterprise REST (/api/v3) + GraphQL (/api/graphql) for one repo. */
function githubHandler(
  repo: string,
  prs: FakePr[],
  opts: { openPageSize?: number; maliciousNext?: boolean; gate?: Promise<void> } = {},
) {
  const base = `/api/v3/repos/${repo}`;
  return async (req: MockRequest): Promise<MockReply> => {
    if (opts.gate) await opts.gate;
    if (req.headers.authorization !== `Bearer ${TOKEN}`)
      return { status: 401, json: { message: 'Bad credentials' } };
    if (req.method === 'GET' && req.path === `${base}/pulls`) {
      const state = req.query.get('state');
      const list = prs.filter((p) =>
        state === 'open' ? (p.state ?? 'open') === 'open' : p.state === 'closed',
      );
      const size = opts.openPageSize ?? 100;
      const page = Number(req.query.get('page') ?? '1');
      const slice = list.slice((page - 1) * size, page * size);
      const headers: Record<string, string> = {};
      if (page * size < list.length) {
        const host = opts.maliciousNext ? 'http://evil.example.com' : `http://${req.headers.host}`;
        headers.link = `<${host}${base}/pulls?state=${state}&page=${page + 1}>; rel="next"`;
      }
      return { json: slice.map((p) => restPr(repo, p)), headers };
    }
    const files = new RegExp(`^${base}/pulls/(\\d+)/files$`).exec(req.path);
    if (files) {
      const pr = prs.find((p) => p.number === Number(files[1]));
      return pr ? { json: pr.files ?? [] } : notFoundReply(req);
    }
    if (req.method === 'POST' && req.path === '/api/graphql') {
      const body = req.body as { query: string; variables: { owner: string; name: string } };
      expect(`${body.variables.owner}/${body.variables.name}`).toBe(repo);
      const repository: Record<string, unknown> = {};
      for (const m of body.query.matchAll(/pr(\d+): pullRequest\(number: (\d+)\)/g)) {
        const pr = prs.find((p) => p.number === Number(m[2]));
        repository[`pr${m[1]}`] = pr ? { number: pr.number, ...(pr.gql ?? gqlNode({})) } : null;
      }
      return { json: { data: { repository } } };
    }
    return notFoundReply(req);
  };
}

describe('GitHub derivations', () => {
  it('derives review state (all branches)', () => {
    expect(deriveReviewState('APPROVED', [], [])).toBe('approved');
    expect(deriveReviewState('CHANGES_REQUESTED', [], [])).toBe('changes_requested');
    expect(deriveReviewState('REVIEW_REQUIRED', [{ author: 'a', state: 'APPROVED' }], [])).toBe(
      'review_required',
    );
    // null decision: latest review per reviewer
    expect(
      deriveReviewState(
        null,
        [
          { author: 'a', state: 'CHANGES_REQUESTED' },
          { author: 'a', state: 'APPROVED' },
        ],
        [],
      ),
    ).toBe('approved');
    expect(
      deriveReviewState(
        null,
        [
          { author: 'a', state: 'APPROVED' },
          { author: 'b', state: 'CHANGES_REQUESTED' },
          { author: 'b', state: 'COMMENTED' },
        ],
        [],
      ),
    ).toBe('changes_requested');
    expect(
      deriveReviewState(
        null,
        [
          { author: 'b', state: 'CHANGES_REQUESTED' },
          { author: 'b', state: 'DISMISSED' },
        ],
        ['c'],
      ),
    ).toBe('review_required');
    expect(deriveReviewState(null, [{ author: 'a', state: 'COMMENTED' }], ['x'])).toBe(
      'review_required',
    );
    expect(deriveReviewState(undefined, [], [])).toBe('none');
  });

  it('derives checks and PR state', () => {
    expect(deriveChecks('SUCCESS')).toBe('passing');
    expect(deriveChecks('FAILURE')).toBe('failing');
    expect(deriveChecks('ERROR')).toBe('failing');
    expect(deriveChecks('PENDING')).toBe('pending');
    expect(deriveChecks('EXPECTED')).toBe('pending');
    expect(deriveChecks(null)).toBe('none');
    expect(prState({ state: 'open', draft: true, merged_at: null })).toBe('draft');
    expect(prState({ state: 'open', draft: false, merged_at: null })).toBe('open');
    expect(prState({ state: 'closed', draft: false, merged_at: '2026-01-01T00:00:00Z' })).toBe(
      'merged',
    );
    expect(prState({ state: 'closed', draft: false, merged_at: null })).toBe('closed');
  });

  it('computes the GraphQL endpoint for github.com and GHES', () => {
    expect(graphqlUrl('https://api.github.com')).toBe('https://api.github.com/graphql');
    expect(graphqlUrl('https://ghe.acme.io/api/v3')).toBe('https://ghe.acme.io/api/graphql');
  });

  it('parses test names and matches module paths', () => {
    expect(parseTestName('tests.api.test_users.TestX#test_ok')).toEqual({
      test: 'test_ok',
      moduleSegs: ['tests', 'api', 'test_users', 'TestX'],
    });
    expect(parseTestName('tests/api/test_users.py::TestX::test_ok[a-b]')).toEqual({
      test: 'test_ok',
      moduleSegs: ['tests', 'api', 'test_users', 'TestX'],
    });
    expect(parseTestName('test_users.test_ok')).toEqual({ test: 'test_ok', moduleSegs: null });
    expect(parseTestName('PAY-1')).toBeNull();
    expect(
      moduleMatchesPath(['tests', 'api', 'test_users', 'TestX'], 'tests/api/test_users.py'),
    ).toBe(true);
    expect(moduleMatchesPath(['api', 'test_users'], 'project/tests/api/test_users.py')).toBe(true);
    expect(moduleMatchesPath(['tests', 'web', 'test_users'], 'tests/api/test_users.py')).toBe(
      false,
    );
  });

  it('links by each rule kind', () => {
    const index = new CaseIndex([
      { id: 1, key: 'PAY-1', jiraKey: 'PAY-1', allureId: null, allureFullName: null },
      { id: 2, key: 'k2', jiraKey: 'PAY-2', allureId: null, allureFullName: null },
      { id: 3, key: 'k3', jiraKey: 'PAY-3', allureId: null, allureFullName: null },
      { id: 4, key: 'k4', jiraKey: null, allureId: '777', allureFullName: null },
      { id: 5, key: 'k5', jiraKey: 'PAY-5', allureId: null, allureFullName: null },
      {
        id: 6,
        key: 'tests.api.test_users#test_login',
        jiraKey: null,
        allureId: null,
        allureFullName: 'tests.api.test_users#test_login',
      },
      {
        id: 7,
        key: 'tests.web.test_users#test_login',
        jiraKey: null,
        allureId: null,
        allureFullName: null,
      },
      { id: 8, key: 'k8', jiraKey: null, allureId: '888', allureFullName: null },
      { id: 9, key: 'k9', jiraKey: 'PAY-9', allureId: null, allureFullName: null },
    ]);
    const links = linkPullRequest(
      {
        title: 'PAY-1: automate login (NOPE-1)',
        body: 'Covers PAY-2 and PAY-1',
        headBranch: 'feature/pay-3-login',
        files: [
          {
            filename: 'tests/api/test_users.py',
            patch: [
              '@@ -1,3 +1,9 @@',
              '+@allure.id("777")',
              '+@pytest.mark.xray("PAY-5")',
              '-@allure.id("888")',
              ' def test_logout():',
              '+def test_login(client):',
              '+@allure.link("https://acme.atlassian.net/browse/PAY-9", name="ticket")',
            ].join('\n'),
          },
        ],
      },
      index,
    );
    expect(links.dropped).toBe(0);
    // strongest kind first: marker > test name > branch > title > body
    expect(links.links).toEqual([
      { testCaseId: 4, linkedBy: 'marker_in_diff' },
      { testCaseId: 5, linkedBy: 'marker_in_diff' },
      { testCaseId: 9, linkedBy: 'marker_in_diff' },
      { testCaseId: 6, linkedBy: 'test_name_in_diff' },
      { testCaseId: 3, linkedBy: 'key_in_branch' },
      { testCaseId: 1, linkedBy: 'key_in_title' },
      { testCaseId: 2, linkedBy: 'key_in_body' },
    ]);
  });

  it('parses markers with a bounded scan', () => {
    expect(
      markerArgs('@allure.id("1") @pytest.mark.jira ("QA-2") @allure.idx("3") @allure.link('),
    ).toEqual(['"1"', '"QA-2"']);
    expect(markerArgs(`@allure.id(${'x'.repeat(600)})`)).toEqual([]);
  });

  it('R2-01: hostile diffs and bodies are processed in linear time', () => {
    const cases = Array.from({ length: 200 }, (_, i) => ({
      id: i + 1,
      key: `PAY-${i + 1}`,
      jiraKey: `PAY-${i + 1}`,
      allureId: String(i + 1),
      allureFullName: `tests.test_evil#test_c${i + 1}`,
    }));
    const index = new CaseIndex(cases);
    const hostileLine = '@allure.id('.repeat(Math.ceil((1024 * 1024) / 11)); // ~1 MB, no ")"
    const shortHostile = '@allure.id('.repeat(180); // just under the 2 KB line cap
    const hostileBody = ('@allure.id(' + 'A'.repeat(50) + '-' + '1'.repeat(10) + ' ')
      .repeat(1024)
      .slice(0, 64 * 1024);
    const work = () =>
      linkPullRequest(
        {
          title: 'AAAAAAAA'.repeat(10_000),
          body: hostileBody,
          headBranch: 'a'.repeat(100_000),
          files: [
            { filename: 'tests/test_evil.py', patch: `@@ -0,0 +1 @@\n+${hostileLine}` },
            {
              filename: 'tests/test_evil2.py',
              patch: Array.from({ length: 2000 }, () => `+${shortHostile}`).join('\n'),
            },
            { filename: 'tests/test_evil3.py', patch: `+def ${'test_'.repeat(250_000)}` },
            { filename: 'tests/test_evil4.py', patch: `+def${' '.repeat(1_000_000)}x` },
          ],
        },
        index,
      );
    // Measure CPU time of warmed-up runs, not wall-clock: test files run in parallel, and a busy
    // CI runner stretched a single cold wall-clock timing to 101 ms (about 25 ms of CPU warm).
    // Super-linear backtracking on these inputs would take seconds of CPU, so the bound still
    // catches it. (pool: 'forks' gives each test file its own process to measure.)
    work(); // JIT warm-up, so compilation on helper threads isn't counted
    let best = Infinity;
    for (let i = 0; i < 3; i++) {
      const cpu0 = process.cpuUsage();
      const res = work();
      // markerArgs on an uncapped 1 MB line is linear too
      expect(markerArgs(hostileLine)).toEqual([]);
      const cpu = process.cpuUsage(cpu0);
      best = Math.min(best, (cpu.user + cpu.system) / 1000);
      expect(res.links).toEqual([]);
    }
    expect(best).toBeLessThan(100);
  });

  it('R2-03: caps links per PR, keeping the strongest kinds', () => {
    const cases = Array.from({ length: 200 }, (_, i) => ({
      id: i + 1,
      key: `PAY-${i + 1}`,
      jiraKey: `PAY-${i + 1}`,
      allureId: null,
      allureFullName: null,
    }));
    const index = new CaseIndex(cases);
    const res = linkPullRequest(
      {
        title: 'PAY-199',
        body: cases.map((c) => c.key).join(' '),
        headBranch: 'feature/pay-198',
        files: [{ filename: 'tests/test_x.py', patch: '+@pytest.mark.jira("PAY-200")' }],
      },
      index,
    );
    expect(res.links).toHaveLength(50);
    expect(res.dropped).toBe(150);
    expect(res.links.slice(0, 3)).toEqual([
      { testCaseId: 200, linkedBy: 'marker_in_diff' },
      { testCaseId: 198, linkedBy: 'key_in_branch' },
      { testCaseId: 199, linkedBy: 'key_in_title' },
    ]);
    expect(res.links.slice(3).every((l) => l.linkedBy === 'key_in_body')).toBe(true);
  });
});

describe('GitHub sync', () => {
  let t: TestApp | undefined;
  let mock: MockServer | undefined;
  afterEach(async () => {
    await t?.close();
    await mock?.close();
    t = undefined;
    mock = undefined;
  });

  const env = (url: string) => ({
    GITHUB_TOKEN: TOKEN,
    GITHUB_REPOS: 'acme/api',
    GITHUB_API_URL: `${url}/api/v3`,
  });

  const createCase = async (body: Record<string, unknown>) => {
    const res = await t!.app.inject({
      method: 'POST',
      url: '/api/test-cases',
      payload: { title: 'x', ...body },
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json<TestCase>();
  };

  const scenario = (): FakePr[] => [
    {
      number: 1,
      title: 'PAY-1 automate payments',
      branch: 'b1',
      gql: gqlNode({ decision: 'APPROVED', rollup: 'SUCCESS' }),
    },
    {
      number: 2,
      title: 'More tests',
      body: 'Implements PAY-2',
      branch: 'b2',
      gql: gqlNode({
        reviews: [
          ['a', 'CHANGES_REQUESTED'],
          ['a', 'APPROVED'],
        ],
        rollup: 'FAILURE',
      }),
    },
    {
      number: 3,
      title: 'Login tests',
      branch: 'feature/pay-3-login',
      gql: gqlNode({
        reviews: [
          ['a', 'APPROVED'],
          ['b', 'CHANGES_REQUESTED'],
          ['b', 'COMMENTED'],
        ],
        rollup: 'SUCCESS',
      }),
    },
    {
      number: 4,
      title: 'Orders',
      branch: 'b4',
      files: [
        {
          filename: 'tests/api/test_orders.py',
          patch: '@@ -1 +1,2 @@\n+@allure.id("777")\n-@allure.id("888")\n def test_x(): pass',
        },
        { filename: 'src/app.py', patch: '+@allure.id("999")' },
      ],
      gql: gqlNode({
        requested: [{ login: 'alice' }, { name: 'qa-team' }],
        threads: [false, true, false],
        rollup: 'PENDING',
      }),
    },
    {
      number: 5,
      title: 'Users',
      branch: 'b5',
      draft: true,
      files: [
        {
          filename: 'tests/api/test_users.py',
          patch: '+def test_login(client):\n+    assert True',
        },
      ],
      gql: gqlNode({ isDraft: true }),
    },
    {
      number: 7,
      title: 'Nope',
      branch: 'b7',
      gql: gqlNode({ decision: 'CHANGES_REQUESTED', rollup: 'SUCCESS' }),
    },
    {
      number: 6,
      title: 'PAY-1 merged follow-up',
      branch: 'b6',
      state: 'closed',
      merged_at: iso(3),
      updated_at: iso(3),
      gql: gqlNode({ decision: 'REVIEW_REQUIRED', rollup: 'ERROR' }),
    },
    {
      number: 8,
      title: 'old',
      branch: 'b8',
      state: 'closed',
      merged_at: iso(30),
      updated_at: iso(30),
    },
  ];

  it('syncs PRs end-to-end via the route: pagination, links, review state, needsAttention', async () => {
    let open: () => void = () => undefined;
    const gate = new Promise<void>((r) => (open = r));
    mock = await startMockServer(() => ({ status: 500 }));
    mock.setHandler(githubHandler('acme/api', scenario(), { openPageSize: 2, gate }));
    t = await createTestApp(env(mock.url));
    const c1 = await createCase({ key: 'PAY-1', jiraKey: 'PAY-1' });
    const c2 = await createCase({ key: 'tests.api.test_pay#test_refund', jiraKey: 'PAY-2' });
    const c3 = await createCase({ key: 'login-case', jiraKey: 'PAY-3' });
    const c4 = await createCase({ key: 'tests.api.test_orders#test_create', allureId: '777' });
    const c5 = await createCase({
      key: 'tests.api.test_users#test_login',
      allureFullName: 'tests.api.test_users#test_login',
    });
    const c6 = await createCase({ key: 'tests.web.test_users#test_login' });
    const c8 = await createCase({ key: 'eight', allureId: '888' });

    const first = await t.app.inject({ method: 'POST', url: '/api/integrations/github/sync' });
    expect(first.statusCode).toBe(202);
    expect(first.json<IntegrationStatus>()).toMatchObject({
      name: 'github',
      state: 'running',
      configured: true,
    });
    expect(
      (await t.app.inject({ method: 'POST', url: '/api/integrations/github/sync' })).statusCode,
    ).toBe(409);
    open();
    await t.runner.waitForIdle();

    const status = (await t.app.inject({ url: '/api/integrations' }))
      .json<IntegrationStatus[]>()
      .find((s) => s.name === 'github')!;
    expect(status.lastError).toBeNull();
    expect(status).toMatchObject({
      state: 'idle',
      // updated = cases auto-promoted: PAY-1 is linked to merged PR #6
      lastStats: { fetched: 7, created: 7, updated: 1, linked: 6 },
    });
    expect(status.target).toContain('acme/api (127.0.0.1');

    // pagination: open list fetched over 3 pages
    const openPages = mock.requests.filter(
      (r) => r.path === '/api/v3/repos/acme/api/pulls' && r.query.get('state') === 'open',
    );
    expect(openPages.map((r) => r.query.get('page'))).toEqual([null, '2', '3']);
    expect(mock.requests.filter((r) => r.path === '/api/graphql')).toHaveLength(1);

    const prs = (await t.app.inject({ url: '/api/pull-requests?linkedOnly=false' })).json<
      PullRequest[]
    >();
    const pr = (n: number) => prs.find((p) => p.number === n)!;
    expect(prs.map((p) => p.number).sort()).toEqual([1, 2, 3, 4, 5, 6, 7]); // #8 is outside the 14-day window
    expect(pr(1)).toMatchObject({
      state: 'open',
      reviewState: 'approved',
      checks: 'passing',
      needsAttention: false,
      readyToMerge: true,
      mergedAt: null,
    });
    expect(pr(2).readyToMerge).toBe(false); // checks failing
    expect(pr(2)).toMatchObject({
      reviewState: 'approved',
      checks: 'failing',
      needsAttention: true,
    });
    expect(pr(3)).toMatchObject({ reviewState: 'changes_requested', needsAttention: true });
    expect(pr(4)).toMatchObject({
      reviewState: 'review_required',
      checks: 'pending',
      unresolvedThreads: 2,
      requestedReviewers: ['alice', 'qa-team'],
      needsAttention: true,
    });
    expect(pr(5)).toMatchObject({
      state: 'draft',
      reviewState: 'none',
      checks: 'none',
      needsAttention: false,
    });
    expect(pr(6).mergedAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    expect(pr(6)).toMatchObject({
      state: 'merged',
      readyToMerge: false,
      reviewState: 'review_required',
      checks: 'failing',
      needsAttention: false,
    });
    expect(pr(7)).toMatchObject({ reviewState: 'changes_requested', needsAttention: true });
    // needsAttention first
    expect(prs.slice(0, 4).every((p) => p.needsAttention)).toBe(true);

    const linkedIds = (n: number) =>
      pr(n)
        .testCases.map((c) => c.id)
        .sort();
    expect(linkedIds(1)).toEqual([c1.id]);
    expect(linkedIds(2)).toEqual([c2.id]);
    expect(linkedIds(3)).toEqual([c3.id]);
    expect(linkedIds(4)).toEqual([c4.id]); // not c8 (removed line), not 999 (non-test file)
    expect(linkedIds(5)).toEqual([c5.id]); // not c6 (different module)
    expect(linkedIds(6)).toEqual([c1.id]);
    expect(linkedIds(7)).toEqual([]);
    void c6;
    void c8;

    const detail = (await t.app.inject({ url: `/api/test-cases/${c3.id}` })).json<{
      pullRequests: Array<{ linkedBy: string }>;
    }>();
    expect(detail.pullRequests[0]!.linkedBy).toBe('key_in_branch');

    // second sync: updates, replaces links atomically
    const resync = await t.app.inject({ method: 'POST', url: '/api/integrations/github/sync' });
    expect(resync.statusCode).toBe(202);
    await t.runner.waitForIdle();
    const s2 = (await t.app.inject({ url: '/api/integrations' }))
      .json<IntegrationStatus[]>()
      .find((s) => s.name === 'github')!;
    // no PR newly merged → nothing promoted again
    expect(s2.lastStats).toEqual({ fetched: 7, created: 0, updated: 0, linked: 6 });
    const ready = (await t.app.inject({ url: '/api/pull-requests?readyToMerge=true' })).json<PullRequest[]>();
    expect(ready.map((p) => p.number)).toEqual([1]);
  });

  it('refreshes PRs that were open but are no longer listed', async () => {
    const prs = scenario().slice(0, 1);
    mock = await startMockServer(githubHandler('acme/api', prs));
    const config = loadConfig({ NODE_ENV: 'test', ...env(mock.url) });
    t = await createTestApp(env(mock.url), { providers: [createGithubProvider(config.github)] });
    await t.app.inject({ method: 'POST', url: '/api/integrations/github/sync' });
    await t.runner.waitForIdle();
    // PR 1 gets closed long ago (not in the 14-day window any more)
    prs[0] = { ...prs[0]!, state: 'closed', updated_at: iso(40) };
    mock.setHandler(async (req) => {
      if (req.path === '/api/v3/repos/acme/api/pulls/1')
        return { json: restPr('acme/api', prs[0]!) };
      return githubHandler('acme/api', prs)(req);
    });
    await t.app.inject({ method: 'POST', url: '/api/integrations/github/sync' });
    await t.runner.waitForIdle();
    const list = (await t.app.inject({ url: '/api/pull-requests?linkedOnly=false' })).json<
      PullRequest[]
    >();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ number: 1, state: 'closed', needsAttention: false });
  });

  it('rejects a malicious next link to another host; error stored without token', async () => {
    mock = await startMockServer(
      githubHandler('acme/api', scenario(), { openPageSize: 2, maliciousNext: true }),
    );
    t = await createTestApp(env(mock.url));
    await t.app.inject({ method: 'POST', url: '/api/integrations/github/sync' });
    await t.runner.waitForIdle();
    const s = (await t.app.inject({ url: '/api/integrations' }))
      .json<IntegrationStatus[]>()
      .find((x) => x.name === 'github')!;
    expect(s.state).toBe('error');
    expect(s.lastError).toMatch(
      /acme\/api: GitHub: refused request to a host other than the configured base URL/,
    );
    expect(mock.requests.every((r) => r.headers.host?.startsWith('127.0.0.1'))).toBe(true);
  });

  it('retries 429 (Retry-After) and 500 during sync', async () => {
    const handler = githubHandler('acme/api', scenario());
    let calls = 0;
    mock = await startMockServer(async (req) => {
      calls++;
      if (calls === 1)
        return {
          status: 429,
          headers: { 'retry-after': '1' },
          json: { message: 'secondary rate limit' },
        };
      if (calls === 2) return { status: 500, text: 'boom' };
      return handler(req);
    });
    const sleeps: number[] = [];
    const config = loadConfig({ NODE_ENV: 'test', ...env(mock.url) });
    t = await createTestApp(env(mock.url), {
      providers: [
        createGithubProvider(config.github, {
          http: { sleep: async (ms) => void sleeps.push(ms), backoffBaseMs: 5 },
        }),
      ],
    });
    await t.app.inject({ method: 'POST', url: '/api/integrations/github/sync' });
    await t.runner.waitForIdle();
    const s = (await t.app.inject({ url: '/api/integrations' })).json<IntegrationStatus[]>()[0]!;
    expect(s.lastError).toBeNull();
    expect(s.lastStats?.fetched).toBe(7);
    expect(sleeps[0]).toBe(1000);
    expect(sleeps).toHaveLength(2);
  });

  it('a token without read:org still syncs: team reviewers are left out', async () => {
    const inner = githubHandler('acme/api', scenario());
    mock = await startMockServer(async (req) => {
      const body = req.body as { query?: string } | undefined;
      if (req.method === 'POST' && req.path === '/api/graphql' && body?.query?.includes('on Team')) {
        return {
          json: {
            data: null,
            errors: [
              {
                type: 'INSUFFICIENT_SCOPES',
                message: "Your token has not been granted the required scopes to execute this query. The 'name' field requires one of the following scopes: ['read:org', 'read:discussion'], but your token has only been granted the: ['repo'] scopes.",
              },
            ],
          },
        };
      }
      return inner(req);
    });
    t = await createTestApp(env(mock.url));
    await t.app.inject({ method: 'POST', url: '/api/integrations/github/sync' });
    await t.runner.waitForIdle();
    const s = (await t.app.inject({ url: '/api/integrations' })).json<IntegrationStatus[]>()[0]!;
    expect(s.lastError).toBeNull();
    expect(s.state).toBe('idle');
    const queries = mock.requests.filter((r) => r.path === '/api/graphql').map((r) => (r.body as { query: string }).query);
    expect(queries[0]).toContain('on Team');
    expect(queries.slice(1).every((q) => !q.includes('on Team'))).toBe(true);
    expect(isMissingScope([{ message: 'nothing to see' }])).toBe(false);
  });

  it('stores sanitized errors (bad credentials) without the token', async () => {
    mock = await startMockServer((req) => ({
      status: 401,
      json: {
        message: `Bad credentials: ${String(req.headers.authorization)}`,
        documentation_url: 'https://docs.github.com',
      },
    }));
    t = await createTestApp(env(mock.url));
    await t.app.inject({ method: 'POST', url: '/api/integrations/github/sync' });
    await t.runner.waitForIdle();
    const s = (await t.app.inject({ url: '/api/integrations' })).json<IntegrationStatus[]>()[0]!;
    expect(s.state).toBe('error');
    expect(s.lastError).toContain('HTTP 401');
    expect(s.lastError).not.toContain(TOKEN);
    expect(s.lastError).not.toContain('secretsecret');
    const row = t.dbHandle.sqlite
      .prepare('SELECT last_error FROM integration_state WHERE name = ?')
      .get('github') as { last_error: string };
    expect(row.last_error).not.toContain(TOKEN);
  });

  it('an open PR does not change automationStatus (inOpenPr / pipelineStage are derived)', async () => {
    mock = await startMockServer(
      githubHandler(
        'acme/api',
        scenario().filter((p) => p.number !== 6), // #6 merged would auto-promote PAY-1
      ),
    );
    t = await createTestApp(env(mock.url));
    await importResults(t, [{ fullName: 'x.test_a', status: 'passed', start: daysAgo(1) }]);
    const c1 = await createCase({ key: 'PAY-1', jiraKey: 'PAY-1' });
    await t.app.inject({ method: 'POST', url: '/api/integrations/github/sync' });
    await t.runner.waitForIdle();
    const c = (await t.app.inject({ url: `/api/test-cases/${c1.id}` })).json<TestCase>();
    expect(c.automationStatus).toBe('not_automated');
    expect(c.inOpenPr).toBe(true);
    expect(c.pipelineStage).toBe('ready_to_merge');
  });

  it('auto-promotes linked cases when a PR merges; merged_awaiting_run until a later run', async () => {
    const merged = iso(0.5);
    const pr10: FakePr = {
      number: 10,
      title: 'PAY-10 PAY-11 PAY-12 PAY-13 order route tests',
      branch: 'qa/order-route',
      gql: gqlNode({ decision: 'APPROVED', rollup: 'SUCCESS' }),
    };
    pr10.gql = {
      ...(pr10.gql as object),
      reviews: { nodes: [{ author: { login: 'lead' }, state: 'APPROVED', submittedAt: '2026-11-01T10:00:00Z' }] },
    };
    const prs = [pr10];
    mock = await startMockServer(githubHandler('acme/api', prs));
    t = await createTestApp(env(mock.url));
    const a = await createCase({ key: 'PAY-10', jiraKey: 'PAY-10', automationStatus: 'not_automated' });
    const b = await createCase({ key: 'PAY-11', jiraKey: 'PAY-11', automationStatus: 'in_progress' });
    const c = await createCase({ key: 'PAY-12', jiraKey: 'PAY-12', automationStatus: 'not_automatable' });
    const d = await createCase({ key: 'PAY-13', jiraKey: 'PAY-13', automationStatus: 'automated' });
    // d was automated long before the PR (a maintenance PR, not new automation)
    t.dbHandle.sqlite.prepare('UPDATE test_cases SET automated_at = ? WHERE id = ?').run(iso(30), d.id);
    const sync = async () => {
      await t!.app.inject({ method: 'POST', url: '/api/integrations/github/sync' });
      await t!.runner.waitForIdle();
      return (await t!.app.inject({ url: '/api/integrations' })).json<IntegrationStatus[]>()[0]!;
    };
    const get = async (id: number) =>
      (await t!.app.inject({ url: `/api/test-cases/${id}` })).json<TestCase>();

    // 1) open + approved: ready to merge, nothing promoted
    let s = await sync();
    expect(s.lastStats).toMatchObject({ updated: 0, linked: 4 });
    expect((await get(a.id)).pipelineStage).toBe('ready_to_merge');
    expect((await get(b.id)).pipelineStage).toBe('ready_to_merge');
    expect((await get(c.id)).pipelineStage).toBe('not_automatable');
    expect((await get(d.id)).pipelineStage).toBe('automated'); // maintenance PR on an automated case
    const pr = (await get(a.id)).pullRequests[0]!;
    expect(pr).toMatchObject({ readyToMerge: true, approvedAt: '2026-11-01T10:00:00.000Z' });
    const list = (await t.app.inject({ url: '/api/test-cases?pipelineStage=ready_to_merge' })).json<{
      items: TestCase[];
    }>();
    expect(list.items.map((x) => x.key).sort()).toEqual(['PAY-10', 'PAY-11']);

    // 2) merged: not_automated / in_progress promoted; not_automatable untouched
    prs[0] = { ...pr10, state: 'closed', merged_at: merged, updated_at: merged };
    s = await sync();
    expect(s.lastStats).toMatchObject({ updated: 2 });
    for (const id of [a.id, b.id]) {
      const x = await get(id);
      expect(x).toMatchObject({ automationStatus: 'automated', automatedVia: 'pr_merge', pipelineStage: 'merged_awaiting_run' });
    }
    expect(await get(c.id)).toMatchObject({ automationStatus: 'not_automatable', pipelineStage: 'not_automatable' });
    expect(await get(d.id)).toMatchObject({ automationStatus: 'automated', automatedVia: 'manual', pipelineStage: 'automated' });
    const summary = (await t.app.inject({ url: '/api/summary' })).json<{ pipeline: Record<string, number>; coverage: { automated: number } }>();
    expect(summary.pipeline).toMatchObject({ merged_awaiting_run: 2, automated: 1, not_automatable: 1, ready_to_merge: 0 });
    expect(summary.coverage.automated).toBe(3);

    // 3) a later run: passed → automated; broken does not count as a verifying run
    await importResults(t, [
      { fullName: 'tests.routes.test_order#a', status: 'passed', start: Date.now() - 3_600_000, links: [{ name: 'PAY-10', type: 'tms' }] },
      { fullName: 'tests.routes.test_order#b', status: 'broken', message: 'ORA-12541: TNS:no listener', start: Date.now() - 3_600_000, links: [{ name: 'PAY-11', type: 'tms' }] },
    ]);
    expect((await get(a.id)).pipelineStage).toBe('automated');
    expect((await get(b.id)).pipelineStage).toBe('merged_awaiting_run');

    // 4) re-sync: the merge was already seen → no re-promotion
    s = await sync();
    expect(s.lastStats).toMatchObject({ updated: 0 });
  });

  it('R2-04: pagination stops on empty pages, repeated next URLs and the page cap', async () => {
    let mode: 'empty' | 'self' | 'endless' = 'empty';
    let n = 0;
    mock = await startMockServer((req) => {
      if (req.path === '/api/graphql') return { json: { data: { repository: {} } } };
      if (req.path.endsWith('/files')) return { json: [] };
      if (!req.path.endsWith('/pulls')) return notFoundReply(req);
      n++;
      const page = Number(req.query.get('page') ?? '1');
      const host = `http://${req.headers.host}`;
      const state = req.query.get('state');
      if (mode === 'empty') {
        return {
          json: [],
          headers: { link: `<${host}${req.path}?state=${state}&page=1>; rel="next"` },
        };
      }
      // one closed-in-window PR per page so the listing never runs dry
      const pr = restPr('acme/api', {
        number: page,
        title: 't',
        branch: 'b',
        state: 'closed',
        updated_at: iso(1),
      });
      const next = mode === 'self' ? 1 : page + 1;
      return {
        json: [pr],
        headers: { link: `<${host}${req.path}?state=${state}&page=${next}>; rel="next"` },
      };
    });
    const config = loadConfig({ NODE_ENV: 'test', ...env(mock.url) });
    t = await createTestApp(env(mock.url), { providers: [createGithubProvider(config.github)] });
    const run = async () => {
      n = 0;
      await t!.app.inject({ method: 'POST', url: '/api/integrations/github/sync' });
      await t!.runner.waitForIdle();
      return (await t!.app.inject({ url: '/api/integrations' })).json<IntegrationStatus[]>()[0]!;
    };
    let s = await run();
    expect(s.lastError).toBeNull();
    expect(n).toBe(2); // one empty page per listing (open + closed)

    mode = 'self';
    s = await run();
    expect(s.lastError).toBeNull();
    expect(n).toBeLessThanOrEqual(6); // first page + the self link once per listing

    mode = 'endless';
    s = await run();
    expect(s.lastError).toBeNull();
    expect(n).toBeLessThanOrEqual(2 * maxPages(300));
  });

  it('R2-03: a PR listing every key is capped at 50 links', async () => {
    const body = Array.from({ length: 80 }, (_, i) => `PAY-${i + 1}`).join(' ');
    mock = await startMockServer(
      githubHandler('acme/api', [{ number: 1, title: 'spam', body, branch: 'b' }]),
    );
    t = await createTestApp(env(mock.url));
    for (let i = 1; i <= 80; i++) await createCase({ key: `PAY-${i}`, jiraKey: `PAY-${i}` });
    await t.app.inject({ method: 'POST', url: '/api/integrations/github/sync' });
    await t.runner.waitForIdle();
    const s = (await t.app.inject({ url: '/api/integrations' })).json<IntegrationStatus[]>()[0]!;
    expect(s.lastStats?.linked).toBe(50);
  });
});
