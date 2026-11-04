/**
 * Demo data so the UI looks alive:
 *   pnpm --filter @ptd/server seed            (refuses if the DB already has data)
 *   pnpm --filter @ptd/server seed -- --reset (deletes DATA_DIR/dashboard.db first)
 *
 * ~120 cases over 6 suites, 3 run groups (tests/api, tests/ui, smoke) with
 * 15–25 runs each over ~120 days (regressions that get fixed, flaky tests, a
 * slowly-degrading test), notes with triage, ~15 bugs in every verification
 * state, automation PRs in various review states, 120 days of coverage
 * snapshots trending up, and a team goal.
 */
import fs from 'node:fs';
import path from 'node:path';
import { and, desc, eq, lte } from 'drizzle-orm';
import type { ResultStatus } from '@ptd/shared';
import { loadConfig } from '../src/config.js';
import { openDatabase, type Db } from '../src/db/client.js';
import { bugs, coverageSnapshots, notes, runs, testCases } from '../src/db/schema.js';
import { createBug } from '../src/domain/bugs.js';
import { refreshCaseStats } from '../src/domain/caseStats.js';
import { createNote } from '../src/domain/notes.js';
import { replaceRepoPullRequests, type PullRequestUpsert } from '../src/domain/pullRequests.js';
import { putSettings } from '../src/domain/settings.js';
import { AllureBundle, type ParsedResult } from '../src/import/allure/parse.js';
import { importAllureRun } from '../src/import/allure/importRun.js';
import { isoDate } from '../src/util/time.js';

// --- deterministic randomness ---------------------------------------------------
let rngState = 0x2f6e2b1;
function rand(): number {
  rngState |= 0;
  rngState = (rngState + 0x6d2b79f5) | 0;
  let t = Math.imul(rngState ^ (rngState >>> 15), 1 | rngState);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)] as T;
const hex = (n: number) => Array.from({ length: n }, () => Math.floor(rand() * 16).toString(16)).join('');
const uuid = () => `${hex(8)}-${hex(4)}-4${hex(3)}-a${hex(3)}-${hex(12)}`;

const DAY = 86_400_000;
const NOW = Date.now();
const at = (daysAgo: number, hour = 2) => {
  const d = new Date(NOW - daysAgo * DAY);
  d.setUTCHours(hour, Math.floor(rand() * 50), 0, 0);
  return d;
};

// --- setup ---------------------------------------------------------------------
const reset = process.argv.includes('--reset');
const config = loadConfig({ ...process.env, NODE_ENV: process.env.NODE_ENV === 'production' ? 'production' : 'development' });
const dbFile = path.join(config.dataDir, 'dashboard.db');
if (reset) for (const f of [dbFile, `${dbFile}-wal`, `${dbFile}-shm`]) fs.rmSync(f, { force: true });
const handle = openDatabase(config.dataDir);
const db: Db = handle.db;
if (db.select({ id: testCases.id }).from(testCases).limit(1).get()) {
  console.error(`[seed] ${dbFile} already contains data — rerun with --reset to wipe it.`);
  process.exit(1);
}

// --- test cases ----------------------------------------------------------------
type Group = 'tests/api' | 'tests/ui';
interface SuiteDef {
  suite: string;
  group: Group;
  module: string;
  cls: string;
  owner: string;
  names: string[];
}
const SUITES: SuiteDef[] = [
  {
    suite: 'Authentication',
    group: 'tests/api',
    module: 'tests.api.test_auth',
    cls: 'TestAuth',
    owner: 'Priya Natarajan',
    names: ['login_valid_credentials', 'login_wrong_password', 'lockout_after_five_attempts', 'logout_clears_session', 'token_refresh', 'token_expiry', 'password_reset_email', 'password_reset_link_expires', 'mfa_enrollment', 'mfa_challenge', 'sso_saml_login', 'sso_oidc_login', 'remember_me_cookie', 'session_idle_timeout', 'api_key_rotation', 'csrf_token_required', 'login_rate_limited', 'audit_log_on_login', 'disabled_user_cannot_login', 'password_complexity'],
  },
  {
    suite: 'User management',
    group: 'tests/api',
    module: 'tests.api.test_users',
    cls: 'TestUsers',
    owner: 'Marco Rossi',
    names: ['create_user', 'update_profile', 'delete_user', 'invite_by_email', 'bulk_import_csv', 'assign_role', 'revoke_role', 'list_users_paginated', 'search_users', 'deactivate_user', 'reactivate_user', 'avatar_upload', 'email_change_confirmation', 'gdpr_export', 'gdpr_delete', 'team_membership', 'org_transfer', 'user_preferences', 'timezone_setting', 'locale_setting'],
  },
  {
    suite: 'Payments',
    group: 'tests/api',
    module: 'tests.api.test_payments',
    cls: 'TestPayments',
    owner: 'Lena Fischer',
    names: ['charge_card', 'charge_declined_card', 'refund_full', 'refund_partial', '3ds_challenge', 'saved_card_charge', 'paypal_checkout', 'apple_pay', 'currency_rounding', 'invoice_pdf', 'tax_calculation_eu', 'tax_calculation_us', 'webhook_signature', 'webhook_retry', 'idempotency_key', 'subscription_create', 'subscription_cancel', 'proration', 'chargeback_flow', 'payout_report'],
  },
  {
    suite: 'Platform',
    group: 'tests/api',
    module: 'tests.api.test_platform',
    cls: 'TestPlatform',
    owner: 'Sam Okafor',
    names: ['health_endpoint', 'readiness_probe', 'rate_limit_headers', 'request_id_propagation', 'cors_preflight', 'gzip_responses', 'pagination_links', 'error_envelope', 'feature_flags', 'config_reload', 'metrics_endpoint', 'db_migration_idempotent', 'cache_invalidation', 'search_index_rebuild', 'background_jobs', 'retry_policy', 'timeouts', 'openapi_schema', 'deprecation_headers', 'maintenance_mode'],
  },
  {
    suite: 'Checkout',
    group: 'tests/ui',
    module: 'tests.ui.test_checkout',
    cls: 'TestCheckoutPage',
    owner: 'Lena Fischer',
    names: ['add_to_cart', 'remove_from_cart', 'update_quantity', 'apply_coupon', 'expired_coupon_rejected', 'guest_checkout', 'address_autocomplete', 'shipping_options', 'order_summary', 'place_order', 'order_confirmation_email', 'saved_addresses', 'gift_wrap', 'split_shipment', 'cart_persistence', 'mini_cart', 'out_of_stock_warning', 'checkout_accessibility', 'checkout_mobile_layout', 'payment_error_banner'],
  },
  {
    suite: 'Search',
    group: 'tests/ui',
    module: 'tests.ui.test_search',
    cls: 'TestSearchPage',
    owner: 'Marco Rossi',
    names: ['search_by_keyword', 'search_by_sku', 'typo_tolerance', 'facet_filters', 'filters_persist_in_url', 'sort_by_price', 'sort_by_rating', 'empty_state', 'autocomplete_suggestions', 'recent_searches', 'pagination', 'infinite_scroll', 'search_analytics_event', 'synonyms', 'category_landing', 'price_slider', 'availability_filter', 'search_accessibility', 'search_mobile_layout', 'zero_results_recovery'],
  },
];

interface CaseInfo {
  id: number;
  key: string;
  fullName: string;
  suite: SuiteDef;
  automatedDaysAgo: number | null;
  status: 'automated' | 'in_progress' | 'not_automated' | 'not_automatable';
}
const cases: CaseInfo[] = [];
let tcNum = 1000;
const titleOf = (n: string) => n.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
const PRIORITIES = ['P0', 'P1', 'P1', 'P2', 'P2', 'P2', 'P3'] as const;

for (const s of SUITES) {
  s.names.forEach((n, i) => {
    tcNum++;
    // per suite: 13–14 automated, 2 in progress, 3–4 backlog, 1 not automatable
    let status: CaseInfo['status'] = 'automated';
    if (i >= 14) status = i === 19 ? 'not_automatable' : i >= 16 ? 'not_automated' : 'in_progress';
    // ~55% automated 120 days ago, the rest automated progressively since
    const automatedDaysAgo = status === 'automated' ? (i < 8 ? 125 : Math.floor(5 + rand() * 110)) : null;
    const createdDaysAgo = i === 18 ? Math.floor(3 + rand() * 25) : 130; // a few added recently
    const fullName = `${s.module}.${s.cls}#test_${n}`;
    const row = db
      .insert(testCases)
      .values({
        key: `TC-${tcNum}`,
        title: titleOf(n),
        suite: s.suite,
        priority: pick(PRIORITIES),
        automationStatus: status,
        owner: s.owner,
        tags: [s.group === 'tests/ui' ? 'ui' : 'api', ...(i < 4 ? ['smoke'] : []), ...(i % 5 === 0 ? ['regression'] : [])],
        externalUrl: tcNum % 3 === 0 ? `https://acme.atlassian.net/browse/QA-${tcNum}` : null,
        allureFullName: status === 'automated' || status === 'in_progress' ? fullName : null,
        jiraKey: tcNum % 3 === 0 ? `QA-${tcNum}` : null,
        source: 'spreadsheet',
        automatedAt: automatedDaysAgo !== null ? at(automatedDaysAgo, 9).toISOString() : null,
        createdAt: at(createdDaysAgo, 9).toISOString(),
        updatedAt: at(Math.min(createdDaysAgo, automatedDaysAgo ?? createdDaysAgo), 10).toISOString(),
      })
      .returning({ id: testCases.id })
      .get();
    cases.push({ id: row.id, key: `TC-${tcNum}`, fullName, suite: s, automatedDaysAgo, status });
  });
}
const byName = (n: string) => {
  const c = cases.find((x) => x.fullName.endsWith(`#test_${n}`));
  if (!c) throw new Error(`no case ${n}`);
  return c;
};

// --- scenario: what fails when ---------------------------------------------------
const MSG = {
  http500: () => `AssertionError: expected status 201 but got 500 for user ${uuid()}\nassert 500 == 201`,
  declined: () => `AssertionError: payment ${hex(10)} was declined: card_declined (amount=${Math.floor(rand() * 900 + 100)}.00)`,
  timeout: () => `TimeoutError: page.wait_for_selector: Timeout ${Math.floor(rand() * 5 + 25)}000ms exceeded waiting for "[data-test=login-form]"`,
  reset: () => `ConnectionResetError: [Errno 104] Connection reset by peer (host='staging-${Math.floor(rand() * 4)}.internal')`,
  coupon: () => `AssertionError: expected discount 15.00 but got 0.00 for coupon 'SPRING${Math.floor(rand() * 90 + 10)}'`,
  tax: () => `AssertionError: assert ${(rand() * 10 + 10).toFixed(2)} == ${(rand() * 10 + 20).toFixed(2)}  # VAT for DE`,
  db: () => `psycopg2.OperationalError: could not connect to server: Connection refused at 0x${hex(12)}`,
  index: () => `KeyError: 'facets' in response from /api/search?q=${hex(6)}`,
};

interface Rule {
  names: string[];
  group?: Group | 'smoke';
  from: number; // days ago (inclusive)
  to: number; // days ago (inclusive), 0 = still failing
  status: 'failed' | 'broken';
  msg: () => string;
}
const RULES: Rule[] = [
  // fixed product regression (bug verified fixed)
  { names: ['create_user', 'delete_user', 'invite_by_email'], from: 62, to: 50, status: 'failed', msg: MSG.http500 },
  // UI environment outage (no bug)
  { names: ['add_to_cart', 'place_order', 'guest_checkout', 'saved_addresses'], group: 'tests/ui', from: 34, to: 30, status: 'broken', msg: MSG.timeout },
  // staging DB down for one run window
  { names: ['health_endpoint', 'readiness_probe', 'background_jobs'], from: 78, to: 76, status: 'broken', msg: MSG.db },
  // resolved-but-still-failing bug #1 (declined cards)
  { names: ['charge_card', 'saved_card_charge'], from: 14, to: 0, status: 'failed', msg: MSG.declined },
  // resolved-but-still-failing bug #2 (coupon)
  { names: ['apply_coupon'], group: 'tests/ui', from: 20, to: 0, status: 'failed', msg: MSG.coupon },
  // fixed tax regression (bug verified fixed)
  { names: ['tax_calculation_eu', 'invoice_pdf'], from: 45, to: 38, status: 'failed', msg: MSG.tax },
  // open bug, currently failing
  { names: ['facet_filters', 'filters_persist_in_url'], group: 'tests/ui', from: 9, to: 0, status: 'failed', msg: MSG.index },
  // brand-new failure in the latest api run (untriaged)
  { names: ['webhook_retry'], from: 3, to: 0, status: 'failed', msg: () => `AssertionError: expected 3 webhook attempts, got ${Math.floor(rand() * 2) + 1}` },
];
const FLAKY = ['token_refresh', 'sort_by_price', 'cors_preflight'];
const SLOW = 'search_index_rebuild';
const ALWAYS_SKIPPED = 'sso_saml_login';
const SMOKE = ['login_valid_credentials', 'logout_clears_session', 'token_refresh', 'create_user', 'charge_card', 'refund_full', 'health_endpoint', 'readiness_probe', 'rate_limit_headers', 'error_envelope', 'feature_flags', 'metrics_endpoint'];

function outcome(c: CaseInfo, group: Group | 'smoke', daysAgo: number): { status: ResultStatus; message: string | null; durationMs: number } {
  const name = c.fullName.split('#test_')[1] ?? '';
  let durationMs = Math.floor(300 + rand() * (c.suite.group === 'tests/ui' ? 6000 : 1500));
  if (name === SLOW) durationMs = Math.floor(2000 + (120 - daysAgo) * 65 + rand() * 300);
  if (name === ALWAYS_SKIPPED && group !== 'smoke') return { status: 'skipped', message: 'Skipped: SAML IdP not available in CI', durationMs: 1 };
  for (const r of RULES) {
    if (r.group && r.group !== group) continue;
    if (r.names.includes(name) && daysAgo <= r.from && daysAgo >= r.to) return { status: r.status, message: r.msg(), durationMs };
  }
  if (FLAKY.includes(name) && rand() < 0.33) return { status: 'failed', message: MSG.reset(), durationMs };
  if (rand() < 0.004) return { status: 'broken', message: MSG.reset(), durationMs };
  return { status: 'passed', message: null, durationMs };
}

// --- runs --------------------------------------------------------------------------
interface Schedule {
  group: Group | 'smoke';
  every: number;
  start: number;
  name: string;
}
const SCHEDULES: Schedule[] = [
  { group: 'tests/api', every: 5, start: 118, name: 'api nightly' },
  { group: 'tests/ui', every: 6, start: 117, name: 'ui e2e' },
  { group: 'smoke', every: 7, start: 116, name: 'smoke' },
];
let buildNo = 3100;
const runIdsByGroup = new Map<string, number[]>();
const plannedRuns: Array<{ s: Schedule; daysAgo: number }> = [];
for (const s of SCHEDULES) {
  for (let d = s.start; d >= 0; d -= s.every) plannedRuns.push({ s, daysAgo: d });
  if (s.group === 'tests/api') plannedRuns.push({ s, daysAgo: 0 }); // freshest data
}
plannedRuns.sort((a, b) => b.daysAgo - a.daysAgo);

for (const { s, daysAgo } of plannedRuns) {
  const started = at(daysAgo, s.group === 'smoke' ? 6 : 1);
  const members = cases.filter((c) => {
    if (c.automatedDaysAgo === null || c.automatedDaysAgo < daysAgo) return false;
    if (s.group === 'smoke') return SMOKE.some((n) => c.fullName.endsWith(`#test_${n}`));
    return c.suite.group === s.group;
  });
  if (members.length === 0) continue;
  const bundle = new AllureBundle();
  let clock = started.getTime();
  for (const c of members) {
    const o = outcome(c, s.group, daysAgo);
    const result: ParsedResult = {
      file: `${uuid()}-result.json`,
      uuid: uuid(),
      historyId: `${c.fullName}`,
      testCaseId: null,
      fullName: c.fullName,
      name: `test_${c.fullName.split('#test_')[1]}`,
      status: o.status,
      message: o.message,
      trace: o.message ? `Traceback (most recent call last):\n  File "${c.suite.module.replace(/\./g, '/')}.py", line ${Math.floor(rand() * 200 + 20)}, in test\n${o.message}` : null,
      start: clock,
      stop: clock + o.durationMs,
      labels: [
        { name: 'feature', value: c.suite.suite },
        { name: 'framework', value: 'pytest' },
      ],
      parameters: [],
      links: [],
    };
    clock += o.durationMs + 20;
    bundle.results.push(result);
  }
  bundle.environment = { Python: '3.12.4', Environment: 'staging', 'Base.URL': 'https://staging.acme.dev' };
  buildNo++;
  const branch = s.group === 'tests/api' && daysAgo % 25 === 3 ? 'release/2.4' : 'main';
  const res = importAllureRun(
    db,
    bundle,
    {
      name: `${s.name} #${buildNo}`,
      runGroup: s.group,
      branch,
      commit: hex(40),
      buildUrl: `https://github.com/acme/shop/actions/runs/${9_000_000 + buildNo}`,
    },
    new Date(started.getTime() + 45 * 60_000),
  );
  runIdsByGroup.set(s.group, [...(runIdsByGroup.get(s.group) ?? []), res.run.id]);
}

// --- notes (timestamps back-dated after creation) -------------------------------------
function note(
  name: string,
  daysAgo: number,
  author: string,
  body: string,
  triage: Parameters<typeof createNote>[1]['triage'],
  ticketUrl: string | null = null,
) {
  const c = byName(name);
  const n = createNote(db, { testCaseId: c.id, author, body, triage, ticketUrl });
  const ts = at(daysAgo, 11).toISOString();
  db.update(notes).set({ createdAt: ts, updatedAt: ts }).where(eq(notes.id, n.id)).run();
  return n;
}
note('add_to_cart', 33, 'Lena Fischer', 'Staging frontend was down during the deploy window — not a test problem.', 'environment');
note('place_order', 33, 'Lena Fischer', 'Same staging outage as add_to_cart.', 'environment');
note('token_refresh', 20, 'Sam Okafor', 'Connection resets from the staging LB, happens ~1 in 3 runs. Adding retries in the client fixture.', 'flaky');
note('sort_by_price', 12, 'Marco Rossi', 'Flaky ordering when two products have the same price; test needs a deterministic tiebreak.', 'test_bug');
note('cors_preflight', 8, 'Sam Okafor', 'Probably LB again. Watching.', 'flaky');
note('facet_filters', 8, 'Marco Rossi', 'Search API dropped `facets` from the response after the indexer upgrade.', 'product_bug', 'https://acme.atlassian.net/browse/SHOP-311');
note('create_user', 60, 'Priya Natarajan', 'User service returns 500 when the email contains a plus sign.\nRepro: POST /users with a+b@example.com', 'product_bug', 'https://acme.atlassian.net/browse/SHOP-204');
note('update_profile', 90, 'Marco Rossi', 'Converted to API test; UI version removed.', null);
note('webhook_retry', 0.5, 'Lena Fischer', 'Looking into this — retry backoff config changed yesterday?', 'needs_investigation');

// --- bugs ------------------------------------------------------------------------------------
function bug(opts: {
  key: string;
  title: string;
  severity: 'critical' | 'major' | 'minor' | 'trivial';
  status: 'open' | 'in_progress' | 'resolved' | 'closed' | 'wont_fix';
  createdDaysAgo: number;
  resolvedDaysAgo?: number;
  cases: string[];
  assignee?: string;
  fromAutomation?: boolean;
}) {
  const existing = db.select().from(bugs).where(eq(bugs.jiraKey, opts.key)).get();
  const linked = opts.cases.map((n) => byName(n).id);
  const first = byName(opts.cases[0] ?? '');
  const createdIso = at(opts.createdDaysAgo, 12).toISOString();
  const foundIn =
    opts.fromAutomation === false
      ? null
      : (db
          .select({ id: runs.id })
          .from(runs)
          .where(and(eq(runs.runGroup, first.suite.group), lte(runs.sortAt, createdIso)))
          .orderBy(desc(runs.sortAt))
          .limit(1)
          .get()?.id ?? null);
  const id = existing
    ? existing.id
    : createBug(db, {
        title: opts.title,
        jiraKey: opts.key,
        url: `https://acme.atlassian.net/browse/${opts.key}`,
        status: 'open',
        severity: opts.severity,
        assignee: opts.assignee ?? null,
        testCaseIds: linked,
        foundInRunId: foundIn,
        failureSignatures: [],
      }).id;
  db.update(bugs)
    .set({
      title: opts.title,
      status: opts.status,
      severity: opts.severity,
      assignee: opts.assignee ?? null,
      createdAt: createdIso,
      foundInRunId: foundIn,
      foundByAutomation: foundIn !== null,
      updatedAt: at(opts.resolvedDaysAgo ?? opts.createdDaysAgo, 13).toISOString(),
      resolvedAt: opts.resolvedDaysAgo !== undefined ? at(opts.resolvedDaysAgo, 13).toISOString() : null,
    })
    .where(eq(bugs.id, id))
    .run();
}
// verified fixed (fix shipped, later runs pass)
bug({ key: 'SHOP-204', title: 'User service 500s on emails containing "+"', severity: 'major', status: 'closed', createdDaysAgo: 60, resolvedDaysAgo: 52, cases: ['create_user', 'delete_user', 'invite_by_email'], assignee: 'Dev: Ana' });
bug({ key: 'SHOP-221', title: 'EU VAT computed on net instead of gross for DE', severity: 'critical', status: 'resolved', createdDaysAgo: 44, resolvedDaysAgo: 39, cases: ['tax_calculation_eu', 'invoice_pdf'], assignee: 'Dev: Tom' });
bug({ key: 'SHOP-180', title: 'Health endpoint reports OK while DB is down', severity: 'minor', status: 'resolved', createdDaysAgo: 77, resolvedDaysAgo: 70, cases: ['health_endpoint'], assignee: 'Dev: Ana' });
bug({ key: 'SHOP-233', title: 'Refund webhook missing idempotency key', severity: 'major', status: 'closed', createdDaysAgo: 35, resolvedDaysAgo: 28, cases: ['refund_partial', 'refund_full'], fromAutomation: false });
// resolved but still failing
bug({ key: 'SHOP-298', title: 'Saved cards declined after PSP migration', severity: 'critical', status: 'resolved', createdDaysAgo: 13, resolvedDaysAgo: 8, cases: ['charge_card', 'saved_card_charge'], assignee: 'Dev: Tom' });
bug({ key: 'SHOP-276', title: 'Coupon discount not applied for SPRING codes', severity: 'major', status: 'resolved', createdDaysAgo: 19, resolvedDaysAgo: 10, cases: ['apply_coupon'], assignee: 'Dev: Kim' });
// resolved, awaiting a run (group hasn't run since)
bug({ key: 'SHOP-305', title: 'Gift wrap option resets on address change', severity: 'minor', status: 'resolved', createdDaysAgo: 6, resolvedDaysAgo: 0.2, cases: ['add_to_cart'], fromAutomation: false });
// open / in progress
bug({ key: 'SHOP-311', title: 'Search API no longer returns facets', severity: 'critical', status: 'in_progress', createdDaysAgo: 8, cases: ['facet_filters', 'filters_persist_in_url'], assignee: 'Dev: Kim' });
bug({ key: 'SHOP-312', title: 'Webhook retries stop after first attempt', severity: 'major', status: 'open', createdDaysAgo: 1, cases: ['webhook_retry'] });
bug({ key: 'SHOP-290', title: 'Staging LB resets idle connections', severity: 'minor', status: 'in_progress', createdDaysAgo: 22, cases: ['token_refresh', 'cors_preflight'], assignee: 'SRE: Jo', fromAutomation: true });
bug({ key: 'SHOP-301', title: 'Mobile checkout layout overlaps pay button', severity: 'major', status: 'open', createdDaysAgo: 5, cases: ['checkout_mobile_layout'], fromAutomation: false });
bug({ key: 'SHOP-302', title: 'Autocomplete suggestions flicker', severity: 'trivial', status: 'open', createdDaysAgo: 4, cases: ['autocomplete_suggestions'], fromAutomation: false });
bug({ key: 'SHOP-266', title: 'Sorting by price unstable for ties', severity: 'minor', status: 'open', createdDaysAgo: 12, cases: ['sort_by_price'] });
bug({ key: 'SHOP-150', title: 'Legacy XML export truncates names', severity: 'trivial', status: 'wont_fix', createdDaysAgo: 100, resolvedDaysAgo: 95, cases: ['payout_report'], fromAutomation: false });
bug({ key: 'SHOP-310', title: 'Tax rounding off by one cent for JPY', severity: 'minor', status: 'open', createdDaysAgo: 2, cases: ['currency_rounding'], fromAutomation: false });

// --- pull requests ------------------------------------------------------------------------------
const pr = (
  number: number,
  title: string,
  state: PullRequestUpsert['state'],
  review: PullRequestUpsert['reviewState'],
  opts: Partial<PullRequestUpsert> & { createdDaysAgo: number; updatedDaysAgo: number },
): PullRequestUpsert => ({
  number,
  title,
  url: `https://github.com/acme/shop-tests/pull/${number}`,
  state,
  author: opts.author ?? pick(['priya-n', 'mrossi', 'lfischer', 'sokafor']),
  headBranch: opts.headBranch ?? `qa/${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30)}`,
  reviewState: review,
  requestedReviewers: opts.requestedReviewers ?? [],
  unresolvedThreads: opts.unresolvedThreads ?? 0,
  checks: opts.checks ?? 'passing',
  createdAt: at(opts.createdDaysAgo, 14).toISOString(),
  updatedAt: at(opts.updatedDaysAgo, 15).toISOString(),
  mergedAt: state === 'merged' ? at(opts.updatedDaysAgo, 15).toISOString() : null,
});
const backlog = cases.filter((c) => c.status === 'in_progress' || c.status === 'not_automated');
const prs: PullRequestUpsert[] = [
  pr(412, 'Automate MFA enrollment + challenge (QA-1009)', 'open', 'review_required', { createdDaysAgo: 3, updatedDaysAgo: 1, requestedReviewers: ['sokafor'] }),
  pr(415, 'Add API key rotation tests', 'open', 'changes_requested', { createdDaysAgo: 6, updatedDaysAgo: 2, unresolvedThreads: 4, author: 'mrossi' }),
  pr(418, 'Bulk user import via CSV', 'draft', 'none', { createdDaysAgo: 2, updatedDaysAgo: 0.3, checks: 'pending' }),
  pr(420, 'Subscription cancel/proration tests', 'open', 'approved', { createdDaysAgo: 5, updatedDaysAgo: 0.5 }),
  pr(421, 'Chargeback flow e2e', 'open', 'review_required', { createdDaysAgo: 4, updatedDaysAgo: 1, checks: 'failing', requestedReviewers: ['priya-n', 'qa-leads'] }),
  pr(423, 'Search synonyms + category landing', 'open', 'approved', { createdDaysAgo: 3, updatedDaysAgo: 1, unresolvedThreads: 1 }),
  pr(401, 'Automate GDPR export', 'merged', 'approved', { createdDaysAgo: 20, updatedDaysAgo: 12 }),
  pr(395, 'Price slider tests', 'merged', 'approved', { createdDaysAgo: 26, updatedDaysAgo: 21 }),
  pr(390, 'Old: availability filter (superseded)', 'closed', 'none', { createdDaysAgo: 40, updatedDaysAgo: 30 }),
];
const links = prs.flatMap((p, i) => {
  const targets = [backlog[(i * 3) % backlog.length], backlog[(i * 3 + 1) % backlog.length]].filter(Boolean) as CaseInfo[];
  return targets.slice(0, i % 2 === 0 ? 2 : 1).map((c, j) => ({
    prNumber: p.number,
    testCaseId: c.id,
    linkedBy: (['key_in_title', 'marker_in_diff', 'test_name_in_diff', 'key_in_branch'] as const)[(i + j) % 4]!,
  }));
});
replaceRepoPullRequests(db, 'acme/shop-tests', prs, links);

// --- coverage snapshots (reconstructed per day) + settings ---------------------------------
const all = db.select().from(testCases).all();
for (let d = 120; d >= 0; d--) {
  const end = new Date(NOW - d * DAY);
  end.setUTCHours(23, 59, 59, 999);
  const endIso = end.toISOString();
  const existing = all.filter((c) => c.createdAt <= endIso);
  const automated = existing.filter((c) => c.automationStatus === 'automated' && (c.automatedAt ?? '') <= endIso).length;
  const notAutomatable = existing.filter((c) => c.automationStatus === 'not_automatable').length;
  const inProgress = existing.filter(
    (c) => c.automationStatus === 'in_progress' || (c.automationStatus === 'automated' && (c.automatedAt ?? '') > endIso && d < 20),
  ).length;
  const row = { date: isoDate(end), total: existing.length, automated, inProgress, notAutomatable };
  db.insert(coverageSnapshots).values(row).onConflictDoUpdate({ target: coverageSnapshots.date, set: row }).run();
}
putSettings(db, {
  teamName: 'Shop QA',
  goal: { targetRate: 0.8, targetDate: isoDate(new Date(NOW + 90 * DAY)) },
});

refreshCaseStats(db);
const counts = {
  cases: all.length,
  runs: [...runIdsByGroup.values()].reduce((a, b) => a + b.length, 0),
  groups: Object.fromEntries([...runIdsByGroup].map(([g, ids]) => [g, ids.length])),
  bugs: db.select().from(bugs).all().length,
  prs: prs.length,
};
handle.close();
console.log(`[seed] done → ${dbFile}`, counts);
