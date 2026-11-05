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
  </camelContext>
</beans>
`,
  'billing-service/properties/acme-dev.properties': 'acme.invoice.dir=/srv/acme/dev/invoices\nacme.purge.cron=0 0 2 * * ?\nacme.db.password=TopSecret99\n',
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
    expect(a.triggers.map((t) => t.coveredBy.length)).toEqual([1, 1, 1]); // the fixture really links all three
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
    expect(report).toMatch(/- routes: 4/);
    expect(report).toMatch(/beans > camelContext > route`: 4/);
    expect(report).toMatch(/@allure\.label`: 1/);
  });
});
