# Connecting GitHub and Jira / Xray

Both integrations are **optional** and **read-only**: the dashboard only reads
from GitHub and Jira, it never writes anything back. Credentials live only in
the server's environment variables (your `.env` file in development, or the
container/host environment in production). The web UI can start a sync and
show its status, but it can never see or change tokens or URLs.

After changing environment variables, **restart the server**. Then open the
Integrations section in the dashboard and click **Sync now**, or call the API:

```bash
curl -X POST -H "Authorization: Bearer $DASHBOARD_TOKEN" https://dashboard.example.com/api/integrations/jira/sync
```

A sync runs in the background. The status (last sync, counts, last error)
appears in the UI. To sync automatically, set `JIRA_SYNC_INTERVAL_MINUTES` /
`GITHUB_SYNC_INTERVAL_MINUTES` (for example `60`).

---

## Jira (and optionally Xray)

### What it does

- Reads your **test cases** from Jira (the issues matched by `JIRA_JQL`, by
  default every issue of type *Test*) and creates or updates them in the
  dashboard: key, title, component (shown as the suite), labels (tags),
  assignee (owner), priority, and a link back to Jira.
- Keeps **bugs** up to date: every bug in the dashboard that has a Jira key
  gets its status, severity (from the priority), assignee and title from Jira.
  Bugs linked to a Test issue in Jira (a *Defect*, *Tests* or *Blocks* link to
  an issue of type *Bug*) are added and linked to that test case.
- Status mapping: *To Do* type statuses → open, *In Progress* type statuses →
  in progress, *Done* type statuses → resolved, except the resolutions
  *Won't Fix*, *Won't Do* and *Duplicate*, which become *won't fix*.
- A test case that is already **automated** and has real test results
  (imported Allure runs) is never set back to "not automated" by Jira.

### Step 1: Cloud, or Server / Data Center?

Look at the address you use to open Jira in your browser:

| Address looks like | You have | Use |
|---|---|---|
| `https://yourcompany.atlassian.net/...` | **Jira Cloud** | e-mail + API token |
| Anything else, e.g. `https://jira.yourcompany.com/...` | Probably **Jira Server / Data Center** | Personal Access Token |

If you're not sure, open **Help (?) → About Jira** in Jira. Server/Data Center
shows a version number like "Jira v9.12". Cloud doesn't.

Set `JIRA_BASE_URL` to the start of that address, without anything after the
host name, for example `JIRA_BASE_URL=https://yourcompany.atlassian.net`. It
must start with `https://`.

### Step 2a: Jira Cloud. Create an API token

1. Go to <https://id.atlassian.com/manage-profile/security/api-tokens> (or
   **id.atlassian.com → Security → API tokens**).
2. Click **Create API token**, give it a name like "test dashboard", and pick
   an expiry date.
3. Copy the token. You won't be able to see it again.

```env
JIRA_BASE_URL=https://yourcompany.atlassian.net
JIRA_EMAIL=you@yourcompany.com
JIRA_API_TOKEN=paste-the-token-here
```

The token acts as **you**: the dashboard sees exactly the projects and issues
you can see. If you want to limit what it can see, use a dedicated Jira
account with read access to the relevant projects only.

### Step 2b: Jira Server / Data Center. Create a Personal Access Token

1. In Jira, click your avatar, then **Profile → Personal Access Tokens**.
2. Click **Create token**, name it, and copy it.

```env
JIRA_BASE_URL=https://jira.yourcompany.com
JIRA_PAT=paste-the-token-here
```

Leave `JIRA_EMAIL` / `JIRA_API_TOKEN` empty in this case.

### Step 3: Choose which issues are test cases (`JIRA_JQL`)

The default `issuetype = Test ORDER BY key` fits most Xray setups. To limit
the sync to one project:

```env
JIRA_JQL=project = QA AND issuetype = Test ORDER BY key
```

Tip: paste the JQL into Jira's issue search (**Filters → Advanced issue
search**) first to check it returns the right issues. The sync reads at most
10,000 issues.

### Step 4 (optional): An "automation status" field

If your Test issues have a custom field such as "Automated?" or "Automation
status", the dashboard can use it. Values such as *Yes / Automated / Done*,
*In progress / WIP*, *No / Manual / To do* and *N/A / Not automatable* are
recognized. Unknown values are ignored.

To find the field id in Jira Cloud, go to **Settings (gear) → Issues → Custom
fields**, open the field's **…** menu, and choose **Edit details**. The URL then
ends in `id=10123`, so the field id is `customfield_10123`.

```env
JIRA_AUTOMATION_FIELD=customfield_10123
```

### Step 5 (optional): Xray Cloud API key

**You don't need this to get started.** The Jira token alone syncs test cases
and bugs. The Xray key adds one thing: it reads each test's **test type**.
Tests of type *Cucumber* or *Generic* are marked as automated. *Manual* tests
are left as they are. This only works with **Xray Cloud**. Xray on Jira
Server/Data Center stores the test type in a normal Jira field, which you can
use through `JIRA_AUTOMATION_FIELD` instead.

1. In Jira go to **Apps → Xray → Settings (or "Manage apps" → Xray) → API Keys**.
   You may need a Jira admin to do this.
2. Click **Create API Key**, choose a user, and copy the **Client ID** and
   **Client Secret**.

```env
XRAY_CLIENT_ID=...
XRAY_CLIENT_SECRET=...
# Only if your Xray Cloud data lives in a regional instance (data residency):
# XRAY_BASE_URL=https://eu.xray.cloud.getxray.app
```

`XRAY_BASE_URL` defaults to the global endpoint `https://xray.cloud.getxray.app`.
If your Jira site uses Xray data residency, use your region's host instead
(for example `https://eu.xray.cloud.getxray.app` or
`https://us.xray.cloud.getxray.app`; Xray's documentation lists the current
regions). The dashboard appends `/api/v2` itself. For safety the value must be
`https://` and the host must be `xray.cloud.getxray.app` or a subdomain of it,
with no path, port or credentials; anything else stops the server at startup
with a clear error. This means your Xray credentials can only ever be sent to
Xray.

How the automation status is decided, in order: the custom field, if set and
recognized; then the Xray test type; otherwise the status stays unchanged.

---

## GitHub

### What it does

For each repository in `GITHUB_REPOS`, the dashboard reads the open pull
requests plus those merged or closed in the last 14 days. It then links each
PR to test cases when:

- a Jira key of a test case (e.g. `QA-123`) appears in the PR **title**,
  **description** or **branch name**, or
- the PR adds lines with a test marker in a test file, such as
  `@allure.id("123")`, `@pytest.mark.xray("QA-123")`, `@pytest.mark.jira("QA-123")`,
  `@allure.testcase(...)` or `@allure.link(...)`, or
- the PR adds a test function `def test_name(` whose name matches a known test
  case, in the same module.

It also shows each PR's review state, unresolved review conversations, and CI
status, and flags PRs that **need attention**: changes requested, unresolved
threads, or failing checks. Linking a PR never changes a test case's automation
status. The case gets an "in open PR" badge instead.

### Create a read-only token

Recommended: a **fine-grained personal access token**.

1. On github.com go to **Settings → Developer settings → Personal access tokens
   → Fine-grained tokens → Generate new token**.
2. **Resource owner**: the organization that owns the repositories. The org may
   need to approve the token.
3. **Repository access**: *Only select repositories*, then pick the repos you
   list in `GITHUB_REPOS`.
4. **Repository permissions**, all **Read-only**:
   - **Pull requests**
   - **Contents** (to read the changed files of a PR)
   - **Metadata** (selected automatically)
   - **Commit statuses**, and **Checks** if it's offered (to show CI status)
5. Generate and copy the token.

A classic token also works. It needs the `repo` scope for private
repositories, but that scope grants write access too, so prefer a
fine-grained token.

```env
GITHUB_TOKEN=github_pat_...
GITHUB_REPOS=acme/api,acme/web
```

### GitHub Enterprise Server

Point `GITHUB_API_URL` at your server's API:

```env
GITHUB_API_URL=https://github.yourcompany.com/api/v3
```

### Which files count as tests

`GITHUB_TEST_PATH_GLOBS` (default `**/test_*.py,**/*_test.py,**/tests/**`)
decides which changed files are scanned for markers and test functions.
`**` matches any number of folders and `*` matches part of a file name.

---

## Troubleshooting

The Integrations page shows the last error. Common ones:

| Message contains | Meaning / fix |
|---|---|
| `HTTP 401` | The token is wrong or expired, or (Jira Cloud) the e-mail doesn't match the token's account. |
| `HTTP 403` | The token works but can't see that project or repo. Check permissions, or org approval for fine-grained GitHub tokens. |
| `HTTP 404` on `/repos/...` | Repo name typo in `GITHUB_REPOS`, or the token has no access to that repo. GitHub answers 404 for repos you can't see. |
| `HTTP 400` on `/search` | Your `JIRA_JQL` is invalid. Test it in Jira's advanced search. |
| `rate limited … try again later` | GitHub or Jira asked the dashboard to wait more than 60 seconds. The next sync will work. |
| `timed out` / `network error` | The server can't reach Jira or GitHub. Check the firewall or proxy settings of the host running the dashboard. |
| `Xray … authenticate → HTTP 401` | Wrong Xray Client ID or Secret, or the key belongs to a different Xray region. Check `XRAY_BASE_URL`, or remove both credentials to sync without Xray. |

Error messages never contain your tokens. They are removed before anything is
stored or shown.

### Running behind a corporate proxy

The server uses Node.js's built-in `fetch`. If outbound traffic must go
through an HTTP proxy, set `HTTPS_PROXY` (and `NO_PROXY` as needed) together
with `NODE_USE_ENV_PROXY=1` (Node 22.21 and later, and Node 24) in the server's
environment.
