import type { FastifyInstance } from 'fastify';
import { ImportCommitRequest, ImportStatusValuesRequest, type ImportPreviewResponse } from '@ptd/shared';
import type { Deps } from '../deps.js';
import { AppError, badRequest, parseWith } from '../errors.js';
import { commitImport, findSheet, statusValues } from '../import/spreadsheet/commit.js';
import { suggestMapping } from '../import/spreadsheet/headers.js';
import { SHEET_LIMITS, parseSpreadsheet } from '../import/spreadsheet/parse.js';

const IMPORT_RATE = { max: 30, timeWindow: '1 minute' };

export function importRoutes(app: FastifyInstance, { db, uploads }: Deps): void {
  app.post('/api/test-cases/import/preview', { config: { rateLimit: IMPORT_RATE } }, async (req): Promise<ImportPreviewResponse> => {
    const file = await req.file({ limits: { fileSize: SHEET_LIMITS.maxFileBytes, files: 1, fields: 5 } });
    if (!file) throw badRequest('Upload one .xlsx, .csv or .tsv file');
    const buffer = await file.toBuffer();
    const fileName = (file.filename || 'upload').replace(/[\\/]/g, '_').slice(0, 200);
    const sheets = await parseSpreadsheet(buffer, fileName);
    if (sheets.every((s) => s.headers.length === 0)) {
      throw new AppError(400, 'empty_spreadsheet', 'The file contains no data');
    }
    const uploadId = uploads.put(fileName, sheets);
    return {
      uploadId,
      fileName,
      sheets: sheets.map((s) => ({
        name: s.name,
        headers: s.headers,
        rowCount: s.rows.length,
        sampleRows: s.rows.slice(0, 20).map((r) => r.cells),
        suggestedMapping: suggestMapping(s.headers),
      })),
    };
  });

  const loadUpload = (uploadId: string) => {
    const u = uploads.get(uploadId);
    if (!u) throw new AppError(404, 'upload_expired', 'Upload not found or expired — please upload the file again');
    return u;
  };

  app.post('/api/test-cases/import/status-values', async (req) => {
    const body = parseWith(ImportStatusValuesRequest, req.body);
    return statusValues(findSheet(loadUpload(body.uploadId).sheets, body.sheet), body.column);
  });

  app.post('/api/test-cases/import/commit', { config: { rateLimit: IMPORT_RATE } }, async (req) => {
    const body = parseWith(ImportCommitRequest, req.body);
    const upload = loadUpload(body.uploadId);
    return commitImport(db, findSheet(upload.sheets, body.sheet), body);
  });
}
