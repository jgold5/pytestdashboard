import { describe, expect, it } from 'vitest';
import { scopeSelection } from '../components/ScopeButton';

// the server's answer for the previous pick: what the picker must not wait for
const d = {
  routeBranches: ['main', 'core', 'dev'],
  defaultBranch: 'main',
  testBranches: ['main', 'develop', 'core'],
  triggerRepo: { branch: 'main' },
  testRepo: { branch: 'main' },
};

describe('the scope picker shows a pick at once', () => {
  it('a routes branch picked shows before the server answers', () => {
    expect(scopeSelection({ branch: 'dev', tests: null }, d).routes).toBe('dev');
  });
  it('a tests branch picked shows before the server answers', () => {
    expect(scopeSelection({ branch: null, tests: 'develop' }, d).tests).toBe('develop');
  });
  it('no tests branch picked: the one named like the routes branch, else the default', () => {
    expect(scopeSelection({ branch: 'core', tests: null }, d).tests).toBe('core');
    expect(scopeSelection({ branch: 'dev', tests: null }, d).tests).toBe('main');
  });
  it('a routes branch that has no scan falls back to the default, like the server', () => {
    expect(scopeSelection({ branch: 'gone', tests: null }, d).routes).toBe('main');
  });
  it('a tests branch the list does not show (from a link): the server\'s answer', () => {
    expect(scopeSelection({ branch: null, tests: 'feature/x' }, { ...d, testRepo: { branch: 'feature/x' } }).tests).toBe('feature/x');
  });
});

describe('folder picks', () => {
  it('splits and labels several folders', async () => {
    const { splitFolders, folderLabel } = await import('@ptd/shared');
    expect(splitFolders('common, billing,common,')).toEqual(['common', 'billing']);
    expect(splitFolders(null)).toEqual([]);
    expect(folderLabel('common')).toBe('common/');
    expect(folderLabel('common,billing')).toBe('common/ + billing/');
    expect(folderLabel('a,b,c')).toBe('3 folders');
    expect(folderLabel('')).toBeNull();
  });
});

describe('leaving routes out and saved filters', () => {
  it('a word is a start (any case); * stands for anything', async () => {
    const { excludedBy, excludeLabel } = await import('@ptd/shared');
    expect(excludedBy('download-invoices', 'download')).toBe('download');
    expect(excludedBy('Download_Credits', 'download')).toBe('download');
    expect(excludedBy('invoice-download', 'download')).toBeNull();
    expect(excludedBy('invoice-download', '*download*')).toBe('*download*');
    expect(excludedBy('invoice-load', 'download, *-load')).toBe('*-load');
    expect(excludedBy(null, 'download')).toBeNull();
    expect(excludeLabel('download, *-test')).toBe('not download… or *-test');
  });
  it('a saved filter is the one picked when folders, types and exclusion are the same, in any order', async () => {
    const { activePreset } = await import('../components/ScopeButton');
    const p = { id: 'a', name: 'Loads', folder: 'common,billing', kinds: ['file', 'schedule'] as const, exclude: 'download', baseline: null };
    const presets = [{ ...p, kinds: [...p.kinds] }];
    expect(activePreset(presets, { folder: 'billing,common', kinds: 'schedule,file', exclude: 'Download' })?.id).toBe('a');
    expect(activePreset(presets, { folder: 'common', kinds: 'schedule,file', exclude: 'download' })).toBeNull();
    expect(activePreset(presets, { folder: 'billing,common', kinds: 'schedule,file', exclude: null })).toBeNull();
  });
});

describe('leave out by trigger name', () => {
  it('matches a file pattern, an endpoint name or the route id, not the folder watched', async () => {
    const { excludedBy } = await import('@ptd/shared');
    const file = (filePattern: string, routeId = 'invoice-load', resolvedUri = 'file:/data/in') => ({ routeId, filePattern, resolvedUri });
    expect(excludedBy(file('DOWNLOAD_INV.*\\.csv'), 'download')).toBe('download');
    expect(excludedBy(file('^(Download_X|Y).*'), 'download')).toBe('download');
    expect(excludedBy(file('INV.TXT'), 'download')).toBeNull();
    expect(excludedBy(file('INV.TXT', 'invoice-load', 'file:/data/download'), 'download')).toBeNull(); // the folder isn't the name
    expect(excludedBy(file('INV.TXT', 'download-invoices'), 'download')).toBe('download');
    expect(excludedBy({ routeId: 'x', filePattern: null, resolvedUri: 'direct:downloadJob' }, 'download')).toBe('download');
    expect(excludedBy({ routeId: 'x', filePattern: null, resolvedUri: 'seda://downloads?concurrentConsumers=2' }, 'download')).toBe('download');
    expect(excludedBy({ routeId: 'x', filePattern: null, resolvedUri: 'rest:get:/download/all' }, 'download')).toBe('download');
    expect(excludedBy({ routeId: 'x', filePattern: null, resolvedUri: 'rest:get:/api/download/all' }, 'download')).toBeNull(); // a path starts at its first segment
    expect(excludedBy({ routeId: 'x', firesOn: 'kafka:download-events' }, 'download')).toBe('download');
    expect(excludedBy({ routeId: 'x', firesOn: '0 0 2 * * ?' }, 'download')).toBeNull();
  });
});

describe('leave out by one kind of name', () => {
  it('route:, file: and endpoint: look only at that name; no prefix looks at all three', async () => {
    const { excludedBy, describeExcludePattern } = await import('@ptd/shared');
    const byFile = { routeId: 'invoice-load', filePattern: 'DOWNLOAD_INV.*', resolvedUri: 'file:/in' };
    const byRoute = { routeId: 'download-invoices', filePattern: 'INV.TXT', resolvedUri: 'file:/in' };
    const byEndpoint = { routeId: 'job-a', filePattern: null, resolvedUri: 'direct:downloadJob' };
    expect([byFile, byRoute, byEndpoint].map((t) => excludedBy(t, 'download'))).toEqual(['download', 'download', 'download']);
    expect([byFile, byRoute, byEndpoint].map((t) => excludedBy(t, 'file:download'))).toEqual(['file:download', null, null]);
    expect([byFile, byRoute, byEndpoint].map((t) => excludedBy(t, 'route:download'))).toEqual([null, 'route:download', null]);
    expect([byFile, byRoute, byEndpoint].map((t) => excludedBy(t, 'Endpoint: download'))).toEqual([null, null, 'endpoint: download']);
    expect(excludedBy('download-x', 'file:download')).toBeNull(); // a bare route id is only a route id
    expect(describeExcludePattern('file:download')).toBe('file names starting with download');
    expect(describeExcludePattern('*download*')).toBe('names matching *download*');
  });
});
