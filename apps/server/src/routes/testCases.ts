import type { FastifyInstance } from 'fastify';
import { stringify } from 'csv-stringify/sync';
import {
  IdParam,
  TestCaseBulkUpdate,
  TestCaseCreate,
  TestCaseQuery,
  TestCaseUpdate,
  type TestCase,
} from '@ptd/shared';
import type { Deps } from '../deps.js';
import { parseWith } from '../errors.js';
import { recordCoverageSnapshot } from '../domain/coverage.js';
import {
  bulkUpdateCases,
  createCase,
  deleteCase,
  getCase,
  getCaseDetail,
  listCases,
  listCasesForExport,
  serializeCases,
  updateCase,
} from '../domain/testCases.js';
import { csvSafeCell } from '../util/csv.js';
import { isoDate } from '../util/time.js';

const EXPORT_MAX = 50_000;

const EXPORT_COLUMNS: Array<[string, (c: TestCase) => unknown]> = [
  ['key', (c) => c.key],
  ['title', (c) => c.title],
  ['suite', (c) => c.suite],
  ['priority', (c) => c.priority],
  ['automationStatus', (c) => c.automationStatus],
  ['owner', (c) => c.owner],
  ['tags', (c) => c.tags.join(', ')],
  ['jiraKey', (c) => c.jiraKey],
  ['externalUrl', (c) => c.externalUrl],
  ['allureId', (c) => c.allureId],
  ['allureFullName', (c) => c.allureFullName],
  ['source', (c) => c.source],
  ['lastStatus', (c) => c.lastResult?.status],
  ['lastRunAt', (c) => c.lastResult?.at],
  ['triage', (c) => c.triage],
  ['flakiness', (c) => c.flakiness],
  ['inOpenPr', (c) => (c.inOpenPr ? 'yes' : 'no')],
  ['pipelineStage', (c) => c.pipelineStage],
  ['noteCount', (c) => c.noteCount],
  ['updatedAt', (c) => c.updatedAt],
];

export function toCsv(cases: TestCase[]): string {
  const rows = cases.map((c) => EXPORT_COLUMNS.map(([, get]) => csvSafeCell(get(c))));
  return stringify([EXPORT_COLUMNS.map(([h]) => h), ...rows], { quoted_string: true });
}

export function testCaseRoutes(app: FastifyInstance, { db }: Deps): void {
  app.get('/api/test-cases', async (req) => {
    const q = parseWith(TestCaseQuery, req.query);
    const { items, total } = listCases(db, q);
    return { items, total, page: q.page, pageSize: q.pageSize };
  });

  app.get('/api/test-cases/export.csv', async (req, reply) => {
    const q = parseWith(TestCaseQuery, req.query);
    const csv = toCsv(listCasesForExport(db, q, EXPORT_MAX));
    return reply
      .type('text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="test-cases-${isoDate()}.csv"`)
      .header('cache-control', 'no-store')
      .send(`﻿${csv}`);
  });

  app.post('/api/test-cases', async (req, reply) => {
    const input = parseWith(TestCaseCreate, req.body);
    const row = db.transaction((tx) => {
      const r = createCase(tx, input);
      recordCoverageSnapshot(tx);
      return r;
    });
    const [tc] = serializeCases(db, [row]);
    return reply.status(201).send(tc);
  });

  app.post('/api/test-cases/bulk-update', async (req) => {
    const input = parseWith(TestCaseBulkUpdate, req.body);
    const updated = db.transaction((tx) => {
      const n = bulkUpdateCases(tx, input);
      recordCoverageSnapshot(tx);
      return n;
    });
    return { updated };
  });

  app.get('/api/test-cases/:id', async (req) => {
    const { id } = parseWith(IdParam, req.params);
    return getCaseDetail(db, id);
  });

  app.patch('/api/test-cases/:id', async (req) => {
    const { id } = parseWith(IdParam, req.params);
    const patch = parseWith(TestCaseUpdate, req.body);
    db.transaction((tx) => {
      updateCase(tx, id, patch);
      recordCoverageSnapshot(tx);
    });
    return getCase(db, id);
  });

  app.delete('/api/test-cases/:id', async (req, reply) => {
    const { id } = parseWith(IdParam, req.params);
    db.transaction((tx) => {
      deleteCase(tx, id);
      recordCoverageSnapshot(tx);
    });
    return reply.status(204).send();
  });
}
