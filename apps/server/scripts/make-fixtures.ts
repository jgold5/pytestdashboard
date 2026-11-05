/**
 * Build demo/test artifacts from the checked-in fixtures:
 *   test/fixtures/allure-results.zip  (zip of test/fixtures/allure-results)
 *   test/fixtures/tracker.xlsx        (tracker.csv as an Excel workbook, 2 sheets)
 * Usage: pnpm --filter @ptd/server fixtures
 */
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'csv-parse/sync';
import writeXlsxFile from 'write-excel-file/node';
import { makeZip } from '../test/helpers/zip.js';

const dir = path.resolve(import.meta.dirname, '../test/fixtures');

const resultsDir = path.join(dir, 'allure-results');
const entries = fs
  .readdirSync(resultsDir)
  .sort()
  .map((name) => ({ name: `allure-results/${name}`, data: fs.readFileSync(path.join(resultsDir, name)) }));
fs.writeFileSync(path.join(dir, 'allure-results.zip'), makeZip(entries));

const rows = parse(fs.readFileSync(path.join(dir, 'tracker.csv'), 'utf8')) as string[][];
const toCells = (r: string[]) => r.map((value) => ({ value }));
const buffer = await writeXlsxFile([
  { data: rows.map(toCells), sheet: 'Test cases' },
  { data: [[{ value: 'Notes' }], [{ value: 'This sheet is ignored' }]], sheet: 'Readme' },
]).toBuffer();
fs.writeFileSync(path.join(dir, 'tracker.xlsx'), buffer);
console.log(`wrote ${entries.length} entries to allure-results.zip and ${rows.length - 1} rows to tracker.xlsx`);
