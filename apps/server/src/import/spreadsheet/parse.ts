/**
 * Spreadsheet parsing (.xlsx / .csv / .tsv) into text grids.
 *
 * XLSX library choice: `read-excel-file` (9.x, actively maintained, small
 * dependency tree: fflate + saxen; `pnpm audit --prod` clean). `exceljs` 4.4.0
 * was evaluated but is unmaintained since 2024 and pulls in archiver/uuid/
 * minimatch with open (moderate) advisories; SheetJS on npm (`xlsx` 0.18.5) is
 * stale with known high-severity advisories. read-excel-file reads cached
 * formula results only (never evaluates formulas) and parses in memory. Since it
 * inflates the whole archive, we first validate the zip with our own streaming
 * guard (sizes / ratios / entry count) in ../zip.ts.
 */
import path from 'node:path';
import { parse as parseCsv } from 'csv-parse/sync';
import readXlsxFile from 'read-excel-file/node';
import { AppError } from '../../errors.js';
import { assertSafeZip, isZipMagic, type ZipLimits } from '../zip.js';

export const SHEET_LIMITS = {
  maxFileBytes: 50 * 1024 * 1024,
  maxRows: 50_000,
  maxColumns: 200,
  maxCellChars: 32_767,
};

const XLSX_ZIP_LIMITS: ZipLimits = {
  maxEntries: 10_000,
  maxEntryBytes: 300 * 1024 * 1024,
  maxTotalBytes: 600 * 1024 * 1024,
  maxRatio: 400,
  ratioMinBytes: 1024 * 1024,
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
    throw new AppError(413, 'payload_too_large', 'Spreadsheet file is too large');
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
  return [parseDelimited(buffer.toString('utf8'), ext === '.tsv' ? '\t' : undefined)];
}

async function parseXlsx(buffer: Buffer): Promise<ParsedSheet[]> {
  await assertSafeZip(buffer, XLSX_ZIP_LIMITS);
  let sheets: Awaited<ReturnType<typeof readXlsxFile>>;
  try {
    sheets = await readXlsxFile(buffer);
  } catch {
    throw new AppError(400, 'invalid_spreadsheet', 'Could not read the .xlsx file');
  }
  return sheets.map((s) => toSheet(s.sheet, s.data.map((row) => row.map(cellText))));
}

function sniffDelimiter(text: string): string {
  const firstLine = text.slice(0, 10_000).split(/\r?\n/, 1)[0] ?? '';
  const counts: Array<[string, number]> = [',', ';', '\t', '|'].map((d) => [d, firstLine.split(d).length - 1]);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0] && counts[0][1] > 0 ? counts[0][0] : ',';
}

function parseDelimited(text: string, delimiter?: string): ParsedSheet {
  let records: string[][];
  try {
    records = parseCsv(text, {
      delimiter: delimiter ?? sniffDelimiter(text),
      bom: true,
      relax_column_count: true,
      relax_quotes: true,
      skip_empty_lines: false,
      max_record_size: 1024 * 1024,
      to_line: SHEET_LIMITS.maxRows + 1000,
    }) as string[][];
  } catch {
    throw new AppError(400, 'invalid_spreadsheet', 'Could not parse the CSV file');
  }
  return toSheet('Sheet1', records);
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
