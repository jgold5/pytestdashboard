/**
 * Collect an allure-results upload from multipart: EITHER one .zip OR many
 * individual files. Uploaded filenames are only used for basename matching —
 * never for filesystem paths (a zip is spooled to a random temp file).
 */
import { createWriteStream } from 'node:fs';
import { mkdtemp, open, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { finished, pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import type { FastifyRequest } from 'fastify';
import { RunImportFields } from '@ptd/shared';
import { badRequest, parseWith } from '../../errors.js';
import { baseName, isZipMagic, readZip, type ZipLimits, DEFAULT_ZIP_LIMITS } from '../zip.js';
import { AllureBundle, MAX_JSON_BYTES, isAllowedAllureFile } from './parse.js';

const FIELD_NAMES = new Set(['name', 'branch', 'commit', 'buildUrl', 'runGroup']);

/** Read a stream into memory up to `cap` bytes; returns null (and drains) when larger. */
async function readCapped(stream: Readable, cap: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  let over = false;
  for await (const chunk of stream) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > cap) over = true;
    if (!over) chunks.push(buf);
  }
  return over ? null : Buffer.concat(chunks, size);
}

async function hasZipMagic(file: string): Promise<boolean> {
  const fh = await open(file, 'r');
  try {
    const head = Buffer.alloc(4);
    await fh.read(head, 0, 4, 0);
    return isZipMagic(head);
  } finally {
    await fh.close();
  }
}

export async function collectAllureUpload(
  req: FastifyRequest,
  zipLimits: ZipLimits = DEFAULT_ZIP_LIMITS,
): Promise<{ bundle: AllureBundle; fields: RunImportFields }> {
  const bundle = new AllureBundle();
  const rawFields: Record<string, string> = {};
  let tmpDir: string | null = null;
  let zipPath: string | null = null;
  let individualFiles = 0;

  try {
    for await (const part of req.parts()) {
      if (part.type === 'field') {
        if (FIELD_NAMES.has(part.fieldname) && typeof part.value === 'string' && part.value.trim() !== '') {
          rawFields[part.fieldname] = part.value;
        }
        continue;
      }
      const name = baseName((part.filename || '').replace(/\\/g, '/'));
      const looksZip = /\.zip$/i.test(name) || part.mimetype === 'application/zip' || part.mimetype === 'application/x-zip-compressed';
      if (looksZip) {
        if (zipPath) throw badRequest('Upload a single .zip (or the individual files), not several zips');
        tmpDir = await mkdtemp(path.join(os.tmpdir(), 'ptd-upload-'));
        zipPath = path.join(tmpDir, 'upload.zip');
        await pipeline(part.file, createWriteStream(zipPath, { mode: 0o600 }));
        continue;
      }
      if (!isAllowedAllureFile(name)) {
        await finished(part.file.resume());
        bundle.skippedFiles++;
        continue;
      }
      const data = await readCapped(part.file, MAX_JSON_BYTES);
      if (data === null) {
        bundle.warn(`${name}: file too large, skipped`);
        bundle.skippedFiles++;
        continue;
      }
      individualFiles++;
      bundle.addFile(name, data);
    }

    if (zipPath) {
      if (individualFiles > 0) throw badRequest('Upload either a .zip or individual files, not both');
      if (!(await hasZipMagic(zipPath))) throw badRequest('The uploaded .zip is not a valid zip archive');
      const res = await readZip(
        { path: zipPath },
        (entryName) => isAllowedAllureFile(baseName(entryName)),
        (entryName, data) => bundle.addFile(baseName(entryName), data),
        zipLimits,
      );
      bundle.skippedFiles += res.skipped;
    }
  } finally {
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  }

  return { bundle, fields: parseWith(RunImportFields, rawFields) };
}
