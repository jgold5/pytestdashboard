import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { SheetCompareRequest, TriggerGithubScanRequest, TriggerOverviewQuery, TriggerQuery, type SheetComparePreviewResponse, type TriggerGithubInfo } from '@ptd/shared';
import type { Deps } from '../deps.js';
import { recordCoverageSnapshot } from '../domain/coverage.js';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AppError, badRequest, parseWith } from '../errors.js';
import { findSheet } from '../import/spreadsheet/commit.js';
import { SHEET_LIMITS, parseSpreadsheet } from '../import/spreadsheet/parse.js';
import { compareSheet, detectColumns } from '../triggers/sheetCompare.js';
import { commitFromTopDir, downloadBranchZip, listBranches } from '../integrations/githubArchive.js';
import type { ZipLimits } from '../import/zip.js';
import { prScanStatus, startPrScan, stopPrScan } from '../triggers/prBranchSync.js';
import { routeOverview } from '../triggers/routeCoverage.js';
import { scanRepository } from '../triggers/scan.js';
import { deleteBranchScans, listTriggers, saveScan, unlinkedTests } from '../triggers/store.js';
import { REPO_ARCHIVE_LIMITS, applyOnly, collectRepoUpload, readRepoZip } from '../triggers/upload.js';

const BranchParam = z.object({ branch: z.string().trim().min(1).max(200) });

const RepoQuery = z.object({ repo: z.string().trim().regex(/^[\w.-]+\/[\w.-]+$/) });

export function triggerRoutes(app: FastifyInstance, { db, config, uploads }: Deps, zipLimits?: ZipLimits): void {
  // 'ingest': CI scans every branch / PR with the upload-only token
  app.post('/api/triggers/scan', { config: { access: 'ingest', rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { repo, fields } = await collectRepoUpload(req, zipLimits);
    applyOnly(repo, fields.only);
    if (repo.files.xml === 0 && repo.files.tests === 0) {
      throw new AppError(400, 'nothing_to_scan', 'No Camel route XML or pytest test files found in the upload', { warnings: repo.warnings });
    }
    const out = scanRepository(repo.input);
    out.warnings.unshift(...repo.warnings);
    const result = db.transaction((tx) => {
      const saved = saveScan(tx, fields, out, repo.files);
      recordCoverageSnapshot(tx); // the headline coverage counts routes once the Camel repo is scanned
      return saved;
    });
    req.log.info({ branch: result.branch, triggers: result.total, automated: result.automated }, 'trigger scan stored');
    return reply.status(201).send(result);
  });

  app.get('/api/triggers', async (req) => listTriggers(db, parseWith(TriggerQuery, req.query)));
  app.get('/api/triggers/overview', async (req) => routeOverview(db, parseWith(TriggerOverviewQuery, req.query)));
  app.get('/api/triggers/unlinked-tests', async (req) => unlinkedTests(db, parseWith(TriggerQuery, req.query)));

  // Compare with my sheet: upload a spreadsheet of routes, then compare it with what the dashboard counts
  app.post('/api/triggers/compare-sheet/preview', { config: { access: 'viewer', rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req): Promise<SheetComparePreviewResponse> => {
    const file = await req.file({ limits: { fileSize: SHEET_LIMITS.maxFileBytes, files: 1, fields: 5 } });
    if (!file) throw badRequest('Upload one .xlsx, .csv or .tsv file');
    const fileName = (file.filename || 'upload').replace(/[\\/]/g, '_').slice(0, 200);
    const sheets = await parseSpreadsheet(await file.toBuffer(), fileName);
    if (sheets.every((s) => s.headers.length === 0)) throw new AppError(400, 'empty_spreadsheet', 'The file contains no data');
    const uploadId = uploads.put(fileName, sheets);
    return { uploadId, fileName, sheets: sheets.map((s) => ({ name: s.name, headers: s.headers, rowCount: s.rows.length, columns: detectColumns(s.headers) })) };
  });
  app.post('/api/triggers/compare-sheet', { config: { access: 'viewer', rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    const body = parseWith(SheetCompareRequest, req.body);
    const upload = uploads.get(body.uploadId);
    if (!upload) throw new AppError(404, 'upload_expired', 'Upload not found or expired — please upload the file again');
    return compareSheet(db, findSheet(upload.sheets, body.sheet), body);
  });

  // Scan any branch of a configured repo straight from GitHub (editor only: it uses the GitHub token)
  app.get('/api/triggers/github', async (): Promise<TriggerGithubInfo> => ({
    configured: Boolean(config.github.token) && config.github.repos.length > 0,
    repos: config.github.token ? config.github.repos : [],
  }));

  app.get('/api/triggers/github/branches', async (req) => {
    const { repo } = parseWith(RepoQuery, req.query);
    return { branches: await listBranches(config.github, repo) };
  });

  app.post('/api/triggers/scan-github', { config: { rateLimit: { max: 6, timeWindow: '1 minute' } } }, async (req, reply) => {
    const body = parseWith(TriggerGithubScanRequest, req.body);
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'ptd-gh-'));
    try {
      const zip = path.join(tmp, 'branch.zip');
      await downloadBranchZip(config.github, body.repo, body.branch, zip);
      const { repo, topDir } = await readRepoZip(zip, REPO_ARCHIVE_LIMITS, { stripTopDir: true, only: body.only });
      applyOnly(repo, body.only);
      if (repo.files.xml === 0 && repo.files.tests === 0) {
        throw new AppError(400, 'nothing_to_scan', `${body.repo}@${body.branch} has no ${body.only === 'routes' ? 'Camel route XML' : 'Python test files'}`);
      }
      const out = scanRepository(repo.input);
      out.warnings.unshift(...repo.warnings);
      const fields = { branch: body.branch, commit: commitFromTopDir(topDir), label: body.repo, only: body.only };
      const result = db.transaction((tx) => {
        const saved = saveScan(tx, fields, out, repo.files);
        recordCoverageSnapshot(tx);
        return saved;
      });
      req.log.info({ repo: body.repo, branch: body.branch, only: body.only, triggers: result.total, tests: result.testsFound }, 'github branch scanned');
      return reply.status(201).send(result);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  // Scan every open PR branch of the test repo (editor only): runs in the background, poll GET
  app.get('/api/triggers/pr-scan', async () => prScanStatus(db));
  app.addHook('onClose', async () => stopPrScan(db));
  app.post('/api/triggers/pr-scan', { config: { rateLimit: { max: 6, timeWindow: '1 minute' } } }, async (req, reply) =>
    reply.status(202).send(startPrScan(db, config.github, req.log)),
  );

  app.delete('/api/triggers/branches/:branch', async (req, reply) => {
    const { branch } = parseWith(BranchParam, req.params);
    db.transaction((tx) => {
      deleteBranchScans(tx, branch);
      recordCoverageSnapshot(tx);
    });
    return reply.status(204).send();
  });
}
