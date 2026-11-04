import path from 'node:path';
import { expect, test } from '@playwright/test';
import { FIXTURES } from './helpers';

test('spreadsheet wizard: map columns, dry run, commit', async ({ page }) => {
  await page.goto('/import');
  await page.getByLabel('Choose spreadsheet').setInputFiles(path.join(FIXTURES, 'tracker.xlsx'));

  // mapping step: suggestions are pre-filled; make one explicit choice
  const keyField = page.getByLabel('Field for column Test ID');
  await expect(keyField).toBeVisible();
  await expect(keyField).toHaveValue('key');
  await expect(page.getByLabel('Field for column Test Case')).toHaveValue('title');
  await page.getByLabel('Field for column Labels').selectOption('tags');
  await page.getByRole('button', { name: 'Continue' }).click();

  // status values step
  const wip = page.getByLabel('Status for “WIP”');
  await expect(wip).toHaveValue('in_progress');
  await page.getByRole('button', { name: 'Dry run' }).click();

  // review: dry run summary, then commit
  await expect(page.getByText('Will create')).toBeVisible();
  const importBtn = page.getByRole('button', { name: /^Import \d+ rows?$/ });
  await expect(importBtn).toBeEnabled();
  await importBtn.click();
  await expect(page.getByText('Import complete')).toBeVisible();
  await expect(page.getByText('Created', { exact: true })).toBeVisible();

  await page.getByRole('link', { name: 'View test cases' }).click();
  await page.getByLabel('Search test cases').fill('Login with SSO');
  await expect(page.getByRole('link', { name: 'Login with SSO' }).first()).toBeVisible();
});

test('inline automation status change persists after reload', async ({ page }) => {
  await page.goto('/tests?search=TC-1019');
  const trigger = page.getByRole('combobox', { name: /^Automation status for TC-1019:/ });
  await expect(trigger).toBeVisible();
  const before = await trigger.getAttribute('aria-label');
  const target = before?.includes('Not automatable') ? 'Not automated' : 'Not automatable';
  await trigger.click();
  await page.getByRole('option', { name: target, exact: true }).click();
  await expect(page.getByText(`TC-1019 → ${target}`)).toBeVisible(); // toast
  await page.reload();
  await expect(page.getByRole('combobox', { name: `Automation status for TC-1019: ${target}` })).toBeVisible();
});
