import { FolderTree } from 'lucide-react';
import { cn } from '../lib/utils';
import { ALL_GROUPS } from '../lib/runGroup';
import { Tooltip } from './ui/tooltip';

/** Run group chip — shown next to every run, everywhere. */
export function RunGroupChip({ group, className }: { group: string; className?: string }) {
  return (
    <Tooltip content={`Run group: ${group}`}>
      <span
        className={cn(
          'inline-flex max-w-[16rem] min-w-0 items-center gap-1 rounded-md border border-border bg-surface-2 px-1.5 py-px font-mono text-[11px] text-fg-2',
          className,
        )}
      >
        <FolderTree className="size-3 shrink-0 text-fg-3" aria-hidden />
        <span className="truncate">{group}</span>
      </span>
    </Tooltip>
  );
}

/** Pill tabs for choosing a run group; collapses to a native select when there are many. */
export function RunGroupPicker({
  groups,
  value,
  onChange,
  allowAll,
  className,
}: {
  groups: { name: string; runs: number }[];
  value: string | null;
  onChange: (g: string) => void;
  allowAll?: boolean;
  className?: string;
}) {
  const options = [...(allowAll ? [{ name: ALL_GROUPS, runs: groups.reduce((s, g) => s + g.runs, 0) }] : []), ...groups];
  if (groups.length === 0) return null;
  const label = (n: string) => (n === ALL_GROUPS ? 'All groups' : n);
  if (options.length > 6) {
    return (
      <label className={cn('inline-flex items-center gap-2 text-xs text-fg-2', className)}>
        <FolderTree className="size-3.5 text-fg-3" aria-hidden />
        Run group
        <select
          value={value ?? ''}
          onChange={(e) => onChange(e.target.value)}
          className="h-8 rounded-md border border-border-strong/70 bg-surface px-2 font-mono text-[12px] text-fg shadow-sm"
        >
          {options.map((o) => (
            <option key={o.name} value={o.name}>
              {label(o.name)} ({o.runs})
            </option>
          ))}
        </select>
      </label>
    );
  }
  return (
    <div role="radiogroup" aria-label="Run group" className={cn('flex flex-wrap items-center gap-1.5', className)}>
      <span className="mr-1 inline-flex items-center gap-1 text-xs text-fg-3">
        <FolderTree className="size-3.5" aria-hidden /> Run group
      </span>
      {options.map((o) => {
        const active = o.name === value;
        return (
          <button
            key={o.name}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(o.name)}
            className={cn(
              'inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50',
              o.name === ALL_GROUPS ? 'font-sans' : 'font-mono',
              active
                ? 'border-accent/50 bg-accent-soft text-fg'
                : 'border-border bg-surface text-fg-2 hover:bg-surface-2 hover:text-fg',
            )}
          >
            {label(o.name)}
            <span className="font-sans text-[10px] text-fg-3 tabular">{o.runs}</span>
          </button>
        );
      })}
    </div>
  );
}
