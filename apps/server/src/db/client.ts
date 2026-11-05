import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core';
import * as schema from './schema.js';
import { MIGRATIONS } from './migrations.js';

/** A database or an open transaction — domain functions accept either. */
export type Db = BaseSQLiteDatabase<'sync', Database.RunResult, typeof schema>;

export interface DbHandle {
  db: Db;
  sqlite: Database.Database;
  close(): void;
}

/** Open (creating if needed) DATA_DIR/dashboard.db, configure pragmas and migrate. */
export function openDatabase(dataDir: string, fileName = 'dashboard.db'): DbHandle {
  fs.mkdirSync(dataDir, { recursive: true });
  const sqlite = new Database(path.join(dataDir, fileName));
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('synchronous = NORMAL');
  sqlite.pragma('busy_timeout = 5000');
  migrate(sqlite);
  const db = drizzle(sqlite, { schema });
  return { db, sqlite, close: () => sqlite.close() };
}

export function migrate(sqlite: Database.Database): void {
  const current = sqlite.pragma('user_version', { simple: true }) as number;
  for (let v = current; v < MIGRATIONS.length; v++) {
    const ddl = MIGRATIONS[v];
    if (ddl === undefined) break;
    sqlite.transaction(() => {
      sqlite.exec(ddl);
      sqlite.pragma(`user_version = ${v + 1}`);
    })();
  }
}
