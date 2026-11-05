import { defineConfig, devices } from '@playwright/test';
import { BASE_URL } from './e2e/env.mjs';

/**
 * E2E suite: production build + freshly seeded temp DATA_DIR (see e2e/server.mjs).
 *   pnpm e2e                    build → seed → start → test
 *   E2E_SKIP_BUILD=1 pnpm e2e   reuse an existing `pnpm build` (CI does this)
 * The browser must match @playwright/test's version (pinned exactly); set
 * PW_CHROMIUM_PATH to use a pre-installed Chromium instead.
 */
export default defineConfig({
  testDir: './e2e',
  // Tests share one server + DB and some mutate it: run serially, in file order.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    colorScheme: 'light',
    viewport: { width: 1440, height: 900 },
    launchOptions: process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {},
  },
  projects: [
    { name: 'setup', testMatch: /auth\.setup\.ts/ },
    {
      name: 'chromium',
      testMatch: /.*\.spec\.ts/,
      dependencies: ['setup'],
      use: { storageState: 'e2e/.auth/editor.json' },
    },
  ],
  webServer: {
    command: 'node e2e/server.mjs',
    url: `${BASE_URL}/api/health`,
    timeout: 240_000,
    reuseExistingServer: false,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
