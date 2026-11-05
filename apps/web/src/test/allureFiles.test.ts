import { describe, expect, it } from 'vitest';
import { folderOf, isAllowedAllureFile, planAllureUpload } from '../lib/allureFiles';

const f = (name: string, size = 10) => new File(['x'.repeat(size)], name);

describe('allure file allowlist', () => {
  it('keeps only result-related files', () => {
    expect(isAllowedAllureFile('allure-results/abc-result.json')).toBe(true);
    expect(isAllowedAllureFile('abc-container.json')).toBe(true);
    expect(isAllowedAllureFile('environment.properties')).toBe(true);
    expect(isAllowedAllureFile('executor.json')).toBe(true);
    expect(isAllowedAllureFile('categories.json')).toBe(true);
    expect(isAllowedAllureFile('abc-attachment.png')).toBe(false);
    expect(isAllowedAllureFile('video.webm')).toBe(false);
    expect(isAllowedAllureFile('evil-result.json.exe')).toBe(false);
  });

  it('plans a folder upload, skipping attachments', () => {
    const plan = planAllureUpload([f('a-result.json'), f('b-result.json'), f('environment.properties'), f('shot.png', 5000)]);
    expect(plan.kind).toBe('files');
    expect(plan.files.map((x) => x.name)).toEqual(['a-result.json', 'b-result.json', 'environment.properties']);
    expect(plan.ignored).toBe(1);
    expect(plan.resultCount).toBe(2);
    expect(plan.error).toBeUndefined();
  });

  it('accepts a single zip and rejects mixing zips with files', () => {
    expect(planAllureUpload([f('results.zip')]).kind).toBe('zip');
    expect(planAllureUpload([f('results.zip'), f('a-result.json')]).error).toBeTruthy();
  });

  it('errors when no result files are present', () => {
    const plan = planAllureUpload([f('readme.md')]);
    expect(plan.kind).toBe('empty');
    expect(plan.error).toMatch(/No allure result files/);
  });
});

describe('history uploads', () => {
  it('accepts allure-history snapshots only in history mode', () => {
    expect(isAllowedAllureFile('history/build-12.snapshot.json.gz')).toBe(false);
    expect(isAllowedAllureFile('history/build-12.snapshot.json.gz', { snapshots: true })).toBe(true);
    expect(isAllowedAllureFile('archive.tar.gz', { snapshots: true })).toBe(false);
  });

  it('counts snapshots and result folders', () => {
    const inFolder = (dir: string, name: string) => {
      const file = f(name);
      Object.defineProperty(file, 'webkitRelativePath', { value: `${dir}/${name}` });
      return file;
    };
    const plan = planAllureUpload(
      [inFolder('ci/build-1', 'a-result.json'), inFolder('ci/build-2', 'a-result.json'), inFolder('ci/history', 'build-3.snapshot.json.gz')],
      { snapshots: true },
    );
    expect(plan.error).toBeUndefined();
    expect([plan.resultCount, plan.snapshotCount, plan.folderCount]).toEqual([2, 1, 2]);
    expect(folderOf(plan.files[0]!)).toBe('ci/build-1');
    expect(planAllureUpload([f('build-3.snapshot.json.gz')], { snapshots: true }).error).toBeUndefined();
    expect(planAllureUpload([f('build-3.snapshot.json.gz')]).error).toMatch(/No allure result files/);
  });
});
