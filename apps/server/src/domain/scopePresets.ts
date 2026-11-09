import { eq } from 'drizzle-orm';
import { routeKey, ScopePresets as ScopePresetsSchema, type ScopePreset, type ScopePresets, type TriggerOverviewResponse } from '@ptd/shared';
import type { Db } from '../db/client.js';
import { settings } from '../db/schema.js';
import { badRequest } from '../errors.js';
import { inScope, routeCoverage } from '../triggers/routeCoverage.js';
import { nowIso } from '../util/time.js';

/** Saved filters live next to the app settings, under their own key. */
const KEY = 'scope-presets';

export function getScopePresets(db: Db): ScopePresets {
  const row = db.select().from(settings).where(eq(settings.key, KEY)).get();
  const parsed = row ? ScopePresetsSchema.safeParse(row.value) : null;
  return parsed?.success ? parsed.data : { presets: [] };
}

function store(db: Db, value: ScopePresets): ScopePresets {
  const row = { key: KEY, value, updatedAt: nowIso() };
  db.insert(settings).values(row).onConflictDoUpdate({ target: settings.key, set: row }).run();
  return value;
}

/**
 * The routes a saved filter holds now on `branch` (default: the default routes branch), as
 * routeKeys; null before any route scan.
 */
function snapshot(db: Db, p: Pick<ScopePreset, 'folder' | 'kinds' | 'exclude'>, branch?: string): NonNullable<ScopePreset['baseline']> | null {
  const cov = routeCoverage(db, branch);
  if (!cov?.branch) return null;
  const routes = new Set<string>();
  for (const r of cov.rows) if (r.routeId && inScope(r, { folder: p.folder, kinds: p.kinds, exclude: p.exclude })) routes.add(routeKey(r.module, r.routeId));
  return { at: nowIso(), branch: cov.branch, routes: [...routes].sort() };
}

/**
 * Replace the saved filters. A new one (or one whose folders, kinds or exclusion changed) gets
 * its baseline now, on `branch`: the routes in it at this moment, so routes added later show as new.
 */
export function putScopePresets(db: Db, value: ScopePresets, branch?: string): ScopePresets {
  const ids = new Set<string>();
  for (const p of value.presets) {
    if (ids.has(p.id)) throw badRequest(`Two saved filters have the id ${p.id}`);
    ids.add(p.id);
  }
  const before = new Map(getScopePresets(db).presets.map((p) => [p.id, p]));
  const same = (a: ScopePreset, b: ScopePreset) => a.folder === b.folder && a.exclude === b.exclude && (a.kinds ?? []).join(',') === (b.kinds ?? []).join(',');
  const presets = value.presets.map((p) => {
    const old = before.get(p.id);
    // the baseline is the server's: kept while the filter is the same, taken anew when it changes
    const baseline = old && same(old, p) ? old.baseline : snapshot(db, p, branch);
    return { ...p, baseline };
  });
  return store(db, { presets });
}

/** "Mark as seen": the saved filter's routes now become its baseline. */
export function resetScopePresetBaseline(db: Db, id: string, branch?: string): ScopePresets {
  const cur = getScopePresets(db);
  const p = cur.presets.find((x) => x.id === id);
  if (!p) throw badRequest(`No saved filter ${id}`);
  return store(db, { presets: cur.presets.map((x) => (x.id === id ? { ...x, baseline: snapshot(db, x, branch) } : x)) });
}

/**
 * The routes a saved filter holds now on the branch counted that weren't in its baseline (added),
 * and those of the baseline that it no longer holds (gone). Null when it has no baseline on that branch.
 */
export function freshRoutes(db: Db, q: { preset?: string; branch?: string; tests?: string }): NonNullable<TriggerOverviewResponse['fresh']> | null {
  const p = q.preset ? getScopePresets(db).presets.find((x) => x.id === q.preset) : undefined;
  if (!p?.baseline) return null;
  const now = snapshot(db, p, q.branch);
  if (!now || now.branch !== p.baseline.branch) return null;
  const before = new Set(p.baseline.routes);
  const after = new Set(now.routes);
  return {
    preset: p.id,
    at: p.baseline.at,
    branch: p.baseline.branch,
    added: now.routes.filter((r) => !before.has(r)),
    gone: p.baseline.routes.filter((r) => !after.has(r)),
  };
}
