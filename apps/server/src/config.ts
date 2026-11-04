import path from 'node:path';
import { randomBytes } from 'node:crypto';
import net from 'node:net';
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
  /** Optional CI token: may only POST /api/runs/import. */
  INGEST_TOKEN: optionalStr,
  SESSION_SECRET: optionalStr,
  // Capped at 30 days (stateless sessions can only be revoked by rotating SESSION_SECRET / tokens).
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(720).default(168),
  ALLOWED_ORIGINS: csvList,
  TRUST_PROXY: z.string().trim().optional(),
  /** Public URL users open (e.g. https://qa.example.com): own origin for CSRF, Secure cookie, Host allowlist. */
  PUBLIC_URL: optionalStr,
  /** Extra accepted Host header values (comma list, host[:port]). */
  ALLOWED_HOSTS: csvList,
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
  /** Xray Cloud region endpoint, e.g. https://eu.xray.cloud.getxray.app (default: global). */
  XRAY_BASE_URL: z
    .string()
    .trim()
    .optional()
    .transform((v) => (v ? v : 'https://xray.cloud.getxray.app')),
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
  /** Xray Cloud origin (no path), e.g. https://xray.cloud.getxray.app or a regional host. */
  xrayBaseUrl: string;
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
  /** Optional upload-only token for CI (role 'ingest'). */
  ingestToken: string | undefined;
  sessionSecret: string;
  sessionTtlHours: number;
  allowedOrigins: string[];
  /** false, a hop count, or a list of trusted proxy IPs/CIDRs (never blanket `true`). */
  trustProxy: false | number | string[];
  /** Origin of PUBLIC_URL, if configured. */
  publicOrigin: string | null;
  /** Accepted Host header values (lowercase host[:port]); see hostAllowed(). */
  allowedHosts: string[];
  /** true when ALLOWED_HOSTS or PUBLIC_URL was configured explicitly. */
  hostsExplicit: boolean;
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
  if (e.INGEST_TOKEN !== undefined) {
    if (e.INGEST_TOKEN.length < MIN_SECRET) problems.push(`INGEST_TOKEN must be at least ${MIN_SECRET} characters`);
    if (e.INGEST_TOKEN === e.DASHBOARD_TOKEN || e.INGEST_TOKEN === e.VIEWER_TOKEN) {
      problems.push('INGEST_TOKEN must differ from DASHBOARD_TOKEN and VIEWER_TOKEN');
    }
    if (e.DASHBOARD_TOKEN === undefined) problems.push('INGEST_TOKEN requires DASHBOARD_TOKEN to be set');
  }
  if (e.SESSION_SECRET !== undefined && e.SESSION_SECRET.length < MIN_SECRET) {
    problems.push(`SESSION_SECRET must be at least ${MIN_SECRET} characters`);
  }
  if (isProduction) {
    if (!e.DASHBOARD_TOKEN) problems.push('DASHBOARD_TOKEN is required in production');
    if (!e.SESSION_SECRET) problems.push('SESSION_SECRET is required in production');
  }
  const trustProxy = parseTrustProxy(e.TRUST_PROXY, problems);
  if (e.PUBLIC_URL !== undefined && !isHttpUrl(e.PUBLIC_URL)) problems.push('PUBLIC_URL must be an http(s) URL');
  for (const origin of e.ALLOWED_ORIGINS) {
    if (!isOrigin(origin)) problems.push(`ALLOWED_ORIGINS entry is not an origin: ${origin}`);
  }
  if (e.JIRA_BASE_URL !== undefined && !isHttpsUrl(e.JIRA_BASE_URL)) {
    problems.push('JIRA_BASE_URL must be an https:// URL');
  }
  const xrayBaseUrl = parseXrayBaseUrl(e.XRAY_BASE_URL);
  if (xrayBaseUrl === null) {
    problems.push('XRAY_BASE_URL must be https://xray.cloud.getxray.app or https://<region>.xray.cloud.getxray.app');
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
    e.INGEST_TOKEN,
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
    // Without a token, auth is disabled: never expose that on the network.
    host: e.DASHBOARD_TOKEN ? e.HOST : '127.0.0.1',
    dataDir: path.resolve(e.DATA_DIR),
    dashboardToken: e.DASHBOARD_TOKEN,
    viewerToken: e.VIEWER_TOKEN,
    ingestToken: e.INGEST_TOKEN,
    // Dev without SESSION_SECRET: random per-process secret (sessions reset on restart).
    sessionSecret: e.SESSION_SECRET ?? randomBytes(32).toString('hex'),
    sessionTtlHours: e.SESSION_TTL_HOURS,
    allowedOrigins: [...new Set(allowedOrigins.map((o) => o.replace(/\/+$/, '')))],
    trustProxy,
    publicOrigin: e.PUBLIC_URL ? new URL(e.PUBLIC_URL).origin : null,
    allowedHosts: allowedHostList(e.ALLOWED_HOSTS, e.ALLOWED_ORIGINS, e.PUBLIC_URL),
    hostsExplicit: e.ALLOWED_HOSTS.length > 0 || e.PUBLIC_URL !== undefined,
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
      xrayBaseUrl: xrayBaseUrl!,
      intervalMinutes: e.JIRA_SYNC_INTERVAL_MINUTES ?? null,
    },
  };
}

const XRAY_HOST = 'xray.cloud.getxray.app';

/**
 * Xray Cloud base URL: https only, host must be xray.cloud.getxray.app or a
 * subdomain of it (regional endpoints such as eu.xray.cloud.getxray.app); no
 * credentials, port, path, query or fragment. Returns the origin or null.
 */
export function parseXrayBaseUrl(v: string): string | null {
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  if (u.protocol !== 'https:') return null;
  if (host !== XRAY_HOST && !(host.endsWith(`.${XRAY_HOST}`) && /^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(host))) return null;
  if (u.username || u.password || u.port || u.search || u.hash) return null;
  if (u.pathname !== '/' && u.pathname !== '') return null;
  return `https://${host}`;
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

/**
 * TRUST_PROXY: empty/false → off; an integer → trust that many hops; otherwise a
 * comma list of proxy IPs/CIDRs. Blanket `true` is rejected (it lets any client
 * spoof X-Forwarded-For and bypass rate limits).
 */
function parseTrustProxy(raw: string | undefined, problems: string[]): false | number | string[] {
  const v = (raw ?? '').trim();
  if (v === '' || /^(false|0|no|off)$/i.test(v)) return false;
  if (/^(true|yes|on)$/i.test(v)) {
    problems.push('TRUST_PROXY=true is not allowed: use the number of proxy hops (e.g. 1) or a list of proxy IPs/CIDRs');
    return false;
  }
  if (/^\d+$/.test(v)) return Number(v);
  const list = v.split(',').map((x) => x.trim()).filter(Boolean);
  for (const item of list) {
    const [ip, bits, extra] = item.split('/');
    const family = net.isIP(ip ?? '');
    const okBits = bits === undefined || (/^\d+$/.test(bits) && Number(bits) <= (family === 6 ? 128 : 32));
    if (!family || !okBits || extra !== undefined) problems.push(`TRUST_PROXY entry is not an IP or CIDR: ${item.slice(0, 60)}`);
  }
  return list;
}

const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

function allowedHostList(extra: string[], origins: string[], publicUrl: string | undefined): string[] {
  const hosts = new Set<string>(LOOPBACK_HOSTS);
  for (const h of extra) hosts.add(h.toLowerCase());
  for (const o of [...origins, ...(publicUrl ? [publicUrl] : [])]) {
    try {
      const u = new URL(o);
      hosts.add(u.host.toLowerCase());
      hosts.add(u.hostname.toLowerCase());
    } catch {
      // validated elsewhere
    }
  }
  return [...hosts];
}

/** Host header check: hostname (any port) for loopback names; exact host[:port] or hostname otherwise. */
export function hostAllowed(config: Pick<AppConfig, 'allowedHosts'>, hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  const host = hostHeader.trim().toLowerCase();
  if (config.allowedHosts.includes(host)) return true;
  let hostname: string;
  try {
    hostname = new URL(`http://${host}`).hostname;
  } catch {
    return false;
  }
  return config.allowedHosts.includes(hostname);
}
