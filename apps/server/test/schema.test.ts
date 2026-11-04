import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { getTableConfig, type SQLiteTable } from 'drizzle-orm/sqlite-core';
import { openDatabase } from '../src/db/client.js';
import * as schema from '../src/db/schema.js';

describe('migrations', () => {
  it('create every table/column/index declared in the Drizzle schema; idempotent; WAL + FKs', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptd-schema-'));
    try {
      const h = openDatabase(dir);
      expect(h.sqlite.pragma('journal_mode', { simple: true })).toBe('wal');
      expect(h.sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
      const tables = (Object.values(schema) as unknown[]).filter(
        (v): v is SQLiteTable => typeof v === 'object' && v !== null && Symbol.for('drizzle:IsDrizzleTable') in v,
      );
      expect(tables.length).toBeGreaterThanOrEqual(12);
      for (const table of tables) {
        const cfg = getTableConfig(table);
        const cols = (h.sqlite.prepare(`PRAGMA table_info("${cfg.name}")`).all() as Array<{ name: string }>).map((c) => c.name);
        for (const c of cfg.columns) expect(cols, `${cfg.name}.${c.name}`).toContain(c.name);
        const idx = (h.sqlite.prepare(`PRAGMA index_list("${cfg.name}")`).all() as Array<{ name: string }>).map((i) => i.name);
        for (const i of cfg.indexes) expect(idx, `${cfg.name} index`).toContain(i.config.name);
      }
      h.close();
      openDatabase(dir).close(); // re-open: no re-run of migrations
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
