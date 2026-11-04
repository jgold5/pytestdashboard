/**
 * Spreadsheet parsing (.xlsx / .csv / .tsv) into text grids.
 *
 * XLSX library choice: `read-excel-file` (9.x, actively maintained, small
 * dependency tree: fflate + saxen; `pnpm audit --prod` clean). `exceljs` 4.4.0
 * was evaluated but is unmaintained since 2024 and pulls in archiver/uuid/
 * minimatch with open (moderate) advisories; SheetJS on npm (`xlsx` 0.18.5) is
 * stale with known high-severity advisories. read-excel-file reads cached
 * formula results only (never evaluates formulas) and parses in memory.
 *
 * Hardening (SECURITY_REVIEW F-02/F-05): the zip is stream-validated first
 * (../zip.ts), worksheet XML is pre-scanned so oversized row/column indexes and
 * cell counts are rejected before the library pads gap arrays, and the actual
 * parse (xlsx and CSV) runs in a worker thread with a heap cap and a timeout.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { AppError } from '../../errors.js';
import { isZipMagic, readZip, type ZipLimits } from '../zip.js';

export const SHEET_LIMITS = {
  maxFileBytes: 20 * 1024 * 1024,
  maxRows: 50_000,
  maxColumns: 200,
  /** Total cells across all sheets of one file. */
  maxCells: 2_000_000,
  maxCellChars: 32_767,
  /** Parser worker budget. */
  workerHeapMb: 256,
  workerTimeoutMs: 30_000,
  /** Process-wide: parser workers running at once, and requests allowed to wait. */
  maxConcurrentWorkers: 2,
  maxQueuedWorkers: 4,
};

const XLSX_ZIP_LIMITS: ZipLimits = {
  maxEntries: 10_000,
  maxEntryBytes: 128 * 1024 * 1024,
  maxTotalBytes: 256 * 1024 * 1024,
  maxRatio: 400,
  ratioMinBytes: 1024 * 1024,
  maxAggregateRatio: 400,
};

export interface SheetRow {
  /** 1-based row number in the original sheet (header row included). */
  n: number;
  cells: string[];
}

export interface ParsedSheet {
  name: string;
  headers: string[];
  rows: SheetRow[];
}

const OLE_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0]);

export async function parseSpreadsheet(buffer: Buffer, fileName: string): Promise<ParsedSheet[]> {
  if (buffer.length > SHEET_LIMITS.maxFileBytes) {
    throw new AppError(413, 'payload_too_large', 'Spreadsheet file is too large (max 20 MB)');
  }
  const ext = path.extname(fileName).toLowerCase();
  if (isZipMagic(buffer)) return parseXlsx(buffer);
  if (buffer.subarray(0, 4).equals(OLE_MAGIC)) {
    throw new AppError(415, 'unsupported_media_type', 'Legacy .xls files are not supported — save as .xlsx or .csv');
  }
  if (ext === '.xlsx') throw new AppError(415, 'unsupported_media_type', 'File is not a valid .xlsx (bad signature)');
  if (buffer.subarray(0, 8192).includes(0)) {
    throw new AppError(415, 'unsupported_media_type', 'Unsupported file type — upload .xlsx, .csv or .tsv');
  }
  const delimiter = ext === '.tsv' ? '\t' : sniffDelimiter(buffer.subarray(0, 10_000).toString('utf8'));
  const sheets = await runParserWorker({ kind: 'csv', buffer, delimiter });
  return sheets.map((s) => toSheet(s.name, s.grid));
}

async function parseXlsx(buffer: Buffer): Promise<ParsedSheet[]> {
  // Single streaming pass: zip shape checks for every entry + a structural scan of
  // every XML part (wherever it lives — the parser follows workbook.xml.rels, so a
  // sheet may be relocated). Huge row/column indexes (which make the parser allocate
  // gigantic gap arrays) are rejected before parsing.
  let cells = 0;
  const seen = new Set<string>();
  const scanned = new Set<string>();
  let rels: Buffer | null = null;
  await readZip(
    { buffer },
    () => true,
    (name, data) => {
      if (seen.has(name)) throw new AppError(400, 'invalid_spreadsheet', 'Workbook contains duplicate entries');
      seen.add(name);
      if (name === WORKBOOK_RELS) rels = data;
      if (/\.xml$/i.test(name)) {
        cells += scanSheetXml(data, cells, /^xl\/worksheets\//i.test(name));
        scanned.add(name);
      }
    },
    XLSX_ZIP_LIMITS,
  );
  // Every worksheet the parser would open must be one we scanned.
  for (const target of worksheetPaths(rels)) {
    if (!scanned.has(target)) {
      throw new AppError(400, 'invalid_spreadsheet', 'Workbook references a worksheet that could not be validated');
    }
  }
  const sheets = await runParserWorker({ kind: 'xlsx', buffer });
  return sheets.map((s) => toSheet(s.name, s.grid));
}

const WORKBOOK_RELS = 'xl/_rels/workbook.xml.rels';
const MAX_TAG = 64 * 1024;
/** `r` attribute, any quoting, optional whitespace around `=` (tags are ≤ 64 KB). */
const R_ATTR = /(?:^|\s)r\s*=\s*(?:"([^"]*)"|'([^']*)')/;
const R_PRESENT = /(?:^|\s)r\s*=/;
const ATTR = (name: string) => new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`);
const TARGET_ATTR = ATTR('Target');
const TYPE_ATTR = ATTR('Type');

/** XML entity decoding as the parser (saxen) does it. */
function decodeEntities(v: string): string {
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  return v.replace(/&#(\d{1,7});|&#x([0-9a-f]{1,6});|&(\w{1,8});/gi, (m, d?: string, h?: string, n?: string) => {
    if (d) return String.fromCodePoint(Math.min(Number(d), 0x10ffff));
    if (h) return String.fromCodePoint(Math.min(parseInt(h, 16), 0x10ffff));
    const k = (n ?? '').toLowerCase();
    return Object.hasOwn(named, k) ? (named[k] as string) : m;
  });
}

/** Mirrors read-excel-file's parseCellAddress: letters = charCode − 64 each, row = Number(rest). */
function parseCellAddress(ref: string): [row: number, col: number] {
  let col = 0;
  for (let i = 0; i < ref.length; i++) {
    const code = ref.charCodeAt(i);
    if (code >= 48 && code <= 57) return [Number(ref.slice(i)), col];
    col = col * 26 + (code - 64);
    if (col > 1e9) break;
  }
  return [Number.NaN, col];
}

/**
 * Linear scan of an XML part (indexOf over the bytes; regexes only on single
 * bounded tags). Row and cell references are interpreted exactly like the parser
 * does (entities decoded, `Number()` semantics), and anything beyond the caps is
 * rejected. `strict` (worksheets dir) also rejects over-long tags. Returns cells seen.
 */
export function scanSheetXml(xml: Buffer, cellsSoFar = 0, strict = true): number {
  const tooBig = (what: string) => new AppError(413, `too_many_${what}`, `Spreadsheet has too many ${what}`);
  const malformed = () => new AppError(400, 'invalid_spreadsheet', 'Malformed worksheet XML');
  const rowCap = SHEET_LIMITS.maxRows + 1000;
  const colCap = SHEET_LIMITS.maxColumns + 50;
  let pos = 0;
  let row = 0;
  let col = 0;
  let cells = 0;
  const rValue = (tag: string): string | null => {
    const m = R_ATTR.exec(tag);
    if (!m) {
      if (R_PRESENT.test(tag)) throw malformed();
      return null;
    }
    return decodeEntities(m[1] ?? m[2] ?? '');
  };
  for (;;) {
    const lt = xml.indexOf(0x3c, pos); // '<'
    if (lt < 0) break;
    const gt = xml.indexOf(0x3e, lt + 1); // '>'
    if (gt < 0) break;
    pos = gt + 1;
    if (gt - lt > MAX_TAG) {
      if (strict) throw malformed();
      continue;
    }
    const first = xml[lt + 1];
    if (first === 0x2f || first === 0x3f || first === 0x21) continue; // </, <?, <!
    const tag = xml.toString('latin1', lt + 1, gt);
    const nameEnd = tag.search(/[\s/]|$/);
    const tagName = tag.slice(0, nameEnd);
    const local = tagName.slice(tagName.indexOf(':') + 1);
    if (local === 'row') {
      const r = rValue(tag);
      row = r !== null ? Number(r) : row + 1;
      col = 0;
      if (!(row <= rowCap)) throw tooBig('rows'); // also catches NaN/Infinity
    } else if (local === 'c') {
      const r = rValue(tag);
      if (r !== null) {
        const [cellRow, cellCol] = parseCellAddress(r);
        if (!(cellRow <= rowCap)) throw tooBig('rows');
        col = cellCol;
      } else {
        col += 1;
      }
      if (!(col <= colCap)) throw tooBig('columns');
      cells++;
      if (cellsSoFar + cells > SHEET_LIMITS.maxCells) throw tooBig('cells');
    }
  }
  return cells;
}

/** Worksheet part paths exactly as read-excel-file resolves them from workbook.xml.rels. */
export function worksheetPaths(rels: Buffer | null): string[] {
  if (!rels) return [];
  const out: string[] = [];
  let pos = 0;
  for (;;) {
    const lt = rels.indexOf(0x3c, pos);
    if (lt < 0) break;
    const gt = rels.indexOf(0x3e, lt + 1);
    if (gt < 0) break;
    pos = gt + 1;
    if (gt - lt > MAX_TAG) throw new AppError(400, 'invalid_spreadsheet', 'Malformed workbook relationships');
    const tag = rels.toString('utf8', lt + 1, gt);
    const local = tag.slice(0, tag.search(/[\s/]|$/)).replace(/^.*:/, '');
    if (local !== 'Relationship') continue;
    const type = TYPE_ATTR.exec(tag);
    const target = TARGET_ATTR.exec(tag);
    const typeValue = decodeEntities(type?.[1] ?? type?.[2] ?? '');
    if (!typeValue.endsWith('/worksheet')) continue;
    const t = decodeEntities(target?.[1] ?? target?.[2] ?? '');
    out.push(t.startsWith('/') ? t.slice(1) : `xl/${t}`);
  }
  return out;
}

interface WorkerSheet {
  name: string;
  grid: string[][];
}
type WorkerReply = { ok: true; sheets: WorkerSheet[] } | { ok: false; code: string; message: string };

function workerPath(): string {
  for (const f of ['./xlsxWorker.mjs', './xlsxWorker.js']) {
    const p = fileURLToPath(new URL(f, import.meta.url));
    if (fs.existsSync(p)) return p;
  }
  throw new Error('spreadsheet worker script not found');
}

// Process-wide semaphore so N parallel uploads cannot start N heap-capped workers.
let activeWorkers = 0;
let peakWorkers = 0;
const waiting: Array<() => void> = [];

async function acquireWorkerSlot(): Promise<void> {
  if (activeWorkers < SHEET_LIMITS.maxConcurrentWorkers) {
    activeWorkers++;
  } else {
    if (waiting.length >= SHEET_LIMITS.maxQueuedWorkers) {
      throw new AppError(503, 'parser_busy', 'Spreadsheet parser is busy — please retry in a moment');
    }
    await new Promise<void>((resolve) => waiting.push(resolve)); // slot handed over by release
  }
  peakWorkers = Math.max(peakWorkers, activeWorkers);
}

function releaseWorkerSlot(): void {
  const next = waiting.shift();
  if (next) next();
  else activeWorkers--;
}

/** For tests/diagnostics. */
export function parserWorkerStats(reset = false): { active: number; peak: number; queued: number } {
  const stats = { active: activeWorkers, peak: peakWorkers, queued: waiting.length };
  if (reset) peakWorkers = activeWorkers;
  return stats;
}

/** Parse in a worker with a heap cap and a timeout; a hostile file kills only the worker. */
async function runParserWorker(input: { kind: 'xlsx' | 'csv'; buffer: Buffer; delimiter?: string }): Promise<WorkerSheet[]> {
  await acquireWorkerSlot();
  try {
    return await spawnParserWorker(input);
  } finally {
    releaseWorkerSlot();
  }
}

function spawnParserWorker(input: { kind: 'xlsx' | 'csv'; buffer: Buffer; delimiter?: string }): Promise<WorkerSheet[]> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerPath(), {
      workerData: {
        ...input,
        maxRows: SHEET_LIMITS.maxRows,
        maxColumns: SHEET_LIMITS.maxColumns,
        maxCells: SHEET_LIMITS.maxCells,
      },
      resourceLimits: { maxOldGenerationSizeMb: SHEET_LIMITS.workerHeapMb, maxYoungGenerationSizeMb: 64 },
      // tsx/vitest loaders are not needed for the plain-JS worker
      execArgv: [],
      stdout: true,
      stderr: true,
    });
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // settle only once the worker is really gone, so the semaphore slot covers its memory
      worker.terminate().then(fn, fn);
    };
    const timer = setTimeout(
      () => finish(() => reject(new AppError(422, 'spreadsheet_too_complex', 'Spreadsheet took too long to parse'))),
      SHEET_LIMITS.workerTimeoutMs,
    );
    worker.once('message', (msg: WorkerReply) =>
      finish(() => {
        if (msg.ok) resolve(msg.sheets);
        else {
          const status = msg.code.startsWith('too_many') ? 413 : 400;
          reject(new AppError(status, msg.code, msg.message));
        }
      }),
    );
    worker.once('error', (err: NodeJS.ErrnoException) =>
      finish(() =>
        reject(
          err.code === 'ERR_WORKER_OUT_OF_MEMORY'
            ? new AppError(413, 'spreadsheet_too_large', 'Spreadsheet needs too much memory to parse')
            : new AppError(400, 'invalid_spreadsheet', 'Could not read the spreadsheet file'),
        ),
      ),
    );
    worker.once('exit', () =>
      finish(() => reject(new AppError(400, 'invalid_spreadsheet', 'Could not read the spreadsheet file'))),
    );
  });
}

function sniffDelimiter(text: string): string {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const counts: Array<[string, number]> = [',', ';', '\t', '|'].map((d) => [d, firstLine.split(d).length - 1]);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0] && counts[0][1] > 0 ? counts[0][0] : ',';
}

export function cellText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return '';
    const iso = v.toISOString();
    return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso;
  }
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  return String(v).trim().slice(0, SHEET_LIMITS.maxCellChars);
}

/** Normalize a raw grid: first non-empty row = header, drop empty rows, enforce caps. */
export function toSheet(name: string, grid: string[][]): ParsedSheet {
  const cleaned = grid.map((r) => r.map((c) => (typeof c === 'string' ? c.trim().slice(0, SHEET_LIMITS.maxCellChars) : cellText(c))));
  const headerIdx = cleaned.findIndex((r) => r.some((c) => c !== ''));
  if (headerIdx < 0) return { name, headers: [], rows: [] };
  const rawHeaders = cleaned[headerIdx] ?? [];

  const rows: SheetRow[] = [];
  let width = rawHeaders.length;
  for (let i = headerIdx + 1; i < cleaned.length; i++) {
    const cells = cleaned[i] ?? [];
    if (!cells.some((c) => c !== '')) continue;
    rows.push({ n: i + 1, cells });
    let last = cells.length;
    while (last > 0 && cells[last - 1] === '') last--;
    width = Math.max(width, last);
  }
  while (width > 0 && (rawHeaders[width - 1] ?? '') === '' && rows.every((r) => (r.cells[width - 1] ?? '') === '')) width--;

  if (width > SHEET_LIMITS.maxColumns) {
    throw new AppError(413, 'too_many_columns', `Sheet "${name}" has more than ${SHEET_LIMITS.maxColumns} columns`);
  }
  if (rows.length > SHEET_LIMITS.maxRows) {
    throw new AppError(413, 'too_many_rows', `Sheet "${name}" has more than ${SHEET_LIMITS.maxRows} rows`);
  }

  const seen = new Map<string, number>();
  const headers: string[] = [];
  for (let i = 0; i < width; i++) {
    let h = (rawHeaders[i] ?? '').slice(0, 200) || `Column ${i + 1}`;
    const count = seen.get(h) ?? 0;
    seen.set(h, count + 1);
    if (count > 0) h = `${h} (${count + 1})`;
    headers.push(h);
  }
  for (const r of rows) {
    r.cells = Array.from({ length: width }, (_, i) => r.cells[i] ?? '');
  }
  return { name: name.slice(0, 200), headers, rows };
}
