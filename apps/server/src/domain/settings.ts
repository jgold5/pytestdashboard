import { eq } from 'drizzle-orm';
import { Settings as SettingsSchema, type Settings } from '@ptd/shared';
import type { Db } from '../db/client.js';
import { settings } from '../db/schema.js';
import { nowIso } from '../util/time.js';

const KEY = 'app';
const DEFAULTS: Settings = { teamName: null, goal: null };

export function getSettings(db: Db): Settings {
  const row = db.select().from(settings).where(eq(settings.key, KEY)).get();
  if (!row) return DEFAULTS;
  const parsed = SettingsSchema.safeParse(row.value);
  return parsed.success ? parsed.data : DEFAULTS;
}

export function putSettings(db: Db, value: Settings): Settings {
  const row = { key: KEY, value, updatedAt: nowIso() };
  db.insert(settings).values(row).onConflictDoUpdate({ target: settings.key, set: row }).run();
  return value;
}
