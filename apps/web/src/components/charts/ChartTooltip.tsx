import type { ReactNode } from 'react';

export interface TooltipRow {
  color: string;
  label: string;
  value: ReactNode;
  shape?: 'line' | 'square';
}

/** Shared tooltip body: values lead (strong), labels follow; line/square keys, never colored text. */
export function ChartTooltipBox({ title, rows, footer }: { title: ReactNode; rows: TooltipRow[]; footer?: ReactNode }) {
  return (
    <div className="min-w-40 rounded-lg border border-border bg-surface px-3 py-2 text-xs shadow-md">
      <div className="mb-1.5 font-medium text-fg-2">{title}</div>
      <div className="space-y-1">
        {rows.map((r) => (
          <div key={r.label} className="flex items-center gap-2">
            <span
              aria-hidden
              className={r.shape === 'square' ? 'size-2.5 rounded-[3px]' : 'h-0.5 w-3 rounded-full'}
              style={{ background: r.color }}
            />
            <span className="font-semibold text-fg tabular">{r.value}</span>
            <span className="text-fg-2">{r.label}</span>
          </div>
        ))}
      </div>
      {footer ? <div className="mt-1.5 border-t border-border pt-1.5 text-fg-2">{footer}</div> : null}
    </div>
  );
}

export function Legend({ items }: { items: { label: string; color: string; shape?: 'line' | 'square' | 'dashed' }[] }) {
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-fg-2">
      {items.map((i) => (
        <li key={i.label} className="inline-flex items-center gap-1.5">
          {i.shape === 'dashed' ? (
            <span aria-hidden className="w-3.5 border-t-2 border-dashed" style={{ borderColor: i.color }} />
          ) : (
            <span
              aria-hidden
              className={i.shape === 'line' ? 'h-0.5 w-3.5 rounded-full' : 'size-2.5 rounded-[3px]'}
              style={{ background: i.color }}
            />
          )}
          {i.label}
        </li>
      ))}
    </ul>
  );
}
