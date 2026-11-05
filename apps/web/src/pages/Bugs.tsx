import { useEffect, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import { Bot, Bug as BugIcon, ChevronLeft, ChevronRight, Ellipsis, Pencil, Plus, Search, Trash2, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';
import { BugSeverity, BugVerification, type Bug } from '@ptd/shared';
import { useBugStats, useBugs, useDeleteBug } from '../api/hooks';
import { useDebounced } from '../lib/useDebounced';
import { cn, fmtNumber, fmtRelative } from '../lib/utils';
import { Button } from '../components/ui/button';
import { Card, CardBody, CardHeader } from '../components/ui/card';
import { ConfirmDialog } from '../components/ui/confirm';
import { EmptyState, ErrorState } from '../components/ui/empty-state';
import { Input } from '../components/ui/input';
import { Menu, MenuContent, MenuItem, MenuTrigger } from '../components/ui/dropdown';
import { ExternalLink, PageHeader } from '../components/ui/misc';
import { Select } from '../components/ui/select';
import { Skeleton, SkeletonRows } from '../components/ui/skeleton';
import { Tooltip as Tip } from '../components/ui/tooltip';
import { FoundResolvedChart } from '../components/charts/FoundResolvedChart';
import { BugDialog, BugStatusBadge, SEVERITY_META, SeverityBadge, VERIFICATION_META, VerificationBadge } from '../components/bugs';
import { RESULT_META } from '../components/status';
import { RunGroupChip } from '../components/RunGroup';

const BUCKETS = [
  { v: 'open', l: 'Open' },
  { v: 'resolved', l: 'Resolved' },
  { v: 'all', l: 'All' },
] as const;

export default function BugsPage() {
  const [params, setParams] = useSearchParams();
  const bucket = (BUCKETS.find((b) => b.v === params.get('bucket'))?.v ?? 'open') as 'open' | 'resolved' | 'all';
  const severity = BugSeverity.safeParse(params.get('severity')).data;
  const verification = BugVerification.safeParse(params.get('verification')).data;
  const auto = params.get('auto') === '1';
  const page = Math.max(1, Number(params.get('page')) || 1);
  const [search, setSearch] = useState(params.get('search') ?? '');
  const debounced = useDebounced(search.trim(), 300);
  const [dialog, setDialog] = useState<{ bug?: Bug } | null>(null);
  const [toDelete, setToDelete] = useState<Bug | null>(null);
  const del = useDeleteBug();

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

  const pageSize = 50;
  const bugs = useBugs({ bucket, severity, verification, foundByAutomation: auto || undefined, search: debounced || undefined, page, pageSize });
  const stats = useBugStats();
  const items = bugs.data?.items ?? [];
  const total = bugs.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <>
      <PageHeader
        title="Bugs"
        description="Defects found by your tests — and whether the fix is verified by the next run."
        actions={
          <Button variant="primary" onClick={() => setDialog({})}>
            <Plus /> Log bug
          </Button>
        }
      />
      <StatsRow stats={stats.data} onPick={(p) => set(p)} />
      <div className="mb-4 grid gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader title="Found vs resolved" description="Bugs per week, last 26 weeks" />
          <CardBody>{stats.data ? <FoundResolvedChart trend={stats.data.trend} /> : <Skeleton className="h-52" />}</CardBody>
        </Card>
        <Card>
          <CardHeader title="Open by severity" />
          <CardBody>
            {stats.data ? (
              <ul className="space-y-2.5">
                {BugSeverity.options.map((s) => {
                  const n = stats.data.bySeverity.find((x) => x.severity === s)?.open ?? 0;
                  const max = Math.max(1, ...stats.data.bySeverity.map((x) => x.open));
                  const M = SEVERITY_META[s];
                  return (
                    <li key={s}>
                      <button type="button" onClick={() => set({ severity: s, bucket: null })} className="flex w-full items-center gap-2 rounded outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
                        <M.icon className="size-3.5" style={{ color: M.color }} aria-hidden />
                        <span className="w-16 text-left text-xs text-fg-2">{M.label}</span>
                        <span className="h-2 flex-1 overflow-hidden rounded-full bg-surface-2">
                          <span className="block h-full rounded-full" style={{ width: `${(n / max) * 100}%`, background: M.color }} />
                        </span>
                        <span className="w-6 text-right text-xs font-semibold text-fg tabular">{n}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <Skeleton className="h-32" />
            )}
            {stats.data ? (
              <p className="mt-4 border-t border-border pt-3 text-xs text-fg-2">
                Mean time to resolve:{' '}
                <b className="font-semibold text-fg">{stats.data.meanDaysToResolve != null ? `${stats.data.meanDaysToResolve.toFixed(1)} days` : '—'}</b>{' '}
                <span className="text-fg-3">(last 90 days)</span>
              </p>
            ) : null}
          </CardBody>
        </Card>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div role="radiogroup" aria-label="Bucket" className="inline-flex rounded-md border border-border bg-surface-2 p-0.5">
          {BUCKETS.map((b) => (
            <button
              key={b.v}
              type="button"
              role="radio"
              aria-checked={bucket === b.v}
              onClick={() => set({ bucket: b.v === 'open' ? null : b.v })}
              className={cn('h-7 rounded-[5px] px-3 text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring/50', bucket === b.v ? 'bg-surface text-fg shadow-sm' : 'text-fg-2 hover:text-fg')}
            >
              {b.l}
            </button>
          ))}
        </div>
        <div className="relative w-full sm:w-56">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-fg-3" aria-hidden />
          <Input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search key or title…" aria-label="Search bugs" className="pl-8" />
        </div>
        <Select
          ariaLabel="Severity"
          value={severity ?? null}
          onValueChange={(v) => set({ severity: v })}
          options={BugSeverity.options.map((s) => ({ value: s, label: SEVERITY_META[s].label }))}
          allowNone
          noneLabel="Any severity"
        />
        <Select
          ariaLabel="Verification"
          value={verification ?? null}
          onValueChange={(v) => set({ verification: v })}
          options={BugVerification.options.filter((v) => v !== 'n/a').map((v) => ({ value: v, label: VERIFICATION_META[v].label }))}
          allowNone
          noneLabel="Any verification"
        />
        <button
          type="button"
          aria-pressed={auto}
          onClick={() => set({ auto: auto ? null : '1' })}
          className={cn(
            'inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-[13px] shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
            auto ? 'border-accent/50 bg-accent-soft text-fg' : 'border-border-strong/70 bg-surface text-fg-2 hover:bg-surface-2',
          )}
        >
          <Bot className="size-3.5" aria-hidden /> Found by automation
        </button>
      </div>

      <Card className={cn('overflow-hidden', bugs.isPlaceholderData && 'opacity-70')}>
        {bugs.isError ? (
          <ErrorState error={bugs.error} onRetry={() => void bugs.refetch()} />
        ) : bugs.isPending ? (
          <SkeletonRows rows={6} />
        ) : items.length === 0 ? (
          <EmptyState icon={<BugIcon />} title={bucket === 'open' ? 'No open bugs' : 'No bugs match'} actions={<Button variant="outline" onClick={() => setDialog({})}><Plus /> Log bug</Button>}>
            Log bugs from a failure group on a run, from a test case, or here. Notes triaged as “Product bug” with a Jira link create one automatically.
          </EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[880px] text-[13px]">
              <thead className="bg-surface-2/60 text-left text-[11px] font-medium tracking-wide text-fg-3 uppercase">
                <tr className="border-b border-border">
                  <th className="px-4 py-2 font-medium">Bug</th>
                  <th className="px-2 py-2 font-medium">Severity</th>
                  <th className="px-2 py-2 font-medium">Status</th>
                  <th className="px-2 py-2 font-medium">Verification</th>
                  <th className="px-2 py-2 font-medium">Linked tests</th>
                  <th className="px-2 py-2 font-medium">Found in</th>
                  <th className="px-2 py-2 font-medium">Age</th>
                  <th className="w-10 px-2 py-2" />
                </tr>
              </thead>
              <tbody>
                {items.map((b) => (
                  <BugRow key={b.id} b={b} onEdit={() => setDialog({ bug: b })} onDelete={() => setToDelete(b)} />
                ))}
              </tbody>
            </table>
          </div>
        )}
        {total > pageSize ? (
          <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-2 text-xs text-fg-2">
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
        ) : null}
      </Card>

      <BugDialog open={!!dialog} onOpenChange={(o) => !o && setDialog(null)} bug={dialog?.bug} />
      <ConfirmDialog
        open={!!toDelete}
        onOpenChange={(o) => !o && setToDelete(null)}
        title="Delete bug?"
        description={`“${toDelete?.title ?? ''}” will be removed and unlinked from its test cases. Jira is not affected.`}
        loading={del.isPending}
        onConfirm={() => toDelete && del.mutate(toDelete.id, { onSuccess: () => { toast.success('Bug deleted'); setToDelete(null); } })}
      />
    </>
  );
}

function StatTile({ label, value, tone, onClick, icon }: { label: string; value: ReactNode; tone?: 'bad'; onClick?: () => void; icon?: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      className={cn(
        'rounded-xl border bg-surface px-4 py-3 text-left shadow-sm outline-none transition-colors enabled:hover:border-border-strong focus-visible:ring-2 focus-visible:ring-ring/50',
        tone === 'bad' ? 'border-[color-mix(in_oklab,var(--st-failed)_40%,var(--border))] bg-[color-mix(in_oklab,var(--st-failed)_5%,var(--surface))]' : 'border-border',
      )}
    >
      <div className="flex items-center gap-1.5 text-xs text-fg-2">
        {icon}
        {label}
      </div>
      <div className="mt-1 text-2xl font-semibold tracking-tight text-fg">{value}</div>
    </button>
  );
}

function StatsRow({ stats, onPick }: { stats: ReturnType<typeof useBugStats>['data']; onPick: (p: Record<string, string | null>) => void }) {
  if (!stats)
    return (
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-[76px]" />
        ))}
      </div>
    );
  return (
    <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
      <StatTile label="Open" value={fmtNumber(stats.open)} onClick={() => onPick({ bucket: null, verification: null })} />
      <StatTile label="In progress" value={fmtNumber(stats.inProgress)} />
      <StatTile label="Awaiting verification" value={fmtNumber(stats.resolvedAwaitingVerification)} onClick={() => onPick({ bucket: 'resolved', verification: 'awaiting_run' })} />
      <StatTile
        label="Resolved but still failing"
        value={fmtNumber(stats.stillFailingAfterFix)}
        tone={stats.stillFailingAfterFix > 0 ? 'bad' : undefined}
        icon={stats.stillFailingAfterFix > 0 ? <TriangleAlert className="size-3.5 text-st-failed" aria-hidden /> : undefined}
        onClick={() => onPick({ bucket: 'resolved', verification: 'still_failing' })}
      />
      <StatTile label="Verified fixed" value={fmtNumber(stats.verifiedFixed)} onClick={() => onPick({ bucket: 'resolved', verification: 'verified_fixed' })} />
      <StatTile label="Mean days to resolve" value={stats.meanDaysToResolve != null ? stats.meanDaysToResolve.toFixed(1) : '—'} />
    </div>
  );
}

function BugRow({ b, onEdit, onDelete }: { b: Bug; onEdit: () => void; onDelete: () => void }) {
  return (
    <tr className={cn('border-b border-border align-top last:border-0 hover:bg-surface-2/50', b.verification === 'still_failing' && 'bg-[color-mix(in_oklab,var(--st-failed)_5%,transparent)]')}>
      <td className="max-w-[340px] px-4 py-2.5">
        <div className="flex items-start gap-2">
          <BugIcon className="mt-0.5 size-3.5 shrink-0 text-st-broken" aria-hidden />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-2">
              {b.jiraKey ? (
                <ExternalLink href={b.url} className="font-mono text-xs" fallback={<span className="font-mono text-xs text-fg-2">{b.jiraKey}</span>}>
                  {b.jiraKey}
                </ExternalLink>
              ) : b.url ? (
                <ExternalLink href={b.url} className="text-xs">
                  Link
                </ExternalLink>
              ) : null}
              {b.foundByAutomation ? (
                <Tip content="Found by automation">
                  <Bot className="size-3.5 text-fg-3" aria-label="Found by automation" />
                </Tip>
              ) : null}
            </div>
            <div className="line-clamp-2 text-fg">{b.title}</div>
            {b.assignee ? <div className="text-[11px] text-fg-3">Assignee: {b.assignee}</div> : null}
          </div>
        </div>
      </td>
      <td className="px-2 py-2.5">
        <SeverityBadge severity={b.severity} />
      </td>
      <td className="px-2 py-2.5">
        <BugStatusBadge status={b.status} />
      </td>
      <td className="px-2 py-2.5">
        <VerificationBadge v={b.verification} />
      </td>
      <td className="max-w-60 px-2 py-2.5">
        {b.testCases.length === 0 ? (
          <span className="text-xs text-fg-3">None</span>
        ) : (
          <ul className="space-y-0.5">
            {b.testCases.slice(0, 3).map((t) => {
              const M = t.lastStatus ? RESULT_META[t.lastStatus] : null;
              return (
                <li key={t.id} className="flex min-w-0 items-center gap-1.5 text-xs">
                  {M ? <M.icon className="size-3 shrink-0" style={{ color: M.color }} aria-label={M.label} /> : <span className="size-3 shrink-0" />}
                  <Link to={`/tests/${t.id}`} className="truncate text-fg-2 hover:text-fg hover:underline" title={t.title}>
                    <span className="font-mono">{t.key}</span>
                  </Link>
                </li>
              );
            })}
            {b.testCases.length > 3 ? <li className="text-[11px] text-fg-3">+{b.testCases.length - 3} more</li> : null}
          </ul>
        )}
      </td>
      <td className="px-2 py-2.5">
        {b.foundInRun ? (
          <div className="space-y-0.5">
            <Link to={`/runs/${b.foundInRun.id}`} className="block max-w-40 truncate text-xs text-fg-2 hover:text-fg hover:underline">
              {b.foundInRun.name}
            </Link>
            <RunGroupChip group={b.foundInRun.runGroup} />
          </div>
        ) : (
          <span className="text-xs text-fg-3">—</span>
        )}
      </td>
      <td className="px-2 py-2.5 text-xs whitespace-nowrap text-fg-2">{fmtRelative(b.createdAt).replace(' ago', '')}</td>
      <td className="px-2 py-2">
        <Menu>
          <MenuTrigger asChild>
            <Button size="icon-sm" variant="ghost" aria-label={`Actions for ${b.jiraKey ?? b.title}`}>
              <Ellipsis />
            </Button>
          </MenuTrigger>
          <MenuContent>
            <MenuItem onSelect={onEdit}>
              <Pencil /> Edit
            </MenuItem>
            <MenuItem onSelect={onDelete} className="text-bad">
              <Trash2 /> Delete
            </MenuItem>
          </MenuContent>
        </Menu>
      </td>
    </tr>
  );
}
