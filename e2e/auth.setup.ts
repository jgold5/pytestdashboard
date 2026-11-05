import { expect, test as setup } from '@playwright/test';
import { BASE_URL, E2E } from './env.mjs';

// Editor session for the spec files (the login UI itself is covered in auth.spec.ts).
setup('editor session', async ({ request }) => {
  const res = await request.post('/api/auth/login', { data: { token: E2E.editorToken }, headers: { origin: BASE_URL } });
  expect(res.status()).toBe(204);
  await request.storageState({ path: 'e2e/.auth/editor.json' });
});
