import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SheetComparePreviewResponse, SheetCompareResponse } from '@ptd/shared';
import { createTestApp, multipart, type TestApp } from './helpers/app.js';

describe('compare with my sheet', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await createTestApp();
  });
  afterEach(async () => t.close());

  const up = async (fields: Record<string, string>, files: Array<{ field: string; filename: string; content: string }>) => {
    const mp = multipart(fields, files);
    const res = await t.app.inject({ method: 'POST', url: '/api/triggers/scan', payload: mp.payload, headers: mp.headers });
    expect(res.statusCode, res.body).toBe(201);
  };

  it('lines up the sheet with the routes counted, field by field, and says why a route is on one side only', async () => {
    await up({ branch: 'main', only: 'routes' }, [
      {
        field: 'file:src/main/resources/common/routes',
        filename: 'billing.xml',
        content: `<routes>
          <route id="invoice-load"><from uri="file:/in?include=INV_.*|CRN_.*"/></route>
          <route id="nightly-purge"><from uri="quartz2://jobs/nightlyPurge?cron=0+0+2+*+*+?"/></route>
          <route id="parse-invoice"><from uri="direct:parseInvoice"/></route>
          <route id="orders-worker"><from uri="seda:orders"/></route>
          <route id="audit"><from uri="bean:audit"/></route>
        </routes>`,
      },
    ]);
    await up({ branch: 'main', only: 'tests' }, [
      { field: 'file:tests/billing', filename: 'test_invoice.py', content: '@pytest.mark.route("invoice-load")\ndef test_invoice():\n    pass\n\n@pytest.mark.route("nightly-purge")\ndef test_purge():\n    pass\n' },
    ]);
    await up({ branch: 'feature/orders', only: 'tests', label: 'acme/tests PR #12 → main' }, [
      { field: 'file:tests/billing', filename: 'test_invoice.py', content: '@pytest.mark.route("invoice-load")\ndef test_invoice():\n    pass\n\n@pytest.mark.route("nightly-purge")\ndef test_purge():\n    pass\n' },
      { field: 'file:tests/orders', filename: 'test_orders.py', content: '@pytest.mark.route("orders-worker")\ndef test_orders():\n    pass\n' },
    ]);

    const csv = [
      'route_id,xml,entry_kind,triggers,automated,where,test_files,prs',
      'invoice-load,billing.xml,file,2,yes,merged,test_invoice.py,',
      'nightly-purge,billing.xml,quartz,1,no,merged,,',
      'orders-worker,billing.xml,seda,1,yes,PR,test_orders.py,#12',
      'audit,billing.xml,bean,1,no,,,',
      'invoice-laod,billing.xml,file,1,no,,,',
    ].join('\n');
    const mp = multipart({}, [{ field: 'file', filename: 'mine.csv', content: csv, contentType: 'text/csv' }]);
    const pre = await t.app.inject({ method: 'POST', url: '/api/triggers/compare-sheet/preview', payload: mp.payload, headers: mp.headers });
    expect(pre.statusCode, pre.body).toBe(200);
    const preview = pre.json<SheetComparePreviewResponse>();
    expect(preview.sheets[0]!.columns).toEqual({
      routeId: 'route_id',
      xml: 'xml',
      kind: 'entry_kind',
      triggers: 'triggers',
      automated: 'automated',
      where: 'where',
      testFiles: 'test_files',
      prs: 'prs',
    });

    const res = await t.app.inject({
      method: 'POST',
      url: '/api/triggers/compare-sheet',
      payload: { uploadId: preview.uploadId, sheet: preview.sheets[0]!.name, columns: preview.sheets[0]!.columns },
    });
    expect(res.statusCode, res.body).toBe(200);
    const cmp = res.json<SheetCompareResponse>();
    expect(cmp.counts).toEqual({ sheetRows: 5, routes: 4, match: 2, differs: 1, sheetOnly: 2, dashboardOnly: 1, outside: 0 });
    const by = Object.fromEntries(cmp.rows.map((r) => [r.routeId, r]));
    expect(by['invoice-load']).toMatchObject({ status: 'match', sheetRow: 2 });
    expect(by['orders-worker']).toMatchObject({ status: 'match' }); // only in PR #12, as the sheet says
    expect(by['nightly-purge']).toMatchObject({ status: 'differs', diffs: [{ field: 'automated', sheet: 'no', dashboard: '1 of 1 trigger tested' }] });
    expect(by['audit']!.status).toBe('sheetOnly');
    expect(by['audit']!.note).toContain('starts from bean:audit, which is not a trigger type');
    expect(by['invoice-laod']!.note).toContain('closest id there: invoice-load');
    expect(by['parse-invoice']).toMatchObject({ status: 'dashboardOnly' });
    expect(by['parse-invoice']!.note).toContain('The sheet has no Direct routes');
    expect(by['parse-invoice']!.note).toContain('another route calls it');
    expect(by['parse-invoice']!.note).toContain('Found at src/main/resources/common/routes/billing.xml:4.');
    expect(cmp.fieldCounts.automated).toBe(1);

    // the scope's folder and types apply: only queue routes
    const q = await t.app.inject({
      method: 'POST',
      url: '/api/triggers/compare-sheet',
      payload: { uploadId: preview.uploadId, sheet: preview.sheets[0]!.name, columns: preview.sheets[0]!.columns, kinds: ['queue'] },
    });
    const only = q.json<SheetCompareResponse>();
    // the sheet's rows outside the types picked aren't compared: they're "outside", not "only in the sheet"
    expect(only.counts).toMatchObject({ routes: 1, match: 1, dashboardOnly: 0, outside: 2, sheetOnly: 2 });
    expect(only.rows.find((r) => r.routeId === 'invoice-load')).toMatchObject({ status: 'outside', note: expect.stringContaining('outside the folder/types picked') });
    expect(only.rows.find((r) => r.routeId === 'audit')!.status).toBe('sheetOnly'); // not counted anywhere: still a difference

    // several folders: the routes in any of them
    const cmpFolders = async (folder: string) =>
      (
        await t.app.inject({
          method: 'POST',
          url: '/api/triggers/compare-sheet',
          payload: { uploadId: preview.uploadId, sheet: preview.sheets[0]!.name, columns: preview.sheets[0]!.columns, folder },
        })
      ).json<SheetCompareResponse>();
    expect(await cmpFolders('common,other')).toMatchObject({ folder: 'common,other', counts: { routes: 4 } });
    expect((await cmpFolders('other')).counts.routes).toBe(0);
  });
});
