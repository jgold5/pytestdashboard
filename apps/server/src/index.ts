import fs from 'node:fs';
import path from 'node:path';
import { buildApp } from './app.js';
import { ConfigError, loadConfig } from './config.js';

/** Set by tsup for the production bundle (dist/index.js). */
declare const __PTD_BUNDLED__: boolean | undefined;
const BUNDLED = typeof __PTD_BUNDLED__ !== 'undefined' && __PTD_BUNDLED__;

function loadDotEnv(): void {
  // Loads .env (cwd, then repo root) in every mode — local installs keep their
  // tokens there. Never overrides variables already set in the environment,
  // so container/systemd env still wins. .env is git- and docker-ignored.
  for (const candidate of [path.resolve('.env'), path.resolve('../../.env')]) {
    if (fs.existsSync(candidate)) {
      process.loadEnvFile(candidate);
      return;
    }
  }
}

async function main(): Promise<void> {
  // `node dist/index.js` (e.g. root `pnpm start`) defaults to production, which
  // refuses to start without tokens instead of silently running without auth.
  // Set before loading .env so the .env.example default (development) can't
  // silently downgrade `pnpm start` to no-auth mode.
  if (BUNDLED && !process.env.NODE_ENV) process.env.NODE_ENV = 'production';
  loadDotEnv();
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
      '!!! AUTH DISABLED: DASHBOARD_TOKEN is not set. Listening on 127.0.0.1 only (HOST ignored) and accepting only localhost Host headers. Set DASHBOARD_TOKEN (>= 32 chars) to serve other machines. !!!',
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
