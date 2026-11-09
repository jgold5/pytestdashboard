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
