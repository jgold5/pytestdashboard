import { expect, test } from '@playwright/test';

test('report renders and has a print layout', async ({ page }) => {
  await page.goto('/report');
  await expect(page.getByRole('heading', { name: 'Shop QA', level: 1 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Automation coverage' })).toBeVisible();
  const printBtn = page.getByRole('button', { name: 'Print / PDF' });
  await expect(printBtn).toBeVisible();
  await expect(page.locator('main')).not.toContainText(/NaN|undefined|Infinity/);

  await page.emulateMedia({ media: 'print' });
  await expect(printBtn).toBeHidden(); // .no-print controls
  await expect(page.getByText('Workspace', { exact: true })).toBeHidden(); // app header hidden
  await expect(page.getByRole('heading', { name: 'Automation coverage' })).toBeVisible();
  await expect(page.getByRole('img', { name: /Automated cases over time/ })).toBeVisible();
  // light theme forced for print even if the viewer prefers dark
  await page.emulateMedia({ media: 'print', colorScheme: 'dark' });
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(bg).toBe('rgb(255, 255, 255)');
  const pdf = await page.pdf({ format: 'A4', landscape: true, printBackground: true });
  expect(pdf.byteLength).toBeGreaterThan(10_000);
});
