/**
 * @ptd/shared — the single source of truth for the API contract.
 *
 * Both the server (request validation, response typing) and the web app
 * (fetch typing, form validation) import from here. Change the contract here
 * first, then update both sides.
 *
 * All API routes are prefixed with /api. JSON everywhere except file uploads
 * (multipart/form-data) and CSV export. Timestamps are ISO-8601 strings (UTC).
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

/** Where a test case is on the automation journey. */
export const AutomationStatus = z.enum([
  'automated', // has automation that runs
  'in_progress', // someone is writing it
  'not_automated', // backlog: should be automated, not started
  'not_automatable', // manual by design; excluded from the coverage denominator
]);
export type AutomationStatus = z.infer<typeof AutomationStatus>;

/** Allure result statuses. */
export const ResultStatus = z.enum(['passed', 'failed', 'broken', 'skipped', 'unknown']);
export type ResultStatus = z.infer<typeof ResultStatus>;

export const Priority = z.enum(['P0', 'P1', 'P2', 'P3']);
export type Priority = z.infer<typeof Priority>;

/** Why something is failing — set on notes, drives the triage view. */
export const TriageCategory = z.enum([
  'needs_investigation',
  'product_bug',
  'test_bug',
  'environment',
  'flaky',
  'known_issue',
]);
export type TriageCategory = z.infer<typeof TriageCategory>;

/**
 * Where a test case sits in the GitHub-driven automation pipeline. Derived on
 * read (never stored) from automationStatus, linked PRs and results — see
 * SPEC "Automation pipeline" for the precedence:
 *   1. not_automatable      — automationStatus not_automatable (always wins)
 *   2. ready_to_merge / in_review / pr_draft — automationStatus ≠ automated and
 *      ≥1 linked open/draft PR; the most advanced linked PR wins
 *      (ready_to_merge > in_review > pr_draft)
 *   3. merged_awaiting_run  — a linked PR merged at M (latest mergedAt), the case
 *      was not automated before M (status ≠ automated, or automatedAt ≥ M), and no
 *      passed/failed result exists in a run started after M
 *   4. automated / in_progress / not_started — from automationStatus
 */
export const PipelineStage = z.enum([
  'not_started',
  'in_progress',
  'pr_draft',
  'in_review',
  'ready_to_merge',
  'merged_awaiting_run',
  'automated',
  'not_automatable',
]);
export type PipelineStage = z.infer<typeof PipelineStage>;

/** What last moved a case to `automated` (audit only; null when never automated or unknown/legacy). */
/** repo_scan: a test on the default branch of the test repo names the case's Jira/Xray key (comment, docstring, marker…). */
export const AutomatedVia = z.enum(['allure', 'pr_merge', 'manual', 'spreadsheet', 'jira', 'repo_scan']);
export type AutomatedVia = z.infer<typeof AutomatedVia>;

// ---------------------------------------------------------------------------
// Shared primitives / limits (enforced server-side; mirrored in UI forms)
// ---------------------------------------------------------------------------

export const LIMITS = {
  keyMax: 512,
  titleMax: 1000,
  shortTextMax: 200,
  noteBodyMax: 20_000,
  tagsMax: 50,
  urlMax: 2048,
  pageSizeMax: 200,
  /** Max upload size for allure zips / spreadsheet files (bytes). */
  uploadMaxBytes: 200 * 1024 * 1024,
  /** Max number of files in one multipart allure upload. */
  uploadMaxFiles: 20_000,
  /** Stored error message / trace are truncated to these lengths. */
  messageMax: 8_000,
  traceMax: 64_000,
} as const;

const trimmed = (max: number) => z.string().trim().max(max);
const nullableShort = trimmed(LIMITS.shortTextMax).nullable();

/** http(s) URLs only — blocks javascript:, data:, etc. */
export const SafeUrl = z
  .string()
  .trim()
  .max(LIMITS.urlMax)
  .refine((v) => /^https?:\/\//i.test(v), 'URL must start with http:// or https://');

export const IdParam = z.object({ id: z.coerce.number().int().positive() });

export const Paginated = <T extends z.ZodTypeAny>(item: T) =>
  z.object({
    items: z.array(item),
    total: z.number().int(),
    page: z.number().int(),
    pageSize: z.number().int(),
  });

export const ApiError = z.object({
  error: z.string(), // machine-readable code e.g. "not_found", "validation_error"
  message: z.string(), // human-readable, safe to show in UI (never a stack trace)
  details: z.unknown().optional(),
});
export type ApiError = z.infer<typeof ApiError>;

// ---------------------------------------------------------------------------
// Test cases (the inventory: "we have n tests, y are automated")
// ---------------------------------------------------------------------------

export const LastResult = z.object({
  status: ResultStatus,
  runId: z.number().int(),
  runName: z.string(),
  at: z.string(), // run start (or import time)
});
export type LastResult = z.infer<typeof LastResult>;

export const BugStatus = z.enum(['open', 'in_progress', 'resolved', 'closed', 'wont_fix']);
export type BugStatus = z.infer<typeof BugStatus>;

export const BugSeverity = z.enum(['critical', 'major', 'minor', 'trivial']);
export type BugSeverity = z.infer<typeof BugSeverity>;

/**
 * Verification derived from linked tests' results AFTER resolvedAt:
 * - verified_fixed: resolved/closed and every linked case's latest result (in a run started after resolvedAt) passed
 * - still_failing: resolved/closed but ≥1 linked case's latest result after resolvedAt failed/broken
 * - awaiting_run: resolved/closed, no linked-case results since resolvedAt yet
 * - n/a: open / in_progress / wont_fix
 */
export const BugVerification = z.enum(['verified_fixed', 'still_failing', 'awaiting_run', 'n/a']);
export type BugVerification = z.infer<typeof BugVerification>;

/** Compact bug reference embedded in test cases / failure groups. Full model: `Bug`. */
export const BugRef = z.object({
  id: z.number().int(),
  jiraKey: z.string().nullable(),
  title: z.string(),
  url: z.string().nullable(),
  status: BugStatus,
  severity: BugSeverity.nullable(),
  verification: BugVerification,
});
export type BugRef = z.infer<typeof BugRef>;

export const PullRequestRef = z.object({
  repo: z.string(), // "owner/name"
  number: z.number().int(),
  title: z.string(),
  url: z.string(),
  state: z.enum(['open', 'draft', 'merged', 'closed']),
  author: z.string().nullable(),
  updatedAt: z.string(),
  /** How the link was made — shown as a tooltip. */
  linkedBy: z.enum(['key_in_title', 'key_in_body', 'key_in_branch', 'marker_in_diff', 'test_name_in_diff', 'key_in_test_diff']),
  /**
   * Review state derived from latest review per reviewer (GitHub reviewDecision when available):
   * review_required = no approving review yet / reviewers requested; changes_requested; approved;
   * none = no reviews and none required.
   */
  reviewState: z.enum(['review_required', 'changes_requested', 'approved', 'none']),
  /** Logins of reviewers requested but not yet reviewed. */
  requestedReviewers: z.array(z.string()),
  /** Review threads not marked resolved (GraphQL reviewThreads.isResolved=false). */
  unresolvedThreads: z.number().int(),
  /** Combined CI status of the head commit. */
  checks: z.enum(['passing', 'failing', 'pending', 'none']),
  /** Open PRs waiting on the author: changes requested OR unresolved threads OR failing checks. */
  needsAttention: z.boolean(),
  /** GitHub merged_at (null unless state = merged). */
  mergedAt: z.string().nullable(),
  /** Submission time of the latest approving review, when known (null otherwise). */
  approvedAt: z.string().nullable(),
  /**
   * "Done, awaiting merge": state open (not draft) AND reviewState approved AND
   * checks passing or none AND unresolvedThreads = 0.
   */
  readyToMerge: z.boolean(),
});
export type PullRequestRef = z.infer<typeof PullRequestRef>;

export const TestCase = z.object({
  id: z.number().int(),
  /** Stable human/business key, unique. e.g. "TC-123", Xray/Jira key, or allure fullName. */
  key: z.string(),
  title: z.string(),
  suite: z.string().nullable(), // feature area / module
  priority: Priority.nullable(),
  automationStatus: AutomationStatus,
  owner: z.string().nullable(),
  tags: z.array(z.string()),
  externalUrl: z.string().nullable(), // link to Jira/Xray/TestRail
  /** Allure fullName used to link imported results to this case. */
  allureFullName: z.string().nullable(),
  /** Allure testCaseId / AS_ID label used to link results (takes precedence over fullName). */
  allureId: z.string().nullable(),
  /** Jira / Xray Test issue key, e.g. "QA-123". Unique when set. */
  jiraKey: z.string().nullable(),
  /** Where this case came from / is mastered. */
  source: z.enum(['manual', 'spreadsheet', 'allure', 'jira']),
  /** Open (or recently merged) PRs linked to this case by the GitHub sync. */
  pullRequests: z.array(PullRequestRef),
  /** True if any linked PR is open (incl. draft). UI shows an "In PR" badge. */
  inOpenPr: z.boolean(),
  /** Derived automation-pipeline stage (see PipelineStage for the precedence). */
  pipelineStage: PipelineStage,
  /** What last moved the case to `automated` (null if unknown / never). */
  automatedVia: AutomatedVia.nullable(),
  lastResult: LastResult.nullable(),
  /** Latest triage category from the newest note that set one (null if none). */
  triage: TriageCategory.nullable(),
  /** Linked bugs that are not closed/wont_fix-and-verified (open, in_progress, resolved-unverified, still_failing). */
  openBugs: z.array(BugRef),
  noteCount: z.number().int(),
  /** 0..1 — share of status flips across the last 10 results within each run group; max over groups (0 = stable). */
  flakiness: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type TestCase = z.infer<typeof TestCase>;

/** Fields without defaults — used for PATCH so omitted fields are never reset. */
const TestCaseFields = z.object({
  key: trimmed(LIMITS.keyMax).min(1),
  title: trimmed(LIMITS.titleMax).min(1),
  suite: nullableShort.optional(),
  priority: Priority.nullable().optional(),
  automationStatus: AutomationStatus,
  owner: nullableShort.optional(),
  tags: z.array(trimmed(LIMITS.shortTextMax).min(1)).max(LIMITS.tagsMax),
  externalUrl: SafeUrl.nullable().optional(),
  allureFullName: trimmed(LIMITS.keyMax).nullable().optional(),
  allureId: trimmed(LIMITS.shortTextMax).nullable().optional(),
  jiraKey: trimmed(LIMITS.shortTextMax)
    .regex(/^[A-Z][A-Z0-9_]+-\d+$/, 'Must look like a Jira key, e.g. QA-123')
    .nullable()
    .optional(),
});

export const TestCaseCreate = TestCaseFields.extend({
  automationStatus: AutomationStatus.default('not_automated'),
  tags: TestCaseFields.shape.tags.default([]),
});
export type TestCaseCreate = z.infer<typeof TestCaseCreate>;

export const TestCaseUpdate = TestCaseFields.partial();
export type TestCaseUpdate = z.infer<typeof TestCaseUpdate>;

export const TestCaseBulkUpdate = z.object({
  ids: z.array(z.number().int().positive()).min(1).max(1000),
  patch: TestCaseFields.pick({ automationStatus: true, owner: true, suite: true, priority: true })
    .partial()
    .refine((p) => Object.keys(p).length > 0, 'patch must not be empty'),
});
export type TestCaseBulkUpdate = z.infer<typeof TestCaseBulkUpdate>;

export const TestCaseSort = z.enum([
  'key',
  'title',
  'suite',
  'priority',
  'automationStatus',
  'lastRun',
  'flakiness',
  'updatedAt',
]);

/** GET /api/test-cases query string */
export const TestCaseQuery = z.object({
  search: z.string().trim().max(200).optional(), // matches key/title/suite/owner/tags
  suite: z.string().max(LIMITS.shortTextMax).optional(),
  automationStatus: AutomationStatus.optional(),
  priority: Priority.optional(),
  lastStatus: ResultStatus.optional(),
  triage: TriageCategory.optional(),
  owner: z.string().max(LIMITS.shortTextMax).optional(),
  flakyOnly: z.stringbool().optional(),
  inOpenPr: z.stringbool().optional(),
  pipelineStage: PipelineStage.optional(),
  source: z.enum(['manual', 'spreadsheet', 'allure', 'jira']).optional(),
  sort: TestCaseSort.default('key'),
  order: z.enum(['asc', 'desc']).default('asc'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(LIMITS.pageSizeMax).default(50),
});
export type TestCaseQuery = z.infer<typeof TestCaseQuery>;

export const TestCaseList = Paginated(TestCase);
export type TestCaseList = z.infer<typeof TestCaseList>;

// ---------------------------------------------------------------------------
// Runs & results (imported from allure-results)
// ---------------------------------------------------------------------------

export const StatusCounts = z.object({
  passed: z.number().int(),
  failed: z.number().int(),
  broken: z.number().int(),
  skipped: z.number().int(),
  unknown: z.number().int(),
  total: z.number().int(),
});
export type StatusCounts = z.infer<typeof StatusCounts>;

export const Run = z.object({
  id: z.number().int(),
  name: z.string(),
  /**
   * Run group: separates independent test sets (e.g. folder A vs folder B,
   * "smoke" vs "regression"). History baselines, change tagging, trends and
   * flakiness are computed within (runGroup, branch). Set explicitly on import
   * or auto-derived from the results' common test folder (see SPEC).
   */
  runGroup: z.string(),
  branch: z.string().nullable(),
  commit: z.string().nullable(),
  buildUrl: z.string().nullable(),
  /** From environment.properties */
  environment: z.record(z.string(), z.string()),
  /** Earliest result start / latest stop, from the results themselves. */
  startedAt: z.string().nullable(),
  stoppedAt: z.string().nullable(),
  durationMs: z.number().int().nullable(),
  importedAt: z.string(),
  counts: StatusCounts,
  /** passed / (total - skipped), 0..1; null if nothing executed. */
  passRate: z.number().nullable(),
  /**
   * Previous run used as the baseline for `change` tagging: the most recent run
   * (by startedAt, falling back to importedAt) before this one with the same
   * runGroup AND the same branch (null branch matches null). Null for the first run.
   */
  previousRunId: z.number().int().nullable(),
  /** Counts of results by `change` vs previousRunId. */
  changes: z.object({
    newFailures: z.number().int(),
    stillFailing: z.number().int(),
    fixed: z.number().int(),
    newTests: z.number().int(),
    /** Cases present in previous run but missing from this one. */
    missing: z.number().int(),
  }),
});
export type Run = z.infer<typeof Run>;

/**
 * How a result compares with the same test case in the run's previousRunId.
 * failing = failed|broken; passing = passed. skipped/unknown → 'other'.
 */
export const ResultChange = z.enum([
  'new_failure', // failing now, passing (or skipped) before
  'still_failing', // failing now and before
  'fixed', // passing now, failing before
  'stable_pass', // passing now and before
  'new_test', // not present in previous run (or no previous run)
  'other',
]);
export type ResultChange = z.infer<typeof ResultChange>;

export const RunList = Paginated(Run);
export type RunList = z.infer<typeof RunList>;

/** PATCH /api/runs/:id — fix metadata after import. Changing runGroup/branch re-links baselines. */
export const RunUpdate = z
  .object({
    name: trimmed(LIMITS.shortTextMax).min(1),
    runGroup: trimmed(LIMITS.shortTextMax).min(1),
    branch: nullableShort,
  })
  .partial();
export type RunUpdate = z.infer<typeof RunUpdate>;

export const RunQuery = z.object({
  runGroup: z.string().max(LIMITS.shortTextMax).optional(),
  branch: z.string().max(LIMITS.shortTextMax).optional(),
  search: z.string().trim().max(200).optional(), // run name / commit
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(LIMITS.pageSizeMax).default(25),
});
export type RunQuery = z.infer<typeof RunQuery>;

export const TestResult = z.object({
  id: z.number().int(),
  runId: z.number().int(),
  testCaseId: z.number().int(),
  testCaseKey: z.string(),
  name: z.string(),
  fullName: z.string().nullable(),
  status: ResultStatus,
  durationMs: z.number().int().nullable(),
  startedAt: z.string().nullable(),
  message: z.string().nullable(), // truncated to LIMITS.messageMax
  trace: z.string().nullable(), // truncated to LIMITS.traceMax
  /** Normalized hash of message — groups similar failures. Null if not failed/broken. */
  failureSignature: z.string().nullable(),
  /**
   * Heuristic triage suggestion from the message (e.g. ORA-12541 / TNS-* /
   * "Connection refused" ⇒ environment). Null if none or not failed/broken.
   * A suggestion only — no note is ever created server-side.
   */
  suggestedTriage: TriageCategory.nullable(),
  /** Allure retries (multiple results with same historyId in one run). */
  retries: z.number().int(),
  /** Status of every attempt, oldest first, when the test was retried (null otherwise). */
  attempts: z.array(ResultStatus).nullable(),
  change: ResultChange,
  parameters: z.array(z.object({ name: z.string(), value: z.string() })),
  labels: z.array(z.object({ name: z.string(), value: z.string() })),
});
export type TestResult = z.infer<typeof TestResult>;
/** `GET /api/results/:id` (editor only) → `TestResult` (incl. message + trace). Params: `IdParam`. */
export const ResultResponse = TestResult;

export const RunResultsQuery = z.object({
  status: ResultStatus.optional(),
  change: ResultChange.optional(),
  search: z.string().trim().max(200).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(LIMITS.pageSizeMax).default(100),
});
export type RunResultsQuery = z.infer<typeof RunResultsQuery>;

export const TestResultList = Paginated(TestResult);
export type TestResultList = z.infer<typeof TestResultList>;

/**
 * GET /api/runs/compare?base=<runId>&head=<runId> — diff two runs by test case.
 * Lists are capped at 500 each (counts are exact).
 */
/** If base is omitted, the server uses head's previousRunId (400 if none). */
export const RunCompareQuery = z.object({
  base: z.coerce.number().int().positive().optional(),
  head: z.coerce.number().int().positive(),
});
export const RunCompareEntry = z.object({
  testCase: z.object({ id: z.number().int(), key: z.string(), title: z.string(), suite: z.string().nullable() }),
  baseStatus: ResultStatus.nullable(), // null = not in base
  headStatus: ResultStatus.nullable(), // null = not in head
  baseDurationMs: z.number().int().nullable(),
  headDurationMs: z.number().int().nullable(),
  headMessage: z.string().nullable(), // first line, ≤ 300 chars
  headResultId: z.number().int().nullable(),
});
export type RunCompareEntry = z.infer<typeof RunCompareEntry>;
export const RunComparison = z.object({
  base: Run,
  head: Run,
  counts: z.object({
    newFailures: z.number().int(),
    fixed: z.number().int(),
    stillFailing: z.number().int(),
    added: z.number().int(),
    removed: z.number().int(),
    slower: z.number().int(),
    unchangedPass: z.number().int(),
  }),
  newFailures: z.array(RunCompareEntry),
  fixed: z.array(RunCompareEntry),
  stillFailing: z.array(RunCompareEntry),
  added: z.array(RunCompareEntry),
  removed: z.array(RunCompareEntry),
  /** head ≥ 1.5× base AND +≥ 1000 ms; sorted by absolute increase desc. */
  slower: z.array(RunCompareEntry),
});
export type RunComparison = z.infer<typeof RunComparison>;

/**
 * GET /api/history/matrix — tests × runs grid (heatmap).
 * Runs: the latest `runs` runs matching branch (oldest → newest left→right).
 * Rows: test cases with ≥1 result in those runs, filtered; sorted by
 * instability (flips desc, then failures desc), then key.
 */
export const HistoryMatrixQuery = z.object({
  runs: z.coerce.number().int().min(5).max(60).default(20),
  /** Required in practice: the UI always sends one (defaults to the most recently active group). If omitted, server uses the runGroup of the latest run. */
  runGroup: z.string().max(LIMITS.shortTextMax).optional(),
  branch: z.string().max(LIMITS.shortTextMax).optional(),
  suite: z.string().max(LIMITS.shortTextMax).optional(),
  search: z.string().trim().max(200).optional(),
  /** Only tests with ≥1 failed/broken in the window (default true). */
  onlyUnstable: z.stringbool().default(true),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
export type HistoryMatrixQuery = z.infer<typeof HistoryMatrixQuery>;
export const HistoryMatrix = z.object({
  runGroup: z.string().nullable(), // the group actually used
  runs: z.array(
    Run.pick({ id: true, name: true, runGroup: true, branch: true, startedAt: true, importedAt: true, passRate: true }),
  ),
  rows: z.array(
    z.object({
      testCase: z.object({ id: z.number().int(), key: z.string(), title: z.string(), suite: z.string().nullable() }),
      /** Same length/order as `runs`; status null = not executed in that run. */
      cells: z.array(z.object({ status: ResultStatus.nullable(), resultId: z.number().int().nullable() })),
      flips: z.number().int(),
      failures: z.number().int(),
    }),
  ),
  total: z.number().int(),
  page: z.number().int(),
  pageSize: z.number().int(),
});
export type HistoryMatrix = z.infer<typeof HistoryMatrix>;

/** Failures in a run grouped by normalized error signature. */
export const FailureGroup = z.object({
  signature: z.string(),
  /** Representative message line (the line that drives the signature, e.g. the ORA- line), truncated. */
  sampleMessage: z.string(),
  count: z.number().int(),
  status: z.enum(['failed', 'broken']),
  testCases: z.array(z.object({ id: z.number().int(), key: z.string(), title: z.string() })),
  /** Most common triage category among the affected cases, if any. */
  triage: TriageCategory.nullable(),
  /**
   * Heuristic suggestion from the group's sample message (see TestResult.suggestedTriage).
   * The UI offers it as a one-click bulk triage note; never applied automatically.
   */
  suggestedTriage: TriageCategory.nullable(),
  /** Bugs already linked to this signature or to all affected cases. */
  bugs: z.array(BugRef),
  /** How many of the group's results are new failures vs previous run. */
  newFailures: z.number().int(),
  /** First run (any branch) where this signature appeared. */
  firstSeen: z.object({ runId: z.number().int(), runName: z.string(), at: z.string() }).nullable(),
});
export type FailureGroup = z.infer<typeof FailureGroup>;

/**
 * POST /api/runs/import — multipart/form-data.
 * Fields (all optional, sent before files): name, branch, commit, buildUrl.
 * Files: EITHER one `.zip` of an allure-results directory, OR many individual
 * files from the folder (`*-result.json`, `*-container.json`,
 * `environment.properties`, `executor.json`, `categories.json`). Anything else
 * is ignored. Attachments are never stored.
 */
export const RunImportFields = z.object({
  name: trimmed(LIMITS.shortTextMax).min(1).optional(),
  /** Omit to auto-derive from the results' common test folder. */
  runGroup: trimmed(LIMITS.shortTextMax).min(1).optional(),
  branch: nullableShort.optional(),
  commit: nullableShort.optional(),
  buildUrl: SafeUrl.nullable().optional(),
});
export type RunImportFields = z.infer<typeof RunImportFields>;

export const RunImportResponse = z.object({
  run: Run,
  /** Test cases auto-created because no existing case matched a result. */
  createdTestCases: z.number().int(),
  /** Existing cases whose automationStatus was flipped to 'automated' because results arrived. */
  promotedTestCases: z.number().int(),
  skippedFiles: z.number().int(),
  warnings: z.array(z.string()),
});
export type RunImportResponse = z.infer<typeof RunImportResponse>;

/**
 * `POST /api/runs/import-history` (multipart, editor or ingest token): many runs
 * in one upload, the way allure-history (allureparser) reads them:
 * - several allure-results folders and/or allure-history snapshots
 *   (`*.snapshot.json.gz`): each folder or snapshot is one run;
 * - one folder that collected results from many runs: runs are recovered from
 *   the host + process id allure-pytest records on every result.
 * Fields apply to every run in the upload.
 */
export const HistoryImportFields = z.object({
  /** Omit to auto-derive per run from the results' common test folder. */
  runGroup: trimmed(LIMITS.shortTextMax).min(1).optional(),
  branch: nullableShort.optional(),
});
export type HistoryImportFields = z.infer<typeof HistoryImportFields>;

export const HistoryImportMode = z.enum(['per_source', 'detected']);
export type HistoryImportMode = z.infer<typeof HistoryImportMode>;

export const HistoryImportResponse = z.object({
  /** `per_source`: one run per folder/snapshot. `detected`: runs recovered from one mixed folder. */
  mode: HistoryImportMode,
  /** Imported runs, oldest first. */
  runs: z.array(Run),
  /** Runs in the upload that the dashboard already had (same group, branch, start, stop and counts); not imported again. */
  duplicateRuns: z.number().int(),
  createdTestCases: z.number().int(),
  promotedTestCases: z.number().int(),
  skippedFiles: z.number().int(),
  warnings: z.array(z.string()),
});
export type HistoryImportResponse = z.infer<typeof HistoryImportResponse>;

// ---------------------------------------------------------------------------
// Notes (why is this failing? triage + discussion)
// ---------------------------------------------------------------------------

export const Note = z.object({
  id: z.number().int(),
  testCaseId: z.number().int(),
  /** Optional: the specific result this note is about. */
  resultId: z.number().int().nullable(),
  runId: z.number().int().nullable(),
  author: z.string(),
  /** Plain text / markdown. UI must render safely (no raw HTML). */
  body: z.string(),
  triage: TriageCategory.nullable(),
  ticketUrl: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Note = z.infer<typeof Note>;

export const NoteCreate = z.object({
  testCaseId: z.number().int().positive(),
  resultId: z.number().int().positive().nullable().optional(),
  author: trimmed(LIMITS.shortTextMax).min(1),
  body: trimmed(LIMITS.noteBodyMax).min(1),
  triage: TriageCategory.nullable().optional(),
  ticketUrl: SafeUrl.nullable().optional(),
});
export type NoteCreate = z.infer<typeof NoteCreate>;

export const NoteUpdate = NoteCreate.pick({ body: true, triage: true, ticketUrl: true }).partial();
export type NoteUpdate = z.infer<typeof NoteUpdate>;

export const NoteQuery = z.object({
  testCaseId: z.coerce.number().int().positive().optional(),
  runId: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type NoteQuery = z.infer<typeof NoteQuery>;

/**
 * POST /api/notes/bulk — add the same note to many cases at once
 * (e.g. "all 14 of these fail because staging DB is down").
 */
export const NoteBulkCreate = NoteCreate.omit({ testCaseId: true, resultId: true }).extend({
  testCaseIds: z.array(z.number().int().positive()).min(1).max(1000),
  runId: z.number().int().positive().nullable().optional(),
});
export type NoteBulkCreate = z.infer<typeof NoteBulkCreate>;

export const TestCaseDetail = TestCase.extend({
  /** Newest first, last 50 results across runs. */
  history: z.array(
    TestResult.pick({
      id: true,
      runId: true,
      status: true,
      durationMs: true,
      startedAt: true,
      message: true,
      failureSignature: true,
      change: true,
    }).extend({ runName: z.string(), runGroup: z.string(), branch: z.string().nullable() }),
  ),
  notes: z.array(Note), // newest first
  stats: z.object({
    /** Oldest run of the current consecutive failing streak (null if last result not failing). */
    failingSince: z.object({ runId: z.number().int(), runName: z.string(), at: z.string() }).nullable(),
    consecutiveFailures: z.number().int(),
    lastPassed: z.object({ runId: z.number().int(), runName: z.string(), at: z.string() }).nullable(),
    /** Over the last 30 executed (non-skipped) results; null if none. */
    passRate: z.number().nullable(),
    executions: z.number().int(), // total results ever
    avgDurationMs: z.number().int().nullable(), // last 30 passed
    /** Latest duration vs avg — >1.5 = notably slower. Null if not computable. */
    durationRatio: z.number().nullable(),
  }),
});
export type TestCaseDetail = z.infer<typeof TestCaseDetail>;

// ---------------------------------------------------------------------------
// Spreadsheet (Excel/CSV) inventory import — two-step: preview, then commit.
// ---------------------------------------------------------------------------

/** Fields a spreadsheet column can be mapped to. */
export const ImportField = z.enum([
  'key',
  'title',
  'suite',
  'priority',
  'automationStatus',
  'owner',
  'tags',
  'externalUrl',
  'allureFullName',
  'allureId',
  'jiraKey',
]);
export type ImportField = z.infer<typeof ImportField>;

/**
 * POST /api/test-cases/import/preview — multipart, one file (.xlsx or .csv).
 * The server parses it, stores the parsed rows server-side under an opaque
 * uploadId (short TTL, e.g. 1h), and returns sheets + headers + sample rows +
 * a suggested column mapping (fuzzy-matched header names).
 */
export const ImportPreviewResponse = z.object({
  uploadId: z.string(),
  fileName: z.string(),
  sheets: z.array(
    z.object({
      name: z.string(),
      headers: z.array(z.string()),
      rowCount: z.number().int(),
      sampleRows: z.array(z.array(z.string())), // first ~20 rows, cell values as text
      /** header -> suggested field (only headers we could guess). */
      suggestedMapping: z.record(z.string(), ImportField),
    }),
  ),
});
export type ImportPreviewResponse = z.infer<typeof ImportPreviewResponse>;

/**
 * Free-text values in a spreadsheet's status column ("Yes", "Automated", "Done",
 * "WIP", "Manual", "N/A"...) get mapped to AutomationStatus. The server suggests
 * a default mapping; the user can override per distinct value.
 */
export const ImportCommitRequest = z.object({
  uploadId: z.string().min(1).max(100),
  sheet: z.string().max(LIMITS.shortTextMax),
  /** header -> field. `key` and `title` must be mapped (key may fall back to title). */
  mapping: z.record(z.string().max(LIMITS.shortTextMax), ImportField),
  /** Distinct raw status cell value -> AutomationStatus. */
  statusValueMap: z.record(z.string().max(LIMITS.shortTextMax), AutomationStatus).default({}),
  /** What to do when a row's key already exists. */
  onConflict: z.enum(['update', 'skip']).default('update'),
  /** If true, validate and report what would happen without writing. */
  dryRun: z.boolean().default(false),
});
export type ImportCommitRequest = z.infer<typeof ImportCommitRequest>;

export const ImportCommitResponse = z.object({
  created: z.number().int(),
  updated: z.number().int(),
  skipped: z.number().int(),
  errors: z.array(z.object({ row: z.number().int(), message: z.string() })), // capped at 100
  dryRun: z.boolean(),
});
export type ImportCommitResponse = z.infer<typeof ImportCommitResponse>;

/** POST /api/test-cases/import/status-values — distinct values in the mapped status column. */
export const ImportStatusValuesRequest = z.object({
  uploadId: z.string().min(1).max(100),
  sheet: z.string().max(LIMITS.shortTextMax),
  column: z.string().max(LIMITS.shortTextMax),
});
export const ImportStatusValuesResponse = z.object({
  values: z.array(
    z.object({ raw: z.string(), count: z.number().int(), suggested: AutomationStatus }),
  ),
});
export type ImportStatusValuesResponse = z.infer<typeof ImportStatusValuesResponse>;

// ---------------------------------------------------------------------------
// Dashboard summary
// ---------------------------------------------------------------------------

export const CoverageTotals = z.object({
  /**
   * What is counted: `routes` once the Camel repo has been scanned (route triggers on the default
   * branch; automated = covered by a test there; inProgress = covered only on another branch),
   * else `cases` (the test case inventory).
   */
  unit: z.enum(['cases', 'routes']),
  total: z.number().int(),
  automated: z.number().int(),
  inProgress: z.number().int(),
  notAutomated: z.number().int(),
  notAutomatable: z.number().int(),
  /** Cases not yet automated that have an open PR linked (subset of inProgress+notAutomated). */
  inOpenPr: z.number().int(),
  /** automated / (total - notAutomatable), 0..1; null if denominator is 0. */
  automationRate: z.number().nullable(),
});
export type CoverageTotals = z.infer<typeof CoverageTotals>;

/** Number of test cases in each PipelineStage (all stages present; sums to total cases). */
export const PipelineCounts = z.record(PipelineStage, z.number().int());
export type PipelineCounts = z.infer<typeof PipelineCounts>;

/** GET /api/summary */
export const Summary = z.object({
  coverage: CoverageTotals,
  /** Daily snapshots, oldest first (up to 180 days). */
  coverageTrend: z.array(
    z.object({ date: z.string(), total: z.number().int(), automated: z.number().int() }),
  ),
  latestRun: Run.nullable(),
  /** Last 30 runs of each run group (up to 12 most recently active groups), oldest first. */
  runTrend: z.array(
    Run.pick({ id: true, name: true, runGroup: true, branch: true, startedAt: true, importedAt: true, counts: true, passRate: true, changes: true }),
  ),
  bySuite: z.array(
    z.object({
      suite: z.string(), // "(none)" for null suite
      total: z.number().int(),
      automated: z.number().int(),
      inProgress: z.number().int(),
      notAutomatable: z.number().int(), // excluded from the rate denominator
      passing: z.number().int(), // last result passed
      failing: z.number().int(), // last result failed/broken
    }),
  ),
  /** Cases whose last result is failed/broken and have no triage yet. */
  untriagedFailures: z.number().int(),
  triageBreakdown: z.array(z.object({ triage: TriageCategory, count: z.number().int() })),
  topFlaky: z.array(TestCase.pick({ id: true, key: true, title: true, flakiness: true })),
  byOwner: z.array(
    z.object({
      owner: z.string(),
      total: z.number().int(),
      automated: z.number().int(),
      notAutomatable: z.number().int(), // excluded from the rate denominator
    }),
  ),
  /** Open automation PRs (linked to ≥1 case), by review state. */
  prPipeline: z.object({
    open: z.number().int(),
    draft: z.number().int(),
    reviewRequired: z.number().int(),
    changesRequested: z.number().int(),
    approved: z.number().int(),
    unresolvedThreads: z.number().int(), // sum across open PRs
    needsAttention: z.number().int(),
    /** Open linked PRs that are readyToMerge. */
    readyToMerge: z.number().int(),
  }),
  /** Test cases per derived PipelineStage (the Overview funnel). */
  pipeline: PipelineCounts,
});
export type Summary = z.infer<typeof Summary>;

// ---------------------------------------------------------------------------
// Bugs identified (by automation or manually), linked to test cases
// ---------------------------------------------------------------------------

export const Bug = z.object({
  id: z.number().int(),
  /** Jira key if tracked in Jira (unique when set). */
  jiraKey: z.string().nullable(),
  title: z.string(),
  url: z.string().nullable(),
  status: BugStatus,
  severity: BugSeverity.nullable(),
  /** true if first detected via an automated result (has foundInRunId or created from a failure). */
  foundByAutomation: z.boolean(),
  foundInRun: z.object({ id: z.number().int(), name: z.string(), runGroup: z.string() }).nullable(),
  /** Failure signatures this bug explains (so new failures with the same signature auto-suggest it). */
  failureSignatures: z.array(z.string()),
  testCases: z.array(
    z.object({
      id: z.number().int(),
      key: z.string(),
      title: z.string(),
      lastStatus: ResultStatus.nullable(),
    }),
  ),
  verification: BugVerification,
  /** Synced from Jira when jiraKey set & Jira configured; else manual. */
  source: z.enum(['manual', 'jira']),
  assignee: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  resolvedAt: z.string().nullable(),
});
export type Bug = z.infer<typeof Bug>;

export const BugCreate = z.object({
  title: trimmed(LIMITS.titleMax).min(1),
  jiraKey: TestCaseFields.shape.jiraKey,
  url: SafeUrl.nullable().optional(),
  status: BugStatus.default('open'),
  severity: BugSeverity.nullable().optional(),
  assignee: nullableShort.optional(),
  testCaseIds: z.array(z.number().int().positive()).max(1000).default([]),
  /** When logged from a failure group / result. */
  foundInRunId: z.number().int().positive().nullable().optional(),
  failureSignatures: z.array(z.string().max(64)).max(50).default([]),
});
export type BugCreate = z.infer<typeof BugCreate>;

export const BugUpdate = z
  .object({
    title: trimmed(LIMITS.titleMax).min(1),
    jiraKey: TestCaseFields.shape.jiraKey,
    url: SafeUrl.nullable(),
    status: BugStatus,
    severity: BugSeverity.nullable(),
    assignee: nullableShort,
    /** Replace the full set of linked cases / signatures. */
    testCaseIds: z.array(z.number().int().positive()).max(1000),
    failureSignatures: z.array(z.string().max(64)).max(50),
  })
  .partial();
export type BugUpdate = z.infer<typeof BugUpdate>;

export const BugQuery = z.object({
  status: BugStatus.optional(),
  /** open = open|in_progress; resolved = resolved|closed; all */
  bucket: z.enum(['open', 'resolved', 'all']).default('open'),
  severity: BugSeverity.optional(),
  verification: BugVerification.optional(),
  testCaseId: z.coerce.number().int().positive().optional(),
  foundByAutomation: z.stringbool().optional(),
  search: z.string().trim().max(200).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(LIMITS.pageSizeMax).default(50),
});
export type BugQuery = z.infer<typeof BugQuery>;

export const BugList = Paginated(Bug);
export type BugList = z.infer<typeof BugList>;


/** GET /api/bugs/stats — for the Bugs page header and report. */
export const BugStats = z.object({
  open: z.number().int(),
  inProgress: z.number().int(),
  resolvedAwaitingVerification: z.number().int(),
  stillFailingAfterFix: z.number().int(),
  verifiedFixed: z.number().int(),
  bySeverity: z.array(z.object({ severity: BugSeverity, open: z.number().int() })),
  /** Weekly, last 26 weeks, oldest first. */
  trend: z.array(z.object({ weekStart: z.string(), found: z.number().int(), resolved: z.number().int() })),
  /** Mean days from createdAt to resolvedAt over bugs resolved in last 90 days; null if none. */
  meanDaysToResolve: z.number().nullable(),
});
export type BugStats = z.infer<typeof BugStats>;

// ---------------------------------------------------------------------------
// Settings & management report ("external" side)
// ---------------------------------------------------------------------------

/** GET /api/settings, PUT /api/settings (editor only). Stored in DB. */
export const Settings = z.object({
  /** Shown in the report header, e.g. "Payments QA". */
  teamName: trimmed(LIMITS.shortTextMax).nullable(),
  /** Automation goal, e.g. 0.8 by 2027-03-31. */
  goal: z
    .object({
      targetRate: z.number().min(0).max(1),
      targetDate: z.iso.date(),
    })
    .nullable(),
});
export type Settings = z.infer<typeof Settings>;

export const ReportQuery = z.object({
  periodDays: z.coerce.number().int().refine((n) => [7, 30, 90, 180].includes(n)).default(30),
});
export type ReportQuery = z.infer<typeof ReportQuery>;

/**
 * GET /api/report — management-friendly rollup. Readable by both editor and
 * viewer roles. Contains NO free-text notes, traces or messages (aggregates only).
 */
export const Report = z.object({
  generatedAt: z.string(),
  periodDays: z.number().int(),
  teamName: z.string().nullable(),
  coverage: CoverageTotals,
  /** Coverage at the start of the period, for "+x pts" deltas. */
  coverageAtPeriodStart: CoverageTotals.pick({ total: true, automated: true, automationRate: true }),
  coverageTrend: Summary.shape.coverageTrend,
  goal: Settings.shape.goal,
  projection: z.object({
    /** Avg newly-automated cases per week over the period (from snapshots). */
    weeklyVelocity: z.number(),
    /** Cases still to automate to hit goal.targetRate (null without goal). */
    remainingToGoal: z.number().int().nullable(),
    /** Linear projection of when goal is reached; null if velocity ≤ 0 or no goal. */
    projectedGoalDate: z.string().nullable(),
    /** 'ahead' | 'on_track' | 'at_risk' | 'behind' vs goal.targetDate; null without goal. */
    status: z.enum(['ahead', 'on_track', 'at_risk', 'behind']).nullable(),
  }),
  /** Pass rate of the latest run and the average over the period. */
  quality: z.object({
    latestPassRate: z.number().nullable(),
    periodAvgPassRate: z.number().nullable(),
    previousPeriodAvgPassRate: z.number().nullable(),
    runsInPeriod: z.number().int(),
    /** Weekly buckets, oldest first. */
    weeklyPassRate: z.array(z.object({ weekStart: z.string(), passRate: z.number().nullable(), runs: z.number().int() })),
    /** Latest run per run group (management sees each test set separately). */
    byRunGroup: z.array(
      z.object({
        runGroup: z.string(),
        latestPassRate: z.number().nullable(),
        periodAvgPassRate: z.number().nullable(),
        runsInPeriod: z.number().int(),
        lastRunAt: z.string().nullable(),
      }),
    ),
  }),
  /** Per-suite readiness, worst first. */
  suites: z.array(
    z.object({
      suite: z.string(),
      total: z.number().int(),
      automated: z.number().int(),
      /** total − not automatable (the rate's denominator). */
      automatable: z.number().int(),
      automationRate: z.number().nullable(),
      lastPassRate: z.number().nullable(),
      /** green: rate≥goal(or 0.8) & pass≥0.95; amber: pass≥0.85; red otherwise or no data → 'unknown'. */
      health: z.enum(['green', 'amber', 'red', 'unknown']),
    }),
  ),
  highlights: z.object({
    newlyAutomated: z.number().int(), // in period
    casesAdded: z.number().int(), // in period
    prsMerged: z.number().int(), // linked automation PRs merged in period
    failuresTriaged: z.number().int(), // notes with triage in period
    bugsFoundByAutomation: z.number().int(), // created in period with foundByAutomation
    bugsResolved: z.number().int(), // resolvedAt in period
    bugsVerifiedFixed: z.number().int(), // verified in period
  }),
  risks: z.object({
    untriagedFailures: z.number().int(),
    flakyTests: z.number().int(), // flakiness ≥ 0.3
    productBugsOpen: z.number().int(), // cases currently triaged product_bug and last result failing
    prsNeedingAttention: z.number().int(),
    openBugs: z.number().int(),
    openCriticalBugs: z.number().int(),
    stillFailingAfterFix: z.number().int(),
  }),
  bugs: z.object({
    bySeverity: BugStats.shape.bySeverity,
    trend: BugStats.shape.trend, // trimmed to the period (weekly)
    meanDaysToResolve: z.number().nullable(),
  }),
  prPipeline: Summary.shape.prPipeline,
  /** Automation work in flight (derived pipeline stages) + the projected rate once ready PRs merge. */
  automationInFlight: z.object({
    stages: PipelineCounts,
    /** automated + cases whose stage is ready_to_merge or merged_awaiting_run but not yet `automated`. */
    projectedAutomated: z.number().int(),
    /** projectedAutomated / (total − notAutomatable); null if denominator is 0. */
    projectedAutomationRate: z.number().nullable(),
  }),
});
export type Report = z.infer<typeof Report>;

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

/** POST /api/auth/login — exchange the shared access token for an httpOnly session cookie. */
export const LoginRequest = z.object({ token: z.string().min(1).max(512) });
export type LoginRequest = z.infer<typeof LoginRequest>;

export const Role = z.enum(['editor', 'viewer']);
export type Role = z.infer<typeof Role>;

/** GET /api/auth/session */
export const SessionInfo = z.object({
  authenticated: z.boolean(),
  /** editor = full workspace; viewer = Report only (read-only). null when unauthenticated. */
  role: Role.nullable(),
  /** false when the server runs with auth disabled (dev only). */
  authRequired: z.boolean(),
});
export type SessionInfo = z.infer<typeof SessionInfo>;

// ---------------------------------------------------------------------------
// Integrations (GitHub PRs, Jira/Xray). Credentials live ONLY in server env
// vars — never sent to or accepted from the browser.
// ---------------------------------------------------------------------------

export const IntegrationName = z.enum(['github', 'jira']);
export type IntegrationName = z.infer<typeof IntegrationName>;

export const IntegrationStatus = z.object({
  name: IntegrationName,
  /** Env vars present. If false, UI shows setup instructions (env var names only). */
  configured: z.boolean(),
  /** Non-secret description, e.g. "acme/api, acme/web" or "https://acme.atlassian.net — project QA". */
  target: z.string().nullable(),
  state: z.enum(['idle', 'running', 'error']),
  lastSyncAt: z.string().nullable(),
  lastSuccessAt: z.string().nullable(),
  /** Sanitized error (no tokens / headers). */
  lastError: z.string().nullable(),
  lastStats: z
    .object({
      fetched: z.number().int(), // PRs or issues fetched
      created: z.number().int(), // jira: test cases created; github: PRs seen for the first time
      updated: z.number().int(), // jira: test cases updated; github: cases auto-promoted to automated by a merged PR
      linked: z.number().int(), // PR↔case links (github only)
    })
    .nullable(),
  /** Minutes between automatic syncs; null = manual only. */
  intervalMinutes: z.number().int().nullable(),
});
export type IntegrationStatus = z.infer<typeof IntegrationStatus>;

/** Automation PR as shown in the "Pull requests" view (GET /api/pull-requests). */
export const PullRequest = PullRequestRef.omit({ linkedBy: true }).extend({
  id: z.number().int(),
  headBranch: z.string().nullable(),
  createdAt: z.string(),
  /** Test cases this PR is linked to. */
  testCases: z.array(z.object({ id: z.number().int(), key: z.string(), title: z.string() })),
});
export type PullRequest = z.infer<typeof PullRequest>;

export const PullRequestQuery = z.object({
  state: z.enum(['open', 'draft', 'merged', 'closed']).optional(),
  reviewState: z.enum(['review_required', 'changes_requested', 'approved', 'none']).optional(),
  needsAttention: z.stringbool().optional(),
  /** Only PRs that are readyToMerge (true) / are not (false). */
  readyToMerge: z.stringbool().optional(),
  repo: z.string().max(LIMITS.shortTextMax).optional(),
  author: z.string().max(LIMITS.shortTextMax).optional(),
  /** Only PRs linked to at least one test case (default true). */
  linkedOnly: z.stringbool().default(true),
});
export type PullRequestQuery = z.infer<typeof PullRequestQuery>;

/** GET /api/integrations → IntegrationStatus[]; POST /api/integrations/:name/sync → 202 IntegrationStatus */
export const IntegrationNameParam = z.object({ name: IntegrationName });

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

/** GET /api/meta — distinct values for filter dropdowns. */
export const Meta = z.object({
  suites: z.array(z.string()),
  owners: z.array(z.string()),
  tags: z.array(z.string()),
  branches: z.array(z.string()),
  /** Ordered by most recent run first. */
  runGroups: z.array(z.object({ name: z.string(), runs: z.number().int(), lastRunAt: z.string() })),
});
export type Meta = z.infer<typeof Meta>;

export const AUTOMATION_STATUS_LABELS: Record<AutomationStatus, string> = {
  automated: 'Automated',
  in_progress: 'In progress',
  not_automated: 'Not automated',
  not_automatable: 'Not automatable',
};

export const PIPELINE_STAGE_LABELS: Record<PipelineStage, string> = {
  not_started: 'Not started',
  in_progress: 'In progress',
  pr_draft: 'PR draft',
  in_review: 'In review',
  ready_to_merge: 'Ready to merge',
  merged_awaiting_run: 'Merged (awaiting run)',
  automated: 'Automated',
  not_automatable: 'Not automatable',
};

/** Funnel order (left → right); not_automatable is shown separately. */
export const PIPELINE_FUNNEL: readonly PipelineStage[] = [
  'not_started',
  'in_progress',
  'pr_draft',
  'in_review',
  'ready_to_merge',
  'merged_awaiting_run',
  'automated',
];

export const TRIAGE_LABELS: Record<TriageCategory, string> = {
  needs_investigation: 'Needs investigation',
  product_bug: 'Product bug',
  test_bug: 'Test bug',
  environment: 'Environment',
  flaky: 'Flaky',
  known_issue: 'Known issue',
};

// ---------------------------------------------------------------------------
// Camel route triggers (scope of what can be automated, scanned from the repo)
// ---------------------------------------------------------------------------

/**
 * What starts a Camel route: a file landing in a folder (`file:`, `ftp:`, `sftp:`,
 * `ftps:`), or a schedule (`quartz:`, `cron:`, `timer:`, `scheduler:`).
 */
export const TriggerKind = z.enum(['file', 'schedule']);
export type TriggerKind = z.infer<typeof TriggerKind>;

export const TriggerCoverage = z.object({
  /** pytest node id, e.g. `tests/routes/test_invoice.py::TestLoad::test_loads_file`. */
  test: z.string(),
  /** The label/marker value that linked the test to the trigger. */
  via: z.string(),
  /** Dashboard test case with the matching Allure full name, when one exists. */
  testCaseId: z.number().int().nullable(),
});
export type TriggerCoverage = z.infer<typeof TriggerCoverage>;

export const Trigger = z.object({
  /** Stable identity across branches: the route id, else source file + endpoint. */
  key: z.string(),
  routeId: z.string().nullable(),
  /** Module the route belongs to (folder under `resources/`), when the repo has several. */
  module: z.string().nullable(),
  kind: TriggerKind,
  /** Endpoint scheme: file, sftp, quartz, cron, … */
  scheme: z.string(),
  /** The `from` URI as written. */
  uri: z.string(),
  /** With property placeholders filled in (placeholders whose value differs per file are left as is). */
  resolvedUri: z.string(),
  /** file triggers: folder being watched. */
  directory: z.string().nullable(),
  /** file triggers: the file name pattern (`include`, `antInclude`, `fileName`, or a readable form of `condition`). */
  filePattern: z.string().nullable(),
  /** How `filePattern` matches: include regex, antInclude glob, fileName, or a `<choice>`/`<filter>` condition on the file name. */
  patternKind: z.enum(['regex', 'glob', 'name', 'condition']).nullable(),
  /** `<choice>`/`<filter>` triggers: the Camel simple expression on the file name, as written. */
  condition: z.string().nullable(),
  /** `<choice>`/`<filter>` triggers: where matching files go (the branch's first `<to>`), e.g. `direct:invoiceJob`. */
  target: z.string().nullable(),
  /** file triggers: Camel `doneFileName` — the trigger file that has to exist before the data file is picked up. */
  doneFile: z.string().nullable(),
  /** 1-based position of the `<from>` in its route (older Camel XML allows several inputs per route). */
  input: z.number().int(),
  /** schedule triggers: cron expression, or period / delay for timer and scheduler. */
  schedule: z.string().nullable(),
  sourceFile: z.string(),
  line: z.number().int(),
  /** Placeholders that could not be resolved to a single value (missing, or different per properties file). */
  unresolved: z.array(
    z.object({ key: z.string(), values: z.array(z.object({ file: z.string(), value: z.string() })) }),
  ),
  coveredBy: z.array(TriggerCoverage),
});
export type Trigger = z.infer<typeof Trigger>;

/** `POST /api/triggers/scan` multipart fields (editor or ingest token); the files are a .zip of the repo or loose files. */
export const TriggerScanFields = z.object({
  branch: trimmed(LIMITS.shortTextMax).min(1),
  commit: nullableShort.optional(),
  /** Free text shown with the scan, e.g. `PR #123`. */
  label: nullableShort.optional(),
  /**
   * Which part of the upload to use: `routes` (route XML + properties) for the Camel repo,
   * `tests` (pytest files) for the test repo — so route copies kept as test data in the
   * test repo never replace the real routes. Default: everything found.
   */
  only: z.enum(['routes', 'tests']).optional(),
});
export type TriggerScanFields = z.infer<typeof TriggerScanFields>;

export const TriggerScanSummary = z.object({
  id: z.number().int(),
  branch: z.string(),
  commit: z.string().nullable(),
  label: z.string().nullable(),
  scannedAt: z.string(),
  /** Triggers found (0 for a tests-only scan of the test repo). */
  total: z.number().int(),
  /** Route XML / properties / pytest files read. */
  files: z.object({ xml: z.number().int(), properties: z.number().int(), tests: z.number().int() }),
  /** Tests found in the pytest files (whether or not they cover a trigger). */
  testsFound: z.number().int(),
  /** Routes started by something other than a file or a schedule (jms, direct, rest…): not counted as triggers. */
  otherRoutes: z.number().int(),
});
export type TriggerScanSummary = z.infer<typeof TriggerScanSummary>;

export const TriggerScanResponse = TriggerScanSummary.extend({
  /** Triggers covered on this branch right after the scan (tests from this or the default branch's test scan). */
  automated: z.number().int(),
  /**
   * Test scans of the default branch (main/master/develop): test cases whose Jira/Xray key a test
   * names (comment, docstring, marker…), and how many of them this scan newly marked automated.
   * Null for other branches and for routes-only scans.
   */
  cases: z.object({ referenced: z.number().int(), newlyAutomated: z.number().int() }).nullable(),
  warnings: z.array(z.string()),
});
export type TriggerScanResponse = z.infer<typeof TriggerScanResponse>;

/** `POST /api/triggers/scan-github` (editor): download a branch of a GITHUB_REPOS repo and scan it. */
export const TriggerGithubScanRequest = z.object({
  repo: z.string().trim().regex(/^[\w.-]+\/[\w.-]+$/, 'owner/name'),
  branch: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .regex(/^[\w.\-/@+]+$/, 'not a valid branch name'),
  /** The Camel repo holds routes, the test repo holds tests (route copies kept as test data there are ignored). */
  only: z.enum(['routes', 'tests']),
});
export type TriggerGithubScanRequest = z.infer<typeof TriggerGithubScanRequest>;

/** `GET /api/triggers/github`: repos that can be scanned from the dashboard. */
export const TriggerGithubInfo = z.object({ configured: z.boolean(), repos: z.array(z.string()) });
export type TriggerGithubInfo = z.infer<typeof TriggerGithubInfo>;

/** Where a route on the default branch stands: a test on that branch, a test only on other branches, or none. */
export const RouteStatus = z.enum(['tested', 'branch', 'none']);
export type RouteStatus = z.infer<typeof RouteStatus>;

/** `GET /api/triggers/overview`: the default branch's routes with one status, for the Overview table. */
export const TriggerOverviewQuery = z.object({
  status: RouteStatus.optional(),
  limit: z.coerce.number().int().min(1).max(50).default(8),
});
export type TriggerOverviewQuery = z.infer<typeof TriggerOverviewQuery>;

export const TriggerOverviewRow = z.object({
  key: z.string(),
  routeId: z.string().nullable(),
  module: z.string().nullable(),
  kind: TriggerKind,
  scheme: z.string(),
  /** File pattern, schedule or file-name condition: what makes the route fire. */
  firesOn: z.string(),
  status: RouteStatus,
  /** Tests on the default branch that cover it (first 3), as pytest node ids. */
  tests: z.array(z.string()),
  /** Other branches whose tests cover it. */
  branches: z.array(z.string()),
});
export type TriggerOverviewRow = z.infer<typeof TriggerOverviewRow>;

export const TriggerOverviewResponse = z.object({
  /** Null until a route scan exists. */
  branch: z.string().nullable(),
  commit: z.string().nullable(),
  scannedAt: z.string().nullable(),
  counts: z.object({ tested: z.number().int(), branch: z.number().int(), none: z.number().int() }),
  /** The status listed: the one asked for, else the first of none → branch → tested that has routes. */
  status: RouteStatus,
  items: z.array(TriggerOverviewRow),
});
export type TriggerOverviewResponse = z.infer<typeof TriggerOverviewResponse>;

export const TriggerChange = z.enum(['added', 'changed', 'removed', 'unchanged']);
export type TriggerChange = z.infer<typeof TriggerChange>;

export const TriggerRow = Trigger.extend({
  /** Branches whose latest scan has this trigger. */
  branches: z.array(z.string()),
  /** Only with `compare`: vs the same trigger on the compare branch. */
  change: TriggerChange.nullable(),
  /** Only with `compare`: whether it was automated on the compare branch. */
  automatedBefore: z.boolean().nullable(),
});
export type TriggerRow = z.infer<typeof TriggerRow>;

/** `GET /api/triggers` — `branch` omitted ⇒ every branch's latest route scan merged, covered by any branch's tests. */
export const TriggerQuery = z.object({
  branch: trimmed(LIMITS.shortTextMax).min(1).optional(),
  compare: trimmed(LIMITS.shortTextMax).min(1).optional(),
});
export type TriggerQuery = z.infer<typeof TriggerQuery>;

export const TriggerListResponse = z.object({
  /** Latest scan of every branch, newest first. */
  branches: z.array(TriggerScanSummary),
  branch: z.string().nullable(),
  compare: z.string().nullable(),
  /**
   * Routes and tests can come from different repos, each scanned per branch. A branch
   * without its own route (or test) scan uses the default branch's: a PR in the test
   * repo is shown against main's routes, and a PR in the route repo against main's tests.
   */
  routesFrom: z.string().nullable(),
  testsFrom: z.string().nullable(),
  compareRoutesFrom: z.string().nullable(),
  compareTestsFrom: z.string().nullable(),
  /** Tests in the test scan(s) used, and how many of them cover at least one trigger. */
  tests: z.object({ read: z.number().int(), linked: z.number().int() }),
  /**
   * Only with `compare`: what the two branches' test scans disagree on — tests (pytest node
   * ids) and Jira/Xray keys named by tests that exist on one branch and not the other. Lists
   * are capped at 500; the counts are exact.
   */
  divergence: z
    .object({
      testsMissingHere: z.array(z.string()),
      testsOnlyHere: z.array(z.string()),
      testsMissingHereCount: z.number().int(),
      testsOnlyHereCount: z.number().int(),
      keysMissingHere: z.array(z.object({ key: z.string(), title: z.string().nullable(), testCaseId: z.number().int().nullable() })),
      keysOnlyHere: z.array(z.object({ key: z.string(), title: z.string().nullable(), testCaseId: z.number().int().nullable() })),
    })
    .nullable(),
  items: z.array(TriggerRow),
});
export type TriggerListResponse = z.infer<typeof TriggerListResponse>;
