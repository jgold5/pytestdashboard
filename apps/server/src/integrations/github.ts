/**
 * GitHub PR sync — STUB. The integrations engineer implements sync() per
 * SPEC.md "GitHub". Use domain/pullRequests.ts#replaceRepoPullRequests to
 * persist PRs + links atomically per repo.
 */
import type { GithubConfig } from '../config.js';
import type { IntegrationProvider } from './registry.js';

export function createGithubProvider(config: GithubConfig): IntegrationProvider {
  return {
    name: 'github',
    isConfigured: () => Boolean(config.token) && config.repos.length > 0,
    describeTarget: () => {
      if (config.repos.length === 0) return null;
      const host = new URL(config.apiUrl).host;
      const repos = config.repos.join(', ');
      return host === 'api.github.com' ? repos : `${repos} (${host})`;
    },
    intervalMinutes: () => config.intervalMinutes,
    sync: async () => {
      throw new Error('GitHub sync is not implemented yet');
    },
  };
}
