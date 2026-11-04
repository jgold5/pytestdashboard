import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import * as D from '@radix-ui/react-dialog';
import {
  Bug,
  CirclePlay,
  CornerDownLeft,
  GitPullRequest,
  LayoutDashboard,
  ListChecks,
  Plug,
  Presentation,
  Search,
  Upload,
} from 'lucide-react';
import { useTestCases } from '../api/hooks';
import { useDebounced } from '../lib/useDebounced';
import { cn } from '../lib/utils';
import { AUTOMATION_META, ResultBadge } from './status';
import { Kbd } from './ui/misc';

export function useCommandPaletteHotkey(open: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        open();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);
}

const PAGES = [
  { label: 'Overview', to: '/', icon: LayoutDashboard },
  { label: 'Test cases', to: '/tests', icon: ListChecks },
  { label: 'Pull requests', to: '/pulls', icon: GitPullRequest },
  { label: 'Runs', to: '/runs', icon: CirclePlay },
  { label: 'History matrix', to: '/runs/history', icon: CirclePlay },
  { label: 'Compare runs', to: '/runs/compare', icon: CirclePlay },
  { label: 'Bugs', to: '/bugs', icon: Bug },
  { label: 'Import', to: '/import', icon: Upload },
  { label: 'Integrations', to: '/integrations', icon: Plug },
  { label: 'Management report', to: '/report', icon: Presentation },
];

interface Item {
  id: string;
  to: string;
  render: React.ReactNode;
}

export function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <D.Content
          className="fixed top-[12vh] left-1/2 z-50 w-[calc(100vw-24px)] max-w-xl -translate-x-1/2 overflow-hidden rounded-xl border border-border bg-surface shadow-lg outline-none"
          aria-describedby={undefined}
        >
          <D.Title className="sr-only">Quick search</D.Title>
          {open ? <PaletteBody onClose={() => onOpenChange(false)} /> : null}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

function PaletteBody({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const debounced = useDebounced(q.trim(), 150);
  const cases = useTestCases({ search: debounced, pageSize: 8 }, { enabled: debounced.length > 0 });

  const items: Item[] = useMemo(() => {
    const pages = PAGES.filter((p) => !q || p.label.toLowerCase().includes(q.toLowerCase())).map((p) => ({
      id: `page:${p.to}`,
      to: p.to,
      render: (
        <>
          <p.icon className="size-4 text-fg-3" aria-hidden />
          <span className="flex-1 truncate">{p.label}</span>
          <span className="text-[11px] text-fg-3">Page</span>
        </>
      ),
    }));
    const tcs = debounced
      ? (cases.data?.items ?? []).map((t) => {
          const A = AUTOMATION_META[t.automationStatus];
          return {
            id: `tc:${t.id}`,
            to: `/tests/${t.id}`,
            render: (
              <>
                <A.icon className="size-4 shrink-0" style={{ color: A.color }} aria-label={A.label} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{t.title}</span>
                  <span className="block truncate font-mono text-[11px] text-fg-3">{t.key}</span>
                </span>
                {t.lastResult ? <ResultBadge status={t.lastResult.status} /> : null}
              </>
            ),
          };
        })
      : [];
    return [...tcs, ...pages];
  }, [q, debounced, cases.data]);

  const clamped = Math.min(active, Math.max(items.length - 1, 0));

  const go = (it: Item | undefined) => {
    if (!it) return;
    onClose();
    void navigate(it.to);
  };

  return (
    <div
      onKeyDown={(e) => {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          setActive((a) => Math.min(a + 1, items.length - 1));
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          setActive((a) => Math.max(a - 1, 0));
        } else if (e.key === 'Enter') {
          e.preventDefault();
          go(items[clamped]);
        }
      }}
    >
      <div className="flex items-center gap-2 border-b border-border px-3">
        <Search className="size-4 text-fg-3" aria-hidden />
        <input
          autoFocus
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setActive(0);
          }}
          placeholder="Search test cases by key, title, suite, owner…"
          aria-label="Search"
          role="combobox"
          aria-expanded
          aria-controls="palette-list"
          aria-activedescendant={items[clamped] ? `palette-${items[clamped].id}` : undefined}
          className="h-11 flex-1 bg-transparent text-sm text-fg outline-none placeholder:text-fg-3"
        />
        <Kbd>Esc</Kbd>
      </div>
      <ul id="palette-list" role="listbox" aria-label="Results" className="max-h-[50vh] overflow-y-auto p-1.5">
        {debounced && cases.isFetching && !cases.data ? (
          <li className="px-3 py-2 text-xs text-fg-3">Searching…</li>
        ) : null}
        {items.length === 0 ? <li className="px-3 py-6 text-center text-[13px] text-fg-3">No matches</li> : null}
        {items.map((it, i) => (
          <li
            key={it.id}
            id={`palette-${it.id}`}
            role="option"
            aria-selected={i === clamped}
            onMouseMove={() => setActive(i)}
            onClick={() => go(it)}
            className={cn(
              'flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 text-[13px] text-fg',
              i === clamped && 'bg-surface-2',
            )}
          >
            {it.render}
            {i === clamped ? <CornerDownLeft className="size-3.5 text-fg-3" aria-hidden /> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
