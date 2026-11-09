/**
 * Safe, streaming zip reader built on yauzl. Nothing is ever extracted to disk.
 * Protections: zip-slip (absolute paths, `..`, backslashes, drive letters),
 * entry-count cap, per-entry and total uncompressed-size caps (declared sizes
 * are verified while streaming by yauzl's validateEntrySizes), compression-ratio
 * bomb detection, and an allow-list predicate so only wanted entries are read.
 */
import { stat } from 'node:fs/promises';
import yauzl, { type Entry, type ZipFile } from 'yauzl';
import { AppError } from '../errors.js';

export interface ZipLimits {
  maxEntries: number;
  maxEntryBytes: number;
  maxTotalBytes: number;
  /** uncompressed / compressed above this ⇒ bomb (only checked for entries ≥ ratioMinBytes). */
  maxRatio: number;
  ratioMinBytes: number;
  /** Declared uncompressed bytes of *read* entries / archive size (whole-archive bomb check). */
  maxAggregateRatio: number;
}

/** Defaults for allure-results zips (entries we read are JSON/properties ≤ 5 MB). */
export const DEFAULT_ZIP_LIMITS: ZipLimits = {
  maxEntries: 50_000,
  maxEntryBytes: 5 * 1024 * 1024,
  maxTotalBytes: 512 * 1024 * 1024,
  maxRatio: 250,
  ratioMinBytes: 1024 * 1024,
  maxAggregateRatio: 100,
};

export class ZipSafetyError extends AppError {
  constructor(message: string, status = 400) {
    super(status, status === 413 ? 'payload_too_large' : 'unsafe_archive', message);
  }
}

export const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
export const isZipMagic = (head: Buffer): boolean => head.length >= 4 && head.subarray(0, 4).equals(ZIP_MAGIC);

/** True for paths that could escape an extraction root (we never extract, but such archives are hostile). */
export function isUnsafeEntryName(name: string): boolean {
  if (name.length === 0 || name.length > 1024) return true;
  if (name.includes('\0') || name.includes('\\')) return true;
  if (name.startsWith('/') || /^[a-zA-Z]:/.test(name)) return true;
  return name.split('/').some((seg) => seg === '..');
}

export const baseName = (name: string): string => name.slice(name.lastIndexOf('/') + 1);

export interface ZipReadResult {
  entries: number;
  read: number;
  skipped: number;
}

export type ZipSource = { buffer: Buffer } | { path: string };

function openZip(source: ZipSource): Promise<ZipFile> {
  const opts = { lazyEntries: true, autoClose: true, validateEntrySizes: true, decodeStrings: true } as const;
  return new Promise((resolve, reject) => {
    const cb = (err: Error | null, zip?: ZipFile) => {
      if (err || !zip) reject(new ZipSafetyError(`Invalid zip archive: ${safeMsg(err)}`));
      else resolve(zip);
    };
    if ('buffer' in source) yauzl.fromBuffer(source.buffer, opts, cb);
    else yauzl.open(source.path, opts, cb);
  });
}

function safeMsg(err: unknown): string {
  return err instanceof Error ? err.message.slice(0, 200) : 'unreadable';
}

function readEntry(zip: ZipFile, entry: Entry, cap: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (err, stream) => {
      if (err || !stream) return reject(new ZipSafetyError(`Cannot read zip entry: ${safeMsg(err)}`));
      const chunks: Buffer[] = [];
      let size = 0;
      stream.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > cap) {
          stream.destroy();
          reject(new ZipSafetyError('Zip entry exceeds size limit', 413));
          return;
        }
        chunks.push(chunk);
      });
      stream.on('error', (e) => reject(e instanceof AppError ? e : new ZipSafetyError(`Corrupt zip entry: ${safeMsg(e)}`)));
      stream.on('end', () => resolve(Buffer.concat(chunks, size)));
    });
  });
}

/**
 * Iterate entries; `accept(name)` decides which entries are read; `onEntry` receives
 * their content. Throws ZipSafetyError on any hostile/oversized archive.
 */
export async function readZip(
  source: ZipSource,
  accept: (entryName: string) => boolean,
  onEntry: (entryName: string, data: Buffer) => void | Promise<void>,
  limits: ZipLimits = DEFAULT_ZIP_LIMITS,
  /** When given, an accepted entry over maxEntryBytes is passed here and skipped instead of failing the whole archive. */
  onOversize?: (entryName: string, bytes: number) => void,
): Promise<ZipReadResult> {
  const archiveBytes = 'buffer' in source ? source.buffer.length : (await stat(source.path)).size;
  // whole-archive budget for the bytes we will actually inflate
  const readBudget = Math.max(8 * limits.ratioMinBytes, archiveBytes * limits.maxAggregateRatio);
  let readDeclared = 0;
  const zip = await openZip(source);
  if (zip.entryCount > limits.maxEntries) {
    zip.close();
    throw new ZipSafetyError(`Zip has too many entries (max ${limits.maxEntries})`, 413);
  }
  const result: ZipReadResult = { entries: 0, read: 0, skipped: 0 };
  let declaredTotal = 0;

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const fail = (e: unknown) => {
      if (settled) return;
      settled = true;
      zip.close();
      reject(e instanceof AppError ? e : new ZipSafetyError(`Invalid zip archive: ${safeMsg(e)}`));
    };
    zip.on('error', fail);
    zip.on('end', () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    });
    zip.on('entry', (entry: Entry) => {
      void (async () => {
        result.entries++;
        const name = entry.fileName;
        if (isUnsafeEntryName(name)) throw new ZipSafetyError('Zip contains an unsafe path (absolute or "..")');
        declaredTotal += entry.uncompressedSize;
        if (declaredTotal > limits.maxTotalBytes) {
          throw new ZipSafetyError('Zip uncompressed size exceeds limit', 413);
        }
        const isDir = name.endsWith('/');
        if (isDir || !accept(name)) {
          if (!isDir) result.skipped++;
          zip.readEntry();
          return;
        }
        if (entry.uncompressedSize > limits.maxEntryBytes) {
          if (!onOversize) throw new ZipSafetyError('Zip entry exceeds size limit', 413);
          onOversize(name, entry.uncompressedSize);
          result.skipped++;
          zip.readEntry();
          return;
        }
        readDeclared += entry.uncompressedSize;
        if (readDeclared > readBudget) {
          throw new ZipSafetyError('Zip expands too much overall (possible zip bomb)', 413);
        }
        if (
          entry.uncompressedSize >= limits.ratioMinBytes &&
          (entry.compressedSize === 0 || entry.uncompressedSize / entry.compressedSize > limits.maxRatio)
        ) {
          throw new ZipSafetyError('Zip entry compression ratio is suspicious (possible zip bomb)', 413);
        }
        const data = await readEntry(zip, entry, Math.min(limits.maxEntryBytes, entry.uncompressedSize));
        result.read++;
        await onEntry(name, data);
        zip.readEntry();
      })().catch(fail);
    });
    zip.readEntry();
  });
  return result;
}

/**
 * Fully stream-validate an archive (sizes, ratios, paths) without keeping the
 * content — used for .xlsx files before handing them to the spreadsheet parser.
 */
export async function assertSafeZip(buffer: Buffer, limits: ZipLimits): Promise<void> {
  await readZip({ buffer }, () => true, () => undefined, limits);
}
