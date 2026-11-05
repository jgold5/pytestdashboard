import { NavLink, useSearchParams } from 'react-router';
import { CirclePlay, GitCompareArrows, Grid3x3 } from 'lucide-react';
import { cn } from '../lib/utils';
import { PageHeader } from './ui/misc';

const TABS = [
  { to: '/runs', label: 'Runs', icon: CirclePlay, end: true },
  { to: '/runs/history', label: 'History matrix', icon: Grid3x3 },
  { to: '/runs/compare', label: 'Compare', icon: GitCompareArrows },
];

/** Header + tab nav for the Runs / History area. Keeps the run group in the URL across tabs. */
export function RunsHeader({ actions, description }: { actions?: React.ReactNode; description?: React.ReactNode }) {
  const [params] = useSearchParams();
  const group = params.get('group');
  const qs = group ? `?group=${encodeURIComponent(group)}` : '';
  return (
    <PageHeader title="Runs & history" description={description ?? 'Every imported run, how tests behave over time, and what changed between runs.'} actions={actions}>
      <nav aria-label="Runs views" className="mt-4 flex gap-1 overflow-x-auto border-b border-border">
        {TABS.map((t) => (
          <NavLink
            key={t.to}
            to={t.to + qs}
            end={t.end}
            className={({ isActive }) =>
              cn(
                '-mb-px inline-flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-[13px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
                isActive ? 'border-accent text-fg' : 'border-transparent text-fg-2 hover:text-fg',
              )
            }
          >
            <t.icon className="size-4" aria-hidden />
            {t.label}
          </NavLink>
        ))}
      </nav>
    </PageHeader>
  );
}
