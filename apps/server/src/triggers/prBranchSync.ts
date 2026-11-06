/**
 * Scan the test repo's open PR branches on request (Triggers → Scan open PRs), so "triggers
 * tested" counts their tests as not merged yet for the branch each PR targets.
 *
 * - A repo in GITHUB_REPOS is a *test repo* once the dashboard has scanned it as tests
 *   (Scan a branch → It holds: tests). The Camel repo's PRs are never scanned this way.
 * - One job at a time works through every open PR from a branch of that repo (not a fork),
 *   a few downloads at a time, until all are done. Each scan is labelled
 *   `<repo> PR #<n> → <base>` and keeps the commit it was taken at.
 * - A PR whose head commit and target are unchanged since its last scan is skipped (up to
 *   date), so running it again only downloads what moved.
 * - The scans it made are removed once no open PR uses their branch (merged or closed).
 *   Scans made by hand are left alone, and a Camel repo branch of the same name keeps its
 *   route scans.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { desc, inArray, isNotNull } from 'drizzle-orm';
import { z } from 'zod';
import type { FastifyBaseLogger } from 'fastify';
import type { PrScanStatus } from '@ptd/shared';
import type { GithubConfig } from '../config.js';
import type { Db } from '../db/client.js';
import { triggerScans } from '../db/schema.js';
import { recordCoverageSnapshot } from '../domain/coverage.js';
import { commitFromTopDir, downloadBranchZip } from '../integrations/githubArchive.js';
import { paginate } from '../integrations/github.js';
import { HttpClient } from '../integrations/http.js';
import { parsePrLabel, prLabel } from './prLabel.js';
import { scanRepository } from './scan.js';
import { saveScan } from './store.js';
import { REPO_ARCHIVE_LIMITS, applyOnly, readRepoZip } from './upload.js';

/** Branches that are never treated as PR branches (their scans are the merged tests). */
const DEFAULT_BRANCHES = new Set(['main', 'master', 'develop']);
/** Branches downloaded at the same time. */
const PARALLEL = 3;
/** Open PRs listed per repo. */
const MAX_OPEN_PRS = 1000;

export interface PrHead {
  number: number;
  title: string;
  ref: string;
  /** The branch the PR targets. */
  base: string;
  sha: string | null;
  updatedAt: string;
  /** owner/name the branch lives in; a fork's PR can't be downloaded with this repo's access. */
  repo: string | null;
}

const isPrLabel = (repo: string, label: string | null) => parsePrLabel(label)?.repo === repo;

/** Test scans of this repo, newest first: scanned from the dashboard (label = repo) or by this job. */
function testScansOf(db: Db, repo: string) {
  return db
    .select({ id: triggerScans.id, branch: triggerScans.branch, commit: triggerScans.commit, label: triggerScans.label, files: triggerScans.files, scannedAt: triggerScans.scannedAt })
    .from(triggerScans)
    .where(isNotNull(triggerScans.label))
    .orderBy(desc(triggerScans.scannedAt), desc(triggerScans.id))
    .all()
    .filter((r) => (r.label === repo || isPrLabel(repo, r.label)) && r.files.tests > 0 && r.files.xml === 0);
}

/** The repos in GITHUB_REPOS the dashboard has scanned as tests. */
export const testRepos = (db: Db, cfg: GithubConfig): string[] => cfg.repos.filter((r) => testScansOf(db, r).length > 0);

const RestPr = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  updated_at: z.string(),
  head: z.object({ ref: z.string(), sha: z.string().nullish(), repo: z.object({ full_name: z.string() }).nullish() }).nullish(),
  base: z.object({ ref: z.string() }).nullish(),
});

async function listOpenPrs(cfg: GithubConfig, repo: string, signal: AbortSignal): Promise<PrHead[]> {
  const gh = new HttpClient({
    label: 'GitHub',
    baseUrl: cfg.apiUrl,
    headers: { authorization: `Bearer ${cfg.token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
    secrets: [cfg.token!],
    signal,
  });
  const [owner, name] = repo.split('/') as [string, string];
  const out: PrHead[] = [];
  await paginate(gh, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls`, { state: 'open', per_page: 100, sort: 'updated', direction: 'desc' }, z.array(RestPr), MAX_OPEN_PRS, (pr) => {
    if (pr.head?.ref && pr.base?.ref) {
      out.push({ number: pr.number, title: pr.title, ref: pr.head.ref, base: pr.base.ref, sha: pr.head.sha ?? null, updatedAt: pr.updated_at, repo: pr.head.repo?.full_name ?? null });
    }
  });
  return out;
}

type PrRow = PrScanStatus['prs'][number];

/**
 * Scan the open PRs that moved since their last scan (skipping those up to date), then drop
 * the scans of branches no open PR uses. `onUpdate` sees every status change, for progress.
 */
export async function scanPrBranches(
  db: Db,
  cfg: GithubConfig,
  repo: string,
  prs: readonly PrHead[],
  ctx: { signal: AbortSignal; log: FastifyBaseLogger; onUpdate?: (row: PrRow) => void },
): Promise<{ scanned: number; upToDate: number; removed: number; failed: number; skipped: number }> {
  const stats = { scanned: 0, upToDate: 0, removed: 0, failed: 0, skipped: 0 };
  const mine = testScansOf(db, repo);
  if (mine.length === 0) return stats;
  const latest = new Map<string, (typeof mine)[number]>();
  for (const r of mine) if (!latest.has(r.branch)) latest.set(r.branch, r);

  const rows: PrRow[] = [];
  const todo: Array<{ pr: PrHead; label: string; row: PrRow }> = [];
  for (const pr of prs) {
    const label = prLabel(repo, pr.number, pr.base);
    const last = latest.get(pr.ref);
    const row: PrRow = { repo, number: pr.number, title: pr.title.slice(0, 300), branch: pr.ref, base: pr.base, commit: null, scannedAt: null, status: 'pending', error: null };
    if (pr.repo !== repo || DEFAULT_BRANCHES.has(pr.ref)) {
      row.status = 'skipped';
      row.error = pr.repo !== repo ? 'from a fork' : 'a default branch';
      stats.skipped++;
    } else if (last?.commit && pr.sha && pr.sha.startsWith(last.commit) && last.label === label) {
      row.status = 'up_to_date';
      row.commit = last.commit;
      row.scannedAt = last.scannedAt;
      stats.upToDate++;
    } else todo.push({ pr, label, row });
    rows.push(row);
    ctx.onUpdate?.(row);
  }
  // never-scanned PRs first, then the most recently updated
  todo.sort((x, y) => Number(!latest.has(y.pr.ref)) - Number(!latest.has(x.pr.ref)) || y.pr.updatedAt.localeCompare(x.pr.updatedAt));

  let next = 0;
  const scanOne = async ({ pr, label, row }: (typeof todo)[number]) => {
    row.status = 'scanning';
    ctx.onUpdate?.(row);
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'ptd-pr-'));
    try {
      const zip = path.join(tmp, 'branch.zip');
      await downloadBranchZip(cfg, repo, pr.ref, zip, { signal: ctx.signal });
      const { repo: snapshot, topDir } = await readRepoZip(zip, REPO_ARCHIVE_LIMITS, { stripTopDir: true });
      applyOnly(snapshot, 'tests');
      if (snapshot.files.tests === 0) {
        row.status = 'skipped';
        row.error = 'no Python test files';
        stats.skipped++;
        return;
      }
      const out = scanRepository(snapshot.input);
      const commit = commitFromTopDir(topDir);
      const saved = db.transaction((tx) => saveScan(tx, { branch: pr.ref, commit, label, only: 'tests' }, out, snapshot.files));
      row.status = 'scanned';
      row.commit = commit;
      row.scannedAt = saved.scannedAt;
      stats.scanned++;
    } catch (e) {
      row.status = 'failed';
      row.error = (e instanceof Error ? e.message : String(e)).slice(0, 300);
      stats.failed++;
      ctx.log.warn({ repo, pr: pr.number, branch: pr.ref, err: row.error }, 'PR branch scan failed');
    } finally {
      await rm(tmp, { recursive: true, force: true });
      ctx.onUpdate?.(row);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(PARALLEL, todo.length) }, async () => {
      while (next < todo.length && !ctx.signal.aborted) await scanOne(todo[next++]!);
    }),
  );

  // drop the scans this job made of branches no open PR uses any more (merged or closed)
  const openRefs = new Set(prs.map((p) => p.ref));
  const stale = mine.filter((r) => isPrLabel(repo, r.label) && !openRefs.has(r.branch));
  if (stale.length > 0) {
    db.delete(triggerScans).where(inArray(triggerScans.id, stale.map((r) => r.id))).run();
    stats.removed = new Set(stale.map((r) => r.branch)).size;
  }
  if (stats.scanned > 0 || stats.removed > 0) recordCoverageSnapshot(db);
  return stats;
}

// ---------------------------------------------------------------------------
// The job behind the button: one at a time per database, progress kept in memory

const jobs = new WeakMap<Db, { status: PrScanStatus; controller: AbortController | null }>();
const idle = (): PrScanStatus => ({ state: 'idle', repos: [], startedAt: null, finishedAt: null, error: null, removed: 0, prs: [] });

export function prScanStatus(db: Db): PrScanStatus {
  return jobs.get(db)?.status ?? idle();
}

/** Start scanning every test repo's open PRs (no-op while one runs). Resolves when it has started. */
export function startPrScan(db: Db, cfg: GithubConfig, log: FastifyBaseLogger): PrScanStatus {
  const current = jobs.get(db);
  if (current?.status.state === 'running') return current.status;
  const repos = cfg.token ? testRepos(db, cfg) : [];
  const status: PrScanStatus = { ...idle(), state: 'running', repos, startedAt: new Date().toISOString() };
  const controller = new AbortController();
  jobs.set(db, { status, controller });
  if (repos.length === 0) {
    status.state = 'error';
    status.error = cfg.token
      ? 'No test repo yet: scan your pytest repo once with Scan a branch → It holds: tests.'
      : 'Set GITHUB_TOKEN to scan PR branches from GitHub.';
    status.finishedAt = new Date().toISOString();
    return status;
  }
  void (async () => {
    try {
      for (const repo of repos) {
        const prs = await listOpenPrs(cfg, repo, controller.signal);
        const index = new Map<number, number>();
        const res = await scanPrBranches(db, cfg, repo, prs, {
          signal: controller.signal,
          log,
          onUpdate: (row) => {
            const i = index.get(row.number);
            if (i === undefined) index.set(row.number, status.prs.push({ ...row }) - 1);
            else status.prs[i] = { ...row };
          },
        });
        status.removed += res.removed;
        log.info({ repo, ...res }, 'PR branches scanned');
      }
      status.state = 'done';
    } catch (e) {
      status.state = 'error';
      status.error = (e instanceof Error ? e.message : String(e)).slice(0, 500);
      log.warn({ err: status.error }, 'PR branch scan stopped');
    } finally {
      status.finishedAt = new Date().toISOString();
      const job = jobs.get(db);
      if (job) job.controller = null;
    }
  })();
  return status;
}

/** Stop a running job (on shutdown). */
export function stopPrScan(db: Db): void {
  jobs.get(db)?.controller?.abort(new Error('stopped'));
}
