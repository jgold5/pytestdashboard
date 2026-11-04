import fs from 'node:fs';
import path from 'node:path';
import { buildApp } from './app.js';
import { ConfigError, loadConfig } from './config.js';

function loadDotEnv(): void {
  // Convenience for local dev; never overrides variables already set.
  for (const candidate of [path.resolve('.env'), path.resolve('../../.env')]) {
    if (fs.existsSync(candidate)) {
      process.loadEnvFile(candidate);
      return;
    }
  }
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV !== 'production') loadDotEnv();
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`[ptd] ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  const { app, runner } = await buildApp({ config });
  if (!config.dashboardToken) {
    app.log.warn(
      '!!! AUTH DISABLED: DASHBOARD_TOKEN is not set. Anyone who can reach this server has full access. Set DASHBOARD_TOKEN (>= 32 chars) for any shared deployment. !!!',
    );
  }
  runner.start();

  let closing = false;
  const shutdown = (signal: string) => {
    if (closing) return;
    closing = true;
    app.log.info({ signal }, 'shutting down');
    app
      .close()
      .then(() => process.exit(0))
      .catch((e: unknown) => {
        app.log.error({ err: e }, 'error during shutdown');
        process.exit(1);
      });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  await app.listen({ port: config.port, host: config.host });
}

void main();
