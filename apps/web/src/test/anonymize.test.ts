import { describe, expect, it } from 'vitest';
import type { SheetCompareResponse } from '@ptd/shared';
import { Anonymizer, anonymizeDeep } from '../lib/anonymize';

const result: SheetCompareResponse = {
  routesFrom: 'core',
  testsFrom: 'core',
  folder: 'billing',
  kinds: ['file', 'queue'],
  columns: { routeId: 'route_id', xml: 'xml', automated: 'automated', testFiles: 'test_files', prs: 'prs' },
  counts: { sheetRows: 3, routes: 3, match: 1, differs: 1, sheetOnly: 1, dashboardOnly: 1 },
  fieldCounts: { kind: 0, triggers: 0, automated: 1, where: 0, testFiles: 1, prs: 0 },
  rows: [
    {
      status: 'differs',
      routeId: 'acmeInvoiceLoad',
      sheetRow: 2,
      diffs: [
        { field: 'automated', sheet: 'yes', dashboard: 'no test names it (it runs via acme-orders-load, which is tested)' },
        { field: 'testFiles', sheet: 'test_acme_invoice.py', dashboard: 'test_acme_invoice.py says "ACME_INVOICE_20260101.csv", a name of this route, but only as a plain word' },
      ],
      note: null,
      sheet: { routeId: 'acmeInvoiceLoad', xml: 'acme-billing.xml', automated: 'yes', testFiles: 'test_acme_invoice.py' },
      dashboard: {
        routeId: 'acmeInvoiceLoad',
        module: 'billing',
        sourceFile: 'src/main/resources/billing/routes/acme-billing.xml',
        line: 30,
        kinds: ['file'],
        schemes: ['sftp'],
        triggers: 1,
        tested: 0,
        testedInPrOnly: 0,
        testFiles: [],
        prBranches: [],
        prNumbers: [],
        runVia: ['acme-orders-load'],
      },
    },
    {
      status: 'sheetOnly',
      routeId: 'acme-legacy-export',
      sheetRow: 3,
      diffs: [],
      note: 'In src/main/resources/billing/routes/acme-billing.xml:44, not counted: it starts from bean:acmeAudit, which is not a trigger type',
      sheet: { routeId: 'acme-legacy-export' },
      dashboard: null,
    },
  ],
};

describe('anonymizing a sheet comparison for sharing', () => {
  const a = new Anonymizer();
  const out = anonymizeDeep(result, a, new Set(['status', 'field', 'kinds', 'kind', 'schemes', 'columns', 'sheetRow', 'line']));
  const text = JSON.stringify(out);

  it('leaves none of the names in it', () => {
    for (const name of ['acme', 'Acme', 'ACME', 'invoice', 'Invoice', 'INVOICE', 'billing', 'legacy', 'export', 'Audit', 'core', '20260101'])
      expect(text, name).not.toContain(name);
  });

  it('renames each name the same everywhere, keeping its length and shape', () => {
    const row = out.rows[0]!;
    expect(row.routeId).toBe(row.dashboard!.routeId);
    expect(row.routeId).toBe(row.sheet!.routeId);
    expect(row.routeId).toHaveLength('acmeInvoiceLoad'.length);
    expect(row.routeId).toMatch(/^[a-z]+[A-Z][a-z]+Load$/); // camelCase kept; "load" is a generic word
    // acme-orders-load in a sentence is renamed like the same words elsewhere
    expect(row.dashboard!.runVia![0]).toBe(a.text('acme-orders-load'));
    expect(row.diffs[0]!.dashboard).toContain(`it runs via ${a.text('acme-orders-load')}, which is tested`);
    expect(out.rows[1]!.note).toContain(a.text('src/main/resources/billing/routes/acme-billing.xml:44'));
  });

  it('keeps the dashboard’s own words, the field names and short numbers', () => {
    expect(out.rows[0]!.diffs[0]!.dashboard).toMatch(/^no test names it \(it runs via [a-z]+-[a-z]+-load, which is tested\)$/);
    expect(out.rows[1]!.note).toMatch(/not counted: it starts from bean:[a-z]+[A-Z][a-z]+, which is not a trigger type$/);
    expect(out.rows[0]!.status).toBe('differs');
    expect(out.rows[0]!.diffs.map((d) => d.field)).toEqual(['automated', 'testFiles']);
    expect(out.kinds).toEqual(['file', 'queue']);
    expect(out.rows[0]!.sheetRow).toBe(2);
    expect(out.rows[0]!.dashboard!.line).toBe(30);
  });

  it('the key turns the made-up names back into the real ones', () => {
    const key = a.key();
    const made = out.rows[0]!.dashboard!.module!;
    expect(key.words[made]).toBe('billing');
    expect(Object.values(key.numbers)).toContain('20260101');
  });
});
