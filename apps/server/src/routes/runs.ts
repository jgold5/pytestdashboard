import type { FastifyInstance } from 'fastify';
import {
  HistoryMatrixQuery,
  IdParam,
  RunCompareQuery,
  RunQuery,
  RunResultsQuery,
  RunUpdate,
} from '@ptd/shared';
import type { Deps } from '../deps.js';
import { parseWith } from '../errors.js';
import { compareRuns, historyMatrix } from '../domain/history.js';
import { deleteRun, getResult, getRunRow, listRunResults, listRuns, runFailureGroups, serializeRun, updateRun } from '../domain/runs.js';
import { MAX_RESULTS_PER_HISTORY_IMPORT, importAllureRun, importHistory } from '../import/allure/importRun.js';
import { collectAllureUpload, collectHistoryUpload } from '../import/allure/upload.js';
import type { ZipLimits } from '../import/zip.js';

export function runRoutes(app: FastifyInstance, { db }: Deps, zipLimits?: ZipLimits): void {
  app.get('/api/runs', async (req) => {
    const q = parseWith(RunQuery, req.query);
    const { items, total } = listRuns(db, q);
    return { items, total, page: q.page, pageSize: q.pageSize };
  });

  // 'ingest': editors, or the CI-only INGEST_TOKEN (which can call nothing else)
  app.post('/api/runs/import', { config: { access: 'ingest', rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { bundle, fields } = await collectAllureUpload(req, zipLimits);
    const result = importAllureRun(db, bundle, fields);
    req.log.info(
      { runId: result.run.id, results: result.run.counts.total, created: result.createdTestCases },
      'allure results imported',
    );
    return reply.status(201).send(result);
  });

  // Many runs at once: allure-history snapshots, several result folders, or one folder holding many runs.
  app.post(
    '/api/runs/import-history',
    { config: { access: 'ingest', rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const { bundle, fields } = await collectHistoryUpload(req, zipLimits, MAX_RESULTS_PER_HISTORY_IMPORT);
      const result = importHistory(db, bundle, fields);
      req.log.info(
        { mode: result.mode, runs: result.runs.length, duplicates: result.duplicateRuns, created: result.createdTestCases },
        'allure history imported',
      );
      return reply.status(201).send(result);
    },
  );

  app.get('/api/runs/compare', async (req) => {
    const q = parseWith(RunCompareQuery, req.query);
    return compareRuns(db, q.head, q.base);
  });

  app.get('/api/history/matrix', async (req) => historyMatrix(db, parseWith(HistoryMatrixQuery, req.query)));

  app.get('/api/runs/:id', async (req) => {
    const { id } = parseWith(IdParam, req.params);
    return serializeRun(getRunRow(db, id));
  });

  app.patch('/api/runs/:id', async (req) => {
    const { id } = parseWith(IdParam, req.params);
    const patch = parseWith(RunUpdate, req.body);
    return db.transaction((tx) => updateRun(tx, id, patch));
  });

  app.delete('/api/runs/:id', async (req, reply) => {
    const { id } = parseWith(IdParam, req.params);
    db.transaction((tx) => deleteRun(tx, id));
    return reply.status(204).send();
  });

  app.get('/api/runs/:id/results', async (req) => {
    const { id } = parseWith(IdParam, req.params);
    const q = parseWith(RunResultsQuery, req.query);
    const { items, total } = listRunResults(db, id, q);
    return { items, total, page: q.page, pageSize: q.pageSize };
  });

  app.get('/api/results/:id', async (req) => {
    const { id } = parseWith(IdParam, req.params);
    return getResult(db, id);
  });

  app.get('/api/runs/:id/failures', async (req) => {
    const { id } = parseWith(IdParam, req.params);
    return runFailureGroups(db, id);
  });
}
