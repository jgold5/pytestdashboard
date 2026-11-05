/**
 * GitHub-driven automation pipeline (SPEC "Automation pipeline").
 *
 * `pipelineStage` is derived on read with ONE SQL expression (`pipelineStageSql`)
 * so it can be filtered, counted and grouped without a denormalized column that
 * could go stale. `derivePipelineStage` is the same rule as a pure function: it
 * documents the precedence, is unit-tested exhaustively, and a DB test asserts
 * that the SQL agrees with it on every combination.
 */
import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { AutomationStatus, PipelineCounts, PipelineStage } from '@ptd/shared';
import { PipelineStage as PipelineStageEnum } from '@ptd/shared';
import type { Db } from '../db/client.js';
import {
  pullRequests,
  testCasePullRequests,
  testCases,
  type ChecksState,
  type PrState,
  type ReviewState,
} from '../db/schema.js';

// ---------------------------------------------------------------------------
// Pure rules
// ---------------------------------------------------------------------------

export interface PrForStage {
  state: PrState;
  reviewState: ReviewState;
  checks: ChecksState;
  unresolvedThreads: number;
  mergedAt: string | null;
}

/** "Done, awaiting merge": open (not draft), approved, checks passing/none, no unresolved threads. */
export function isReadyToMerge(pr: Omit<PrForStage, 'mergedAt'>): boolean {
  return (
    pr.state === 'open' &&
    pr.reviewState === 'approved' &&
    (pr.checks === 'passing' || pr.checks === 'none') &&
    pr.unresolvedThreads === 0
  );
}

/** SQL twin of isReadyToMerge for a `pull_requests` row (unaliased table). */
export const readyToMergeSql: SQL = sql`(${pullRequests.state} = 'open' AND ${pullRequests.reviewState} = 'approved' AND ${pullRequests.checks} IN ('passing', 'none') AND ${pullRequests.unresolvedThreads} = 0)`;

export interface StageInput {
  automationStatus: AutomationStatus;
  automatedAt: string | null;
  /** All PRs linked to the case (any state). */
  prs: readonly PrForStage[];
  /** Latest COALESCE(startedAt, importedAt) of a run with a passed/failed result for the case; null if none. */
  lastExecutedAt: string | null;
}

/**
 * Precedence (first match wins):
 *  1. not_automatable status → not_automatable
 *  2. status ≠ automated and ≥1 open/draft PR → best open PR:
 *     ready_to_merge > in_review (open, not ready) > pr_draft
 *  3. ≥1 merged PR, M = latest mergedAt, case not automated before M
 *     (status ≠ automated or automatedAt ≥ M), no passed/failed result in a
 *     run after M → merged_awaiting_run
 *  4. automated → automated; in_progress → in_progress; not_automated → not_started
 */
export function derivePipelineStage(c: StageInput): PipelineStage {
  if (c.automationStatus === 'not_automatable') return 'not_automatable';

  if (c.automationStatus !== 'automated') {
    let rank = 0; // 1 draft, 2 in review, 3 ready
    for (const pr of c.prs) {
      if (pr.state === 'draft') rank = Math.max(rank, 1);
      else if (pr.state === 'open') rank = Math.max(rank, isReadyToMerge(pr) ? 3 : 2);
    }
    if (rank === 3) return 'ready_to_merge';
    if (rank === 2) return 'in_review';
    if (rank === 1) return 'pr_draft';
  }

  let mergedAt: string | null = null;
  for (const pr of c.prs) {
    if (pr.state === 'merged' && pr.mergedAt && (mergedAt === null || pr.mergedAt > mergedAt)) mergedAt = pr.mergedAt;
  }
  if (mergedAt !== null) {
    const notAutomatedBefore =
      c.automationStatus !== 'automated' || (c.automatedAt !== null && c.automatedAt >= mergedAt);
    const ranSince = c.lastExecutedAt !== null && c.lastExecutedAt > mergedAt;
    if (notAutomatedBefore && !ranSince) return 'merged_awaiting_run';
  }

  switch (c.automationStatus) {
    case 'automated':
      return 'automated';
    case 'in_progress':
      return 'in_progress';
    default:
      return 'not_started';
  }
}

// ---------------------------------------------------------------------------
// SQL (correlated on the outer, unaliased `test_cases` table)
// ---------------------------------------------------------------------------

const tc = testCases;

/** Best open-PR rank: 3 ready, 2 in review, 1 draft, NULL = no open PR. */
const openRank = sql`(SELECT max(CASE WHEN p.state = 'draft' THEN 1 WHEN p.review_state = 'approved' AND p.checks IN ('passing', 'none') AND p.unresolved_threads = 0 THEN 3 ELSE 2 END) FROM test_case_pull_requests l JOIN pull_requests p ON p.id = l.pull_request_id WHERE l.test_case_id = ${tc.id} AND p.state IN ('open', 'draft'))`;

/** Latest mergedAt of a linked merged PR (NULL = none). */
const lastMergedAt = sql`(SELECT max(p.merged_at) FROM test_case_pull_requests l JOIN pull_requests p ON p.id = l.pull_request_id WHERE l.test_case_id = ${tc.id} AND p.state = 'merged' AND p.merged_at IS NOT NULL)`;

/** A passed/failed result in a run that started after the latest merge. */
const executedSinceMerge = sql`EXISTS (SELECT 1 FROM test_results r JOIN runs ru ON ru.id = r.run_id WHERE r.test_case_id = ${tc.id} AND r.status IN ('passed', 'failed') AND ru.sort_at > ${lastMergedAt})`;

/** SQL twin of derivePipelineStage — usable in SELECT, WHERE and GROUP BY over `test_cases`. */
export const pipelineStageSql: SQL<PipelineStage> = sql<PipelineStage>`(CASE
  WHEN ${tc.automationStatus} = 'not_automatable' THEN 'not_automatable'
  WHEN ${tc.automationStatus} <> 'automated' AND ${openRank} = 3 THEN 'ready_to_merge'
  WHEN ${tc.automationStatus} <> 'automated' AND ${openRank} = 2 THEN 'in_review'
  WHEN ${tc.automationStatus} <> 'automated' AND ${openRank} = 1 THEN 'pr_draft'
  WHEN ${lastMergedAt} IS NOT NULL
    AND (${tc.automationStatus} <> 'automated' OR ${tc.automatedAt} >= ${lastMergedAt})
    AND NOT ${executedSinceMerge} THEN 'merged_awaiting_run'
  WHEN ${tc.automationStatus} = 'automated' THEN 'automated'
  WHEN ${tc.automationStatus} = 'in_progress' THEN 'in_progress'
  ELSE 'not_started'
END)`;

export function pipelineStageFilter(stage: PipelineStage): SQL {
  return sql`${pipelineStageSql} = ${stage}`;
}

export function pipelineStagesForCases(db: Db, ids: number[]): Map<number, PipelineStage> {
  const out = new Map<number, PipelineStage>();
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    for (const r of db
      .select({ id: testCases.id, stage: pipelineStageSql })
      .from(testCases)
      .where(inArray(testCases.id, chunk))
      .all()) {
      out.set(r.id, r.stage);
    }
  }
  return out;
}

export function emptyPipelineCounts(): PipelineCounts {
  return Object.fromEntries(PipelineStageEnum.options.map((s) => [s, 0])) as PipelineCounts;
}

/** Cases per stage (every stage present). */
export function computePipelineCounts(db: Db): PipelineCounts {
  const counts = emptyPipelineCounts();
  for (const r of db
    .select({ stage: pipelineStageSql, n: sql<number>`count(*)` })
    .from(testCases)
    .groupBy(pipelineStageSql)
    .all()) {
    counts[r.stage] = r.n;
  }
  return counts;
}

/** automated + not-yet-automated cases that are ready to merge / merged awaiting a run. */
export function countProjectedAutomated(db: Db): number {
  return (
    db
      .select({ n: sql<number>`count(*)` })
      .from(testCases)
      .where(
        sql`(${testCases.automationStatus} = 'automated' OR ${pipelineStageSql} IN ('ready_to_merge', 'merged_awaiting_run'))`,
      )
      .get()?.n ?? 0
  );
}

// ---------------------------------------------------------------------------
// Auto-promotion on merge
// ---------------------------------------------------------------------------

/**
 * Cases linked to the given (newly) merged PRs that are not_automated /
 * in_progress become `automated` (automatedAt = latest mergedAt, via
 * 'pr_merge'). not_automatable and automated cases are never touched.
 * Returns the number of promoted cases. Call inside the sync transaction.
 */
export function promoteCasesForMergedPrs(db: Db, prIds: number[], now: string): number {
  if (prIds.length === 0) return 0;
  const rows = db
    .select({ id: testCases.id, mergedAt: sql<string | null>`max(${pullRequests.mergedAt})` })
    .from(testCasePullRequests)
    .innerJoin(pullRequests, eq(pullRequests.id, testCasePullRequests.pullRequestId))
    .innerJoin(testCases, eq(testCases.id, testCasePullRequests.testCaseId))
    .where(
      and(
        inArray(testCasePullRequests.pullRequestId, prIds),
        eq(pullRequests.state, 'merged'),
        inArray(testCases.automationStatus, ['not_automated', 'in_progress']),
      ),
    )
    .groupBy(testCases.id)
    .all();
  for (const r of rows) {
    db.update(testCases)
      .set({ automationStatus: 'automated', automatedAt: r.mergedAt ?? now, automatedVia: 'pr_merge', updatedAt: now })
      .where(and(eq(testCases.id, r.id), inArray(testCases.automationStatus, ['not_automated', 'in_progress'])))
      .run();
  }
  return rows.length;
}
