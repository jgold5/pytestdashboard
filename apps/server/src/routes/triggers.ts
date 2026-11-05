import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { TriggerQuery } from '@ptd/shared';
import type { Deps } from '../deps.js';
import { AppError, parseWith } from '../errors.js';
import type { ZipLimits } from '../import/zip.js';
import { scanRepository } from '../triggers/scan.js';
import { deleteBranchScans, listTriggers, saveScan } from '../triggers/store.js';
import { collectRepoUpload } from '../triggers/upload.js';

const BranchParam = z.object({ branch: z.string().trim().min(1).max(200) });

export function triggerRoutes(app: FastifyInstance, { db }: Deps, zipLimits?: ZipLimits): void {
  // 'ingest': CI scans every branch / PR with the upload-only token
  app.post('/api/triggers/scan', { config: { access: 'ingest', rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { repo, fields } = await collectRepoUpload(req, zipLimits);
    if (fields.only === 'tests') {
      repo.input.xml.length = 0;
      repo.input.properties.length = 0;
      repo.files.xml = repo.files.properties = 0;
    } else if (fields.only === 'routes') {
      repo.input.tests.length = 0;
      repo.files.tests = 0;
    }
    if (repo.files.xml === 0 && repo.files.tests === 0) {
      throw new AppError(400, 'nothing_to_scan', 'No Camel route XML or pytest test files found in the upload', { warnings: repo.warnings });
    }
    const out = scanRepository(repo.input);
    out.warnings.unshift(...repo.warnings);
    const result = db.transaction((tx) => saveScan(tx, fields, out, repo.files));
    req.log.info({ branch: result.branch, triggers: result.total, automated: result.automated }, 'trigger scan stored');
    return reply.status(201).send(result);
  });

  app.get('/api/triggers', async (req) => listTriggers(db, parseWith(TriggerQuery, req.query)));

  app.delete('/api/triggers/branches/:branch', async (req, reply) => {
    const { branch } = parseWith(BranchParam, req.params);
    db.transaction((tx) => deleteBranchScans(tx, branch));
    return reply.status(204).send();
  });
}
