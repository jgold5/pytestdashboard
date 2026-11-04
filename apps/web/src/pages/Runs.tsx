import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { ChevronLeft, ChevronRight, CirclePlay, Ellipsis, GitBranch, GitCommitHorizontal, GitCompareArrows, Search, Trash2, Upload, X } from 'lucide-react';
import type { Run } from '@ptd/shared';
import { useDeleteRun, useMeta, useRuns } from '../api/hooks';
import { useDebounced } from '../lib/useDebounced';
import { ALL_GROUPS, useRunGroupSelection } from '../lib/runGroup';
import { cn, fmtDateTime, fmtDuration, fmtNumber, fmtRelative } from '../lib/utils';
import { Button } from '../components/ui/button';
import { Card } from '../components/ui/card';
import { Checkbox } from '../components/ui/checkbox';
import { ConfirmDialog } from '../components/ui/confirm';
import { EmptyState, ErrorState } from '../components/ui/empty-state';
import { Input } from '../components/ui/input';
import { Menu, MenuContent, MenuItem, MenuTrigger } from '../components/ui/dropdown';
import { Select } from '../components/ui/select';
import { SkeletonRows } from '../components/ui/skeleton';
import { linkButton } from '../components/ui/link-button';
import { Tooltip } from '../components/ui/tooltip';
import { RunsHeader } from '../components/RunsTabs';
import { RunGroupChip, RunGroupPicker } from '../components/RunGroup';
import { RunChangeChips } from '../components/ChangeBadge';
import { RESULT_META } from '../components/status';
import { PassRateBar } from '../components/RunBits';

export default function RunsPage() {
  const { groups, value: group, setValue: setGroup } = useRunGroupSelection({ allowAll: true });
  const meta = useMeta();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const page = Math.max(1, Number(params.get('page')) || 1);
  const branch = params.get('branch') ?? undefined;
  const from = params.get('from') ?? undefined;
  const to = params.get('to') ?? undefined;
  const [search, setSearch] = useState(params.get('search') ?? '');
  const debounced = useDebounced(search.trim(), 300);
  const [selected, setSelected] = useState<Run[]>([]);
  const [toDelete, setToDelete] = useState<Run | null>(null);
  const del = useDeleteRun();

  const set = (patch: Record<string, string | null>) =>
    setParams(
      (prev) => {
        const n = new URLSearchParams(prev);
        for (const [k, v] of Object.entries(patch)) {
          if (v) n.set(k, v);
          else n.delete(k);
        }
        if (!('page' in patch)) n.delete('page');
        return n;
      },
      { replace: true },
    );

  useEffect(() => {
    if ((params.get('search') ?? '') !== debounced) set({ search: debounced || null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);

  const pageSize = 25;
  const runs = useRuns({
    page,
    pageSize,
    branch,
    from,
    to,
    search: debounced || undefined,
    runGroup: group && group !== ALL_GROUPS ? group : undefined,
  });
  const items = runs.data?.items ?? [];
  const total = runs.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const filtered = !!(branch || from || to || debounced);

  const toggle = (r: Run, c: boolean) =>
    setSelected((prev) => {
      if (!c) return prev.filter((x) => x.id !== r.id);
      const next = [...prev.filter((x) => x.id !== r.id), r];
      return next.slice(-2); // keep at most two (the last two picked)
    });

  const compare = () => {
    if (selected.length !== 2) return;
    const [a, b] = [...selected].sort((x, y) => (x.startedAt ?? x.importedAt).localeCompare(y.startedAt ?? y.importedAt));
    const g = a!.runGroup === b!.runGroup ? a!.runGroup : null;
    void navigate(`/runs/compare?base=${a!.id}&head=${b!.id}${g ? `&group=${encodeURIComponent(g)}` : ''}`);
  };

  return (
    <>
      <RunsHeader
        actions={
          <Link to="/import#allure" className={linkButton('outline')}>
            <Upload /> Upload results
          </Link>
        }
      />
      <div className="mb-3 space-y-3">
        <RunGroupPicker groups={groups} value={group} onChange={(g) => { setGroup(g); setSelected([]); }} allowAll />
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative w-full sm:w-60">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-fg-3" aria-hidden />
            <Input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name or commit…" aria-label="Search runs" className="pl-8" />
          </div>
          <Select
            ariaLabel="Branch"
            value={branch ?? null}
            onValueChange={(v) => set({ branch: v })}
            options={(meta.data?.branches ?? []).map((b) => ({ value: b, label: b, icon: <GitBranch className="size-3.5 text-fg-3" aria-hidden /> }))}
            allowNone
            noneLabel="All branches"
            className="max-w-52"
          />
          <label className="flex items-center gap-1.5 text-xs text-fg-2">
            From
            <Input type="date" value={from ?? ''} max={to} onChange={(e) => set({ from: e.target.value || null })} className="w-36" aria-label="From date" />
          </label>
          <label className="flex items-center gap-1.5 text-xs text-fg-2">
            To
            <Input type="date" value={to ?? ''} min={from} onChange={(e) => set({ to: e.target.value || null })} className="w-36" aria-label="To date" />
          </label>
          {filtered ? (
            <Button variant="ghost" size="sm" onClick={() => { setSearch(''); set({ branch: null, from: null, to: null, search: null }); }}>
              <X /> Clear
            </Button>
          ) : null}
        </div>
      </div>

      {selected.length > 0 ? (
        <div className="sticky top-14 z-10 mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-accent/30 bg-surface px-3 py-2 shadow-md">
          <span className="text-[13px] text-fg">
            {selected.length === 1 ? 'Select one more run to compare' : `${selected.length} runs selected`}
          </span>
          {selected.length === 2 && selected[0]!.runGroup !== selected[1]!.runGroup ? (
            <span className="text-xs text-warn">Different run groups — comparison may be noisy</span>
          ) : null}
          <div className="ml-auto flex gap-2">
            <Button size="sm" variant="ghost" onClick={() => setSelected([])}>
              Clear
            </Button>
            <Button size="sm" variant="primary" disabled={selected.length !== 2} onClick={compare}>
              <GitCompareArrows /> Compare
            </Button>
          </div>
        </div>
      ) : null}

      <Card className={cn('overflow-hidden', runs.isPlaceholderData && 'opacity-70')}>
        {runs.isError ? (
          <ErrorState error={runs.error} onRetry={() => void runs.refetch()} />
        ) : runs.isPending ? (
          <SkeletonRows rows={8} />
        ) : items.length === 0 ? (
          filtered ? (
            <EmptyState icon={<Search />} title="No runs match these filters" />
          ) : (
            <EmptyState
              icon={<CirclePlay />}
              title="No runs yet"
              actions={
                <Link to="/import#allure" className={linkButton('primary')}>
                  <Upload /> Upload allure-results
                </Link>
              }
            >
              Upload an allure-results folder (or zip) from a pytest run, or post it from CI.
            </EmptyState>
          )
        ) : (
          <ul className="divide-y divide-border">
            {items.map((r) => (
              <RunRow
                key={r.id}
                r={r}
                selected={selected.some((s) => s.id === r.id)}
                onSelect={(c) => toggle(r, c)}
                onDelete={() => setToDelete(r)}
                showGroup={group === ALL_GROUPS}
              />
            ))}
          </ul>
        )}
        {total > pageSize ? (
          <div className="flex items-center justify-between border-t border-border px-4 py-2 text-xs text-fg-2">
            <span className="tabular">{fmtNumber(total)} runs</span>
            <div className="flex items-center gap-2">
              <Button size="icon-sm" variant="ghost" aria-label="Previous page" disabled={page <= 1} onClick={() => set({ page: String(page - 1) })}>
                <ChevronLeft />
              </Button>
              <span className="tabular">
                {page} / {pages}
              </span>
              <Button size="icon-sm" variant="ghost" aria-label="Next page" disabled={page >= pages} onClick={() => set({ page: String(page + 1) })}>
                <ChevronRight />
              </Button>
            </div>
          </div>
        ) : null}
      </Card>

      <ConfirmDialog
        open={!!toDelete}
        onOpenChange={(o) => !o && setToDelete(null)}
        title={`Delete run “${toDelete?.name ?? ''}”?`}
        description={
          <>
            Deletes the run and its {fmtNumber(toDelete?.counts.total ?? 0)} results. Test cases and notes are kept. The next run in
            this group will be re-baselined against the run before it.
          </>
        }
        loading={del.isPending}
        onConfirm={() =>
          toDelete &&
          del.mutate(toDelete.id, {
            onSuccess: () => {
              toast.success('Run deleted');
              setSelected((s) => s.filter((x) => x.id !== toDelete.id));
              setToDelete(null);
            },
          })
        }
      />
    </>
  );
}

function StatusCounts({ c }: { c: Run['counts'] }) {
  const items = ['passed', 'failed', 'broken', 'skipped'] as const;
  return (
    <span className="hidden grid-cols-4 gap-1 text-xs text-fg-2 tabular sm:grid">
      {items.map((k) => {
        const M = RESULT_META[k];
        return (
          <span key={k} className={cn('inline-flex w-11 items-center gap-1', c[k] === 0 && 'opacity-35')} title={M.label} aria-label={`${c[k]} ${M.label}`}>
            <M.icon className="size-3" style={{ color: M.color }} aria-hidden />
            {fmtNumber(c[k])}
          </span>
        );
      })}
    </span>
  );
}

function RunRow({
  r,
  selected,
  onSelect,
  onDelete,
  showGroup,
}: {
  r: Run;
  selected: boolean;
  onSelect: (c: boolean) => void;
  onDelete: () => void;
  showGroup: boolean;
}) {
  const navigate = useNavigate();
  const when = r.startedAt ?? r.importedAt;
  return (
    <li
      className={cn('group relative flex cursor-pointer flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5 pr-12 md:pr-4 hover:bg-surface-2/50 md:flex-nowrap', selected && 'bg-accent-soft hover:bg-accent-soft')}
      onClick={() => void navigate(`/runs/${r.id}`)}
    >
      <Checkbox checked={selected} onCheckedChange={onSelect} ariaLabel={`Select ${r.name} for comparison`} />
      <div className="min-w-0 flex-1 basis-56">
        <div className="flex min-w-0 items-center gap-2">
          <Link to={`/runs/${r.id}`} onClick={(e) => e.stopPropagation()} className="truncate text-[13px] font-medium text-fg outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/50">
            {r.name}
          </Link>
          {showGroup ? <RunGroupChip group={r.runGroup} /> : null}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-fg-3">
          <Tooltip content={fmtDateTime(when)}>
            <span>{fmtRelative(when)}</span>
          </Tooltip>
          {r.branch ? (
            <span className="inline-flex items-center gap-1">
              <GitBranch className="size-3" aria-hidden />
              <span className="max-w-40 truncate font-mono">{r.branch}</span>
            </span>
          ) : null}
          {r.commit ? (
            <span className="inline-flex items-center gap-1 font-mono">
              <GitCommitHorizontal className="size-3" aria-hidden />
              {r.commit.slice(0, 7)}
            </span>
          ) : null}
          <span>{fmtDuration(r.durationMs)}</span>
          {!showGroup ? <span className="font-mono">{r.runGroup}</span> : null}
        </div>
      </div>
      <div className="flex min-w-0 basis-full items-center gap-4 pl-8 md:basis-auto md:pl-0">
        <RunChangeChips changes={r.changes} baseline={r.previousRunId !== null} className="md:w-56 md:justify-end" />
        <StatusCounts c={r.counts} />
        <PassRateBar r={r} className="ml-auto md:ml-0" />
      </div>
      <div onClick={(e) => e.stopPropagation()} className="absolute top-2.5 right-2 md:static">
        <Menu>
          <MenuTrigger asChild>
            <Button size="icon-sm" variant="ghost" aria-label={`Actions for ${r.name}`}>
              <Ellipsis />
            </Button>
          </MenuTrigger>
          <MenuContent>
            <MenuItem onSelect={() => void navigate(`/runs/compare?head=${r.id}&group=${encodeURIComponent(r.runGroup)}`)} disabled={!r.previousRunId}>
              <GitCompareArrows /> Compare with previous
            </MenuItem>
            <MenuItem onSelect={onDelete} className="text-bad">
              <Trash2 /> Delete run
            </MenuItem>
          </MenuContent>
        </Menu>
      </div>
    </li>
  );
}
