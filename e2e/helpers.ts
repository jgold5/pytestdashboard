import { expect, type Page } from '@playwright/test';

export const FIXTURES = new URL('../apps/server/test/fixtures/', import.meta.url).pathname;

/** Wait until no page-level loading skeleton is shown. */
export async function settled(page: Page) {
  await expect(page.getByRole('status', { name: /^Loading/ })).toHaveCount(0);
}
