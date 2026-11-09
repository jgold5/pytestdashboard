/**
 * Regressions found by an independent re-implementation of the counting rules (an "oracle"
 * written from the spec, run against hundreds of generated repos): each case is the minimal
 * repro of a disagreement, with what Camel / pytest actually do.
 */
import { describe, expect, it } from 'vitest';
import { scanRepository, type ScanInput } from '../src/triggers/scan.js';

const xml = (text: string, path = 'src/main/resources/m/routes/r.xml') => ({ path, text });
const py = (text: string) => ({ path: 'tests/test_a.py', text });
const run = (input: Partial<ScanInput>) => scanRepository({ xml: [], properties: [], tests: [], ...input });
const covered = (out: ReturnType<typeof run>) => out.triggers.map((t) => [t.routeId, t.filePattern, t.coveredBy.map((c) => c.test.split('::').pop())]);

describe('counting rules checked against an independent implementation', () => {
  it('P1: {{env:NAME}} is an environment variable, not a key "env" with default NAME', () => {
    const out = run({ xml: [xml('<routes><route id="a"><from uri="{{env:INVOICE_SFTP_URL}}"/></route><route id="b"><from uri="{{env:ORDERS_IN_URI}}"/></route><route id="c"><from uri="{{env:X_URI:timer:x}}"/></route></routes>')] });
    expect(out.triggers.map((t) => [t.routeId, t.kind, t.scheme])).toEqual([
      ['a', 'file', 'sftp'],
      ['b', 'property', 'property'],
      ['c', 'schedule', 'timer'], // {{env:NAME:default}} uses its default
    ]);
    expect(out.otherRoutes).toBe(0);
  });

  it('P2: the ref: component names an <endpoint>', () => {
    const out = run({ xml: [xml('<beans><camelContext><endpoint id="inbox" uri="file:/data/in"/><route id="a"><from uri="ref:inbox"/></route></camelContext></beans>', 'src/main/resources/m/ctx.xml')] });
    expect(out.triggers.map((t) => [t.kind, t.directory])).toEqual([['file', '/data/in']]);
  });

  it('P3: Camel 3 operators ~~, !startsWith, !contains… are read (with their negation)', () => {
    const out = run({
      xml: [
        xml(
          "<routes><route id=\"a\"><from uri=\"file:/in\"/><choice><when><simple>${file:name} ~~ 'inv_'</simple><to uri=\"direct:invoiceJob\"/></when><when><simple>${file:name} starts with 'CRN_'</simple><to uri=\"direct:creditJob\"/></when><when><simple>${file:name} !endsWith '.tmp' &amp;&amp; ${file:name} startsWith 'ORD'</simple><to uri=\"direct:x\"/></when></choice></route></routes>",
        ),
      ],
      tests: [py('@allure.label("file", "INV_1.CSV")\ndef test_inv():\n    pass\n\n@allure.label("file", "ORD_1.tmp")\ndef test_tmp():\n    pass\n\n@allure.label("file", "ORD_1.xml")\ndef test_data():\n    pass\n')],
    });
    expect(covered(out)).toEqual([
      ['a', '*inv_*', ['test_inv']], // ~~ ignores case
      ['a', 'CRN_*', []],
      ['a', 'ORD* and not *.tmp', ['test_data']], // ORD_1.tmp is excluded by !endsWith
    ]);
  });

  it('P4: starts with, in, contains, == and regex are case-sensitive; =~ and ~~ are not', () => {
    const out = run({
      xml: [
        xml(
          "<routes><route id=\"a\"><from uri=\"file:/in\"/><choice><when><simple>${file:name} starts with 'INV_'</simple><to uri=\"direct:invoiceJob\"/></when><when><simple>${header.CamelFileName} in 'PAY.csv,PAY.txt'</simple><to uri=\"direct:payJob\"/></when><when><simple>${file:name} =~ 'crn.csv'</simple><to uri=\"direct:creditJob\"/></when></choice></route></routes>",
        ),
      ],
      tests: [py('def test_a():\n    drop_file("inv_20260101.csv")\n\ndef test_b():\n    drop_file("pay.csv")\n\ndef test_c():\n    drop_file("CRN.CSV")\n')],
    });
    expect(covered(out).map(([, , c]) => c)).toEqual([[], [], ['test_c']]);
  });

  it('P5: another module’s properties file never fills in a route; the shared one higher up does', () => {
    const out = run({
      xml: [xml('<routes><route id="a"><from uri="{{shared.in.uri}}"/></route></routes>', 'src/main/resources/billing/routes/r.xml')],
      properties: [
        { path: 'src/main/resources/accounts/config/application-accounts.properties', text: 'shared.in.uri=jms:queue:ACCOUNTS\n' },
        { path: 'src/main/resources/application.properties', text: 'shared.in.uri=file:/data/shared/in\n' },
      ],
    });
    expect(out.triggers.map((t) => [t.kind, t.unresolved])).toEqual([['file', []]]);
  });

  it('P6: REST paths of rest:verb:path:template and http(s)://host:port/path consumers', () => {
    const out = run({
      xml: [xml('<routes><route id="a"><from uri="rest:get:/api/orders:/{id}"/></route><route id="b"><from uri="rest:get:api:orders"/></route><route id="c"><from uri="https://0.0.0.0:8443/api/pay"/></route></routes>')],
      tests: [py('@allure.label("endpoint", "/api/orders/{id}")\ndef test_a():\n    pass\n\n@allure.label("endpoint", "/api/orders")\ndef test_b():\n    pass\n\n@allure.label("endpoint", "/api/pay")\ndef test_c():\n    pass\n')],
    });
    expect(covered(out).map(([id, , c]) => [id, c])).toEqual([
      ['a', ['test_a']],
      ['b', ['test_b']],
      ['c', ['test_c']],
    ]);
  });

  it('P7: a fixture’s params=[…] parametrize the tests that ask for it', () => {
    const out = run({
      xml: [xml('<routes><route id="invoice-load"><from uri="file:/in"/></route></routes>')],
      tests: [py('import pytest\n\n@pytest.fixture(params=["invoice-load"])\ndef route_id(request):\n    return request.param\n\ndef test_a(route_id):\n    start_route(route_id)\n')],
    });
    expect(covered(out)).toEqual([['invoice-load', null, ['test_a']]]);
  });

  it('P8: a bare name in a method is not the class attribute (Python would raise NameError)', () => {
    const out = run({
      xml: [xml('<routes><route id="invoice-load"><from uri="file:/in"/></route></routes>')],
      tests: [py('class TestA:\n    ROUTE = "invoice-load"\n\n    def test_a(self):\n        start_route(ROUTE)\n\n    def test_b(self):\n        start_route(self.ROUTE)\n')],
    });
    expect(covered(out)).toEqual([['invoice-load', null, ['test_b']]]);
  });

  it('P9: of two tests with one name pytest runs only the last', () => {
    const out = run({
      xml: [xml('<routes><route id="invoice-load"><from uri="file:/in"/></route></routes>')],
      tests: [py('def test_a():\n    start_route("invoice-load")\n\ndef test_a():\n    assert True\n')],
    });
    expect(covered(out)).toEqual([['invoice-load', null, []]]);
    expect(out.testsFound).toBe(1);
  });

  it('P10: antInclude is case-sensitive unless antFilterCaseSensitive=false', () => {
    const out = run({
      xml: [xml('<routes><route id="a"><from uri="file:/in?antInclude=INV_*.csv"/></route><route id="b"><from uri="file:/in2?antInclude=CRN_*.csv&amp;antFilterCaseSensitive=false"/></route></routes>')],
      tests: [py('def test_a():\n    drop_file("inv_20260101.csv")\n\ndef test_b():\n    drop_file("crn_20260101.csv")\n')],
    });
    expect(covered(out).map(([id, , c]) => [id, c])).toEqual([
      ['a', []],
      ['b', ['test_b']],
    ]);
  });

  it('P11: file:ext is everything after the first dot; file:ext.single only the last part', () => {
    const out = run({
      xml: [
        xml(
          "<routes><route id=\"a\"><from uri=\"file:/in\"/><choice><when><simple>${file:ext} == 'gz' &amp;&amp; ${file:name} starts with 'REP'</simple><to uri=\"direct:gzJob\"/></when><when><simple>${file:ext.single} == 'gz' &amp;&amp; ${file:name} starts with 'ARC'</simple><to uri=\"direct:arcJob\"/></when></choice></route></routes>",
        ),
      ],
      tests: [py('def test_a():\n    drop_file("REPORT_1.csv.gz")\n\ndef test_b():\n    drop_file("ARCHIVE_1.csv.gz")\n')],
    });
    expect(covered(out).map(([, , c]) => c)).toEqual([[], ['test_b']]);
  });

  it('${header:CamelFileName} is the file name too', () => {
    const out = run({ xml: [xml("<routes><route id=\"a\"><from uri=\"file:/in\"/><choice><when><simple>${header:CamelFileName} starts with 'INV_'</simple><to uri=\"direct:invoiceJob\"/></when></choice></route></routes>")] });
    expect(out.triggers.map((t) => [t.patternKind, t.filePattern, t.target])).toEqual([['condition', 'INV_*', 'direct:invoiceJob']]);
  });

  it('Q1: fileName= with file language is compared case-sensitively', () => {
    const out = run({
      xml: [xml('<routes><route id="a"><from uri="file:/in?fileName=CUST_${date:now:yyyyMMdd}.csv"/></route></routes>')],
      tests: [py('def test_a():\n    drop_file("cust_20260906.csv")\n\ndef test_b():\n    drop_file("CUST_20260906.csv")\n')],
    });
    expect(covered(out).map(([, , c]) => c)).toEqual([['test_b']]);
  });
});
