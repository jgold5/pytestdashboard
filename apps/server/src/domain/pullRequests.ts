import { and, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { PullRequest, PullRequestQuery, Summary } from '@ptd/shared';
import type { Db } from '../db/client.js';
import {
  pullRequests,
  testCasePullRequests,
  testCases,
  type ChecksState,
  type LinkedBy,
  type PrState,
  type PullRequestRow,
  type ReviewState,
} from '../db/schema.js';
import { nowIso } from '../util/time.js';

export type PrPipeline = Summary['prPipeline'];

/** Open PRs waiting on the author: changes requested OR unresolved threads OR failing checks. */
export function computeNeedsAttention(pr: {
  state: PrState;
  reviewState: ReviewState;
  unresolvedThreads: number;
  checks: ChecksState;
}): boolean {
  const open = pr.state === 'open' || pr.state === 'draft';
  return open && (pr.reviewState === 'changes_requested' || pr.unresolvedThreads > 0 || pr.checks === 'failing');
}

const isLinked = sql`EXISTS (SELECT 1 FROM ${testCasePullRequests} WHERE ${testCasePullRequests.pullRequestId} = ${pullRequests.id})`;

export function listPullRequests(db: Db, q: PullRequestQuery): PullRequest[] {
  const conds: SQL[] = [];
  if (q.state) conds.push(eq(pullRequests.state, q.state));
  if (q.reviewState) conds.push(eq(pullRequests.reviewState, q.reviewState));
  if (q.needsAttention !== undefined) conds.push(eq(pullRequests.needsAttention, q.needsAttention));
  if (q.repo !== undefined) conds.push(eq(pullRequests.repo, q.repo));
  if (q.author !== undefined) conds.push(eq(pullRequests.author, q.author));
  if (q.linkedOnly) conds.push(isLinked);
  const rows = db
    .select()
    .from(pullRequests)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(pullRequests.needsAttention), desc(pullRequests.updatedAt), desc(pullRequests.id))
    .limit(1000)
    .all();
  return serializePullRequests(db, rows);
}

export function serializePullRequests(db: Db, rows: PullRequestRow[]): PullRequest[] {
  const ids = rows.map((r) => r.id);
  const cases = new Map<number, PullRequest['testCases']>();
  if (ids.length > 0) {
    for (const l of db
      .select({ prId: testCasePullRequests.pullRequestId, id: testCases.id, key: testCases.key, title: testCases.title })
      .from(testCasePullRequests)
      .innerJoin(testCases, eq(testCases.id, testCasePullRequests.testCaseId))
      .where(inArray(testCasePullRequests.pullRequestId, ids))
      .orderBy(testCases.key)
      .all()) {
      const list = cases.get(l.prId) ?? [];
      list.push({ id: l.id, key: l.key, title: l.title });
      cases.set(l.prId, list);
    }
  }
  return rows.map((r) => ({
    id: r.id,
    repo: r.repo,
    number: r.number,
    title: r.title,
    url: r.url,
    state: r.state,
    author: r.author,
    headBranch: r.headBranch,
    reviewState: r.reviewState,
    requestedReviewers: r.requestedReviewers,
    unresolvedThreads: r.unresolvedThreads,
    checks: r.checks,
    needsAttention: r.needsAttention,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    testCases: cases.get(r.id) ?? [],
  }));
}

/** Open automation PRs (linked to ≥1 case), by review state. */
export function computePrPipeline(db: Db): PrPipeline {
  const rows = db
    .select({
      state: pullRequests.state,
      reviewState: pullRequests.reviewState,
      unresolvedThreads: pullRequests.unresolvedThreads,
      needsAttention: pullRequests.needsAttention,
    })
    .from(pullRequests)
    .where(and(inArray(pullRequests.state, ['open', 'draft']), isLinked))
    .all();
  const p: PrPipeline = {
    open: rows.length,
    draft: 0,
    reviewRequired: 0,
    changesRequested: 0,
    approved: 0,
    unresolvedThreads: 0,
    needsAttention: 0,
  };
  for (const r of rows) {
    p.unresolvedThreads += r.unresolvedThreads;
    if (r.needsAttention) p.needsAttention++;
    if (r.state === 'draft') p.draft++;
    else if (r.reviewState === 'changes_requested') p.changesRequested++;
    else if (r.reviewState === 'approved') p.approved++;
    else p.reviewRequired++; // review_required or none: waiting for review
  }
  return p;
}

// ---------------------------------------------------------------------------
// Write helpers for the GitHub integration (and the seed script)
// ---------------------------------------------------------------------------

export interface PullRequestUpsert {
  number: number;
  title: string;
  url: string;
  state: PrState;
  author: string | null;
  headBranch: string | null;
  reviewState: ReviewState;
  requestedReviewers: string[];
  unresolvedThreads: number;
  checks: ChecksState;
  createdAt: string;
  updatedAt: string;
  mergedAt: string | null;
}

export interface PullRequestLink {
  prNumber: number;
  testCaseId: number;
  linkedBy: LinkedBy;
}

/**
 * Upsert a repo's PRs and atomically replace all of that repo's case links.
 * PRs no longer returned by GitHub are kept (history for "merged in period")
 * but lose their links. Returns the number of links written.
 */
export function replaceRepoPullRequests(
  db: Db,
  repo: string,
  prs: PullRequestUpsert[],
  links: PullRequestLink[],
): number {
  return db.transaction((tx) => {
    const idByNumber = new Map<number, number>();
    const syncedAt = nowIso();
    for (const pr of prs) {
      const values = {
        repo,
        number: pr.number,
        title: pr.title,
        url: pr.url,
        state: pr.state,
        author: pr.author,
        headBranch: pr.headBranch,
        reviewState: pr.reviewState,
        requestedReviewers: pr.requestedReviewers,
        unresolvedThreads: pr.unresolvedThreads,
        checks: pr.checks,
        needsAttention: computeNeedsAttention(pr),
        createdAt: pr.createdAt || syncedAt,
        updatedAt: pr.updatedAt || syncedAt,
        mergedAt: pr.mergedAt,
      };
      const row = tx
        .insert(pullRequests)
        .values(values)
        .onConflictDoUpdate({ target: [pullRequests.repo, pullRequests.number], set: values })
        .returning({ id: pullRequests.id })
        .get();
      idByNumber.set(pr.number, row.id);
    }
    const repoPrIds = tx
      .select({ id: pullRequests.id })
      .from(pullRequests)
      .where(eq(pullRequests.repo, repo))
      .all()
      .map((r) => r.id);
    if (repoPrIds.length > 0) {
      tx.delete(testCasePullRequests).where(inArray(testCasePullRequests.pullRequestId, repoPrIds)).run();
    }
    const seen = new Set<string>();
    const rows: Array<typeof testCasePullRequests.$inferInsert> = [];
    for (const l of links) {
      const prId = idByNumber.get(l.prNumber);
      const k = `${l.testCaseId}:${prId}`;
      if (prId === undefined || seen.has(k)) continue;
      seen.add(k);
      rows.push({ testCaseId: l.testCaseId, pullRequestId: prId, linkedBy: l.linkedBy });
    }
    for (let i = 0; i < rows.length; i += 500) {
      tx.insert(testCasePullRequests).values(rows.slice(i, i + 500)).run();
    }
    return rows.length;
  });
}
