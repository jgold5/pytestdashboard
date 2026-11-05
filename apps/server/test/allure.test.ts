import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FailureGroup, RunImportResponse, TestCase, TestCaseList, TestResultList } from '@ptd/shared';
import { AllureBundle, parseProperties } from '../src/import/allure/parse.js';
import { dedupeRetries, humanizeModule, linkCandidates, suiteFromResult } from '../src/import/allure/importRun.js';
import { deriveRunGroup } from '../src/import/allure/runGroup.js';
import { failureSignature, normalizeFailureMessage, suggestTriage } from '../src/domain/signature.js';
import { createTestApp, multipart, type TestApp } from './helpers/app.js';
import { importResults } from './helpers/allure.js';

const FIXTURES = path.join(import.meta.dirname, 'fixtures');

describe('failure signatures', () => {
  it('groups messages that differ only by ids, numbers, paths, quotes', () => {
    const a = 'AssertionError: expected status 201 but got 500 for user 4f3a9c1e-2b7d-4e8a-9f61-0c2d3e4f5a6b\nmore';
    const b = 'AssertionError: expected status 201 but got 500 for user 9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
    expect(failureSignature(a)).toBe(failureSignature(b));
    expect(failureSignature(a)).toMatch(/^[0-9a-f]{12}$/);
    expect(normalizeFailureMessage("KeyError: 'user_42' at 0x7f3b2c1d4e50 in /srv/app/x.py")).toBe(
      'keyerror: <str> at <addr> in <path>',
    );
    expect(failureSignature('Timeout after 30s')).toBe(failureSignature('Timeout after 45s'));
    expect(failureSignature('Timeout after 30s')).not.toBe(failureSignature('Connection refused'));
    expect(normalizeFailureMessage('hash deadbeef12 mismatch')).toBe('hash <hex> mismatch');
  });

  const sig = failureSignature;
  const norm = normalizeFailureMessage;

  it('preserves Oracle error codes (ORA/TNS/PLS/SP2) — different codes never group', () => {
    expect(sig('cx_Oracle.DatabaseError: ORA-00942: table or view does not exist')).not.toBe(
      sig('cx_Oracle.DatabaseError: ORA-00001: unique constraint (APP.PK_INVOICE) violated'),
    );
    expect(sig('ORA-12541: TNS:no listener')).not.toBe(sig('ORA-12514: TNS:listener does not currently know of service'));
    expect(norm('TNS-12560: TNS:protocol adapter error')).toBe('tns-12560: tns:protocol adapter error');
    expect(norm('PLS-00201: identifier MY_PKG must be declared')).toBe('pls-00201: identifier my_pkg must be declared');
    expect(norm('SP2-0310: unable to open file "seed_42.sql"')).toBe('sp2-0310: unable to open file <str>');
    expect(sig('PLS-00201: x')).not.toBe(sig('PLS-00302: x'));
    expect(sig('SP2-0310: x')).not.toBe(sig('SP2-0042: x'));
  });

  it('the same Oracle error groups across drivers / wrappers; the ORA line drives the signature', () => {
    const a = 'cx_Oracle.DatabaseError: ORA-12541: TNS:no listener';
    const b = 'oracledb.exceptions.OperationalError: ORA-12541: TNS:no listener';
    const c =
      'org.apache.camel.CamelExecutionException: Exception occurred during execution on the exchange: Exchange[ID-ci-7-41235-1793700000000-0-5]\n' +
      'Caused by: java.sql.SQLRecoverableException: ORA-12541: TNS:no listener';
    const d = 'AssertionError: assert route did not complete\nE   oracledb.exceptions.OperationalError: ORA-12541: TNS:no listener';
    expect(norm(a)).toBe('ora-12541: tns:no listener');
    expect(new Set([sig(a), sig(b), sig(c), sig(d)]).size).toBe(1);
    // object names in quotes still normalize; constraint names (unquoted) are kept
    expect(norm('ORA-01400: cannot insert NULL into ("APP"."INVOICE"."ID")')).toBe('ora-01400: cannot insert null into (<str>.<str>.<str>)');
    expect(sig('ORA-00001: unique constraint (APP.PK_INVOICE) violated')).not.toBe(
      sig('ORA-00001: unique constraint (APP.PK_ORDER) violated'),
    );
    // a code inside a quoted value is kept, the rest of the line is not dropped
    expect(norm("AssertionError: expected 'ORA-00001' got 'ok'")).toBe('assertionerror: expected <str ora-00001> got <str>');
  });

  it('keeps SQLSTATE and HTTP status codes', () => {
    expect(norm('java.sql.SQLException: SQLSTATE[23000] integrity violation')).toBe('sqlexception: sqlstate 23000 integrity violation');
    expect(sig('SQLState: 08006 connection failure')).not.toBe(sig('SQLState: 08001 connection failure'));
    expect(norm('org.apache.camel.http.base.HttpOperationFailedException: HTTP operation failed invoking http://orders:8080/api with statusCode: 503')).toContain(
      'httpoperationfailedexception: http operation failed invoking',
    );
    expect(sig('HttpOperationFailedException: HTTP operation failed with statusCode: 503')).not.toBe(
      sig('HttpOperationFailedException: HTTP operation failed with statusCode: 500'),
    );
    expect(norm('requests.exceptions.HTTPError: 500 Server Error: Internal Server Error for url: x')).toBe(
      'httperror: http 500: internal server error for url: x',
    );
    expect(sig('upstream returned HTTP 502')).not.toBe(sig('upstream returned HTTP 504'));
    expect(norm('HTTP/1.1 404 Not Found')).toBe('http 404 not found');
    // other numbers are still stripped
    expect(sig('expected 3 rows but got 2')).toBe(sig('expected 7 rows but got 5'));
  });

  it('reduces Java/Camel/Python exception classes to the simple class name', () => {
    expect(norm('org.apache.camel.CamelExecutionException: boom')).toBe('camelexecutionexception: boom');
    expect(norm('java.sql.SQLRecoverableException: IO Error: The Network Adapter could not establish the connection')).toBe(
      'sqlrecoverableexception: io error: the network adapter could not establish the connection',
    );
    expect(norm('org.apache.camel.component.jms.JmsException: broker gone')).toBe('jmsexception: broker gone');
    expect(sig('org.apache.camel.CamelExecutionException: boom')).not.toBe(sig('org.apache.camel.NoSuchEndpointException: boom'));
  });

  it('strips Camel exchange ids, message ids, route/endpoint counters and timestamps', () => {
    const ex = (id: string, route: number, ts: string) =>
      `org.apache.camel.CamelExchangeException: Failed delivery on route${route} at ${ts} on the exchange: Exchange[${id}] MessageId: ID:amq-${route}-1700000000000-1:1:1:1:${route}`;
    const a = ex('ID-ci-runner-7-41235-1793700000000-0-5', 12, '2026-11-04T01:02:03.456Z');
    const b = ex('ID-ci-runner-2-39999-1793700099999-3-117', 3, '2026-11-05 22:10:09,001');
    expect(sig(a)).toBe(sig(b));
    expect(norm(a)).toBe(
      'camelexchangeexception: failed delivery on route<n> at <ts> on the exchange: exchange[<exchange-id>] messageid: <msg-id>',
    );
  });

  it('only the first lines are considered (later lines never change the signature)', () => {
    const head = Array.from({ length: 8 }, (_, i) => `AssertionError line ${i}`).join('\n');
    expect(sig(`${head}\nORA-00942: x`)).toBe(sig(`${head}\nORA-00001: y`));
  });
});

describe('suggested triage', () => {
  it('suggests environment for Oracle connectivity / infra codes', () => {
    for (const code of ['12541', '12514', '12170', '03113', '03114', '12537', '01017', '28000', '00018', '00020']) {
      expect(suggestTriage(`oracledb.exceptions.DatabaseError: ORA-${code}: x`), code).toBe('environment');
    }
    expect(suggestTriage('TNS-12560: TNS:protocol adapter error')).toBe('environment');
    expect(
      suggestTriage('org.apache.camel.CamelExecutionException: Exception occurred\nCaused by: java.sql.SQLException: ORA-03113: end-of-file on communication channel'),
    ).toBe('environment');
  });

  it('suggests environment for network / broker failures', () => {
    for (const m of [
      "requests.exceptions.ConnectionError: HTTPConnectionPool(host='orders-api', port=8080): Failed to establish a new connection: [Errno 111] Connection refused",
      'ConnectionResetError: [Errno 104] Connection reset by peer',
      'socket.timeout: timed out',
      'java.net.UnknownHostException: oracle-db.staging.internal',
      'javax.jms.JMSException: Could not connect to broker URL: tcp://amq:61616',
      'org.apache.activemq.artemis.api.core.ActiveMQNotConnectedException: AMQ219007: Cannot connect to server(s)',
      'ActiveMQ transport failed: tcp://amq:61616',
      'org.apache.camel.component.direct.DirectConsumerNotAvailableException: No consumers available on endpoint: direct://invoices',
      'java.sql.SQLRecoverableException: IO Error: The Network Adapter could not establish the connection',
    ]) {
      expect(suggestTriage(m), m).toBe('environment');
    }
  });

  it('returns null for product / test failures', () => {
    for (const m of [
      'oracledb.exceptions.IntegrityError: ORA-00001: unique constraint (APP.PK_INVOICE) violated',
      'cx_Oracle.DatabaseError: ORA-00942: table or view does not exist',
      'AssertionError: assert 3 == 2',
      'HttpOperationFailedException: HTTP operation failed invoking http://x with statusCode: 500',
      'ORA-01400: cannot insert NULL into ("APP"."INVOICE"."ID")',
      null,
      '',
    ]) {
      expect(suggestTriage(m), String(m)).toBeNull();
    }
  });
});

describe('allure parsing', () => {
  it('keeps the latest retry per historyId and counts retries', () => {
    const b = new AllureBundle();
    const base = { historyId: 'h1', fullName: 'tests.a#t', name: 't', labels: [], parameters: [] };
    b.addFile('1-result.json', Buffer.from(JSON.stringify({ ...base, uuid: '1', status: 'failed', start: 1, stop: 10 })));
    b.addFile('2-result.json', Buffer.from(JSON.stringify({ ...base, uuid: '2', status: 'passed', start: 11, stop: 20 })));
    b.addFile('3-result.json', Buffer.from(JSON.stringify({ ...base, uuid: '3', status: 'broken', start: 5, stop: 9 })));
    const d = dedupeRetries(b.results);
    expect(d).toHaveLength(1);
    expect(d[0]?.status).toBe('passed');
    expect(d[0]?.retries).toBe(2);
  });

  it('turns bad files into warnings', () => {
    const b = new AllureBundle();
    b.addFile('x-result.json', Buffer.from('{not json'));
    b.addFile('y-result.json', Buffer.from('[1,2]'));
    b.addFile('z-result.json', Buffer.from('{"status":"passed"}'));
    expect(b.results).toHaveLength(0);
    expect(b.warnings).toHaveLength(3);
    expect(b.skippedFiles).toBe(3);
  });

  it('parses environment.properties safely', () => {
    expect(parseProperties('# c\nA=1\nB : two\n__proto__=x\n!bang\n')).toEqual({ A: '1', B: 'two' });
  });

  it('collects link candidates in precedence order', () => {
    const b = new AllureBundle();
    b.addFile(
      'r-result.json',
      Buffer.from(
        JSON.stringify({
          name: 'n',
          testCaseId: 'tcid',
          labels: [
            { name: 'jira', value: 'QA-9' },
            { name: 'AS_ID', value: '42' },
          ],
          links: [{ name: 'QA-1', type: 'tms' }],
        }),
      ),
    );
    expect(linkCandidates(b.results[0]!)).toEqual(['tcid', '42', 'QA-1', 'QA-9']);
  });

  it('derives run groups from the common test folder', () => {
    const r = (fullName: string | null, labels: Array<{ name: string; value: string }> = []) => ({ fullName, labels });
    expect(deriveRunGroup([r('tests.api.users.test_login#test_ok'), r('tests.api.users.test_x.TestY#test_z')])).toBe(
      'tests/api/users',
    );
    expect(deriveRunGroup([r('tests.api.users.test_login#a'), r('tests.api.orders.test_o#b')])).toBe('tests/api');
    expect(deriveRunGroup([r('tests.api.a.b.c.test_x#t')])).toBe('tests/api/a');
    expect(deriveRunGroup([r('tests/db/invoices/test_merge.py::TestMerge::test_ok')])).toBe('tests/db/invoices');
    expect(deriveRunGroup([r('api.test_a#t'), r('ui.test_b#t')])).toBe('default');
    expect(deriveRunGroup([r(null, [{ name: 'parentSuite', value: 'x' }])])).toBe('default');
    expect(deriveRunGroup([r(null, [{ name: 'package', value: 'tests.smoke.test_a' }])])).toBe('tests/smoke');
  });
});

describe('POST /api/runs/import', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await createTestApp();
  });
  afterEach(async () => t.close());

  it('imports the fixture zip: retries, signatures, environment, executor defaults', async () => {
    const zip = fs.readFileSync(path.join(FIXTURES, 'allure-results.zip'));
    const mp = multipart({ branch: 'main' }, [{ filename: 'allure-results.zip', content: zip, contentType: 'application/zip' }]);
    const res = await t.app.inject({ method: 'POST', url: '/api/runs/import', payload: mp.payload, headers: mp.headers });
    expect(res.statusCode).toBe(201);
    const body = res.json<RunImportResponse>();
    expect(body.run.name).toBe('nightly #482');
    expect(body.run.buildUrl).toBe('https://github.com/acme/camel-routes/actions/runs/123456');
    expect(body.run.runGroup).toBe('tests/routes');
    expect(body.run.environment.Camel).toBe('4.8.1');
    expect(body.run.environment.Python).toBe('3.12.4');
    expect(body.run.counts).toMatchObject({ total: 14, passed: 10, failed: 2, broken: 1, skipped: 1 });
    expect(body.createdTestCases).toBe(13);
    expect(body.skippedFiles).toBe(2); // container + categories
    expect(body.warnings.some((w) => w.includes('auto-detected'))).toBe(true);

    const results = (
      await t.app.inject({ url: `/api/runs/${body.run.id}/results?search=publishes_to_queue` })
    ).json<TestResultList>();
    expect(results.items[0]?.retries).toBe(1);
    expect(results.items[0]?.status).toBe('passed');

    const failures = (await t.app.inject({ url: `/api/runs/${body.run.id}/failures` })).json<FailureGroup[]>();
    // the Camel-wrapped JDBC error and the python oracledb error share ORA-00001
    expect(failures[0]).toMatchObject({
      count: 2,
      status: 'failed',
      suggestedTriage: null,
      sampleMessage: expect.stringMatching(/ORA-00001: unique constraint \(APP\.PK_INVOICE\) violated$/),
    });
    expect(failures[1]).toMatchObject({ count: 1, status: 'broken', suggestedTriage: 'environment' });
    expect(failures).toHaveLength(2);
    const broken = (await t.app.inject({ url: `/api/runs/${body.run.id}/results?status=broken` })).json<TestResultList>();
    expect(broken.items[0]).toMatchObject({ suggestedTriage: 'environment', testCaseKey: expect.stringContaining('test_payment_route') });
  });

  it('links by allureId, jiraKey, allureFullName and key before auto-creating; promotes', async () => {
    const mk = async (body: object) =>
      (await t.app.inject({ method: 'POST', url: '/api/test-cases', payload: body })).json<TestCase>();
    const byAllureId = await mk({ key: 'TC-1', title: 'a', allureId: '1042', automationStatus: 'not_automated' });
    const byJira = await mk({ key: 'TC-2', title: 'b', jiraKey: 'QA-7', automationStatus: 'in_progress' });
    const byFullName = await mk({ key: 'TC-3', title: 'c', allureFullName: 'tests.x#c' });
    const byKey = await mk({ key: 'tests.x#d', title: 'd', automationStatus: 'not_automatable' });

    const out = await importResults(t, [
      { fullName: 'tests.x#a', status: 'passed', labels: [{ name: 'AS_ID', value: '1042' }] },
      { fullName: 'tests.x#b', status: 'failed', message: 'boom', links: [{ name: 'QA-7', type: 'tms' }] },
      { fullName: 'tests.x#c', status: 'passed' },
      { fullName: 'tests.x#d', status: 'passed' },
      { fullName: 'tests.x#e', status: 'passed', labels: [{ name: 'tag', value: 'smoke' }, { name: 'feature', value: 'Feat' }] },
    ]);
    expect(out.createdTestCases).toBe(1);
    expect(out.promotedTestCases).toBe(3); // TC-1/TC-3 not_automated, TC-2 in_progress; not_automatable untouched

    const list = (await t.app.inject({ url: '/api/test-cases?pageSize=200' })).json<TestCaseList>();
    const get = (id: number) => list.items.find((c) => c.id === id)!;
    expect(get(byAllureId.id).lastResult?.status).toBe('passed');
    expect(get(byAllureId.id).automationStatus).toBe('automated');
    expect(get(byJira.id).lastResult?.status).toBe('failed');
    expect(get(byFullName.id).lastResult?.status).toBe('passed');
    expect(get(byKey.id).automationStatus).toBe('not_automatable');
    const created = list.items.find((c) => c.key === 'tests.x#e')!;
    expect(created).toMatchObject({ source: 'allure', automationStatus: 'automated', suite: 'Feat', tags: ['smoke'] });
  });

  it('rejects uploads without results and ignores unknown files', async () => {
    const mp = multipart({}, [{ filename: 'notes.txt', content: 'hi' }]);
    const res = await t.app.inject({ method: 'POST', url: '/api/runs/import', payload: mp.payload, headers: mp.headers });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'no_results' });
  });

  it('validates form fields', async () => {
    const mp = multipart({ buildUrl: 'javascript:alert(1)' }, [
      { filename: '1-result.json', content: JSON.stringify({ name: 'x', status: 'passed' }) },
    ]);
    const res = await t.app.inject({ method: 'POST', url: '/api/runs/import', payload: mp.payload, headers: mp.headers });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'validation_error' });
  });
});

describe('suite names for auto-created cases', () => {
  const res = (labels: Array<{ name: string; value: string }>, fullName: string | null = null) =>
    ({ labels, fullName }) as unknown as Parameters<typeof suiteFromResult>[0];
  it('humanises module-path suites, keeps explicit features', () => {
    expect(suiteFromResult(res([{ name: 'feature', value: 'Checkout' }, { name: 'suite', value: 'test_orders' }]))).toBe('Checkout');
    expect(suiteFromResult(res([{ name: 'suite', value: 'test_orders' }, { name: 'parentSuite', value: 'tests.api' }]))).toBe('Orders');
    expect(suiteFromResult(res([{ name: 'parentSuite', value: 'tests.api' }]))).toBe('Api');
    expect(suiteFromResult(res([], 'tests.api.test_user_profile.TestProfile#test_x'))).toBe('User profile');
    expect(suiteFromResult(res([], 'tests/routes/order_flow_test.py::test_x'))).toBe('Order flow');
    expect(suiteFromResult(res([{ name: 'suite', value: 'Payments API' }]))).toBe('Payments API');
    expect(humanizeModule('test_')).toBe('test_');
  });
});
