# Test Automation Dashboard

A self-hosted dashboard for teams that test with **pytest + Allure**. It answers two
questions: *how much of our test inventory is automated, and is that number going up?*
and *what failed last night, and is it new?* You upload `allure-results` from CI (or
by drag and drop), import the Excel or CSV tracker you already have, and the team
triages failures with notes, Jira links and bugs. Management gets a separate,
presentation-ready **Report** with goal tracking and a printable PDF.

![Overview](docs/screenshots/overview-light-1440.png)

## Features

The app has two sides. Editors use both; viewers see only the Report.

**Workspace** (the day-to-day tool for QA engineers)

- **Overview**: KPIs (total cases, automation rate, in progress, last-run pass rate,
  untriaged failures), coverage trend, results per run for each run group, suite and
  owner breakdowns, triage mix, top flaky tests, and the PR pipeline.
- **Automation pipeline (GitHub-driven)**: every case gets a derived stage — Not
  started → In progress → PR draft → In review → Ready to merge → Merged (awaiting run)
  → Automated. The Overview funnel links each stage to the filtered test list and
  calls out "N tests done, awaiting merge" with the approved PRs. When the sync sees a
  linked PR merged, its cases are promoted to `automated` automatically.
- **Test cases**: a searchable, filterable, server-paginated inventory. You can edit
  the automation status inline, run bulk actions and export to CSV. Each case has a
  detail page with history per run group, a duration trend, the latest failure and
  its stack trace, a notes thread, linked bugs and linked PRs.
- **Runs and history**:
  - The runs list shows change chips (new failures, fixed).
  - Run detail compares the run with the previous one and groups failures by
    normalized error signature. You can triage a whole group at once. Signatures are
    Camel/Oracle aware: `ORA-`/`TNS-` codes, SQLSTATEs, HTTP statuses and exception
    class names are kept, exchange/message ids and timestamps are stripped, and
    connectivity failures (ORA-12541, TNS-*, connection refused, JMS broker down…)
    get a one-click "Looks like environment — apply?" suggestion.
  - The **history matrix** shows tests × runs as a heatmap.
  - **Compare** puts any two runs side by side.
- **Bugs**: Jira-linked defects with a verification state, for example "resolved but
  still failing". A `product_bug` note that has a Jira link creates the bug
  automatically.
- **Pull requests**: automation PRs from GitHub that are linked to test cases. Each
  one shows review state, unresolved threads and CI checks. You can filter by repo
  and author.
- **Import**: allure-results as a folder or `.zip`, and a spreadsheet wizard that
  maps columns and status values and runs a dry run before it commits.
- **Integrations**: sync tests and bugs from Jira/Xray, and PRs from GitHub.

**Report** (for management, also available to read-only viewers)

The Report shows aggregates only: no notes, traces or names. It includes:

- the automation rate and its change over the period;
- the goal, with a projected date and an ahead / on track / at risk / behind status;
- the coverage trend with the projection;
- pass-rate quality per run group;
- suite readiness;
- highlights and risks;
- bug metrics;
- the PR pipeline and automation in flight (in review, ready to merge, merged
  awaiting a run, and the projected rate once ready PRs merge).

**Print / PDF** uses a dedicated print stylesheet.

| | |
|---|---|
| ![History matrix](docs/screenshots/matrix-light-1440.png) | ![Compare](docs/screenshots/compare-light-1440.png) |
| ![Report](docs/screenshots/report-light-1440.png) | ![Run detail](docs/screenshots/run-detail-dark-1440.png) |

More screenshots, in light and dark themes at 1440 px and 375 px wide, are in
[`docs/screenshots/`](docs/screenshots/).

## Quickstart

Requirements: Node.js 22 or later, and pnpm 10 (run `corepack enable` to get it).

### Run it on your machine (recommended for a local install)

```bash
git clone https://github.com/jgold5/pytestdashboard.git
cd pytestdashboard
pnpm install
cp .env.example .env
```

Generate two secrets and paste them into `.env` as `DASHBOARD_TOKEN=` and `SESSION_SECRET=`
(run the command twice, one value each). Keep `DASHBOARD_TOKEN`: it is what you type on the login page.

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Build and start (re-run `pnpm build` after pulling updates):

```bash
pnpm build
pnpm start          # http://localhost:3000 → log in with DASHBOARD_TOKEN
```

Data lives in `apps/server/data/dashboard.db` (SQLite). Back up that folder; delete it to start fresh.

Optional demo data, to look around before importing your own (stop the server first):

```bash
pnpm seed -- --reset    # 120 cases, ~60 runs, bugs, PRs — wipes the DB first
```

To let **teammates on your network** open it, set in `.env` (use your machine's IP) and restart:

```
PUBLIC_URL=http://192.168.1.50:3000
```

Optional `.env` extras: `VIEWER_TOKEN` (read-only Report login for managers), `INGEST_TOKEN`
(upload-only token for CI), Jira/GitHub settings (see [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md)).
Each token must be ≥ 32 characters and different from the others.

### Development mode

```bash
pnpm dev                   # API on :3000, UI with hot reload on http://localhost:5173
```

With `DASHBOARD_TOKEN` empty, dev mode disables auth and listens on 127.0.0.1 only.

## Importing data

### Allure results

You can send results from the UI or from CI.

- **From the UI**: open **Import → Allure results** and drop the `allure-results`
  folder or a `.zip` of it. You can optionally fill in run name, run group, branch,
  commit and build URL. Only `*-result.json`, `environment.properties` and
  `executor.json` are uploaded.
- **From CI**: use `curl` with a Bearer token. Create a dedicated upload-only
  `INGEST_TOKEN` for this. It can only call `POST /api/runs/import`. Never give CI
  the editor token.

  ```bash
  cd allure-results && zip -qr ../allure-results.zip . && cd ..
  curl --fail-with-body -sS -X POST "$DASHBOARD_URL/api/runs/import" \
    -H "Authorization: Bearer $DASHBOARD_INGEST_TOKEN" \
    --form-string "runGroup=tests/api" \
    --form-string "branch=$BRANCH" --form-string "commit=$COMMIT" \
    --form-string "buildUrl=$BUILD_URL" \
    -F "files=@allure-results.zip;type=application/zip"
  ```

  For a complete GitHub Actions workflow, see
  [`docs/examples/upload-allure.yml`](docs/examples/upload-allure.yml). It pins
  actions by SHA, handles untrusted branch names safely, and skips the upload on
  fork PRs.

Results are linked to test cases in this order:

1. Allure ID, Jira key, or `tms` link;
2. Allure full name;
3. case key.

When nothing matches, a new case is created automatically. Retries in one upload
are deduplicated.

### Run history (allure-history / allureparser)

**Import → Run history** (or `POST /api/runs/import-history`, which also accepts the
`INGEST_TOKEN`) imports many runs in one upload. It reads uploads the same way
[allure-history](https://github.com/jgold5/allureparser) does:

- **Snapshots** (`*.snapshot.json.gz`, written by `allure-history snapshot`): each
  snapshot is one run, named after its label and linked to its build URL. Snapshots
  hold only the failure location, not the full stack trace.
- **Several allure-results folders** (for example `ci/build-12/allure-results/`, as a
  folder or a `.zip`): each folder is one run, named after `executor.json`'s
  `buildName`, or after the folder if there is none.
- **One allure-results folder that collected many runs**: runs are recovered from the
  host and pytest process ID that allure-pytest records on every result. The workers
  of a `pytest -n` run count as one run.

Runs the dashboard already has (same group, branch, start, stop and counts) are
skipped, so you can upload the same history folder again safely. Runs keep each
retry's status, so a test that fails and then passes on rerun counts towards
flakiness.

```bash
cd history && zip -qr ../history.zip . && cd ..
curl --fail-with-body -sS -X POST "$DASHBOARD_URL/api/runs/import-history" \
  -H "Authorization: Bearer $DASHBOARD_INGEST_TOKEN" \
  --form-string "runGroup=tests/api" --form-string "branch=main" \
  -F "files=@history.zip;type=application/zip"
```

### Run groups

Every run belongs to a **run group**: a set of tests that are meant to be compared
with each other, for example `tests/api`, `tests/ui` or `smoke`.

- Runs are only ever compared within the same group and branch. This baseline
  drives "new failure", "fixed", the history matrix, Compare and flakiness. A smoke
  run is never compared with the full regression suite.
- If you leave the group blank, it is derived from the tests' common folder (for
  example `tests.api.users.test_login` gives `tests/api/users`). The import then
  shows a note that says which group was detected.
- Set the group explicitly in CI (`runGroup=...`) when the same folder runs in
  different configurations.

### Spreadsheet tracker

Go to **Import → Spreadsheet** and upload a `.xlsx`, `.csv` or `.tsv` file. The
wizard then takes you through these steps:

1. Pick the sheet.
2. Check the suggested column mapping. "Test ID", "Automated?", "Owner" and similar
   headers are recognized.
3. Map each distinct status value to an automation status.
4. Run a dry run.
5. Commit.

Rows are upserted by key, and errors are reported per row.

## Integrations

Jira/Xray syncs test cases, automation status and the status of linked bugs. GitHub
syncs automation PRs, review state and CI checks. Credentials come **only** from
environment variables; the UI can trigger a sync but can never read or change
credentials or URLs. Xray Cloud regions are supported through `XRAY_BASE_URL`.

Setup, token permissions and troubleshooting are in
**[docs/INTEGRATIONS.md](docs/INTEGRATIONS.md)**.

## Deployment

The app is a single Node process that serves both `/api` and the SPA, with SQLite
stored in `DATA_DIR`.

### Docker

```bash
docker build -t test-dashboard .
docker run -d --name test-dashboard -p 3000:3000 \
  -v test-dashboard-data:/data \
  -e DASHBOARD_TOKEN="$(openssl rand -hex 32)" \
  -e SESSION_SECRET="$(openssl rand -hex 32)" \
  -e INGEST_TOKEN="$(openssl rand -hex 32)" \
  -e PUBLIC_URL=https://qa.example.com \
  -e TRUST_PROXY=1 \
  test-dashboard
```

The image is built in several stages and runs as the non-root `node` user. It
declares a `/data` volume and a `HEALTHCHECK` on `/api/health`. Back up the volume:
it holds `dashboard.db` together with its WAL files.

### Behind a reverse proxy (recommended)

Terminate TLS in nginx, Caddy, Traefik or your load balancer, then:

- **`PUBLIC_URL=https://qa.example.com`**: the URL users open. It is the server's
  own origin for the CSRF check. It makes the session cookie `Secure`, and it enables
  the Host-header allowlist, which protects against DNS rebinding. Add any other
  hostnames to `ALLOWED_HOSTS`.
- **`TRUST_PROXY`**: set this to the number of proxy hops (for example `1`) or to a
  comma-separated list of proxy IPs or CIDRs, so that rate limits use the real
  client IP. `true` is rejected. With a hop count, make sure the app is reachable
  **only** through the proxy, or use the IP list form.
- Forward `X-Forwarded-For` and `X-Forwarded-Proto` from the proxy. Allow request
  bodies of at least 200 MB for allure uploads (`client_max_body_size 200m;` in
  nginx).
- HSTS is sent in production. Keep the dashboard on its own origin; it sends
  `X-Frame-Options: DENY` and a strict CSP.

Every setting is documented in [`.env.example`](.env.example). In production the
server refuses to start without `DASHBOARD_TOKEN` and `SESSION_SECRET`, each at
least 32 characters.

## Security model

- **Tokens and roles.** There are no user accounts. Access is based on tokens:
  - `DASHBOARD_TOKEN` gives the **editor** role, which can do everything.
  - The optional `VIEWER_TOKEN` gives the **viewer** role, which can only read the
    Report and settings.
  - The optional `INGEST_TOKEN` gives the **ingest** role, which can only upload
    runs and cannot sign in to the UI.

  Browsers exchange a token for a signed, `httpOnly`, `SameSite=Strict` session
  cookie. CI sends `Authorization: Bearer`. The role is checked on the server for
  every route, based on the matched route. To revoke sessions, rotate
  `SESSION_SECRET` or the token they were issued for.
- **Request protections.**
  - CSRF: cookie-authenticated writes must come from an allowed `Origin`.
  - Rate limits: login and imports have their own stricter limits, and all API
    calls also share a global per-IP limit.
  - Every input is validated with zod.
  - Uploads are size-capped. Zip files are read in a streaming way with zip-slip,
    bomb and amplification checks.
  - Spreadsheets are parsed in a resource-limited worker thread.
- **Stored data.** The SQLite database holds test cases, results (messages and
  traces are truncated), notes, author names typed into notes, bugs and PR metadata.
  Integration credentials are never stored or returned; error messages are stripped
  of secrets before they are saved.
- **Output.** There is no `dangerouslySetInnerHTML`, Markdown is rendered without
  raw HTML, and CSV exports are protected against formula injection.

The full threat review, findings and fixes are in
[docs/SECURITY_REVIEW.md](docs/SECURITY_REVIEW.md).

## Architecture

```
packages/shared   zod 4 schemas = the API contract (source of truth for server + web)
apps/server       Fastify 5 · better-sqlite3 + Drizzle · tsup bundle · serves the SPA
apps/web          React 19 · Vite · Tailwind v4 · TanStack Query · React Router · Recharts
e2e/              Playwright journeys against the production build
```

The product and technical spec, including the API route table and domain rules
(coverage math, run-group baselines, flakiness, triage, bug verification), is in
[docs/SPEC.md](docs/SPEC.md).

## Development

| Command | What it does |
|---|---|
| `pnpm dev` | Server (tsx watch) and Vite dev server |
| `pnpm lint` | ESLint across server, web, shared and e2e |
| `pnpm typecheck` | `tsc` for every package and for e2e |
| `pnpm test` | Unit and API tests (vitest, Fastify `inject`, in-memory temp DBs) |
| `pnpm build` | Web (Vite, code-split per route), then server (tsup) |
| `pnpm e2e` | Playwright: build → seed a temp `DATA_DIR` → start prod server → run journeys |
| `pnpm --filter @ptd/server seed -- --reset` | Demo data into `DATA_DIR` |

The e2e suite covers these journeys:

- login with a wrong token and with the right one;
- the viewer role being confined to the Report;
- Overview KPIs;
- allure zip import with a run group, and the import notes;
- run detail compared with the previous run, plus failure groups;
- a product-bug note that auto-creates a bug;
- the history matrix, including navigating from a cell;
- Compare;
- the spreadsheet wizard;
- inline status changes persisting after reload;
- the Report print layout and PDF export.

Set `E2E_SKIP_BUILD=1` to reuse an existing build. Set `PW_CHROMIUM_PATH` to use a
Chromium you already have installed. `@playwright/test` is pinned to an exact
version, so `pnpm exec playwright install chromium` fetches the browser that
matches it.

CI (`.github/workflows/ci.yml`) runs these steps:

1. install with a frozen lockfile;
2. lint;
3. typecheck;
4. unit tests;
5. build;
6. `pnpm audit --prod --audit-level high`;
7. e2e.

Actions are pinned by SHA, and Dependabot updates both the npm packages and the
actions every week.

## Roadmap / recommendations

- **SSO (OIDC) and per-user identity** instead of shared tokens. This would give
  real authorship, per-user revocation and an audit log.
- **Postgres** as an option, for multi-instance or high-availability deployments.
  SQLite is fine for a single instance.
- A **pytest plugin or GitHub Action** that uploads results automatically and fills
  in the run group, branch, commit and build URL.
- **Slack or Teams digests**: new failures, untriaged failures and "resolved but
  still failing" bugs after each nightly run.
- **Creating Jira issues** directly from a failure group, pre-filled with the
  signature, affected tests and run link.
- **Flaky-test quarantine**: a managed list with an owner and an expiry. Quarantined
  tests would be excluded from pass-rate KPIs but still tracked.
- Test **ownership from CODEOWNERS**; trends of duration regressions.
