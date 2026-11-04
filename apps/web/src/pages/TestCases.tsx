import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import {
  ArrowDown,
  ArrowUp,
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
  Download,
  FileSpreadsheet,
  FunnelX,
  GitPullRequest,
  ListChecks,
  MessageSquare,
  MessageSquarePlus,
  Plus,
  Search,
  Shuffle,
  Upload,
  X,
} from 'lucide-react';
import {
  AutomationStatus,
  LIMITS,
  Priority,
  ResultStatus,
  TestCaseQuery,
  type TestCase,
} from '@ptd/shared';
import { useBulkUpdate, useMeta, useSetAutomationStatus, useTestCases, type TestCaseQueryInput } from '../api/hooks';
import { toQueryString } from '../lib/url';
import { useDebounced } from '../lib/useDebounced';
import { cn, fmtNumber, fmtRelative, pluralize } from '../lib/utils';
import { Button } from '../components/ui/button';
import { Card } from '../components/ui/card';
import { Checkbox } from '../components/ui/checkbox';
import { Dialog } from '../components/ui/dialog';
import { EmptyState, ErrorState } from '../components/ui/empty-state';
import { Field, Input } from '../components/ui/input';
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuSub, MenuSubContent, MenuSubTrigger, MenuTrigger } from '../components/ui/dropdown';
import { PageHeader } from '../components/ui/misc';
import { Select } from '../components/ui/select';
import { SkeletonRows } from '../components/ui/skeleton';
import { linkButton } from '../components/ui/link-button';
import { AUTOMATION_META, FlakyMeter, InPrBadge, RESULT_META, ResultBadge, TriageBadge } from '../components/status';
import { AUTOMATION_OPTIONS, NewTestCaseDialog, PRIORITY_OPTIONS } from '../components/TestCaseForm';
import { BulkNoteDialog, TRIAGE_OPTIONS } from '../components/NoteForm';
import { BugBadge } from '../components/bugs';
import * as S from '@radix-ui/react-select';

type Sort = TestCaseQuery['sort'];

const FILTER_KEYS = ['search', 'suite', 'automationStatus', 'priority', 'lastStatus', 'triage', 'owner', 'flakyOnly', 'inOpenPr', 'source'] as const;
const SOURCES = ['manual', 'spreadsheet', 'allure', 'jira'] as const;
const SOURCE_LABEL: Record<(typeof SOURCES)[number], string> = {
  manual: 'Manual',
  spreadsheet: 'Spreadsheet',
  allure: 'Allure import',
  jira: 'Jira sync',
};

function useCaseQuery() {
  const [params, setParams] = useSearchParams();
  const query: TestCaseQueryInput = useMemo(() => {
    // Parse via the shared schema so invalid URL values fall back to defaults instead of erroring.
    const raw = Object.fromEntries(params.entries());
    const r = TestCaseQuery.safeParse(raw);
    if (r.success) return { ...r.data, flakyOnly: r.data.flakyOnly || undefined, inOpenPr: r.data.inOpenPr || undefined };
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) {
      const one = TestCaseQuery.safeParse({ [k]: v });
      if (one.success) clean[k] = v;
    }
    return TestCaseQuery.parse(clean);
  }, [params]);

  const update = (patch: Record<string, string | number | boolean | null | undefined>, resetPage = true) => {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        for (const [k, v] of Object.entries(patch)) {
          if (v === null || v === undefined || v === '' || v === false) next.delete(k);
          else next.set(k, String(v));
        }
        if (resetPage && !('page' in patch)) next.delete('page');
        return next;
      },
      { replace: true },
    );
  };
  const clear = () =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        FILTER_KEYS.forEach((k) => next.delete(k));
        next.delete('page');
        return next;
      },
      { replace: true },
    );
  const activeFilters = FILTER_KEYS.filter((k) => params.get(k));
  return { query, update, clear, activeFilters };
}

export default function TestCasesPage() {
  const { query, update, clear, activeFilters } = useCaseQuery();
  const list = useTestCases(query);
  const meta = useMeta();
  const navigate = useNavigate();
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [newOpen, setNewOpen] = useState(false);
  const [bulkNoteOpen, setBulkNoteOpen] = useState(false);
  const [textDialog, setTextDialog] = useState<null | 'owner' | 'suite'>(null);

  const [search, setSearch] = useState(query.search ?? '');
  const debounced = useDebounced(search, 300);
  useEffect(() => {
    if ((query.search ?? '') !== debounced.trim()) update({ search: debounced.trim() || null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);

  const items = list.data?.items ?? [];
  const total = list.data?.total ?? 0;
  const page = query.page ?? 1;
  const pageSize = query.pageSize ?? 50;
  const pages = Math.max(1, Math.ceil(total / pageSize));

  const allOnPage = items.length > 0 && items.every((t) => selected.has(t.id));
  const someOnPage = items.some((t) => selected.has(t.id));
  const toggleAll = (c: boolean) =>
    setSelected((prev) => {
      const n = new Set(prev);
      items.forEach((t) => (c ? n.add(t.id) : n.delete(t.id)));
      return n;
    });
  const toggle = (id: number, c: boolean) =>
    setSelected((prev) => {
      const n = new Set(prev);
      if (c) n.add(id);
      else n.delete(id);
      return n;
    });

  const sortBy = (s: Sort) => {
    if (query.sort === s) update({ order: query.order === 'asc' ? 'desc' : 'asc' }, false);
    else update({ sort: s, order: s === 'flakiness' || s === 'updatedAt' || s === 'lastRun' ? 'desc' : 'asc' }, false);
  };

  const exportHref = `/api/test-cases/export.csv${toQueryString({ ...query, page: undefined, pageSize: undefined })}`;
  const noData = !list.isPending && total === 0 && activeFilters.length === 0;

  return (
    <>
      <PageHeader
        title="Test cases"
        description={list.data ? `${fmtNumber(total)} ${activeFilters.length ? 'matching' : 'total'}` : 'Inventory of all test cases'}
        actions={
          <>
            <a href={exportHref} className={linkButton('outline')} download>
              <Download /> Export CSV
            </a>
            <Button variant="primary" onClick={() => setNewOpen(true)}>
              <Plus /> New test case
            </Button>
          </>
        }
      />

      {/* Filters: one row above the content they scope */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-64">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-fg-3" aria-hidden />
          <Input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search key, title, suite, owner, tag…"
            aria-label="Search test cases"
            className="pl-8"
            maxLength={200}
          />
        </div>
        <Select
          ariaLabel="Automation status"
          value={query.automationStatus ?? null}
          onValueChange={(v) => update({ automationStatus: v })}
          options={AUTOMATION_OPTIONS}
          allowNone
          noneLabel="Any status"
        />
        <Select
          ariaLabel="Last result"
          value={query.lastStatus ?? null}
          onValueChange={(v) => update({ lastStatus: v })}
          options={ResultStatus.options.map((s) => {
            const M = RESULT_META[s];
            return { value: s, label: M.label, text: `Last: ${M.label}`, icon: <M.icon className="size-3.5" style={{ color: M.color }} aria-hidden /> };
          })}
          allowNone
          noneLabel="Any result"
        />
        <Select
          ariaLabel="Suite"
          value={query.suite ?? null}
          onValueChange={(v) => update({ suite: v })}
          options={(meta.data?.suites ?? []).map((s) => ({ value: s, label: s }))}
          allowNone
          noneLabel="All suites"
          className="max-w-48"
        />
        <Select
          ariaLabel="Triage"
          value={query.triage ?? null}
          onValueChange={(v) => update({ triage: v })}
          options={TRIAGE_OPTIONS}
          allowNone
          noneLabel="Any triage"
        />
        <Select ariaLabel="Priority" value={query.priority ?? null} onValueChange={(v) => update({ priority: v })} options={PRIORITY_OPTIONS} allowNone noneLabel="Any priority" />
        <Select
          ariaLabel="Owner"
          value={query.owner ?? null}
          onValueChange={(v) => update({ owner: v })}
          options={(meta.data?.owners ?? []).map((s) => ({ value: s, label: s }))}
          allowNone
          noneLabel="Any owner"
          className="max-w-44"
        />
        <Select
          ariaLabel="Source"
          value={query.source ?? null}
          onValueChange={(v) => update({ source: v })}
          options={SOURCES.map((s) => ({ value: s, label: SOURCE_LABEL[s] }))}
          allowNone
          noneLabel="Any source"
        />
        <ToggleChip active={!!query.inOpenPr} onClick={() => update({ inOpenPr: !query.inOpenPr })} icon={<GitPullRequest />}>
          In PR
        </ToggleChip>
        <ToggleChip active={!!query.flakyOnly} onClick={() => update({ flakyOnly: !query.flakyOnly })} icon={<Shuffle />}>
          Flaky
        </ToggleChip>
        {activeFilters.length > 0 ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setSearch('');
              clear();
            }}
          >
            <FunnelX /> Clear
          </Button>
        ) : null}
      </div>

      {selected.size > 0 ? (
        <BulkBar
          count={selected.size}
          ids={[...selected]}
          onClear={() => setSelected(new Set())}
          onNote={() => setBulkNoteOpen(true)}
          onText={setTextDialog}
        />
      ) : null}

      <Card className={cn('overflow-hidden', list.isPlaceholderData && 'opacity-70 transition-opacity')}>
        {list.isError ? (
          <ErrorState error={list.error} onRetry={() => void list.refetch()} />
        ) : list.isPending ? (
          <SkeletonRows rows={10} />
        ) : noData ? (
          <EmptyState
            icon={<ListChecks />}
            title="No test cases yet"
            actions={
              <>
                <Link to="/import#spreadsheet" className={linkButton('primary')}>
                  <FileSpreadsheet /> Import Excel tracker
                </Link>
                <Link to="/import#allure" className={linkButton('outline')}>
                  <Upload /> Upload allure-results
                </Link>
                <Button variant="ghost" onClick={() => setNewOpen(true)}>
                  <Plus /> Add manually
                </Button>
              </>
            }
          >
            No data yet — import your Excel tracker or an allure-results folder, or add a case by hand.
          </EmptyState>
        ) : items.length === 0 ? (
          <EmptyState icon={<Search />} title="No matching test cases" actions={<Button variant="outline" onClick={() => { setSearch(''); clear(); }}>Clear filters</Button>}>
            Try a different search or remove some filters.
          </EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] table-fixed text-[13px]">
              <thead className="bg-surface-2/60 text-left text-[11px] font-medium tracking-wide text-fg-3 uppercase">
                <tr className="border-b border-border">
                  <th className="w-10 py-2 pl-4">
                    <Checkbox
                      checked={allOnPage ? true : someOnPage ? 'indeterminate' : false}
                      onCheckedChange={toggleAll}
                      ariaLabel="Select all on page"
                    />
                  </th>
                  <SortTh label="Key" s="key" query={query} onSort={sortBy} className="w-28" />
                  <SortTh label="Title" s="title" query={query} onSort={sortBy} className="w-auto" />
                  <SortTh label="Suite" s="suite" query={query} onSort={sortBy} className="hidden w-32 md:table-cell" />
                  <SortTh label="Pri" s="priority" query={query} onSort={sortBy} className="w-14" />
                  <SortTh label="Automation" s="automationStatus" query={query} onSort={sortBy} className="w-40" />
                  <SortTh label="Last result" s="lastRun" query={query} onSort={sortBy} className="w-32" />
                  <th className="hidden w-40 px-2 py-2 font-medium xl:table-cell">Triage</th>
                  <SortTh label="Flaky" s="flakiness" query={query} onSort={sortBy} className="hidden w-24 lg:table-cell" />
                  <th className="hidden w-32 px-2 py-2 pr-4 font-medium lg:table-cell">Owner</th>
                </tr>
              </thead>
              <tbody>
                {items.map((t) => (
                  <Row key={t.id} t={t} selected={selected.has(t.id)} onSelect={(c) => toggle(t.id, c)} onOpen={() => void navigate(`/tests/${t.id}`)} />
                ))}
              </tbody>
            </table>
          </div>
        )}
        {list.data && total > 0 ? (
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-4 py-2 text-xs text-fg-2">
            <span className="tabular">
              {fmtNumber((page - 1) * pageSize + 1)}–{fmtNumber(Math.min(page * pageSize, total))} of {fmtNumber(total)}
            </span>
            <div className="flex items-center gap-2">
              <label className="flex items-center gap-1.5">
                Rows
                <select
                  value={pageSize}
                  onChange={(e) => update({ pageSize: Number(e.target.value) })}
                  className="h-7 rounded-md border border-border bg-surface px-1.5 text-xs"
                >
                  {[25, 50, 100, LIMITS.pageSizeMax].map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </label>
              <Button size="icon-sm" variant="ghost" aria-label="Previous page" disabled={page <= 1} onClick={() => update({ page: page - 1 }, false)}>
                <ChevronLeft />
              </Button>
              <span className="tabular">
                {page} / {pages}
              </span>
              <Button size="icon-sm" variant="ghost" aria-label="Next page" disabled={page >= pages} onClick={() => update({ page: page + 1 }, false)}>
                <ChevronRight />
              </Button>
            </div>
          </div>
        ) : null}
      </Card>

      <NewTestCaseDialog open={newOpen} onOpenChange={setNewOpen} />
      <BulkNoteDialog
        open={bulkNoteOpen}
        onOpenChange={setBulkNoteOpen}
        testCaseIds={[...selected]}
        onDone={() => setSelected(new Set())}
      />
      <BulkTextDialog field={textDialog} ids={[...selected]} onClose={() => setTextDialog(null)} onDone={() => setSelected(new Set())} />
    </>
  );
}

function ToggleChip({ active, onClick, icon, children }: { active: boolean; onClick: () => void; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-[13px] shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50 [&_svg]:size-3.5',
        active ? 'border-accent/50 bg-accent-soft text-fg' : 'border-border-strong/70 bg-surface text-fg-2 hover:bg-surface-2',
      )}
    >
      {icon}
      {children}
    </button>
  );
}

function SortTh({
  label,
  s,
  query,
  onSort,
  className,
}: {
  label: string;
  s: Sort;
  query: TestCaseQueryInput;
  onSort: (s: Sort) => void;
  className?: string;
}) {
  const active = (query.sort ?? 'key') === s;
  const dir = query.order ?? 'asc';
  return (
    <th className={cn('px-2 py-2 font-medium', className)} aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button
        type="button"
        onClick={() => onSort(s)}
        className={cn('-mx-1 inline-flex items-center gap-1 rounded px-1 uppercase outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-ring/50', active && 'text-fg')}
      >
        {label}
        {active ? dir === 'asc' ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" /> : <ChevronsUpDown className="size-3 opacity-40" />}
      </button>
    </th>
  );
}

function Row({ t, selected, onSelect, onOpen }: { t: TestCase; selected: boolean; onSelect: (c: boolean) => void; onOpen: () => void }) {
  return (
    <tr
      onClick={onOpen}
      className={cn('cursor-pointer border-b border-border last:border-0 hover:bg-surface-2/60', selected && 'bg-accent-soft hover:bg-accent-soft')}
    >
      <td className="py-1.5 pl-4" onClick={(e) => e.stopPropagation()}>
        <Checkbox checked={selected} onCheckedChange={onSelect} ariaLabel={`Select ${t.key}`} />
      </td>
      <td className="px-2 py-1.5">
        <Link to={`/tests/${t.id}`} onClick={(e) => e.stopPropagation()} className="block truncate font-mono text-xs text-fg-2 outline-none hover:text-fg hover:underline focus-visible:ring-2 focus-visible:ring-ring/50" title={t.key}>
          {t.key}
        </Link>
      </td>
      <td className="max-w-0 px-2 py-1.5">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-fg" title={t.title}>
            {t.title}
          </span>
          <InPrBadge prs={t.pullRequests} />
          {t.openBugs.slice(0, 2).map((b) => (
            <BugBadge key={b.id} bug={b} />
          ))}
          {t.noteCount > 0 ? (
            <span className="inline-flex shrink-0 items-center gap-0.5 text-[11px] text-fg-3" title={`${t.noteCount} notes`} aria-label={`${t.noteCount} notes`}>
              <MessageSquare className="size-3" aria-hidden />
              {t.noteCount}
            </span>
          ) : null}
        </div>
      </td>
      <td className="hidden truncate px-2 py-1.5 text-fg-2 md:table-cell" title={t.suite ?? undefined}>
        {t.suite ?? <span className="text-fg-3">—</span>}
      </td>
      <td className="px-2 py-1.5 text-xs text-fg-2">{t.priority ?? <span className="text-fg-3">—</span>}</td>
      <td className="px-2 py-1.5" onClick={(e) => e.stopPropagation()}>
        <InlineStatus t={t} />
      </td>
      <td className="px-2 py-1.5">
        {t.lastResult ? (
          <span className="flex items-center gap-1.5" title={`${t.lastResult.runName} · ${fmtRelative(t.lastResult.at)}`}>
            <ResultBadge status={t.lastResult.status} />
            <span className="hidden truncate text-[11px] text-fg-3 2xl:inline">{fmtRelative(t.lastResult.at)}</span>
          </span>
        ) : (
          <span className="text-xs text-fg-3">Never run</span>
        )}
      </td>
      <td className="hidden px-2 py-1.5 xl:table-cell">{t.triage ? <TriageBadge triage={t.triage} /> : <span className="text-fg-3">—</span>}</td>
      <td className="hidden px-2 py-1.5 lg:table-cell">{t.flakiness > 0 ? <FlakyMeter value={t.flakiness} /> : <span className="text-fg-3">—</span>}</td>
      <td className="hidden truncate px-2 py-1.5 pr-4 text-fg-2 lg:table-cell">{t.owner ?? <span className="text-fg-3">—</span>}</td>
    </tr>
  );
}

/** Inline automation-status dropdown with optimistic update. */
function InlineStatus({ t }: { t: TestCase }) {
  const set = useSetAutomationStatus();
  const M = AUTOMATION_META[t.automationStatus];
  return (
    <S.Root
      value={t.automationStatus}
      onValueChange={(v) => set.mutate({ id: t.id, status: v as AutomationStatus }, { onSuccess: () => toast.success(`${t.key} → ${AUTOMATION_META[v as AutomationStatus].label}`) })}
    >
      <S.Trigger
        aria-label={`Automation status for ${t.key}: ${M.label}`}
        className="-ml-1 inline-flex h-6 max-w-full items-center gap-1.5 rounded-md border whitespace-nowrap border-transparent px-1.5 text-xs text-fg outline-none hover:border-border hover:bg-surface focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <M.icon className="size-3.5 shrink-0" style={{ color: M.color }} aria-hidden />
        <S.Value>{M.label}</S.Value>
        <S.Icon>
          <ChevronsUpDown className="size-3 text-fg-3" />
        </S.Icon>
      </S.Trigger>
      <S.Portal>
        <S.Content position="popper" sideOffset={4} className="z-50 min-w-44 rounded-lg border border-border bg-surface p-1 shadow-md">
          <S.Viewport>
            {AutomationStatus.options.map((s) => {
              const A = AUTOMATION_META[s];
              return (
                <S.Item key={s} value={s} className="flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-fg outline-none data-[highlighted]:bg-surface-2">
                  <A.icon className="size-3.5" style={{ color: A.color }} aria-hidden />
                  <S.ItemText>{A.label}</S.ItemText>
                </S.Item>
              );
            })}
          </S.Viewport>
        </S.Content>
      </S.Portal>
    </S.Root>
  );
}

function BulkBar({
  count,
  ids,
  onClear,
  onNote,
  onText,
}: {
  count: number;
  ids: number[];
  onClear: () => void;
  onNote: () => void;
  onText: (f: 'owner' | 'suite') => void;
}) {
  const bulk = useBulkUpdate();
  const apply = (patch: Record<string, unknown>, what: string) =>
    bulk.mutate(
      { ids, patch },
      {
        onSuccess: (r) => {
          toast.success(`Updated ${pluralize(r.updated, 'case')}: ${what}`);
          onClear();
        },
      },
    );
  return (
    <div
      role="region"
      aria-label="Bulk actions"
      className="sticky top-14 z-10 mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-accent/30 bg-surface px-3 py-2 shadow-md"
    >
      <span className="text-[13px] font-medium text-fg tabular">{count} selected</span>
      <span className="mx-1 h-4 w-px bg-border" aria-hidden />
      <Menu>
        <MenuTrigger asChild>
          <Button size="sm" variant="outline" loading={bulk.isPending}>
            Set…
          </Button>
        </MenuTrigger>
        <MenuContent align="start">
          <MenuSub>
            <MenuSubTrigger>Automation status</MenuSubTrigger>
            <MenuSubContent>
              {AutomationStatus.options.map((s) => {
                const A = AUTOMATION_META[s];
                return (
                  <MenuItem key={s} onSelect={() => apply({ automationStatus: s }, A.label)}>
                    <A.icon style={{ color: A.color }} /> {A.label}
                  </MenuItem>
                );
              })}
            </MenuSubContent>
          </MenuSub>
          <MenuSub>
            <MenuSubTrigger>Priority</MenuSubTrigger>
            <MenuSubContent>
              {Priority.options.map((p) => (
                <MenuItem key={p} onSelect={() => apply({ priority: p }, p)}>
                  {p}
                </MenuItem>
              ))}
              <MenuSeparator />
              <MenuItem onSelect={() => apply({ priority: null }, 'no priority')}>None</MenuItem>
            </MenuSubContent>
          </MenuSub>
          <MenuSeparator />
          <MenuLabel>Text fields</MenuLabel>
          <MenuItem onSelect={() => onText('owner')}>Owner…</MenuItem>
          <MenuItem onSelect={() => onText('suite')}>Suite…</MenuItem>
        </MenuContent>
      </Menu>
      <Button size="sm" variant="outline" onClick={onNote}>
        <MessageSquarePlus /> Add note
      </Button>
      <Button size="sm" variant="ghost" onClick={onClear} className="ml-auto">
        <X /> Clear selection
      </Button>
    </div>
  );
}

function BulkTextDialog({ field, ids, onClose, onDone }: { field: null | 'owner' | 'suite'; ids: number[]; onClose: () => void; onDone: () => void }) {
  const [value, setValue] = useState('');
  const bulk = useBulkUpdate();
  const meta = useMeta();
  const options = field === 'owner' ? meta.data?.owners : meta.data?.suites;
  const submit = () => {
    if (!field) return;
    bulk.mutate(
      { ids, patch: { [field]: value.trim() || null } },
      {
        onSuccess: (r) => {
          toast.success(`Updated ${pluralize(r.updated, 'case')}`);
          setValue('');
          onClose();
          onDone();
        },
      },
    );
  };
  return (
    <Dialog
      open={field !== null}
      onOpenChange={(o) => !o && onClose()}
      title={`Set ${field ?? ''} for ${pluralize(ids.length, 'case')}`}
      className="max-w-md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} loading={bulk.isPending}>
            Apply
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Field label={field === 'owner' ? 'Owner' : 'Suite'} htmlFor="bulk-text" hint="Leave empty to clear.">
          <Input id="bulk-text" list="bulk-text-options" autoFocus value={value} maxLength={LIMITS.shortTextMax} onChange={(e) => setValue(e.target.value)} />
          <datalist id="bulk-text-options">
            {options?.map((o) => <option key={o} value={o} />)}
          </datalist>
        </Field>
      </form>
    </Dialog>
  );
}

