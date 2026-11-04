/**
 * Jira / Xray sync — STUB. The integrations engineer implements sync() per
 * SPEC.md "Jira / Xray". Reuse domain/normalize.ts (normalizeAutomationStatus,
 * normalizePriority) and record a coverage snapshot is done by the runner.
 */
import type { JiraConfig } from '../config.js';
import type { IntegrationProvider } from './registry.js';

export function createJiraProvider(config: JiraConfig): IntegrationProvider {
  const hasAuth = Boolean((config.email && config.apiToken) || config.pat);
  return {
    name: 'jira',
    isConfigured: () => Boolean(config.baseUrl) && hasAuth,
    describeTarget: () => (config.baseUrl ? `${config.baseUrl} — ${config.jql}` : null),
    intervalMinutes: () => config.intervalMinutes,
    sync: async () => {
      throw new Error('Jira sync is not implemented yet');
    },
  };
}
