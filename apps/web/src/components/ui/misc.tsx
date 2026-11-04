import type { ReactNode } from 'react';
import { ExternalLink as ExternalIcon } from 'lucide-react';
import { cn } from '../../lib/utils';
import { safeHttpUrl } from '../../lib/url';

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        'inline-flex h-5 min-w-5 items-center justify-center rounded border border-border bg-surface-2 px-1 font-sans text-[10px] font-medium text-fg-3',
        className,
      )}
    >
      {children}
    </kbd>
  );
}

/** Renders a link only when the URL is http(s); otherwise plain text (or nothing). */
export function ExternalLink({
  href,
  children,
  className,
  showIcon = true,
  fallback,
}: {
  href: string | null | undefined;
  children: ReactNode;
  className?: string;
  showIcon?: boolean;
  fallback?: ReactNode;
}) {
  const safe = safeHttpUrl(href);
  if (!safe) return <>{fallback ?? null}</>;
  return (
    <a
      href={safe}
      target="_blank"
      rel="noopener noreferrer"
      className={cn('inline-flex items-center gap-1 text-accent hover:underline underline-offset-2', className)}
    >
      {children}
      {showIcon ? <ExternalIcon className="size-3 shrink-0 opacity-70" aria-hidden /> : null}
    </a>
  );
}

export function PageHeader({
  title,
  description,
  actions,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="mb-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight text-fg">{title}</h1>
          {description ? <p className="mt-1 text-[13px] text-fg-2">{description}</p> : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      {children}
    </div>
  );
}

export function Chip({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex max-w-full items-center gap-1 truncate rounded-md border border-border bg-surface-2 px-1.5 py-px text-[11px] font-medium text-fg-2',
        className,
      )}
    >
      {children}
    </span>
  );
}

/** Thin segmented bar (8px / 4px dense). Parts at zero draw nothing; 2px surface gap between parts. */
export function SegmentedBar({
  parts,
  className,
  height = 8,
  label,
}: {
  parts: { value: number; color: string; label: string; className?: string }[];
  className?: string;
  height?: number;
  label: string;
}) {
  const total = parts.reduce((s, p) => s + p.value, 0);
  const visible = parts.filter((p) => p.value > 0);
  return (
    <div
      role="img"
      aria-label={`${label}: ${parts.map((p) => `${p.label} ${p.value}`).join(', ')}`}
      className={cn('flex w-full gap-[2px] overflow-hidden rounded-full bg-surface-3', className)}
      style={{ height }}
    >
      {total > 0
        ? visible.map((p) => (
            <div
              key={p.label}
              className={cn('h-full first:rounded-l-full last:rounded-r-full', p.className)}
              style={{ width: `${(p.value / total) * 100}%`, background: p.color }}
              title={`${p.label}: ${p.value}`}
            />
          ))
        : null}
    </div>
  );
}
