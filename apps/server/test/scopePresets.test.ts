import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ScopePresets, TriggerOverviewResponse } from '@ptd/shared';
import { createTestApp, multipart, type TestApp } from './helpers/app.js';

describe('leaving routes out, and saved filters', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await createTestApp();
  });
  afterEach(async () => t.close());

  const scan = async (routes: string) => {
    const mp = multipart({ branch: 'main', only: 'routes' }, [
      { field: 'file:src/main/resources/common/routes', filename: 'a.xml', content: `<routes>${routes}</routes>` },
      { field: 'file:src/main/resources/billing/routes', filename: 'b.xml', content: '<routes><route id="credit-load"><from uri="file:/in?fileName=CRN.TXT"/></route></routes>' },
    ]);
    const res = await t.app.inject({ method: 'POST', url: '/api/triggers/scan', payload: mp.payload, headers: mp.headers });
    expect(res.statusCode, res.body).toBe(201);
  };
  const COMMON = [
    '<route id="invoice-load"><from uri="file:/in?fileName=INV.TXT"/></route>',
    '<route id="download-invoices"><from uri="file:/in?fileName=DL.TXT"/></route>',
    '<route id="Download-Credits"><from uri="file:/in?fileName=DLC.TXT"/></route>',
    '<route id="purge"><from uri="quartz://p?cron=0+0+2+*+*+?"/></route>',
    '<route id="ship-worker"><from uri="seda:ship"/></route>',
  ];
  const total = async (q: string) => (await t.app.inject({ url: `/api/summary?${q}` })).json<{ coverage: { total: number; exclude?: string } }>().coverage;
  const overview = async (q: string) => (await t.app.inject({ url: `/api/triggers/overview?${q}` })).json<TriggerOverviewResponse>();

  it('leaves out route ids starting with a word (any case), or matching a * pattern, from every count', async () => {
    await scan(COMMON.join(''));
    expect((await total('')).total).toBe(6);
    expect(await total('exclude=download')).toMatchObject({ total: 4, exclude: 'download' });
    expect((await total('exclude=*-load')).total).toBe(4); // invoice-load, credit-load
    expect((await total('exclude=download,purge')).total).toBe(3);
    expect((await total('exclude=load')).total).toBe(6); // a start, not anywhere: no id starts with "load"
    // with folders and kinds: load files + schedules in common, not download…
    const ov = await overview('folder=common&kinds=file,schedule&exclude=download');
    expect(ov).toMatchObject({ exclude: 'download', excluded: 2, triggerRepo: { triggers: 2 } });
    expect(ov.folders.find((f) => f.folder === 'common')!.triggers).toBe(2); // folder counts follow the kinds and exclusion picked
    expect(ov.kindCounts.find((k) => k.kind === 'file')!.triggers).toBe(1); // invoice-load only
    expect((await t.app.inject({ url: '/api/report?exclude=download' })).json<{ coverage: { total: number } }>().coverage.total).toBe(4);
  });

  it('leaves out a trigger whose file name or endpoint name starts with the word, whatever the route id', async () => {
    await scan(
      [
        '<route id="invoice-load"><from uri="file:/in?include=DOWNLOAD_INV.*\\.csv"/></route>',
        '<route id="credit-pull"><from uri="file:/download?fileName=CRN.TXT"/></route>',
        '<route id="job-a"><from uri="direct:downloadJob"/></route>',
        '<route id="two-files"><from uri="file:/in?include=(Download_A|KEEP_B).*"/></route>',
        '<route id="purge"><from uri="quartz://p?cron=0+0+2+*+*+?"/></route>',
      ].join(''),
    );
    const all = (await total('')).total;
    const left = (await total('exclude=download')).total;
    // DOWNLOAD_INV.*, direct:downloadJob and the (Download_A|KEEP_B) pattern start with download; CRN.TXT in /download doesn't
    expect(all - left).toBe(3);
    const ov = await overview('exclude=download');
    expect(ov.excluded).toBe(3);
    // one kind of name: file:, endpoint:, route:
    expect(all - (await total('exclude=file:download')).total).toBe(2);
    expect(all - (await total('exclude=endpoint:download')).total).toBe(1);
    expect(all - (await total('exclude=route:download')).total).toBe(0);
  });

  it('a saved filter keeps the routes it held when saved, so routes added later can be told apart', async () => {
    await scan(COMMON.join(''));
    const preset = { id: 'loads', name: 'Common loads', folder: 'common', kinds: ['file', 'schedule'], exclude: 'download', baseline: null };
    const put = await t.app.inject({ method: 'PUT', url: '/api/scope-presets', payload: { presets: [preset] } });
    expect(put.statusCode, put.body).toBe(200);
    const saved = put.json<ScopePresets>().presets[0]!;
    expect(saved.baseline).toMatchObject({ branch: 'main', routes: ['common/invoice-load', 'common/purge'] });

    // a new route in scope: the baseline doesn't change by itself
    await scan([...COMMON, '<route id="refund-load"><from uri="file:/in?fileName=REF.TXT"/></route>'].join(''));
    expect((await t.app.inject({ url: '/api/scope-presets' })).json<ScopePresets>().presets[0]!.baseline!.routes).toEqual(['common/invoice-load', 'common/purge']);
    // the overview says which routes are new to it (and which are gone)
    const fresh = await overview('folder=common&kinds=file,schedule&exclude=download&preset=loads');
    expect(fresh.fresh).toMatchObject({ preset: 'loads', branch: 'main', added: ['common/refund-load'], gone: [] });
    expect((await overview('preset=loads&branch=nope')).fresh).toMatchObject({ added: ['common/refund-load'] }); // unknown branch: the default, like every count
    expect((await overview('preset=nope')).fresh).toBeNull();
    // renaming keeps it; the client can't set it
    const renamed = await t.app.inject({ method: 'PUT', url: '/api/scope-presets', payload: { presets: [{ ...saved, name: 'Loads', baseline: { at: 'x', branch: 'x', routes: [] } }] } });
    expect(renamed.json<ScopePresets>().presets[0]).toMatchObject({ name: 'Loads', baseline: { routes: ['common/invoice-load', 'common/purge'] } });
    // mark as seen: the routes now become the baseline
    const seen = await t.app.inject({ method: 'POST', url: '/api/scope-presets/loads/seen' });
    expect(seen.json<ScopePresets>().presets[0]!.baseline!.routes).toEqual(['common/invoice-load', 'common/purge', 'common/refund-load']);
    // changing what the filter picks takes a new baseline
    const wider = await t.app.inject({ method: 'PUT', url: '/api/scope-presets', payload: { presets: [{ ...saved, exclude: null }] } });
    expect(wider.json<ScopePresets>().presets[0]!.baseline!.routes).toHaveLength(5);
    expect((await t.app.inject({ method: 'POST', url: '/api/scope-presets/nope/seen' })).statusCode).toBe(400);
    expect((await t.app.inject({ method: 'PUT', url: '/api/scope-presets', payload: { presets: [preset, preset] } })).statusCode).toBe(400);
  });
});
