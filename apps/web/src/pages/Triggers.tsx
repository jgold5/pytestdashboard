import { createContext, useContext, useId, useMemo, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { Braces, ChevronRight, CircleCheck, CircleDashed, Clock, Copy, CornerDownRight, FileInput, GitBranch, GitCompareArrows, Globe, Inbox, Radio, Search, Terminal, Trash2, TriangleAlert, Zap } from 'lucide-react';
import { excludedBy, excludeLabel, folderLabel, routeKey, splitFolders, TRIGGER_KIND_LABEL, type TriggerChange, type TriggerKind, type TriggerListResponse, type TriggerRow } from '@ptd/shared';
import { useDeleteTriggerBranch, useScanGithubBranch, useScopePresets, useTriggerBranches, useTriggerGithub, useTriggerOverview, useTriggers } from '../api/hooks';
import { cleanKinds, useScopeBranch, useScopeExclude, useScopeFolder, useScopeKinds, useScopeTests } from '../lib/scopeBranch';
import { errorMessage } from '../api/client';
import { cn, fmtNumber, fmtPct, fmtRelative, pluralize } from '../lib/utils';
import { Button } from '../components/ui/button';
import { Card, CardBody, CardHeader } from '../components/ui/card';
import { ConfirmDialog } from '../components/ui/confirm';
import { PrScanButton } from '../components/PrScan';
import { SheetCompareButton } from '../components/SheetCompare';
import { activePreset, kindsLabel, ScopeButton, type Scope } from '../components/ScopeButton';
import { EmptyState, ErrorState } from '../components/ui/empty-state';
import { Dialog } from '../components/ui/dialog';
import { Field, Input } from '../components/ui/input';
import { Chip, PageHeader } from '../components/ui/misc';
import { Select } from '../components/ui/select';
import { SkeletonRows } from '../components/ui/skeleton';
import { Tooltip } from '../components/ui/tooltip';

const STATUS_FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'automated', label: 'Tested' },
  { key: 'missing', label: 'No test yet' },
  { key: 'changes', label: 'Changed on this branch', compareOnly: true },
  { key: 'new', label: 'New to the saved filter', freshOnly: true },
] as const;

/** The routes (routeKeys) a saved filter didn't have when it was saved: marked New in the list. */
const FreshContext = createContext<ReadonlySet<string>>(new Set());
type StatusKey = (typeof STATUS_FILTERS)[number]['key'];

const CHANGE_META: Record<TriggerChange, { label: string; cls: string }> = {
  added: { label: 'New', cls: 'border-[color-mix(in_oklab,var(--st-passed)_40%,transparent)] text-st-passed' },
  changed: { label: 'Changed', cls: 'border-[color-mix(in_oklab,var(--warn)_45%,transparent)] text-warn' },
  removed: { label: 'Removed', cls: 'border-[color-mix(in_oklab,var(--st-failed)_40%,transparent)] text-st-failed' },
  unchanged: { label: 'Unchanged', cls: 'border-border text-fg-3' },
};
const CHANGE_ORDER: Record<TriggerChange, number> = { added: 0, changed: 1, removed: 2, unchanged: 3 };

const automated = (r: TriggerRow) => r.coveredBy.length > 0;
/** Rows rendered at a time: a big repo has thousands of triggers. */
const PAGE = 200;
/** Covered on this branch but not on the compare branch. */
const newlyAutomated = (r: TriggerRow) => r.change !== 'removed' && automated(r) && r.automatedBefore === false;
/** Covered on the compare branch, but no test covers it on this one. */
const lostTest = (r: TriggerRow) => r.change !== 'removed' && !automated(r) && r.automatedBefore === true;

export default function TriggersPage() {
  const [params, setParams] = useSearchParams();
  // the branch and folder follow what was picked on the Overview (and back), unless the link names one
  const [scopeBranch, setScopeBranch] = useScopeBranch();
  const [scopeFolder, setScopeFolder] = useScopeFolder();
  const [scopeTests, setScopeTests] = useScopeTests();
  const [scopeKinds, setScopeKinds] = useScopeKinds();
  const [scopeExclude, setScopeExclude] = useScopeExclude();
  const routeInfo = useTriggerOverview(undefined, 1);
  const routeBranches = routeInfo.data?.routeBranches ?? [];
  const defaultBranch = routeInfo.data?.defaultBranch ?? null;
  // always one branch of the trigger repo: its triggers, its merged tests and the PRs into it
  const branchParam = params.get('branch') || null;
  const branch = (branchParam ?? (scopeBranch && routeBranches.includes(scopeBranch) ? scopeBranch : defaultBranch)) ?? undefined;
  const resolving = !branchParam && routeInfo.isPending;
  const compare = (branch && params.get('compare')) || undefined;
  // the kinds of trigger counted: a link's ?kinds= (or the old ?kind=), else the pick shared with the Overview
  const kindsParam = params.has('kinds') || params.has('kind') ? cleanKinds(params.get('kinds') ?? params.get('kind')) : null;
  const kinds = kindsParam ?? scopeKinds;
  const kindSet = useMemo(() => (kinds ? new Set(kinds.split(',')) : null), [kinds]);
  const [limit, setLimit] = useState(PAGE);
  const status = (STATUS_FILTERS.find((f) => f.key === params.get('status'))?.key ?? 'all') as StatusKey;
  const [search, setSearch] = useState(params.get('q') ?? '');
  // the test repo branch whose merged tests (and PRs into it) count; none = the routes branch's name
  const tests = params.get('tests') || scopeTests || undefined;
  // route ids left out: a link's ?exclude=, else the pick shared with the Overview
  const exclude = params.get('exclude') ?? scopeExclude;
  const res = useTriggers({ branch, compare, tests }, !resolving);

  const set = (patch: Record<string, string | null>) =>
    setParams(
      (p) => {
        const n = new URLSearchParams(p);
        for (const [k, v] of Object.entries(patch)) {
          if (v) n.set(k, v);
          else n.delete(k);
        }
        return n;
      },
      { replace: true },
    );

  const data = res.data;
  const modules = useMemo(() => [...new Set((data?.items ?? []).map((r) => r.module).filter((m): m is string => !!m))].sort(), [data]);
  const moduleParam = params.get('module') || null;
  // the folders picked (several joined with commas): a link's own, else the stored pick, keeping those on this branch
  const module = moduleParam ?? (splitFolders(scopeFolder).filter((f) => modules.includes(f)).join(',') || null);
  const moduleSet = useMemo(() => new Set(splitFolders(module)), [module]);
  const missingModules = [...moduleSet].filter((f) => !modules.includes(f));
  /** The triggers the folder, type and search pick: what the tiles count (the status tabs only narrow the list). */
  const scoped = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (data?.items ?? [])
      .filter((r) => !kindSet || kindSet.has(r.kind))
      .filter((r) => moduleSet.size === 0 || (!!r.module && moduleSet.has(r.module)))
      .filter((r) => !excludedBy(r.routeId, exclude))
      .filter((r) => !q || [r.routeId, r.resolvedUri, r.sourceFile, r.filePattern, r.schedule, r.target, r.doneFile].some((v) => v?.toLowerCase().includes(q)));
  }, [data, kindSet, moduleSet, exclude, search]);
  // a saved filter picked: the routes in it that it didn't have when saved
  const presets = useScopePresets().data?.presets;
  const active = activePreset(presets, { folder: module, kinds, exclude });
  const freshQ = useTriggerOverview(undefined, 1, branch ?? null, module, tests ?? null, kinds, exclude, active?.id ?? null);
  const fresh = useMemo(() => new Set(active && freshQ.data?.fresh?.preset === active.id ? freshQ.data.fresh.added : []), [active, freshQ.data]);
  const rows = useMemo(() => {
    return scoped
      .filter((r) =>
        status === 'automated'
          ? automated(r) && r.change !== 'removed'
          : status === 'missing'
            ? !automated(r) && r.change !== 'removed'
            : status === 'changes'
              ? r.change !== 'unchanged' || newlyAutomated(r) || lostTest(r)
              : status === 'new'
                ? !!r.routeId && fresh.has(routeKey(r.module, r.routeId))
                : true,
      )
      .sort((a, b) => (compare ? CHANGE_ORDER[a.change ?? 'unchanged'] - CHANGE_ORDER[b.change ?? 'unchanged'] : 0));
  }, [scoped, status, compare, fresh]);
  const groups = useMemo(() => groupByRoute(rows), [rows]);

  // only trigger repo branches (dev, core…): PR branches of the test repo count inside them
  const branchOptions = routeBranches.map((b) => ({ value: b, label: b === defaultBranch ? `${b} (default)` : b }));
  if (branch && !routeBranches.includes(branch)) branchOptions.push({ value: branch, label: `${branch} · tests only` });
  // the scope button writes the choice shared with the Overview and Report; a link's own branch/folder/tests give way to it
  const changeScope = (p: Partial<Scope>) => {
    if ('branch' in p) setScopeBranch(p.branch ?? null);
    if ('folder' in p) setScopeFolder(p.folder ?? null);
    if ('tests' in p) setScopeTests(p.tests ?? null);
    if ('kinds' in p) setScopeKinds(p.kinds ?? null);
    if ('exclude' in p) setScopeExclude(p.exclude ?? null);
    const nextBranch = 'branch' in p ? (p.branch ?? defaultBranch) : branch;
    set({ branch: null, module: null, tests: null, kind: null, kinds: null, exclude: null, compare: compare && compare !== nextBranch ? compare : null });
  };

  return (
    <FreshContext.Provider value={fresh}>
      <PageHeader
        title="Triggers"
        description="Camel routes started by a load file, a schedule, another route, a queue, Kafka or HTTP, scanned from the repo — the scope to automate, and which of it has tests."
        actions={
          data && data.branches.length > 0 ? (
            <>
              <ScanBranchButton onScanned={(b) => set({ branch: b, compare: b === 'main' ? null : compare ?? (b !== 'main' && branchOptions.some((o) => o.value === 'main') ? 'main' : null) })} />
              <PrScanButton />
              <SheetCompareButton scope={{ branch: branch ?? null, tests: tests ?? null, folder: module, kinds, exclude }} />
              {branch && !DEFAULT_BRANCHES.includes(branch) ? (
                <RemoveBranchButton
                  branch={branch}
                  onRemoved={() => {
                    if (branch === scopeBranch) setScopeBranch(null);
                    set({ branch: null, compare: null });
                  }}
                />
              ) : null}
              <ScopeButton scope={{ branch: branchParam ?? scopeBranch, folder: module, tests: tests ?? null, kinds, exclude }} onChange={changeScope} />
              <Select
                size="sm"
                ariaLabel="Compare with branch"
                value={compare ?? null}
                onValueChange={(v) => set({ compare: v, status: v ? status : status === 'changes' ? null : status })}
                options={branchOptions.filter((o) => o.value !== branch)}
                allowNone
                noneLabel="Compare with…"
                disabled={!branch}
                className="w-48"
              />
            </>
          ) : null
        }
      />

      {res.isError ? (
        <Card>
          <ErrorState error={res.error} onRetry={() => void res.refetch()} />
        </Card>
      ) : res.isPending ? (
        <Card>
          <SkeletonRows rows={8} />
        </Card>
      ) : data && data.branches.length === 0 ? (
        <NoScans onScanned={(b) => set({ branch: b })} />
      ) : data ? (
        <>
          {missingModules.length > 0 ? (
            <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-[color-mix(in_oklab,var(--warn)_40%,transparent)] bg-[color-mix(in_oklab,var(--warn)_8%,var(--surface))] px-3 py-2 text-[13px]">
              <span>
                There is no <span className="font-mono">{missingModules.map((m) => `${m}/`).join(', ')}</span>{' '}
                {missingModules.length === 1 ? 'folder' : 'folders'} on <span className="font-mono">{branch}</span>
                {modules.length ? (
                  <>
                    {' '}
                    (its folders: <span className="font-mono">{modules.slice(0, 6).join(', ')}</span>
                    {modules.length > 6 ? '…' : ''})
                  </>
                ) : null}
                .
              </span>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  set({ module: null });
                  setScopeFolder(null);
                }}
              >
                Show all folders
              </Button>
            </div>
          ) : null}
          <Totals data={data} items={scoped} scope={[module ? `in ${folderLabel(module)}` : null, kinds ? `(${kindsLabel(kinds)})` : null, excludeLabel(exclude), search.trim() ? `matching “${search.trim()}”` : null].filter(Boolean).join(' · ')} />
          <div className="mt-4 mb-3 flex flex-wrap items-center gap-2">
            <div role="tablist" aria-label="Filter triggers" className="flex flex-wrap gap-1.5">
              {STATUS_FILTERS.filter((f) => (!('compareOnly' in f) || compare) && (!('freshOnly' in f) || fresh.size > 0 || status === 'new')).map((f) => (
                <button
                  key={f.key}
                  type="button"
                  role="tab"
                  aria-selected={status === f.key}
                  onClick={() => set({ status: f.key === 'all' ? null : f.key })}
                  className={cn(
                    'inline-flex h-7 items-center gap-1.5 rounded-full border px-3 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
                    status === f.key ? 'border-accent/50 bg-accent-soft font-medium text-fg' : 'border-border bg-surface text-fg-2 hover:bg-surface-2 hover:text-fg',
                  )}
                >
                  {f.label}
                  {f.key === 'new' ? <span className="tabular text-accent">{fresh.size}</span> : null}
                </button>
              ))}
            </div>
            <div className="ml-auto flex flex-wrap gap-1.5">
              <div className="relative">
                <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-fg-3" aria-hidden />
                <Input
                  aria-label="Search triggers"
                  value={search}
                  onChange={(e) => {
                    setSearch(e.target.value);
                    set({ q: e.target.value || null });
                  }}
                  placeholder="Route, folder, pattern…"
                  className="h-7 w-56 pl-7 text-xs"
                />
              </div>
            </div>
          </div>
          <Card className={cn('overflow-hidden', res.isPlaceholderData && 'opacity-70')}>
            {rows.length === 0 ? (
              <EmptyState icon={<Zap />} title="No triggers match these filters" />
            ) : (
              <>
                <TriggerTable groups={groups.slice(0, limit)} showBranches={!branch} compare={compare ?? null} />
                {groups.length > limit ? (
                  <div className="border-t border-border p-2 text-center">
                    <Button size="sm" variant="ghost" onClick={() => setLimit(limit + PAGE * 5)}>
                      Show more ({pluralize(groups.length - limit, 'route')} not shown)
                    </Button>
                  </div>
                ) : null}
              </>
            )}
          </Card>
          {data.divergence ? <Divergence d={data.divergence} branch={data.branch ?? ''} compare={data.compare ?? ''} /> : null}
          <p className="mt-2 text-xs text-fg-3">
            {pluralize(rows.length, 'trigger')} in {pluralize(groups.length, 'route')} shown. A route with several inputs, several file patterns, or a choice on the file name counts each one as its own trigger. A test covers a trigger when one of its Allure labels or pytest markers names the route id, the schedule, the job a file is sent to, a load file the trigger picks up, the direct/seda/queue or Kafka topic name, or the REST path.
          </p>
        </>
      ) : null}
    </FreshContext.Provider>
  );
}

/** `items`: the triggers in scope (folder, type, search), `scope`: how they were picked, for the labels. */
function Totals({ data, items, scope }: { data: TriggerListResponse; items: TriggerRow[]; scope: string }) {
  const live = items.filter((r) => r.change !== 'removed');
  const routes = groupByRoute(live).length;
  const covered = live.filter(automated).length;
  const unmergedOnly = live.filter((r) => r.coveredBy.length > 0 && r.coveredBy.every((c) => c.branch)).length;
  const byKind = KIND_ORDER.map((k) => [k, live.filter((r) => r.kind === k).length] as const).filter(([, n]) => n > 0);
  const runViaCount = live.filter((r) => r.coveredBy.length === 0 && r.runVia?.length).length;
  const scan = data.branch ? data.branches.find((b) => b.branch === data.branch) : null;
  const added = live.filter((r) => r.change === 'added');
  const changed = live.filter((r) => r.change === 'changed');
  const removed = items.filter((r) => r.change === 'removed');
  const fresh = live.filter(newlyAutomated);
  const lost = live.filter(lostTest);
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      <Tile
        label={scope ? `Triggers ${scope}` : 'Triggers'}
        value={
          <>
            {fmtNumber(live.length)}
            {routes !== live.length ? <span className="ml-1.5 text-sm font-medium text-fg-3">in {pluralize(routes, 'route')}</span> : null}
          </>
        }
        sub={byKind.map(([k, n]) => `${fmtNumber(n)} ${KIND_SHORT_SUB[k]}`).join(' · ') || 'none'}
      />
      <Tile
        label="Tested"
        value={
          <>
            {fmtPct(live.length ? covered / live.length : null, 0)}
            {live.length ? <span className="ml-1.5 text-sm font-medium text-fg-3">{fmtNumber(covered)}</span> : null}
          </>
        }
        sub={
          unmergedOnly > 0
            ? `${fmtNumber(covered - unmergedOnly)} merged · ${fmtNumber(unmergedOnly)} only in PRs into ${data.testsFrom ?? data.branch}`
            : 'have one or more tests'
        }
      />
      <Tile
        label="No test yet"
        value={fmtNumber(live.length - covered)}
        sub={
          live.length === 0
            ? 'no triggers here'
            : live.length - covered > 0
              ? runViaCount > 0
                ? `no test names them · ${fmtNumber(runViaCount)} run via a tested route`
                : 'no merged test or PR names them'
              : 'every trigger covered'
        }
        tone={live.length === 0 ? undefined : live.length - covered > 0 ? 'bad' : 'good'}
      />
      {data.compare ? (
        <Tile
          label={`vs ${data.compare}`}
          value={
            <span className="text-[20px]">
              +{added.length} <span className="text-fg-3">·</span> ~{changed.length} <span className="text-fg-3">·</span> −{removed.length}
            </span>
          }
          sub={`${pluralize(fresh.length, 'trigger')} newly automated${lost.length ? ` · ${lost.length} lost ${lost.length === 1 ? 'its test' : 'their tests'}` : ''}`}
          tone={fresh.length > 0 ? 'good' : undefined}
        />
      ) : scan ? (
        <Tile
          label="Last scan"
          value={<span className="text-[20px]">{fmtRelative(scan.scannedAt)}</span>}
          sub={[scan.commit?.slice(0, 10), scan.label, `${pluralize(scan.testsFound, 'test')} read`].filter(Boolean).join(' · ')}
        />
      ) : (
        <Tile label="Branches" value={fmtNumber(data.branches.length)} sub={`scope across ${pluralize(data.branches.length, 'branch', 'branches')}`} />
      )}
    </div>
  );
}

function Tile({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: 'good' | 'bad' }) {
  return (
    <div className="rounded-lg border border-border bg-surface px-4 py-3.5 shadow-sm">
      <div className="truncate text-xs font-medium text-fg-2">{label}</div>
      <div className="mt-1.5 text-[26px] leading-none font-semibold tracking-tight text-fg">{value}</div>
      {sub ? <div className={cn('mt-2 truncate text-xs', tone === 'bad' ? 'text-bad' : tone === 'good' ? 'text-good' : 'text-fg-3')}>{sub}</div> : null}
    </div>
  );
}

/** The triggers of one route (each file pattern, input or file-name branch is its own trigger), in list order. */
interface RouteGroup {
  key: string;
  rows: TriggerRow[];
}

/** One group per route: a route with several patterns shows as one row that expands. */
function groupByRoute(rows: TriggerRow[]): RouteGroup[] {
  const groups = new Map<string, RouteGroup>();
  for (const r of rows) {
    const key = `${r.module ?? ''}\0${r.routeId ?? `${r.sourceFile}:${r.line}`}`;
    const g = groups.get(key);
    if (g) g.rows.push(r);
    else groups.set(key, { key, rows: [r] });
  }
  return [...groups.values()];
}

function TriggerTable({ groups, showBranches, compare }: { groups: RouteGroup[]; showBranches: boolean; compare: string | null }) {
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const toggle = (key: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const multi = groups.filter((g) => g.rows.length > 1);
  const allOpen = multi.length > 0 && multi.every((g) => open.has(g.key));
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[860px] text-left text-[13px]">
        <thead>
          <tr className="border-b border-border text-xs text-fg-2">
            <th className="px-4 py-2 font-medium">
              Route
              {multi.length > 0 ? (
                <button
                  type="button"
                  onClick={() => setOpen(allOpen ? new Set() : new Set(multi.map((g) => g.key)))}
                  className="link ml-2 text-[11px] font-normal text-fg-3"
                >
                  {allOpen ? 'collapse all' : 'expand all'}
                </button>
              ) : null}
            </th>
            <th className="px-2 py-2 font-medium">Trigger</th>
            <th className="px-2 py-2 font-medium">Tests</th>
            {showBranches ? <th className="px-2 py-2 font-medium">Branches</th> : null}
            {compare ? <th className="px-2 py-2 pr-4 font-medium">vs {compare}</th> : null}
          </tr>
        </thead>
        <tbody>
          {groups.map((g) =>
            g.rows.length === 1 ? (
              <TriggerLine key={g.key} r={g.rows[0]!} showBranches={showBranches} compare={compare} />
            ) : (
              <RouteGroupRows key={g.key} g={g} open={open.has(g.key)} onToggle={() => toggle(g.key)} showBranches={showBranches} compare={compare} />
            ),
          )}
        </tbody>
      </table>
    </div>
  );
}

function RouteCell({ r, extra }: { r: TriggerRow; extra?: ReactNode }) {
  const fresh = useContext(FreshContext);
  return (
    <>
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="truncate font-medium text-fg">{r.routeId ?? <span className="text-fg-3 italic">no route id</span>}</span>
        {r.routeId && fresh.has(routeKey(r.module, r.routeId)) ? (
          <span className="shrink-0 rounded-full border border-accent/50 bg-accent-soft px-1.5 py-px text-[10.5px] font-medium text-accent" title="Not in the saved filter when it was saved (or last marked as seen)">
            New
          </span>
        ) : null}
        {extra}
      </div>
      <div className="truncate font-mono text-[11px] text-fg-3" title={`${r.sourceFile}:${r.line}`}>
        {r.module ? <span className="font-sans text-fg-2">{r.module} · </span> : null}
        {r.sourceFile.split('/').pop()}:{r.line}
        {r.input > 1 ? <span className="ml-1.5 font-sans">· input {r.input}</span> : null}
      </div>
    </>
  );
}

function TriggerLine({ r, showBranches, compare, nested }: { r: TriggerRow; showBranches: boolean; compare: string | null; nested?: boolean }) {
  return (
    <tr className={cn('border-b border-border align-top last:border-0 hover:bg-surface-2/50', r.change === 'removed' && 'opacity-60', nested && 'bg-surface-2/40')}>
      <td className={cn('max-w-[260px] py-2.5', nested ? 'pr-4 pl-10' : 'px-4')}>
        {nested ? <div className="truncate font-mono text-[11px] text-fg-3">{r.filePattern ?? r.schedule ?? `input ${r.input}`}</div> : <RouteCell r={r} />}
      </td>
      <td className="max-w-[360px] px-2 py-2.5">
        <TriggerSpec r={r} />
      </td>
      <td className="max-w-[300px] px-2 py-2.5">
        <Coverage r={r} />
      </td>
      {showBranches ? (
        <td className="max-w-[200px] px-2 py-2.5">
          <div className="flex flex-wrap gap-1">
            {r.branches.map((b) => (
              <Chip key={b} className="font-mono">
                {b}
              </Chip>
            ))}
          </div>
        </td>
      ) : null}
      {compare ? (
        <td className="px-2 py-2.5 pr-4 whitespace-nowrap">
          {r.change ? <span className={cn('inline-flex rounded-full border px-2 py-px text-[11px] font-medium', CHANGE_META[r.change].cls)}>{CHANGE_META[r.change].label}</span> : null}
          {newlyAutomated(r) ? <div className="mt-1 text-[11px] text-st-passed">newly automated</div> : null}
          {lostTest(r) ? <div className="mt-1 text-[11px] text-st-failed">lost its test</div> : null}
        </td>
      ) : null}
    </tr>
  );
}

/** A route with several triggers: one summary row (patterns, how many are tested), the triggers below when expanded. */
function RouteGroupRows({
  g,
  open,
  onToggle,
  showBranches,
  compare,
}: {
  g: RouteGroup;
  open: boolean;
  onToggle: () => void;
  showBranches: boolean;
  compare: string | null;
}) {
  const first = g.rows[0]!;
  const live = g.rows.filter((r) => r.change !== 'removed');
  const tested = live.filter(automated).length;
  const unmergedOnly = live.filter((r) => r.coveredBy.length > 0 && r.coveredBy.every((c) => c.branch)).length;
  const specs = g.rows.map((r) => r.filePattern ?? r.schedule ?? r.resolvedUri.split('?')[0] ?? '');
  const dirs = [...new Set(g.rows.map((r) => r.directory).filter(Boolean))];
  const unresolved = g.rows.find((r) => r.unresolved.length > 0);
  const changes = compare
    ? Object.entries(g.rows.reduce<Record<string, number>>((m, r) => (r.change && r.change !== 'unchanged' ? { ...m, [r.change]: (m[r.change] ?? 0) + 1 } : m), {}))
    : [];
  const branches = [...new Set(g.rows.flatMap((r) => r.branches))];
  return (
    <>
      <tr className="cursor-pointer border-b border-border align-top last:border-0 hover:bg-surface-2/50" onClick={onToggle}>
        <td className="max-w-[260px] px-4 py-2.5">
          <RouteCell
            r={first}
            extra={
              <button
                type="button"
                aria-expanded={open}
                aria-label={`${open ? 'Hide' : 'Show'} the ${g.rows.length} triggers of ${first.routeId ?? 'this route'}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onToggle();
                }}
                className="inline-flex shrink-0 items-center gap-1 rounded-full border border-border px-1.5 py-px text-[11px] text-fg-2 outline-none hover:bg-surface-3 focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                <ChevronRight className={cn('size-3 transition-transform', open && 'rotate-90')} aria-hidden />
                {g.rows.length} triggers
              </button>
            }
          />
        </td>
        <td className="max-w-[360px] px-2 py-2.5">
          <div className="flex flex-wrap gap-1">
            {specs.slice(0, 4).map((x, i) => (
              <span key={i} className="max-w-[160px] truncate rounded border border-border bg-surface-2 px-1.5 font-mono text-[11px] text-fg" title={x}>
                {x}
              </span>
            ))}
            {specs.length > 4 ? <span className="text-[11px] text-fg-3">+{specs.length - 4} more</span> : null}
          </div>
          {dirs.length === 1 ? (
            <div className="mt-0.5 truncate font-mono text-[11px] text-fg-3" title={dirs[0] ?? undefined}>
              {first.scheme !== 'file' ? `${first.scheme}: ` : ''}
              {dirs[0]}
            </div>
          ) : null}
          {unresolved ? (
            <span className="mt-0.5 inline-flex items-center gap-1 text-[11px] text-warn">
              <TriangleAlert className="size-3" aria-hidden /> {unresolved.unresolved.some((u) => u.values.length === 0) ? 'missing property' : 'differs per environment'}
            </span>
          ) : null}
        </td>
        <td className="max-w-[300px] px-2 py-2.5">
          {tested === 0 ? (
            <>
              <span className="inline-flex items-center gap-1.5 text-xs text-fg-3">
                <CircleDashed className="size-3.5" aria-hidden /> No test yet (0 of {live.length})
              </span>
              <RunVia via={live.find((r) => r.runVia?.length)?.runVia} />
            </>
          ) : (
            <span className={cn('inline-flex items-center gap-1.5 text-xs font-medium', tested === live.length ? 'text-st-passed' : 'text-fg')}>
              {tested === live.length ? <CircleCheck className="size-3.5" aria-hidden /> : <CircleDashed className="size-3.5" aria-hidden />}
              {tested} of {live.length} tested
              {unmergedOnly > 0 ? <span className="font-normal text-fg-3">· {unmergedOnly} not merged</span> : null}
            </span>
          )}
        </td>
        {showBranches ? (
          <td className="max-w-[200px] px-2 py-2.5">
            <div className="flex flex-wrap gap-1">
              {branches.map((b) => (
                <Chip key={b} className="font-mono">
                  {b}
                </Chip>
              ))}
            </div>
          </td>
        ) : null}
        {compare ? (
          <td className="px-2 py-2.5 pr-4 text-[11px] whitespace-nowrap text-fg-2">
            {changes.length ? changes.map(([c, n]) => `${n} ${CHANGE_META[c as TriggerChange].label.toLowerCase()}`).join(' · ') : null}
          </td>
        ) : null}
      </tr>
      {open ? g.rows.map((r) => <TriggerLine key={`${r.key}-${r.change ?? ''}`} r={r} showBranches={showBranches} compare={compare} nested />) : null}
    </>
  );
}

const KIND_ORDER: TriggerKind[] = ['file', 'schedule', 'direct', 'queue', 'kafka', 'rest', 'property'];
const KIND_SHORT_SUB: Record<TriggerKind, string> = { file: 'load file', schedule: 'schedule', direct: 'direct', queue: 'queue', kafka: 'kafka', rest: 'REST', property: 'property-only' };
const KIND_ICON: Record<TriggerKind, typeof Clock> = { file: FileInput, schedule: Clock, direct: CornerDownRight, queue: Inbox, kafka: Radio, rest: Globe, property: Braces };

function TriggerSpec({ r }: { r: TriggerRow }) {
  const Icon = KIND_ICON[r.kind] ?? Zap;
  const kindLabel = TRIGGER_KIND_LABEL[r.kind] ?? r.kind;
  return (
    <div className="flex min-w-0 gap-2">
      <Tooltip content={`${kindLabel} (${r.scheme})`}>
        <Icon className="mt-0.5 size-3.5 shrink-0 text-fg-3" aria-label={kindLabel} />
      </Tooltip>
      <div className="min-w-0">
        {r.kind === 'file' ? (
          <>
            <div className="truncate font-mono text-xs text-fg" title={r.condition ?? r.filePattern ?? undefined}>
              {r.filePattern ?? <span className="text-fg-3">any file</span>}
            </div>
            <div className="truncate font-mono text-[11px] text-fg-3" title={r.directory ?? undefined}>
              {r.scheme !== 'file' ? `${r.scheme}: ` : ''}
              {r.directory}
            </div>
            {r.doneFile ? (
              <div className="truncate text-[11px] text-fg-2" title="Camel doneFileName: the data file is picked up once this trigger file exists">
                trigger file <span className="font-mono text-fg">{r.doneFile}</span>
              </div>
            ) : null}
            {r.target ? (
              <div className="truncate text-[11px] text-fg-2" title={r.condition ? `when ${r.condition}` : undefined}>
                → <span className="font-mono">{r.target}</span>
              </div>
            ) : null}
          </>
        ) : (
          <>
            <div className="truncate font-mono text-xs text-fg" title={r.kind === 'schedule' ? undefined : r.resolvedUri}>
              {r.kind === 'schedule' ? (r.schedule ?? <span className="text-fg-3">no schedule found</span>) : r.resolvedUri.split('?')[0]}
            </div>
            {r.kind === 'schedule' ? (
              <div className="truncate font-mono text-[11px] text-fg-3" title={r.resolvedUri}>
                {r.resolvedUri.split('?')[0]}
              </div>
            ) : (
              <div className="truncate text-[11px] text-fg-3">{r.kind === 'property' ? 'the URI comes only from a property' : TRIGGER_KIND_LABEL[r.kind]}</div>
            )}
          </>
        )}
        {r.unresolved.length > 0 ? (
          <Tooltip
            content={
              <div className="space-y-1 text-xs">
                {r.unresolved.map((u) => (
                  <div key={u.key}>
                    <span className="font-mono">{u.key}</span>:{' '}
                    {u.values.length === 0 ? 'not defined in any .properties file' : u.values.map((v) => `${v.value} (${v.file.split('/').pop()})`).join(', ')}
                  </div>
                ))}
              </div>
            }
          >
            <span className="mt-0.5 inline-flex items-center gap-1 text-[11px] text-warn">
              <TriangleAlert className="size-3" aria-hidden /> {r.unresolved.some((u) => u.values.length === 0) ? 'missing property' : 'differs per environment'}
            </span>
          </Tooltip>
        ) : null}
      </div>
    </div>
  );
}

/** "run via invoice-load → parse-invoice": a tested route hands this one work, though no test names it. */
function RunVia({ via }: { via: string[] | null | undefined }) {
  if (!via?.length) return null;
  return (
    <Tooltip content="No test names this route, but a tested route sends it work, so it runs when that test runs. It still counts as not tested.">
      <div className="mt-0.5 truncate text-[11px] text-fg-2">
        run via <span className="font-mono">{via.join(' → ')}</span>
      </div>
    </Tooltip>
  );
}

function Coverage({ r }: { r: TriggerRow }) {
  if (r.coveredBy.length === 0) {
    return (
      <div className="min-w-0">
        <span className="inline-flex items-center gap-1.5 text-xs text-fg-3">
          <CircleDashed className="size-3.5" aria-hidden /> No test yet
        </span>
        <RunVia via={r.runVia} />
      </div>
    );
  }
  const onlyUnmerged = r.coveredBy.every((c) => c.branch);
  return (
    <div className="min-w-0">
      <span className={cn('inline-flex items-center gap-1.5 text-xs font-medium', onlyUnmerged ? 'text-fg' : 'text-st-passed')}>
        {onlyUnmerged ? <CircleDashed className="size-3.5" aria-hidden /> : <CircleCheck className="size-3.5" aria-hidden />}{' '}
        {onlyUnmerged ? `${pluralize(r.coveredBy.length, 'test')}, not merged yet` : pluralize(r.coveredBy.length, 'test')}
      </span>
      <ul className="mt-0.5 space-y-0.5">
        {r.coveredBy.slice(0, 3).map((c) => {
          const name = c.test.split('::').pop();
          return (
            <li key={c.test} className="truncate text-[11px] text-fg-2" title={`${c.test} — via "${c.via}"${c.branch ? ` — on ${c.branch}, not merged yet` : ''}`}>
              {c.testCaseId ? (
                <Link to={`/tests/${c.testCaseId}`} className="font-mono hover:underline">
                  {name}
                </Link>
              ) : (
                <span className="font-mono">{name}</span>
              )}
              {c.branch ? <span className="text-fg-3"> · {c.branch}</span> : null}
            </li>
          );
        })}
        {r.coveredBy.length > 3 ? <li className="text-[11px] text-fg-3">+{r.coveredBy.length - 3} more</li> : null}
      </ul>
    </div>
  );
}

function NoScans({ onScanned }: { onScanned: (branch: string) => void }) {
  const origin = typeof window !== 'undefined' ? window.location.origin : 'https://dashboard.example.com';
  const snippet = `# Use the upload-only INGEST token.
# Camel repo, on its long-lived branches (main, core, dev…): route XML and properties
git ls-files '*.xml' '*.properties' | zip -q -@ scan.zip
curl -fsS -X POST "${origin}/api/triggers/scan" -H "Authorization: Bearer $PTD_INGEST_TOKEN" \\
  --form-string "branch=$GIT_BRANCH" --form-string "commit=$GIT_COMMIT" --form-string "only=routes" \\
  -F "file=@scan.zip;type=application/zip"

# Test repo, on its long-lived branches and on every PR: all Python files (constants,
# conftest.py and helpers count too). On a PR, the label says which branch it merges into;
# without it a PR branch's tests don't count anywhere.
git ls-files '*.py' | zip -q -@ scan.zip
LABEL=\${PR_NUMBER:+"$REPO PR #$PR_NUMBER → $PR_BASE_BRANCH"}
curl -fsS -X POST "${origin}/api/triggers/scan" -H "Authorization: Bearer $PTD_INGEST_TOKEN" \\
  --form-string "branch=$GIT_BRANCH" --form-string "commit=$GIT_COMMIT" --form-string "only=tests" \\
  \${LABEL:+--form-string "label=$LABEL"} -F "file=@scan.zip;type=application/zip"`;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(snippet);
      toast.success('Copied to clipboard');
    } catch {
      toast.error('Copy failed — select the text and copy manually.');
    }
  };
  return (
    <Card>
      <EmptyState icon={<GitCompareArrows />} title="No trigger scans yet" actions={<ScanBranchButton onScanned={onScanned} variant="primary" />}>
        Scan the repo with the Camel routes from CI. Each branch’s latest scan is its scope; compare a PR branch with main to see which triggers it adds and automates.
      </EmptyState>
      <CardHeader
        title="Scan from CI"
        icon={<Terminal className="size-4 text-fg-3" aria-hidden />}
        actions={
          <Button size="sm" variant="outline" onClick={() => void copy()}>
            <Copy /> Copy
          </Button>
        }
      />
      <CardBody>
        <pre className="overflow-x-auto rounded-lg border border-border bg-surface-2/60 p-3 font-mono text-xs leading-relaxed text-fg">{snippet}</pre>
      </CardBody>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Scan a branch from GitHub
// ---------------------------------------------------------------------------

const ROLE_KEY = 'ptd.triggers.repoRole';
function rememberedRole(repo: string): 'routes' | 'tests' {
  try {
    const all = JSON.parse(localStorage.getItem(ROLE_KEY) ?? '{}') as Record<string, 'routes' | 'tests'>;
    return all[repo] ?? (/test/i.test(repo) ? 'tests' : 'routes');
  } catch {
    return /test/i.test(repo) ? 'tests' : 'routes';
  }
}
function rememberRole(repo: string, role: 'routes' | 'tests') {
  try {
    const all = JSON.parse(localStorage.getItem(ROLE_KEY) ?? '{}') as Record<string, string>;
    localStorage.setItem(ROLE_KEY, JSON.stringify({ ...all, [repo]: role }));
  } catch {
    // per-browser convenience only
  }
}

const DEFAULT_BRANCHES = ['main', 'master', 'develop'];

/** Abandoned or merged PR branches: their tests stop counting towards "triggers tested" once removed. */
function RemoveBranchButton({ branch, onRemoved }: { branch: string; onRemoved: () => void }) {
  const [open, setOpen] = useState(false);
  const del = useDeleteTriggerBranch();
  return (
    <>
      <Tooltip content="Remove this branch's scans" side="bottom">
        <Button size="icon" variant="ghost" aria-label={`Remove the scans of ${branch}`} onClick={() => setOpen(true)}>
          <Trash2 />
        </Button>
      </Tooltip>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={`Remove the scans of ${branch}?`}
        description={
          <>
            Its routes and tests stop counting. Use this when the branch was abandoned, or merged and <span className="font-mono">main</span> has been
            scanned since. Scanning the branch again brings it back.
          </>
        }
        confirmLabel="Remove"
        loading={del.isPending}
        onConfirm={() =>
          del.mutate(branch, {
            onSuccess: () => {
              setOpen(false);
              toast.success(`Removed the scans of ${branch}`);
              onRemoved();
            },
            onError: (e) => toast.error(errorMessage(e)),
          })
        }
      />
    </>
  );
}

function ScanBranchButton({ onScanned, variant = 'outline' }: { onScanned: (branch: string) => void; variant?: 'outline' | 'primary' }) {
  const gh = useTriggerGithub();
  const [open, setOpen] = useState(false);
  if (!gh.data?.configured) return null;
  return (
    <>
      <Button size="sm" variant={variant} onClick={() => setOpen(true)}>
        <GitBranch /> Scan a branch
      </Button>
      {open ? <ScanBranchDialog repos={gh.data.repos} onClose={() => setOpen(false)} onScanned={onScanned} /> : null}
    </>
  );
}

function ScanBranchDialog({ repos, onClose, onScanned }: { repos: string[]; onClose: () => void; onScanned: (branch: string) => void }) {
  const id = useId();
  const [repo, setRepo] = useState(repos[0] ?? '');
  const [role, setRole] = useState<'routes' | 'tests'>(() => rememberedRole(repos[0] ?? ''));
  const [branch, setBranch] = useState('main');
  const branches = useTriggerBranches(repo || null);
  const scan = useScanGithubBranch();
  const submit = async () => {
    try {
      const res = await scan.mutateAsync({ repo, branch: branch.trim(), only: role });
      rememberRole(repo, role);
      toast.success(`Scanned ${repo} @ ${res.branch}`, {
        description:
          role === 'routes'
            ? `${pluralize(res.total, 'trigger')} found`
            : `${pluralize(res.testsFound, 'test')} read${res.cases ? ` · ${res.cases.newlyAutomated} cases newly automated` : ''}`,
      });
      onScanned(res.branch);
      onClose();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => (o ? undefined : onClose())}
      title="Scan a branch"
      description="Downloads the branch from GitHub and reads its Camel routes or its tests. Branches differ, so scan each one you want to see or compare."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={scan.isPending}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void submit()} loading={scan.isPending} disabled={!repo || !branch.trim()}>
            <GitBranch /> Scan
          </Button>
        </div>
      }
    >
      <div className="space-y-3 p-5">
        <Field label="Repository" htmlFor={`${id}-repo`}>
          <Select
            id={`${id}-repo`}
            value={repo}
            onValueChange={(v) => {
              if (!v) return;
              setRepo(v);
              setRole(rememberedRole(v));
            }}
            options={repos.map((r) => ({ value: r, label: r }))}
            className="w-full"
          />
        </Field>
        <Field label="It holds" htmlFor={`${id}-role`} hint="Route copies kept as test data in the test repo are ignored">
          <Select
            id={`${id}-role`}
            value={role}
            onValueChange={(v) => v && setRole(v)}
            options={[
              { value: 'routes', label: 'Camel routes (scope)' },
              { value: 'tests', label: 'pytest tests (coverage)' },
            ]}
            className="w-full"
          />
        </Field>
        <Field label="Branch" htmlFor={`${id}-branch`} hint={branches.isError ? 'Could not list branches — type the name' : undefined}>
          <Input id={`${id}-branch`} list={`${id}-branches`} value={branch} onChange={(e) => setBranch(e.target.value)} className="font-mono" placeholder="main" />
          <datalist id={`${id}-branches`}>
            {(branches.data?.branches ?? []).map((b) => (
              <option key={b} value={b} />
            ))}
          </datalist>
        </Field>
        {scan.isPending ? <p className="text-xs text-fg-2">Downloading and scanning — a large repo can take a minute…</p> : null}
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// What the two branches' tests disagree on
// ---------------------------------------------------------------------------

function Divergence({ d, branch, compare }: { d: NonNullable<TriggerListResponse['divergence']>; branch: string; compare: string }) {
  const empty = d.testsMissingHereCount + d.testsOnlyHereCount + d.keysMissingHere.length + d.keysOnlyHere.length === 0;
  const keyList = (keys: typeof d.keysMissingHere) =>
    keys.length === 0 ? (
      <p className="text-xs text-fg-3">none</p>
    ) : (
      <ul className="space-y-0.5">
        {keys.map((k) => (
          <li key={k.key} className="truncate text-xs">
            {k.testCaseId ? (
              <Link to={`/tests/${k.testCaseId}`} className="font-mono text-fg hover:underline">
                {k.key}
              </Link>
            ) : (
              <span className="font-mono text-fg">{k.key}</span>
            )}
            {k.title ? <span className="text-fg-2"> — {k.title}</span> : null}
          </li>
        ))}
      </ul>
    );
  const testList = (tests: string[], count: number) =>
    count === 0 ? (
      <p className="text-xs text-fg-3">none</p>
    ) : (
      <ul className="max-h-48 space-y-0.5 overflow-auto">
        {tests.map((t) => (
          <li key={t} className="truncate font-mono text-[11px] text-fg-2" title={t}>
            {t}
          </li>
        ))}
        {count > tests.length ? <li className="text-[11px] text-fg-3">+{count - tests.length} more</li> : null}
      </ul>
    );
  return (
    <Card className="mt-4">
      <CardHeader
        title={`Tests on ${branch} vs ${compare}`}
        icon={<GitCompareArrows className="size-4 text-fg-3" aria-hidden />}
        description={empty ? 'Both branches have the same tests and Xray keys.' : 'Tests and the Xray cases they name that exist on one branch and not the other.'}
      />
      {empty ? null : (
        <CardBody className="grid gap-4 md:grid-cols-2">
          <div>
            <h3 className="mb-1 text-xs font-semibold text-st-failed">
              On {compare}, missing on {branch}
            </h3>
            <p className="mb-1 text-[11px] text-fg-3">{pluralize(d.keysMissingHere.length, 'Xray case')}</p>
            {keyList(d.keysMissingHere)}
            <p className="mt-2 mb-1 text-[11px] text-fg-3">{pluralize(d.testsMissingHereCount, 'test')}</p>
            {testList(d.testsMissingHere, d.testsMissingHereCount)}
          </div>
          <div>
            <h3 className="mb-1 text-xs font-semibold text-st-passed">Only on {branch}</h3>
            <p className="mb-1 text-[11px] text-fg-3">{pluralize(d.keysOnlyHere.length, 'Xray case')}</p>
            {keyList(d.keysOnlyHere)}
            <p className="mt-2 mb-1 text-[11px] text-fg-3">{pluralize(d.testsOnlyHereCount, 'test')}</p>
            {testList(d.testsOnlyHere, d.testsOnlyHereCount)}
          </div>
        </CardBody>
      )}
    </Card>
  );
}
