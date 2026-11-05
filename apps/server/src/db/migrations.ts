/**
 * Versioned, forward-only SQL migrations (tracked via PRAGMA user_version).
 * Kept in TS so the tsup bundle is self-contained. Version 1 was generated with
 * `drizzle-kit generate --dialect sqlite --schema src/db/schema.ts` and pasted
 * here; append new entries for future schema changes (never edit released ones).
 */
export const MIGRATIONS: readonly string[] = [
  /* v1 — initial schema */ `
CREATE TABLE "bug_signatures" (
	"bug_id" integer NOT NULL,
	"signature" text NOT NULL,
	PRIMARY KEY("bug_id", "signature"),
	FOREIGN KEY ("bug_id") REFERENCES "bugs"("id") ON UPDATE no action ON DELETE cascade
);
CREATE INDEX "bug_signatures_sig_idx" ON "bug_signatures" ("signature");
CREATE TABLE "bug_test_cases" (
	"bug_id" integer NOT NULL,
	"test_case_id" integer NOT NULL,
	PRIMARY KEY("bug_id", "test_case_id"),
	FOREIGN KEY ("bug_id") REFERENCES "bugs"("id") ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY ("test_case_id") REFERENCES "test_cases"("id") ON UPDATE no action ON DELETE cascade
);
CREATE INDEX "bug_test_cases_case_idx" ON "bug_test_cases" ("test_case_id");
CREATE TABLE "bugs" (
	"id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	"jira_key" text,
	"title" text NOT NULL,
	"url" text,
	"status" text DEFAULT 'open' NOT NULL,
	"severity" text,
	"found_by_automation" integer DEFAULT 0 NOT NULL,
	"found_in_run_id" integer,
	"source" text DEFAULT 'manual' NOT NULL,
	"assignee" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"resolved_at" text,
	FOREIGN KEY ("found_in_run_id") REFERENCES "runs"("id") ON UPDATE no action ON DELETE set null
);
CREATE UNIQUE INDEX "bugs_jira_key_uq" ON "bugs" ("jira_key");
CREATE INDEX "bugs_status_idx" ON "bugs" ("status");
CREATE INDEX "bugs_created_idx" ON "bugs" ("created_at");
CREATE INDEX "bugs_resolved_idx" ON "bugs" ("resolved_at");
CREATE TABLE "coverage_snapshots" (
	"date" text PRIMARY KEY NOT NULL,
	"total" integer NOT NULL,
	"automated" integer NOT NULL,
	"in_progress" integer DEFAULT 0 NOT NULL,
	"not_automatable" integer DEFAULT 0 NOT NULL
);
CREATE TABLE "integration_state" (
	"name" text PRIMARY KEY NOT NULL,
	"state" text DEFAULT 'idle' NOT NULL,
	"last_sync_at" text,
	"last_success_at" text,
	"last_error" text,
	"last_stats" text
);
CREATE TABLE "notes" (
	"id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	"test_case_id" integer NOT NULL,
	"result_id" integer,
	"run_id" integer,
	"author" text NOT NULL,
	"body" text NOT NULL,
	"triage" text,
	"ticket_url" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	FOREIGN KEY ("test_case_id") REFERENCES "test_cases"("id") ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY ("result_id") REFERENCES "test_results"("id") ON UPDATE no action ON DELETE set null,
	FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON UPDATE no action ON DELETE set null
);
CREATE INDEX "notes_case_created_idx" ON "notes" ("test_case_id","created_at");
CREATE INDEX "notes_run_idx" ON "notes" ("run_id");
CREATE INDEX "notes_created_idx" ON "notes" ("created_at");
CREATE TABLE "pull_requests" (
	"id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	"repo" text NOT NULL,
	"number" integer NOT NULL,
	"title" text NOT NULL,
	"url" text NOT NULL,
	"state" text NOT NULL,
	"author" text,
	"head_branch" text,
	"review_state" text DEFAULT 'none' NOT NULL,
	"requested_reviewers" text DEFAULT '[]' NOT NULL,
	"unresolved_threads" integer DEFAULT 0 NOT NULL,
	"checks" text DEFAULT 'none' NOT NULL,
	"needs_attention" integer DEFAULT 0 NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"merged_at" text
);
CREATE UNIQUE INDEX "pull_requests_repo_number_uq" ON "pull_requests" ("repo","number");
CREATE INDEX "pull_requests_state_idx" ON "pull_requests" ("state");
CREATE TABLE "runs" (
	"id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	"name" text NOT NULL,
	"run_group" text DEFAULT 'default' NOT NULL,
	"branch" text,
	"commit_sha" text,
	"build_url" text,
	"environment" text DEFAULT '{}' NOT NULL,
	"started_at" text,
	"stopped_at" text,
	"duration_ms" integer,
	"imported_at" text NOT NULL,
	"sort_at" text NOT NULL,
	"passed" integer DEFAULT 0 NOT NULL,
	"failed" integer DEFAULT 0 NOT NULL,
	"broken" integer DEFAULT 0 NOT NULL,
	"skipped" integer DEFAULT 0 NOT NULL,
	"unknown" integer DEFAULT 0 NOT NULL,
	"total" integer DEFAULT 0 NOT NULL,
	"previous_run_id" integer,
	"new_failures" integer DEFAULT 0 NOT NULL,
	"still_failing" integer DEFAULT 0 NOT NULL,
	"fixed" integer DEFAULT 0 NOT NULL,
	"new_tests" integer DEFAULT 0 NOT NULL,
	"missing" integer DEFAULT 0 NOT NULL
);
CREATE INDEX "runs_sort_idx" ON "runs" ("sort_at");
CREATE INDEX "runs_branch_started_idx" ON "runs" ("branch","started_at");
CREATE INDEX "runs_group_branch_sort_idx" ON "runs" ("run_group","branch","sort_at");
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text,
	"updated_at" text NOT NULL
);
CREATE TABLE "test_case_pull_requests" (
	"test_case_id" integer NOT NULL,
	"pull_request_id" integer NOT NULL,
	"linked_by" text NOT NULL,
	PRIMARY KEY("test_case_id", "pull_request_id"),
	FOREIGN KEY ("test_case_id") REFERENCES "test_cases"("id") ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY ("pull_request_id") REFERENCES "pull_requests"("id") ON UPDATE no action ON DELETE cascade
);
CREATE INDEX "tcpr_pr_idx" ON "test_case_pull_requests" ("pull_request_id");
CREATE TABLE "test_cases" (
	"id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	"key" text NOT NULL,
	"title" text NOT NULL,
	"suite" text,
	"priority" text,
	"automation_status" text DEFAULT 'not_automated' NOT NULL,
	"owner" text,
	"tags" text DEFAULT '[]' NOT NULL,
	"external_url" text,
	"allure_full_name" text,
	"allure_id" text,
	"jira_key" text,
	"source" text DEFAULT 'manual' NOT NULL,
	"automated_at" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"last_status" text,
	"last_run_id" integer,
	"last_run_at" text,
	"last_signature" text,
	"flakiness" real DEFAULT 0 NOT NULL,
	"triage" text,
	"triage_at" text,
	"note_count" integer DEFAULT 0 NOT NULL
);
CREATE UNIQUE INDEX "test_cases_key_uq" ON "test_cases" ("key");
CREATE UNIQUE INDEX "test_cases_jira_key_uq" ON "test_cases" ("jira_key");
CREATE INDEX "test_cases_allure_full_name_idx" ON "test_cases" ("allure_full_name");
CREATE INDEX "test_cases_allure_id_idx" ON "test_cases" ("allure_id");
CREATE INDEX "test_cases_suite_idx" ON "test_cases" ("suite");
CREATE INDEX "test_cases_status_idx" ON "test_cases" ("automation_status");
CREATE INDEX "test_cases_owner_idx" ON "test_cases" ("owner");
CREATE INDEX "test_cases_last_status_idx" ON "test_cases" ("last_status");
CREATE INDEX "test_cases_source_idx" ON "test_cases" ("source");
CREATE INDEX "test_cases_updated_idx" ON "test_cases" ("updated_at");
CREATE INDEX "test_cases_last_run_at_idx" ON "test_cases" ("last_run_at");
CREATE INDEX "test_cases_flakiness_idx" ON "test_cases" ("flakiness");
CREATE INDEX "test_cases_created_idx" ON "test_cases" ("created_at");
CREATE TABLE "test_results" (
	"id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	"run_id" integer NOT NULL,
	"test_case_id" integer NOT NULL,
	"name" text NOT NULL,
	"full_name" text,
	"history_id" text,
	"status" text NOT NULL,
	"duration_ms" integer,
	"started_at" text,
	"message" text,
	"trace" text,
	"failure_signature" text,
	"change" text DEFAULT 'other' NOT NULL,
	"retries" integer DEFAULT 0 NOT NULL,
	"parameters" text DEFAULT '[]' NOT NULL,
	"labels" text DEFAULT '[]' NOT NULL,
	FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY ("test_case_id") REFERENCES "test_cases"("id") ON UPDATE no action ON DELETE cascade
);
CREATE INDEX "test_results_run_status_idx" ON "test_results" ("run_id","status");
CREATE INDEX "test_results_sig_idx" ON "test_results" ("failure_signature");
CREATE INDEX "test_results_case_idx" ON "test_results" ("test_case_id");
CREATE INDEX "test_results_run_sig_idx" ON "test_results" ("run_id","failure_signature");
CREATE INDEX "test_results_case_run_idx" ON "test_results" ("test_case_id","run_id");
`,
  /* v2 — automation pipeline: automatedVia audit + PR approval time */ `
ALTER TABLE "test_cases" ADD COLUMN "automated_via" text;
ALTER TABLE "pull_requests" ADD COLUMN "approved_at" text;
CREATE INDEX "pull_requests_merged_at_idx" ON "pull_requests" ("merged_at");
`,
  /* v3 — per-attempt statuses of retried results (retry-aware flakiness) */ `
ALTER TABLE "test_results" ADD COLUMN "attempts" text;
`,
  /* v4 — Camel route trigger scans (one per branch upload) */ `
CREATE TABLE "trigger_scans" (
	"id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	"branch" text NOT NULL,
	"commit_sha" text,
	"label" text,
	"scanned_at" text NOT NULL,
	"triggers" text DEFAULT '[]' NOT NULL,
	"tests_found" integer DEFAULT 0 NOT NULL,
	"other_routes" integer DEFAULT 0 NOT NULL,
	"files" text DEFAULT '{}' NOT NULL
);
CREATE INDEX "trigger_scans_branch_idx" ON "trigger_scans" ("branch","scanned_at");
`,
];
