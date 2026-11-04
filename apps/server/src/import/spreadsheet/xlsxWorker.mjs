// Spreadsheet parsing worker (plain JS so it runs unchanged under tsx, vitest
// and the tsup bundle). Runs with V8 resourceLimits + a timeout set by the
// parent (parse.ts): a hostile file can only kill this worker, not the server.
import { parentPort, workerData } from 'node:worker_threads';
import { parse as parseCsv } from 'csv-parse/sync';
import readXlsxFile from 'read-excel-file/node';

const MAX_CELL_CHARS = 32767;

function cellText(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return '';
    const iso = v.toISOString();
    return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso;
  }
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  return String(v).trim().slice(0, MAX_CELL_CHARS);
}

class LimitError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

async function run({ kind, buffer, delimiter, maxRows, maxColumns, maxCells }) {
  const buf = Buffer.from(buffer);
  if (kind === 'xlsx') {
    const sheets = await readXlsxFile(buf);
    let cells = 0;
    return sheets.map((s) => {
      if (s.data.length > maxRows + 1000) throw new LimitError('too_many_rows', `Sheet "${s.sheet}" has too many rows`);
      const grid = s.data.map((row) => {
        cells += row.length;
        if (cells > maxCells) throw new LimitError('too_many_cells', 'Spreadsheet has too many cells');
        return row.slice(0, maxColumns + 1).map(cellText);
      });
      return { name: s.sheet, grid };
    });
  }
  // CSV/TSV: caps enforced per record while parsing (never materialise more).
  let rows = 0;
  let cells = 0;
  const grid = parseCsv(buf.toString('utf8'), {
    delimiter,
    bom: true,
    relax_column_count: true,
    relax_quotes: true,
    skip_empty_lines: false,
    max_record_size: 1024 * 1024,
    on_record: (record) => {
      rows++;
      if (rows > maxRows + 1000) throw new LimitError('too_many_rows', `Sheet has more than ${maxRows} rows`);
      let last = record.length;
      while (last > 0 && record[last - 1] === '') last--;
      if (last > maxColumns) throw new LimitError('too_many_columns', `Sheet has more than ${maxColumns} columns`);
      cells += last;
      if (cells > maxCells) throw new LimitError('too_many_cells', 'Spreadsheet has too many cells');
      return record.slice(0, last).map((c) => c.slice(0, MAX_CELL_CHARS));
    },
  });
  return [{ name: 'Sheet1', grid }];
}

run(workerData).then(
  (sheets) => parentPort.postMessage({ ok: true, sheets }),
  (err) =>
    parentPort.postMessage({
      ok: false,
      code: err instanceof LimitError ? err.code : 'invalid_spreadsheet',
      message: err instanceof LimitError ? err.message : 'Could not read the spreadsheet file',
    }),
);
