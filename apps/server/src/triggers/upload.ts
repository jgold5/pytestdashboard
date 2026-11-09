/**
 * Collect a repository snapshot for a trigger scan: one .zip of the repo (or of the
 * relevant folders), or loose files whose folder is given in the field name
 * (`file:<folder>`, as for history imports). Only Camel XML, .properties and
 * pytest files are read; everything else is skipped unread.
 */
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { finished, pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import type { FastifyRequest } from 'fastify';
import { TriggerScanFields, type TriggerScanSummary } from '@ptd/shared';
import { badRequest, parseWith } from '../errors.js';
import { dirName } from '../import/allure/upload.js';
import { DEFAULT_ZIP_LIMITS, baseName, readZip, type ZipLimits } from '../import/zip.js';
import { isPytestFile, type ScanInput } from './scan.js';

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const FIELDS = new Set(['branch', 'commit', 'label', 'only']);
/** Build output, dependencies and VCS folders never hold the routes we want (and can be huge). */
const SKIP_DIR = /(^|\/)(\.git|node_modules|target|build|dist|out|\.venv|venv|site-packages|__pycache__|\.idea|\.gradle|\.mvn)(\/|$)/;

export type FileClass = 'xml' | 'properties' | 'tests';

/**
 * Java/Kotlin test source sets: their route XML is copies of routes for unit and integration
 * tests, and their .properties override the real ones for those tests. Neither is scope.
 */
const TEST_SOURCES = /(^|\/)src\/(test|it|integrationTest|integration-test|intTest|testFixtures|e2e)\//;

export function classify(filePath: string): FileClass | null {
  if (SKIP_DIR.test(filePath)) return null;
  if (/\.xml$/i.test(filePath)) return TEST_SOURCES.test(filePath) ? null : 'xml';
  if (/\.properties$/i.test(filePath)) return TEST_SOURCES.test(filePath) ? null : 'properties';
  if (isPytestFile(filePath)) return 'tests';
  return null;
}

/** Which classes of file a scan of only one side reads (the other side is never even unpacked). */
const wanted = (only: 'routes' | 'tests' | undefined) => (cls: FileClass | null): boolean =>
  cls !== null && (only === 'tests' ? cls === 'tests' : only === 'routes' ? cls !== 'tests' : true);

async function readCapped(stream: Readable, cap: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  let over = false;
  for await (const chunk of stream) {
    size += (chunk as Buffer).length;
    if (size > cap) over = true;
    if (!over) chunks.push(chunk as Buffer);
  }
  return over ? null : Buffer.concat(chunks, size);
}

export interface CollectedRepo {
  input: ScanInput & { xml: Array<{ path: string; text: string }>; properties: Array<{ path: string; text: string }>; tests: Array<{ path: string; text: string }> };
  files: TriggerScanSummary['files'];
  warnings: string[];
}

function emptyRepo(): CollectedRepo {
  return { input: { xml: [], properties: [], tests: [] }, files: { xml: 0, properties: 0, tests: 0 }, warnings: [] };
}

function adder(repo: CollectedRepo) {
  return (filePath: string, data: Buffer) => {
    const cls = classify(filePath);
    if (!cls) return;
    // a BOM or Latin-1 file still scans
    repo.input[cls].push({ path: filePath, text: data.toString('utf8').replace(/^\uFEFF/, '') });
    repo.files[cls]++;
  };
}

/** Keep only the routes side (Camel repo) or the tests side (test repo) of a snapshot. */
export function applyOnly(repo: CollectedRepo, only: 'routes' | 'tests' | undefined): void {
  if (only === 'tests') {
    repo.input.xml.length = 0;
    repo.input.properties.length = 0;
    repo.files.xml = repo.files.properties = 0;
  } else if (only === 'routes') {
    repo.input.tests.length = 0;
    repo.files.tests = 0;
  }
}

/** Limits for a whole-repo archive from GitHub: many entries, but only small XML/properties/py files are read. */
export const REPO_ARCHIVE_LIMITS: ZipLimits = {
  ...DEFAULT_ZIP_LIMITS,
  maxEntries: 1_000_000,
  maxTotalBytes: 16 * 1024 * 1024 * 1024,
  maxEntryBytes: MAX_FILE_BYTES,
};

/**
 * Read a repo snapshot from a zip on disk. GitHub archives put everything under one
 * `<owner>-<repo>-<sha>/` folder: `stripTopDir` removes it (and returns its name).
 */
export async function readRepoZip(
  zipPath: string,
  limits: ZipLimits,
  opts: { stripTopDir?: boolean; only?: 'routes' | 'tests' } = {},
): Promise<{ repo: CollectedRepo; topDir: string | null }> {
  const repo = emptyRepo();
  const add = adder(repo);
  let topDir: string | null = null;
  const rel = (entry: string): string => {
    if (!opts.stripTopDir) return entry;
    const cut = entry.indexOf('/');
    if (cut < 0) return entry;
    topDir ??= entry.slice(0, cut);
    return entry.slice(cut + 1);
  };
  const want = wanted(opts.only);
  await readZip(
    { path: zipPath },
    (entry) => want(classify(rel(entry))),
    (entry, data) => add(rel(entry), data),
    limits,
    (entry, bytes) => repo.warnings.push(`${rel(entry)}: ${Math.round(bytes / 1024 / 1024)} MB, over the ${MAX_FILE_BYTES / 1024 / 1024} MB a file may be: skipped`),
  );
  return { repo, topDir };
}

export async function collectRepoUpload(req: FastifyRequest, zipLimits: ZipLimits = DEFAULT_ZIP_LIMITS): Promise<{ repo: CollectedRepo; fields: TriggerScanFields }> {
  const repo = emptyRepo();
  const add = adder(repo);
  const rawFields: Record<string, string> = {};
  let tmpDir: string | null = null;
  let zipPath: string | null = null;
  let loose = 0;
  try {
    for await (const part of req.parts()) {
      if (part.type === 'field') {
        if (FIELDS.has(part.fieldname) && typeof part.value === 'string' && part.value.trim()) rawFields[part.fieldname] = part.value;
        continue;
      }
      const name = baseName((part.filename || '').replace(/\\/g, '/'));
      if (/\.zip$/i.test(name) || part.mimetype === 'application/zip' || part.mimetype === 'application/x-zip-compressed') {
        if (zipPath) throw badRequest('Upload a single .zip (or the individual files), not several zips');
        tmpDir = await mkdtemp(path.join(os.tmpdir(), 'ptd-scan-'));
        zipPath = path.join(tmpDir, 'repo.zip');
        await pipeline(part.file, createWriteStream(zipPath, { mode: 0o600 }));
        continue;
      }
      const dir = part.fieldname.startsWith('file:') ? dirName(`${part.fieldname.slice(5)}/x`) : '';
      const filePath = dir ? `${dir}/${name}` : name;
      if (!classify(filePath)) {
        await finished(part.file.resume());
        continue;
      }
      const data = await readCapped(part.file, MAX_FILE_BYTES);
      if (data === null) {
        repo.warnings.push(`${filePath}: file too large, skipped`);
        continue;
      }
      loose++;
      add(filePath, data);
    }
    if (zipPath) {
      if (loose > 0) throw badRequest('Upload either a .zip or individual files, not both');
      const want = wanted(rawFields.only === 'routes' || rawFields.only === 'tests' ? rawFields.only : undefined);
      await readZip(
        { path: zipPath },
        (entry) => want(classify(entry)),
        (entry, data) => add(entry, data),
        { ...zipLimits, maxEntryBytes: Math.min(zipLimits.maxEntryBytes, MAX_FILE_BYTES) },
        (entry, bytes) => repo.warnings.push(`${entry}: ${Math.round(bytes / 1024 / 1024)} MB, over the ${MAX_FILE_BYTES / 1024 / 1024} MB a file may be: skipped`),
      );
    }
  } finally {
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  }
  return { repo, fields: parseWith(TriggerScanFields, rawFields) };
}
