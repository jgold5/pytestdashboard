import { expect, test } from '@playwright/test';

test('a product_bug note with a Jira link auto-creates a bug (plain-text title) shown on Bugs', async ({ page }) => {
  await page.goto('/tests?search=Gift%20wrap');
  await page.getByRole('link', { name: 'Gift wrap', exact: true }).first().click();
  await expect(page.getByRole('heading', { name: 'Gift wrap', level: 1 })).toBeVisible();

  await page.getByLabel('Your name').fill('E2E Bot');
  await page.getByLabel('Note', { exact: true }).fill('## **Gift wrap** total ignores `tax`\nSee [log](https://ci.example.com/1)');
  await page.getByRole('combobox', { name: 'Triage' }).click();
  await page.getByRole('option', { name: 'Product bug' }).click();
  await page.getByLabel('Ticket URL').fill('https://acme.atlassian.net/browse/E2E-101');
  await page.getByRole('button', { name: 'Add note' }).click();

  // note rendered (markdown, no raw HTML) with its triage badge
  await expect(page.getByRole('link', { name: 'log' })).toHaveAttribute('rel', /noopener/);
  // the auto-created bug is linked on the case…
  await expect(page.getByRole('link', { name: /E2E-101/ }).first()).toBeVisible();

  // …and listed on the Bugs page with a markdown-free title
  await page.goto('/bugs');
  const row = page.getByRole('row').filter({ hasText: 'E2E-101' });
  await expect(row).toBeVisible();
  await expect(row).toContainText('Gift wrap total ignores tax');
  await expect(row).not.toContainText('**');
});
