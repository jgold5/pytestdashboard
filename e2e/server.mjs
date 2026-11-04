// Starts the production build against a fresh temp DATA_DIR for the e2e suite:
//   (build, unless E2E_SKIP_BUILD=1) → seed demo data → node apps/server/dist/index.js
// Used as Playwright's `webServer.command`; the temp dir is removed on exit.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { E2E } from './env.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptd-e2e-'));
const env = {
  ...process.env,
  NODE_ENV: 'production',
  HOST: '127.0.0.1',
  PORT: String(E2E.port),
  DATA_DIR: dataDir,
  LOG_LEVEL: 'warn',
  DASHBOARD_TOKEN: E2E.editorToken,
  VIEWER_TOKEN: E2E.viewerToken,
  SESSION_SECRET: E2E.sessionSecret,
  // no integrations in e2e
  GITHUB_TOKEN: '',
  GITHUB_REPOS: '',
  JIRA_BASE_URL: '',
};

function run(cmd, args, runEnv = env) {
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', env: runEnv });
  if (r.status !== 0) {
    cleanup();
    process.exit(r.status ?? 1);
  }
}

function cleanup() {
  fs.rmSync(dataDir, { recursive: true, force: true });
}

if (process.env.E2E_SKIP_BUILD !== '1') {
  const { NODE_ENV: _ignored, ...buildEnv } = process.env;
  run('pnpm', ['build'], buildEnv);
}
run('pnpm', ['--filter', '@ptd/server', 'seed', '--', '--reset']);

const server = spawn(process.execPath, ['apps/server/dist/index.js'], { cwd: root, stdio: 'inherit', env });
const stop = () => server.kill('SIGTERM');
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
server.on('exit', (code) => {
  cleanup();
  process.exit(code ?? 0);
});
