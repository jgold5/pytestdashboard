import { afterEach, describe, expect, it } from 'vitest';
import type { IntegrationStatus } from '@ptd/shared';
import type { IntegrationProvider } from '../src/integrations/registry.js';
import { sanitizeError } from '../src/integrations/sanitize.js';
import { createTestApp, type TestApp } from './helpers/app.js';

describe('sanitizeError', () => {
  it('removes secrets and credential-looking strings', () => {
    const msg = sanitizeError(
      new Error(
        'GET https://user:pa55@api.example.com/x?access_token=abc123 failed: Authorization: Bearer ghp_abcdefghijklmnopqrstuvwxyz0123 SECRETVALUE',
      ),
      ['SECRETVALUE'],
    );
    expect(msg).not.toMatch(/pa55|abc123|ghp_|SECRETVALUE/);
    expect(msg).toContain('[redacted]');
    expect(sanitizeError({ weird: true }, [])).toBe('Unknown error');
  });
});

describe('integration runner', () => {
  let t: TestApp | undefined;
  afterEach(async () => t?.close());

  it('lists stub providers as not configured; sync needs configuration', async () => {
    t = await createTestApp();
    const list = (await t.app.inject({ url: '/api/integrations' })).json<IntegrationStatus[]>();
    expect(list.map((i) => [i.name, i.configured, i.state])).toEqual([
      ['github', false, 'idle'],
      ['jira', false, 'idle'],
    ]);
    expect((await t.app.inject({ method: 'POST', url: '/api/integrations/github/sync' })).statusCode).toBe(400);
    expect((await t.app.inject({ method: 'POST', url: '/api/integrations/nope/sync' })).statusCode).toBe(400);
  });

  it('runs one sync at a time (409), persists stats and sanitized errors', async () => {
    let release: () => void = () => undefined;
    let fail = false;
    const provider: IntegrationProvider = {
      name: 'github',
      isConfigured: () => true,
      describeTarget: () => 'acme/api',
      intervalMinutes: () => null,
      sync: () =>
        new Promise((resolve, reject) => {
          release = () => (fail ? reject(new Error('401 Bad credentials token=SUPERSECRET')) : resolve({ fetched: 3, created: 0, updated: 1, linked: 2 }));
        }),
    };
    t = await createTestApp({ GITHUB_TOKEN: 'SUPERSECRET' }, { providers: [provider] });
    const first = await t.app.inject({ method: 'POST', url: '/api/integrations/github/sync' });
    expect(first.statusCode).toBe(202);
    expect(first.json<IntegrationStatus>().state).toBe('running');
    expect((await t.app.inject({ method: 'POST', url: '/api/integrations/github/sync' })).statusCode).toBe(409);
    release();
    await t.runner.waitForIdle();
    let status = (await t.app.inject({ url: '/api/integrations' })).json<IntegrationStatus[]>()[0]!;
    expect(status).toMatchObject({ state: 'idle', lastStats: { fetched: 3, created: 0, updated: 1, linked: 2 }, target: 'acme/api' });
    expect(status.lastSuccessAt).not.toBeNull();

    fail = true;
    await t.app.inject({ method: 'POST', url: '/api/integrations/github/sync' });
    release();
    await t.runner.waitForIdle();
    status = (await t.app.inject({ url: '/api/integrations' })).json<IntegrationStatus[]>()[0]!;
    expect(status.state).toBe('error');
    expect(status.lastError).toContain('Bad credentials');
    expect(status.lastError).not.toContain('SUPERSECRET');
  });
});
