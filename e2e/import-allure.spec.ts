import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { FIXTURES } from './helpers';

const GROUP = 'e2e/fixture';

test('import the allure zip with a run group, then a folder with a broken file (warnings + baseline)', async ({ page }) => {
  await page.goto('/import');
  await expect(page.getByRole('heading', { name: 'Import', level: 1 })).toBeVisible();

  // 1) zip + explicit run group
  await page.getByLabel('Choose zip or result files').setInputFiles(path.join(FIXTURES, 'allure-results.zip'));
  await page.getByLabel('Run group').fill(GROUP);
  await page.getByLabel('Branch').fill('main');
  await page.getByRole('button', { name: 'Upload results' }).click();
  const first = page.getByRole('status').filter({ hasText: 'Imported “' });
  await expect(first).toBeVisible();
  await expect(first).toContainText(GROUP);
  await expect(first).toContainText('14 results');

  // 2) the same results as loose files + one corrupt result file → warning, and a baseline exists now
  const dir = path.join(FIXTURES, 'allure-results');
  const files = fs
    .readdirSync(dir)
    .map((f) => ({ name: f, mimeType: 'application/json', buffer: fs.readFileSync(path.join(dir, f)) }));
  await page.getByLabel('Choose zip or result files').setInputFiles([
    ...files,
    { name: 'deadbeef-0000-result.json', mimeType: 'application/json', buffer: Buffer.from('{ not json') },
  ]);
  await page.getByLabel('Run name').fill('e2e second import');
  await page.getByLabel('Run group').fill(GROUP);
  await page.getByLabel('Branch').fill('main');
  await page.getByRole('button', { name: 'Upload results' }).click();
  const second = page.getByRole('status').filter({ hasText: 'Imported “e2e second import”' });
  await expect(second).toBeVisible();
  await second.getByText(/notes? from the import/).click();
  await expect(second.getByText('deadbeef-0000-result.json: invalid JSON, skipped')).toBeVisible();

  // the new run is listed and opens
  await second.getByRole('link', { name: 'Open run' }).click();
  await expect(page.getByRole('heading', { name: 'e2e second import', level: 1 })).toBeVisible();
  await expect(page.getByText('vs previous run')).toBeVisible();

  await page.goto(`/runs?group=${encodeURIComponent(GROUP)}`);
  await expect(page.getByRole('link', { name: 'e2e second import' })).toBeVisible();
});
