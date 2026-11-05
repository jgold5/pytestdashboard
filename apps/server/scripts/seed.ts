/**
 * Demo data so the UI looks alive:
 *   pnpm --filter @ptd/server seed            (refuses if the DB already has data)
 *   pnpm --filter @ptd/server seed -- --reset (deletes DATA_DIR/dashboard.db first)
 *
 * A pytest suite testing Apache Camel integration routes against Oracle:
 * ~120 cases over 6 suites, 3 run groups (tests/routes, tests/db, tests/smoke)
 * with 15–25 runs each over ~120 days — an Oracle listener outage (ORA-12541
 * across a whole run), a real product bug (ORA-00001 on PK_INVOICE), fixed
 * regressions, resolved-but-still-failing bugs, flaky JMS timing, a slowly
 * degrading test — notes with triage, ~15 bugs in every verification state,
 * automation PRs that put cases in every pipeline stage (drafts, in review,
 * ready to merge, merged awaiting a run), 120 days of coverage snapshots
 * trending up, and a team goal.
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
// Same .env lookup as the server (cwd, then repo root) so DATA_DIR matches.
for (const candidate of [path.resolve('.env'), path.resolve('../../.env')]) {
  if (fs.existsSync(candidate)) {
    process.loadEnvFile(candidate);
    break;
  }
}
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
type Group = 'tests/routes' | 'tests/db';
type AnyGroup = Group | 'tests/smoke';
interface SuiteDef {
  suite: string;
  group: Group;
  module: string;
  cls: string;
  owner: string;
  names: string[];
}
// Per suite, by index: 0–13 automated, 14–15 in progress, 16–18 backlog, 19 not automatable.
const SUITES: SuiteDef[] = [
  {
    suite: 'Order routes',
    group: 'tests/routes',
    module: 'tests.routes.test_order_route',
    cls: 'TestOrderRoute',
    owner: 'Priya Natarajan',
    names: ['order_route_publishes_to_queue', 'order_route_sets_correlation_id', 'order_route_idempotent_consumer', 'order_route_rejects_invalid_payload', 'order_route_enriches_from_oracle_lookup', 'order_route_splits_multi_line_orders', 'order_route_aggregates_by_customer', 'order_route_content_based_router', 'order_route_wiretap_audit', 'order_route_transacted_rollback', 'order_route_throttles_bursts', 'order_route_jms_reply_to', 'order_route_sftp_poller', 'order_route_resequencer', 'order_route_header_propagation', 'order_route_large_payload_streaming', 'order_route_xml_schema_validation', 'order_route_priority_queue', 'order_route_graceful_shutdown', 'order_route_xa_transaction'],
  },
  {
    suite: 'Invoice routes',
    group: 'tests/routes',
    module: 'tests.routes.test_invoice_route',
    cls: 'TestInvoiceRoute',
    owner: 'Lena Fischer',
    names: ['invoice_upsert_merge_into_oracle', 'invoice_route_transforms_xml', 'invoice_route_retries_on_timeout', 'invoice_route_currency_rounding', 'invoice_route_tax_lookup', 'invoice_route_multi_currency', 'invoice_route_batch_commit', 'invoice_route_duplicate_detection', 'invoice_route_credit_note', 'invoice_route_partial_payment', 'invoice_route_status_callback', 'invoice_route_numbering_sequence', 'invoice_route_csv_export', 'invoice_route_archive_purge', 'invoice_route_pdf_rendering', 'invoice_route_einvoice_peppol', 'invoice_route_late_fee_job', 'invoice_route_dunning_letters', 'invoice_route_vat_reverse_charge', 'invoice_route_manual_tax_audit'],
  },
  {
    suite: 'Customer sync',
    group: 'tests/routes',
    module: 'tests.routes.test_customer_sync',
    cls: 'TestCustomerSync',
    owner: 'Marco Rossi',
    names: ['customer_sync_paginates', 'customer_sync_handles_429_throttling', 'customer_sync_resumes_after_restart', 'customer_sync_empty_page_ends_route', 'customer_sync_merge_keeps_latest', 'customer_sync_address_normalization', 'customer_sync_delta_since_watermark', 'customer_sync_soft_delete', 'customer_sync_kafka_fanout', 'customer_sync_duplicate_email', 'customer_sync_timezone_conversion', 'customer_sync_unicode_names', 'customer_sync_bulk_upsert', 'customer_sync_metrics', 'customer_sync_gdpr_erasure', 'customer_sync_rest_oauth_refresh', 'customer_sync_schema_drift', 'customer_sync_rate_limit_backoff', 'customer_sync_dormant_customers_report', 'customer_sync_legacy_crm_manual'],
  },
  {
    suite: 'Error handling',
    group: 'tests/routes',
    module: 'tests.routes.test_error_handling',
    cls: 'TestErrorHandling',
    owner: 'Sam Okafor',
    names: ['dead_letter_channel_on_ora_00001', 'redelivery_policy_exponential_backoff', 'poison_message_parked', 'on_exception_marks_handled', 'circuit_breaker_opens_on_db_down', 'dlq_message_carries_exchange_headers', 'error_handler_logs_exchange_id', 'retry_on_ora_00060_deadlock', 'timeout_on_slow_endpoint', 'http_5xx_retried', 'http_4xx_not_retried', 'jms_transaction_redelivery', 'sftp_failure_moves_to_error_dir', 'no_consumers_on_direct_endpoint', 'dead_letter_channel_on_jms_outage', 'compensation_on_partial_failure', 'saga_rollback', 'idempotent_repository_cleanup', 'error_route_alerting', 'chaos_failover_manual'],
  },
  {
    suite: 'Oracle schema & PL/SQL',
    group: 'tests/db',
    module: 'tests.db.test_plsql',
    cls: 'TestPlsql',
    owner: 'Lena Fischer',
    names: ['plsql_pkg_invoice_totals', 'plsql_trigger_audit_columns', 'merge_statement_upsert', 'sequence_no_gaps_under_load', 'materialized_view_refresh', 'partition_pruning_by_month', 'unique_constraint_on_order_ref', 'fk_cascade_on_customer_delete', 'check_constraint_status_values', 'lob_storage_for_payloads', 'scheduler_job_purges_staging', 'synonym_grants_for_app_user', 'plsql_exception_maps_to_error_code', 'timestamp_with_timezone_roundtrip', 'nls_date_format_independent', 'bulk_collect_forall_batch', 'flashback_query_audit', 'index_used_for_lookup', 'db_link_to_reporting', 'rman_restore_drill'],
  },
  {
    suite: 'Data integrity',
    group: 'tests/db',
    module: 'tests.db.test_integrity',
    cls: 'TestIntegrity',
    owner: 'Marco Rossi',
    names: ['order_totals_match_lines', 'invoice_ledger_balances', 'customer_dedup_by_email', 'orphan_rows_none', 'staging_tables_empty_after_run', 'referential_integrity_nightly', 'null_checks_mandatory_columns', 'currency_codes_iso4217', 'row_counts_source_vs_target', 'checksum_matches_source', 'reconciliation_report', 'soft_deleted_hidden_from_views', 'scd2_history_rows', 'cdc_events_complete', 'late_arriving_facts', 'pii_masked_in_reporting', 'retention_policy_applied', 'archive_tables_partitioned', 'encryption_at_rest_columns', 'manual_data_steward_review'],
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
const ACRONYMS: Record<string, string> = { xml: 'XML', jms: 'JMS', sftp: 'SFTP', xa: 'XA', pdf: 'PDF', csv: 'CSV', vat: 'VAT', gdpr: 'GDPR', rest: 'REST', oauth: 'OAuth', plsql: 'PL/SQL', pkg: 'PKG', dlq: 'DLQ', http: 'HTTP', ora: 'ORA', nls: 'NLS', fk: 'FK', lob: 'LOB', scd2: 'SCD2', cdc: 'CDC', pii: 'PII', rman: 'RMAN', iso4217: 'ISO 4217', crm: 'CRM', db: 'DB', peppol: 'PEPPOL', einvoice: 'e-invoice', '5xx': '5xx', '4xx': '4xx' };
const titleOf = (n: string) =>
  n
    .replace(/ora_(\d{5})/g, 'ORA-$1')
    .split('_')
    .map((w) => ACRONYMS[w] ?? w)
    .join(' ')
    .replace(/^./, (c) => c.toUpperCase());
const PRIORITIES = ['P0', 'P1', 'P1', 'P2', 'P2', 'P2', 'P3'] as const;

for (const s of SUITES) {
  s.names.forEach((n, i) => {
    tcNum++;
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
        tags: [s.group === 'tests/db' ? 'oracle' : 'camel', ...(i < 4 ? ['smoke'] : []), ...(i % 5 === 0 ? ['regression'] : [])],
        externalUrl: tcNum % 3 === 0 ? `https://acme.atlassian.net/browse/QA-${tcNum}` : null,
        allureFullName: status === 'automated' || status === 'in_progress' ? fullName : null,
        jiraKey: tcNum % 3 === 0 ? `QA-${tcNum}` : null,
        source: 'spreadsheet',
        automatedAt: automatedDaysAgo !== null ? at(automatedDaysAgo, 9).toISOString() : null,
        automatedVia: automatedDaysAgo !== null ? (i < 8 ? 'spreadsheet' : 'allure') : null,
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
const HOSTS = ['ci-runner-3', 'ci-runner-7', 'ci-runner-11'];
const exchangeId = () => `ID-${pick(HOSTS)}-${Math.floor(30000 + rand() * 30000)}-${1793700000000 + Math.floor(rand() * 9e8)}-0-${Math.floor(rand() * 400)}`;
const camelWrap = (cause: string) =>
  `org.apache.camel.CamelExecutionException: Exception occurred during execution on the exchange: Exchange[${exchangeId()}]\nCaused by: ${cause}`;
const MSG = {
  // real product bug: MERGE on a redelivered exchange violates the invoice PK
  ora00001: () =>
    rand() < 0.5
      ? `oracledb.exceptions.IntegrityError: ORA-00001: unique constraint (APP.PK_INVOICE) violated\nHelp: https://docs.oracle.com/error-help/db/ora-00001/`
      : camelWrap('java.sql.SQLIntegrityConstraintViolationException: ORA-00001: unique constraint (APP.PK_INVOICE) violated'),
  // environment: Oracle listener down
  ora12541: () =>
    pick([
      'oracledb.exceptions.OperationalError: ORA-12541: TNS:no listener',
      'cx_Oracle.DatabaseError: ORA-12541: TNS:no listener',
      camelWrap('java.sql.SQLRecoverableException: Listener refused the connection with the following error: ORA-12541: TNS:no listener'),
    ]),
  ora12514: () =>
    'cx_Oracle.DatabaseError: ORA-12514: TNS:listener does not currently know of service requested in connect descriptor',
  ora01400: () => `oracledb.exceptions.IntegrityError: ORA-01400: cannot insert NULL into ("APP"."CUSTOMER"."EMAIL")`,
  ora00060: () => camelWrap('java.sql.SQLException: ORA-00060: deadlock detected while waiting for resource'),
  ledger: () =>
    `AssertionError: ledger imbalance for batch ${Math.floor(rand() * 9000 + 1000)}: debit ${(rand() * 900 + 100).toFixed(2)} != credit ${(rand() * 900 + 100).toFixed(2)}`,
  jpy: () => `AssertionError: assert Decimal('${Math.floor(rand() * 900 + 100)}.01') == Decimal('${Math.floor(rand() * 900 + 100)}.00')  # PKG_INVOICE.total JPY rounding`,
  http500: () =>
    `org.apache.camel.http.base.HttpOperationFailedException: HTTP operation failed invoking http://orders-api:8080/api/orders/${Math.floor(rand() * 90000)} with statusCode: 500`,
  queue: () =>
    rand() < 0.6
      ? `AssertionError: expected 1 message on queue ORDERS.OUT within 5s, got 0`
      : `org.apache.camel.ExchangeTimedOutException: The OUT message was not received within: 20000 millis. Exchange[${exchangeId()}]`,
  reset: () => `ConnectionResetError: [Errno 104] Connection reset by peer (host='amq-${Math.floor(rand() * 3)}.staging.internal')`,
};

interface Rule {
  names: string[] | 'all';
  group?: AnyGroup;
  from: number; // days ago (inclusive)
  to: number; // days ago (inclusive), 0 = still failing
  status: 'failed' | 'broken';
  msg: () => string;
}
const RULES: Rule[] = [
  // fixed product regression (bug verified fixed): customer sync inserted NULL emails
  { names: ['customer_sync_merge_keeps_latest', 'customer_sync_duplicate_email', 'customer_sync_address_normalization'], from: 62, to: 50, status: 'failed', msg: MSG.ora01400 },
  // environment outage: the Oracle listener was down for one whole routes run
  { names: 'all', group: 'tests/routes', from: 58, to: 58, status: 'broken', msg: MSG.ora12541 },
  // fixed ledger regression (bug verified fixed)
  { names: ['invoice_ledger_balances', 'order_totals_match_lines'], from: 45, to: 38, status: 'failed', msg: MSG.ledger },
  // resolved-but-still-failing bug #1 (JPY rounding)
  { names: ['invoice_route_currency_rounding', 'invoice_route_multi_currency'], from: 14, to: 0, status: 'failed', msg: MSG.jpy },
  // resolved-but-still-failing bug #2 (deadlock)
  { names: ['retry_on_ora_00060_deadlock'], group: 'tests/routes', from: 20, to: 0, status: 'failed', msg: MSG.ora00060 },
  // real product bug, open: ORA-00001 on PK_INVOICE for redelivered exchanges
  { names: ['invoice_upsert_merge_into_oracle', 'dead_letter_channel_on_ora_00001', 'invoice_route_duplicate_detection'], group: 'tests/routes', from: 9, to: 0, status: 'failed', msg: MSG.ora00001 },
  // the reporting DB service is not registered with the listener (latest db run, untriaged)
  { names: ['materialized_view_refresh', 'reconciliation_report', 'row_counts_source_vs_target', 'checksum_matches_source'], group: 'tests/db', from: 3, to: 0, status: 'broken', msg: MSG.ora12514 },
  // brand-new failure in the latest routes run (untriaged)
  { names: ['http_5xx_retried'], group: 'tests/routes', from: 3, to: 0, status: 'failed', msg: MSG.http500 },
];
const FLAKY = ['order_route_resequencer', 'customer_sync_kafka_fanout', 'timeout_on_slow_endpoint'];
const SLOW = 'sequence_no_gaps_under_load';
const ALWAYS_SKIPPED = 'order_route_sftp_poller';
const SMOKE = ['order_route_publishes_to_queue', 'order_route_sets_correlation_id', 'order_route_resequencer', 'invoice_upsert_merge_into_oracle', 'invoice_route_transforms_xml', 'customer_sync_paginates', 'dead_letter_channel_on_ora_00001', 'poison_message_parked', 'plsql_pkg_invoice_totals', 'merge_statement_upsert', 'order_totals_match_lines', 'referential_integrity_nightly'];

function outcome(c: CaseInfo, group: AnyGroup, daysAgo: number): { status: ResultStatus; message: string | null; durationMs: number } {
  const name = c.fullName.split('#test_')[1] ?? '';
  let durationMs = Math.floor(300 + rand() * (c.suite.group === 'tests/db' ? 2500 : 4000));
  if (name === SLOW) durationMs = Math.floor(2000 + (120 - daysAgo) * 65 + rand() * 300);
  if (name === ALWAYS_SKIPPED && group !== 'tests/smoke') return { status: 'skipped', message: 'Skipped: SFTP server not available in CI', durationMs: 1 };
  for (const r of RULES) {
    if (r.group && r.group !== group) continue;
    if ((r.names === 'all' || r.names.includes(name)) && daysAgo <= r.from && daysAgo >= r.to) return { status: r.status, message: r.msg(), durationMs };
  }
  if (FLAKY.includes(name) && rand() < 0.33) return { status: 'failed', message: MSG.queue(), durationMs };
  if (rand() < 0.004) return { status: 'broken', message: MSG.reset(), durationMs };
  return { status: 'passed', message: null, durationMs };
}

// --- runs --------------------------------------------------------------------------
interface Schedule {
  group: AnyGroup;
  every: number;
  start: number;
  name: string;
}
const SCHEDULES: Schedule[] = [
  { group: 'tests/routes', every: 5, start: 118, name: 'routes nightly' },
  { group: 'tests/db', every: 6, start: 117, name: 'db nightly' },
  { group: 'tests/smoke', every: 7, start: 116, name: 'smoke' },
];
let buildNo = 3100;
const runIdsByGroup = new Map<string, number[]>();
const plannedRuns: Array<{ s: Schedule; daysAgo: number }> = [];
for (const s of SCHEDULES) {
  for (let d = s.start; d >= 0; d -= s.every) plannedRuns.push({ s, daysAgo: d });
  if (s.group === 'tests/routes') plannedRuns.push({ s, daysAgo: 0 }); // freshest data
}
plannedRuns.sort((a, b) => b.daysAgo - a.daysAgo);

for (const { s, daysAgo } of plannedRuns) {
  const started = at(daysAgo, s.group === 'tests/smoke' ? 6 : 1);
  const members = cases.filter((c) => {
    if (c.automatedDaysAgo === null || c.automatedDaysAgo < daysAgo) return false;
    if (s.group === 'tests/smoke') return SMOKE.some((n) => c.fullName.endsWith(`#test_${n}`));
    return c.suite.group === s.group;
  });
  if (members.length === 0) continue;
  const bundle = new AllureBundle();
  let clock = started.getTime();
  for (const c of members) {
    const o = outcome(c, s.group, daysAgo);
    const pkg = c.suite.module;
    const result: ParsedResult = {
      file: `${uuid()}-result.json`,
      uuid: uuid(),
      historyId: `${c.fullName}`,
      testCaseId: null,
      fullName: c.fullName,
      name: `test_${c.fullName.split('#test_')[1]}`,
      status: o.status,
      message: o.message,
      trace: o.message
        ? `Traceback (most recent call last):\n  File "${pkg.replace(/\./g, '/')}.py", line ${Math.floor(rand() * 200 + 20)}, in test\n    exchange = route.send(payload)\n${o.message}`
        : null,
      start: clock,
      stop: clock + o.durationMs,
      labels: [
        { name: 'feature', value: c.suite.suite },
        { name: 'framework', value: 'pytest' },
        { name: 'package', value: pkg },
      ],
      parameters: [],
      links: [],
    };
    clock += o.durationMs + 20;
    bundle.results.push(result);
  }
  bundle.environment = {
    Python: '3.12.4',
    'Oracle.DB': '19c (APPDB staging)',
    Camel: '4.8.1',
    'Broker': 'Artemis 2.37',
    Environment: 'staging',
  };
  buildNo++;
  const branch = s.group === 'tests/routes' && daysAgo % 25 === 3 ? 'release/2.4' : 'main';
  const res = importAllureRun(
    db,
    bundle,
    {
      name: `${s.name} #${buildNo}`,
      runGroup: s.group,
      branch,
      commit: hex(40),
      buildUrl: `https://github.com/acme/camel-routes/actions/runs/${9_000_000 + buildNo}`,
    },
    new Date(started.getTime() + 45 * 60_000),
  );
  runIdsByGroup.set(s.group, [...(runIdsByGroup.get(s.group) ?? []), res.run.id]);
}

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
bug({ key: 'INT-204', title: 'Customer sync inserts NULL email (ORA-01400)', severity: 'major', status: 'closed', createdDaysAgo: 60, resolvedDaysAgo: 52, cases: ['customer_sync_merge_keeps_latest', 'customer_sync_duplicate_email', 'customer_sync_address_normalization'], assignee: 'Dev: Ana' });
bug({ key: 'INT-221', title: 'Ledger imbalance from PKG_INVOICE rounding', severity: 'critical', status: 'resolved', createdDaysAgo: 44, resolvedDaysAgo: 39, cases: ['invoice_ledger_balances', 'order_totals_match_lines'], assignee: 'Dev: Tom' });
bug({ key: 'INT-180', title: 'Synonym grants missing after schema migration', severity: 'minor', status: 'resolved', createdDaysAgo: 77, resolvedDaysAgo: 70, cases: ['synonym_grants_for_app_user'], assignee: 'DBA: Ana' });
bug({ key: 'INT-233', title: 'DLQ drops the JMSCorrelationID header', severity: 'major', status: 'closed', createdDaysAgo: 35, resolvedDaysAgo: 28, cases: ['dlq_message_carries_exchange_headers', 'error_handler_logs_exchange_id'], fromAutomation: false });
// resolved but still failing
bug({ key: 'INT-298', title: 'JPY totals off by one unit in PKG_INVOICE.total', severity: 'critical', status: 'resolved', createdDaysAgo: 13, resolvedDaysAgo: 8, cases: ['invoice_route_currency_rounding', 'invoice_route_multi_currency'], assignee: 'Dev: Tom' });
bug({ key: 'INT-276', title: 'Deadlock (ORA-00060) between invoice batch and purge job', severity: 'major', status: 'resolved', createdDaysAgo: 19, resolvedDaysAgo: 10, cases: ['retry_on_ora_00060_deadlock'], assignee: 'DBA: Kim' });
// resolved, awaiting a run (group hasn't run since)
bug({ key: 'INT-305', title: 'Partial payment callback double-posts', severity: 'minor', status: 'resolved', createdDaysAgo: 6, resolvedDaysAgo: 0.2, cases: ['plsql_exception_maps_to_error_code'], fromAutomation: false });
// open / in progress
bug({ key: 'INT-311', title: 'Invoice MERGE violates PK_INVOICE on redelivered exchanges (ORA-00001)', severity: 'critical', status: 'in_progress', createdDaysAgo: 8, cases: ['invoice_upsert_merge_into_oracle', 'dead_letter_channel_on_ora_00001', 'invoice_route_duplicate_detection'], assignee: 'Dev: Kim' });
bug({ key: 'INT-312', title: 'Orders API returns 500 on retried POST', severity: 'major', status: 'open', createdDaysAgo: 1, cases: ['http_5xx_retried'] });
bug({ key: 'INT-290', title: 'Artemis drops idle consumers on staging', severity: 'minor', status: 'in_progress', createdDaysAgo: 22, cases: ['order_route_resequencer', 'customer_sync_kafka_fanout'], assignee: 'SRE: Jo', fromAutomation: true });
bug({ key: 'INT-301', title: 'XA recovery leaves in-doubt transactions', severity: 'major', status: 'open', createdDaysAgo: 5, cases: ['order_route_transacted_rollback'], fromAutomation: false });
bug({ key: 'INT-302', title: 'Route metrics report negative in-flight exchanges', severity: 'trivial', status: 'open', createdDaysAgo: 4, cases: ['customer_sync_metrics'], fromAutomation: false });
bug({ key: 'INT-266', title: 'Slow-endpoint timeout too aggressive', severity: 'minor', status: 'open', createdDaysAgo: 12, cases: ['timeout_on_slow_endpoint'] });
bug({ key: 'INT-150', title: 'Legacy CSV export truncates long names', severity: 'trivial', status: 'wont_fix', createdDaysAgo: 100, resolvedDaysAgo: 95, cases: ['invoice_route_csv_export'], fromAutomation: false });
bug({ key: 'INT-310', title: 'PKG_REPORTS depends on NLS_DATE_FORMAT', severity: 'minor', status: 'open', createdDaysAgo: 2, cases: ['timestamp_with_timezone_roundtrip'], fromAutomation: false });

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
note('order_route_publishes_to_queue', 57, 'Sam Okafor', 'ORA-12541 on every route test: the staging listener was down during the DB patch window. Not a test problem.', 'environment');
note('invoice_route_transforms_xml', 57, 'Sam Okafor', 'Same listener outage (ORA-12541) as the rest of the run.', 'environment');
note('order_route_resequencer', 20, 'Priya Natarajan', 'Artemis drops idle consumers; the resequencer sometimes misses the 5s window. ~1 in 3 runs.', 'flaky');
note('timeout_on_slow_endpoint', 12, 'Sam Okafor', 'Timeout too tight for the stubbed slow endpoint; needs a deterministic clock.', 'test_bug');
note('customer_sync_kafka_fanout', 8, 'Marco Rossi', 'Probably the broker again. Watching.', 'flaky');
note('invoice_upsert_merge_into_oracle', 8, 'Lena Fischer', 'Redelivered exchanges re-run the MERGE without the idempotent repository → ORA-00001 on PK_INVOICE.', 'product_bug', 'https://acme.atlassian.net/browse/INT-311');
note('customer_sync_merge_keeps_latest', 60, 'Marco Rossi', 'CRM sends customers without email; the route maps them to NULL.\nRepro: replay customer 4711 from the CRM sandbox.', 'product_bug', 'https://acme.atlassian.net/browse/INT-204');
note('customer_sync_paginates', 90, 'Marco Rossi', 'Moved from the old SOAP poller to the REST source.', null);
note('http_5xx_retried', 0.5, 'Lena Fischer', 'Orders API 500s on retried POSTs since yesterday — related to the new idempotency header?', 'needs_investigation');

// --- pull requests: every pipeline stage ---------------------------------------------------------
const HOUR = 3_600_000;
const ago = (hours: number) => new Date(NOW - hours * HOUR).toISOString();
const pr = (
  number: number,
  title: string,
  state: PullRequestUpsert['state'],
  review: PullRequestUpsert['reviewState'],
  opts: Partial<PullRequestUpsert> & { createdHoursAgo: number; updatedHoursAgo: number },
): PullRequestUpsert => ({
  number,
  title,
  url: `https://github.com/acme/camel-routes-tests/pull/${number}`,
  state,
  author: opts.author ?? pick(['priya-n', 'mrossi', 'lfischer', 'sokafor']),
  headBranch: opts.headBranch ?? `qa/${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30)}`,
  reviewState: review,
  requestedReviewers: opts.requestedReviewers ?? [],
  unresolvedThreads: opts.unresolvedThreads ?? 0,
  checks: opts.checks ?? 'passing',
  createdAt: ago(opts.createdHoursAgo),
  updatedAt: ago(opts.updatedHoursAgo),
  mergedAt: opts.mergedAt ?? null,
  approvedAt: opts.approvedAt ?? (review === 'approved' ? ago(opts.updatedHoursAgo + 2) : null),
});
// [PR, linked test names]
const PRS: Array<[PullRequestUpsert, string[]]> = [
  // ready to merge — "done, awaiting merge"
  [pr(431, 'Automate header propagation + priority queue', 'open', 'approved', { createdHoursAgo: 120, updatedHoursAgo: 20, approvedAt: ago(26), author: 'priya-n' }), ['order_route_header_propagation', 'order_route_priority_queue']],
  [pr(433, 'PEPPOL e-invoice + late fee job route tests', 'open', 'approved', { createdHoursAgo: 96, updatedHoursAgo: 30, approvedAt: ago(52), author: 'lfischer' }), ['invoice_route_einvoice_peppol', 'invoice_route_late_fee_job']],
  [pr(436, 'GDPR erasure via customer sync (QA-1075)', 'open', 'approved', { createdHoursAgo: 70, updatedHoursAgo: 6, approvedAt: ago(9), author: 'mrossi' }), ['customer_sync_gdpr_erasure']],
  [pr(438, 'BULK COLLECT / FORALL batch + flashback audit', 'open', 'approved', { createdHoursAgo: 150, updatedHoursAgo: 44, approvedAt: ago(98), author: 'lfischer' }), ['bulk_collect_forall_batch', 'flashback_query_audit']],
  [pr(439, 'Late-arriving facts integrity check', 'open', 'approved', { createdHoursAgo: 40, updatedHoursAgo: 3, checks: 'none', approvedAt: ago(4), author: 'mrossi' }), ['late_arriving_facts']],
  // in review — not ready yet
  [pr(440, 'Compensation on partial failure', 'open', 'review_required', { createdHoursAgo: 50, updatedHoursAgo: 18, requestedReviewers: ['priya-n', 'qa-leads'], author: 'sokafor' }), ['compensation_on_partial_failure']],
  [pr(441, 'OAuth token refresh in customer sync', 'open', 'changes_requested', { createdHoursAgo: 140, updatedHoursAgo: 28, unresolvedThreads: 3, author: 'mrossi' }), ['customer_sync_rest_oauth_refresh']],
  [pr(442, 'PII masking checks on reporting views', 'open', 'approved', { createdHoursAgo: 90, updatedHoursAgo: 12, checks: 'failing', author: 'lfischer' }), ['pii_masked_in_reporting']],
  [pr(443, 'Schema drift detection for customer payloads', 'open', 'approved', { createdHoursAgo: 60, updatedHoursAgo: 8, unresolvedThreads: 1, author: 'mrossi' }), ['customer_sync_schema_drift']],
  // drafts
  [pr(445, 'WIP: XML schema validation for orders', 'draft', 'none', { createdHoursAgo: 30, updatedHoursAgo: 5, checks: 'pending', author: 'priya-n' }), ['order_route_xml_schema_validation']],
  [pr(446, 'WIP: dunning letters route', 'draft', 'none', { createdHoursAgo: 20, updatedHoursAgo: 7, checks: 'pending', author: 'lfischer' }), ['invoice_route_dunning_letters']],
  // merged, awaiting the next run of their group (auto-promoted to automated)
  [pr(425, 'Dead letter channel on JMS outage', 'merged', 'approved', { createdHoursAgo: 160, updatedHoursAgo: 3, mergedAt: ago(3), author: 'sokafor' }), ['dead_letter_channel_on_jms_outage']],
  [pr(427, 'Index usage check + saga rollback tests', 'merged', 'approved', { createdHoursAgo: 100, updatedHoursAgo: 26, mergedAt: ago(26), author: 'lfischer' }), ['index_used_for_lookup', 'saga_rollback']],
  // maintenance PR on an already automated (flaky) test: "In PR" badge, stage stays automated
  [pr(447, 'Stabilize resequencer test (flaky)', 'open', 'review_required', { createdHoursAgo: 15, updatedHoursAgo: 4, requestedReviewers: ['sokafor'], author: 'priya-n' }), ['order_route_resequencer']],
  [pr(390, 'Old: SOAP customer poller (superseded)', 'closed', 'none', { createdHoursAgo: 40 * 24, updatedHoursAgo: 30 * 24 }), ['customer_sync_legacy_crm_manual']],
];
// merged earlier and already verified by later runs (automated)
const verified = cases
  .filter((c) => c.automatedDaysAgo !== null && c.automatedDaysAgo >= 6 && c.automatedDaysAgo <= 25)
  .slice(0, 3);
verified.forEach((c, i) => {
  const mergedAt = at(c.automatedDaysAgo!, 8).toISOString();
  PRS.push([
    { ...pr(400 + i, `Automate ${titleOf(c.fullName.split('#test_')[1] ?? '').toLowerCase()}`, 'merged', 'approved', { createdHoursAgo: (c.automatedDaysAgo! + 4) * 24, updatedHoursAgo: c.automatedDaysAgo! * 24 }), mergedAt, updatedAt: mergedAt },
    [c.fullName.split('#test_')[1] ?? ''],
  ]);
});
const prs = PRS.map(([p]) => p);
const linkKinds = ['key_in_title', 'marker_in_diff', 'test_name_in_diff', 'key_in_branch'] as const;
const links = PRS.flatMap(([p, names], i) =>
  names.map((n, j) => ({ prNumber: p.number, testCaseId: byName(n).id, linkedBy: linkKinds[(i + j) % linkKinds.length]! })),
);
const { promoted } = replaceRepoPullRequests(db, 'acme/camel-routes-tests', prs, links);

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
  teamName: 'Integration QA',
  goal: { targetRate: 0.8, targetDate: isoDate(new Date(NOW + 90 * DAY)) },
});

refreshCaseStats(db);
const counts = {
  cases: all.length,
  runs: [...runIdsByGroup.values()].reduce((a, b) => a + b.length, 0),
  groups: Object.fromEntries([...runIdsByGroup].map(([g, ids]) => [g, ids.length])),
  bugs: db.select().from(bugs).all().length,
  prs: prs.length,
  promotedByMerge: promoted,
};
handle.close();
console.log(`[seed] done → ${dbFile}`, counts);
