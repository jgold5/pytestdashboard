import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Trigger, TriggerListResponse, TriggerScanResponse } from '@ptd/shared';
import { parsePropertiesFile, parseEndpoint, resolvePlaceholders, buildPropertyIndex, scanCamelXml, scanPytestFile, scanRepository } from '../src/triggers/scan.js';
import { classify } from '../src/triggers/upload.js';
import { authEnv, createTestApp, multipart, type TestApp } from './helpers/app.js';
import { importResults } from './helpers/allure.js';
import { makeZip } from './helpers/zip.js';

const ROUTES_XML = `<?xml version="1.0" encoding="UTF-8"?>
<beans xmlns="http://www.springframework.org/schema/beans">
  <camelContext id="billing" xmlns="http://camel.apache.org/schema/spring">
    <endpoint id="ordersIn" uri="sftp://{{sftp.host}}/orders?antInclude=ORD_*.xml&amp;delete=true"/>

    <route id="invoice-load">
      <from uri="file:{{invoice.in.dir}}?include={{invoice.pattern}}&amp;move=.done"/>
      <to uri="direct:parseInvoice"/>
    </route>

    <route id="nightly-purge">
      <from uri="quartz://billing/nightlyPurge?cron=0+0+2+*+*+?"/>
      <to uri="bean:purger"/>
    </route>

    <!-- <route id="old-load"><from uri="file:/legacy?include=OLD_.*"/></route> -->

    <route id="statements">
      <from uri="cron:statements?schedule={{statement.cron}}"/>
      <to uri="direct:statements"/>
    </route>

    <route id="orders-load">
      <from ref="ordersIn"/>
      <to uri="direct:orders"/>
    </route>

    <route id="parse-invoice">
      <from uri="direct:parseInvoice"/>
      <log message="&lt;parsing&gt;"/>
    </route>
  </camelContext>
</beans>
`;

const DEV = `# dev
invoice.in.dir=/data/dev/in
invoice.pattern=INV_.*\\\\.csv
statement.cron=0 0 6 * * ?
sftp.host=sftp.dev.example.com
`;
const PROD = `invoice.in.dir = /data/prod/in
invoice.pattern=INV_.*\\\\.csv
statement.cron=0 0 6 * * ?
sftp.host : sftp.example.com
`;

const TESTS_PY = `import allure
import pytest


@allure.label("route", "invoice-load")
@allure.feature("Billing")
def test_invoice_file_is_loaded(camel):
    camel.drop("INV_1.csv")


@pytest.mark.parametrize("route", ["nightly-purge", "statements"])
def test_parametrized_strings_do_not_count(route):
    pass


@allure.feature("Billing")
class TestSchedules:
    @pytest.mark.camel_route(
        "nightlyPurge",
    )
    def test_purge_runs(self):
        pass

    def test_orders(self):
        allure.dynamic.label("trigger", "ORD_20260101.xml")
`;

const repoFiles = {
  xml: [{ path: 'src/main/resources/camel/billing-routes.xml', text: ROUTES_XML }],
  properties: [
    { path: 'properties/dev.properties', text: DEV },
    { path: 'properties/prod.properties', text: PROD },
  ],
  tests: [{ path: 'tests/routes/test_billing.py', text: TESTS_PY }],
};

describe('properties and placeholders', () => {
  it('parses .properties like Java does', () => {
    expect(parsePropertiesFile('a=1\nb : two\nc three\n! comment\nd=multi \\\n  line\ne=x\\=y\\u0041')).toEqual([
      ['a', '1'],
      ['b', 'two'],
      ['c', 'three'],
      ['d', 'multi line'],
      ['e', 'x=yA'],
    ]);
  });

  it('fills in values, keeping per-environment differences visible', () => {
    const props = buildPropertyIndex(repoFiles.properties);
    const r = resolvePlaceholders('file:{{invoice.in.dir}}?include={{invoice.pattern}}&x={{missing:5}}&f=${date:now:yyyyMMdd}', props);
    expect(r.text).toBe('file:{{invoice.in.dir}}?include=INV_.*\\.csv&x=5&f=${date:now:yyyyMMdd}');
    expect(r.firstVariant).toBe('file:/data/dev/in?include=INV_.*\\.csv&x=5&f=${date:now:yyyyMMdd}');
    expect(r.unresolved).toEqual([
      {
        key: 'invoice.in.dir',
        values: [
          { file: 'properties/dev.properties', value: '/data/dev/in' },
          { file: 'properties/prod.properties', value: '/data/prod/in' },
        ],
      },
    ]);
    expect(resolvePlaceholders('file:${load.dir}', props).unresolved).toEqual([{ key: 'load.dir', values: [] }]);
  });

  it('parses endpoint URIs', () => {
    expect(parseEndpoint('quartz://billing/nightlyPurge?cron=0+0+2+*+*+?')).toEqual({
      scheme: 'quartz',
      path: 'billing/nightlyPurge',
      params: { cron: '0 0 2 * * ?' },
    });
    expect(parseEndpoint('file:/in?include=RAW(A+B)')?.params.include).toBe('A+B');
  });
});

describe('Camel XML', () => {
  it('finds route inputs with line numbers, skipping comments', () => {
    const { routes, endpoints } = scanCamelXml('r.xml', ROUTES_XML);
    expect(routes.map((r) => [r.routeId, r.uri ?? `ref:${r.ref}`, r.line])).toEqual([
      ['invoice-load', 'file:{{invoice.in.dir}}?include={{invoice.pattern}}&move=.done', 7],
      ['nightly-purge', 'quartz://billing/nightlyPurge?cron=0+0+2+*+*+?', 12],
      ['statements', 'cron:statements?schedule={{statement.cron}}', 19],
      ['orders-load', 'ref:ordersIn', 24],
      ['parse-invoice', 'direct:parseInvoice', 29],
    ]);
    expect(endpoints.get('ordersIn')).toMatch(/^sftp:/);
  });

  it('handles namespace prefixes and single-quoted attributes', () => {
    const xml = `<camel:routes xmlns:camel="x"><camel:route id='a'><camel:from uri='timer:tick?period=5000'/></camel:route></camel:routes>`;
    expect(scanCamelXml('a.xml', xml).routes).toMatchObject([{ routeId: 'a', uri: 'timer:tick?period=5000', line: 1 }]);
  });
});

describe('pytest labels', () => {
  it('collects decorator strings, class labels and allure.dynamic calls per test', () => {
    const tests = scanPytestFile('tests/routes/test_billing.py', TESTS_PY);
    expect(tests.map((t) => [t.id, t.strings])).toEqual([
      ['tests/routes/test_billing.py::test_invoice_file_is_loaded', ['route', 'invoice-load', 'Billing']],
      ['tests/routes/test_billing.py::test_parametrized_strings_do_not_count', []],
      ['tests/routes/test_billing.py::TestSchedules::test_purge_runs', ['nightlyPurge', 'camel_route', 'Billing']],
      ['tests/routes/test_billing.py::TestSchedules::test_orders', ['Billing', 'trigger', 'ORD_20260101.xml']],
    ]);
  });

  it('only reads test files and skips build output', () => {
    expect(classify('tests/test_a.py')).toBe('tests');
    expect(classify('tests/a_test.py')).toBe('tests');
    expect(classify('tests/conftest.py')).toBeNull();
    expect(classify('src/main/resources/routes.xml')).toBe('xml');
    expect(classify('target/classes/routes.xml')).toBeNull();
    expect(classify('properties/prod.properties')).toBe('properties');
    expect(classify('README.md')).toBeNull();
  });
});

describe('scanRepository', () => {
  it('lists file and schedule triggers and the tests that cover them', () => {
    const out = scanRepository(repoFiles);
    expect(out.otherRoutes).toBe(1); // direct:parseInvoice is not a trigger
    expect(out.testsFound).toBe(4);
    const byId: Record<string, Trigger> = Object.fromEntries(out.triggers.map((t) => [t.routeId, t]));
    expect(Object.keys(byId)).toEqual(['invoice-load', 'nightly-purge', 'statements', 'orders-load']);
    expect(byId['invoice-load']).toMatchObject({
      kind: 'file',
      scheme: 'file',
      directory: '{{invoice.in.dir}}',
      filePattern: 'INV_.*\\.csv',
      line: 7,
      sourceFile: 'src/main/resources/camel/billing-routes.xml',
    });
    expect(byId['nightly-purge']).toMatchObject({ kind: 'schedule', schedule: '0 0 2 * * ?' });
    expect(byId['statements']).toMatchObject({ kind: 'schedule', schedule: '0 0 6 * * ?', unresolved: [] });
    expect(byId['orders-load']).toMatchObject({ kind: 'file', scheme: 'sftp', filePattern: 'ORD_*.xml' });

    const cover = (id: string) => byId[id]!.coveredBy.map((c) => `${c.test.split('::').pop()} via ${c.via}`);
    expect(cover('invoice-load')).toEqual(['test_invoice_file_is_loaded via invoice-load']);
    expect(cover('nightly-purge')).toEqual(['test_purge_runs via nightlyPurge']);
    expect(cover('orders-load')).toEqual(['test_orders via ORD_20260101.xml']);
    expect(cover('statements')).toEqual([]); // only named in a parametrize list
  });

  it('a label that is a file name the route would pick up counts as coverage', () => {
    const out = scanRepository({
      ...repoFiles,
      tests: [{ path: 'tests/test_x.py', text: '@allure.label("file", "INV_20260101.csv")\ndef test_x():\n    pass\n' }],
    });
    expect(out.triggers.find((t) => t.routeId === 'invoice-load')!.coveredBy).toHaveLength(1);
  });

  it('does not run dangerous include patterns', () => {
    const xml = `<routes><route id="r"><from uri="file:/in?include=(a+)+b"/></route></routes>`;
    const tests = [{ path: 'tests/test_x.py', text: `@allure.label("file", "${'a'.repeat(40)}.c")\ndef test_x():\n    pass\n` }];
    const started = Date.now();
    const out = scanRepository({ xml: [{ path: 'r.xml', text: xml }], properties: [], tests });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(out.triggers[0]!.coveredBy).toEqual([]);
  });
});

describe('trigger API', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await createTestApp();
  });
  afterEach(async () => t.close());

  const repoZip = (extraXml = '', extraTest = '') =>
    makeZip([
      { name: 'repo/src/main/resources/camel/billing-routes.xml', data: ROUTES_XML.replace('</camelContext>', `${extraXml}</camelContext>`) },
      { name: 'repo/properties/dev.properties', data: DEV },
      { name: 'repo/properties/prod.properties', data: PROD },
      { name: 'repo/tests/routes/test_billing.py', data: TESTS_PY + extraTest },
      { name: 'repo/target/classes/billing-routes.xml', data: ROUTES_XML },
      { name: 'repo/pom.xml', data: '<project/>' },
      { name: 'repo/README.md', data: '# hi' },
    ]);

  async function scan(branch: string, zip: Buffer, headers: Record<string, string> = {}) {
    const mp = multipart({ branch }, [{ filename: 'repo.zip', content: zip, contentType: 'application/zip' }]);
    return t.app.inject({ method: 'POST', url: '/api/triggers/scan', payload: mp.payload, headers: { ...mp.headers, ...headers } });
  }

  it('stores a scan per branch and compares a PR branch with main', async () => {
    const main = await scan('main', repoZip());
    expect(main.statusCode).toBe(201);
    expect(main.json<TriggerScanResponse>()).toMatchObject({ branch: 'main', total: 4, automated: 3, files: { xml: 2, properties: 2, tests: 1 }, otherRoutes: 1 });

    const newRoute = `<route id="payments-load"><from uri="file:/data/payments?include=PAY_.*\\.csv"/><to uri="direct:pay"/></route>`;
    const newTest = `\n\n@allure.label("route", "payments-load")\ndef test_payment_file_is_loaded():\n    pass\n\n\n@allure.label("route", "statements")\ndef test_statements_run():\n    pass\n`;
    expect((await scan('feature/payments', repoZip(newRoute, newTest))).statusCode).toBe(201);

    const pr = (await t.app.inject({ url: '/api/triggers?branch=feature%2Fpayments&compare=main' })).json<TriggerListResponse>();
    const rows = Object.fromEntries(pr.items.map((r) => [r.routeId, r]));
    expect(rows['payments-load']).toMatchObject({ change: 'added', automatedBefore: false, branches: ['feature/payments'] });
    expect(rows['payments-load']!.coveredBy).toHaveLength(1);
    // newly automated on the branch
    expect(rows['statements']).toMatchObject({ change: 'unchanged', automatedBefore: false });
    expect(rows['statements']!.coveredBy).toHaveLength(1);
    expect(rows['invoice-load']!.branches.sort()).toEqual(['feature/payments', 'main']);

    // all branches merged: the union of triggers
    const all = (await t.app.inject({ url: '/api/triggers' })).json<TriggerListResponse>();
    expect(all.items.map((r) => r.routeId).sort()).toEqual(['invoice-load', 'nightly-purge', 'orders-load', 'payments-load', 'statements']);
    expect(all.branches.map((b) => b.branch)).toEqual(['feature/payments', 'main']);

    // removing the branch's scans drops it from the scope
    expect((await t.app.inject({ method: 'DELETE', url: '/api/triggers/branches/feature%2Fpayments' })).statusCode).toBe(204);
    expect((await t.app.inject({ url: '/api/triggers' })).json<TriggerListResponse>().items).toHaveLength(4);
  });

  it('links covering tests to dashboard test cases by Allure full name', async () => {
    await importResults(t, [{ fullName: 'tests.routes.test_billing#test_invoice_file_is_loaded', status: 'passed' }], { runGroup: 'g' });
    await scan('main', repoZip());
    const res = (await t.app.inject({ url: '/api/triggers?branch=main' })).json<TriggerListResponse>();
    const invoice = res.items.find((r) => r.routeId === 'invoice-load')!;
    expect(invoice.coveredBy[0]!.testCaseId).toBeTypeOf('number');
    expect(res.items.find((r) => r.routeId === 'nightly-purge')!.coveredBy[0]!.testCaseId).toBeNull();
  });

  it('rejects uploads without route XML and unknown branches', async () => {
    const res = await scan('main', makeZip([{ name: 'README.md', data: 'x' }]));
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('no_routes');
    expect((await t.app.inject({ url: '/api/triggers?branch=nope' })).statusCode).toBe(400);
  });
});

describe('trigger API auth', () => {
  const INGEST_TOKEN = 'ingest-token-0123456789abcdef0123456789';
  let t: TestApp;
  beforeEach(async () => {
    t = await createTestApp(authEnv({ INGEST_TOKEN }));
  });
  afterEach(async () => t.close());

  it('CI may upload scans with the ingest token but not read them', async () => {
    const mp = multipart({ branch: 'main' }, [{ field: 'file:camel', filename: 'r.xml', content: ROUTES_XML }]);
    const ingest = { authorization: `Bearer ${INGEST_TOKEN}` };
    const up = await t.app.inject({ method: 'POST', url: '/api/triggers/scan', payload: mp.payload, headers: { ...mp.headers, ...ingest } });
    expect(up.statusCode).toBe(201);
    expect(up.json<TriggerScanResponse>().total).toBe(4);
    expect((await t.app.inject({ url: '/api/triggers', headers: ingest })).statusCode).toBe(403);
  });
});
