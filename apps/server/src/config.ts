import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';

const optionalStr = z
  .string()
  .trim()
  .transform((v) => (v === '' ? undefined : v))
  .optional();

const optionalInt = z
  .string()
  .trim()
  .optional()
  .transform((v, ctx) => {
    if (v === undefined || v === '') return undefined;
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0) {
      ctx.addIssue({ code: 'custom', message: 'must be a positive integer' });
      return z.NEVER;
    }
    return n;
  });

const boolStr = (def: boolean) =>
  z
    .string()
    .trim()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : /^(1|true|yes|on)$/i.test(v)));

const csvList = z
  .string()
  .optional()
  .transform((v) =>
    (v ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().default('0.0.0.0'),
  DATA_DIR: z.string().default('./data'),
  DASHBOARD_TOKEN: optionalStr,
  VIEWER_TOKEN: optionalStr,
  SESSION_SECRET: optionalStr,
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(24 * 365).default(168),
  ALLOWED_ORIGINS: csvList,
  TRUST_PROXY: boolStr(false),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  WEB_DIST: optionalStr,

  // GitHub
  GITHUB_TOKEN: optionalStr,
  GITHUB_REPOS: csvList,
  GITHUB_API_URL: z.string().trim().default('https://api.github.com'),
  GITHUB_SYNC_INTERVAL_MINUTES: optionalInt,
  GITHUB_TEST_PATH_GLOBS: z
    .string()
    .optional()
    .transform((v) =>
      (v && v.trim() ? v : '**/test_*.py,**/*_test.py,**/tests/**')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),

  // Jira / Xray
  JIRA_BASE_URL: optionalStr,
  JIRA_EMAIL: optionalStr,
  JIRA_API_TOKEN: optionalStr,
  JIRA_PAT: optionalStr,
  JIRA_JQL: z.string().trim().default('issuetype = Test ORDER BY key'),
  JIRA_AUTOMATION_FIELD: optionalStr,
  XRAY_CLIENT_ID: optionalStr,
  XRAY_CLIENT_SECRET: optionalStr,
  JIRA_SYNC_INTERVAL_MINUTES: optionalInt,
});

export interface GithubConfig {
  token: string | undefined;
  repos: string[];
  apiUrl: string;
  intervalMinutes: number | null;
  testPathGlobs: string[];
}

export interface JiraConfig {
  baseUrl: string | undefined;
  email: string | undefined;
  apiToken: string | undefined;
  pat: string | undefined;
  jql: string;
  automationField: string | undefined;
  xrayClientId: string | undefined;
  xrayClientSecret: string | undefined;
  intervalMinutes: number | null;
}

export interface AppConfig {
  nodeEnv: 'development' | 'production' | 'test';
  isProduction: boolean;
  port: number;
  host: string;
  dataDir: string;
  /** Editor token. undefined ⇒ auth disabled (dev/test only). */
  dashboardToken: string | undefined;
  /** Optional read-only (Report-only) token. */
  viewerToken: string | undefined;
  sessionSecret: string;
  sessionTtlHours: number;
  allowedOrigins: string[];
  trustProxy: boolean;
  logLevel: string;
  webDist: string;
  /** Secrets that must never appear in logs or stored errors. */
  secrets: string[];
  github: GithubConfig;
  jira: JiraConfig;
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

const MIN_SECRET = 32;
const JIRA_KEY_FIELD = /^customfield_\d+$/;

/** Default location of the built SPA: apps/web/dist relative to apps/server/{src,dist}. */
function defaultWebDist(): string {
  return path.resolve(import.meta.dirname, '../../web/dist');
}

/**
 * Parse and validate the environment. Throws ConfigError with a readable
 * message (never containing secret values) when invalid.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new ConfigError(`Invalid environment: ${msg}`);
  }
  const e = parsed.data;
  const isProduction = e.NODE_ENV === 'production';
  const problems: string[] = [];

  if (e.DASHBOARD_TOKEN !== undefined && e.DASHBOARD_TOKEN.length < MIN_SECRET) {
    problems.push(`DASHBOARD_TOKEN must be at least ${MIN_SECRET} characters`);
  }
  if (e.VIEWER_TOKEN !== undefined) {
    if (e.VIEWER_TOKEN.length < MIN_SECRET) problems.push(`VIEWER_TOKEN must be at least ${MIN_SECRET} characters`);
    if (e.VIEWER_TOKEN === e.DASHBOARD_TOKEN) problems.push('VIEWER_TOKEN must differ from DASHBOARD_TOKEN');
    if (e.DASHBOARD_TOKEN === undefined) problems.push('VIEWER_TOKEN requires DASHBOARD_TOKEN to be set');
  }
  if (e.SESSION_SECRET !== undefined && e.SESSION_SECRET.length < MIN_SECRET) {
    problems.push(`SESSION_SECRET must be at least ${MIN_SECRET} characters`);
  }
  if (isProduction) {
    if (!e.DASHBOARD_TOKEN) problems.push('DASHBOARD_TOKEN is required in production');
    if (!e.SESSION_SECRET) problems.push('SESSION_SECRET is required in production');
  }
  for (const origin of e.ALLOWED_ORIGINS) {
    if (!isOrigin(origin)) problems.push(`ALLOWED_ORIGINS entry is not an origin: ${origin}`);
  }
  if (e.JIRA_BASE_URL !== undefined && !isHttpsUrl(e.JIRA_BASE_URL)) {
    problems.push('JIRA_BASE_URL must be an https:// URL');
  }
  if (!isHttpUrl(e.GITHUB_API_URL)) problems.push('GITHUB_API_URL must be an http(s) URL');
  if (e.JIRA_AUTOMATION_FIELD !== undefined && !JIRA_KEY_FIELD.test(e.JIRA_AUTOMATION_FIELD)) {
    problems.push('JIRA_AUTOMATION_FIELD must look like customfield_12345');
  }
  for (const repo of e.GITHUB_REPOS) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) problems.push(`GITHUB_REPOS entry is not owner/name: ${repo}`);
  }
  if (problems.length > 0) throw new ConfigError(`Invalid configuration: ${problems.join('; ')}`);

  const allowedOrigins = [...e.ALLOWED_ORIGINS];
  if (!isProduction) {
    // Vite dev server proxies /api from :5173.
    allowedOrigins.push('http://localhost:5173', 'http://127.0.0.1:5173');
  }

  const secrets = [
    e.DASHBOARD_TOKEN,
    e.VIEWER_TOKEN,
    e.SESSION_SECRET,
    e.GITHUB_TOKEN,
    e.JIRA_API_TOKEN,
    e.JIRA_PAT,
    e.XRAY_CLIENT_SECRET,
    e.XRAY_CLIENT_ID,
  ].filter((s): s is string => typeof s === 'string' && s.length > 0);

  return {
    nodeEnv: e.NODE_ENV,
    isProduction,
    port: e.PORT,
    host: e.HOST,
    dataDir: path.resolve(e.DATA_DIR),
    dashboardToken: e.DASHBOARD_TOKEN,
    viewerToken: e.VIEWER_TOKEN,
    // Dev without SESSION_SECRET: random per-process secret (sessions reset on restart).
    sessionSecret: e.SESSION_SECRET ?? randomBytes(32).toString('hex'),
    sessionTtlHours: e.SESSION_TTL_HOURS,
    allowedOrigins: [...new Set(allowedOrigins.map((o) => o.replace(/\/+$/, '')))],
    trustProxy: e.TRUST_PROXY,
    logLevel: e.LOG_LEVEL,
    webDist: e.WEB_DIST ? path.resolve(e.WEB_DIST) : defaultWebDist(),
    secrets,
    github: {
      token: e.GITHUB_TOKEN,
      repos: e.GITHUB_REPOS,
      apiUrl: e.GITHUB_API_URL.replace(/\/+$/, ''),
      intervalMinutes: e.GITHUB_SYNC_INTERVAL_MINUTES ?? null,
      testPathGlobs: e.GITHUB_TEST_PATH_GLOBS,
    },
    jira: {
      baseUrl: e.JIRA_BASE_URL?.replace(/\/+$/, ''),
      email: e.JIRA_EMAIL,
      apiToken: e.JIRA_API_TOKEN,
      pat: e.JIRA_PAT,
      jql: e.JIRA_JQL,
      automationField: e.JIRA_AUTOMATION_FIELD,
      xrayClientId: e.XRAY_CLIENT_ID,
      xrayClientSecret: e.XRAY_CLIENT_SECRET,
      intervalMinutes: e.JIRA_SYNC_INTERVAL_MINUTES ?? null,
    },
  };
}

function isHttpsUrl(v: string): boolean {
  try {
    return new URL(v).protocol === 'https:';
  } catch {
    return false;
  }
}

function isHttpUrl(v: string): boolean {
  try {
    const p = new URL(v).protocol;
    return p === 'https:' || p === 'http:';
  } catch {
    return false;
  }
}

function isOrigin(v: string): boolean {
  try {
    const u = new URL(v);
    return (u.protocol === 'http:' || u.protocol === 'https:') && (u.pathname === '/' || u.pathname === '');
  } catch {
    return false;
  }
}
