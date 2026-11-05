/**
 * Run-group auto-derivation: the longest common test directory across all
 * results (≤ 3 segments), e.g. tests.api.users.test_login#test_ok → tests/api/users.
 */
import type { ParsedResult } from './parse.js';

export const DEFAULT_RUN_GROUP = 'default';
const MAX_SEGMENTS = 3;

/** Directory segments of a result's module, or null if undeterminable. */
export function moduleDir(r: Pick<ParsedResult, 'fullName' | 'labels'>): string[] | null {
  let mod: string | null = null;
  if (r.fullName) {
    const cut = r.fullName.search(/#|::/);
    mod = cut >= 0 ? r.fullName.slice(0, cut) : r.fullName;
  }
  if (!mod) mod = r.labels.find((l) => l.name === 'package')?.value ?? null;
  if (!mod) return null;

  let segs: string[];
  if (mod.includes('/')) {
    // pytest node-id style: tests/api/test_users.py → drop the file
    segs = mod.split('/').filter(Boolean);
    segs.pop();
  } else {
    segs = mod.split('.').filter(Boolean);
    // drop trailing class names (Capitalized) and then the module file itself
    while (segs.length > 0 && /^[A-Z]/.test(segs[segs.length - 1] ?? '')) segs.pop();
    segs.pop();
  }
  return segs;
}

export function deriveRunGroup(results: ReadonlyArray<Pick<ParsedResult, 'fullName' | 'labels'>>): string {
  let prefix: string[] | null = null;
  for (const r of results) {
    const dir = moduleDir(r);
    if (dir === null) continue;
    if (prefix === null) {
      prefix = dir;
      continue;
    }
    let i = 0;
    while (i < prefix.length && i < dir.length && prefix[i] === dir[i]) i++;
    prefix = prefix.slice(0, i);
    if (prefix.length === 0) break;
  }
  if (!prefix || prefix.length === 0) return DEFAULT_RUN_GROUP;
  return prefix.slice(0, MAX_SEGMENTS).join('/');
}
