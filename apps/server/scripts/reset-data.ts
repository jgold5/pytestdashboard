/**
 * Empty the dashboard without touching credentials or stopping the server:
 *   pnpm reset-data          (asks first)
 *   pnpm reset-data --yes    (no question, for scripts)
 *   pnpm reset-data --all    (also forget the team name and goal from Settings)
 *
 * Deletes every row from DATA_DIR/dashboard.db: test cases, runs and results, notes,
 * bugs, PRs, trigger scans, coverage history and integration sync state. Tokens, Jira and
 * GitHub settings live in .env, and logins are signed cookies, so neither is affected.
 * Safe while the server runs: SQLite locks the database for the few milliseconds it takes,
 * and row ids are never reused, so nothing the server cached can point at new data.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { loadConfig } from '../src/config.js';
import { openDatabase } from '../src/db/client.js';

const args = process.argv.slice(2);
const yes = args.includes('--yes') || args.includes('-y');
const all = args.includes('--all');

// Same .env lookup as the server (cwd, then repo root) so DATA_DIR matches.
for (const candidate of [path.resolve('.env'), path.resolve('../../.env')]) {
  if (fs.existsSync(candidate)) {
    process.loadEnvFile(candidate);
    break;
  }
}
const config = loadConfig({ ...process.env, NODE_ENV: process.env.NODE_ENV === 'production' ? 'production' : 'development' });
const dbFile = path.join(config.dataDir, 'dashboard.db');
if (!fs.existsSync(dbFile)) {
  console.log(`[reset-data] Nothing to clear: ${dbFile} doesn't exist yet.`);
  process.exit(0);
}

const { sqlite, close } = openDatabase(config.dataDir);
const keep = new Set(all ? [] : ['settings']);
const tables = (sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[])
  .map((t) => t.name)
  .filter((t) => !keep.has(t));
const counts = tables.map((t) => ({ table: t, rows: (sqlite.prepare(`SELECT count(*) AS n FROM "${t}"`).get() as { n: number }).n }));
const total = counts.reduce((s, c) => s + c.rows, 0);

if (total === 0) {
  console.log(`[reset-data] ${dbFile} is already empty.`);
  close();
  process.exit(0);
}

console.log(`[reset-data] ${dbFile}`);
for (const c of counts.filter((c) => c.rows > 0)) console.log(`  ${c.table.padEnd(24)} ${c.rows}`);
if (!all) console.log('  (Settings such as the team name and goal are kept; add --all to clear them too.)');

if (!yes) {
  if (!process.stdin.isTTY) {
    console.error('[reset-data] Not a terminal: rerun with --yes to confirm.');
    process.exit(1);
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`Delete these ${total} rows? Type "yes" to continue: `)).trim().toLowerCase();
  rl.close();
  if (answer !== 'yes') {
    console.log('[reset-data] Cancelled, nothing was deleted.');
    close();
    process.exit(1);
  }
}

// Foreign keys off so the order of the deletes doesn't matter; sqlite_sequence is left
// alone so new rows never reuse an old id.
sqlite.pragma('foreign_keys = OFF');
sqlite.transaction(() => {
  for (const t of tables) sqlite.prepare(`DELETE FROM "${t}"`).run();
})();
sqlite.pragma('foreign_keys = ON');
const broken = sqlite.pragma('foreign_key_check') as unknown[];
sqlite.pragma('wal_checkpoint(TRUNCATE)');
close();

if (broken.length > 0) {
  console.error(`[reset-data] Deleted, but ${broken.length} rows still point at deleted data (kept settings?).`);
  process.exit(1);
}
console.log(`[reset-data] Deleted ${total} rows. Reload the dashboard; you stay signed in.`);
