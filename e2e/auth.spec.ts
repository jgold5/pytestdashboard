import { expect, test } from '@playwright/test';
import { E2E } from './env.mjs';

// These tests start signed out.
test.use({ storageState: { cookies: [], origins: [] } });

test('login rejects a wrong token, accepts the editor token', async ({ page }) => {
  await page.goto('/tests');
  await expect(page).toHaveURL(/\/login\?next=%2Ftests/);
  const token = page.getByLabel('Access token');
  await token.fill('definitely-not-the-right-token-0000000000');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert')).toContainText(/invalid|token/i);
  await expect(page).toHaveURL(/\/login/);

  await token.fill(E2E.editorToken);
  await page.getByRole('button', { name: 'Sign in' }).click();
  // back to where we were going
  await expect(page).toHaveURL(/\/tests$/);
  await expect(page.getByRole('heading', { name: 'Test cases', level: 1 })).toBeVisible();
});

test('viewer token only sees the report and is redirected away from the workspace', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Access token').fill(E2E.viewerToken);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/report$/);
  await expect(page.getByRole('heading', { name: 'Shop QA' })).toBeVisible();
  // no workspace switch / nav for viewers
  await expect(page.getByText('Workspace', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Test cases' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Report settings' })).toHaveCount(0);

  await page.goto('/tests');
  await expect(page).toHaveURL(/\/report$/);
  await expect(page.getByRole('heading', { name: 'Shop QA' })).toBeVisible();

  // and the API agrees (server-side role check, not just the UI)
  const res = await page.request.get('/api/test-cases');
  expect(res.status()).toBe(403);
});
