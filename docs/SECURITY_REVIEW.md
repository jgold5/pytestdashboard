# Security review: `apps/server`

- **Date:** 2026-11-04
- **Commit reviewed:** `2cf51fc`
- **Scope:** `apps/server/src/**`, `test/**`, `scripts/**`, the repo-root `Dockerfile`, `.env.example`, `pnpm-lock.yaml`, `pnpm-workspace.yaml` and `packages/shared/src/index.ts`. The internals of `src/integrations/github.ts` and `jira.ts` were excluded because they are being rewritten. The registry, the runner, `sanitize.ts` and the integration routes were reviewed.
- **Method:** I read the code against `docs/SPEC.md` ("Security requirements" and "Roles"). Each finding below was then reproduced against a real app instance, using `buildApp` with `inject`, or `src/index.ts` listening on a port and driven with `curl` and raw sockets. The exploit scripts are kept outside the repo, in the reviewer's scratch directory.
- **Product code:** I made no changes to product code.

## Summary

| ID | Severity | Title | Status |
|----|----------|-------|--------|
| F-01 | **Critical** | Anyone can skip authentication, roles and CSRF by encoding the `/api` path or sending an absolute-form request target | Confirmed |
| F-02 | **High** | A 4 KB `.xlsx` crashes the server process (out of memory in read-excel-file's row-gap padding) | Confirmed |
| F-03 | Medium | Allure zip amplification: a 4 MB zip produces 870 MB in the DB, 877 MB of WAL and 2.6 GB RSS | Confirmed |
| F-04 | Medium | ReDoS in `parseProperties`: a 100 KB `environment.properties` blocks the event loop for about 11 s (quadratic) | Confirmed |
| F-05 | Medium | Memory exhaustion through the in-memory spreadsheet upload store (about 265 MB kept per upload, up to 20 slots) | Confirmed |
| F-06 | Low | `TRUST_PROXY=true` trusts every hop, so spoofed `X-Forwarded-For` bypasses all rate limits | Confirmed |
| F-07 | Low | When auth is disabled the server still listens on `0.0.0.0` and does not validate `Host`, which allows DNS rebinding | Confirmed |
| F-08 | Info | Stateless sessions cannot be revoked; TTL can be up to 1 year | By design |
| F-09 | Info | Header and TLS-deployment gaps: `X-Frame-Options: SAMEORIGIN`, plus the Secure cookie and origin check behind a TLS proxy | Observed |
| F-10 | Info | Keys from the prototype chain (`constructor`, `toString`) can mis-handle record lookups; functional effect only | Code reading |
| F-11 | Info | Supply chain: prod audit is clean; dev has 2 moderate advisories; base image is not pinned by digest | Observed |

F-01 makes F-02 through F-05 reachable **without authentication**. The result is that an unauthenticated user anywhere on the network can crash the service or fill its disk with a single request.

---

## F-01: Critical. Authentication, role and CSRF bypass through a non-canonical request target

**Affected code:** `apps/server/src/auth/plugin.ts:81`

```ts
if (!req.url.startsWith('/api/')) return;   // skips authn, role check and CSRF check
```

**Description**

The auth hook decides whether to enforce auth by looking at the *raw* `req.url`. The router (find-my-way) matches routes on the *decoded* path.

- A request to `/%61pi/test-cases` or `/ap%69/runs` therefore matches the `/api/...` handlers but fails the `startsWith('/api/')` test. Every check is skipped: authentication, editor/viewer role enforcement and the CSRF origin check.
- The same happens with an HTTP absolute-form request target, `GET http://host/api/test-cases HTTP/1.1`. Node leaves `req.url` as the full URL, but Fastify still routes it.

The consequences:

- An anonymous user on the network gets full editor access: read everything, including `export.csv`, notes and traces; create, update and delete cases, runs, bugs and notes; import files; trigger integration syncs.
- A viewer gets the same access.

Browsers keep `%61` in paths without decoding it. A malicious web page could therefore also send "simple" cross-site requests (multipart `POST /%61pi/runs/import`, or a body-less `POST /%61pi/integrations/github/sync`) to an internal instance with `mode: 'no-cors'`. The CSRF check is skipped too. This browser variant is plausible but was not tested in a real browser. Chrome's Private Network Access rules may limit it.

**Proof**

`inject` against an app built with `DASHBOARD_TOKEN` and `VIEWER_TOKEN` set:

```
401 /api/test-cases
200 /%61pi/test-cases          {"items":[],"total":0,...}
200 /%61pi/summary
viewer 403 /api/summary
viewer 200 /%61pi/summary
anon PUT /%61pi/settings (Origin: https://evil.example)  200 {"teamName":"PWNED2",...}
anon GET /ap%69/test-cases/export.csv                   200 "key","title",...
```

A real server (`NODE_ENV=production`, token set) driven with curl and a raw socket:

```
curl /api/test-cases                                   -> 401
curl -X POST --path-as-is /%61pi/test-cases (Origin evil) -> 201 {"id":1,"key":"PWN-1",...}
curl -X DELETE --path-as-is /%61pi/test-cases/1         -> 204
raw: GET http://127.0.0.1:3998/api/test-cases HTTP/1.1  -> 200 OK
raw: GET /ap%69/runs HTTP/1.1                           -> 200 OK
```

Variants that were correctly rejected: `/API/…`, `//api/…`, `/api//…`, trailing slash, `/api/./…`, `/x/../api/…`, `/api%2f…`, `;` suffixes, HEAD and OPTIONS. All of them returned 401 or 404.

**Recommended fix: deny by default and decide from the matched route, not the raw URL**

1. Tag routes when they are registered:

   ```ts
   app.addHook('onRoute', (r) => {
     r.config ??= {};
     if (r.config.access === undefined) {
       r.config.access = r.url.startsWith('/api') ? 'editor' : 'public';   // static/SPA routes
     }
   });
   ```

   The hook must be registered before any routes.
2. In `onRequest`, drop the `req.url.startsWith` test. Use `req.routeOptions.config.access` directly, and default to `'editor'` when it is `undefined`.
3. For unmatched requests (`req.routeOptions.url === undefined`), let the not-found handler run without auth.
4. Change the `startsWith('/api')` check in the SPA fallback (`app.ts:159`) to use the decoded pathname.
5. Add regression tests for `/%61pi/...`, `/ap%69/...`, absolute-form targets, and a viewer calling an encoded editor route.

---

## F-02: High. A tiny `.xlsx` crashes the process with an out-of-memory abort

**Affected code:** `apps/server/src/import/spreadsheet/parse.ts:64-73`, which calls `read-excel-file@9.3.14` (`modules/xlsx/parseSheet.js`, the `onCloseTagInSheetData` gap-filling loop).

**Description**

read-excel-file fills gaps between rows and columns:

- `while (rowNumber > rows.length+1) rows.push([])`
- `while (col > row.length+1) row.push(null)`

`<row r="60000000">` therefore makes the library allocate 60 million arrays. Several existing guards do not help:

- `assertSafeZip` cannot see this, because the XML is only a few hundred bytes.
- The `maxRows` and `maxColumns` caps in `toSheet` run *after* the library returns.
- The `<dimension>` element is ignored.

A large column reference such as `ZZZZZ1` causes the same problem horizontally: it pushed about 12 million nulls in 1.3 s before the 413 response.

**Proof**

The test file was built by patching `test/fixtures/tracker.xlsx` so that sheet1 contains row 1 and row 60,000,000. The result is a 4,111-byte file.

```
POST /api/test-cases/import/preview (editor bearer)
FATAL ERROR: ... JavaScript heap out of memory   (V8::FatalProcessOutOfMemory), exit code 134
```

The test ran with a 2 GB heap. A larger `r` value exceeds any heap size. Combined with F-01, this is an unauthenticated one-request crash. The Dockerfile has no restart policy; restarts depend on the orchestrator.

**Recommended fix**

- Before calling read-excel-file, stream each `xl/worksheets/*.xml` entry (the yauzl pass already reads them). Reject when:
  - any `<row r=…>` value is above `maxRows` plus a small slack, or
  - any `<c r=…>` column is above `maxColumns`, or
  - the cell count goes over a budget (for example 2 million).
- Also run `parseSpreadsheet` in a `worker_threads` Worker with `resourceLimits: { maxOldGenerationSizeMb: 512 }` and a timeout. A malicious file then kills the worker, not the server. This also fixes the event-loop blocking in F-05.
- Optionally, report the row-gap amplification upstream to read-excel-file.

---

## F-03: Medium. Allure zip amplification fills the disk and memory

**Affected code:**

- `apps/server/src/import/zip.ts:20-26` and `:143-148`: the ratio check only applies to entries of at least 1 MB, and the total cap is 1 GB.
- `apps/server/src/import/allure/parse.ts:131-146` and `importRun.ts:232-251`: each result keeps an 8 KB message, a 64 KB trace, and 200 labels plus 200 parameters of up to 1.2 KB each. That is about 550 KB per result, and all of it is stored in the database.

**Description**

The bomb check can be avoided by using many entries just under 1 MB, each compressing at about 100:1 or better. The uncompressed total stays under the 1 GB cap, but every byte is parsed, kept in memory and written to SQLite.

The import rate limit is 30 per minute. That allows roughly 25 GB per minute of database growth from about 120 MB of uploads.

**Proof**

1,800 entries of `*-result.json`, each 482 KB of repetitive JSON, packed into a 4,046 KB zip. Imported once:

```
status 201, 25.9 s
maxRSS 2621 MB
dashboard.db 872 MB, dashboard.db-wal 877 MB
```

**Recommended fix**

- Add an aggregate ratio check: total declared uncompressed size divided by archive size must stay at or below about 50–100.
- Lower `maxTotalBytes` to around 200–256 MB.
- Cap what is stored per result: labels and parameters at about 50 entries and 16 KB in total, and the trace at 16 KB.
- Cap the total stored bytes and the result count per import (for example 50k results), and reject above the cap.
- Consider a disk-usage guard: refuse imports when the DB is above a configured size.

---

## F-04: Medium. ReDoS in `parseProperties`

**Affected code:** `apps/server/src/import/allure/parse.ts:218`

```ts
/^([^=:]+?)\s*[=:]\s*(.*)$/
```

**Description**

When a line has no `=` or `:`, the lazy `[^=:]+?` and the `\s*` backtrack over runs of whitespace. The cost is O(n²). Lines are only limited by the file cap: 20 MB for individual files, or up to 50 MB inside a zip.

**Proof**

Direct call with the line `'a' + ' '.repeat(n) + 'b'`:

| n | Time |
|---|------|
| 10k | 95 ms |
| 20k | 474 ms |
| 40k | 1,766 ms |

End to end, a 100 KB `environment.properties` uploaded to `/%61pi/runs/import` without auth took **10,875 ms**, all of it synchronous on the event loop. A 1 MB line would take about 15–20 minutes.

**Recommended fix**

Remove the regex:

```ts
const i = line.search(/[=:]/);
if (i <= 0) continue;
const key = line.slice(0, i).trim();
const value = line.slice(i + 1).trim();
```

Also skip lines longer than about 8 KB, and cap the `environment.properties` file at about 64 KB.

---

## F-05: Medium. Memory exhaustion in spreadsheet preview and the upload store

**Affected code:**

- `apps/server/src/import/spreadsheet/store.ts:162-180`: up to 20 entries, 1-hour TTL, no byte budget.
- `parse.ts:19-24`: 50 MB files.
- `parse.ts:82-98` and `:113-114`: the full grid is built, then copied, and only then checked against the caps.

**Description**

A parsed CSV takes several times its file size in V8 memory. The store keeps up to 20 of them for an hour. The CSV is also parsed synchronously on the event loop.

**Proof**

- A 49 MB CSV (200 columns × 41k rows of 5-character cells) **keeps about 265 MB of heap per upload**: 268, 533, 800 and 1,065 MB after 4 uploads, with forced GC. Twenty uploads, which fits within the 30-per-minute limit, come to about 5.3 GB, which is enough to cause an OOM.
- A 50 MB CSV of commas reaches **1.24 GB peak RSS** and blocks the loop for about 7 s, even though the result is trimmed down to 1 column.

The endpoint is editor-only, but anyone can reach it through F-01.

**Recommended fix**

- Give `UploadStore` a byte budget (for example 256 MB in total), estimated as the sum of cell string lengths × 2 plus overhead. Evict the oldest entries, or refuse with 503.
- Lower `maxFileBytes` to about 10 MB.
- Enforce `maxColumns` and `maxRows` while parsing: use the csv-parse `on_record` callback and stop at the cap, instead of materialising the whole grid and then calling `grid.map`.
- Parse in a worker thread, as for F-02.

---

## F-06: Low. `TRUST_PROXY=true` lets clients spoof their IP and bypass rate limits

**Affected code:** `apps/server/src/config.ts:52` (boolean only) and `apps/server/src/app.ts:72` (`trustProxy: true` trusts every hop).

**Description**

With `trustProxy: true`, `req.ip` is the left-most `X-Forwarded-For` value, and the client controls that value. Every `@fastify/rate-limit` bucket uses `req.ip`, so a client can bypass the login limit (10 per minute), the import limit (30 per minute) and the global limit (300 per minute).

Severity is Low because the tokens are at least 32 characters, so brute force is impractical if they are random. However, nothing checks that they are random: `'a'.repeat(32)` is accepted. The main real impact is removing the throttle on F-03 and F-05.

Operators are likely to set `TRUST_PROXY=true`. Behind a TLS proxy with `TRUST_PROXY=false`, `req.protocol` is `http`, the Origin check fails, and cookie-authenticated writes are refused (see F-09). Turning on `TRUST_PROXY` is the obvious workaround.

**Proof**

12 login attempts, each with a different `X-Forwarded-For`:

```
TRUST_PROXY=false: 401 ×10, then 429, 429
TRUST_PROXY=true:  401 ×12, never limited
```

**Recommended fix**

Accept a hop count or a list of proxy IPs/CIDRs (`TRUST_PROXY=1`, or `TRUST_PROXY=10.0.0.0/8,127.0.0.1`) and pass it to Fastify. Reject the bare `true` value in production, or map it to `1`. Document this in `.env.example`.

---

## F-07: Low. Auth-disabled mode listens on all interfaces and is open to DNS rebinding

**Affected code:**

- `apps/server/src/config.ts:45`: `HOST` defaults to `0.0.0.0`.
- `apps/server/src/index.ts:17` and `config.ts:43`: `NODE_ENV` defaults to `development`.
- `apps/server/src/auth/plugin.ts:68-73`: `originAllowed` compares the request against the `Host` header.

**Description**

- Without `NODE_ENV=production` and `DASHBOARD_TOKEN`, auth is off. The root `pnpm start` script does not set `NODE_ENV`. The server still listens on every interface, so anyone on the LAN has full access, with only a log warning.
- The CSRF check treats `${protocol}://${Host}` as "own origin". A DNS-rebinding page whose `Host` and `Origin` are both `evil.example:3000` therefore passes the check. A website can then read and write a developer's local, auth-disabled instance.

The Docker image sets `NODE_ENV=production`, so it is not affected.

**Proof**

Auth-disabled app:

```
PUT /api/settings  Host: evil.example:3000  Origin: http://evil.example:3000  -> 200 {"teamName":"rebound"}
PUT /api/settings  Host: localhost:3000     Origin: http://evil.example     -> 403
```

**Recommended fix**

- When `DASHBOARD_TOKEN` is unset, refuse to bind to non-loopback addresses unless an explicit opt-in such as `ALLOW_INSECURE_NO_AUTH=1` is set. In other words, default `HOST` to `127.0.0.1` when there is no token.
- Validate `Host` against an allowlist (`localhost`, `127.0.0.1`, `[::1]`, plus `ALLOWED_ORIGINS` hosts and an optional `PUBLIC_ORIGIN`), and use that value as the server's own origin instead of the `Host` header.

---

## F-08: Info. Sessions cannot be revoked

**Affected code:** `apps/server/src/auth/session.ts` and `apps/server/src/routes/system.ts:43-46`

- Logout only clears the cookie in the browser. A copied cookie stays valid until it expires. The default lifetime is 7 days, and `SESSION_TTL_HOURS` accepts up to 8,760 (1 year).
- Revoking access means rotating `DASHBOARD_TOKEN`/`VIEWER_TOKEN` (the fingerprint binding works, as verified in code) or `SESSION_SECRET`.
- This matches the spec, which calls for stateless sessions.

**Recommendation:** cap the TTL at about 30 days, and document that "rotate the token" is how sessions are revoked.

## F-09: Info. Header and TLS-deployment notes

**Affected code:** `apps/server/src/app.ts:81-100`

- Helmet's default `X-Frame-Options: SAMEORIGIN` is still sent next to CSP `frame-ancestors 'none'`. Modern browsers follow the CSP. For consistency, set `frameguard: { action: 'deny' }`.
- In production the cookie is `Secure` and the CSP includes `upgrade-insecure-requests`. Over plain HTTP, login silently fails.
- Behind a TLS-terminating proxy with `TRUST_PROXY=false`, cookie-authenticated writes get 403 unless `ALLOWED_ORIGINS` is set.
- Document both points. Consider a `PUBLIC_ORIGIN` setting instead of deriving the server's origin from `Host` and the protocol (this also helps F-07).

## F-10: Info. Lookups that can hit the prototype chain

These have a functional effect only; no exploit was found.

- `commit.ts:72`: `req.statusValueMap[raw]` returns `Object.prototype.constructor` when a cell value is `constructor`, which makes that row fail validation.
- `headers.ts:178`: `c.header in out` is true for headers named `constructor` or `toString`, so they never get a suggested mapping.

**Recommendation:** use `Object.hasOwn` or a `Map`.

Fastify's JSON parser rejects `__proto__` (`onProtoPoisoning: 'error'`), and `parseProperties` filters `__proto__`, `constructor` and `prototype`. No pollution path was found.

## F-11: Info. Supply chain and container

- `pnpm audit --prod` reports **no known vulnerabilities**.
- The full audit reports 2 moderate advisories: `minimatch` under `eslint`, dev-only.
- All dependency versions are pinned exactly, the lockfile is committed, and `onlyBuiltDependencies` allows only `better-sqlite3` and `esbuild`.
- The Dockerfile uses `node:22-bookworm-slim` without a digest. **Recommendation:** pin it (`@sha256:…`) for reproducible builds.
- Container setup, verified in the file:
  - multi-stage build;
  - `USER node`, and `/data` owned by `node`;
  - no secrets baked in;
  - `.dockerignore` excludes `.env*`, `*.db*` and `data`;
  - a healthcheck is present;
  - `apps/server/data/dashboard.db` exists locally but is not tracked by git and is excluded from the image.

---

## Checked and found sound

**Tokens and sessions**

- Tokens are compared by SHA-256 hashing both sides, then `timingSafeEqual`, and both roles are always evaluated.
- Session HMAC-SHA256 is compared with `timingSafeEqual` after a length check. The 1 KB size cap, `v`/`role`/`iat`/`exp`/`fp` validation, expiry and future-`iat` rejection all work.
- The token fingerprint binds sessions to the current token, so rotation invalidates them.

**Configuration**

- Production refuses to start without `DASHBOARD_TOKEN`/`SESSION_SECRET` (at least 32 characters).
- `VIEWER_TOKEN` must differ from `DASHBOARD_TOKEN` and requires it to be set.
- Errors from `loadConfig` never echo secret values.

**Cookie and role matrix**

- The cookie has `HttpOnly; SameSite=Strict; Path=/; Max-Age` everywhere, plus `Secure` in production (observed).
- On canonical paths the role matrix matches the spec. Viewers can only reach `/api/health`, `/api/auth/*`, `GET /api/report` and `GET /api/settings`; all other routes return 403. This includes the auto-generated HEAD routes.
- Unknown `/api/*` routes return 401 (or 404 when authenticated).

**CSRF and CORS**

- Cookie-authenticated non-GET requests are refused when Origin and Referer are missing, when Origin is `null`, and when the origin is foreign. A spoofed `X-Forwarded-Host` is not trusted when `TRUST_PROXY=false`. A valid bearer token is exempt; an invalid one gets 401.
- There is no method-override plugin.
- CORS is only registered when `ALLOWED_ORIGINS` is set, and only for exact origins. The dev Vite origin is excluded from CORS.

**Headers**

- The CSP and HSTS are applied to SPA `index.html`, to static assets and to API responses (observed in production mode): `default-src 'self'`, `script-src 'self'`, `frame-ancestors 'none'` and so on.

**Input validation and SQL**

- Every route parses its params, query and body with the shared zod schemas, and unknown keys are stripped.
- The body limit is 1 MB.
- `pageSize` is capped at 200.
- The history matrix allows at most 60 runs and 200 rows; `periodDays` must be one of 7, 30, 90 or 180.
- Bulk ID lists are capped at 1,000, CSV export at 50k rows, PR listing at 1,000, and bug verification filtering at 10k.
- All SQL is built with Drizzle or `sql` template parameters. LIKE patterns are escaped with `ESCAPE '\'`. `sort` and `order` are enums mapped to columns, so there is no dynamic identifier SQL.

**Upload handling**

- Zip entries are streamed with yauzl and never extracted.
- Zip-slip protection works: absolute paths, `..`, backslashes, NUL and drive letters are rejected.
- Entry-count, per-entry and declared-total caps are enforced, with `validateEntrySizes`.
- Only entries matching the basename allowlist are read. Nested zips are ignored, and symlink entries are harmless because nothing is extracted.
- Magic bytes are checked for both zip and xlsx; legacy `.xls` (OLE) is rejected.
- The temporary zip is written to a `mkdtemp` directory (mode 0700) as a 0600 file with a fixed name, and is removed in `finally`, including on errors and aborts.
- Uploaded filenames are never used as filesystem paths.
- Multipart limits match the spec.
- Each JSON file is parsed with `JSON.parse` inside try/catch with a size cap, then validated with a permissive zod schema. Bad files produce warnings.

**Output and stored URLs**

- CSV export neutralises formula injection by prefixing `'` to any cell that starts with `=`, `+`, `-`, `@`, tab or CR. Every column goes through this.
- Stored URLs are validated as http(s) on every write path: `externalUrl`, `ticketUrl`, the bug `url`, `buildUrl` (multipart field and `executor.json`), and spreadsheet `externalUrl`. A spot check of the web app shows `safeHttpUrl`/`ExternalLink` and no `dangerouslySetInnerHTML`.

**Regexes**

- The regexes in `signature.ts`, `normalize.ts` and `headers.ts` (including the dynamic `new RegExp` built from constant synonyms) showed no catastrophic backtracking. Input to `normalizeFailureMessage` is capped at 2,000 characters.

**Errors and logging**

- The central error handler never returns stacks or internal messages for 5xx responses. Zod details are capped at 50.
- pino redacts the authorization and cookie headers, `set-cookie` and `*.token`, and request bodies are not logged.

**Integrations runner (internals of `github.ts` and `jira.ts` excluded)**

- Integration errors pass through `sanitizeError`, which redacts known secrets and token shapes before they are stored or logged.
- The runner runs one sync per integration at a time, with a timeout and abort on shutdown.
- `POST /api/integrations/:name/sync` is editor-only, and the name is an enum.

**Report and dotenv**

- `GET /api/report` returns aggregates only: no note text, messages, traces or author names. Suite and run-group names and the team name are included, which the spec allows.
- `.env` loading uses `process.loadEnvFile`, which does not override existing environment variables, and only runs outside production.

**Not covered**

- The internals of `github.ts` and `jira.ts`: outbound request handling, SSRF exposure of `GITHUB_API_URL`, and the URLs and HTML returned by those APIs.
- Web app code, beyond the spot check above.
- Browser-level confirmation of the `no-cors` variant of F-01.

---

## Remediation (2026-11-04)

All fixes are in `apps/server`, with no contract changes. Regression tests are in `apps/server/test/security.test.ts` (24 tests). I re-ran the reviewer's exploit scripts from `secreview/` against the fixed code. To check the scripts' behaviour I used `buildApp`/`inject`, and for `raw.mjs` I used `dist/index.js` listening on :3998.

**Validation:** `pnpm --filter @ptd/server typecheck`, `test` and `build` all pass, with 126 tests passing and 1 perf test skipped. `pnpm audit --prod` reports no known vulnerabilities.

### F-01: Authentication, role and CSRF bypass (Critical)

**Fix:** Access is now decided from the **matched route**, never from the raw URL.

- `registerRouteAccess()` (`auth/plugin.ts`) is registered as an `onRoute` hook before any route. Every route whose path is under `/api` gets `config.access = 'editor'` unless it declares something else; all other routes (static files) are `'public'`.
- The `onRequest` hook now reads `req.routeOptions.config.access`. The `req.url.startsWith('/api/')` test is removed.
- Unmatched requests go only to the 404 handler.
- The SPA fallback uses `isApiPath()`. It decodes the path, removes repeated slashes, applies `posix.normalize`, compares case-insensitively, and handles absolute-form targets. It never serves `index.html` for anything that resolves to an `/api` path.

**Tests:**
- "F-01 … never returns 2xx for encoded /api variants (anonymous)" and "(viewer)". These cover `/%61pi`, `/ap%69`, `/%61%70%69`, `/api/%74est-cases`, `/API`, `//api`, `/api/./`, `/x/../api`, trailing slash and absolute-form, each with GET, POST and DELETE.
- "rejects absolute-form request targets over a real socket".
- "SPA fallback never treats encoded /api paths as SPA routes".

**Verified:**
- `paths.ts`: `/%61pi/*` returns 401, and anonymous `PUT /%61pi/settings` returns 401. For the viewer, `/%61pi/summary` returns 403.
- `prod.ts`: anonymous `PUT`, cross-site `PUT /%61pi/settings` and `GET /ap%69/…/export.csv` all return 401 or 403.
- `raw.mjs`: the absolute-form target, `/%61pi`, `/ap%69` and `/api/%74est-cases` all return **401**.

### F-02: A 4 KB xlsx crashes the server (High)

**Fix:**
- `parseXlsx` makes one streaming yauzl pass over the archive. `scanSheetXml()` scans each `xl/worksheets/*.xml` in linear time: it walks the bytes with `indexOf`, and regexes only ever run on a single tag of at most 64 KB. It rejects a row index (`<row r>` or the cell reference) above 51,000, a column above 250, and more than 2,000,000 cells in total, all **before** read-excel-file runs.
- Parsing then happens in a `worker_threads` Worker (`xlsxWorker.mjs`) with `maxOldGenerationSizeMb: 512` and a 30-second timeout. If the worker runs out of memory, the request gets a 413 and the server keeps running.

**Tests:**
- "rejects a 4 KB xlsx with a huge row index before parsing (no OOM)"
- "rejects a huge column reference"
- "scanner handles namespaced tags and implicit refs; stays linear on junk"
- "still parses a normal xlsx (worker thread)"

**Verified:** with `xlsx_e2e.ts`, `bomb-rowgap.xlsx` returns **413 `too_many_rows` in 42 ms** (maxRSS 174 MB), and `bomb-colgap.xlsx` returns **413 `too_many_columns` in 58 ms**.

### F-03: Allure zip amplification (Medium)

**Fix:**
- Whole-archive ratio check: the declared bytes of the entries we actually read must stay below 100 × the archive size. Small zips get a floor of 8 MB.
- `maxTotalBytes` is lowered to 512 MB, and each JSON entry is capped at 5 MB (zip entries and individual files).
- Per-result caps:
  - labels and parameters: at most 50 each, values up to 500 characters, 16 KB in total per list;
  - trace: 16 KB.
- Per-import caps: 50,000 results, and an estimated 256 MB of stored data. Both return 413.
- The import rate limit is now **10/min** for `runs/import`, spreadsheet preview and commit.

**Tests:**
- "rejects zips whose read entries expand too much overall"
- "caps stored labels/parameters/trace per result"
- "rejects oversized result JSON and environment.properties"
- "lowers the import rate limit to 10/min"

**Verified:** `zipamp.ts 1800` (a 4 MB zip that expands to 869 MB) now returns **413 "Zip expands too much overall" in 2.6 s**, with a 0 MB DB and 0 MB WAL. The maxRSS reported is mostly the script building its own payload.

### F-04: ReDoS in `parseProperties` (Medium)

**Fix:**
- `parseProperties` now uses `indexOf` and no regex. Lines over 8 KB are skipped, and `environment.properties` itself is capped at 64 KB.
- Audit of the other regexes:
  - Normalizers (status, priority, header `canon`): input is capped at 200 characters before any regex runs.
  - `splitTags`: input capped at 20 KB.
  - `sanitizeError`: input capped at 4 KB.
  - `normalizeFailureMessage`: input was already capped at 2,000 characters.
  - The new xlsx scanner only runs regexes on bounded tags.
  - None of these patterns has nested or overlapping quantifiers.

**Tests:**
- "F-04 … parseProperties"
- "normalizers, signatures, header matching, sanitizer". This one runs six hostile 100 KB inputs and asserts each call takes under **50 ms**.

**Verified:**
- `redos.ts`: about 0 ms at 10k, 20k and 40k (previously 95 ms, 474 ms and 1,766 ms).
- `redos_e2e.ts`: 100 KB properties sent to `/%61pi/runs/import` returns 401 in 29 ms, and health answers after 20 ms. Authenticated parsing is linear.

### F-05: Memory exhaustion through the spreadsheet store (Medium)

**Fix:**
- The spreadsheet file cap is **20 MB**.
- CSV parsing runs in the worker and enforces the row, column and 2M-cell caps **per record** (in csv-parse's `on_record`), so oversized grids are never built.
- `UploadStore` has a **200 MB byte budget**, based on an estimate of retained size. It evicts the oldest entries first and returns 413 for a single upload that is over the budget.

**Tests:**
- "enforces caps while streaming CSV and the 20 MB file cap"
- "upload store enforces a byte budget"

**Verified:**
- `commas.csv` (50 MB) returns 413 at the multipart limit.
- A 19 MB comma file parses in the worker (200, 1.1 s, main thread not blocked).
- A 19 MB wide CSV returns 413 `too_many_cells`.
- `retain.ts` with 19 MB wide uploads: about 1 MB retained after 4 uploads (previously 265 MB per upload).

### F-06: `TRUST_PROXY=true` (Low)

**Fix:**
- `TRUST_PROXY` now accepts `false`, a **hop count** (`1`), or a **comma list of proxy IPs/CIDRs**, and anything else is rejected at startup.
- The bare value `true` is rejected.
- A hop count is passed to Fastify as `(addr, hop) => hop < n`.
- These options are documented in `.env.example`.

**Tests:**
- "TRUST_PROXY accepts hops or IP/CIDR lists, rejects true"
- "rate limits cannot be bypassed with spoofed X-Forwarded-For when trusting one hop"

**Verified:**
- `prod.ts`: with `TRUST_PROXY=false`, spoofed XFF still gets 429.
- `TRUST_PROXY=true` now refuses to start.
- **Note:** with a hop count, the server must only be reachable through the proxy; otherwise use the IP/CIDR list form. With `TRUST_PROXY=1`, a client that connects directly can still choose its rate-limit key.

### F-07: Auth-disabled mode and DNS rebinding (Low)

**Fix:**
- Without `DASHBOARD_TOKEN`, the server **binds to 127.0.0.1 regardless of `HOST`**, and the warning log explains why.
- A Host allowlist covers `localhost`, `127.0.0.1` and `[::1]`, plus the hosts from `ALLOWED_ORIGINS`, `PUBLIC_URL` and `ALLOWED_HOSTS`. It is enforced on every request when auth is disabled, and whenever `PUBLIC_URL` or `ALLOWED_HOSTS` is set. A disallowed Host gets 403 `invalid_host`.
- When `PUBLIC_URL` is set, it is the server's own origin for the CSRF check, instead of the `Host` header.
- The bundled `dist/index.js` now defaults `NODE_ENV` to `production` (a tsup `define`), so the root `pnpm start` refuses to run without tokens instead of silently running with auth disabled.

**Tests:**
- "rejects DNS-rebinding Host headers when auth is disabled"
- "binds loopback when auth is disabled; caps session TTL"
- "PUBLIC_URL defines the own origin and the Host allowlist"

**Verified:**
- `rebind.ts`: the request with matching Host and Origin returns **403 `invalid_host`**.
- `node dist/index.js` without `NODE_ENV` exits with "DASHBOARD_TOKEN is required in production".

### F-08: Sessions cannot be revoked (Info)

**Fix:**
- `SESSION_TTL_HOURS` is capped at **720** (30 days).
- `.env.example` documents revocation: rotate `SESSION_SECRET`, or the token the session was issued for, which is already bound by fingerprint.

**Test:** "binds loopback when auth is disabled; caps session TTL".

### F-09: Header and TLS-deployment gaps (Info)

**Fix:**
- `frameguard: deny`, so the response sends `X-Frame-Options: DENY`, consistent with CSP `frame-ancestors 'none'`.
- `PUBLIC_URL` sets the cookie's `Secure` flag when it is https, and sets the server's own origin behind TLS-terminating proxies. This is documented in `.env.example`.

**Test:** "sends X-Frame-Options: DENY".

**Verified:** `prod.ts` shows `x-frame-options=DENY`.

### F-10: Prototype-chain lookups (Info)

**Fix:**
- The status-word table is now a `Map`.
- The spreadsheet `statusValueMap` lookup uses a `Map`.
- `suggestMapping` uses a `Map`.

**Test:** "prototype-chain keys are plain values" (`constructor` and `toString`).

### F-11: Supply chain (Info)

- `pnpm audit --prod` is still clean.
- The Docker base image is still unpinned. The registry rate-limited the digest lookup (HTTP 429), so the Dockerfile has a `TODO(F-11)` comment with the `docker buildx imagetools inspect` command to get the digest.

---

## Final review (round 2)

- **Date:** 2026-11-04
- **Reviewed:** `ebfd270` plus the uncommitted working tree at review time. That tree included the new `GET /api/results/:id` and `XRAY_BASE_URL`; other QA edits were in progress at the same time.
- **Scope:**
  - Re-verified F-01 and F-02 by attacking the current code.
  - Looked for regressions introduced by the fixes.
  - New scope:
    - `apps/server/src/integrations/**`
    - `apps/web/src/**` and the production bundle
    - an end-to-end test in a real browser
- **Method:**
  - Ran a production build (`pnpm build`).
  - Started `node dist/index.js` with `NODE_ENV=production`, editor and viewer tokens, a temporary `DATA_DIR`, and `HOST=127.0.0.1:3917`, then seeded it.
  - Planted payloads through every write path. Where the server would refuse a value, I wrote it straight into SQLite to simulate a hostile GitHub or Jira response.
  - Drove Chromium with Playwright.
  - Ran the GitHub provider against a loopback mock that plays a malicious PR.
  - The exploit scripts are in the reviewer's scratch directory (`secreview2/`), not in the repo.
- **Product code:** I did not change any product code.

### Summary

| ID | Severity | Title | Status |
|----|----------|-------|--------|
| R2-01 | **Medium** | ReDoS in the PR diff marker regex: anyone who can open a PR can block the server's event loop (400 KB line → 15.3 s stall, quadratic) | Confirmed (end to end against a mock) |
| R2-02 | **Medium** | The F-02 xlsx pre-scan can be bypassed by moving the sheet out of `xl/worksheets/`, and parser workers have no concurrency cap: 9 × 4.9 KB uploads → **5.8 GB RSS** | Confirmed (production server) |
| R2-03 | Low | A malicious PR can link itself to every test case. This inflates the management KPI "in open PR" and puts PR badges on unrelated cases | Confirmed |
| R2-04 | Low | GitHub pagination never ends on empty pages that carry a `rel="next"` link: about 1,900 requests/s until the 15-minute sync budget runs out | Confirmed (requires the configured GitHub host) |
| R2-05 | Info | The login `next=` check is incomplete. Only react-router stops it from becoming an open redirect | Confirmed (not exploitable) |
| R2-06 | Info | CI uploads need the full editor token. There is no ingest-only credential | Design |

There are no Critical or High findings. F-01 and F-02 are fixed (details under "Verified sound").

---

### R2-01: Medium. ReDoS in `MARKER_G` on attacker-controlled PR diffs

**Affected code:**

- `apps/server/src/integrations/prLinks.ts:41`: the pattern, used at `:190-193`.
- `github.ts:315-338`: patches are retained.
- `github.ts:434`: linking runs synchronously on the main thread.

```ts
const MARKER_G = /@(?:allure\.(?:id|testcase|link)|pytest\.mark\.(?:xray|jira))\s*\(([^)]*)\)/g;
```

**Description**

- On a line that holds many marker openings and no `)`, every match attempt scans to the end of the line with `[^)]*` and then fails. The cost is O(n²).
- PR diffs are written by whoever opens the PR. On public repos that includes fork PRs from anyone on the internet, because `GET /pulls?state=open` lists them.
- `linkPullRequest` runs synchronously on the Fastify main thread, so the whole dashboard stops responding: API, UI and health check. This happens on every sync, manual or interval, for as long as the PR is open.
- The 15-minute sync timeout cannot interrupt synchronous regex work.

There is a second, related problem. Patches for every test file of every PR (up to 600 PRs × 300 files, with responses up to 10 MB per page) are kept in `filesByPr` until all PRs have been fetched, instead of being linked and dropped one PR at a time.

**Proof**

Direct timing (`redos.mjs`). `JIRA_KEY_G`, `DEF_TEST_G` and the quote regex in `markerTokens` stayed linear (0–1 ms at 80 KB).

| Payload `'@allure.id('.repeat(…)` | Time |
|---|---|
| 10 KB | 8 ms |
| 20 KB | 38 ms |
| 40 KB | 130 ms |
| 80 KB | 523 ms |

End to end (`gh_e2e.mts`): the real `createGithubProvider` against a loopback mock. PR #7 adds `tests/test_evil.py` with one 400 KB `+@allure.id(@allure.id(…` line.

```
mode=redos lineKB=100  total=1100ms
mode=redos lineKB=400  total=15418ms  maxEventLoopStall=15300ms
```

At this growth rate a 1 MB line would take about 100 s; this is extrapolated, not measured. I could not confirm GitHub's exact per-file `patch` size limit offline. Large single-line diffs are returned in practice, but very large files have their `patch` omitted. Even within that limit, an attacker can repeat the payload across up to 300 files per PR and across several PRs, because the stalls add up.

**Fix**

- Replace the regex with a bounded scan. For each marker prefix found with `indexOf`, look for `)` only within the next 512 characters. Alternatively, use `\(([^)]{0,512})\)`.
- Skip added lines longer than about 4 KB.
- Cap the total patch bytes inspected per PR (about 256 KB) and per sync.
- Link each PR as soon as its files are fetched, then drop its patches.
- Add a regression test asserting that a 1 MB hostile line takes under 50 ms.

---

### R2-02: Medium. F-02 hardening: scanner bypass and unbounded parallel workers

**Affected code:**

- `apps/server/src/import/spreadsheet/parse.ts:85`: only entries matching `^xl/worksheets/[^/]+\.xml$` are scanned.
- `parse.ts:159-185`: one new `Worker` per request with no concurrency limit.
- `parse.ts:31-32`: 512 MB heap and a 30 s timeout per worker.

**Description**

- read-excel-file finds sheets through `xl/_rels/workbook.xml.rels`. A workbook whose relationship says `Target="evil/sheet1.xml"` stores the sheet at `xl/evil/sheet1.xml`. `scanSheetXml` never sees that sheet, so the row-gap bomb from F-02 reaches read-excel-file.
- The library also unzips with a different implementation (`unzipper-esm`) from the yauzl pre-scan, which leaves room for zip parser differentials. I did not test this.
- The worker isolation from F-02 works, so the server does not crash. However, each request starts its own worker that grows to its heap cap and lives for up to 30 s, and the import rate limit (10 per minute per IP) still allows 10 of them at once.
- The endpoint requires editor access, which limits who can do this.

**Proof**

Production server. The files are built by `mkx.py` from `test/fixtures/tracker.xlsx`, are about 4.9 KB each, and add `<row r="60000000">`.

```
plain.xlsx (sheet in xl/worksheets/)  → 413 too_many_rows            0.02 s   (scanner works)
moved.xlsx (sheet in xl/evil/)        → 413 spreadsheet_too_large    6.2 s    (scanner bypassed; worker OOM)
9 × moved.xlsx in parallel (conc.sh)  → 422 ×9 after 30.0 s; server peak RSS 5,776 MB; /api/health still OK
```

In a container with a 2–4 GB memory limit, this gets the process OOM-killed, which is the same outcome as F-02 but needs editor access.

**Fix**

- Scan every `*.xml` entry in the archive, or resolve the relationship targets exactly as read-excel-file does and scan those.
- Reject archives with duplicate entry names.
- Ideally, hand the worker the entries yauzl already extracted instead of letting a second unzipper re-parse the file.
- Add a process-wide semaphore of 1–2 concurrent parser workers. Return 503 or queue when it is full.
- Lower `workerHeapMb` to 256.

---

### R2-03: Low. A malicious PR can claim any test case and skew the "in open PR" KPI

**Affected code:**

- `apps/server/src/integrations/prLinks.ts:183-198`
- `domain/coverage.ts:25-37`

**Description**

- Any open PR whose title, body (up to 65 KB) or diff mentions a case key is linked to that case. There is no cap on links per PR.
- One PR body that lists every key, or a diff that adds `def test_<name>(` for every case, therefore links the PR to every case.
- `computeCoverage().inOpenPr` appears in the Overview and the coverage figures, so it can be inflated to 100%. Every case also shows an "in PR" badge.
- No other data is changed. Links are replaced on each sync, and PR rows are scoped by repo. The attacker's PR also cannot overwrite other repos or cases.

**Proof:** `gh_e2e.mts 1 link`. Starting from 200 `not_automated` cases, one PR whose body lists `PAY-1 … PAY-200` produced `linked: 200` and `inOpenPr: 200`.

**Fix**

- Cap links per PR (for example 25). Above the cap, store none and flag the PR.
- Optionally, count `key_in_body` and `test_name_in_diff` links only for PR authors in an allowlist, or only for PRs from the same repo (not forks).
- Document that this KPI is derived from what PR authors write.

---

### R2-04: Low. GitHub list pagination has no page cap

**Affected code:** `apps/server/src/integrations/github.ts:256-269` and `:321-333`

**Description**

- Both loops stop only on `count >= cap`, and `count` grows only when a page contains items.
- An endpoint that returns `[]` with a `rel="next"` link, including a link pointing back to itself, loops until the sync budget runs out.
- Only the configured `GITHUB_API_URL` can do this (a misbehaving GHES instance or a proxy), not PR authors. The Jira loops are already capped by page count and by remembering which `nextPageToken` values they have seen.

**Proof:** `gh_loop.mts` made 5,825 requests in 3 s before the test aborted it.

**Fix:**

- Cap pages at `ceil(cap / per_page) + 1`.
- Stop on an empty page.
- Stop when a `next` URL has already been seen.

---

### R2-05: Info. Login `next=` validation relies on react-router

**Affected code:** `apps/web/src/pages/Login.tsx:11-15`

**Description**

`safeNext` accepts `/\t/evil.example/`, `/\n/…` and `/\r/…`. The WHATWG URL parser strips tabs and newlines, which turns these into `//evil.example/`.

**Proof (browser, `redir3.cjs`)**

- react-router 8 throws `External navigation is not allowed`, so the user stays on `/login`. No request is sent to `evil.example` and no open redirect happens.
- These values were all safely confined or sent to `/`: `//`, `/\`, `https:`, `javascript:`, `/%2F%2F`, `/.//`, `/../`, `/%5C/`, Unicode slashes, and NUL, VT, FF and NBSP characters.

**Fix**

Resolve the value with `new URL(raw, location.origin)`. Require `u.origin === location.origin`, then navigate to `u.pathname + u.search + u.hash`.

### R2-06: Info. CI holds the editor token

The CI snippet on the Import page uses `DASHBOARD_TOKEN`. CI jobs that run untrusted PR code with access to that secret would leak full editor rights.

**Recommendation:**

- Document that the secret must only be exposed to trusted-branch pipelines.
- Consider a third token scoped to `POST /api/runs/import` only.

---

### Verified sound (round 2)

**F-01 (auth bypass): fixed**

Tested with raw sockets against the production server (`f01.mjs`). Every one of these returned 401 or 404 for an anonymous client:

- `/%61pi/…`, `/ap%69/…`, `/api/%74est-cases`
- absolute-form targets, both plain and encoded
- `/API`, `//api`, `/api//`, `/api/./`, `/x/../api`
- `/api%2f…`, `;x`, `%00`, `\`
- dot-segments through public routes (`/api/health/../test-cases`, `/api/auth/../…`)

The viewer gets 403 on `/%61pi/summary`, on the new `/api/results/1` route, and on `PUT /%61pi/settings`. `/%2561pi/…` gets the SPA shell, with no data.

Route tagging works for routes added after the fix. Every route under `/api` defaults to `editor`, and only these four are relaxed: `/api/health`, `/api/auth/*`, `GET /api/report` and `GET /api/settings`. Tagging also covers the auto-generated HEAD routes. The security and http test suites pass (41 tests).

**F-02 (xlsx OOM): fixed for crash-safety**

The original bomb gets 413 in 20 ms. Bypass files only kill the worker, and the server keeps answering. The residual risk is described in R2-02.

**Host allowlist and PUBLIC_URL**

- `PUBLIC_URL` replaces `Host` as the server's own origin.
- When auth is disabled, the server binds to loopback.
- Unusual Host values such as `a@localhost` parse to an allowed hostname, but a browser cannot send them, so they do not help DNS rebinding.
- Login CSRF (`POST /api/auth/login` with a foreign Origin) gets 403.
- A cookie request with `Origin: null` and no Referer gets 403.

**Outbound HTTP client (`http.ts`)**

- Requests are pinned to the configured origin. Absolute and `//` URLs, `Link: next` values and redirects that leave it are refused (`gh_e2e.mts ssrf` aborts with "refused request to a host other than the configured base URL"). The `Authorization` header is therefore never sent to another host.
- Redirects are capped at 3.
- URLs with embedded credentials are rejected.
- The base URL must be https; http is allowed only for loopback.
- The per-attempt 15 s `AbortSignal` also covers reading the body.
- Bodies are capped at 10 MB after decompression, streamed, and checked against `content-length` first.
- Retry waits are capped at 60 s.
- Error messages contain only the path and a short `message` excerpt, sanitized for known secrets, the Basic auth base64, the Xray JWT and token shapes.
- The new `XRAY_BASE_URL` is restricted to `https://*.xray.cloud.getxray.app`, with no port, path or credentials.

**Data stored from GitHub and Jira**

- The PR `url` is accepted only when it is http(s); a `javascript:` `html_url` fell back to the canonical `https://github.com/{repo}/pull/{n}` (observed).
- The URLs of Jira cases and bugs are built from the configured base URL plus a key checked with `isJiraKey`.
- The bug keys put into JQL `key in (…)` come from `isJiraKey`-checked values, so JQL injection is not possible.
- Titles are capped and rendered as text.
- Repo/PR links are replaced atomically per repo.
- GitHub `GraphQL` and Jira `errorMessages` are stored only as sanitized text.

**Web app: XSS (real browser)**

I planted HTML/JS payloads in every free-text field that reaches the UI:

- test case title, suite, owner, tags and allure full name
- note author and Markdown body (raw `<a>`, `<iframe>`, `javascript:` and `data:` links, reference links, and an external image)
- bug title and assignee
- team name
- run name, branch, commit and run group
- allure test name, message, trace, labels, parameters and `environment.properties`
- spreadsheet header and cell values (shown in the preview)
- PR title, author, branch and reviewers
- integration `last_error`

Through SQLite I also planted `javascript:` values in the PR url, bug url, case `externalUrl` and run `buildUrl`, which the server would otherwise refuse.

Results:

- On all 12 routes, including the Report page with print media, the payloads appeared only as text. Nothing executed, no `img`, `iframe` or `script` element was injected, and no `javascript:`, `data:` or `vbscript:` URL appeared in any `href`, `src`, `action` or `formaction` attribute.
- Neither page showed a `dialog`, made a request to an external host, or reported a CSP violation.
- The server rejects `javascript:`, `JaVaScRiPt:`, leading-space, `data:`, `https:alert(1)`, `http:\\` and `//` URLs on every write path.
- The source contains no `dangerouslySetInnerHTML`, `innerHTML`, `eval` or `new Function`.
- Markdown uses `skipHtml`, `urlTransform` and `safeHttpUrl`, and does not render images.

**CSP compatibility**

- `index.html` contains no inline script. The theme bootstrap is the external `/theme-init.js`.
- The bundle contains no `eval`.
- No CSP violation was reported in the console on any page. `style-src 'unsafe-inline'` is still needed for React `style` attributes. This is acceptable because `script-src 'self'` is strict.

**Bundle secrets**

- There are no source maps.
- The only environment-variable names in `dist` are the documentation strings on the Import and Integrations pages. No values are present, and there are no token-shaped strings, `import.meta.env` or `process.env`.

**Viewer role**

- The UI redirects viewers to `/report`.
- `fetch` calls made by a logged-in viewer from the page all got 403: summary, test cases, export.csv, notes, results, integrations, pull requests, `/%61pi`, and `PUT`/`POST`/`PATCH`/`DELETE` writes, including sync.
- Only `GET /api/report` and `GET /api/settings` returned 200.
- The report payload contains only aggregates and names: team, run groups and suites.

**Session cookie and localStorage**

- The session cookie is `HttpOnly; Secure; SameSite=Strict`.
- `localStorage` holds only the theme, the note author name and the last run group. It holds no tokens.

**Clickjacking**

A cross-origin `<iframe>` loading `/report` is blocked: `chrome-error://`, because of `X-Frame-Options: DENY` and `frame-ancestors 'none'`.

**Regexes reachable from PRs other than R2-01**

`JIRA_KEY_G` (title, body and branch), `DEF_TEST_G`, the quote regex in `markerTokens`, and the glob regexes (from configuration only) are all linear.

**Not covered**

- GitHub's actual per-file `patch` size limits (see R2-01).
- Zip local-header and central-directory differentials between yauzl and `unzipper-esm` (R2-02).
- Deployment over plain HTTP on a non-localhost host. This is F-09: the `Secure` cookie and `upgrade-insecure-requests` assume TLS. Chromium exempts `127.0.0.1`, which is why the end-to-end test works over HTTP.

### Release recommendation

**Ship for the internal deployment**, provided R2-01 is fixed before the GitHub integration is enabled on any repository where people outside the QA team can open PRs. That includes any public repo, because fork PRs are listed.

R2-01 is a small, self-contained change, and it is the only finding that someone without dashboard credentials can trigger. Fix R2-02 (scan every XML entry and add a worker semaphore) in the next patch. Until then, the residual risk is limited to editors, and the process does not crash outright unless the container's memory limit is below about 6 GB. R2-03 to R2-06 can wait for a follow-up.
