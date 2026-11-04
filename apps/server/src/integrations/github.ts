/**
 * GitHub PR sync (SPEC "GitHub").
 * - REST: list open PRs (cap 300) + PRs closed/merged in the last 14 days,
 *   and `GET /pulls/:n/files` (cap 300 files; only files matching the test
 *   globs; `patch` text) for linking.
 * - GraphQL (batched via aliases, 20 PRs/query): isDraft, reviewDecision,
 *   requested reviewers, reviews, review threads, statusCheckRollup.
 * - Links per prLinks.ts, persisted atomically per repo via
 *   replaceRepoPullRequests.
 * GHES: GITHUB_API_URL=https://ghe.example.com/api/v3 → GraphQL at
 * https://ghe.example.com/api/graphql.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { GithubConfig } from '../config.js';
import type { Db } from '../db/client.js';
import {
  pullRequests,
  testCases,
  type ChecksState,
  type PrState,
  type ReviewState,
} from '../db/schema.js';
import {
  replaceRepoPullRequests,
  type PullRequestLink,
  type PullRequestUpsert,
} from '../domain/pullRequests.js';
import { createGlobMatcher } from './glob.js';
import { HttpClient, HttpError, nextLink, type HttpClientOptions } from './http.js';
import { CaseIndex, linkPullRequest, type PrFile } from './prLinks.js';
import type { IntegrationProvider, SyncContext, SyncStats } from './registry.js';

export const GITHUB_LIMITS = {
  openPrs: 300,
  recentClosedPrs: 300,
  recentDays: 14,
  filesPerPr: 300,
  perPage: 100,
  graphqlBatch: 20,
  stalePrRefresh: 50,
  concurrency: 4,
} as const;

export interface GithubProviderOptions {
  /** Test hooks: override HTTP client settings (backoff, sleep, timeouts). */
  http?: Partial<Omit<HttpClientOptions, 'baseUrl' | 'label' | 'headers' | 'signal'>>;
  now?: () => Date;
}

// ---------------------------------------------------------------------------
// Response schemas (permissive: unknown fields are ignored)
// ---------------------------------------------------------------------------

const Login = z.object({ login: z.string() }).nullish();

const RestPr = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  body: z.string().nullish(),
  html_url: z.string().nullish(),
  state: z.string(),
  draft: z.boolean().nullish(),
  merged_at: z.string().nullish(),
  created_at: z.string(),
  updated_at: z.string(),
  user: Login,
  head: z.object({ ref: z.string() }).nullish(),
  requested_reviewers: z.array(z.object({ login: z.string() }).nullish()).nullish(),
  requested_teams: z
    .array(z.object({ name: z.string().nullish(), slug: z.string().nullish() }).nullish())
    .nullish(),
});
type RestPr = z.infer<typeof RestPr>;

const RestFile = z.object({ filename: z.string(), patch: z.string().nullish() });

const GqlPr = z
  .object({
    number: z.number().int().nullish(),
    isDraft: z.boolean().nullish(),
    reviewDecision: z.string().nullish(),
    reviewRequests: z
      .object({
        nodes: z
          .array(
            z
              .object({
                requestedReviewer: z
                  .object({
                    login: z.string().nullish(),
                    name: z.string().nullish(),
                    slug: z.string().nullish(),
                  })
                  .nullish(),
              })
              .nullish(),
          )
          .nullish(),
      })
      .nullish(),
    reviews: z
      .object({
        nodes: z.array(z.object({ author: Login, state: z.string() }).nullish()).nullish(),
      })
      .nullish(),
    reviewThreads: z
      .object({ nodes: z.array(z.object({ isResolved: z.boolean() }).nullish()).nullish() })
      .nullish(),
    commits: z
      .object({
        nodes: z
          .array(
            z
              .object({
                commit: z
                  .object({ statusCheckRollup: z.object({ state: z.string() }).nullish() })
                  .nullish(),
              })
              .nullish(),
          )
          .nullish(),
      })
      .nullish(),
  })
  .nullish();
export type GqlPr = z.infer<typeof GqlPr>;

const GqlResponse = z.object({
  data: z.object({ repository: z.record(z.string(), GqlPr).nullish() }).nullish(),
  errors: z.array(z.object({ message: z.string().nullish() })).nullish(),
});

// ---------------------------------------------------------------------------
// Derivations (exported for tests)
// ---------------------------------------------------------------------------

export function prState(pr: Pick<RestPr, 'state' | 'draft' | 'merged_at'>): PrState {
  if (pr.merged_at) return 'merged';
  if (pr.state === 'closed') return 'closed';
  return pr.draft ? 'draft' : 'open';
}

/** SPEC: reviewDecision first; otherwise latest review per reviewer, then requested reviewers. */
export function deriveReviewState(
  reviewDecision: string | null | undefined,
  reviews: ReadonlyArray<{ author: string | null; state: string }>,
  requestedReviewers: readonly string[],
): ReviewState {
  switch (reviewDecision) {
    case 'APPROVED':
      return 'approved';
    case 'CHANGES_REQUESTED':
      return 'changes_requested';
    case 'REVIEW_REQUIRED':
      return 'review_required';
  }
  const latest = new Map<string, string>();
  reviews.forEach((r, i) => {
    // COMMENTED/PENDING reviews don't change a reviewer's verdict (GitHub semantics)
    if (r.state !== 'APPROVED' && r.state !== 'CHANGES_REQUESTED' && r.state !== 'DISMISSED')
      return;
    latest.set(r.author ?? `#ghost-${i}`, r.state);
  });
  const verdicts = [...latest.values()];
  if (verdicts.includes('CHANGES_REQUESTED')) return 'changes_requested';
  if (verdicts.includes('APPROVED')) return 'approved';
  if (requestedReviewers.length > 0) return 'review_required';
  return 'none';
}

export function deriveChecks(rollup: string | null | undefined): ChecksState {
  switch (rollup) {
    case 'SUCCESS':
      return 'passing';
    case 'FAILURE':
    case 'ERROR':
      return 'failing';
    case 'PENDING':
    case 'EXPECTED':
      return 'pending';
    default:
      return 'none';
  }
}

export function graphqlUrl(apiUrl: string): string {
  const u = new URL(apiUrl);
  return u.hostname === 'api.github.com' ? `${u.origin}/graphql` : `${u.origin}/api/graphql`;
}

function safeHtmlUrl(raw: string | null | undefined, fallback: string): string {
  if (raw && /^https?:\/\//i.test(raw)) return raw;
  return fallback;
}

const PR_FRAGMENT = `fragment PrInfo on PullRequest {
  number isDraft reviewDecision
  reviewRequests(first: 20) { nodes { requestedReviewer { ... on User { login } ... on Team { name slug } ... on Mannequin { login } ... on Bot { login } } } }
  reviews(last: 50) { nodes { author { login } state } }
  reviewThreads(first: 100) { nodes { isResolved } }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
}`;

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}

export function createGithubProvider(
  config: GithubConfig,
  opts: GithubProviderOptions = {},
): IntegrationProvider {
  const isTestFile = createGlobMatcher(config.testPathGlobs);
  const now = opts.now ?? (() => new Date());

  async function syncRepo(
    gh: HttpClient,
    db: Db,
    repo: string,
    ctx: SyncContext,
  ): Promise<SyncStats> {
    const [owner, name] = repo.split('/') as [string, string];
    const repoPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
    const err = (e: unknown): never => {
      if (e instanceof Error) e.message = `${repo}: ${e.message}`;
      throw e;
    };

    // --- 1. list PRs ------------------------------------------------------
    const byNumber = new Map<number, RestPr>();
    const listPages = async (
      query: Record<string, string | number>,
      cap: number,
      stop?: (pr: RestPr) => boolean,
    ) => {
      let url: string | null = `${repoPath}/pulls`;
      let first = true;
      let count = 0;
      while (url && count < cap) {
        const res = await gh.get(url, {
          query: first ? query : undefined,
          schema: z.array(RestPr),
        });
        first = false;
        for (const pr of res.data) {
          if (stop?.(pr)) return;
          if (count >= cap) return;
          count++;
          if (!byNumber.has(pr.number)) byNumber.set(pr.number, pr);
        }
        url = nextLink(res.headers.get('link'));
      }
    };
    const cutoff = new Date(now().getTime() - GITHUB_LIMITS.recentDays * 86_400_000);
    try {
      await listPages(
        { state: 'open', per_page: GITHUB_LIMITS.perPage, sort: 'updated', direction: 'desc' },
        GITHUB_LIMITS.openPrs,
      );
      await listPages(
        { state: 'closed', per_page: GITHUB_LIMITS.perPage, sort: 'updated', direction: 'desc' },
        GITHUB_LIMITS.recentClosedPrs,
        (pr) => new Date(pr.updated_at) < cutoff,
      );
    } catch (e) {
      err(e);
    }
    // keep merged-in-window and closed-in-window (so their state is updated), drop older closed
    for (const [n, pr] of byNumber) {
      if (pr.state === 'closed' && new Date(pr.merged_at ?? pr.updated_at) < cutoff)
        byNumber.delete(n);
    }

    // PRs we still think are open but GitHub no longer lists as open (closed while
    // we weren't syncing): refresh them individually so they don't stay "open".
    const staleOpen = db
      .select({ number: pullRequests.number })
      .from(pullRequests)
      .where(and(eq(pullRequests.repo, repo), inArray(pullRequests.state, ['open', 'draft'])))
      .all()
      .map((r) => r.number)
      .filter((n) => !byNumber.has(n))
      .slice(0, GITHUB_LIMITS.stalePrRefresh);
    await mapLimit(staleOpen, GITHUB_LIMITS.concurrency, async (n) => {
      try {
        const res = await gh.get(`${repoPath}/pulls/${n}`, { schema: RestPr });
        byNumber.set(res.data.number, res.data);
      } catch (e) {
        if (e instanceof HttpError && (e.status === 404 || e.status === 410)) return;
        err(e);
      }
    });

    const prs = [...byNumber.values()];

    // --- 2. changed test files --------------------------------------------
    const filesByPr = new Map<number, PrFile[]>();
    await mapLimit(prs, GITHUB_LIMITS.concurrency, async (pr) => {
      const files: PrFile[] = [];
      let url: string | null = `${repoPath}/pulls/${pr.number}/files`;
      let first = true;
      let seen = 0;
      try {
        while (url && seen < GITHUB_LIMITS.filesPerPr) {
          const res = await gh.get(url, {
            query: first ? { per_page: GITHUB_LIMITS.perPage } : undefined,
            schema: z.array(RestFile),
          });
          first = false;
          for (const f of res.data) {
            if (seen++ >= GITHUB_LIMITS.filesPerPr) break;
            if (isTestFile(f.filename))
              files.push({ filename: f.filename, patch: f.patch ?? null });
          }
          url = nextLink(res.headers.get('link'));
        }
      } catch (e) {
        err(e);
      }
      filesByPr.set(pr.number, files);
    });

    // --- 3. review state via GraphQL --------------------------------------
    const gql = new Map<number, NonNullable<GqlPr>>();
    const gqlEndpoint = graphqlUrl(config.apiUrl);
    for (let i = 0; i < prs.length; i += GITHUB_LIMITS.graphqlBatch) {
      const batch = prs.slice(i, i + GITHUB_LIMITS.graphqlBatch);
      const fields = batch
        .map((pr) => `pr${pr.number}: pullRequest(number: ${pr.number}) { ...PrInfo }`)
        .join('\n');
      const query = `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) {\n${fields}\n} }\n${PR_FRAGMENT}`;
      let res;
      try {
        res = await gh.post(gqlEndpoint, {
          body: { query, variables: { owner, name } },
          schema: GqlResponse,
        });
      } catch (e) {
        return err(e);
      }
      const repoData = res.data.data?.repository;
      if (!repoData) {
        const msg = res.data.errors?.[0]?.message ?? 'no data returned';
        throw new HttpError(`${repo}: GitHub GraphQL error: ${msg.slice(0, 200)}`, res.status);
      }
      if (res.data.errors?.length) {
        ctx.log.warn(
          { repo, errors: res.data.errors.length },
          'GitHub GraphQL returned partial errors',
        );
      }
      for (const pr of batch) {
        const d = repoData[`pr${pr.number}`];
        if (d) gql.set(pr.number, d);
      }
    }

    // --- 4. assemble + link + persist -------------------------------------
    const caseRows = db
      .select({
        id: testCases.id,
        key: testCases.key,
        jiraKey: testCases.jiraKey,
        allureId: testCases.allureId,
        allureFullName: testCases.allureFullName,
      })
      .from(testCases)
      .all();
    const index = new CaseIndex(caseRows);

    const upserts: PullRequestUpsert[] = [];
    const links: PullRequestLink[] = [];
    for (const pr of prs) {
      const g = gql.get(pr.number);
      const gReviewers = (g?.reviewRequests?.nodes ?? [])
        .map(
          (n) =>
            n?.requestedReviewer?.login ??
            n?.requestedReviewer?.name ??
            n?.requestedReviewer?.slug ??
            null,
        )
        .filter((x): x is string => Boolean(x));
      const restReviewers = [
        ...(pr.requested_reviewers ?? []).map((r) => r?.login),
        ...(pr.requested_teams ?? []).map((t) => t?.name ?? t?.slug),
      ].filter((x): x is string => Boolean(x));
      const requestedReviewers = [...new Set(g ? gReviewers : restReviewers)].slice(0, 50);
      const reviews = (g?.reviews?.nodes ?? [])
        .filter((r): r is NonNullable<typeof r> => Boolean(r))
        .map((r) => ({ author: r.author?.login ?? null, state: r.state }));
      const unresolvedThreads = (g?.reviewThreads?.nodes ?? []).filter(
        (t) => t && !t.isResolved,
      ).length;
      const rollup = g?.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state ?? null;
      const state = prState({
        state: pr.state,
        draft: g?.isDraft ?? pr.draft,
        merged_at: pr.merged_at,
      });

      upserts.push({
        number: pr.number,
        title: pr.title.slice(0, 500),
        url: safeHtmlUrl(pr.html_url, `https://github.com/${repo}/pull/${pr.number}`),
        state,
        author: pr.user?.login ?? null,
        headBranch: pr.head?.ref ?? null,
        reviewState: deriveReviewState(g?.reviewDecision, reviews, requestedReviewers),
        requestedReviewers,
        unresolvedThreads,
        checks: deriveChecks(rollup),
        createdAt: pr.created_at,
        updatedAt: pr.updated_at,
        mergedAt: pr.merged_at ?? null,
      });
      for (const l of linkPullRequest(
        {
          title: pr.title,
          body: pr.body ?? null,
          headBranch: pr.head?.ref ?? null,
          files: filesByPr.get(pr.number) ?? [],
        },
        index,
      )) {
        links.push({ prNumber: pr.number, testCaseId: l.testCaseId, linkedBy: l.linkedBy });
      }
    }

    const existing = new Set(
      db
        .select({ number: pullRequests.number })
        .from(pullRequests)
        .where(eq(pullRequests.repo, repo))
        .all()
        .map((r) => r.number),
    );
    const linked = replaceRepoPullRequests(db, repo, upserts, links);
    const created = upserts.filter((p) => !existing.has(p.number)).length;
    return { fetched: upserts.length, created, updated: upserts.length - created, linked };
  }

  return {
    name: 'github',
    isConfigured: () => Boolean(config.token) && config.repos.length > 0,
    describeTarget: () => {
      if (config.repos.length === 0) return null;
      const host = new URL(config.apiUrl).host;
      const repos = config.repos.join(', ');
      return host === 'api.github.com' ? repos : `${repos} (${host})`;
    },
    intervalMinutes: () => config.intervalMinutes,
    sync: async (ctx) => {
      if (!config.token) throw new Error('GITHUB_TOKEN is not set');
      const gh = new HttpClient({
        label: 'GitHub',
        baseUrl: config.apiUrl,
        headers: {
          authorization: `Bearer ${config.token}`,
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
        },
        secrets: [config.token],
        signal: ctx.signal,
        ...opts.http,
      });
      const total: SyncStats = { fetched: 0, created: 0, updated: 0, linked: 0 };
      for (const repo of config.repos) {
        const s = await syncRepo(gh, ctx.db, repo, ctx);
        total.fetched += s.fetched;
        total.created += s.created;
        total.updated += s.updated;
        total.linked += s.linked;
        ctx.log.info({ repo, ...s }, 'GitHub repo synced');
      }
      return total;
    },
  };
}
