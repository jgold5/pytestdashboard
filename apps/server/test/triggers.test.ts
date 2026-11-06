import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PrScanStatus, Trigger, TriggerListResponse, TriggerScanResponse } from '@ptd/shared';
import { normalizeCondition, parseFileCondition, parsePropertiesFile, parseEndpoint, resolvePlaceholders, buildPropertyIndex, scanCamelXml, scanPytestFile, scanRepository } from '../src/triggers/scan.js';
import { classify } from '../src/triggers/upload.js';
import { authEnv, createTestApp, multipart, type TestApp } from './helpers/app.js';
import { importResults } from './helpers/allure.js';
import { makeZip } from './helpers/zip.js';
import { startMockServer, type MockServer } from './helpers/mockServer.js';
import { triggerScans } from '../src/db/schema.js';

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
def test_parametrized_routes(route):
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
    expect(routes.map((r) => [r.routeId, r.inputs[0]!.uri ?? `ref:${r.inputs[0]!.ref}`, r.inputs[0]!.line])).toEqual([
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
    expect(scanCamelXml('a.xml', xml).routes).toMatchObject([{ routeId: 'a', inputs: [{ uri: 'timer:tick?period=5000', line: 1 }] }]);
  });
});

describe('pytest labels', () => {
  it('collects decorator strings, class labels and allure.dynamic calls per test', () => {
    const tests = scanPytestFile('tests/routes/test_billing.py', TESTS_PY);
    expect(tests.map((t) => [t.id, t.strings])).toEqual([
      ['tests/routes/test_billing.py::test_invoice_file_is_loaded', ['route', 'invoice-load', 'Billing', 'INV_1.csv']],
      // a parametrize list of route ids says which routes the test covers
      ['tests/routes/test_billing.py::test_parametrized_routes', ['route', 'nightly-purge', 'statements']],
      ['tests/routes/test_billing.py::TestSchedules::test_purge_runs', ['nightlyPurge', 'camel_route', 'Billing']],
      ['tests/routes/test_billing.py::TestSchedules::test_orders', ['Billing', 'trigger', 'ORD_20260101.xml']],
    ]);
  });

  it('only reads test files and skips build output', () => {
    expect(classify('tests/test_a.py')).toBe('tests');
    expect(classify('tests/a_test.py')).toBe('tests');
    // any .py can hold tests (files run by path, python_files); only def test… functions are read
    expect(classify('src/route_test/invoice_checks.py')).toBe('tests');
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
    expect(cover('nightly-purge')).toEqual(['test_parametrized_routes via nightly-purge', 'test_purge_runs via nightlyPurge']);
    expect(cover('orders-load')).toEqual(['test_orders via ORD_20260101.xml']);
    expect(cover('statements')).toEqual(['test_parametrized_routes via statements']);
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

describe('repo layout seen in practice', () => {
  it('reads module-level and class-level pytestmark markers, and body strings', () => {
    const src = [
      'import pytest',
      '',
      'pytestmark = [pytest.mark.billing, pytest.mark.route("invoice-load")]',
      '',
      '',
      'class TestJobs:',
      '    pytestmark = pytest.mark.nightly',
      '',
      '    def test_purge(self):',
      '        drop_trigger_file("OSCAR150")',
      '',
      '',
      'def test_other():',
      '    assert run_route("orders-load") == "ok"',
      '    log("a long message\\nover two lines")',
      '',
    ].join('\n');
    const tests = scanPytestFile('tests/test_jobs.py', src);
    expect(tests.map((t) => [t.name, t.strings])).toEqual([
      ['test_purge', ['nightly', 'OSCAR150', 'billing', 'route', 'invoice-load']],
      ['test_other', ['orders-load', 'ok', 'billing', 'route', 'invoice-load']],
    ]);
  });

  it('resolves properties per module, scopes route ids per module, and matches trigger files', () => {
    const route = (id: string, dir: string) =>
      `<routes><route id="${id}"><from uri="file:{{inbound}}/${dir}?fileName={{${id}.file}}&amp;doneFileName={{${id}.trigger.name}}"/></route></routes>`;
    const out = scanRepository({
      xml: [
        { path: 'src/main/resources/east/routes/a.xml', text: route('load', 'east') },
        { path: 'src/main/resources/west/routes/a.xml', text: route('load', 'west') },
        {
          path: 'src/main/resources/west/routes/b.xml',
          text: '<routes><route id="tick"><from uri="timer://t?period=5m"/></route><route id="once"><from uri="quartz2://g?trigger.repeatCount=0"/></route></routes>',
        },
      ],
      properties: [
        { path: 'src/main/resources/application.properties', text: 'inbound=/data/in\n' },
        { path: 'src/main/resources/east/config/application-east.properties', text: 'load.file=EAST.TXT\nload.trigger.name=EAST_GO\n' },
        { path: 'src/main/resources/west/config/application-west.properties', text: 'load.file=WEST.TXT\nload.trigger.name=WEST_GO\n' },
      ],
      tests: [{ path: 'tests/test_x.py', text: 'def test_west():\n    drop("WEST_GO")\n' }],
    });
    expect(out.warnings).toEqual([]);
    expect(out.triggers.map((t) => [t.key, t.module, t.directory, t.filePattern, t.doneFile, t.unresolved.length, t.coveredBy.length])).toEqual([
      ['east/load', 'east', '/data/in/east', 'EAST.TXT', 'EAST_GO', 0, 0],
      ['west/load', 'west', '/data/in/west', 'WEST.TXT', 'WEST_GO', 0, 1],
      ['west/tick', 'west', null, null, null, 0, 0],
      ['west/once', 'west', null, null, null, 0, 0],
    ]);
    expect(out.triggers.slice(2).map((t) => t.schedule)).toEqual(['every 5m', 'once, at start-up']);
  });
});

describe('matching only when a pattern names something specific', () => {
  it('rewrites Java-style calls and ${properties:…} into simple-language conditions', () => {
    expect(normalizeCondition('${header.CamelFileName.toUpperCase().endsWith(".GZ")}')).toBe("${header.CamelFileName} ends with '.GZ'");
    expect(normalizeCondition("${in.header.CamelFileName.substring(9,16)} contains '0003_26'")).toBe("${in.header.CamelFileName} contains '0003_26'");
    expect(normalizeCondition("${file:name.substring(0,3)} == 'INV'")).toBe("${file:name} contains 'INV'");
    expect(normalizeCondition('${header.CamelFileName} == ${properties:invoice.name}')).toBe("${header.CamelFileName} == '{{invoice.name}}'");
    expect(parseFileCondition('${header.CamelFileName.toUpperCase().startsWith("INV_")}')?.display).toBe('INV_*');
  });

  it('a condition naming a property is filled in from the properties files', () => {
    const out = scanRepository({
      xml: [{ path: 'r.xml', text: `<routes><route id="inbox"><from uri="file:/in"/><choice><when><simple>\${header.CamelFileName} == \${properties:inv.name}</simple><to uri="direct:inv"/></when></choice></route></routes>` }],
      properties: [{ path: 'a.properties', text: 'inv.name=INV_DAILY.csv\n' }],
      tests: [{ path: 'tests/test_a.py', text: 'def test_a():\n    drop("INV_DAILY.csv")\n' }],
    });
    expect(out.triggers.map((t) => [t.filePattern, t.coveredBy.length])).toEqual([['INV_DAILY.csv', 1]]);
  });

  it('broad patterns and negations never link a test by file name', () => {
    const xml = `<routes>
      <route id="all"><from uri="file:/a?include=.*"/></route>
      <route id="inbox"><from uri="file:/b"/><choice>
        <when><simple>\${file:name} != 'SKIP.TXT'</simple><to uri="direct:x"/></when>
        <when><simple>\${file:name} contains 'sp'</simple><to uri="direct:y"/></when>
      </choice></route>
      <route id="real"><from uri="file:/c?include=ORD_.*\\.xml"/></route>
    </routes>`;
    const tests = [{ path: 'tests/test_a.py', text: 'def test_a():\n    read("ds.properties")\n    read("spring.datasource.url")\n    drop("ORD_1.xml")\n' }];
    const out = scanRepository({ xml: [{ path: 'r.xml', text: xml }], properties: [], tests });
    expect(out.triggers.map((t) => [t.routeId, t.filePattern, t.coveredBy.map((c) => c.via)])).toEqual([
      ['all', '.*', []],
      ['inbox', 'not SKIP.TXT', []],
      ['inbox', '*sp*', []],
      ['real', 'ORD_.*\\.xml', ['ORD_1.xml']],
    ]);
  });
});

describe('several triggers in one route', () => {
  const scan = (xml: string, tests = '') =>
    scanRepository({ xml: [{ path: 'r.xml', text: xml }], properties: [], tests: tests ? [{ path: 'tests/test_r.py', text: tests }] : [] });

  it('one trigger per <from> when a route has several inputs', () => {
    const out = scan(`<routes><route id="inbox">
      <from uri="file:/in/invoices?include=INV_.*"/>
      <from uri="quartz://jobs/inboxSweep?cron=0+0+*+*+*+?"/>
      <to uri="direct:x"/></route></routes>`);
    expect(out.triggers.map((t) => [t.key, t.kind, t.input])).toEqual([
      ['inbox#1', 'file', 1],
      ['inbox#2', 'schedule', 2],
    ]);
    expect(out.warnings).toEqual([]);
  });

  it('one trigger per file pattern when include/antInclude lists several', () => {
    const out = scan(
      `<routes>
        <route id="billing-load"><from uri="file:/in?include=(INV|CRN|PAY)_.*\\.csv"/></route>
        <route id="orders-load"><from uri="file:/in/orders?antInclude=ORD_*.xml, RET_*.xml"/></route>
        <route id="plain"><from uri="file:/in/x?include=RAW(X_(\\d+)\\.csv)"/></route>
      </routes>`,
      `@allure.label("file", "CRN_20260101.csv")\ndef test_credit():\n    pass\n\n@allure.label("route", "orders-load")\ndef test_orders():\n    pass\n`,
    );
    expect(out.triggers.map((t) => [t.key, t.filePattern, t.coveredBy.length])).toEqual([
      ['billing-load::INV_.*\\.csv', 'INV_.*\\.csv', 0],
      ['billing-load::CRN_.*\\.csv', 'CRN_.*\\.csv', 1],
      ['billing-load::PAY_.*\\.csv', 'PAY_.*\\.csv', 0],
      // a label naming the route covers each of its patterns
      ['orders-load::ORD_*.xml', 'ORD_*.xml', 1],
      ['orders-load::RET_*.xml', 'RET_*.xml', 1],
      ['plain', 'X_(\\d+)\\.csv', 0],
    ]);
  });

  it('one trigger per <when>/<filter> on the file name, with the job it goes to', () => {
    const xml = `<routes><route id="inbox">
      <from uri="file:/data/in"/>
      <choice>
        <when><simple>\${file:name} starts with 'INV_' &amp;&amp; \${file:name} ends with '.csv'</simple>
          <to uri="direct:invoiceJob"/></when>
        <when><simple>\${header.CamelFileName} regex 'CRN_\\d{8}\\.csv'</simple>
          <to uri="direct:creditJob"/><to uri="log:x"/></when>
        <when><simple><![CDATA[\${file:onlyname.noext} in 'PAY_DAILY,PAY_WEEKLY']]></simple>
          <to uri="direct:paymentJob"/></when>
        <when><simple>\${header.type} == 'urgent'</simple><to uri="direct:urgent"/></when>
        <otherwise><to uri="direct:unknownFile"/></otherwise>
      </choice></route>
      <route id="ext-filter"><from uri="file:/data/ext"/><filter><simple>\${file:ext} == 'xml'</simple><to uri="direct:xmlJob"/></filter></route>
      </routes>`;
    const tests = `@allure.label("job", "creditJob")\ndef test_credit():\n    pass\n\n@allure.label("file", "INV_1.csv")\ndef test_invoice():\n    pass\n\n@allure.label("file", "PAY_DAILY.txt")\ndef test_pay():\n    pass\n`;
    const out = scan(xml, tests);
    expect(out.triggers.map((t) => [t.filePattern, t.patternKind, t.target, t.coveredBy.map((c) => c.test.split('::').pop())])).toEqual([
      ['INV_*.csv', 'condition', 'direct:invoiceJob', ['test_invoice']],
      ['/CRN_\\d{8}\\.csv/', 'condition', 'direct:creditJob', ['test_credit']],
      ['PAY_DAILY | PAY_WEEKLY', 'condition', 'direct:paymentJob', ['test_pay']],
      ['*.xml', 'condition', 'direct:xmlJob', []],
    ]);
    expect(out.triggers[0]!.key).toBe('inbox::INV_*.csv');
    expect(out.triggers[1]!.line).toBe(6);
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
    expect(main.json<TriggerScanResponse>()).toMatchObject({ branch: 'main', total: 4, automated: 4, files: { xml: 2, properties: 2, tests: 1 }, otherRoutes: 1 });

    const newRoute = `<route id="payments-load"><from uri="file:/data/payments?include=PAY_.*\\.csv"/><to uri="direct:pay"/></route>`;
    const newTest = `\n\n@allure.label("route", "payments-load")\ndef test_payment_file_is_loaded():\n    pass\n\n\n@allure.label("route", "statements")\ndef test_statements_run():\n    pass\n`;
    expect((await scan('feature/payments', repoZip(newRoute, newTest))).statusCode).toBe(201);

    const pr = (await t.app.inject({ url: '/api/triggers?branch=feature%2Fpayments&compare=main' })).json<TriggerListResponse>();
    const rows = Object.fromEntries(pr.items.map((r) => [r.routeId, r]));
    expect(rows['payments-load']).toMatchObject({ change: 'added', automatedBefore: false, branches: ['feature/payments'] });
    expect(rows['payments-load']!.coveredBy).toHaveLength(1);
    // already covered on main by the parametrize list; the branch adds a second test
    // (newly automated unchanged triggers are covered by 'routes and tests from different repos')
    expect(rows['statements']).toMatchObject({ change: 'unchanged', automatedBefore: true });
    expect(rows['statements']!.coveredBy).toHaveLength(2);
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
    expect(res.json().error).toBe('nothing_to_scan');
    expect((await t.app.inject({ url: '/api/triggers?branch=nope' })).statusCode).toBe(400);
  });
});

describe('routes and tests from different repos', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await createTestApp();
  });
  afterEach(async () => t.close());

  const upload = (fields: Record<string, string>, files: Array<{ field: string; filename: string; content: string }>) => {
    const mp = multipart(fields, files);
    return t.app.inject({ method: 'POST', url: '/api/triggers/scan', payload: mp.payload, headers: mp.headers });
  };
  const ROUTES = (extra = '') =>
    `<routes><route id="invoice-load"><from uri="file:/in?include=INV_.*"/></route><route id="purge"><from uri="quartz://p?cron=0+0+2+*+*+?"/></route>${extra}</routes>`;
  const INVOICE_TEST = '@allure.label("route", "invoice-load")\ndef test_invoice():\n    pass\n';

  it('a test-repo PR is shown against main routes; a route-repo PR against main tests', async () => {
    expect((await upload({ branch: 'main', only: 'routes' }, [{ field: 'file:camel', filename: 'routes.xml', content: ROUTES() }])).statusCode).toBe(201);
    // the test repo keeps a copy of a route as test data: with only=tests it must not count as routes
    const mainTests = await upload({ branch: 'main', only: 'tests' }, [
      { field: 'file:tests', filename: 'test_invoice.py', content: INVOICE_TEST },
      { field: 'file:test_data/routes', filename: 'copy.xml', content: '<routes><route id="fake"><from uri="file:/x"/></route></routes>' },
    ]);
    expect(mainTests.json<TriggerScanResponse>()).toMatchObject({ total: 0, automated: 1, files: { xml: 0, tests: 1 } });

    // a PR in the test repo adds a test for purge
    await upload({ branch: 'feature/purge-test', only: 'tests' }, [
      { field: 'file:tests', filename: 'test_invoice.py', content: `${INVOICE_TEST}\n@pytest.mark.route("purge")\ndef test_purge():\n    pass\n` },
    ]);
    const pr = (await t.app.inject({ url: '/api/triggers?branch=feature%2Fpurge-test&compare=main' })).json<TriggerListResponse>();
    expect(pr).toMatchObject({ routesFrom: 'main', testsFrom: 'feature/purge-test', compareRoutesFrom: 'main', compareTestsFrom: 'main' });
    expect(pr.items.map((r) => [r.routeId, r.change, r.coveredBy.length, r.automatedBefore])).toEqual([
      ['invoice-load', 'unchanged', 1, true],
      ['purge', 'unchanged', 1, false],
    ]);

    // a PR in the route repo adds a route; tests come from main
    await upload({ branch: 'feature/refunds', only: 'routes' }, [
      { field: 'file:camel', filename: 'routes.xml', content: ROUTES('<route id="refund-load"><from uri="file:/in?include=RFD_.*"/></route>') },
    ]);
    const rpr = (await t.app.inject({ url: '/api/triggers?branch=feature%2Frefunds&compare=main' })).json<TriggerListResponse>();
    // tests come from main, plus the branch scanned by hand above, not merged yet
    expect(rpr).toMatchObject({ routesFrom: 'feature/refunds', testsFrom: 'main', unmergedFrom: ['feature/purge-test'] });
    expect(rpr.items.map((r) => [r.routeId, r.change, r.coveredBy.map((c) => c.branch ?? 'merged')])).toEqual([
      ['invoice-load', 'unchanged', ['merged']],
      ['purge', 'unchanged', ['feature/purge-test']],
      ['refund-load', 'added', []],
    ]);
    expect(JSON.stringify(rpr)).not.toContain('"match"');
  });
});

describe('Xray keys in tests', () => {
  it('reads keys from comments above a test, its docstring, its class and the module', () => {
    const src = [
      '"""Invoice routes. Covers QA-1."""',
      'import pytest',
      '',
      '# QA-2: the load test',
      '@pytest.mark.smoke',
      'def test_load(camel):',
      '    """Loads the file (QA-3)."""',
      '    # see also QA-4',
      '    camel.drop("INV.TXT")',
      '',
      '',
      'def helper():',
      '    return "QA-99"  # helpers never count',
      '',
      '',
      '# QA-5',
      'class TestPurge:',
      '    """QA-6"""',
      '',
      '    def test_purge(self):',
      '        pass',
      '',
      '',
      'def test_other():',
      '    pass',
      '',
    ].join('\n');
    const tests = scanPytestFile('src/route_test/invoice_route.py', src);
    expect(tests.map((t) => [t.name, [...t.keys].sort()])).toEqual([
      ['test_load', ['QA-1', 'QA-2', 'QA-3', 'QA-4']],
      ['test_purge', ['QA-1', 'QA-5', 'QA-6']],
      ['test_other', ['QA-1']],
    ]);
  });

  it('a test scan of main marks the named Xray cases automated; other branches do not', async () => {
    const t = await createTestApp();
    try {
      const mk = async (key: string, automationStatus = 'not_automated') =>
        (await t.app.inject({ method: 'POST', url: '/api/test-cases', payload: { key, title: key, jiraKey: key, automationStatus } })).json<{ id: number }>();
      const [a, b, c, d] = [await mk('QA-11'), await mk('QA-12'), await mk('QA-13', 'not_automatable'), await mk('QA-14')];
      const upload = (branch: string, text: string) => {
        const mp = multipart({ branch, only: 'tests' }, [{ field: 'file:src/route_test', filename: 'invoice_route.py', content: text }]);
        return t.app.inject({ method: 'POST', url: '/api/triggers/scan', payload: mp.payload, headers: mp.headers });
      };
      // a PR branch names QA-14: nothing changes yet
      const pr = await upload('feature/qa-14', 'def test_x():\n    """QA-14"""\n');
      expect(pr.json<TriggerScanResponse>().cases).toBeNull();
      // main names QA-11 (comment), QA-12 (docstring) and QA-13 (not automatable: left alone)
      const res = await upload('main', '# QA-11\ndef test_a():\n    """QA-12 and QA-13"""\n    pass\n');
      expect(res.statusCode).toBe(201);
      expect(res.json<TriggerScanResponse>().cases).toEqual({ referenced: 3, newlyAutomated: 2 });
      const status = async (id: number) => (await t.app.inject({ url: `/api/test-cases/${id}` })).json<{ automationStatus: string; automatedVia: string | null }>();
      expect(await status(a.id)).toMatchObject({ automationStatus: 'automated', automatedVia: 'repo_scan' });
      expect(await status(b.id)).toMatchObject({ automationStatus: 'automated', automatedVia: 'repo_scan' });
      expect((await status(c.id)).automationStatus).toBe('not_automatable');
      expect((await status(d.id)).automationStatus).toBe('not_automated');
      // scanning main again changes nothing (never downgrades either)
      expect((await upload('main', 'def test_a():\n    pass\n')).json<TriggerScanResponse>().cases).toEqual({ referenced: 0, newlyAutomated: 0 });
      expect((await status(a.id)).automationStatus).toBe('automated');
    } finally {
      await t.close();
    }
  });
});

describe('the ways a trigger is written', () => {
  const scan = (xml: string, props = '', tests: Record<string, string> = {}) =>
    scanRepository({
      xml: [{ path: 'src/main/resources/sample-routes/routes/a.xml', text: xml }],
      properties: props ? [{ path: 'src/main/resources/sample-routes/config/app.properties', text: props }] : [],
      tests: Object.entries(tests).map(([path, text]) => ({ path, text })),
    });
  const covered = (out: ReturnType<typeof scan>, id: string) => out.triggers.find((t) => t.routeId === id)?.coveredBy.map((c) => c.via) ?? [];

  it('load routes: the data file by include=, and the marker file the route deletes as its trigger file', () => {
    const out = scan(
      `<routes>
        <route id="sample-load">
          <from uri="file:{{in}}?include=SAMPLE.*.csv&amp;noop=true"/>
          <to uri="direct:load"/>
          <setHeader name="deleteFileName"><simple>\${file:parent}/LOADTRIGGER</simple></setHeader>
          <to uri="bean:files?method=delete"/>
        </route>
        <route id="camel2-load">
          <from uri="file:/in2?include=OTHER.*"/>
          <!-- <setHeader headerName="deleteFileName"><constant>IGNORED</constant></setHeader> -->
          <setHeader headerName="doneFileName"><constant>/in2/OTHERTRIGGER</constant></setHeader>
        </route>
      </routes>`,
      'in=/data/in\n',
      { 'src/route_test/load_route.py': 'def test_marker():\n    drop("LOADTRIGGER")\n\ndef test_other():\n    drop("OTHERTRIGGER")\n' },
    );
    expect(out.triggers.find((t) => t.routeId === 'sample-load')).toMatchObject({ filePattern: 'SAMPLE.*.csv', patternKind: 'regex', doneFile: 'LOADTRIGGER' });
    expect(out.triggers.find((t) => t.routeId === 'camel2-load')).toMatchObject({ doneFile: 'OTHERTRIGGER' });
    expect(covered(out, 'sample-load')).toEqual(['LOADTRIGGER']);
    expect(covered(out, 'camel2-load')).toEqual(['OTHERTRIGGER']);
  });

  it('include= with a plain name, and placeholder defaults', () => {
    const out = scan(
      `<routes>
        <route id="extract"><from uri="file:/ext?include=EXTRACTRIGGER&amp;delete=true"/></route>
        <route id="daily"><from uri="file:/ext?fileName={{dailyExtractFilename:EXTRACTDAILYTRIGGER}}"/></route>
        <route id="weekly"><from uri="file:/ext?fileName={{weeklyExtractFilename:DEFAULTNAME}}"/></route>
      </routes>`,
      'weeklyExtractFilename=WEEKLYTRIGGER\n',
      { 'src/route_test/extract_route.py': 'def test_e():\n    drop("EXTRACTRIGGER")\n\ndef test_d():\n    drop("EXTRACTDAILYTRIGGER")\n\ndef test_w():\n    drop("WEEKLYTRIGGER")\n' },
    );
    expect(out.triggers.map((t) => [t.routeId, t.filePattern])).toEqual([
      ['extract', 'EXTRACTRIGGER'],
      ['daily', 'EXTRACTDAILYTRIGGER'], // the default, as no properties file sets the key
      ['weekly', 'WEEKLYTRIGGER'], // a value in the properties wins over the default
    ]);
    expect(covered(out, 'extract')).toEqual(['EXTRACTRIGGER']);
    expect(covered(out, 'daily')).toEqual(['EXTRACTDAILYTRIGGER']);
    expect(covered(out, 'weekly')).toEqual(['WEEKLYTRIGGER']);
  });
});

describe('routes in the source code are the scope', () => {
  it('headline coverage counts route triggers once the Camel repo is scanned; cases no longer add to it', async () => {
    const t = await createTestApp();
    try {
      // cases from anywhere (spreadsheet, Jira…) count until routes exist
      for (const key of ['XL-1', 'XL-2', 'XL-3'])
        await t.app.inject({ method: 'POST', url: '/api/test-cases', payload: { key, title: key, automationStatus: 'automated' } });
      const summary = async () => (await t.app.inject({ url: '/api/summary' })).json<{ coverage: Record<string, unknown> }>().coverage;
      expect(await summary()).toMatchObject({ unit: 'cases', total: 3, automated: 3 });
      const overview = async (q = '') => (await t.app.inject({ url: `/api/triggers/overview${q}` })).json<Record<string, unknown>>();
      expect(await overview()).toMatchObject({ triggerRepo: null, testRepo: null, branch: null, counts: { tested: 0, branch: 0, none: 0 }, items: [] });

      const upload = (fields: Record<string, string>, field: string, filename: string, content: string) => {
        const mp = multipart(fields, [{ field, filename, content }]);
        return t.app.inject({ method: 'POST', url: '/api/triggers/scan', payload: mp.payload, headers: mp.headers });
      };
      const routes = '<routes><route id="invoice-load"><from uri="file:/in?fileName=INV.TXT"/></route><route id="credit-load"><from uri="file:/in?fileName=CRN.TXT"/></route><route id="purge"><from uri="quartz://p?cron=0+0+2+*+*+?"/></route></routes>';
      await upload({ branch: 'main', only: 'routes' }, 'file:camel', 'routes.xml', routes);
      await upload({ branch: 'main', only: 'tests' }, 'file:src/route_test', 'invoice_route.py', 'def test_invoice():\n    start("invoice-load")\n');
      // a PR branch in the test repo already covers credit-load
      await upload({ branch: 'feature/credit', only: 'tests' }, 'file:src/route_test', 'credit_route.py', 'def test_credit():\n    start("credit-load")\n');

      // tested = a test on main or on any scanned branch (credit-load only on feature/credit, not merged)
      expect(await summary()).toMatchObject({ unit: 'routes', total: 3, automated: 2, unmerged: 1, inProgress: 0, notAutomated: 1, notAutomatable: 0 });
      // more cases (e.g. a spreadsheet import) change nothing now
      await t.app.inject({ method: 'POST', url: '/api/test-cases', payload: { key: 'XL-4', title: 'XL-4', automationStatus: 'automated' } });
      expect((await summary()).total).toBe(3);
      const report = (await t.app.inject({ url: '/api/report' })).json<{ coverage: { unit: string }; automationInFlight: { projectedAutomated: number } }>();
      expect(report.coverage.unit).toBe('routes');
      expect(report.automationInFlight.projectedAutomated).toBe(2); // automated + covered on a PR branch

      // the Overview's route table: the untested routes first, one status at a time
      expect(await overview()).toMatchObject({
        // 1. the trigger repo: unique triggers; 2. the test repo: triggers with one or more tests
        triggerRepo: { branch: 'main', triggers: 3 },
        testRepo: { branch: 'main', tests: 1, testsLinked: 1, triggersTested: 1 },
        branch: 'main',
        counts: { tested: 1, branch: 1, none: 1 },
        status: 'none',
        items: [{ routeId: 'purge', status: 'none', firesOn: '0 0 2 * * ?', tests: [], branches: [] }],
      });
      expect(await overview('?status=branch')).toMatchObject({ items: [{ routeId: 'credit-load', branches: ['feature/credit'] }] });
      expect(await overview('?status=tested')).toMatchObject({
        items: [{ routeId: 'invoice-load', firesOn: 'INV.TXT', tests: [expect.stringContaining('test_invoice')] }],
      });
      expect((await t.app.inject({ url: '/api/triggers/overview?limit=0' })).statusCode).toBe(400);

      // pick another branch of the trigger repo: its triggers, with main's tests (no test scan on core)
      await upload({ branch: 'core', only: 'routes' }, 'file:camel', 'routes.xml', '<routes><route id="invoice-load"><from uri="file:/in?fileName=INV.TXT"/></route><route id="core-only"><from uri="file:/in?fileName=CORE.TXT"/></route></routes>');
      const coreSummary = (await t.app.inject({ url: '/api/summary?branch=core' })).json<{ coverage: Record<string, unknown> }>().coverage;
      expect(coreSummary).toMatchObject({ unit: 'routes', branch: 'core', total: 2, automated: 1, unmerged: 0, notAutomated: 1 });
      expect(await summary()).toMatchObject({ branch: 'main', total: 3 }); // the default is unchanged
      expect(await overview('?branch=core')).toMatchObject({
        routeBranches: ['main', 'core'],
        defaultBranch: 'main',
        triggerRepo: { branch: 'core', triggers: 2 },
        counts: { tested: 1, branch: 0, none: 1 },
        items: [{ routeId: 'core-only' }],
      });
      // an unknown branch falls back to the default
      expect(await overview('?branch=nope')).toMatchObject({ triggerRepo: { branch: 'main' } });
      const coreReport = (await t.app.inject({ url: '/api/report?branch=core' })).json<{ coverage: { branch: string; total: number } }>();
      expect(coreReport.coverage).toMatchObject({ branch: 'core', total: 2 });

      // folders: the numbers for one folder of a branch, not the branch total
      const mp = multipart({ branch: 'dev', only: 'routes' }, [
        { field: 'file:src/main/resources/common/routes', filename: 'a.xml', content: '<routes><route id="invoice-load"><from uri="file:/in?fileName=INV.TXT"/></route><route id="purge"><from uri="quartz://p?cron=0+0+2+*+*+?"/></route></routes>' },
        { field: 'file:src/main/resources/billing/routes', filename: 'b.xml', content: '<routes><route id="credit-load"><from uri="file:/in?fileName=CRN.TXT"/></route></routes>' },
      ]);
      expect((await t.app.inject({ method: 'POST', url: '/api/triggers/scan', payload: mp.payload, headers: mp.headers })).statusCode).toBe(201);
      const devCommon = (await t.app.inject({ url: '/api/summary?branch=dev&folder=common' })).json<{ coverage: Record<string, unknown> }>().coverage;
      expect(devCommon).toMatchObject({ branch: 'dev', folder: 'common', total: 2, automated: 1, unmerged: 0, notAutomated: 1 });
      const devAll = (await t.app.inject({ url: '/api/summary?branch=dev' })).json<{ coverage: Record<string, unknown> }>().coverage;
      expect(devAll).toMatchObject({ total: 3, automated: 2, unmerged: 1 }); // credit-load: only feature/credit tests it
      expect(await overview('?branch=dev&folder=common&status=none')).toMatchObject({
        folder: 'common',
        folders: [
          { folder: 'billing', triggers: 1, tested: 1, unmerged: 1 },
          { folder: 'common', triggers: 2, tested: 1, unmerged: 0 },
        ],
        triggerRepo: { branch: 'dev', triggers: 2 },
        counts: { tested: 1, branch: 0, none: 1 },
        items: [{ routeId: 'purge' }],
      });
      // a folder the branch doesn't have counts nothing
      expect((await t.app.inject({ url: '/api/summary?branch=core&folder=common' })).json<{ coverage: { total: number } }>().coverage.total).toBe(0);
    } finally {
      await t.close();
    }
  });
});

describe('PRs count for the branch they target', () => {
  it('core and dev both have a common folder; a PR into dev never counts for core', async () => {
    const t = await createTestApp();
    try {
      const up = async (fields: Record<string, string>, dir: string, filename: string, content: string) => {
        const mp = multipart(fields, [{ field: `file:${dir}`, filename, content }]);
        const res = await t.app.inject({ method: 'POST', url: '/api/triggers/scan', payload: mp.payload, headers: mp.headers });
        expect(res.statusCode, res.body).toBe(201);
      };
      const routes = '<routes><route id="core-a"><from uri="file:/in?fileName=A.TXT"/></route><route id="core-b"><from uri="file:/in?fileName=B.TXT"/></route></routes>';
      const test = (name: string, route: string) => `def test_${name}():\n    start("${route}")\n`;
      const R = 'src/main/resources/common/routes';
      const T = 'src/route_test';
      // trigger repo: core and dev, each with the same common/ routes
      await up({ branch: 'core', only: 'routes', label: 'acme/camel' }, R, 'a.xml', routes);
      await up({ branch: 'dev', only: 'routes', label: 'acme/camel' }, R, 'a.xml', routes);
      // test repo: core tests A; dev already has B merged; a PR into dev adds A
      await up({ branch: 'core', only: 'tests', label: 'acme/tests' }, T, 'a_route.py', test('a', 'core-a'));
      await up({ branch: 'dev', only: 'tests', label: 'acme/tests' }, T, 'b_route.py', test('b', 'core-b'));
      await up({ branch: 'feature/a-dev', only: 'tests', label: 'acme/tests PR #3 → dev' }, T, 'a_route.py', test('a', 'core-a'));

      const cov = async (q: string) => (await t.app.inject({ url: `/api/summary?${q}` })).json<{ coverage: Record<string, unknown> }>().coverage;
      // core: A merged; B is only merged on dev, which doesn't count for core
      expect(await cov('branch=core&folder=common')).toMatchObject({ total: 2, automated: 1, unmerged: 0, notAutomated: 1 });
      // dev: B merged, A only in the PR into dev
      expect(await cov('branch=dev&folder=common')).toMatchObject({ total: 2, automated: 2, unmerged: 1, notAutomated: 0 });

      // the same test in a PR into core: now it counts for core too, as not merged yet
      await up({ branch: 'feature/b-core', only: 'tests', label: 'acme/tests PR #1 → core' }, T, 'b_route.py', test('b', 'core-b'));
      expect(await cov('branch=core&folder=common')).toMatchObject({ total: 2, automated: 2, unmerged: 1 });
      expect(await cov('branch=dev&folder=common')).toMatchObject({ automated: 2, unmerged: 1 }); // unchanged
      const ov = (await t.app.inject({ url: '/api/triggers/overview?branch=core&folder=common&status=branch' })).json<{ items: { routeId: string; branches: string[] }[] }>();
      expect(ov.items).toEqual([expect.objectContaining({ routeId: 'core-b', branches: ['feature/b-core'] })]);

      // the Triggers page counts the same way: core's merged tests plus the PRs into core, never dev's
      const list = (await t.app.inject({ url: '/api/triggers?branch=core' })).json<TriggerListResponse>();
      expect(list).toMatchObject({ routesFrom: 'core', testsFrom: 'core', unmergedFrom: ['feature/b-core'] });
      expect(list.items.map((r) => [r.routeId, r.coveredBy.map((c) => c.branch ?? 'merged')])).toEqual([
        ['core-a', ['merged']],
        ['core-b', ['feature/b-core']],
      ]);
      const dev = (await t.app.inject({ url: '/api/triggers?branch=dev' })).json<TriggerListResponse>();
      expect(dev.unmergedFrom).toEqual(['feature/a-dev']);
    } finally {
      await t.close();
    }
  });
});

describe('scan a branch straight from GitHub', () => {
  const TOKEN = 'ghp_0123456789abcdefghijklmnopqrstuvwxyzAB';
  const openPrs: Record<string, unknown[]> = {};
  const pull = (number: number, ref: string, base: string, repo = 'acme/tests') => ({
    number,
    title: `PR ${number}`,
    updated_at: '2026-11-06T10:00:00Z',
    head: { ref, sha: '6666666aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', repo: { full_name: repo } },
    base: { ref: base },
  });
  let mock: MockServer;
  let t: TestApp;
  const zips: Record<string, Buffer> = {};
  beforeEach(async () => {
    const routes = (extra = '') => `<routes><route id="invoice-load"><from uri="file:/in?fileName=INV.TXT"/></route>${extra}</routes>`;
    zips['acme/camel@main'] = makeZip([
      { name: 'acme-camel-1a2b3c4/src/main/resources/billing/routes/billing.xml', data: routes() },
      { name: 'acme-camel-1a2b3c4/README.md', data: 'hi' },
    ]);
    zips['acme/camel@feature/refunds'] = makeZip([
      { name: 'acme-camel-9f8e7d6/src/main/resources/billing/routes/billing.xml', data: routes('<route id="refund-load"><from uri="file:/in?fileName=RFD.TXT"/></route>') },
    ]);
    zips['acme/tests@main'] = makeZip([
      { name: 'acme-tests-5555555/src/route_test/invoice_route.py', data: '# QA-1\ndef test_invoice():\n    start("invoice-load")\n\n\ndef test_old():\n    """QA-2"""\n' },
      { name: 'acme-tests-5555555/src/test_data/routes/copy.xml', data: routes('<route id="fake"><from uri="file:/x"/></route>') },
    ]);
    zips['acme/tests@feature/refunds'] = makeZip([
      { name: 'acme-tests-6666666/src/route_test/invoice_route.py', data: '# QA-1\ndef test_invoice():\n    start("invoice-load")\n\n\ndef test_refund():\n    """QA-3"""\n    start("refund-load")\n' },
    ]);
    mock = await startMockServer((req) => {
      const zb = /^\/api\/v3\/repos\/([\w.-]+)\/([\w.-]+)\/zipball\/(.+)$/.exec(req.path);
      if (zb) {
        if (req.headers.authorization !== `Bearer ${TOKEN}`) return { status: 401, json: { message: 'Bad credentials' } };
        const key = `${zb[1]}/${zb[2]}@${decodeURIComponent(zb[3]!)}`;
        if (!zips[key]) return { status: 404, json: { message: 'Not Found' } };
        return { status: 302, headers: { location: `/_codeload/${encodeURIComponent(key)}?token=signed-secret` } };
      }
      const cl = /^\/_codeload\/(.+)$/.exec(req.path);
      if (cl) {
        // the signed download URL must not receive the API token
        if (req.headers.authorization) return { status: 400, text: 'token forwarded' };
        const body = zips[decodeURIComponent(cl[1]!)]!;
        return { raw: (res) => res.writeHead(200, { 'content-type': 'application/zip', 'content-length': String(body.length) }).end(body) };
      }
      if (req.path === '/api/v3/repos/acme/camel/branches') return { json: [{ name: 'main' }, { name: 'feature/refunds' }] };
      const pulls = /^\/api\/v3\/repos\/([\w.-]+\/[\w.-]+)\/pulls$/.exec(req.path);
      if (pulls) return { json: openPrs[pulls[1]!] ?? [] };
      return { status: 404, json: { message: 'Not Found' } };
    });
    t = await createTestApp({ GITHUB_TOKEN: TOKEN, GITHUB_REPOS: 'acme/camel,acme/tests', GITHUB_API_URL: `${mock.url}/api/v3` });
  });
  afterEach(async () => {
    await t.close();
    await mock.close();
  });
  const scan = (repo: string, branch: string, only: 'routes' | 'tests') =>
    t.app.inject({ method: 'POST', url: '/api/triggers/scan-github', payload: { repo, branch, only } });

  it('downloads, strips the archive folder, takes the commit from it, and stores the scan', async () => {
    expect((await t.app.inject({ url: '/api/triggers/github' })).json()).toEqual({ configured: true, repos: ['acme/camel', 'acme/tests'] });
    expect((await t.app.inject({ url: '/api/triggers/github/branches?repo=acme/camel' })).json()).toEqual({ branches: ['main', 'feature/refunds'] });

    const r1 = await scan('acme/camel', 'main', 'routes');
    expect(r1.statusCode, r1.body).toBe(201);
    expect(r1.json<TriggerScanResponse>()).toMatchObject({ branch: 'main', commit: '1a2b3c4', label: 'acme/camel', total: 1, files: { xml: 1, tests: 0 } });
    // only=tests: the route copy in the test repo is not scope
    const r2 = await scan('acme/tests', 'main', 'tests');
    expect(r2.json<TriggerScanResponse>()).toMatchObject({ total: 0, testsFound: 2, automated: 1 });
    // the two steps: unique triggers in the trigger repo, and how many of them the test repo tests
    expect((await t.app.inject({ url: '/api/triggers/overview' })).json()).toMatchObject({
      triggerRepo: { repo: 'acme/camel', branch: 'main', commit: '1a2b3c4', triggers: 1 },
      testRepo: { repo: 'acme/tests', branch: 'main', commit: '5555555', tests: 2, testsLinked: 1, triggersTested: 1 },
    });
    await scan('acme/camel', 'feature/refunds', 'routes');
    await scan('acme/tests', 'feature/refunds', 'tests');

    const list = (await t.app.inject({ url: '/api/triggers?branch=feature%2Frefunds&compare=main' })).json<TriggerListResponse>();
    const byId = Object.fromEntries(list.items.map((r) => [r.routeId, r]));
    expect(byId['refund-load']).toMatchObject({ change: 'added', automatedBefore: false });
    expect(byId['refund-load']!.coveredBy).toHaveLength(1);
    expect(list.divergence).toMatchObject({
      testsMissingHere: ['src/route_test/invoice_route.py::test_old'],
      testsOnlyHere: ['src/route_test/invoice_route.py::test_refund'],
      testsMissingHereCount: 1,
      testsOnlyHereCount: 1,
      keysMissingHere: [{ key: 'QA-2', title: null, testCaseId: null }],
      keysOnlyHere: [{ key: 'QA-3', title: null, testCaseId: null }],
    });
    // the token never reaches the signed download URL
    expect(mock.requests.filter((r) => r.path.startsWith('/_codeload/')).every((r) => !r.headers.authorization)).toBe(true);
  });

  it('Scan open PRs: scans each open PR branch of the test repo, skips the ones up to date, drops closed ones', async () => {
    const scans = () => t.dbHandle.db.select({ branch: triggerScans.branch, label: triggerScans.label, commit: triggerScans.commit }).from(triggerScans).all();
    const run = async () => {
      expect((await t.app.inject({ method: 'POST', url: '/api/triggers/pr-scan' })).statusCode).toBe(202);
      for (let i = 0; i < 200; i++) {
        const st = (await t.app.inject({ url: '/api/triggers/pr-scan' })).json<PrScanStatus>();
        if (st.state !== 'running') return st;
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error('PR scan did not finish');
    };

    // not a test repo until the dashboard has scanned it as tests
    expect(await run()).toMatchObject({ state: 'error', error: expect.stringContaining('No test repo yet') });
    await scan('acme/camel', 'main', 'routes');
    await scan('acme/camel', 'feature/refunds', 'routes');
    await scan('acme/tests', 'main', 'tests');

    // open PRs: one to scan, one from a fork; the route repo's PRs are never listed
    openPrs['acme/tests'] = [pull(7, 'feature/refunds', 'main'), pull(8, 'feature/fork', 'main', 'someone/tests')];
    openPrs['acme/camel'] = [pull(3, 'feature/refunds', 'main', 'acme/camel')];
    const first = await run();
    expect(first).toMatchObject({ state: 'done', repos: ['acme/tests'] });
    expect(first.prs).toEqual([
      expect.objectContaining({ number: 7, branch: 'feature/refunds', base: 'main', status: 'scanned', commit: '6666666' }),
      expect.objectContaining({ number: 8, status: 'skipped', error: 'from a fork' }),
    ]);
    expect(scans()).toContainEqual({ branch: 'feature/refunds', label: 'acme/tests PR #7 → main', commit: '6666666' });
    expect(mock.requests.some((r) => r.path === '/api/v3/repos/acme/camel/pulls')).toBe(false);

    // run again: nothing moved, so nothing is downloaded
    const downloads = () => mock.requests.filter((r) => r.path.includes('/zipball/')).length;
    const before = downloads();
    expect((await run()).prs[0]).toMatchObject({ number: 7, status: 'up_to_date', commit: '6666666' });
    expect(downloads()).toBe(before);

    // retargeted → scanned again for the new target
    openPrs['acme/tests'] = [pull(7, 'feature/refunds', 'core')];
    expect((await run()).prs[0]).toMatchObject({ status: 'scanned', base: 'core' });

    // merged or closed → its scan goes; the route repo's same-named branch and hand-made scans stay
    openPrs['acme/tests'] = [];
    expect(await run()).toMatchObject({ state: 'done', removed: 1, prs: [] });
    expect(scans().filter((x) => x.label?.startsWith('acme/tests PR #7'))).toEqual([]);
    expect(scans()).toContainEqual(expect.objectContaining({ branch: 'feature/refunds', label: 'acme/camel' }));
    expect(scans()).toContainEqual(expect.objectContaining({ branch: 'main', label: 'acme/tests' }));
  });

  it('refuses repos outside GITHUB_REPOS, bad branch names, and reports missing branches', async () => {
    expect((await scan('evil/repo', 'main', 'routes')).json().error).toBe('repo_not_configured');
    expect((await scan('acme/camel', '../../etc', 'routes')).statusCode).toBe(400);
    const missing = await scan('acme/camel', 'nope', 'routes');
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error).toBe('branch_not_found');
    expect(missing.body).not.toContain(TOKEN);
  });

  it('refuses a redirect to another host', async () => {
    mock.setHandler((req) =>
      req.path.includes('/zipball/') ? { status: 302, headers: { location: 'https://evil.example.com/x.zip' } } : { status: 404, json: {} },
    );
    const res = await scan('acme/camel', 'main', 'routes');
    expect(res.statusCode).toBe(502);
    expect(res.json().message).toMatch(/refused a redirect to evil\.example\.com/);
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
