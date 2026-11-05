/**
 * Download one branch of a configured GitHub repo as a zip, so a trigger scan can run on
 * any branch from the dashboard (no CI upload needed).
 *
 * - Only repos listed in GITHUB_REPOS, so the dashboard can't be used to fetch arbitrary
 *   repos with the token.
 * - `GET /repos/{owner}/{repo}/zipball/{ref}` answers with a redirect to GitHub's download
 *   host (codeload.github.com, codeload.<x>.ghe.com, or the same host on GHES). Only those
 *   are followed, without the Authorization header (the redirect URL carries a short-lived
 *   token itself), and only once.
 * - The download is streamed to a file with a byte cap; errors never include the token or
 *   the signed download URL.
 */
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import type { GithubConfig } from '../config.js';
import { AppError } from '../errors.js';
import { HttpClient, assertSafeBaseUrl } from './http.js';

/** Cap on the downloaded archive (compressed). */
export const MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;
/** Branch / tag names: what git allows that is safe in a URL path, no `..`. */
export const SafeRef = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[\w.\-/@+]+$/, 'not a valid branch name')
  .refine((r) => !r.includes('..') && !r.startsWith('/') && !r.endsWith('/'), 'not a valid branch name');

export function assertConfiguredRepo(cfg: GithubConfig, repo: string): void {
  if (!cfg.token) throw new AppError(400, 'github_not_configured', 'Set GITHUB_TOKEN to scan branches from GitHub');
  if (!cfg.repos.includes(repo)) {
    throw new AppError(400, 'repo_not_configured', `${repo} is not in GITHUB_REPOS`);
  }
}

/** Hosts a zipball redirect may point to for this API base. */
export function downloadHosts(apiUrl: string): string[] {
  const api = assertSafeBaseUrl(apiUrl, 'GitHub').hostname;
  if (api === 'api.github.com') return ['codeload.github.com', api];
  const ghe = /^api\.(.+\.ghe\.com)$/.exec(api);
  if (ghe) return [`codeload.${ghe[1]}`, api];
  return [api]; // GHES serves archives from its own host
}

const ghHeaders = (token: string) => ({
  authorization: `Bearer ${token}`,
  accept: 'application/vnd.github+json',
  'x-github-api-version': '2022-11-28',
  'user-agent': 'pytest-dashboard',
});

async function failure(res: Response, what: string): Promise<AppError> {
  await res.body?.cancel().catch(() => undefined);
  if (res.status === 404) return new AppError(404, 'branch_not_found', `${what}: repo or branch not found (or the token can't see it)`);
  if (res.status === 401) return new AppError(502, 'github_auth', `${what}: GitHub rejected the token (HTTP 401)`);
  if (res.status === 403) return new AppError(502, 'github_forbidden', `${what}: GitHub refused access (HTTP 403 — token scope, SSO or rate limit)`);
  return new AppError(502, 'github_error', `${what}: GitHub answered HTTP ${res.status}`);
}

/** Stream `branch` of `repo` into `destFile`; returns the commit id from the archive's top folder later (see commitFromTopDir). */
export async function downloadBranchZip(
  cfg: GithubConfig,
  repo: string,
  branch: string,
  destFile: string,
  opts: { maxBytes?: number; signal?: AbortSignal } = {},
): Promise<void> {
  assertConfiguredRepo(cfg, repo);
  const ref = SafeRef.parse(branch);
  const base = assertSafeBaseUrl(cfg.apiUrl, 'GitHub');
  const [owner, name] = repo.split('/') as [string, string];
  const refPath = ref.split('/').map(encodeURIComponent).join('/');
  const url = new URL(`${base.pathname.replace(/\/+$/, '')}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/zipball/${refPath}`, base.origin);
  const what = `Download ${repo}@${ref}`;
  const signal = opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)]) : AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);

  let res = await fetch(url, { headers: ghHeaders(cfg.token!), redirect: 'manual', signal });
  if (res.status >= 300 && res.status < 400) {
    const loc = res.headers.get('location');
    await res.body?.cancel().catch(() => undefined);
    if (!loc) throw new AppError(502, 'github_error', `${what}: redirect without a location`);
    const next = new URL(loc, url);
    const allowedProto = next.protocol === 'https:' || (next.protocol === 'http:' && next.hostname === base.hostname && base.protocol === 'http:');
    if (!allowedProto || !downloadHosts(cfg.apiUrl).includes(next.hostname)) {
      throw new AppError(502, 'github_error', `${what}: refused a redirect to ${next.hostname}`);
    }
    // the signed download URL authorizes itself; never forward the token to it
    res = await fetch(next, { headers: { 'user-agent': 'pytest-dashboard' }, redirect: 'manual', signal });
  }
  if (!res.ok || !res.body) throw await failure(res, what);

  const cap = opts.maxBytes ?? MAX_ARCHIVE_BYTES;
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared > cap) {
    await res.body.cancel().catch(() => undefined);
    throw new AppError(413, 'archive_too_large', `${what}: archive is larger than ${Math.round(cap / 1024 / 1024)} MB`);
  }
  let seen = 0;
  const counted = Readable.fromWeb(res.body as WebReadableStream<Uint8Array>);
  counted.on('data', (chunk: Buffer) => {
    seen += chunk.length;
    if (seen > cap) counted.destroy(new AppError(413, 'archive_too_large', `${what}: archive is larger than ${Math.round(cap / 1024 / 1024)} MB`));
  });
  await pipeline(counted, createWriteStream(destFile, { mode: 0o600 }));
}

/** GitHub archives have one top folder `<owner>-<repo>-<sha>`; its last part is the commit. */
export function commitFromTopDir(topDir: string | null): string | null {
  const m = topDir ? /-([0-9a-f]{7,40})$/i.exec(topDir) : null;
  return m ? (m[1] as string) : null;
}

/** Branch names of a configured repo (up to 1,000), for the scan dialog. */
export async function listBranches(cfg: GithubConfig, repo: string): Promise<string[]> {
  assertConfiguredRepo(cfg, repo);
  const gh = new HttpClient({ label: 'GitHub', baseUrl: cfg.apiUrl, headers: ghHeaders(cfg.token!), secrets: [cfg.token!] });
  const [owner, name] = repo.split('/') as [string, string];
  const out: string[] = [];
  for (let page = 1; page <= 10; page++) {
    const res = await gh.get(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/branches`, {
      query: { per_page: '100', page: String(page) },
      schema: z.array(z.looseObject({ name: z.string() })),
    });
    out.push(...res.data.map((b) => b.name));
    if (res.data.length < 100) break;
  }
  return out;
}
