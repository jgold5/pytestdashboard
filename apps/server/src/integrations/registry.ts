import type { FastifyBaseLogger } from 'fastify';
import type { IntegrationName } from '@ptd/shared';
import type { AppConfig } from '../config.js';
import type { Db } from '../db/client.js';
import type { IntegrationStats } from '../db/schema.js';
import { createGithubProvider } from './github.js';
import { createJiraProvider } from './jira.js';

export type SyncStats = IntegrationStats;

export interface SyncContext {
  db: Db;
  log: FastifyBaseLogger;
  /** Aborted on shutdown or when the sync exceeds its time budget. Pass to fetch(). */
  signal: AbortSignal;
}

export interface IntegrationProvider {
  readonly name: IntegrationName;
  /** Required env vars present (never exposes their values). */
  isConfigured(): boolean;
  /** Non-secret description shown in the UI, e.g. "acme/api, acme/web". */
  describeTarget(): string | null;
  /** Minutes between automatic syncs; null = manual only. */
  intervalMinutes(): number | null;
  sync(ctx: SyncContext): Promise<SyncStats>;
}

export function createProviders(config: AppConfig): IntegrationProvider[] {
  return [createGithubProvider(config.github), createJiraProvider(config.jira)];
}
