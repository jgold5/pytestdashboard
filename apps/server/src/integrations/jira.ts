/**
 * Jira / Xray sync — STUB. The integrations engineer implements sync() per
 * SPEC.md "Jira / Xray" and "Bugs identified".
 * - Test cases: reuse domain/normalize.ts (normalizeAutomationStatus — null
 *   means "unrecognized, leave unchanged" — and normalizePriority).
 * - JIRA BUG-STATUS SYNC HOOK: for each bug with a jiraKey, map Jira fields and
 *   call domain/bugs.ts#upsertBugFromJira (keeps links, maintains resolvedAt).
 * - The runner records a coverage snapshot after a successful sync.
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
