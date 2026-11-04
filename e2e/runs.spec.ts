import { expect, test } from '@playwright/test';

test('run detail shows "vs previous run" and failure groups', async ({ page }) => {
  await page.goto('/runs?group=tests%2Fapi');
  const firstRun = page.getByRole('link', { name: /^api nightly #\d+$/ }).first();
  const name = (await firstRun.textContent())!.trim();
  await firstRun.click();
  await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible();

  await expect(page.getByText('vs previous run')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Compare' })).toBeVisible();

  await expect(page.getByRole('tab', { name: /Failures/ })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByText(/failure groups? by normalized error message/)).toBeVisible();
  await expect(page.getByText('NEW', { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/First seen/).first()).toBeVisible();

  await page.getByRole('tab', { name: /All results/ }).click();
  await expect(page.getByRole('tab', { name: /All results/ })).toHaveAttribute('aria-selected', 'true');
});

test('history matrix renders and a cell click opens the test case', async ({ page }) => {
  await page.goto('/runs/history?group=tests%2Fapi');
  const grid = page.getByRole('grid', { name: 'Test history matrix' });
  await expect(grid).toBeVisible();
  await expect(page.getByText(/\d+ tests × \d+ runs/)).toBeVisible();
  // first row's title → we expect to land on that test
  const rowLink = grid.getByRole('rowheader').first().getByRole('link');
  const title = (await rowLink.textContent())!.trim();
  // cells are a visual grid (aria-hidden; the row link is the accessible equivalent)
  await grid.locator('[data-r="0"][data-c]').last().click();
  await expect(page).toHaveURL(/\/tests\/\d+$/);
  await expect(page.getByRole('heading', { name: title, level: 1 })).toBeVisible();
});

test('compare two runs', async ({ page }) => {
  await page.goto('/runs/compare?group=tests%2Fapi');
  const base = page.getByLabel('Base (before)');
  const head = page.getByLabel('Head (after)');
  await expect(base).toBeVisible();
  await expect(head).toBeVisible();
  await expect(page.getByText(/unchanged passing/)).toBeVisible();

  // pick an older base run → the summary follows the selection
  const options = await base.locator('option').allTextContents();
  expect(options.length).toBeGreaterThan(3);
  const baseName = options[3]!.split(' — ')[0]!;
  await base.selectOption({ label: options[3]! });
  await expect(page.getByRole('link', { name: baseName, exact: true })).toBeVisible();
  await expect(page.getByText(/pass rate · \d+ tests/).first()).toBeVisible();
});
