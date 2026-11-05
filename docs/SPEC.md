# Test Automation Dashboard — Product & Technical Spec

## Goal
Track test-case automation progress (**n total cases, y automated**) and the
health of automated runs. Import pytest/Allure results (`allure-results`
folder or zip), import the existing Excel/CSV tracker, and let the team leave
notes and triage categories explaining *why* things fail.

## Users & core jobs
1. **QA lead**: "What % of our cases are automated, and is that trending up? Per suite/owner?"
2. **Automation engineer**: "Upload last night's allure-results. What failed? What's new vs. known?"
3. **Anyone**: "Leave a note on this failure: it's a product bug, here's the Jira link."
4. **Onboarding**: "Import our Excel tracker so we don't start from zero."

## Architecture
pnpm monorepo, TypeScript everywhere, Node >= 22.

| Package | Stack |
|---|---|
| `packages/shared` | zod 4 schemas = the API contract (`src/index.ts`). **Source of truth.** |
| `apps/server` | Fastify 5, better-sqlite3 + Drizzle ORM (SQLite file at `DATA_DIR/dashboard.db`), zod validation, vitest. Bundled by tsup. Serves the built web app in production. |
| `apps/web` | Vite + React 19 + TypeScript, Tailwind CSS v4, TanStack Query, React Router, Recharts, Radix primitives, lucide icons, sonner toasts. |

Single deployable: `pnpm build && pnpm start` → one Node process on `PORT` (default 3000) serving `/api/*` and the SPA. Dev: `pnpm dev` → server on 3000, Vite on 5173 proxying `/api`.

## API routes (all JSON unless noted; types in `@ptd/shared`)

| Method | Path | Body / Query | Response |
|---|---|---|---|
| GET | `/api/health` | – | `{ok:true}` (no auth) |
| GET | `/api/auth/session` | – | `SessionInfo` (no auth) |
| POST | `/api/auth/login` | `LoginRequest` | 204 + cookie (no auth, rate-limited) |
| POST | `/api/auth/logout` | – | 204 |
| GET | `/api/summary` | – | `Summary` |
| GET | `/api/meta` | – | `Meta` |
| GET | `/api/test-cases` | `TestCaseQuery` | `TestCaseList` |
| POST | `/api/test-cases` | `TestCaseCreate` | `TestCase` (201; 409 on duplicate key) |
| GET | `/api/test-cases/:id` | – | `TestCaseDetail` |
| PATCH | `/api/test-cases/:id` | `TestCaseUpdate` | `TestCase` |
| DELETE | `/api/test-cases/:id` | – | 204 (cascades notes; results keep run integrity → delete results too) |
| POST | `/api/test-cases/bulk-update` | `TestCaseBulkUpdate` | `{updated:number}` |
| GET | `/api/test-cases/export.csv` | `TestCaseQuery` filters | `text/csv` (formula-injection safe) |
| POST | `/api/test-cases/import/preview` | multipart: 1 `.xlsx`/`.csv` | `ImportPreviewResponse` |
| POST | `/api/test-cases/import/status-values` | `ImportStatusValuesRequest` | `ImportStatusValuesResponse` |
| POST | `/api/test-cases/import/commit` | `ImportCommitRequest` | `ImportCommitResponse` |
| GET | `/api/runs` | `RunQuery` | `RunList` (newest first) |
| POST | `/api/runs/import` | multipart (see `RunImportFields`) | `RunImportResponse` (201) |
| GET | `/api/runs/:id` | – | `Run` |
| PATCH | `/api/runs/:id` | `RunUpdate` | `Run` (re-links baselines if runGroup/branch change) |
| DELETE | `/api/runs/:id` | – | 204 |
| GET | `/api/runs/:id/results` | `RunResultsQuery` | `TestResultList` |
| GET | `/api/runs/:id/failures` | – | `FailureGroup[]` (new failures first, then largest) |
| GET | `/api/results/:id` | – | `TestResult` incl. message + trace (editor only; used for on-demand trace loading) |
| GET | `/api/runs/compare` | `RunCompareQuery` | `RunComparison` |
| GET | `/api/history/matrix` | `HistoryMatrixQuery` | `HistoryMatrix` |
| GET | `/api/notes` | `NoteQuery` | `Note[]` |
| POST | `/api/notes` | `NoteCreate` | `Note` (201) |
| POST | `/api/notes/bulk` | `NoteBulkCreate` | `{created:number}` |
| PATCH | `/api/notes/:id` | `NoteUpdate` | `Note` |
| DELETE | `/api/notes/:id` | – | 204 |
| GET | `/api/pull-requests` | `PullRequestQuery` (incl. `readyToMerge`) | `PullRequest[]` (needsAttention first, then updatedAt desc) |
| GET | `/api/bugs` | `BugQuery` | `BugList` |
| GET | `/api/bugs/stats` | – | `BugStats` |
| POST | `/api/bugs` | `BugCreate` | `Bug` (201; 409 duplicate jiraKey) |
| GET | `/api/bugs/:id` | – | `Bug` |
| PATCH | `/api/bugs/:id` | `BugUpdate` | `Bug` |
| DELETE | `/api/bugs/:id` | – | 204 |
| GET | `/api/integrations` | – | `IntegrationStatus[]` |
| GET | `/api/report` | `ReportQuery` | `Report` (editor **or viewer**) |
| GET | `/api/settings` | – | `Settings` (editor or viewer) |
| PUT | `/api/settings` | `Settings` | `Settings` (editor) |
| POST | `/api/integrations/:name/sync` | – | 202 `IntegrationStatus` (409 if already running) |

Errors: always `ApiError` shape `{error, message, details?}` with proper status (400 validation, 401, 404, 409, 413, 415, 429, 500). Never leak stack traces or SQL.

## Domain rules

### Coverage
- `automationRate = automated / (total − notAutomatable)`. The same definition applies per suite and per owner (`Summary.bySuite` / `byOwner` carry `notAutomatable`; `Report.suites` carries `automatable`), so the Overview, Report and headline numbers agree.
- "Newly automated" (Report highlights) counts cases that *became* automated in the period (`automatedAt > createdAt`) plus cases discovered by an allure import after the very first one; cases that arrived already automated (spreadsheet/Jira bootstrap, manual create, first import) count as "cases added" instead.
- A daily snapshot row `(date, total, automated)` is upserted after every mutation that can change counts (create/update/delete/bulk/imports). Trend = these rows.

### Allure import
- Parse `*-result.json` (Allure 2 format: `uuid, historyId, testCaseId, fullName, name, status, statusDetails{message,trace}, start, stop, labels[], parameters[]`). Also `environment.properties` (→ `Run.environment`) and `executor.json` (→ name/buildUrl defaults if fields absent). Ignore containers/attachments for v1 (accept but skip).
- **Retries**: multiple results with the same `historyId` in one upload → keep the one with the latest `stop`; `retries = count − 1`.
- **Linking result → test case**, in order:
  1. `testCase.allureId` equals result `testCaseId`, or label `AS_ID`/`allure_id`/`as_id`, or a `tms` link name.
  2. `testCase.allureFullName` equals result `fullName`.
  3. `testCase.key` equals result `fullName`.
  4. Otherwise auto-create a case: `key = fullName ?? name`, `title = name`, `suite` from labels (`feature` → `suite` → `parentSuite` → module part of fullName), `allureFullName = fullName`, `automationStatus = 'automated'`, tags from `tag` labels.
- If a matched case has status `not_automated`/`in_progress`, promote it to `automated` (count in `promotedTestCases`).
- `failureSignature`: for failed/broken only; sha1 (first 12 hex) of one **anchor line** of the message, normalized (see *Failure signatures* below).
- Run `name` default: executor `buildName` → `"Import <YYYY-MM-DD HH:mm> UTC"` (import time).
- Whole import in one DB transaction.

### Failure signatures (Camel / Oracle aware)
Suites are pytest integration tests of Apache Camel routes against Oracle, so messages look like `cx_Oracle.DatabaseError: ORA-00942: table or view does not exist`, `oracledb.exceptions.OperationalError: ORA-12541: TNS:no listener`, `org.apache.camel.CamelExecutionException: … Exchange[ID-host-1234-1700000000-0-5]` + `Caused by: …`, or `AssertionError: assert …`.
- **Window**: the message is cut to 16 KB, then the first 8 non-empty lines (each ≤ 2,000 chars) are inspected. Every regex is linear-time with bounded quantifiers (SECURITY_REVIEW F-04 / R2-01; covered by the 100 KB < 50 ms test).
- **Anchor line** (the "most specific" line drives the signature): first line with an Oracle code (`ORA-\d{5}`, `TNS-\d{5}`, `PLS-\d{5}`, `SP2-\d{4}`) → else first line with a SQLSTATE (`SQLSTATE[23000]`, `SQLState: 08006`) → else first line with an HTTP status (`HTTP 503`, `HTTP/1.1 503`, `statusCode: 500`, `status code 404`, `500 Server Error`) → else the last `Caused by:` line → else the first line. A leading `Caused by:` is dropped; for an Oracle-code anchor only the text **from the first code onward** is used, so the same Oracle error groups together whichever driver/wrapper raised it (`cx_Oracle`, `oracledb`, JDBC under Camel). `FailureGroup.sampleMessage` shows the anchor line.
- **Preserved** (survive number stripping, emitted lowercase): the Oracle codes, SQLSTATE codes (`sqlstate <code>`), HTTP statuses (`http <code>`), and exception class names — fully-qualified Java/Python names are reduced to the simple class name (`org.apache.camel.CamelExecutionException` → `camelexecutionexception`, `cx_Oracle.DatabaseError` and `oracledb.exceptions.DatabaseError` → `databaseerror`), so the driver/package does not split groups. Codes inside quoted strings are kept (`<str ora-00001>`).
- **Stripped**: Camel exchange ids (`ID-host-1234-1700000000-0-5` → `<exchange-id>`), JMS/ActiveMQ message ids (`ID:host-1-2-1:1:1:1` → `<msg-id>`), ISO-ish timestamps (`<ts>`), uuids, `0x` addresses, quoted strings (Oracle object names like `"APP"."INVOICE"` included), file paths, hex ≥ 6, and every other number (route/endpoint counters `route12`, `to7`, ports, counts); then whitespace is collapsed.
- Consequences: `ORA-00942` and `ORA-00001` never group together; two failures differing only by exchange id do.

### Suggested triage (heuristic, never applied server-side)
`suggestedTriage` on `TestResult` and `FailureGroup` (from the group's sample message) is `environment` when the same 8-line window contains an infrastructure signal, else null:
- Oracle connectivity/infra codes: ORA-12541, ORA-12514, ORA-12170, ORA-03113, ORA-03114, ORA-12537, ORA-12535, ORA-12543, ORA-12545, ORA-01017 (auth), ORA-28000 (locked account), ORA-00018 / ORA-00020 (sessions / processes exceeded); any `TNS-\d{5}`.
- `Connection refused`, `Connection reset`, `timed out`, `UnknownHostException`, `Name or service not known`, `Temporary failure in name resolution`, `SQLRecoverableException`, `The Network Adapter could not establish the connection`.
- JMS/ActiveMQ/Artemis connection failures: `ActiveMQNotConnectedException`, `ActiveMQConnectionTimedOutException`, `java.net.ConnectException`, `Failed to create session factory`, or a line mentioning JMS/ActiveMQ/Artemis together with connect/connection/transport.
- Camel: `No consumers available on endpoint`.
The UI shows it as a dismissible chip on failure groups that are not yet triaged ("Looks like environment — apply?"); applying creates the normal bulk triage note. Untriaged counting is unchanged.

### Automation pipeline (GitHub-driven)
`TestCase.pipelineStage` is **derived on read** (one SQL `CASE` expression, so it is filterable via `TestCaseQuery.pipelineStage` and countable in `Summary.pipeline` / `Report.automationInFlight`). A linked PR is **ready to merge** (`PullRequest.readyToMerge`) when state = open (not draft) AND reviewState = approved AND checks ∈ {passing, none} AND unresolvedThreads = 0. Precedence, first match wins:
1. automationStatus `not_automatable` → **not_automatable** (always; PRs never change it).
2. automationStatus ≠ `automated` and ≥ 1 linked PR in state open/draft → the most advanced open PR wins: any ready-to-merge PR → **ready_to_merge**; else any open non-draft PR → **in_review** (review_required / changes_requested / none / unresolved threads / checks failing or pending); else (only drafts) → **pr_draft**. Open PRs on an already-automated case are maintenance and do not move it.
3. ≥ 1 linked **merged** PR; let M = latest `mergedAt`. If the case was not automated before M (automationStatus ≠ `automated`, or `automatedAt` ≥ M — which is the case after auto-promotion) and there is **no `passed`/`failed` result** for the case in any run with `COALESCE(startedAt, importedAt)` > M (broken/skipped do not count) → **merged_awaiting_run**.
4. automationStatus `automated` → **automated**; `in_progress` → **in_progress**; `not_automated` → **not_started** (closed-unmerged PRs are ignored).
Links come from the sync (R2-03 cap of 50 links per PR applies) and are replaced each sync; merged PRs leave the 14-day window and lose their links, so `merged_awaiting_run` ends after a later run or after ~14 days, whichever is first.
- **Auto-promotion on merge**: when the GitHub sync (or `replaceRepoPullRequests` in general) stores a linked PR as `merged`, linked cases with automationStatus `not_automated`/`in_progress` become `automated` with `automatedAt = mergedAt`, `automatedVia = 'pr_merge'` (same transaction; coverage snapshot recorded). `not_automatable` and already-automated cases are never touched. GitHub sync stats: `updated` = cases promoted this way, `created` = PRs seen for the first time.
- **automatedVia** (`allure | pr_merge | manual | spreadsheet | jira`) is stamped wherever a case transitions into `automated` (allure promotion/auto-create, PR merge, manual create/update/bulk, spreadsheet commit, Jira sync); null for legacy rows.
- **Projection** (Report "Automation in flight"): `projectedAutomated` = automated + cases in ready_to_merge / merged_awaiting_run that are not yet `automated`; `projectedAutomationRate` = projectedAutomated / (total − notAutomatable).

### Spreadsheet import
- Accept `.xlsx` and `.csv` (and `.tsv`). Parse server-side. Cell values coerced to trimmed text; dates → ISO date; formulas → cached result value only.
- Preview stores parsed rows in memory (Map with 1h TTL, max ~20 uploads, LRU eviction) keyed by random `uploadId` (crypto.randomUUID). Max rows 50,000/sheet, max 200 columns.
- Header fuzzy match → suggested field (e.g. "Test ID", "ID", "Case ID", "TC" → key; "Name"/"Title"/"Test Case"/"Summary" → title; "Module"/"Feature"/"Area"/"Component"/"Suite" → suite; "Automated?"/"Automation Status"/"Status" → automationStatus; "Owner"/"Assignee"/"QA" → owner; "Priority"/"Severity" → priority; "Labels"/"Tags" → tags (split on `,;|`); "Jira"/"Link"/"URL" → externalUrl).
- Status value suggestion: yes/y/true/automated/done/complete/✓/x → automated; wip/in progress/in-progress/ongoing/started → in_progress; no/n/false/manual/todo/not started/blank → not_automated; n/a/na/not automatable/not possible/won't automate → not_automatable.
- Priority normalization: P0–P3, Critical/Blocker→P0, High→P1, Medium→P2, Low→P3, 0–3 → P0–P3; else null.
- Commit upserts by `key` in one transaction; per-row validation errors reported (row number = spreadsheet row, 1-based incl header), others still imported. If key unmapped, use title as key.

### Run history (critical feature — user priority)
- **Run groups**: runs of different test sets (folder A vs folder B, smoke vs regression) must never be baselined against each other. `runGroup` resolution on import: explicit form field → executor.json `buildName`? NO (that's the run name) → **auto-derive**: for each result, take the module path (fullName before `#`/`::`, or label `package`, converted `.`→`/`, dropping the final module file segment, e.g. `tests.api.users.test_login#test_ok` → `tests/api/users`); runGroup = longest common directory prefix across all results, trimmed to at most 3 segments; if empty → `"default"`. Allure labels `parentSuite`-only uploads with no fullName → `"default"`. Report the derived group in import warnings ("Run group auto-detected as tests/api — set runGroup to override").
- Each run's `previousRunId` = latest earlier run with the same runGroup AND same branch (null branch matches null). Order runs by `COALESCE(started_at, imported_at)`. Store `previous_run_id` on the run and `change` on each result at import time (in the import transaction). Deleting a run must recompute `previous_run_id` + `change` for the next run on that branch. Importing an older run (startedAt earlier than existing ones) must re-link the following run too.
- `Run.changes` counts are stored/derived from results' `change` values; `missing` = cases in previous run not in this one.
- Compare, matrix and TestCaseDetail.stats as defined in the contract. Must be efficient: index `test_results(run_id)`, `test_results(test_case_id, run_id)`, `runs(branch, started_at)`. Matrix must be computed with at most a few queries (no N+1). Target: matrix of 50 rows × 60 runs on a DB of 5k cases × 300 runs in < 200 ms.

### Bugs identified
- Tables: `bugs`, `bug_test_cases (bug_id, test_case_id)`, `bug_signatures (bug_id, signature)`. `verification` computed on read per contract definition (runs started after resolvedAt; consider the case's results across all run groups).
- Auto-create: when a note is created with `triage='product_bug'` and a `ticketUrl` whose path ends in a Jira-like key (`/browse/ABC-123` or `selectedIssue=ABC-123`), upsert a bug by jiraKey (title = first line of note body, ≤ 200 chars, until Jira sync fills the real summary), link the note's case, and the note's result's signature/run. `foundByAutomation` = true when a resultId/runId is involved.
- Failure groups: `bugs` = bugs linked to that signature, or linked to all affected cases. When importing a run, a new failure whose signature is linked to an open bug gets triage "known_issue" implicitly for untriaged counting (do not create notes).
- Untriaged failure definition is extended: a failing case with a linked open/in_progress bug is NOT untriaged.
- Jira sync (integrations engineer): for bugs with jiraKey, fetch `status, statusCategory, resolutiondate, assignee, summary, priority` in batches (JQL `key in (...)`, ≤ 100 per call) → status mapping by statusCategory (new → open, indeterminate → in_progress, done → resolved, unless resolution is Won't Do/Won't Fix/Duplicate → wont_fix), severity from priority (Highest/Blocker→critical, High→major, Medium→minor, Low/Lowest→trivial). Also pull Xray Test issues' linked defects (issuelinks of type "Defect"/"Tests"/"is blocked by" where linked issue type = Bug) → upsert bugs and link to the test case.

### Flakiness
`flakiness` = per run group: status flips (passed↔failed/broken, ignoring skipped) across that group's last 10 executed results for the case / max(1, n−1); the case's flakiness = max over groups. `flakyOnly` = flakiness ≥ 0.3.

### Triage
A case's `triage` = triage of its newest note with non-null triage. "Untriaged failure" = last result failed/broken AND (no triage OR newest triage note older than that result's run).

### Integrations (GitHub + Jira/Xray)
Credentials come **only** from env vars. The UI can trigger a sync and see status, but can never read, set or change credentials or target URLs (no SSRF surface). Outbound requests go only to the configured base URLs, with timeouts (15s), retry with backoff on 429/5xx (respect `Retry-After` / `X-RateLimit-Reset`), pagination caps, and response-size caps. Errors are sanitized before being stored/returned (never include tokens or Authorization headers). Syncs run in-process, one at a time per integration (mutex); optional interval via env; also triggerable via `POST /api/integrations/:name/sync` (works with Bearer token, so CI can call it).

**Jira / Xray** (`src/integrations/jira.ts`): env `JIRA_BASE_URL` (https only), `JIRA_EMAIL`, `JIRA_API_TOKEN` (Cloud basic auth) — or `JIRA_PAT` for Server/DC bearer; `JIRA_JQL` (default `issuetype = Test ORDER BY key`), `JIRA_AUTOMATION_FIELD` (optional custom field id, e.g. `customfield_10123`, whose value maps to AutomationStatus via the same status-value normalizer as spreadsheet import), `XRAY_CLIENT_ID` + `XRAY_CLIENT_SECRET` (optional, Xray Cloud GraphQL at `${XRAY_BASE_URL}/api/v2`; `XRAY_BASE_URL` defaults to `https://xray.cloud.getxray.app`, must be https with host `xray.cloud.getxray.app` or `*.xray.cloud.getxray.app` for regional instances) to read each test's **test type** (Manual / Cucumber / Generic). `JIRA_SYNC_INTERVAL_MINUTES` (optional).
- Fetch issues via `/rest/api/3/search/jql` (Cloud; fall back to `/rest/api/2/search` for Server) with `fields=summary,labels,components,priority,assignee,status,<automation field>`, paginated, cap 10,000.
- Upsert test cases matched by `jiraKey` (then by `key`): `key = jiraKey = issue.key`, `title = summary`, `suite = first component ?? null`, `tags = labels`, `owner = assignee.displayName`, `priority` normalized, `externalUrl = <base>/browse/<key>`, `source='jira'` on create.
- Automation status precedence: automation custom field value → Xray test type (Cucumber/Generic ⇒ automated) → unchanged (never downgrade `automated` that came from real allure results).
- Allure results also link to cases by `jiraKey`: allure `tms` link name / `AS_ID` / `testCaseId` / label `jira`/`xray` equal to `jiraKey` (add to linking rule 1).

**GitHub** (`src/integrations/github.ts`): env `GITHUB_TOKEN` (fine-grained, read-only: Pull requests + Contents), `GITHUB_REPOS` (comma list `owner/name`, required), `GITHUB_API_URL` (default `https://api.github.com`, for GHES), `GITHUB_SYNC_INTERVAL_MINUTES` (optional), `GITHUB_TEST_PATH_GLOBS` (default `**/test_*.py,**/*_test.py,**/tests/**`).
- For each repo: list open PRs (`state=open`, cap 300) + PRs merged in the last 14 days. For each, read title/body/head branch and `GET /pulls/:n/files` (cap 300 files; only files matching test globs; use `patch` text).
- Link rules → `linkedBy`: Jira key (any `[A-Z][A-Z0-9_]+-\d+` that equals an existing case `jiraKey`/`key`) in title/body/branch; added lines (`+`) in the patch containing markers `@allure.id("X")`, `@allure.testcase(...X...)`, `@pytest.mark.xray("X")`, `@pytest.mark.jira("X")`, `@allure.link(...X...)` matching a case's `allureId`/`jiraKey`/`key`; added `def test_<name>(` where `<name>` matches the last segment of a case's `allureFullName`/`key` (`module.Class#test_name` or `...::test_name` or `.test_name`) — only for files whose path matches the case's module when determinable.
- Store PRs in `pull_requests` and links in `test_case_pull_requests` (replace links for a repo atomically per sync). PR state: `draft` if open & draft, `merged`, `closed`, `open`. `mergedAt` comes from REST `merged_at` (normalized to ISO-8601 with ms); `approvedAt` = `submittedAt` of the latest APPROVED review in the GraphQL `reviews(last:50)` page (null if none is visible).
- **Review status** (for open PRs): use the GitHub GraphQL API (`POST {GITHUB_API_URL}/graphql`, or `<host>/api/graphql` for GHES) to fetch per PR: `isDraft, reviewDecision, reviewRequests(first:20){requestedReviewer{... on User{login} ... on Team{name}}}, reviews(last:50){author{login} state submittedAt}, reviewThreads(first:100){nodes{isResolved}}, commits(last:1){nodes{commit{statusCheckRollup{state}}}}`. Batch PRs into one query via aliases where practical. `reviewState`: reviewDecision APPROVED→approved, CHANGES_REQUESTED→changes_requested, REVIEW_REQUIRED→review_required; if null: latest review per reviewer has CHANGES_REQUESTED→changes_requested, else any APPROVED→approved, else requested reviewers non-empty→review_required, else none. `checks`: SUCCESS→passing, FAILURE/ERROR→failing, PENDING/EXPECTED→pending, null→none. `needsAttention` = open && (changes_requested || unresolvedThreads>0 || checks=failing). Store these columns on `pull_requests`.
- `inOpenPr` = any linked PR in state open/draft. An open PR does **not** change `automationStatus` (it's a derived badge + pipeline stage); a **merged** PR auto-promotes linked cases (see *Automation pipeline*).

### Two sides: Workspace (internal) vs Report (management)
- **Workspace** = everything operational (cases, triage, notes, runs, PRs, imports, integrations).
- **Report** = presentation-grade rollup for management: `GET /api/report` returns aggregates only (no notes text, traces, messages, author names). Projection: weeklyVelocity = (automated_end − automated_start) / (periodDays/7) from coverage snapshots; remainingToGoal = ceil(targetRate × (total − notAutomatable)) − automated (min 0); projectedGoalDate = today + remaining/velocity weeks; status vs targetDate: projected ≤ target − 14d → ahead; ≤ target → on_track; ≤ target + 30d → at_risk; else behind (or behind if velocity ≤ 0 and remaining > 0).
- **Roles**: `DASHBOARD_TOKEN` → role `editor` (everything). Optional `VIEWER_TOKEN` (≥ 32 chars, must differ) → role `viewer`, which may ONLY call: health, auth/*, `GET /api/report`, `GET /api/settings`. Every other route returns 403 for viewers. Role is embedded in the signed session cookie and re-checked server-side on every request (never trust the client). Bearer tokens map to roles the same way. Optional `INGEST_TOKEN` (≥ 32 chars, distinct) → bearer-only role `ingest`, which may ONLY call `POST /api/runs/import` (and health); it cannot log into the UI. CI pipelines should use it instead of the editor token.

## Security requirements (non-negotiable)
1. **Auth**: env `DASHBOARD_TOKEN` (shared secret, ≥ 32 chars). If set, every `/api/*` route except health/session/login requires either `Authorization: Bearer <token>` (for CI uploads) or a valid session cookie. Login compares with `crypto.timingSafeEqual` (hash both sides first to equalize length), is rate-limited (e.g. 10/min/IP), and sets a signed, `httpOnly`, `SameSite=Strict`, `Secure` (in production), `Path=/` cookie with expiry (default 7d); sessions are stateless HMAC-signed with `SESSION_SECRET` and include issued-at. When `NODE_ENV=production` the server **refuses to start** without `DASHBOARD_TOKEN` and `SESSION_SECRET` (≥ 32 chars). In dev without a token, auth is disabled and a loud warning is logged.
2. **CSRF**: SameSite=Strict cookie + for cookie-authenticated non-GET requests, require the `Origin` (or `Referer`) header to match the server's own origin / `ALLOWED_ORIGINS`. Bearer-auth requests are exempt.
3. **Validation**: every params/query/body validated with the shared zod schemas. Unknown fields stripped. JSON body limit 1 MB.
4. **Uploads**: `@fastify/multipart` with limits (fileSize = `LIMITS.uploadMaxBytes`, files = `LIMITS.uploadMaxFiles`, fields ≤ 20, fieldSize ≤ 10 KB). Zip handling must be **safe**: stream entries with `yauzl` (no extraction to disk), reject entries with absolute paths / `..` (zip-slip), cap total uncompressed bytes (e.g. 1 GB) and per-entry size (e.g. 50 MB) and entry count, detect compression-ratio bombs, only read entries whose basename matches allowed patterns. Never use the uploaded filename for any filesystem path. Each JSON file parsed with `JSON.parse` inside try/catch, size-capped, then validated with a permissive zod schema; bad files → warnings, not 500s. Spreadsheet parsing: cap file size, rows, columns; don't evaluate formulas; xlsx parsed in-memory. Check magic bytes (zip `PK\x03\x04`) not just extension.
5. **SQL**: Drizzle query builder / parameterized statements only. No string-concatenated SQL with user input (LIKE patterns must escape `%`/`_`).
6. **Output**: CSV export must neutralize formula injection (prefix `'` to cells starting with `= + - @ \t \r`). UI never uses `dangerouslySetInnerHTML`; notes rendered as plain text or via react-markdown **without** raw HTML (no `rehype-raw`), links forced `rel="noopener noreferrer" target="_blank"` and only http(s).
7. **Headers**: `@fastify/helmet` with a strict CSP for the SPA (`default-src 'self'`; no inline scripts; `img-src 'self' data:`; `style-src 'self' 'unsafe-inline'` acceptable for Tailwind/Recharts), `frame-ancestors 'none'`, HSTS in production. CORS off by default (same-origin); `ALLOWED_ORIGINS` env to enable.
8. **Rate limiting**: global `@fastify/rate-limit` (e.g. 300/min/IP), stricter on login and imports.
9. **Errors/logging**: central error handler mapping to `ApiError`; pino logs with `redact` for `authorization`, `cookie`, `token`. No secrets in logs.
10. **Supply chain**: pinned exact versions, committed lockfile, `pnpm audit --prod` clean of high/critical (document any accepted exceptions), `onlyBuiltDependencies` allowlist in pnpm-workspace.
11. **Container**: Dockerfile multi-stage, runs as non-root `node` user, `DATA_DIR` volume, healthcheck.

## Config (env)
Integration vars as above. `PORT` (3000), `HOST` (0.0.0.0), `DATA_DIR` (./data), `DASHBOARD_TOKEN`, `SESSION_SECRET`, `SESSION_TTL_HOURS` (168), `ALLOWED_ORIGINS` (comma list), `TRUST_PROXY` (false), `LOG_LEVEL` (info), `NODE_ENV`. Document in `.env.example`.

## UI (apps/web)
Clean, modern, dense-but-calm "Linear/Vercel" aesthetic; light + dark (system default + toggle); responsive down to ~375px.

- **Overview** (`/`): KPI tiles (Total cases, Automated with %, In progress, Last run pass rate, Untriaged failures); big automation-progress bar (stacked automated / in progress / not automated, not-automatable shown separately) with the **automation pipeline funnel** underneath: Not started → In progress → PR draft → In review → Ready to merge → Merged (awaiting run) → Automated (+ Not automatable aside), each stage links to `/tests?pipelineStage=<stage>`; a prominent **"N tests done, awaiting merge"** callout (ready_to_merge) listing the ready PRs (repo#number, title, author, age since approval — else since last update) linking to `/pulls?filter=ready`; coverage trend line; pass-rate trend per run (stacked bars by status); by-suite table with mini progress bars; triage breakdown; top flaky list; by-owner.
- **Test Cases** (`/tests`): server-paginated table with search (debounced), filters (suite, automation status, pipeline stage, priority, last status, triage, owner, flaky), a pipeline-stage badge column, sortable columns, inline automation-status dropdown, row selection + bulk actions (set status/owner/suite/priority, add note), export CSV, "New test case" dialog. Filters reflected in URL query params (shareable links). Clicking a row opens the detail.
- **Test Case detail** (`/tests/:id`, drawer or page): metadata (editable), pipeline stage with the PR(s) driving it, **history section** (stats row: Failing since / N consecutive failures / Last passed / Pass rate (30) / Avg duration with slower warning; result history strip up to 100 with branch filter; duration trend mini line chart; click a dot → that run's result with message), latest failure message/trace (monospace, collapsible), notes thread with triage badge + ticket link + add/edit/delete.
- **Pull requests** (`/pulls`): automation PRs linked to cases — columns: PR (repo#number + title, link), author, state (draft/open/merged), review state badge, requested reviewers, 💬 unresolved threads count, CI checks badge, linked cases (chips), updated. Filters: ready to merge / needs attention / review required / changes requested / approved; a "Ready to merge" section sits at the top of the default view. Default sort: needs attention first. Overview gets a "PR pipeline" card: Draft → Review required → Changes requested → Approved, plus "N unresolved comment threads" and a "Needs attention" callout linking here.
- **Runs / History** (`/runs`) — tabs: *Runs* | *History matrix* | *Compare*.
  - **Run group selector** at the top of the Runs/History area (pill tabs or select, "All groups" allowed only on the Runs list); matrix/compare/trends are always scoped to one group. Remembers last choice (localStorage, try/catch). Run group shown as a chip on every run everywhere. Import form has a Run group field with autocomplete from existing groups (blank = auto-detect). Run detail has "Edit" (name/runGroup/branch). Overview pass-rate trend: one series per run group (or group selector). Test case detail history: grouped/filterable by run group, with a row per group in the history strip.
  - *Runs*: timeline-ish list; each row: name, run group, commit (short), started, duration, pass-rate bar, status counts, and change chips (▲ N new failures in red, ✓ N fixed in green). Filters: branch, date range, search. Select two runs → "Compare".
  - *History matrix*: heatmap (rows = tests, columns = runs, oldest→newest), compact square cells colored by status with icon-on-hover tooltip (run name, date, status), sticky test-name column and run header (rotated labels or date), filters (branch, suite, search, only unstable, # runs), click a cell → result/case detail. Must stay readable at 60 columns; horizontal scroll inside the card only.
  - *Compare*: pick base/head runs (default: latest vs its previous), summary chips, sections New failures / Fixed / Still failing / Added / Removed / Slower with tables.
- **Runs** (`/runs`) list details: list with pass-rate bars, counts, branch, duration; delete with confirm.
- **Run detail** (`/runs/:id`): header stats + environment + "vs previous run" banner (N new failures, N fixed, link to compare); `change` badge column in results with filter (default view highlights new failures); failure groups show "NEW" tag and "first seen" run; tabs: *Failures (grouped by signature)* — each group expandable, "Triage all" (bulk note to all cases in group), and, for untriaged groups with a `suggestedTriage`, a dismissible chip "Looks like environment — apply?" that creates that bulk note in one click (dismissal remembered per signature in localStorage); *All results* — filterable table; click result → case detail.
- **Import** (`/import`): two cards.
  - *Allure results*: drag & drop a folder (use `webkitdirectory` input + DataTransfer items directory traversal) or a `.zip`; client filters to allowed filenames before upload; optional name/branch/commit/build URL; progress bar; result summary.
  - *Spreadsheet*: upload xlsx/csv → pick sheet → column-mapping table with sample data & suggested mapping → status-value mapping → dry-run summary → commit.
  - Also show a copy-pastable `curl` snippet for CI uploads with Bearer token.
- **Mode switch**: top-level segmented control in the header: **Workspace | Report**. Viewers only ever see Report (no switch, no workspace nav).
- **Report** (`/report`): presentation-style, generous whitespace, big numbers, minimal chrome. Period selector (7/30/90/180d). Sections: headline (automation % with "+x pts this period", goal ring/progress toward target, status pill Ahead/On track/At risk/Behind with projected date); coverage trend line with goal line + projection dashed line; quality (latest & avg pass rate with delta, weekly pass-rate bars); suite readiness grid (traffic-light health tiles); highlights (wins) and risks (4 tiles each); PR pipeline summary; **Automation in flight** (in review / ready to merge / merged awaiting run counts, plus the projected rate, e.g. "77% automated · 81% once ready PRs merge"). "Print / Save PDF" button with a dedicated `@media print` stylesheet (A4/Letter landscape, light theme forced, no nav). "Copy link" for sharing. Editors can set team name + goal from a small settings dialog on this page.
- **Bugs** (`/bugs`, workspace nav): header stat tiles (Open, In progress, Resolved awaiting verification, ⚠ Resolved but still failing, Verified fixed, Mean days to resolve); found vs resolved weekly chart; table (key/link, title, severity badge, status, verification badge, linked tests with their last status, found in run, age, assignee); filters (bucket, severity, verification, found by automation, search); "New bug" dialog with test-case multi-picker. "Log bug" action on failure groups (pre-fills linked cases, signature, run, title from message) and on test case detail; test case detail + test cases table show bug badges (bug icon + key). "Resolved but still failing" is a prominent callout on Overview.
- **Report**: Bugs section — "N bugs found by automation this period", open by severity, found vs resolved trend, mean time to resolve, verified fixes.
- **Login** (`/login`): shown when `authRequired && !authenticated`; token field.
- Author name for notes: prompt once, store in `localStorage` (convenience only).
- Empty states that guide the user (e.g. "No data yet — import your Excel tracker or an allure-results folder").
- Accessible: keyboard navigable, labeled controls, color + icon/text for statuses (not color alone).

## Recommendations (roadmap, not v1)
- SSO (OIDC) + per-user identity instead of shared token.
- Postgres option for multi-instance deploys.
- Pytest plugin / GitHub Action that uploads allure-results automatically.
- Slack digest of new failures; Jira issue creation from a failure group.
- Quarantine list for flaky tests; ownership via CODEOWNERS.
