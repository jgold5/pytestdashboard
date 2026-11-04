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
| DELETE | `/api/runs/:id` | – | 204 |
| GET | `/api/runs/:id/results` | `RunResultsQuery` | `TestResultList` |
| GET | `/api/runs/:id/failures` | – | `FailureGroup[]` (largest first) |
| GET | `/api/notes` | `NoteQuery` | `Note[]` |
| POST | `/api/notes` | `NoteCreate` | `Note` (201) |
| POST | `/api/notes/bulk` | `NoteBulkCreate` | `{created:number}` |
| PATCH | `/api/notes/:id` | `NoteUpdate` | `Note` |
| DELETE | `/api/notes/:id` | – | 204 |
| GET | `/api/integrations` | – | `IntegrationStatus[]` |
| POST | `/api/integrations/:name/sync` | – | 202 `IntegrationStatus` (409 if already running) |

Errors: always `ApiError` shape `{error, message, details?}` with proper status (400 validation, 401, 404, 409, 413, 415, 429, 500). Never leak stack traces or SQL.

## Domain rules

### Coverage
- `automationRate = automated / (total − notAutomatable)`.
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
- `failureSignature`: for failed/broken only; sha1 (first 12 hex) of the first line of the message, normalized (lowercase; strip numbers, hex ≥ 6, uuids, quoted strings, file paths, memory addresses; collapse whitespace).
- Run `name` default: executor `buildName` → `"Import <ISO timestamp>"`.
- Whole import in one DB transaction.

### Spreadsheet import
- Accept `.xlsx` and `.csv` (and `.tsv`). Parse server-side. Cell values coerced to trimmed text; dates → ISO date; formulas → cached result value only.
- Preview stores parsed rows in memory (Map with 1h TTL, max ~20 uploads, LRU eviction) keyed by random `uploadId` (crypto.randomUUID). Max rows 50,000/sheet, max 200 columns.
- Header fuzzy match → suggested field (e.g. "Test ID", "ID", "Case ID", "TC" → key; "Name"/"Title"/"Test Case"/"Summary" → title; "Module"/"Feature"/"Area"/"Component"/"Suite" → suite; "Automated?"/"Automation Status"/"Status" → automationStatus; "Owner"/"Assignee"/"QA" → owner; "Priority"/"Severity" → priority; "Labels"/"Tags" → tags (split on `,;|`); "Jira"/"Link"/"URL" → externalUrl).
- Status value suggestion: yes/y/true/automated/done/complete/✓/x → automated; wip/in progress/in-progress/ongoing/started → in_progress; no/n/false/manual/todo/not started/blank → not_automated; n/a/na/not automatable/not possible/won't automate → not_automatable.
- Priority normalization: P0–P3, Critical/Blocker→P0, High→P1, Medium→P2, Low→P3, 0–3 → P0–P3; else null.
- Commit upserts by `key` in one transaction; per-row validation errors reported (row number = spreadsheet row, 1-based incl header), others still imported. If key unmapped, use title as key.

### Flakiness
`flakiness` = status flips (passed↔failed/broken, ignoring skipped) across the last 10 executed results / max(1, n−1). `flakyOnly` = flakiness ≥ 0.3.

### Triage
A case's `triage` = triage of its newest note with non-null triage. "Untriaged failure" = last result failed/broken AND (no triage OR newest triage note older than that result's run).

### Integrations (GitHub + Jira/Xray)
Credentials come **only** from env vars. The UI can trigger a sync and see status, but can never read, set or change credentials or target URLs (no SSRF surface). Outbound requests go only to the configured base URLs, with timeouts (15s), retry with backoff on 429/5xx (respect `Retry-After` / `X-RateLimit-Reset`), pagination caps, and response-size caps. Errors are sanitized before being stored/returned (never include tokens or Authorization headers). Syncs run in-process, one at a time per integration (mutex); optional interval via env; also triggerable via `POST /api/integrations/:name/sync` (works with Bearer token, so CI can call it).

**Jira / Xray** (`src/integrations/jira.ts`): env `JIRA_BASE_URL` (https only), `JIRA_EMAIL`, `JIRA_API_TOKEN` (Cloud basic auth) — or `JIRA_PAT` for Server/DC bearer; `JIRA_JQL` (default `issuetype = Test ORDER BY key`), `JIRA_AUTOMATION_FIELD` (optional custom field id, e.g. `customfield_10123`, whose value maps to AutomationStatus via the same status-value normalizer as spreadsheet import), `XRAY_CLIENT_ID` + `XRAY_CLIENT_SECRET` (optional, Xray Cloud GraphQL at `https://xray.cloud.getxray.app/api/v2`) to read each test's **test type** (Manual / Cucumber / Generic). `JIRA_SYNC_INTERVAL_MINUTES` (optional).
- Fetch issues via `/rest/api/3/search/jql` (Cloud; fall back to `/rest/api/2/search` for Server) with `fields=summary,labels,components,priority,assignee,status,<automation field>`, paginated, cap 10,000.
- Upsert test cases matched by `jiraKey` (then by `key`): `key = jiraKey = issue.key`, `title = summary`, `suite = first component ?? null`, `tags = labels`, `owner = assignee.displayName`, `priority` normalized, `externalUrl = <base>/browse/<key>`, `source='jira'` on create.
- Automation status precedence: automation custom field value → Xray test type (Cucumber/Generic ⇒ automated) → unchanged (never downgrade `automated` that came from real allure results).
- Allure results also link to cases by `jiraKey`: allure `tms` link name / `AS_ID` / `testCaseId` / label `jira`/`xray` equal to `jiraKey` (add to linking rule 1).

**GitHub** (`src/integrations/github.ts`): env `GITHUB_TOKEN` (fine-grained, read-only: Pull requests + Contents), `GITHUB_REPOS` (comma list `owner/name`, required), `GITHUB_API_URL` (default `https://api.github.com`, for GHES), `GITHUB_SYNC_INTERVAL_MINUTES` (optional), `GITHUB_TEST_PATH_GLOBS` (default `**/test_*.py,**/*_test.py,**/tests/**`).
- For each repo: list open PRs (`state=open`, cap 300) + PRs merged in the last 14 days. For each, read title/body/head branch and `GET /pulls/:n/files` (cap 300 files; only files matching test globs; use `patch` text).
- Link rules → `linkedBy`: Jira key (any `[A-Z][A-Z0-9_]+-\d+` that equals an existing case `jiraKey`/`key`) in title/body/branch; added lines (`+`) in the patch containing markers `@allure.id("X")`, `@allure.testcase(...X...)`, `@pytest.mark.xray("X")`, `@pytest.mark.jira("X")`, `@allure.link(...X...)` matching a case's `allureId`/`jiraKey`/`key`; added `def test_<name>(` where `<name>` matches the last segment of a case's `allureFullName`/`key` (`module.Class#test_name` or `...::test_name` or `.test_name`) — only for files whose path matches the case's module when determinable.
- Store PRs in `pull_requests` and links in `test_case_pull_requests` (replace links for a repo atomically per sync). PR state: `draft` if open & draft, `merged`, `closed`, `open`.
- `inOpenPr` = any linked PR in state open/draft. Does **not** change `automationStatus` automatically (it's a derived badge), but the UI shows it and Coverage counts it.

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

- **Overview** (`/`): KPI tiles (Total cases, Automated with %, In progress, Last run pass rate, Untriaged failures); big automation-progress bar (stacked automated / in progress / not automated, not-automatable shown separately); coverage trend line; pass-rate trend per run (stacked bars by status); by-suite table with mini progress bars; triage breakdown; top flaky list; by-owner.
- **Test Cases** (`/tests`): server-paginated table with search (debounced), filters (suite, automation status, priority, last status, triage, owner, flaky), sortable columns, inline automation-status dropdown, row selection + bulk actions (set status/owner/suite/priority, add note), export CSV, "New test case" dialog. Filters reflected in URL query params (shareable links). Clicking a row opens the detail.
- **Test Case detail** (`/tests/:id`, drawer or page): metadata (editable), result history strip (colored dots, newest right, tooltips), latest failure message/trace (monospace, collapsible), notes thread with triage badge + ticket link + add/edit/delete.
- **Runs** (`/runs`): list with pass-rate bars, counts, branch, duration; delete with confirm.
- **Run detail** (`/runs/:id`): header stats + environment; tabs: *Failures (grouped by signature)* — each group expandable, "Triage all" (bulk note to all cases in group); *All results* — filterable table; click result → case detail.
- **Import** (`/import`): two cards.
  - *Allure results*: drag & drop a folder (use `webkitdirectory` input + DataTransfer items directory traversal) or a `.zip`; client filters to allowed filenames before upload; optional name/branch/commit/build URL; progress bar; result summary.
  - *Spreadsheet*: upload xlsx/csv → pick sheet → column-mapping table with sample data & suggested mapping → status-value mapping → dry-run summary → commit.
  - Also show a copy-pastable `curl` snippet for CI uploads with Bearer token.
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
