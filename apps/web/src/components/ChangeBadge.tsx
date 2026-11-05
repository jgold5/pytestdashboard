import { ArrowUp, Check, Equal, Minus, Repeat, Sparkles, type LucideIcon } from 'lucide-react';
import type { ResultChange } from '@ptd/shared';
import { cn, fmtNumber } from '../lib/utils';

export const CHANGE_META: Record<ResultChange, { label: string; icon: LucideIcon; color: string; quiet?: boolean }> = {
  new_failure: { label: 'New failure', icon: ArrowUp, color: 'var(--st-failed)' },
  still_failing: { label: 'Still failing', icon: Repeat, color: 'var(--st-broken)' },
  fixed: { label: 'Fixed', icon: Check, color: 'var(--st-passed)' },
  new_test: { label: 'New test', icon: Sparkles, color: 'var(--accent)' },
  stable_pass: { label: 'Stable', icon: Equal, color: 'var(--fg-3)', quiet: true },
  other: { label: '—', icon: Minus, color: 'var(--fg-3)', quiet: true },
};

export function ChangeBadge({ change, className }: { change: ResultChange; className?: string }) {
  const M = CHANGE_META[change];
  if (M.quiet) {
    return <span className={cn('text-[11px] text-fg-3', className)}>{change === 'stable_pass' ? 'Stable' : '—'}</span>;
  }
  return (
    <span
      className={cn('inline-flex items-center gap-1 rounded-full border px-1.5 py-px text-[11px] leading-[18px] font-medium whitespace-nowrap text-fg', className)}
      style={{
        background: `color-mix(in oklab, ${M.color} 11%, transparent)`,
        borderColor: `color-mix(in oklab, ${M.color} 28%, transparent)`,
      }}
    >
      <M.icon className="size-3" style={{ color: M.color }} strokeWidth={2.6} aria-hidden />
      {M.label}
    </span>
  );
}

/** Compact change chips for a run: ▲ N new failures, ✓ N fixed. */
export function RunChangeChips({
  changes,
  className,
  showZero = false,
  baseline = true,
}: {
  changes: { newFailures: number; fixed: number; stillFailing?: number };
  className?: string;
  showZero?: boolean;
  /** false when the run has no previous run to compare with (first of its group/branch). */
  baseline?: boolean;
}) {
  if (!baseline) return <span className={cn('text-[11px] text-fg-3', className)}>First run · no baseline</span>;
  const chips: { key: string; n: number; label: string; icon: LucideIcon; color: string }[] = [
    { key: 'new', n: changes.newFailures, label: 'new failing', icon: ArrowUp, color: 'var(--st-failed)' },
    { key: 'fixed', n: changes.fixed, label: 'fixed', icon: Check, color: 'var(--st-passed)' },
  ];
  const visible = chips.filter((c) => showZero || c.n > 0);
  if (visible.length === 0) return <span className={cn('text-[11px] text-fg-3', className)}>No changes</span>;
  return (
    <span className={cn('inline-flex flex-wrap items-center gap-1', className)}>
      {visible.map((c) => (
        <span
          key={c.key}
          className="inline-flex items-center gap-0.5 rounded-full border px-1.5 py-px text-[11px] leading-[18px] font-medium whitespace-nowrap text-fg tabular"
          style={{
            background: `color-mix(in oklab, ${c.color} 11%, transparent)`,
            borderColor: `color-mix(in oklab, ${c.color} 28%, transparent)`,
          }}
          aria-label={`${c.n} ${c.label}`}
        >
          <c.icon className="size-3" style={{ color: c.color }} strokeWidth={2.8} aria-hidden />
          {fmtNumber(c.n)} <span className="font-normal text-fg-2">{c.label}</span>
        </span>
      ))}
    </span>
  );
}
