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
import { CaseIndex, LINK_LIMITS, linkPullRequest, type CaseLink, type PrFile } from './prLinks.js';
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
  /** Patch text inspected per PR / per sync (bytes of UTF-16 chars, approx.). */
  patchCharsPerPr: 1024 * 1024,
  patchCharsPerSync: 20 * 1024 * 1024,
} as const;

/** Hard page cap for a listing: ceil(cap / perPage) + 1. */
export const maxPages = (cap: number, perPage: number = GITHUB_LIMITS.perPage) =>
  Math.ceil(cap / perPage) + 1;

/**
 * Follow `rel="next"` pagination safely: stops on an empty page, on a
 * repeated next URL, at the item cap and at a hard page cap.
 */
export async function paginate<T>(
  gh: HttpClient,
  firstUrl: string,
  query: Record<string, string | number>,
  schema: z.ZodType<T[]>,
  cap: number,
  onItem: (item: T) => 'stop' | void,
): Promise<void> {
  let url: string | null = firstUrl;
  const seenUrls = new Set<string>();
  let count = 0;
  for (let page = 0; url && page < maxPages(cap); page++) {
    const res: { data: T[]; headers: Headers } = await gh.get(url, {
      query: page === 0 ? query : undefined,
      schema,
    });
    if (res.data.length === 0) return;
    for (const item of res.data) {
      if (count >= cap) return;
      count++;
      if (onItem(item) === 'stop') return;
    }
    const next = nextLink(res.headers.get('link'));
    if (!next) return;
    const key = gh.resolve(next).href;
    if (seenUrls.has(key)) return;
    seenUrls.add(key);
    url = next;
  }
}

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
        nodes: z
          .array(
            z.object({ author: Login, state: z.string(), submittedAt: z.string().nullish() }).nullish(),
          )
          .nullish(),
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

/** submittedAt of the latest APPROVED review (null if none visible / no timestamps). */
export function latestApprovalAt(
  reviews: ReadonlyArray<{ state: string; submittedAt?: string | null }>,
): string | null {
  let best: number | null = null;
  for (const r of reviews) {
    if (r.state !== 'APPROVED' || !r.submittedAt) continue;
    const t = Date.parse(r.submittedAt);
    if (!Number.isNaN(t) && (best === null || t > best)) best = t;
  }
  return best === null ? null : new Date(best).toISOString();
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
  reviews(last: 50) { nodes { author { login } state submittedAt } }
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
    budget: { patchChars: number; warned: boolean },
    stats: { droppedLinks: number },
  ): Promise<SyncStats> {
    const [owner, name] = repo.split('/') as [string, string];
    const repoPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
    const err = (e: unknown): never => {
      if (e instanceof Error) e.message = `${repo}: ${e.message}`;
      throw e;
    };

    // --- 1. list PRs ------------------------------------------------------
    const byNumber = new Map<number, RestPr>();
    const listPages = (
      query: Record<string, string | number>,
      cap: number,
      stop?: (pr: RestPr) => boolean,
    ) =>
      paginate(gh, `${repoPath}/pulls`, query, z.array(RestPr), cap, (pr) => {
        if (stop?.(pr)) return 'stop';
        if (!byNumber.has(pr.number)) byNumber.set(pr.number, pr);
      });
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

    // --- 2. changed test files → links, one PR at a time ------------------
    // Patches are linked as soon as a PR's files are fetched and then dropped,
    // so at most `concurrency` PRs' patches are held in memory. Patch text is
    // capped per file (prLinks), per PR and per sync.
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
    const linksByPr = new Map<number, CaseLink[]>();
    await mapLimit(prs, GITHUB_LIMITS.concurrency, async (pr) => {
      const files: PrFile[] = [];
      let prBudget: number = GITHUB_LIMITS.patchCharsPerPr;
      try {
        await paginate(
          gh,
          `${repoPath}/pulls/${pr.number}/files`,
          { per_page: GITHUB_LIMITS.perPage },
          z.array(RestFile),
          GITHUB_LIMITS.filesPerPr,
          (f) => {
            if (!isTestFile(f.filename)) return;
            let patch = f.patch ?? null;
            if (patch) {
              patch = patch.slice(
                0,
                Math.min(LINK_LIMITS.maxPatchChars, prBudget, budget.patchChars),
              );
              prBudget -= patch.length;
              budget.patchChars -= patch.length;
              if (budget.patchChars <= 0 && !budget.warned) {
                budget.warned = true;
                ctx.log.warn(
                  { repo },
                  'GitHub sync patch budget exhausted; remaining diffs are not scanned',
                );
              }
            }
            files.push({ filename: f.filename.slice(0, 1024), patch });
          },
        );
      } catch (e) {
        err(e);
      }
      const { links: prLinks, dropped } = linkPullRequest(
        { title: pr.title, body: pr.body ?? null, headBranch: pr.head?.ref ?? null, files },
        index,
      );
      if (dropped > 0) {
        stats.droppedLinks += dropped;
        ctx.log.warn(
          { repo, pr: pr.number, kept: prLinks.length, dropped },
          'PR links to too many test cases; kept the strongest links only',
        );
      }
      linksByPr.set(pr.number, prLinks);
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

    // --- 4. assemble + persist --------------------------------------------

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
        .map((r) => ({
          author: r.author?.login ?? null,
          state: r.state,
          submittedAt: r.submittedAt ?? null,
        }));
      const unresolvedThreads = (g?.reviewThreads?.nodes ?? []).filter(
        (t) => t && !t.isResolved,
      ).length;
      const rollup = g?.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state ?? null;
      const state = prState({
        state: pr.state,
        draft: g?.isDraft ?? pr.draft,
        merged_at: pr.merged_at,
      });

      const reviewState = deriveReviewState(g?.reviewDecision, reviews, requestedReviewers);
      upserts.push({
        number: pr.number,
        title: pr.title.slice(0, 500),
        url: safeHtmlUrl(pr.html_url, `https://github.com/${repo}/pull/${pr.number}`),
        state,
        author: pr.user?.login ?? null,
        headBranch: pr.head?.ref ?? null,
        reviewState,
        requestedReviewers,
        unresolvedThreads,
        checks: deriveChecks(rollup),
        createdAt: pr.created_at,
        updatedAt: pr.updated_at,
        mergedAt: pr.merged_at ?? null,
        approvedAt: reviewState === 'approved' ? latestApprovalAt(reviews) : null,
      });
      for (const l of linksByPr.get(pr.number) ?? []) {
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
    const { linked, promoted } = replaceRepoPullRequests(db, repo, upserts, links);
    const created = upserts.filter((p) => !existing.has(p.number)).length;
    // updated = test cases auto-promoted to `automated` because a linked PR merged
    return { fetched: upserts.length, created, updated: promoted, linked };
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
      const budget = { patchChars: GITHUB_LIMITS.patchCharsPerSync as number, warned: false };
      for (const repo of config.repos) {
        const repoStats = { droppedLinks: 0 };
        const s = await syncRepo(gh, ctx.db, repo, ctx, budget, repoStats);
        if (repoStats.droppedLinks > 0) {
          ctx.log.warn(
            { repo, droppedLinks: repoStats.droppedLinks },
            'GitHub sync: some PR links were capped',
          );
        }
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
