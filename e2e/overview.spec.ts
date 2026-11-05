import { expect, test } from '@playwright/test';

test('overview renders KPIs from the seeded data', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Overview', level: 1 })).toBeVisible();
  for (const label of ['Total cases', 'Automated', 'In progress', 'Last run pass rate', 'Untriaged failures']) {
    await expect(page.getByText(label, { exact: true }).first()).toBeVisible();
  }
  await expect(page.getByText('120', { exact: true }).first()).toBeVisible(); // seeded total
  await expect(page.getByText(/^\d{1,3}(\.\d)?%$/).first()).toBeVisible();
  await expect(page.getByRole('img', { name: /Results of the last \d+ runs by status/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'By suite' })).toBeVisible();
  // nothing un-formatted leaked into the page
  await expect(page.locator('main')).not.toContainText(/NaN|undefined|Infinity|\d{4}-\d\d-\d\dT\d\d:/);
});
