import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { FIXTURES } from './helpers';

const GROUP = 'e2e/fixture';

test('import the allure zip with a run group, then a folder with a broken file (warnings + baseline)', async ({ page }) => {
  await page.goto('/import');
  await expect(page.getByRole('heading', { name: 'Import', level: 1 })).toBeVisible();
  const card = page.locator('#allure');

  // 1) zip + explicit run group
  await card.getByLabel('Choose zip or result files').setInputFiles(path.join(FIXTURES, 'allure-results.zip'));
  await card.getByLabel('Run group').fill(GROUP);
  await card.getByLabel('Branch').fill('main');
  await card.getByRole('button', { name: 'Upload results' }).click();
  const first = card.getByRole('status').filter({ hasText: 'Imported “' });
  await expect(first).toBeVisible();
  await expect(first).toContainText(GROUP);
  await expect(first).toContainText('14 results');

  // 2) the same results as loose files + one corrupt result file → warning, and a baseline exists now
  const dir = path.join(FIXTURES, 'allure-results');
  const files = fs
    .readdirSync(dir)
    .map((f) => ({ name: f, mimeType: 'application/json', buffer: fs.readFileSync(path.join(dir, f)) }));
  await card.getByLabel('Choose zip or result files').setInputFiles([
    ...files,
    { name: 'deadbeef-0000-result.json', mimeType: 'application/json', buffer: Buffer.from('{ not json') },
  ]);
  await card.getByLabel('Run name').fill('e2e second import');
  await card.getByLabel('Run group').fill(GROUP);
  await card.getByLabel('Branch').fill('main');
  await card.getByRole('button', { name: 'Upload results' }).click();
  const second = card.getByRole('status').filter({ hasText: 'Imported “e2e second import”' });
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

test('import run history: allure-history snapshot plus raw folder of the same run', async ({ page }) => {
  const HISTORY_GROUP = 'e2e/history';
  await page.goto('/import#history');
  const card = page.locator('#history');
  await expect(card.getByRole('heading', { name: 'Run history' })).toBeVisible();

  // a snapshot written by allureparser → one run named after its label
  await card.getByLabel('History: Choose zip or result files').setInputFiles(path.join(FIXTURES, 'build-412.snapshot.json.gz'));
  await expect(card.getByText('1 snapshot')).toBeVisible();
  await card.getByLabel('History run group').fill(HISTORY_GROUP);
  await card.getByRole('button', { name: 'Import history' }).click();
  const done = card.getByRole('status').filter({ hasText: 'Imported 1 run' });
  await expect(done).toBeVisible();
  await expect(done.getByRole('link', { name: '#412' })).toBeVisible();

  // the raw results of that same run are recognised as already imported
  const dir = path.join(FIXTURES, 'allure-results');
  await card.getByLabel('History: Choose zip or result files').setInputFiles(
    fs.readdirSync(dir).map((f) => ({ name: f, mimeType: 'application/json', buffer: fs.readFileSync(path.join(dir, f)) })),
  );
  await card.getByLabel('History run group').fill(HISTORY_GROUP);
  await card.getByRole('button', { name: 'Import history' }).click();
  await expect(card.getByRole('status').filter({ hasText: 'Imported 0 runs' })).toContainText('1 run already imported');
});
