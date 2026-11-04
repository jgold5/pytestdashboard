import { LIMITS } from '@ptd/shared';

/**
 * Client-side allowlist for allure-results uploads. Mirrors the server's
 * allowlist so we never upload screenshots/videos/attachments (often huge).
 */
const ALLOWED = [
  /-result\.json$/i,
  /-container\.json$/i,
  /^environment\.properties$/i,
  /^executor\.json$/i,
  /^categories\.json$/i,
];

export function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? path;
}

export function isAllowedAllureFile(name: string): boolean {
  const base = basename(name);
  return ALLOWED.some((re) => re.test(base));
}

export function isZip(file: File): boolean {
  return /\.zip$/i.test(file.name) || file.type === 'application/zip' || file.type === 'application/x-zip-compressed';
}

export interface AllureSelection {
  kind: 'zip' | 'files' | 'empty';
  files: File[];
  ignored: number;
  totalBytes: number;
  resultCount: number;
  error?: string;
}

/** Classify a dropped/selected set of files into an upload plan. */
export function planAllureUpload(input: File[]): AllureSelection {
  const zips = input.filter(isZip);
  if (zips.length > 0) {
    if (zips.length > 1 || input.length > 1) {
      return {
        kind: 'empty',
        files: [],
        ignored: input.length,
        totalBytes: 0,
        resultCount: 0,
        error: 'Drop a single .zip, or a folder of allure results — not both.',
      };
    }
    const zip = zips[0]!;
    if (zip.size > LIMITS.uploadMaxBytes) {
      return { kind: 'empty', files: [], ignored: 1, totalBytes: zip.size, resultCount: 0, error: 'Zip exceeds the upload size limit.' };
    }
    return { kind: 'zip', files: [zip], ignored: 0, totalBytes: zip.size, resultCount: 0 };
  }
  const files = input.filter((f) => isAllowedAllureFile(f.name));
  const totalBytes = files.reduce((s, f) => s + f.size, 0);
  const resultCount = files.filter((f) => /-result\.json$/i.test(f.name)).length;
  let error: string | undefined;
  if (files.length > LIMITS.uploadMaxFiles) error = `Too many files (${files.length}); max ${LIMITS.uploadMaxFiles}. Zip the folder instead.`;
  else if (totalBytes > LIMITS.uploadMaxBytes) error = 'Selected files exceed the upload size limit. Zip the folder instead.';
  else if (files.length > 0 && resultCount === 0) error = 'No *-result.json files found in the selection.';
  return {
    kind: files.length ? 'files' : 'empty',
    files: error ? [] : files,
    ignored: input.length - files.length,
    totalBytes,
    resultCount,
    error: error ?? (files.length === 0 && input.length > 0 ? 'No allure result files found. Expected *-result.json files.' : undefined),
  };
}

// ---------------------------------------------------------------------------
// Directory traversal for drag & drop (DataTransferItem.webkitGetAsEntry).
// ---------------------------------------------------------------------------

function readAllEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => {
    const all: FileSystemEntry[] = [];
    const next = () =>
      reader.readEntries((batch) => {
        if (batch.length === 0) resolve(all);
        else {
          all.push(...batch);
          next(); // readEntries returns at most ~100 entries per call
        }
      }, reject);
    next();
  });
}

function entryFile(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

async function walk(entry: FileSystemEntry, out: File[], depth: number): Promise<void> {
  if (depth > 12) return;
  if (entry.isFile) {
    // Only materialize allowed files (skip large attachments entirely).
    if (isAllowedAllureFile(entry.name) || /\.zip$/i.test(entry.name)) out.push(await entryFile(entry as FileSystemFileEntry));
    else out.push(new File([], entry.name)); // placeholder so "ignored" count is accurate
    return;
  }
  if (entry.isDirectory) {
    const children = await readAllEntries((entry as FileSystemDirectoryEntry).createReader());
    for (const c of children) await walk(c, out, depth + 1);
  }
}

/** Collect files from a drop event, descending into folders when supported. */
export async function filesFromDataTransfer(dt: DataTransfer): Promise<File[]> {
  const items = Array.from(dt.items ?? []);
  const entries = items
    .filter((i) => i.kind === 'file')
    .map((i) => (typeof i.webkitGetAsEntry === 'function' ? i.webkitGetAsEntry() : null));
  if (entries.length > 0 && entries.every((e): e is FileSystemEntry => e !== null)) {
    const out: File[] = [];
    for (const e of entries) await walk(e, out, 0);
    return out;
  }
  return Array.from(dt.files ?? []);
}
