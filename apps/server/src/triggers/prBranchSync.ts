/**
 * Keep the test repo's open PR branches scanned, so "triggers tested" counts their tests
 * as not merged yet without anyone scanning by hand (run by the GitHub sync).
 *
 * - A repo in GITHUB_REPOS is a *test repo* once the dashboard has scanned it as tests
 *   (Scan a branch → It holds: tests). The Camel repo's PRs are never scanned this way.
 * - Every open PR from a branch of that repo (not a fork) gets a tests scan of its branch,
 *   labelled `<repo> PR #<n> → <base>`. Its tests count as not merged yet only for the branch
 *   the PR targets (see routeCoverage). It is redone only when the head commit or the target
 *   changed.
 * - The scans it made are removed once no open PR uses their branch (merged or closed), so
 *   abandoned work stops counting. Scans made by hand are left alone (a long-lived branch
 *   can be the head of a release PR), and a Camel repo branch of the same name keeps its
 *   route scans.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { desc, inArray, isNotNull } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { GithubConfig } from '../config.js';
import type { Db } from '../db/client.js';
import { triggerScans } from '../db/schema.js';
import { recordCoverageSnapshot } from '../domain/coverage.js';
import { commitFromTopDir, downloadBranchZip } from '../integrations/githubArchive.js';
import { scanRepository } from './scan.js';
import { parsePrLabel, prLabel } from './prLabel.js';
import { saveScan } from './store.js';
import { REPO_ARCHIVE_LIMITS, applyOnly, readRepoZip } from './upload.js';

/** Branches that are never treated as PR branches (their scans are the merged tests). */
const DEFAULT_BRANCHES = new Set(['main', 'master', 'develop']);
/** Downloads per sync and repo; the rest wait for the next sync (head commits are compared, so nothing is redone). */
export const MAX_BRANCH_SCANS_PER_SYNC = 25;

export interface PrHead {
  number: number;
  state: 'open' | 'closed';
  ref: string;
  /** The branch the PR targets. */
  base: string;
  sha: string | null;
  /** owner/name the branch lives in; a fork's PR can't be downloaded with this repo's access. */
  repo: string | null;
}

export interface BranchScanStats {
  scanned: number;
  unchanged: number;
  removed: number;
  failed: number;
}

const isPrLabel = (repo: string, label: string | null) => parsePrLabel(label)?.repo === repo;

/** Test scans of this repo, newest first: scanned from the dashboard (label = repo) or by this sync. */
function testScansOf(db: Db, repo: string) {
  return db
    .select({ id: triggerScans.id, branch: triggerScans.branch, commit: triggerScans.commit, label: triggerScans.label, files: triggerScans.files })
    .from(triggerScans)
    .where(isNotNull(triggerScans.label))
    .orderBy(desc(triggerScans.scannedAt), desc(triggerScans.id))
    .all()
    .filter((r) => (r.label === repo || isPrLabel(repo, r.label)) && r.files.tests > 0 && r.files.xml === 0);
}

/** A repo the dashboard has scanned as tests. */
export function isTestRepo(db: Db, repo: string): boolean {
  return testScansOf(db, repo).length > 0;
}

export async function syncPrBranchScans(
  db: Db,
  cfg: GithubConfig,
  repo: string,
  prs: readonly PrHead[],
  ctx: { signal: AbortSignal; log: FastifyBaseLogger },
): Promise<BranchScanStats> {
  const stats: BranchScanStats = { scanned: 0, unchanged: 0, removed: 0, failed: 0 };
  const mine = testScansOf(db, repo);
  if (mine.length === 0) return stats;

  const open = prs.filter((p) => p.state === 'open' && p.repo === repo && !DEFAULT_BRANCHES.has(p.ref));
  const openRefs = new Set(prs.filter((p) => p.state === 'open').map((p) => p.ref));

  const latest = new Map<string, (typeof mine)[number]>();
  for (const r of mine) if (!latest.has(r.branch)) latest.set(r.branch, r);

  // 1. scan open PR branches whose head moved since their last scan
  let budget = MAX_BRANCH_SCANS_PER_SYNC;
  for (const pr of open) {
    if (ctx.signal.aborted) break;
    const last = latest.get(pr.ref);
    const label = prLabel(repo, pr.number, pr.base);
    if (last?.commit && pr.sha && pr.sha.startsWith(last.commit) && last.label === label) {
      stats.unchanged++;
      continue;
    }
    if (budget-- <= 0) break;
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'ptd-pr-'));
    try {
      const zip = path.join(tmp, 'branch.zip');
      await downloadBranchZip(cfg, repo, pr.ref, zip, { signal: ctx.signal });
      const { repo: snapshot, topDir } = await readRepoZip(zip, REPO_ARCHIVE_LIMITS, { stripTopDir: true });
      applyOnly(snapshot, 'tests');
      if (snapshot.files.tests === 0) {
        stats.unchanged++;
        continue;
      }
      const out = scanRepository(snapshot.input);
      db.transaction((tx) => {
        saveScan(tx, { branch: pr.ref, commit: commitFromTopDir(topDir), label, only: 'tests' }, out, snapshot.files);
      });
      stats.scanned++;
    } catch (e) {
      stats.failed++;
      ctx.log.warn({ repo, pr: pr.number, branch: pr.ref, err: e instanceof Error ? e.message : String(e) }, 'PR branch scan failed');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }

  // 2. drop the scans this sync made of branches no open PR uses any more (merged or closed)
  const stale = mine.filter((r) => isPrLabel(repo, r.label) && !openRefs.has(r.branch));
  if (stale.length > 0) {
    db.delete(triggerScans).where(inArray(triggerScans.id, stale.map((r) => r.id))).run();
    stats.removed = new Set(stale.map((r) => r.branch)).size;
  }
  if (stats.scanned > 0 || stats.removed > 0) recordCoverageSnapshot(db);
  return stats;
}
