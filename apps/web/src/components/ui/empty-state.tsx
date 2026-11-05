import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';

export function EmptyState({
  icon,
  title,
  children,
  actions,
  className,
}: {
  icon?: ReactNode;
  title: string;
  children?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col items-center justify-center px-6 py-12 text-center', className)}>
      {icon ? (
        <div className="mb-3 grid size-10 place-items-center rounded-full border border-border bg-surface-2 text-fg-3 [&_svg]:size-5">
          {icon}
        </div>
      ) : null}
      <h3 className="text-sm font-semibold text-fg">{title}</h3>
      {children ? <div className="mt-1 max-w-md text-[13px] text-fg-2">{children}</div> : null}
      {actions ? <div className="mt-4 flex flex-wrap justify-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const msg = error instanceof Error ? error.message : 'Something went wrong.';
  return (
    <div role="alert" className="flex flex-col items-center px-6 py-10 text-center">
      <p className="text-sm font-medium text-fg">Couldn’t load this</p>
      <p className="mt-1 text-[13px] text-fg-2">{msg}</p>
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="mt-3 rounded-md border border-border px-3 py-1 text-xs font-medium text-fg hover:bg-surface-2"
        >
          Retry
        </button>
      ) : null}
    </div>
  );
}
