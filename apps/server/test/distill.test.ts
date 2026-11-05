/**
 * tools/distill_camel_repo.py anonymizes a Camel + pytest repo for sharing. The
 * distilled copy must scan to the same triggers and coverage as the original,
 * and contain none of the original names.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scanRepository, type ScanInput } from '../src/triggers/scan.js';
import { classify } from '../src/triggers/upload.js';

const SCRIPT = path.join(import.meta.dirname, '../../../tools/distill_camel_repo.py');
const py = spawnSync('python3', ['-c', 'import sys; print(sys.version_info >= (3, 9))'], { encoding: 'utf8' });
const hasPython = py.status === 0 && py.stdout.trim() === 'True';

const REPO: Record<string, string> = {
  'billing-service/src/main/resources/camel/acme-billing.xml': `<?xml version="1.0"?>
<!-- Acme Corp billing, owner: jane.doe@acme.example -->
<beans xmlns="http://www.springframework.org/schema/beans" xmlns:acme="http://schemas.acme.example/x">
  <bean id="acmeSecretBean" class="com.acme.billing.Secret"/>
  <camelContext id="acmeBilling" xmlns="http://camel.apache.org/schema/spring">
    <endpoint id="acmeOrdersIn" uri="sftp://svc_acme:Hunter2pass@sftp.acme.example:2222/outbound/acmeorders?antInclude=ACMEORD_*.xml&amp;password=Hunter2pass"/>
    <route id="acme-invoice-load">
      <from uri="file:{{acme.invoice.dir}}?include=ACMEINV_[A-Z]{3}_\\d{8}\\.csv&amp;move=.done"/>
      <to uri="sql:insert into acme_invoices values (:#customer)"/>
    </route>
    <route id="acme-purge">
      <from uri="quartz://acmeJobs/acmePurge?cron={{acme.purge.cron}}"/>
      <to uri="bean:acmeSecretBean"/>
    </route>
    <route id="acme-orders-load">
      <from ref="acmeOrdersIn"/>
      <to uri="direct:acmeOrders"/>
    </route>
    <route id="acme-internal"><from uri="direct:acmeOrders"/><to uri="log:acme"/></route>
    <route id="acme-inbox">
      <from uri="file:{{acme.inbox.dir}}"/>
      <log message="got \${file:name} for Acme"/>
      <choice>
        <when><simple>\${file:name} starts with 'ACMEPAY_' &amp;&amp; \${file:ext} == 'csv'</simple>
          <to uri="direct:acmePaymentJob"/><to uri="bean:acmeAudit"/></when>
        <when><simple><![CDATA[\${header.CamelFileName} regex 'ACMEREF_[0-9]{8}\\.txt']]></simple>
          <to uri="direct:acmeRefundJob"/></when>
        <when><simple>\${header.acmeKind} == 'urgent'</simple><to uri="direct:acmeUrgent"/></when>
        <otherwise><to uri="direct:acmeUnknown"/></otherwise>
      </choice>
    </route>
    <route id="acme-multi">
      <from uri="file:/srv/acme/ledger?include=(ACMEGL|ACMEAP)_.*\\.dat"/>
      <from uri="quartz://acmeJobs/acmeSweep?cron=0+15+*+*+*+?"/>
      <to uri="direct:acmeLedger"/>
    </route>
  </camelContext>
</beans>
`,
  'billing-service/properties/acme-dev.properties': 'acme.invoice.dir=/srv/acme/dev/invoices\nacme.purge.cron=0 0 2 * * ?\nacme.db.password=TopSecret99\nacme.inbox.dir=/srv/acme/inbox\n',
  'billing-service/properties/acme-prod.properties': 'acme.invoice.dir=/srv/acme/prod/invoices\nacme.purge.cron=0 0 2 * * ?\n',
  'billing-service/tests/test_acme_billing.py': `import allure
import pytest
from acme_helpers import customer_fixture


@allure.label("route", "acme-invoice-load")
@allure.feature("Acme Billing")
def test_acme_invoice_loads(customer_fixture):
    assert customer_fixture.name == "Jane Doe"


@allure.feature("Acme Billing")
class TestAcmeJobs:
    @pytest.mark.camel_route("acmePurge")
    def test_acme_purge_runs(self):
        pass

    def test_acme_orders(self):
        allure.dynamic.label("trigger", "ACMEORD_20261101.xml")


@allure.label("job", "acmeRefundJob")
def test_acme_refund_job():
    pass


@allure.label("file", "ACMEPAY_20261101.csv")
def test_acme_payment_file():
    pass


@allure.label("file", "ACMEAP_20261101.dat")
def test_acme_ap_file():
    pass


@pytest.mark.parametrize("name", ["acme-purge"])
def test_not_a_label(name):
    pass
`,
};
const SENSITIVE = ['acme', 'ACME', 'Acme', 'Hunter2pass', 'TopSecret', 'jane', 'Jane', 'customer', 'invoice', 'billing', 'Billing', '2222', '20261101'];

function load(root: string): ScanInput & { all: string } {
  const input = { xml: [] as Array<{ path: string; text: string }>, properties: [] as Array<{ path: string; text: string }>, tests: [] as Array<{ path: string; text: string }> };
  let all = '';
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else {
        const rel = path.relative(root, p).split(path.sep).join('/');
        const text = fs.readFileSync(p, 'utf8');
        all += `${rel}\n${text}\n`;
        const cls = classify(rel);
        if (cls) input[cls].push({ path: rel, text });
      }
    }
  };
  walk(root);
  return { ...input, all };
}

describe.skipIf(!hasPython)('distill_camel_repo.py', () => {
  let tmp: string;
  let original: ReturnType<typeof load>;
  let distilled: ReturnType<typeof load>;
  let stdout: string;
  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ptd-distill-'));
    for (const [rel, text] of Object.entries(REPO)) {
      fs.mkdirSync(path.dirname(path.join(tmp, 'repo', rel)), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'repo', rel), text);
    }
    const run = spawnSync('python3', [SCRIPT, path.join(tmp, 'repo'), '-o', path.join(tmp, 'out'), '--zip'], { encoding: 'utf8' });
    expect(run.status, run.stderr).toBe(0);
    stdout = run.stdout;
    original = load(path.join(tmp, 'repo'));
    distilled = load(path.join(tmp, 'out'));
  });
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('scans to the same triggers and coverage as the original repo', () => {
    const a = scanRepository(original);
    const b = scanRepository(distilled);
    const shape = (o: typeof a) => ({
      otherRoutes: o.otherRoutes,
      testsFound: o.testsFound,
      triggers: o.triggers.map((t) => ({
        kind: t.kind,
        scheme: t.scheme,
        schedule: t.schedule,
        hasPattern: t.filePattern !== null,
        unresolved: t.unresolved.map((u) => u.values.length),
        coveredBy: t.coveredBy.length,
      })),
    });
    expect(shape(b)).toEqual(shape(a));
    // the fixture really exercises every shape: 3 plain triggers, 2 file-name branches, 2 patterns + a schedule in one route
    expect(a.triggers.map((t) => [t.patternKind, t.coveredBy.length])).toEqual([
      ['regex', 1],
      [null, 2], // a marker and a parametrize list both name acme-purge
      ['glob', 1],
      ['condition', 1],
      ['condition', 1],
      ['regex', 0],
      ['regex', 1],
      [null, 0],
    ]);
  });

  it('leaves no original names, secrets or numbers behind', () => {
    for (const word of SENSITIVE) expect(distilled.all, word).not.toContain(word);
    expect(fs.readFileSync(path.join(tmp, 'out.zip')).includes(Buffer.from('acme'))).toBe(false);
    expect(distilled.all).toContain('REDACTED');
  });

  it('keeps the word map outside the shareable folder', () => {
    expect(fs.existsSync(path.join(tmp, 'out.map.json'))).toBe(true);
    expect(fs.existsSync(path.join(tmp, 'out', 'out.map.json'))).toBe(false);
    const map = JSON.parse(fs.readFileSync(path.join(tmp, 'out.map.json'), 'utf8')) as { words: Record<string, string> };
    expect(map.words.acme).toBeTypeOf('string');
    expect(stdout).toMatch(/PRIVATE word map/);
  });

  it('writes a shareable report', () => {
    const report = fs.readFileSync(path.join(tmp, 'out', 'distill-report.md'), 'utf8');
    expect(report).toMatch(/- routes: 6/);
    expect(report).toMatch(/beans > camelContext > route`: 6/);
    expect(report).toMatch(/@allure\.label`: 4/);
    expect(report).toMatch(/- routes with several <from>: 1/);
    expect(report).toMatch(/- <from> listing several file patterns: 1/);
    expect(report).toMatch(/- routes with <choice>\/<filter> on the file name: 1/);
    expect(report).toMatch(/- {3}file-name branches in them: 2/);
    expect(report).toMatch(/operators in file-name conditions: .*`starts with` 1/);
  });
});

describe.skipIf(!hasPython)('distill_camel_repo.py with the routes and the tests in two repos', () => {
  let tmp: string;
  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ptd-distill2-'));
    for (const [rel, text] of Object.entries(REPO)) {
      const repo = rel.includes('/tests/') ? 'acme-tests' : 'acme-camel';
      const target = path.join(tmp, repo, rel.replace('billing-service/', ''));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, text);
    }
    // ids that differ only by a number must stay different
    fs.writeFileSync(
      path.join(tmp, 'acme-camel', 'src/main/resources/camel/acme-years.xml'),
      '<routes><route id="acme-2025-load"><from uri="file:/in?fileName=ACME2025"/></route><route id="acme-2026-load"><from uri="file:/in?fileName=ACME2026"/></route></routes>',
    );
    fs.writeFileSync(path.join(tmp, 'acme-tests', 'tests', 'test_years.py'), 'def test_2026():\n    drop_trigger("ACME2026")\n');
  });
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const run = (...args: string[]) => spawnSync('python3', [SCRIPT, ...args], { encoding: 'utf8' });
  const originals = () => {
    const camel = load(path.join(tmp, 'acme-camel'));
    const tests = load(path.join(tmp, 'acme-tests'));
    return { xml: camel.xml, properties: camel.properties, tests: tests.tests };
  };
  const shape = (o: ReturnType<typeof scanRepository>) =>
    o.triggers.map((t) => ({ kind: t.kind, scheme: t.scheme, pattern: t.patternKind, covered: t.coveredBy.length }));

  it('one run over both repos keeps tests and routes lined up', () => {
    const res = run(path.join(tmp, 'acme-camel'), path.join(tmp, 'acme-tests'), '-o', path.join(tmp, 'both'));
    expect(res.status, res.stderr).toBe(0);
    const distilled = load(path.join(tmp, 'both'));
    const a = scanRepository(originals());
    const b = scanRepository(distilled);
    expect(shape(b)).toEqual(shape(a));
    expect(a.triggers.filter((t) => t.coveredBy.length > 0)).toHaveLength(7);
    // 7 routes (choice branches, patterns and inputs of one route share its id); acme-2025/2026-load stay two
    expect(new Set(b.triggers.map((t) => t.routeId)).size).toBe(7);
    for (const word of SENSITIVE) expect(distilled.all, word).not.toContain(word);
    expect(distilled.all).not.toContain('2026');
  });

  it('a second run with --map lines up with the first', () => {
    expect(run(path.join(tmp, 'acme-camel'), '-o', path.join(tmp, 'routes')).status).toBe(0);
    const res = run(path.join(tmp, 'acme-tests'), '-o', path.join(tmp, 'tests'), '--map', path.join(tmp, 'routes.map.json'));
    expect(res.status, res.stderr).toBe(0);
    const routes = load(path.join(tmp, 'routes'));
    const tests = load(path.join(tmp, 'tests'));
    const b = scanRepository({ xml: routes.xml, properties: routes.properties, tests: tests.tests });
    const a = scanRepository(originals());
    expect(shape(b)).toEqual(shape(a));
  });
});
