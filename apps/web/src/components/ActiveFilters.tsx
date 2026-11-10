import { Bookmark, X } from 'lucide-react';
import { splitExclude, splitFolders, TRIGGER_KIND_LABEL, type TriggerKind } from '@ptd/shared';
import { useScopePresets } from '../api/hooks';
import { cn } from '../lib/utils';
import { activePreset, type Scope } from './ScopeButton';

/** A filter the page adds on top of the scope (a status tab, a search), shown as a chip too. */
export interface ExtraFilter {
  key: string;
  label: string;
  value: string;
  onRemove: () => void;
}

/**
 * The filters in force, one chip each (folders, types, what is left out, a saved filter, and the
 * page's own), each with × to drop it, and Clear all. Nothing shows when nothing filters.
 */
export function ActiveFilters({
  scope,
  onChange,
  extra = [],
  onClearAll,
  className,
}: {
  scope: Pick<Scope, 'folder' | 'kinds' | 'exclude'>;
  onChange: (patch: Partial<Scope>) => void;
  extra?: ExtraFilter[];
  /** Clear everything in one go (a page whose filters live in the URL clears them in one update). */
  onClearAll?: () => void;
  className?: string;
}) {
  const presets = useScopePresets().data?.presets;
  const saved = activePreset(presets, scope);
  const folders = splitFolders(scope.folder);
  const kinds = (scope.kinds ?? '').split(',').filter(Boolean) as TriggerKind[];
  const excludes = splitExclude(scope.exclude);
  const without = (list: string[], x: string) => list.filter((y) => y !== x).join(',') || null;

  const chips: Array<{ key: string; label: string; value: string; onRemove: () => void; saved?: boolean }> = [];
  if (saved) chips.push({ key: 'saved', label: 'Saved filter', value: saved.name, saved: true, onRemove: () => onChange({ folder: null, kinds: null, exclude: null }) });
  for (const f of folders) chips.push({ key: `folder:${f}`, label: 'Folder', value: `${f}/`, onRemove: () => onChange({ folder: without(folders, f) }) });
  for (const k of kinds) chips.push({ key: `kind:${k}`, label: 'Type', value: TRIGGER_KIND_LABEL[k] ?? k, onRemove: () => onChange({ kinds: without(kinds, k) }) });
  for (const p of excludes) chips.push({ key: `exclude:${p}`, label: 'Leave out', value: p.includes('*') ? p : `${p}…`, onRemove: () => onChange({ exclude: without(excludes, p) }) });
  for (const e of extra) chips.push(e);
  if (chips.length === 0) return null;

  const clearAll = () => {
    if (onClearAll) return onClearAll();
    if (folders.length || kinds.length || excludes.length) onChange({ folder: null, kinds: null, exclude: null });
    for (const e of extra) e.onRemove();
  };
  return (
    <div className={cn('flex flex-wrap items-center gap-1.5', className)} role="group" aria-label="Filters in force">
      <span className="mr-0.5 text-[11px] font-semibold tracking-[0.07em] text-fg-3 uppercase">Filters</span>
      {chips.map((c) => (
        <span
          key={c.key}
          className={cn(
            'inline-flex h-6 max-w-[320px] items-center gap-1 rounded-full border pr-0.5 pl-2 text-xs',
            c.saved ? 'border-accent/50 bg-accent-soft text-fg' : 'border-border bg-surface text-fg-2',
          )}
        >
          {c.saved ? <Bookmark className="size-3 shrink-0 text-accent" aria-hidden /> : null}
          <span className="shrink-0 text-fg-3">{c.label}</span>
          <span className="truncate font-mono text-[11.5px] text-fg">{c.value}</span>
          <button
            type="button"
            aria-label={`Remove filter ${c.label} ${c.value}`}
            onClick={c.onRemove}
            className="grid size-5 shrink-0 place-items-center rounded-full text-fg-3 outline-none hover:bg-surface-3 hover:text-fg focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <X className="size-3" aria-hidden />
          </button>
        </span>
      ))}
      {chips.length > 1 ? (
        <button type="button" onClick={clearAll} className="ml-1 h-6 rounded px-1.5 text-xs text-fg-2 underline-offset-2 outline-none hover:text-fg hover:underline focus-visible:ring-2 focus-visible:ring-ring/50">
          Clear all
        </button>
      ) : null}
    </div>
  );
}
