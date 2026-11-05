import { useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import {
  ArrowLeft,
  Bug as BugIcon,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  Ellipsis,
  ExternalLink as ExternalIcon,
  GitBranch,
  GitCommitHorizontal,
  GitCompareArrows,
  ListChecks,
  MessageSquarePlus,
  Pencil,
  Search,
  Server,
  Trash2,
  X,
} from 'lucide-react';
import { LIMITS, ResultChange, ResultStatus, RunUpdate, type FailureGroup, type Run } from '@ptd/shared';
import { useBulkNote, useDeleteRun, useMeta, useRun, useRunFailures, useRunResults, useUpdateRun } from '../api/hooks';
import { useAuthor } from '../lib/author';
import { readStorage, writeStorage } from '../lib/storage';
import { ApiError } from '../api/client';
import { useDebounced } from '../lib/useDebounced';
import { safeHttpUrl } from '../lib/url';
import { cn, fmtDateTime, fmtDuration, fmtNumber, fmtPct, fmtRelative, pluralize } from '../lib/utils';
import { Button } from '../components/ui/button';
import { Card } from '../components/ui/card';
import { ConfirmDialog } from '../components/ui/confirm';
import { Dialog } from '../components/ui/dialog';
import { EmptyState, ErrorState } from '../components/ui/empty-state';
import { Field, Input } from '../components/ui/input';
import { Menu, MenuContent, MenuItem, MenuTrigger } from '../components/ui/dropdown';
import { Select } from '../components/ui/select';
import { Skeleton, SkeletonRows } from '../components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs';
import { linkButton } from '../components/ui/link-button';
import { RESULT_META, ResultBadge, TRIAGE_META, TriageBadge } from '../components/status';
import { CHANGE_META, ChangeBadge } from '../components/ChangeBadge';
import { RunGroupChip } from '../components/RunGroup';
import { BulkNoteDialog } from '../components/NoteForm';
import { BugBadge, BugDialog } from '../components/bugs';
import { PassRateBar } from '../components/RunBits';

export default function RunDetailPage() {
  const id = Number(useParams().id);
  const run = useRun(id);
  if (run.isError) {
    if (run.error instanceof ApiError && run.error.status === 404)
      return (
        <EmptyState title="Run not found" actions={<Link to="/runs" className={linkButton('outline')}>Back to runs</Link>}>
          It may have been deleted.
        </EmptyState>
      );
    return <ErrorState error={run.error} onRetry={() => void run.refetch()} />;
  }
  if (!run.data)
    return (
      <div className="space-y-4" role="status" aria-label="Loading run">
        <Skeleton className="h-4 w-20" />
        <Skeleton className="h-8 w-1/2" />
        <Skeleton className="h-24" />
        <Skeleton className="h-72" />
      </div>
    );
  return <RunView r={run.data} />;
}

function Tile({ label, value, icon, sub }: { label: string; value: ReactNode; icon?: ReactNode; sub?: ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-surface px-4 py-3 shadow-sm">
      <div className="flex items-center gap-1.5 text-xs text-fg-2">
        {icon}
        {label}
      </div>
      <div className="mt-1 text-xl font-semibold tracking-tight text-fg">{value}</div>
      {sub ? <div className="mt-0.5 text-[11px] text-fg-3">{sub}</div> : null}
    </div>
  );
}

function RunView({ r }: { r: Run }) {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'results' ? 'results' : 'failures';
  const [editOpen, setEditOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const del = useDeleteRun();
  const navigate = useNavigate();
  const buildUrl = safeHttpUrl(r.buildUrl);
  const env = Object.entries(r.environment);
  const failing = r.counts.failed + r.counts.broken;

  return (
    <>
      <Link to={`/runs?group=${encodeURIComponent(r.runGroup)}`} className="mb-3 inline-flex items-center gap-1 text-xs text-fg-2 hover:text-fg">
        <ArrowLeft className="size-3.5" aria-hidden /> Runs
      </Link>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight break-words text-fg">{r.name}</h1>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-2">
            <RunGroupChip group={r.runGroup} />
            {r.branch ? (
              <span className="inline-flex items-center gap-1 font-mono">
                <GitBranch className="size-3.5 text-fg-3" aria-hidden />
                {r.branch}
              </span>
            ) : null}
            {r.commit ? (
              <span className="inline-flex items-center gap-1 font-mono" title={r.commit}>
                <GitCommitHorizontal className="size-3.5 text-fg-3" aria-hidden />
                {r.commit.slice(0, 10)}
              </span>
            ) : null}
            <span title={fmtDateTime(r.startedAt ?? r.importedAt)}>Started {fmtRelative(r.startedAt ?? r.importedAt)}</span>
            <span>Duration {fmtDuration(r.durationMs)}</span>
            {buildUrl ? (
              <a href={buildUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 link">
                Build <ExternalIcon className="size-3" aria-hidden />
              </a>
            ) : null}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => setEditOpen(true)}>
            <Pencil /> Edit
          </Button>
          <Menu>
            <MenuTrigger asChild>
              <Button variant="ghost" size="icon" aria-label="More actions">
                <Ellipsis />
              </Button>
            </MenuTrigger>
            <MenuContent>
              <MenuItem onSelect={() => setConfirm(true)} className="text-bad">
                <Trash2 /> Delete run
              </MenuItem>
            </MenuContent>
          </Menu>
        </div>
      </div>

      <PreviousBanner r={r} />

      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <div className="col-span-2 rounded-lg border border-border bg-surface px-4 py-3 shadow-sm sm:col-span-3 lg:col-span-2">
          <div className="text-xs text-fg-2">Pass rate</div>
          <div className="mt-1 flex items-center gap-3">
            <span className="text-2xl font-semibold tracking-tight text-fg">{fmtPct(r.passRate, 1)}</span>
            <PassRateBar r={r} className="flex-1 [&>span]:hidden" />
          </div>
          <div className="mt-0.5 text-[11px] text-fg-3">{fmtNumber(r.counts.total)} results · skipped excluded</div>
        </div>
        {(['passed', 'failed', 'broken', 'skipped'] as const).map((k) => {
          const M = RESULT_META[k];
          return <Tile key={k} label={M.label} value={fmtNumber(r.counts[k])} icon={<M.icon className="size-3.5" style={{ color: M.color }} aria-hidden />} />;
        })}
      </div>

      {env.length > 0 ? (
        <details className="group mb-4 rounded-lg border border-border bg-surface shadow-sm">
          <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-2.5 text-[13px] font-medium text-fg outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
            <Server className="size-4 text-fg-3" aria-hidden />
            Environment
            <span className="text-xs font-normal text-fg-3">{env.length} properties</span>
            <ChevronDown className="ml-auto size-4 text-fg-3 transition-transform group-open:rotate-180" aria-hidden />
          </summary>
          <dl className="grid gap-x-6 gap-y-1 border-t border-border px-4 py-3 sm:grid-cols-2 lg:grid-cols-3">
            {env.map(([k, v]) => (
              <div key={k} className="flex min-w-0 gap-2 text-xs">
                <dt className="shrink-0 font-mono text-fg-3">{k}</dt>
                <dd className="truncate font-mono text-fg" title={v}>
                  {v}
                </dd>
              </div>
            ))}
          </dl>
        </details>
      ) : null}

      <Tabs
        value={tab}
        onValueChange={(v) =>
          setParams(
            (p) => {
              const n = new URLSearchParams(p);
              if (v === 'results') n.set('tab', 'results');
              else n.delete('tab');
              return n;
            },
            { replace: true },
          )
        }
      >
        <TabsList>
          <TabsTrigger value="failures">
            Failures <span className="rounded-full bg-surface-2 px-1.5 text-[11px] text-fg-2 tabular">{fmtNumber(failing)}</span>
          </TabsTrigger>
          <TabsTrigger value="results">
            All results <span className="rounded-full bg-surface-2 px-1.5 text-[11px] text-fg-2 tabular">{fmtNumber(r.counts.total)}</span>
          </TabsTrigger>
        </TabsList>
        <TabsContent value="failures" className="pt-4 outline-none">
          <FailuresTab r={r} />
        </TabsContent>
        <TabsContent value="results" className="pt-4 outline-none">
          <ResultsTab r={r} />
        </TabsContent>
      </Tabs>

      <EditRunDialog r={r} open={editOpen} onOpenChange={setEditOpen} />
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={`Delete run “${r.name}”?`}
        description={<>Deletes the run and its {pluralize(r.counts.total, 'result')}. Test cases and notes are kept.</>}
        loading={del.isPending}
        onConfirm={() =>
          del.mutate(r.id, {
            onSuccess: () => {
              toast.success('Run deleted');
              void navigate(`/runs?group=${encodeURIComponent(r.runGroup)}`);
            },
          })
        }
      />
    </>
  );
}

function PreviousBanner({ r }: { r: Run }) {
  const ch = r.changes;
  if (!r.previousRunId) {
    return (
      <div className="mb-4 flex items-center gap-2 rounded-lg border border-dashed border-border px-4 py-2.5 text-xs text-fg-2">
        <GitCompareArrows className="size-4 text-fg-3" aria-hidden />
        First run in <b className="font-medium text-fg">{r.runGroup}</b>
        {r.branch ? (
          <>
            {' '}
            on <span className="font-mono">{r.branch}</span>
          </>
        ) : null}{' '}
        — nothing to compare against yet.
      </div>
    );
  }
  const bad = ch.newFailures > 0;
  const items: { n: number; label: string; key: ResultChange | 'missing' }[] = [
    { n: ch.newFailures, label: ch.newFailures === 1 ? 'new failure' : 'new failures', key: 'new_failure' },
    { n: ch.fixed, label: 'fixed', key: 'fixed' },
    { n: ch.stillFailing, label: 'still failing', key: 'still_failing' },
    { n: ch.newTests, label: ch.newTests === 1 ? 'new test' : 'new tests', key: 'new_test' },
    { n: ch.missing, label: 'missing', key: 'missing' },
  ];
  return (
    <div
      className={cn('mb-4 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border px-4 py-2.5 text-[13px]')}
      style={{
        background: bad ? 'color-mix(in oklab, var(--st-failed) 7%, var(--surface))' : 'color-mix(in oklab, var(--st-passed) 6%, var(--surface))',
        borderColor: bad ? 'color-mix(in oklab, var(--st-failed) 28%, transparent)' : 'color-mix(in oklab, var(--st-passed) 25%, transparent)',
      }}
    >
      <span className="font-medium text-fg">vs previous run</span>
      {items.map((i) => {
        const M = i.key === 'missing' ? null : CHANGE_META[i.key];
        return (
          <span key={i.key} className={cn('inline-flex items-center gap-1 text-fg-2', i.n === 0 && 'opacity-60')}>
            {M ? <M.icon className="size-3.5" style={{ color: M.color }} aria-hidden strokeWidth={2.6} /> : null}
            <b className="font-semibold text-fg tabular">{fmtNumber(i.n)}</b> {i.label}
          </span>
        );
      })}
      <span className="ml-auto flex items-center gap-2">
        <Link to={`/runs/${r.previousRunId}`} className="text-xs text-fg-2 hover:text-fg hover:underline">
          Previous run
        </Link>
        <Link to={`/runs/compare?head=${r.id}&base=${r.previousRunId}&group=${encodeURIComponent(r.runGroup)}`} className={linkButton('outline', 'sm')}>
          <GitCompareArrows /> Compare
        </Link>
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------

function FailuresTab({ r }: { r: Run }) {
  const f = useRunFailures(r.id);
  if (f.isError) return <ErrorState error={f.error} onRetry={() => void f.refetch()} />;
  if (!f.data) return <SkeletonRows rows={5} />;
  if (f.data.length === 0)
    return (
      <Card>
        <EmptyState icon={<CircleCheck />} title="No failures in this run">
          Every executed test passed.
        </EmptyState>
      </Card>
    );
  return (
    <div className="space-y-2">
      <p className="text-xs text-fg-3">
        {pluralize(f.data.length, 'failure group')} by normalized error message — new failures first.
      </p>
      {f.data.map((g) => (
        <FailureGroupCard key={g.signature} g={g} runId={r.id} />
      ))}
    </div>
  );
}

const dismissKey = (signature: string) => `ptd-dismissed-suggestion:${signature}`;

function suggestionBody(g: FailureGroup): string {
  const label = g.suggestedTriage ? TRIAGE_META[g.suggestedTriage].label.toLowerCase() : 'triage';
  return `Looks like ${label} (suggested from the error): ${g.sampleMessage.slice(0, 200)}`;
}

/**
 * Heuristic suggestion (server-side `suggestedTriage`, e.g. ORA-12541 / TNS-* /
 * connection refused ⇒ environment) for groups nobody has triaged yet. Applying
 * it creates the normal bulk triage note; dismissing is remembered per signature.
 */
function TriageSuggestion({ g, runId, onNeedDialog }: { g: FailureGroup; runId: number; onNeedDialog: () => void }) {
  const [dismissed, setDismissed] = useState(() => readStorage(dismissKey(g.signature)) === '1');
  const [author] = useAuthor();
  const bulk = useBulkNote();
  if (!g.suggestedTriage || g.triage || dismissed) return null;
  const T = TRIAGE_META[g.suggestedTriage];
  const apply = () => {
    if (!author) return onNeedDialog();
    bulk.mutate(
      {
        testCaseIds: g.testCases.map((t) => t.id),
        runId,
        author,
        body: suggestionBody(g),
        triage: g.suggestedTriage,
        ticketUrl: null,
      },
      { onSuccess: (r) => toast.success(`Triaged ${pluralize(r.created, 'case')} as ${T.label.toLowerCase()}`) },
    );
  };
  return (
    <div
      role="group"
      aria-label="Triage suggestion"
      className="mt-2 inline-flex max-w-full flex-wrap items-center gap-x-2 gap-y-1 rounded-full border py-0.5 pr-1 pl-2.5 text-xs text-fg"
      style={{
        background: `color-mix(in oklab, ${T.color} 9%, transparent)`,
        borderColor: `color-mix(in oklab, ${T.color} 32%, transparent)`,
      }}
    >
      <T.icon className="size-3.5 shrink-0" style={{ color: T.color }} aria-hidden />
      <span>
        Looks like <b className="font-semibold">{T.label.toLowerCase()}</b> — apply?
      </span>
      <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={apply} loading={bulk.isPending}>
        Apply to {pluralize(g.testCases.length, 'case')}
      </Button>
      <button
        type="button"
        onClick={() => {
          writeStorage(dismissKey(g.signature), '1');
          setDismissed(true);
        }}
        aria-label="Dismiss suggestion"
        className="grid size-5 place-items-center rounded-full text-fg-3 outline-none hover:bg-surface-2 hover:text-fg focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <X className="size-3" aria-hidden />
      </button>
    </div>
  );
}

function FailureGroupCard({ g, runId }: { g: FailureGroup; runId: number }) {
  const [open, setOpen] = useState(false);
  const [triageOpen, setTriageOpen] = useState(false);
  const [bugOpen, setBugOpen] = useState(false);
  const [suggestDialog, setSuggestDialog] = useState(false);
  const M = RESULT_META[g.status];
  const isNew = g.newFailures > 0;
  return (
    <Card className={cn('overflow-hidden', isNew && 'border-[color-mix(in_oklab,var(--st-failed)_30%,var(--border))]')}>
      <div className="flex items-start gap-3 px-4 py-3">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-label={open ? 'Collapse group' : 'Expand group'}
          className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-md text-fg-3 outline-none hover:bg-surface-2 hover:text-fg focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <ChevronRight className={cn('size-4 transition-transform', open && 'rotate-90')} />
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <M.icon className="size-4 shrink-0" style={{ color: M.color }} aria-label={M.label} />
            <span className="text-[13px] font-semibold text-fg tabular">{pluralize(g.count, 'test')}</span>
            {isNew ? (
              <span className="rounded-full bg-st-failed px-1.5 py-px text-[10px] font-bold tracking-wide text-white">
                NEW{g.newFailures !== g.count ? ` · ${g.newFailures}` : ''}
              </span>
            ) : null}
            {g.triage ? <TriageBadge triage={g.triage} /> : g.bugs.length === 0 ? <span className="text-[11px] text-fg-3">Untriaged</span> : null}
            {g.bugs.map((b) => (
              <BugBadge key={b.id} bug={b} />
            ))}
            {g.firstSeen ? (
              <span className="text-[11px] text-fg-3">
                First seen{' '}
                {g.firstSeen.runId === runId ? (
                  'in this run'
                ) : (
                  <Link to={`/runs/${g.firstSeen.runId}`} className="hover:text-fg hover:underline">
                    {g.firstSeen.runName} · {fmtRelative(g.firstSeen.at)}
                  </Link>
                )}
              </span>
            ) : null}
          </div>
          <button type="button" onClick={() => setOpen((o) => !o)} className="mt-1.5 block w-full text-left outline-none">
            <code className={cn('block font-mono text-xs leading-relaxed break-words text-fg-2', !open && 'line-clamp-2')}>{g.sampleMessage || '(no message)'}</code>
          </button>
          <TriageSuggestion g={g} runId={runId} onNeedDialog={() => setSuggestDialog(true)} />
        </div>
        <div className="flex shrink-0 flex-col gap-1.5 sm:flex-row">
          <Button size="sm" variant="outline" onClick={() => setTriageOpen(true)}>
            <MessageSquarePlus /> <span className="hidden sm:inline">Triage all</span>
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setBugOpen(true)} aria-label="Log bug for this failure group">
            <BugIcon /> <span className="hidden sm:inline">Log bug</span>
          </Button>
        </div>
      </div>
      {open ? (
        <ul className="border-t border-border bg-surface-2/40 px-4 py-2">
          {g.testCases.map((t) => (
            <li key={t.id} className="flex min-w-0 items-center gap-2 py-1 text-[13px]">
              <Link to={`/tests/${t.id}`} className="truncate text-fg hover:underline">
                {t.title}
              </Link>
              <span className="truncate font-mono text-[11px] text-fg-3">{t.key}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <BulkNoteDialog
        open={triageOpen}
        onOpenChange={setTriageOpen}
        testCaseIds={g.testCases.map((t) => t.id)}
        runId={runId}
        title="Triage failure group"
        description={`Adds the same note to all ${pluralize(g.testCases.length, 'test case')} with this error.`}
        defaultTriage={g.triage ?? 'needs_investigation'}
      />
      {g.suggestedTriage ? (
        <BulkNoteDialog
          open={suggestDialog}
          onOpenChange={setSuggestDialog}
          testCaseIds={g.testCases.map((t) => t.id)}
          runId={runId}
          title={`Triage as ${TRIAGE_META[g.suggestedTriage].label.toLowerCase()}`}
          description={`Adds the same note to all ${pluralize(g.testCases.length, 'test case')} with this error.`}
          defaultTriage={g.suggestedTriage}
          defaultBody={suggestionBody(g)}
        />
      ) : null}
      <BugDialog
        open={bugOpen}
        onOpenChange={setBugOpen}
        prefill={{
          title: (g.sampleMessage.split('\n')[0] ?? '').slice(0, 200),
          testCases: g.testCases,
          failureSignatures: [g.signature],
          foundInRunId: runId,
        }}
      />
    </Card>
  );
}

// ---------------------------------------------------------------------------

function ResultsTab({ r }: { r: Run }) {
  const [status, setStatus] = useState<ResultStatus | null>(null);
  // Default view highlights what's new: if this run introduced failures, start on those.
  const [change, setChange] = useState<ResultChange | null>(r.changes.newFailures > 0 ? 'new_failure' : null);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const debounced = useDebounced(search.trim(), 300);
  const pageSize = 100;
  const q = useRunResults(r.id, { status: status ?? undefined, change: change ?? undefined, search: debounced || undefined, page, pageSize });
  const items = q.data?.items ?? [];
  const total = q.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
        <div className="relative w-full sm:w-60">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-fg-3" aria-hidden />
          <Input
            type="search"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            placeholder="Search tests…"
            aria-label="Search results"
            className="pl-8"
          />
        </div>
        <Select
          ariaLabel="Change vs previous run"
          value={change}
          onValueChange={(v) => {
            setChange(v);
            setPage(1);
          }}
          options={ResultChange.options.map((c) => {
            const M = CHANGE_META[c];
            return { value: c, label: c === 'other' ? 'Other (skipped/unknown)' : M.label, text: c === 'other' ? 'Other' : M.label, icon: <M.icon className="size-3.5" style={{ color: M.color }} aria-hidden /> };
          })}
          allowNone
          noneLabel="Any change"
        />
        <Select
          ariaLabel="Status"
          value={status}
          onValueChange={(v) => {
            setStatus(v);
            setPage(1);
          }}
          options={ResultStatus.options.map((s) => {
            const M = RESULT_META[s];
            return { value: s, label: M.label, icon: <M.icon className="size-3.5" style={{ color: M.color }} aria-hidden /> };
          })}
          allowNone
          noneLabel="Any status"
        />
        <span className="ml-auto text-xs text-fg-3 tabular">{q.data ? `${fmtNumber(total)} results` : null}</span>
      </div>
      {q.isError ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : q.isPending ? (
        <SkeletonRows rows={8} />
      ) : items.length === 0 ? (
        <EmptyState icon={<ListChecks />} title="No results match">
          {change ? (
            <button type="button" onClick={() => setChange(null)} className="link">
              Show all changes
            </button>
          ) : (
            'Try another filter.'
          )}
        </EmptyState>
      ) : (
        <div className={cn('overflow-x-auto', q.isPlaceholderData && 'opacity-60')}>
          <table className="w-full min-w-[680px] text-[13px]">
            <thead className="bg-surface-2/60 text-left text-[11px] font-medium tracking-wide text-fg-3 uppercase">
              <tr className="border-b border-border">
                <th className="w-32 px-4 py-2 font-medium">Change</th>
                <th className="w-28 px-2 py-2 font-medium">Status</th>
                <th className="px-2 py-2 font-medium">Test</th>
                <th className="w-24 px-2 py-2 pr-4 text-right font-medium">Duration</th>
              </tr>
            </thead>
            <tbody>
              {items.map((res) => (
                <tr key={res.id} className={cn('border-b border-border align-top last:border-0 hover:bg-surface-2/50', res.change === 'new_failure' && 'bg-[color-mix(in_oklab,var(--st-failed)_5%,transparent)]')}>
                  <td className="px-4 py-2">
                    <ChangeBadge change={res.change} />
                  </td>
                  <td className="px-2 py-2">
                    <ResultBadge status={res.status} />
                    {res.retries > 0 ? (
                      <div className="mt-0.5 text-[10px] text-fg-3" title={res.attempts ? `Attempts: ${res.attempts.join(' → ')}` : undefined}>
                        {pluralize(res.retries, 'retry', 'retries')}
                        {res.attempts?.includes('passed') && res.attempts.some((st) => st === 'failed' || st === 'broken') ? (
                          <span className="text-st-broken"> · flaky</span>
                        ) : null}
                      </div>
                    ) : null}
                  </td>
                  <td className="max-w-0 px-2 py-2">
                    <Link to={`/tests/${res.testCaseId}`} className="block truncate text-fg hover:underline" title={res.fullName ?? res.name}>
                      {res.name}
                    </Link>
                    <div className="truncate font-mono text-[11px] text-fg-3">{res.testCaseKey}</div>
                    {res.message ? <div className="mt-0.5 line-clamp-2 font-mono text-[11px] text-fg-2">{res.message}</div> : null}
                  </td>
                  <td className="px-2 py-2 pr-4 text-right text-xs text-fg-2 tabular">{fmtDuration(res.durationMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {total > pageSize ? (
        <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-2 text-xs text-fg-2">
          <Button size="icon-sm" variant="ghost" aria-label="Previous page" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            <ChevronLeft />
          </Button>
          <span className="tabular">
            {page} / {pages}
          </span>
          <Button size="icon-sm" variant="ghost" aria-label="Next page" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>
            <ChevronRight />
          </Button>
        </div>
      ) : null}
    </Card>
  );
}

// ---------------------------------------------------------------------------

function EditRunDialog({ r, open, onOpenChange }: { r: Run; open: boolean; onOpenChange: (o: boolean) => void }) {
  const [name, setName] = useState(r.name);
  const [group, setGroup] = useState(r.runGroup);
  const [branch, setBranch] = useState(r.branch ?? '');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const meta = useMeta();
  const update = useUpdateRun(r.id);

  const submit = () => {
    const parsed = RunUpdate.safeParse({ name, runGroup: group, branch: branch.trim() || null });
    if (!parsed.success) {
      const e: Record<string, string> = {};
      parsed.error.issues.forEach((i) => (e[String(i.path[0])] ??= i.message.includes('>=1') || i.code === 'too_small' ? 'Required' : i.message));
      return setErrors(e);
    }
    update.mutate(parsed.data, {
      onSuccess: () => {
        toast.success('Run updated');
        onOpenChange(false);
      },
    });
  };
  const groupChanged = group.trim() !== r.runGroup || (branch.trim() || null) !== r.branch;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (o) {
          setName(r.name);
          setGroup(r.runGroup);
          setBranch(r.branch ?? '');
          setErrors({});
        }
        onOpenChange(o);
      }}
      title="Edit run"
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} loading={update.isPending}>
            Save
          </Button>
        </>
      }
    >
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Field label="Name" htmlFor="run-name" error={errors.name}>
          <Input id="run-name" value={name} maxLength={LIMITS.shortTextMax} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Run group" htmlFor="run-group" error={errors.runGroup} hint="Runs are only compared with earlier runs of the same group and branch.">
          <Input id="run-group" list="run-group-options" value={group} maxLength={LIMITS.shortTextMax} onChange={(e) => setGroup(e.target.value)} className="font-mono" />
          <datalist id="run-group-options">
            {meta.data?.runGroups.map((g) => <option key={g.name} value={g.name} />)}
          </datalist>
        </Field>
        <Field label="Branch" htmlFor="run-branch" error={errors.branch}>
          <Input id="run-branch" list="run-branch-options" value={branch} maxLength={LIMITS.shortTextMax} onChange={(e) => setBranch(e.target.value)} className="font-mono" />
          <datalist id="run-branch-options">
            {meta.data?.branches.map((b) => <option key={b} value={b} />)}
          </datalist>
        </Field>
        {groupChanged ? (
          <p className="rounded-md bg-surface-2 px-3 py-2 text-xs text-fg-2">
            Changing the group or branch re-links this run’s baseline and recomputes change tags.
          </p>
        ) : null}
      </form>
    </Dialog>
  );
}

