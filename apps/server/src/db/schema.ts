/**
 * Drizzle table definitions. The DDL lives in ./migrations.ts (hand-written,
 * idempotent, versioned with PRAGMA user_version) and must be kept in sync.
 * A test asserts that every column declared here exists in the migrated DB.
 */
import { sql } from 'drizzle-orm';
import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import type { AutomationStatus, Priority, ResultStatus, TriageCategory } from '@ptd/shared';

export type CaseSource = 'manual' | 'spreadsheet' | 'allure' | 'jira';
export type PrState = 'open' | 'draft' | 'merged' | 'closed';
export type ReviewState = 'review_required' | 'changes_requested' | 'approved' | 'none';
export type ChecksState = 'passing' | 'failing' | 'pending' | 'none';
export type LinkedBy = 'key_in_title' | 'key_in_body' | 'key_in_branch' | 'marker_in_diff' | 'test_name_in_diff';

export const testCases = sqliteTable(
  'test_cases',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    key: text('key').notNull(),
    title: text('title').notNull(),
    suite: text('suite'),
    priority: text('priority').$type<Priority>(),
    automationStatus: text('automation_status').$type<AutomationStatus>().notNull().default('not_automated'),
    owner: text('owner'),
    tags: text('tags', { mode: 'json' }).$type<string[]>().notNull().default(sql`'[]'`),
    externalUrl: text('external_url'),
    allureFullName: text('allure_full_name'),
    allureId: text('allure_id'),
    jiraKey: text('jira_key'),
    source: text('source').$type<CaseSource>().notNull().default('manual'),
    /** Last time the case transitioned to `automated` (for "newly automated" stats). */
    automatedAt: text('automated_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    // --- denormalized stats, maintained by domain/caseStats.ts ---
    lastStatus: text('last_status').$type<ResultStatus>(),
    lastRunId: integer('last_run_id'),
    lastRunAt: text('last_run_at'),
    flakiness: real('flakiness').notNull().default(0),
    triage: text('triage').$type<TriageCategory>(),
    triageAt: text('triage_at'),
    noteCount: integer('note_count').notNull().default(0),
  },
  (t) => [
    uniqueIndex('test_cases_key_uq').on(t.key),
    uniqueIndex('test_cases_jira_key_uq').on(t.jiraKey),
    index('test_cases_allure_full_name_idx').on(t.allureFullName),
    index('test_cases_allure_id_idx').on(t.allureId),
    index('test_cases_suite_idx').on(t.suite),
    index('test_cases_status_idx').on(t.automationStatus),
    index('test_cases_owner_idx').on(t.owner),
    index('test_cases_last_status_idx').on(t.lastStatus),
    index('test_cases_source_idx').on(t.source),
    index('test_cases_updated_idx').on(t.updatedAt),
    index('test_cases_last_run_at_idx').on(t.lastRunAt),
    index('test_cases_flakiness_idx').on(t.flakiness),
    index('test_cases_created_idx').on(t.createdAt),
  ],
);

export const runs = sqliteTable(
  'runs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    branch: text('branch'),
    commit: text('commit_sha'),
    buildUrl: text('build_url'),
    environment: text('environment', { mode: 'json' }).$type<Record<string, string>>().notNull().default(sql`'{}'`),
    startedAt: text('started_at'),
    stoppedAt: text('stopped_at'),
    durationMs: integer('duration_ms'),
    importedAt: text('imported_at').notNull(),
    /** startedAt ?? importedAt — the chronological order of runs. */
    sortAt: text('sort_at').notNull(),
    passed: integer('passed').notNull().default(0),
    failed: integer('failed').notNull().default(0),
    broken: integer('broken').notNull().default(0),
    skipped: integer('skipped').notNull().default(0),
    unknown: integer('unknown').notNull().default(0),
    total: integer('total').notNull().default(0),
  },
  (t) => [index('runs_sort_idx').on(t.sortAt), index('runs_branch_idx').on(t.branch)],
);

export type NameValue = { name: string; value: string };

export const testResults = sqliteTable(
  'test_results',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    runId: integer('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    testCaseId: integer('test_case_id')
      .notNull()
      .references(() => testCases.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    fullName: text('full_name'),
    historyId: text('history_id'),
    status: text('status').$type<ResultStatus>().notNull(),
    durationMs: integer('duration_ms'),
    startedAt: text('started_at'),
    message: text('message'),
    trace: text('trace'),
    failureSignature: text('failure_signature'),
    retries: integer('retries').notNull().default(0),
    parameters: text('parameters', { mode: 'json' }).$type<NameValue[]>().notNull().default(sql`'[]'`),
    labels: text('labels', { mode: 'json' }).$type<NameValue[]>().notNull().default(sql`'[]'`),
  },
  (t) => [
    index('test_results_run_status_idx').on(t.runId, t.status),
    index('test_results_case_idx').on(t.testCaseId),
    index('test_results_run_sig_idx').on(t.runId, t.failureSignature),
    index('test_results_case_run_idx').on(t.testCaseId, t.runId),
  ],
);

export const notes = sqliteTable(
  'notes',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    testCaseId: integer('test_case_id')
      .notNull()
      .references(() => testCases.id, { onDelete: 'cascade' }),
    resultId: integer('result_id').references(() => testResults.id, { onDelete: 'set null' }),
    runId: integer('run_id').references(() => runs.id, { onDelete: 'set null' }),
    author: text('author').notNull(),
    body: text('body').notNull(),
    triage: text('triage').$type<TriageCategory>(),
    ticketUrl: text('ticket_url'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    index('notes_case_created_idx').on(t.testCaseId, t.createdAt),
    index('notes_run_idx').on(t.runId),
    index('notes_created_idx').on(t.createdAt),
  ],
);

export const coverageSnapshots = sqliteTable('coverage_snapshots', {
  date: text('date').primaryKey(), // YYYY-MM-DD (UTC)
  total: integer('total').notNull(),
  automated: integer('automated').notNull(),
  inProgress: integer('in_progress').notNull().default(0),
  notAutomatable: integer('not_automatable').notNull().default(0),
});

export const pullRequests = sqliteTable(
  'pull_requests',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    repo: text('repo').notNull(),
    number: integer('number').notNull(),
    title: text('title').notNull(),
    url: text('url').notNull(),
    state: text('state').$type<PrState>().notNull(),
    author: text('author'),
    headBranch: text('head_branch'),
    reviewState: text('review_state').$type<ReviewState>().notNull().default('none'),
    requestedReviewers: text('requested_reviewers', { mode: 'json' }).$type<string[]>().notNull().default(sql`'[]'`),
    unresolvedThreads: integer('unresolved_threads').notNull().default(0),
    checks: text('checks').$type<ChecksState>().notNull().default('none'),
    needsAttention: integer('needs_attention', { mode: 'boolean' }).notNull().default(false),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    mergedAt: text('merged_at'),
  },
  (t) => [
    uniqueIndex('pull_requests_repo_number_uq').on(t.repo, t.number),
    index('pull_requests_state_idx').on(t.state),
  ],
);

export const testCasePullRequests = sqliteTable(
  'test_case_pull_requests',
  {
    testCaseId: integer('test_case_id')
      .notNull()
      .references(() => testCases.id, { onDelete: 'cascade' }),
    pullRequestId: integer('pull_request_id')
      .notNull()
      .references(() => pullRequests.id, { onDelete: 'cascade' }),
    linkedBy: text('linked_by').$type<LinkedBy>().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.testCaseId, t.pullRequestId] }),
    index('tcpr_pr_idx').on(t.pullRequestId),
  ],
);

export type IntegrationStats = { fetched: number; created: number; updated: number; linked: number };

export const integrationState = sqliteTable('integration_state', {
  name: text('name').primaryKey(),
  state: text('state').$type<'idle' | 'running' | 'error'>().notNull().default('idle'),
  lastSyncAt: text('last_sync_at'),
  lastSuccessAt: text('last_success_at'),
  lastError: text('last_error'),
  lastStats: text('last_stats', { mode: 'json' }).$type<IntegrationStats>(),
});

/** Key/value app settings (teamName, goal) — values are JSON. */
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }).$type<unknown>(),
  updatedAt: text('updated_at').notNull(),
});

export type TestCaseRow = typeof testCases.$inferSelect;
export type RunRow = typeof runs.$inferSelect;
export type TestResultRow = typeof testResults.$inferSelect;
export type NoteRow = typeof notes.$inferSelect;
export type PullRequestRow = typeof pullRequests.$inferSelect;
