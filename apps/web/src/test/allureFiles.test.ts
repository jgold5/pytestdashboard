import { describe, expect, it } from 'vitest';
import { isAllowedAllureFile, planAllureUpload } from '../lib/allureFiles';

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
