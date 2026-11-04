import { expect, test } from '@playwright/test';
import { settled } from './helpers';

test('overview pipeline funnel → "Ready to merge" → filtered test case list', async ({ page }) => {
  await page.goto('/');
  const funnel = page.getByRole('list', { name: 'Automation pipeline' });
  await expect(funnel).toBeVisible();
  for (const stage of ['Not started', 'In progress', 'PR draft', 'In review', 'Ready to merge', 'Merged (awaiting run)', 'Automated']) {
    await expect(funnel.getByRole('link', { name: new RegExp(`^${stage.replace(/[()]/g, '\\$&')}: \\d+ test cases?$`) })).toBeVisible();
  }
  const ready = funnel.getByRole('link', { name: /^Ready to merge: \d+ test cases?$/ });
  const n = Number((await ready.getAttribute('aria-label'))!.match(/: (\d+)/)![1]);
  expect(n).toBeGreaterThan(1); // the seed has several ready-to-merge cases

  // the prominent "done, awaiting merge" callout lists the approved PRs
  const callout = page.getByRole('region', { name: `${n} tests done, awaiting merge` });
  await expect(callout).toBeVisible();
  await expect(callout.getByRole('link', { name: /acme\/camel-routes-tests#\d+/ }).first()).toBeVisible();
  await expect(callout.getByText(/approved .* ago/).first()).toBeVisible();

  await ready.click();
  await expect(page).toHaveURL(/\/tests\?pipelineStage=ready_to_merge$/);
  await expect(page.getByRole('heading', { name: 'Test cases', level: 1 })).toBeVisible();
  await settled(page);
  await expect(page.getByText(`${n} matching`)).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Pipeline stage' })).toContainText('Ready to merge');
  const rows = page.locator('table tbody tr');
  await expect(rows).toHaveCount(n);
  for (const row of await rows.all()) await expect(row.getByText('Ready to merge', { exact: true })).toBeVisible();

  // the case detail explains the stage and the PR driving it
  await rows.first().getByRole('link', { name: /^TC-\d+$/ }).click();
  await expect(page.getByRole('heading', { name: 'Automation pipeline' })).toBeVisible();
  await expect(page.getByText(/Done: approved, checks green/)).toBeVisible();
  await expect(page.getByText(/Driven by #\d+/)).toBeVisible();
});

test('pull requests page: Ready to merge filter', async ({ page }) => {
  await page.goto('/pulls');
  // default view: ready-to-merge PRs get their own section on top
  const section = page.locator('table').getByText(/Ready to merge · \d+ — approved/);
  await expect(section).toBeVisible();
  const n = Number((await section.textContent())!.match(/· (\d+)/)![1]);
  await page.getByRole('tab', { name: 'Ready to merge' }).click();
  await expect(page).toHaveURL(/filter=ready/);
  await expect(section).toHaveCount(0);
  const rows = page.locator('table tbody tr');
  await expect(rows).toHaveCount(n);
  for (const row of await rows.all()) await expect(row.getByText('Ready to merge', { exact: true })).toBeVisible();
});
