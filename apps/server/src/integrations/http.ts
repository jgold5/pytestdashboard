/**
 * Shared outbound HTTP client for integrations (global fetch).
 *
 * Security properties (SPEC "Integrations" + "Security requirements"):
 * - The base URL is pinned from server config. Requests may only target that
 *   origin; absolute URLs (e.g. pagination `next` links) pointing anywhere else
 *   are refused, and redirects are followed manually only within the origin.
 * - https only, except loopback hosts (local mock servers in tests).
 * - 15s per-attempt timeout (AbortSignal), also honoring the sync's signal.
 * - Retries with exponential backoff on 429 / 5xx / network errors / timeouts,
 *   honoring Retry-After and GitHub's X-RateLimit-Reset (waits capped at 60s;
 *   a server asking for longer fails fast with a clear message).
 * - Response bodies are streamed and aborted beyond a size cap (10 MB).
 * - JSON is validated with (permissive) zod schemas.
 * - Errors carry method, path, status and at most a short, sanitized excerpt of
 *   the server's error message — never headers, tokens or full bodies.
 */
import type { z } from 'zod';
import { sanitizeError } from './sanitize.js';

export const DEFAULT_TIMEOUT_MS = 15_000;
export const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
export const MAX_WAIT_MS = 60_000;
const MAX_REDIRECTS = 3;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

export const defaultSleep: Sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortReason(signal));
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(abortReason(signal!));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

function abortReason(signal: AbortSignal): Error {
  const r: unknown = signal.reason;
  return r instanceof Error ? r : new Error('Request aborted');
}

export interface HttpClientOptions {
  /** e.g. "GitHub", "Jira", "Xray" — prefixes error messages. */
  label: string;
  /** Pinned base URL from server config (never from user input). */
  baseUrl: string;
  /** Default headers (auth). Never included in errors or logs. */
  headers?: Record<string, string>;
  /** Values that must never appear in error messages (tokens). */
  secrets?: readonly string[];
  /** Aborts all requests (sync cancelled / timed out / shutdown). */
  signal?: AbortSignal;
  timeoutMs?: number;
  maxBytes?: number;
  /** Retries after the first attempt (default 4). */
  maxRetries?: number;
  /** First backoff delay (default 1000ms); doubles each attempt. */
  backoffBaseMs?: number;
  /** Longest wait honored for Retry-After / rate-limit reset (default 60s). */
  maxWaitMs?: number;
  sleep?: Sleep;
}

export interface RequestOptions<T> {
  method?: 'GET' | 'POST';
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  headers?: Record<string, string>;
  schema: z.ZodType<T>;
}

export interface HttpResponse<T> {
  status: number;
  headers: Headers;
  data: T;
}

export class HttpError extends Error {
  override name = 'HttpError';
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
  }
}

class RetryableError extends Error {
  constructor(
    readonly inner: HttpError,
    readonly waitMs: number | null,
  ) {
    super(inner.message);
  }
}

function isLoopback(host: string): boolean {
  return LOOPBACK.has(host.toLowerCase());
}

/** Validate a configured base URL: https (or http on loopback), no credentials, no query. */
export function assertSafeBaseUrl(raw: string, label: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new HttpError(`${label}: base URL is not a valid URL`, null);
  }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && isLoopback(u.hostname))) {
    throw new HttpError(`${label}: base URL must use https`, null);
  }
  if (u.username || u.password) throw new HttpError(`${label}: base URL must not contain credentials`, null);
  u.search = '';
  u.hash = '';
  return u;
}

export class HttpClient {
  readonly base: URL;
  private readonly basePath: string;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly maxRetries: number;
  private readonly backoffBaseMs: number;
  private readonly maxWaitMs: number;
  private readonly sleep: Sleep;
  private readonly secrets: string[];

  constructor(private readonly opts: HttpClientOptions) {
    this.base = assertSafeBaseUrl(opts.baseUrl, opts.label);
    this.basePath = this.base.pathname.replace(/\/+$/, '');
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    this.maxRetries = opts.maxRetries ?? 4;
    this.backoffBaseMs = opts.backoffBaseMs ?? 1000;
    this.maxWaitMs = opts.maxWaitMs ?? MAX_WAIT_MS;
    this.sleep = opts.sleep ?? defaultSleep;
    this.secrets = [...(opts.secrets ?? [])];
  }

  /** Register a secret obtained at runtime (e.g. an Xray JWT) for redaction. */
  addSecret(s: string): void {
    if (s) this.secrets.push(s);
  }

  /**
   * Resolve a path (relative to the base URL) or an absolute URL. Absolute
   * URLs must be on the pinned origin — anything else is refused.
   */
  resolve(pathOrUrl: string, query?: RequestOptions<unknown>['query']): URL {
    let url: URL;
    if (/^[a-z][a-z0-9+.-]*:/i.test(pathOrUrl) || pathOrUrl.startsWith('//')) {
      try {
        url = new URL(pathOrUrl, this.base);
      } catch {
        throw new HttpError(`${this.opts.label}: refused malformed URL`, null);
      }
      if (url.origin !== this.base.origin) {
        throw new HttpError(`${this.opts.label}: refused request to a host other than the configured base URL`, null);
      }
    } else {
      const p = pathOrUrl.startsWith('/') ? pathOrUrl : `/${pathOrUrl}`;
      url = new URL(`${this.basePath}${p}`, this.base.origin);
    }
    if (url.username || url.password) throw new HttpError(`${this.opts.label}: refused URL with credentials`, null);
    if (query) {
      for (const [k, v] of Object.entries(query)) if (v !== undefined) url.searchParams.set(k, String(v));
    }
    return url;
  }

  async get<T>(pathOrUrl: string, opts: Omit<RequestOptions<T>, 'method' | 'body'>): Promise<HttpResponse<T>> {
    return this.request(pathOrUrl, { ...opts, method: 'GET' });
  }

  async post<T>(pathOrUrl: string, opts: Omit<RequestOptions<T>, 'method'>): Promise<HttpResponse<T>> {
    return this.request(pathOrUrl, { ...opts, method: 'POST' });
  }

  async request<T>(pathOrUrl: string, opts: RequestOptions<T>): Promise<HttpResponse<T>> {
    const url = this.resolve(pathOrUrl, opts.query);
    let attempt = 0;
    for (;;) {
      this.throwIfAborted();
      try {
        return await this.attempt(url, opts);
      } catch (err) {
        if (!(err instanceof RetryableError)) throw err;
        if (attempt >= this.maxRetries) throw err.inner;
        let wait = err.waitMs ?? this.backoff(attempt);
        if (wait > this.maxWaitMs) {
          throw new HttpError(
            `${err.inner.message} — rate limited; the server asked to wait ${Math.ceil(wait / 1000)}s (more than ${Math.round(this.maxWaitMs / 1000)}s), try again later`,
            err.inner.status,
          );
        }
        wait = Math.max(0, wait);
        attempt++;
        await this.sleep(wait, this.opts.signal);
      }
    }
  }

  private backoff(attempt: number): number {
    const exp = this.backoffBaseMs * 2 ** attempt;
    const jitter = Math.random() * this.backoffBaseMs * 0.25;
    return Math.min(this.maxWaitMs, Math.round(exp + jitter));
  }

  private throwIfAborted(): void {
    if (this.opts.signal?.aborted) throw abortReason(this.opts.signal);
  }

  private describe(method: string, url: URL): string {
    // path only — no query (may hold JQL) and never headers
    return `${this.opts.label} ${method} ${url.pathname}`;
  }

  private clean(msg: string): string {
    return sanitizeError(msg, this.secrets, 300);
  }

  private async attempt<T>(initialUrl: URL, opts: RequestOptions<T>): Promise<HttpResponse<T>> {
    const method = opts.method ?? 'GET';
    let url = initialUrl;
    for (let hop = 0; ; hop++) {
      const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
      const signal = this.opts.signal ? AbortSignal.any([this.opts.signal, timeoutSignal]) : timeoutSignal;
      const headers: Record<string, string> = {
        accept: 'application/json',
        'user-agent': 'pytestdashboard-integrations',
        ...this.opts.headers,
        ...opts.headers,
      };
      let body: string | undefined;
      if (opts.body !== undefined) {
        body = JSON.stringify(opts.body);
        headers['content-type'] = 'application/json';
      }
      const what = this.describe(method, url);
      let res: Response;
      try {
        res = await fetch(url, { method, headers, body, signal, redirect: 'manual' });
      } catch (err) {
        if (this.opts.signal?.aborted) throw abortReason(this.opts.signal);
        if (timeoutSignal.aborted) {
          throw new RetryableError(new HttpError(`${what} timed out after ${Math.round(this.timeoutMs / 1000)}s`, null), null);
        }
        const cause = err instanceof Error && err.cause instanceof Error ? err.cause.message : '';
        throw new RetryableError(new HttpError(this.clean(`${what} failed: network error${cause ? ` (${cause})` : ''}`), null), null);
      }

      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        await res.body?.cancel().catch(() => undefined);
        if (hop >= MAX_REDIRECTS) throw new HttpError(`${what}: too many redirects`, res.status);
        const next = new URL(res.headers.get('location')!, url);
        if (next.origin !== this.base.origin) {
          throw new HttpError(`${what}: refused redirect to a host other than the configured base URL`, res.status);
        }
        url = next;
        continue;
      }

      let text: string;
      try {
        text = await this.readCapped(res, what, signal);
      } catch (err) {
        if (err instanceof HttpError) throw err;
        if (this.opts.signal?.aborted) throw abortReason(this.opts.signal);
        if (timeoutSignal.aborted) {
          throw new RetryableError(new HttpError(`${what} timed out after ${Math.round(this.timeoutMs / 1000)}s`, null), null);
        }
        throw new RetryableError(new HttpError(`${what} failed while reading the response`, res.status), null);
      }

      if (!res.ok) {
        const err = new HttpError(this.clean(`${what} → HTTP ${res.status}${errorExcerpt(text)}`), res.status);
        const wait = rateLimitWaitMs(res);
        const rateLimited =
          res.status === 429 || (res.status === 403 && (res.headers.get('x-ratelimit-remaining') === '0' || res.headers.has('retry-after')));
        if (rateLimited || res.status >= 500) throw new RetryableError(err, wait);
        throw err;
      }

      let json: unknown;
      try {
        json = text === '' ? null : JSON.parse(text);
      } catch {
        throw new HttpError(`${what}: response is not valid JSON`, res.status);
      }
      const parsed = opts.schema.safeParse(json);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const where = issue ? ` at ${issue.path.join('.') || '(root)'}: ${issue.message}` : '';
        throw new HttpError(this.clean(`${what}: unexpected response shape${where}`), res.status);
      }
      return { status: res.status, headers: res.headers, data: parsed.data };
    }
  }

  private async readCapped(res: Response, what: string, signal: AbortSignal): Promise<string> {
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > this.maxBytes) {
      await res.body?.cancel().catch(() => undefined);
      throw new HttpError(`${what}: response too large (> ${this.maxBytes} bytes)`, res.status);
    }
    if (!res.body) return '';
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      if (signal.aborted) {
        await reader.cancel().catch(() => undefined);
        throw abortReason(signal);
      }
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > this.maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new HttpError(`${what}: response too large (> ${this.maxBytes} bytes)`, res.status);
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  }
}

/** Short excerpt of a JSON error message (GitHub `message`, Jira `errorMessages`); never the raw body. */
function errorExcerpt(text: string): string {
  let msg = '';
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    if (typeof j.message === 'string') msg = j.message;
    else if (Array.isArray(j.errorMessages) && typeof j.errorMessages[0] === 'string') msg = j.errorMessages[0];
    else if (typeof j.error === 'string') msg = j.error;
    else if (Array.isArray(j.errors) && typeof (j.errors[0] as { message?: unknown })?.message === 'string') {
      msg = (j.errors[0] as { message: string }).message;
    }
  } catch {
    // non-JSON body (HTML error page etc.) — say nothing about it
  }
  msg = msg.replace(/\s+/g, ' ').trim();
  if (!msg) return '';
  return `: ${msg.length > 160 ? `${msg.slice(0, 159)}…` : msg}`;
}

/** Retry-After (seconds or HTTP date) or GitHub X-RateLimit-Reset (epoch seconds) when exhausted. */
export function rateLimitWaitMs(res: { headers: Headers }, now = Date.now()): number | null {
  const ra = res.headers.get('retry-after');
  if (ra) {
    const secs = Number(ra);
    if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
    const at = Date.parse(ra);
    if (!Number.isNaN(at)) return Math.max(0, at - now);
  }
  if (res.headers.get('x-ratelimit-remaining') === '0') {
    const reset = Number(res.headers.get('x-ratelimit-reset'));
    if (Number.isFinite(reset) && reset > 0) return Math.max(0, reset * 1000 - now) + 1000;
  }
  return null;
}

/** Parse an RFC 5988 Link header and return the rel="next" URL, if any. */
export function nextLink(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(',')) {
    const m = /<([^>]+)>\s*;\s*rel="?([^";]+)"?/.exec(part.trim());
    if (m && m[2]?.split(/\s+/).includes('next')) return m[1] ?? null;
  }
  return null;
}
