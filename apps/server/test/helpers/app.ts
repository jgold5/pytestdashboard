import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildApp, type BuildOptions, type BuiltApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';

export const EDITOR_TOKEN = 'editor-token-0123456789abcdef0123456789';
export const VIEWER_TOKEN = 'viewer-token-0123456789abcdef0123456789';
export const SESSION_SECRET = 'session-secret-0123456789abcdef0123456789';

export interface TestApp extends BuiltApp {
  dataDir: string;
  close(): Promise<void>;
}

export async function createTestApp(
  env: Record<string, string> = {},
  opts: Omit<BuildOptions, 'config'> = {},
): Promise<TestApp> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptd-test-'));
  const config = loadConfig({ NODE_ENV: 'test', DATA_DIR: dataDir, LOG_LEVEL: 'silent', ...env });
  const built = await buildApp({ config, logger: false, rateLimitMax: 10_000, ...opts });
  await built.app.ready();
  return {
    ...built,
    dataDir,
    close: async () => {
      await built.app.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

export const authEnv = (extra: Record<string, string> = {}) => ({
  DASHBOARD_TOKEN: EDITOR_TOKEN,
  SESSION_SECRET,
  ...extra,
});

export interface UploadFile {
  field?: string;
  filename: string;
  content: Buffer | string;
  contentType?: string;
}

/** Build a multipart/form-data payload for app.inject. */
export function multipart(fields: Record<string, string>, files: UploadFile[]): { payload: Buffer; headers: Record<string, string> } {
  const boundary = `----ptdtest${Math.random().toString(16).slice(2)}`;
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  for (const f of files) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${f.field ?? 'files'}"; filename="${f.filename}"\r\nContent-Type: ${f.contentType ?? 'application/octet-stream'}\r\n\r\n`,
      ),
      typeof f.content === 'string' ? Buffer.from(f.content) : f.content,
      Buffer.from('\r\n'),
    );
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(parts), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}
