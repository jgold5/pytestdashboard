/**
 * Runs integration syncs in-process: one at a time per integration (mutex),
 * optional interval scheduling, state persisted in integration_state, errors
 * sanitized before storage.
 */
import { eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { IntegrationName, IntegrationStatus } from '@ptd/shared';
import type { Db } from '../db/client.js';
import { integrationState } from '../db/schema.js';
import { recordCoverageSnapshot } from '../domain/coverage.js';
import { AppError, notFound } from '../errors.js';
import { nowIso } from '../util/time.js';
import type { IntegrationProvider } from './registry.js';
import { sanitizeError } from './sanitize.js';

export interface RunnerOptions {
  /** Hard time budget per sync (default 15 min). */
  syncTimeoutMs?: number;
}

export class IntegrationRunner {
  private readonly running = new Map<IntegrationName, { controller: AbortController; done: Promise<void> }>();
  private readonly timers: NodeJS.Timeout[] = [];
  private readonly timeoutMs: number;

  constructor(
    private readonly db: Db,
    private readonly providers: readonly IntegrationProvider[],
    private readonly log: FastifyBaseLogger,
    private readonly secrets: readonly string[],
    opts: RunnerOptions = {},
  ) {
    this.timeoutMs = opts.syncTimeoutMs ?? 15 * 60 * 1000;
    // A 'running' row left over from a crash/restart is stale.
    this.db
      .update(integrationState)
      .set({ state: 'error', lastError: 'Interrupted (server restarted during sync)' })
      .where(eq(integrationState.state, 'running'))
      .run();
  }

  private provider(name: IntegrationName): IntegrationProvider {
    const p = this.providers.find((x) => x.name === name);
    if (!p) throw notFound('Integration');
    return p;
  }

  status(name: IntegrationName): IntegrationStatus {
    const p = this.provider(name);
    const row = this.db.select().from(integrationState).where(eq(integrationState.name, name)).get();
    return {
      name,
      configured: p.isConfigured(),
      target: p.describeTarget(),
      state: this.running.has(name) ? 'running' : row?.state === 'error' ? 'error' : 'idle',
      lastSyncAt: row?.lastSyncAt ?? null,
      lastSuccessAt: row?.lastSuccessAt ?? null,
      lastError: row?.lastError ?? null,
      lastStats: row?.lastStats ?? null,
      intervalMinutes: p.intervalMinutes(),
    };
  }

  list(): IntegrationStatus[] {
    return this.providers.map((p) => this.status(p.name));
  }

  /** Start a sync in the background. 409 if already running, 400 if not configured. */
  trigger(name: IntegrationName): IntegrationStatus {
    const p = this.provider(name);
    if (!p.isConfigured()) {
      throw new AppError(400, 'not_configured', `The ${name} integration is not configured (set its env vars on the server)`);
    }
    if (this.running.has(name)) throw new AppError(409, 'already_running', `A ${name} sync is already running`);
    this.startSync(p);
    return this.status(name);
  }

  private upsertState(name: string, set: Partial<typeof integrationState.$inferInsert>): void {
    this.db
      .insert(integrationState)
      .values({ name, ...set })
      .onConflictDoUpdate({ target: integrationState.name, set })
      .run();
  }

  private startSync(p: IntegrationProvider): void {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('Sync timed out')), this.timeoutMs);
    timeout.unref();
    const startedAt = nowIso();
    this.upsertState(p.name, { state: 'running', lastSyncAt: startedAt });
    const log = this.log.child({ integration: p.name });

    const done = (async () => {
      try {
        // yield so trigger() returns the "running" status first
        await Promise.resolve();
        const stats = await p.sync({ db: this.db, log, signal: controller.signal });
        this.upsertState(p.name, {
          state: 'idle',
          lastSuccessAt: nowIso(),
          lastError: null,
          lastStats: stats,
        });
        recordCoverageSnapshot(this.db);
        log.info({ stats }, 'integration sync finished');
      } catch (err) {
        const message = sanitizeError(err, this.secrets);
        this.upsertState(p.name, { state: 'error', lastError: message });
        log.warn({ error: message }, 'integration sync failed');
      } finally {
        clearTimeout(timeout);
        this.running.delete(p.name);
      }
    })();
    this.running.set(p.name, { controller, done });
  }

  /** Schedule interval syncs for configured providers that have an interval. */
  start(): void {
    for (const p of this.providers) {
      const minutes = p.intervalMinutes();
      if (!minutes || !p.isConfigured()) continue;
      const t = setInterval(() => {
        if (this.running.has(p.name)) return;
        this.startSync(p);
      }, minutes * 60_000);
      t.unref();
      this.timers.push(t);
      this.log.info({ integration: p.name, minutes }, 'integration sync scheduled');
    }
  }

  async waitForIdle(name?: IntegrationName): Promise<void> {
    const pending = name ? [this.running.get(name)?.done] : [...this.running.values()].map((r) => r.done);
    await Promise.all(pending.filter(Boolean));
  }

  async stop(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    this.timers.length = 0;
    for (const r of this.running.values()) r.controller.abort(new Error('Server shutting down'));
    await this.waitForIdle();
  }
}
