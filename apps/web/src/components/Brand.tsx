import { cn } from '../lib/utils';

/** The mark: a route line between two endpoints (a trigger and the job it starts). */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={cn('size-6 shrink-0', className)} aria-hidden>
      <rect width="32" height="32" rx="7" fill="var(--accent)" />
      <path
        d="M7.5 21 13 12.5l5.5 6.5 6-10"
        fill="none"
        stroke="var(--accent-fg)"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="7.5" cy="21" r="2.6" fill="var(--accent-fg)" />
      <circle cx="24.5" cy="9" r="2.6" fill="var(--accent-fg)" />
    </svg>
  );
}

export function Brand({ className, compact }: { className?: string; compact?: boolean }) {
  return (
    <span className={cn('inline-flex items-center gap-2', className)}>
      <BrandMark />
      {compact ? null : <span className="text-[14px] font-semibold tracking-tight whitespace-nowrap text-fg">Test Automation</span>}
    </span>
  );
}
