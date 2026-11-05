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

/** allure-history (allureparser) snapshot of one run. */
export const SNAPSHOT_RE = /\.snapshot\.json\.gz$/i;

export interface PlanOptions {
  /** History import: also accept allure-history `*.snapshot.json.gz` files. */
  snapshots?: boolean;
}

export function isAllowedAllureFile(name: string, opts: PlanOptions = {}): boolean {
  const base = basename(name);
  return ALLOWED.some((re) => re.test(base)) || (opts.snapshots === true && SNAPSHOT_RE.test(base));
}

/** Path of a picked/dropped file inside the chosen folder (dropped folders don't set webkitRelativePath). */
const droppedPaths = new WeakMap<File, string>();
export function relativePath(file: File): string {
  return droppedPaths.get(file) || file.webkitRelativePath || file.name;
}

/** Folder of a file inside the selection ('' = top level). */
export function folderOf(file: File): string {
  const p = relativePath(file).replace(/\\/g, '/');
  const cut = p.lastIndexOf('/');
  return cut > 0 ? p.slice(0, cut) : '';
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
  /** History import: allure-history snapshots in the selection. */
  snapshotCount: number;
  /** History import: distinct folders holding result files. */
  folderCount: number;
  error?: string;
}

/** Classify a dropped/selected set of files into an upload plan. */
export function planAllureUpload(input: File[], opts: PlanOptions = {}): AllureSelection {
  const empty = { resultCount: 0, snapshotCount: 0, folderCount: 0 };
  const zips = input.filter(isZip);
  if (zips.length > 0) {
    if (zips.length > 1 || input.length > 1) {
      return {
        kind: 'empty',
        files: [],
        ignored: input.length,
        totalBytes: 0,
        ...empty,
        error: 'Drop a single .zip, or a folder of allure results — not both.',
      };
    }
    const zip = zips[0]!;
    if (zip.size > LIMITS.uploadMaxBytes) {
      return { kind: 'empty', files: [], ignored: 1, totalBytes: zip.size, ...empty, error: 'Zip exceeds the upload size limit.' };
    }
    return { kind: 'zip', files: [zip], ignored: 0, totalBytes: zip.size, ...empty };
  }
  const files = input.filter((f) => isAllowedAllureFile(f.name, opts));
  const totalBytes = files.reduce((s, f) => s + f.size, 0);
  const results = files.filter((f) => /-result\.json$/i.test(f.name));
  const snapshotCount = files.filter((f) => SNAPSHOT_RE.test(f.name)).length;
  const folderCount = new Set(results.map(folderOf)).size;
  const expected = opts.snapshots ? '*-result.json or *.snapshot.json.gz' : '*-result.json';
  let error: string | undefined;
  if (files.length > LIMITS.uploadMaxFiles) error = `Too many files (${files.length}); max ${LIMITS.uploadMaxFiles}. Zip the folder instead.`;
  else if (totalBytes > LIMITS.uploadMaxBytes) error = 'Selected files exceed the upload size limit. Zip the folder instead.';
  else if (files.length > 0 && results.length + snapshotCount === 0) error = `No ${expected} files found in the selection.`;
  return {
    kind: files.length ? 'files' : 'empty',
    files: error ? [] : files,
    ignored: input.length - files.length,
    totalBytes,
    resultCount: results.length,
    snapshotCount,
    folderCount,
    error: error ?? (files.length === 0 && input.length > 0 ? `No allure result files found. Expected ${expected} files.` : undefined),
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

async function walk(entry: FileSystemEntry, out: File[], depth: number, opts: PlanOptions): Promise<void> {
  if (depth > 12) return;
  if (entry.isFile) {
    // Only materialize allowed files (skip large attachments entirely).
    if (isAllowedAllureFile(entry.name, opts) || /\.zip$/i.test(entry.name)) {
      const file = await entryFile(entry as FileSystemFileEntry);
      droppedPaths.set(file, entry.fullPath.replace(/^\/+/, ''));
      out.push(file);
    } else out.push(new File([], entry.name)); // placeholder so "ignored" count is accurate
    return;
  }
  if (entry.isDirectory) {
    const children = await readAllEntries((entry as FileSystemDirectoryEntry).createReader());
    for (const c of children) await walk(c, out, depth + 1, opts);
  }
}

/** Collect files from a drop event, descending into folders when supported. */
export async function filesFromDataTransfer(dt: DataTransfer, opts: PlanOptions = {}): Promise<File[]> {
  const items = Array.from(dt.items ?? []);
  const entries = items
    .filter((i) => i.kind === 'file')
    .map((i) => (typeof i.webkitGetAsEntry === 'function' ? i.webkitGetAsEntry() : null));
  if (entries.length > 0 && entries.every((e): e is FileSystemEntry => e !== null)) {
    const out: File[] = [];
    for (const e of entries) await walk(e, out, 0, opts);
    return out;
  }
  return Array.from(dt.files ?? []);
}
