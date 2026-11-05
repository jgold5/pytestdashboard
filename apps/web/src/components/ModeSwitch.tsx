import { NavLink, useLocation } from 'react-router';
import { cn } from '../lib/utils';

/** Workspace | Report segmented control (editors only). */
export function ModeSwitch({ className }: { className?: string }) {
  const { pathname } = useLocation();
  const inReport = pathname.startsWith('/report');
  const item =
    'relative inline-flex h-6 items-center rounded-[5px] px-2.5 text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50';
  return (
    <nav aria-label="Mode" className={cn('inline-flex rounded-md border border-border bg-surface-2 p-0.5', className)}>
      <NavLink
        to="/"
        aria-current={!inReport ? 'page' : undefined}
        className={cn(item, !inReport ? 'bg-surface text-fg shadow-sm' : 'text-fg-2 hover:text-fg')}
      >
        Workspace
      </NavLink>
      <NavLink
        to="/report"
        aria-current={inReport ? 'page' : undefined}
        className={cn(item, inReport ? 'bg-surface text-fg shadow-sm' : 'text-fg-2 hover:text-fg')}
      >
        Report
      </NavLink>
    </nav>
  );
}
