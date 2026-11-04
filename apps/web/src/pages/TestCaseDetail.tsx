import { useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';
import {
  ArrowLeft,
  Bug as BugIcon,
  ChevronDown,
  ChevronRight,
  Clock,
  ExternalLink as ExternalIcon,
  GitPullRequest,
  History,
  MessageSquare,
  Ellipsis,
  Pencil,
  Snail,
  Ticket,
  Trash2,
} from 'lucide-react';
import { Line, LineChart, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis, CartesianGrid } from 'recharts';
import type { Note, PullRequestRef, TestCaseDetail } from '@ptd/shared';
import {
  useCreateNote,
  useDeleteNote,
  useDeleteTestCase,
  useRunResults,
  useSetAutomationStatus,
  useTestCase,
  useUpdateNote,
  useUpdateTestCase,
} from '../api/hooks';
import { ApiError } from '../api/client';
import { useAuthor } from '../lib/author';
import { useCssVars } from '../lib/theme';
import { safeHttpUrl } from '../lib/url';
import { cn, fmtDate, fmtDateTime, fmtDuration, fmtPct, fmtRelative, pluralize } from '../lib/utils';
import { Button } from '../components/ui/button';
import { Card, CardBody, CardHeader } from '../components/ui/card';
import { ConfirmDialog } from '../components/ui/confirm';
import { EmptyState, ErrorState } from '../components/ui/empty-state';
import { Menu, MenuContent, MenuItem, MenuTrigger } from '../components/ui/dropdown';
import { Chip, ExternalLink } from '../components/ui/misc';
import { Select } from '../components/ui/select';
import { Skeleton } from '../components/ui/skeleton';
import { Tooltip } from '../components/ui/tooltip';
import { Markdown } from '../components/Markdown';
import {
  AUTOMATION_META,
  ChecksBadge,
  InPrBadge,
  PrStateBadge,
  RESULT_META,
  ResultBadge,
  ReviewBadge,
  ThreadsCount,
  TriageBadge,
} from '../components/status';
import { AUTOMATION_OPTIONS, CaseFields, draftFromCase, validateCase, type CaseDraft } from '../components/TestCaseForm';
import { AuthorField, NoteFields, validateNote, type NoteDraft } from '../components/NoteForm';
import { ChangeBadge } from '../components/ChangeBadge';
import { RunGroupChip } from '../components/RunGroup';
import { ChartTooltipBox } from '../components/charts/ChartTooltip';
import { BugBadge, BugDialog, BugStatusBadge, SeverityBadge, VerificationBadge } from '../components/bugs';

type HistoryItem = TestCaseDetail['history'][number];

export default function TestCaseDetailPage() {
  const id = Number(useParams().id);
  const q = useTestCase(id);

  if (!Number.isFinite(id) || id <= 0) return <EmptyState title="Invalid test case id" />;
  if (q.isError) {
    if (q.error instanceof ApiError && q.error.status === 404)
      return (
        <EmptyState title="Test case not found" actions={<Link to="/tests" className="text-accent hover:underline">Back to test cases</Link>}>
          It may have been deleted.
        </EmptyState>
      );
    return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  }
  if (!q.data) return <DetailSkeleton />;
  return <Detail t={q.data} />;
}

function DetailSkeleton() {
  return (
    <div className="space-y-4" role="status" aria-label="Loading test case">
      <Skeleton className="h-4 w-24" />
      <Skeleton className="h-8 w-2/3" />
      <div className="grid gap-4 lg:grid-cols-3">
        <Skeleton className="h-80 lg:col-span-2" />
        <Skeleton className="h-80" />
      </div>
    </div>
  );
}

function Detail({ t }: { t: TestCaseDetail }) {
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [bugOpen, setBugOpen] = useState(false);
  const del = useDeleteTestCase();
  const latestFail = t.history.find((h) => h.status === 'failed' || h.status === 'broken');
  const setStatus = useSetAutomationStatus();
  const navigate = useNavigate();
  const jiraUrl = t.jiraKey && safeHttpUrl(t.externalUrl)?.includes(t.jiraKey) ? safeHttpUrl(t.externalUrl) : null;

  return (
    <>
      <Link to="/tests" className="mb-3 inline-flex items-center gap-1 text-xs text-fg-2 hover:text-fg">
        <ArrowLeft className="size-3.5" aria-hidden /> Test cases
      </Link>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 text-xs text-fg-3">
            <span className="font-mono text-fg-2 break-all">{t.key}</span>
            {t.jiraKey ? (
              <ExternalLink href={jiraUrl} className="font-mono" fallback={<Chip className="font-mono">{t.jiraKey}</Chip>}>
                <Ticket className="size-3" aria-hidden />
                {t.jiraKey}
              </ExternalLink>
            ) : null}
            <span>· {t.source === 'allure' ? 'Created from allure results' : t.source === 'jira' ? 'Synced from Jira' : t.source === 'spreadsheet' ? 'Imported from spreadsheet' : 'Added manually'}</span>
          </div>
          <h1 className="mt-1 text-xl font-semibold tracking-tight text-balance text-fg">{t.title}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Select
              ariaLabel="Automation status"
              size="sm"
              value={t.automationStatus}
              onValueChange={(v) => v && setStatus.mutate({ id: t.id, status: v }, { onSuccess: () => toast.success(`Status → ${AUTOMATION_META[v].label}`) })}
              options={AUTOMATION_OPTIONS}
            />
            {t.lastResult ? <ResultBadge status={t.lastResult.status} /> : null}
            {t.triage ? <TriageBadge triage={t.triage} /> : null}
            <InPrBadge prs={t.pullRequests} />
            {t.openBugs.map((b) => (
              <BugBadge key={b.id} bug={b} />
            ))}
            {t.tags.map((tag) => (
              <Chip key={tag}>#{tag}</Chip>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {safeHttpUrl(t.externalUrl) ? (
            <a href={safeHttpUrl(t.externalUrl)!} target="_blank" rel="noopener noreferrer" className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border-strong/70 bg-surface px-3 text-[13px] font-medium text-fg shadow-sm hover:bg-surface-2">
              <ExternalIcon className="size-4" aria-hidden /> Open in {t.jiraKey ? 'Jira' : 'tracker'}
            </a>
          ) : null}
          <Button variant="outline" onClick={() => setBugOpen(true)}>
            <BugIcon /> Log bug
          </Button>
          <Button variant="outline" onClick={() => setEditing(true)}>
            <Pencil /> Edit
          </Button>
          <Menu>
            <MenuTrigger asChild>
              <Button variant="ghost" size="icon" aria-label="More actions">
                <Ellipsis />
              </Button>
            </MenuTrigger>
            <MenuContent>
              <MenuItem onSelect={() => setConfirmDelete(true)} className="text-bad">
                <Trash2 /> Delete test case
              </MenuItem>
            </MenuContent>
          </Menu>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="min-w-0 space-y-4 lg:col-span-2">
          <HistorySection t={t} />
          <LatestFailure t={t} />
          <NotesSection t={t} />
        </div>
        <div className="min-w-0 space-y-4">
          <MetadataCard t={t} editing={editing} setEditing={setEditing} />
          <BugsCard t={t} onLog={() => setBugOpen(true)} />
          <PullRequestsCard prs={t.pullRequests} />
        </div>
      </div>

      <BugDialog
        open={bugOpen}
        onOpenChange={setBugOpen}
        prefill={{
          title: latestFail?.message?.split('\n')[0]?.slice(0, 200) ?? '',
          testCases: [{ id: t.id, key: t.key, title: t.title }],
          failureSignatures: latestFail?.failureSignature ? [latestFail.failureSignature] : [],
          foundInRunId: latestFail?.runId ?? null,
        }}
      />
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete ${t.key}?`}
        description={
          <>
            This permanently deletes the test case, its {pluralize(t.noteCount, 'note')} and its results in all runs. This
            cannot be undone.
          </>
        }
        loading={del.isPending}
        onConfirm={() =>
          del.mutate(t.id, {
            onSuccess: () => {
              toast.success(`Deleted ${t.key}`);
              void navigate('/tests');
            },
          })
        }
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// History

function Stat({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: 'bad' | 'warn' | 'good' }) {
  return (
    <div className="min-w-0 rounded-lg border border-border px-3 py-2">
      <div className="text-[11px] text-fg-3">{label}</div>
      <div className={cn('mt-0.5 truncate text-[15px] font-semibold', tone === 'bad' ? 'text-bad' : tone === 'good' ? 'text-good' : 'text-fg')}>{value}</div>
      {sub ? <div className="truncate text-[11px] text-fg-3">{sub}</div> : null}
    </div>
  );
}

function HistorySection({ t }: { t: TestCaseDetail }) {
  const st = t.stats;
  const branches = useMemo(() => [...new Set(t.history.map((h) => h.branch ?? '(no branch)'))], [t.history]);
  const [branch, setBranch] = useState<string | null>(null);
  const [selected, setSelected] = useState<HistoryItem | null>(null);
  const filtered = branch ? t.history.filter((h) => (h.branch ?? '(no branch)') === branch) : t.history;
  const groups = useMemo(() => {
    const m = new Map<string, HistoryItem[]>();
    for (const h of filtered) {
      const arr = m.get(h.runGroup) ?? [];
      arr.push(h);
      m.set(h.runGroup, arr);
    }
    // oldest → newest (newest right)
    return [...m.entries()].map(([g, items]) => ({ group: g, items: [...items].reverse() }));
  }, [filtered]);

  const slower = st.durationRatio != null && st.durationRatio > 1.5;

  return (
    <Card>
      <CardHeader
        title="History"
        icon={<History className="size-4 text-fg-3" aria-hidden />}
        description={`${pluralize(st.executions, 'execution')} recorded`}
        actions={
          branches.length > 1 ? (
            <Select
              ariaLabel="Branch"
              size="sm"
              value={branch}
              onValueChange={setBranch}
              options={branches.map((b) => ({ value: b, label: b }))}
              allowNone
              noneLabel="All branches"
            />
          ) : null
        }
      />
      <CardBody className="space-y-4">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-5">
          <Stat
            label="Failing since"
            value={st.failingSince ? fmtRelative(st.failingSince.at) : 'Not failing'}
            sub={st.failingSince ? st.failingSince.runName : undefined}
            tone={st.failingSince ? 'bad' : 'good'}
          />
          <Stat label="Consecutive failures" value={st.consecutiveFailures} tone={st.consecutiveFailures > 0 ? 'bad' : undefined} />
          <Stat label="Last passed" value={st.lastPassed ? fmtRelative(st.lastPassed.at) : 'Never'} sub={st.lastPassed?.runName} />
          <Stat label="Pass rate (30)" value={fmtPct(st.passRate)} />
          <Stat
            label="Avg duration"
            value={
              <span className="inline-flex items-center gap-1">
                {fmtDuration(st.avgDurationMs)}
                {slower ? (
                  <Tooltip content={`Latest run took ${st.durationRatio!.toFixed(1)}× the average`}>
                    <Snail className="size-3.5 text-warn" aria-label="Notably slower" />
                  </Tooltip>
                ) : null}
              </span>
            }
            sub={slower ? `Latest ${st.durationRatio!.toFixed(1)}× slower` : undefined}
          />
        </div>

        {t.history.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-xs text-fg-3">
            Never executed. Results appear here after importing allure-results that include this case.
          </p>
        ) : (
          <>
            <div className="space-y-2">
              {groups.map((g) => (
                <div key={g.group} className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-3">
                  <RunGroupChip group={g.group} className="w-fit shrink-0 sm:w-40" />
                  <div className="flex min-w-0 flex-1 flex-wrap justify-end gap-[3px] sm:flex-nowrap sm:overflow-x-auto" role="list" aria-label={`Results in ${g.group}, oldest to newest`}>
                    {g.items.map((h) => {
                      const M = RESULT_META[h.status];
                      const active = selected?.id === h.id;
                      return (
                        <Tooltip
                          key={h.id}
                          content={
                            <div>
                              <div className="font-medium">
                                {M.label} · {h.runName}
                              </div>
                              <div className="text-fg-2">
                                {fmtDateTime(h.startedAt)} · {fmtDuration(h.durationMs)}
                                {h.branch ? ` · ${h.branch}` : ''}
                              </div>
                            </div>
                          }
                        >
                          <button
                            type="button"
                            role="listitem"
                            onClick={() => setSelected(active ? null : h)}
                            aria-label={`${M.label} in ${h.runName}`}
                            aria-pressed={active}
                            className={cn(
                              'grid size-4 shrink-0 place-items-center rounded-[4px] outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
                              active && 'ring-2 ring-fg ring-offset-1 ring-offset-surface',
                            )}
                            style={{ background: M.color }}
                          >
                            {h.status !== 'passed' ? <M.icon className="size-2.5 text-white" strokeWidth={3} aria-hidden /> : null}
                          </button>
                        </Tooltip>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
            <div className="flex items-center justify-between text-[11px] text-fg-3">
              <span>Oldest</span>
              <span>Newest →</span>
            </div>
            {selected ? (
              <div className="rounded-lg border border-border bg-surface-2/50 p-3">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <ResultBadge status={selected.status} />
                  <ChangeBadge change={selected.change} />
                  <Link to={`/runs/${selected.runId}`} className="font-medium text-accent hover:underline">
                    {selected.runName}
                  </Link>
                  <span className="text-fg-3">
                    {fmtDateTime(selected.startedAt)} · {fmtDuration(selected.durationMs)}
                  </span>
                </div>
                {selected.message ? (
                  <pre className="mt-2 max-h-40 overflow-auto rounded-md border border-border bg-surface p-2 font-mono text-xs whitespace-pre-wrap text-fg-2">
                    {selected.message}
                  </pre>
                ) : null}
              </div>
            ) : null}
            <DurationChart history={filtered} />
          </>
        )}
      </CardBody>
    </Card>
  );
}

function DurationChart({ history }: { history: HistoryItem[] }) {
  const c = useCssVars(['accent', 'fg-3', 'grid', 'axis', 'surface'] as const);
  const data = [...history].reverse().filter((h) => h.durationMs != null);
  if (data.length < 3) return null;
  return (
    <div>
      <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-fg-2">
        <Clock className="size-3.5 text-fg-3" aria-hidden /> Duration trend
      </div>
      <div className="h-28" role="img" aria-label="Duration per run">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 6, right: 6, bottom: 0, left: -12 }}>
            <CartesianGrid vertical={false} stroke={c.grid} />
            <XAxis dataKey="id" hide />
            <YAxis tick={{ fontSize: 10, fill: c['fg-3'] }} tickLine={false} axisLine={false} width={44} tickFormatter={(v: number) => (v < 1000 ? `${Math.round(v)}ms` : `${(v / 1000).toFixed(v < 10000 ? 1 : 0)}s`)} />
            <RTooltip
              cursor={{ stroke: c.axis }}
              content={({ active, payload }) => {
                const p = active && payload?.[0] ? (payload[0].payload as HistoryItem) : null;
                if (!p) return null;
                return <ChartTooltipBox title={`${p.runName} · ${fmtDate(p.startedAt)}`} rows={[{ color: c.accent, label: 'Duration', value: fmtDuration(p.durationMs) }]} />;
              }}
            />
            <Line type="monotone" dataKey="durationMs" stroke={c.accent} strokeWidth={2} dot={false} activeDot={{ r: 4, stroke: c.surface, strokeWidth: 2 }} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function LatestFailure({ t }: { t: TestCaseDetail }) {
  const latest = t.history[0];
  const lastFail = latest && (latest.status === 'failed' || latest.status === 'broken') ? latest : null;
  const [showTrace, setShowTrace] = useState(false);
  // The trace isn't part of TestCaseDetail.history; fetch the run's result for this case on demand.
  const results = useRunResults(lastFail?.runId ?? 0, { search: t.key, pageSize: 20 }, { enabled: showTrace && !!lastFail });
  const trace = results.data?.items.find((r) => r.id === lastFail?.id)?.trace;
  if (!lastFail) return null;
  return (
    <Card className="border-[color-mix(in_oklab,var(--st-failed)_28%,var(--border))]">
      <CardHeader
        title="Latest failure"
        description={
          <>
            <Link to={`/runs/${lastFail.runId}`} className="hover:underline">
              {lastFail.runName}
            </Link>{' '}
            · {fmtRelative(lastFail.startedAt)}
          </>
        }
        actions={<ResultBadge status={lastFail.status} />}
      />
      <CardBody>
        <pre className="max-h-48 overflow-auto rounded-md border border-border bg-surface-2/60 p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap text-fg">
          {lastFail.message || 'No message recorded.'}
        </pre>
        <button
          type="button"
          onClick={() => setShowTrace((s) => !s)}
          aria-expanded={showTrace}
          className="mt-2 inline-flex items-center gap-1 rounded text-xs font-medium text-fg-2 outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          {showTrace ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          Stack trace
        </button>
        {showTrace ? (
          results.isPending ? (
            <Skeleton className="mt-2 h-24" />
          ) : (
            <pre className="mt-2 max-h-96 overflow-auto rounded-md border border-border bg-surface-2/60 p-3 font-mono text-[11px] leading-relaxed whitespace-pre text-fg-2">
              {trace || 'No trace recorded for this result.'}
            </pre>
          )
        ) : null}
      </CardBody>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Notes

function NotesSection({ t }: { t: TestCaseDetail }) {
  const [author, setAuthor] = useAuthor();
  const [authorDraft, setAuthorDraft] = useState('');
  const [draft, setDraft] = useState<NoteDraft>({ body: '', triage: null, ticketUrl: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const create = useCreateNote();
  const latest = t.history[0];

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const name = author || authorDraft.trim();
    const v = validateNote(draft, name);
    if (!v.ok) return setErrors({ ...v.errors, ...(v.errors.author ? { author: 'Enter your name.' } : {}) });
    if (!author) setAuthor(name);
    create.mutate(
      { ...v.value, testCaseId: t.id, resultId: latest && latest.status !== 'passed' ? latest.id : null },
      {
        onSuccess: () => {
          setDraft({ body: '', triage: null, ticketUrl: '' });
          setErrors({});
          toast.success('Note added');
        },
      },
    );
  };

  return (
    <Card>
      <CardHeader title="Notes" icon={<MessageSquare className="size-4 text-fg-3" aria-hidden />} description="Why is it failing? Triage it and link the ticket." />
      <CardBody className="space-y-4">
        <form onSubmit={submit} className="space-y-3 rounded-lg border border-border bg-surface-2/40 p-3">
          {!author ? <AuthorField value={authorDraft} onChange={setAuthorDraft} error={errors.author} /> : null}
          <NoteFields draft={draft} onChange={setDraft} errors={errors} />
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] text-fg-3">{author ? <>Posting as <b className="font-medium text-fg-2">{author}</b> · <button type="button" className="underline" onClick={() => setAuthor('')}>change</button></> : null}</span>
            <Button type="submit" variant="primary" size="sm" loading={create.isPending}>
              Add note
            </Button>
          </div>
        </form>
        {t.notes.length === 0 ? (
          <p className="py-2 text-center text-xs text-fg-3">No notes yet.</p>
        ) : (
          <ol className="space-y-3">
            {t.notes.map((n) => (
              <NoteItem key={n.id} n={n} />
            ))}
          </ol>
        )}
      </CardBody>
    </Card>
  );
}

function NoteItem({ n }: { n: Note }) {
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [draft, setDraft] = useState<NoteDraft>({ body: n.body, triage: n.triage, ticketUrl: n.ticketUrl ?? '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const update = useUpdateNote();
  const del = useDeleteNote();
  const initials = n.author
    .split(/\s+/)
    .map((p) => p[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

  const save = () => {
    const v = validateNote(draft, n.author);
    if (!v.ok) return setErrors(v.errors);
    update.mutate(
      { id: n.id, patch: { body: v.value.body, triage: v.value.triage ?? null, ticketUrl: v.value.ticketUrl ?? null } },
      { onSuccess: () => { setEditing(false); toast.success('Note updated'); } },
    );
  };

  return (
    <li className="flex gap-3">
      <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-full bg-surface-3 text-[10px] font-semibold text-fg-2" aria-hidden>
        {initials || '?'}
      </span>
      <div className="min-w-0 flex-1 rounded-lg border border-border bg-surface px-3 py-2">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="font-medium text-fg">{n.author}</span>
          <span className="text-fg-3" title={fmtDateTime(n.createdAt)}>
            {fmtRelative(n.createdAt)}
            {n.updatedAt !== n.createdAt ? ' · edited' : ''}
          </span>
          {n.triage ? <TriageBadge triage={n.triage} /> : null}
          {n.runId ? (
            <Link to={`/runs/${n.runId}`} className="text-fg-3 hover:text-fg hover:underline">
              run #{n.runId}
            </Link>
          ) : null}
          <span className="ml-auto flex items-center">
            <Button size="icon-sm" variant="ghost" aria-label="Edit note" onClick={() => setEditing((e) => !e)}>
              <Pencil className="!size-3.5" />
            </Button>
            <Button size="icon-sm" variant="ghost" aria-label="Delete note" onClick={() => setConfirm(true)}>
              <Trash2 className="!size-3.5" />
            </Button>
          </span>
        </div>
        {editing ? (
          <div className="mt-2 space-y-2">
            <NoteFields draft={draft} onChange={setDraft} errors={errors} autoFocus />
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
                Cancel
              </Button>
              <Button size="sm" variant="primary" onClick={save} loading={update.isPending}>
                Save
              </Button>
            </div>
          </div>
        ) : (
          <>
            <div className="mt-1">
              <Markdown>{n.body}</Markdown>
            </div>
            {n.ticketUrl ? (
              <ExternalLink href={n.ticketUrl} className="mt-1 text-xs" fallback={<span className="text-xs text-fg-3">{n.ticketUrl}</span>}>
                <Ticket className="size-3" aria-hidden />
                {ticketLabel(n.ticketUrl)}
              </ExternalLink>
            ) : null}
          </>
        )}
      </div>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Delete note?"
        description="This note will be permanently removed."
        loading={del.isPending}
        onConfirm={() => del.mutate(n.id, { onSuccess: () => { setConfirm(false); toast.success('Note deleted'); } })}
      />
    </li>
  );
}

function ticketLabel(url: string) {
  const m = /([A-Z][A-Z0-9_]+-\d+)/.exec(url);
  if (m) return m[1]!;
  try {
    return new URL(url).host;
  } catch {
    return 'Ticket';
  }
}

// ---------------------------------------------------------------------------

function MetaRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[110px_1fr] gap-2 py-1.5 text-[13px]">
      <dt className="text-fg-3">{label}</dt>
      <dd className="min-w-0 break-words text-fg">{children ?? <span className="text-fg-3">—</span>}</dd>
    </div>
  );
}

function MetadataCard({ t, editing, setEditing }: { t: TestCaseDetail; editing: boolean; setEditing: (e: boolean) => void }) {
  const [draft, setDraft] = useState<CaseDraft>(() => draftFromCase(t));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const update = useUpdateTestCase(t.id);
  const start = () => {
    setDraft(draftFromCase(t));
    setErrors({});
  };
  const save = () => {
    const v = validateCase(draft, 'update');
    if (!v.ok) return setErrors(v.errors);
    update.mutate(v.value, {
      onSuccess: () => {
        toast.success('Saved');
        setEditing(false);
      },
      onError: (e) => {
        if (e instanceof ApiError && e.status === 409) setErrors({ key: 'Key or Jira key already used by another case.' });
      },
    });
  };
  return (
    <Card>
      <CardHeader
        title="Details"
        actions={
          editing ? null : (
            <Button size="sm" variant="ghost" onClick={() => { start(); setEditing(true); }}>
              <Pencil /> Edit
            </Button>
          )
        }
      />
      <CardBody>
        {editing ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              save();
            }}
            className="space-y-3"
          >
            <CaseFields draft={draft} onChange={setDraft} errors={errors} />
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>
                Cancel
              </Button>
              <Button variant="primary" size="sm" type="submit" loading={update.isPending}>
                Save changes
              </Button>
            </div>
          </form>
        ) : (
          <dl className="divide-y divide-border">
            <MetaRow label="Suite">{t.suite}</MetaRow>
            <MetaRow label="Priority">{t.priority}</MetaRow>
            <MetaRow label="Owner">{t.owner}</MetaRow>
            <MetaRow label="Jira key">{t.jiraKey ? <span className="font-mono text-xs">{t.jiraKey}</span> : null}</MetaRow>
            <MetaRow label="External URL">
              {t.externalUrl ? (
                <ExternalLink href={t.externalUrl} className="break-all" fallback={<span className="break-all text-fg-3">{t.externalUrl}</span>}>
                  {t.externalUrl.replace(/^https?:\/\//, '')}
                </ExternalLink>
              ) : null}
            </MetaRow>
            <MetaRow label="Allure name">{t.allureFullName ? <span className="font-mono text-xs break-all">{t.allureFullName}</span> : null}</MetaRow>
            <MetaRow label="Allure ID">{t.allureId ? <span className="font-mono text-xs">{t.allureId}</span> : null}</MetaRow>
            <MetaRow label="Created">{fmtDate(t.createdAt)}</MetaRow>
            <MetaRow label="Updated">{fmtRelative(t.updatedAt)}</MetaRow>
          </dl>
        )}
      </CardBody>
    </Card>
  );
}

const LINKED_BY: Record<PullRequestRef['linkedBy'], string> = {
  key_in_title: 'Key mentioned in PR title',
  key_in_body: 'Key mentioned in PR description',
  key_in_branch: 'Key in branch name',
  marker_in_diff: 'Allure/pytest marker added in the diff',
  test_name_in_diff: 'Test function added in the diff',
};

function PullRequestsCard({ prs }: { prs: PullRequestRef[] }) {
  return (
    <Card>
      <CardHeader title="Linked pull requests" icon={<GitPullRequest className="size-4 text-fg-3" aria-hidden />} />
      <CardBody>
        {prs.length === 0 ? (
          <p className="text-xs text-fg-3">No linked PRs. The GitHub sync links PRs that mention this case’s key or add its test.</p>
        ) : (
          <ul className="space-y-2.5">
            {prs.map((p) => (
              <li key={`${p.repo}#${p.number}`} className="rounded-lg border border-border p-2.5">
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <ExternalLink href={p.url} className="text-[13px] font-medium text-fg" showIcon={false} fallback={<span className="text-[13px] font-medium">{p.title}</span>}>
                      <span className="line-clamp-2">{p.title}</span>
                    </ExternalLink>
                    <div className="mt-0.5 font-mono text-[11px] text-fg-3">
                      {p.repo}#{p.number}
                      {p.author ? ` · ${p.author}` : ''} · {fmtRelative(p.updatedAt)}
                    </div>
                  </div>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <PrStateBadge state={p.state} />
                  {p.state === 'open' || p.state === 'draft' ? (
                    <>
                      <ReviewBadge state={p.reviewState} />
                      <ChecksBadge checks={p.checks} />
                      <ThreadsCount count={p.unresolvedThreads} />
                    </>
                  ) : null}
                </div>
                {p.requestedReviewers.length > 0 ? (
                  <div className="mt-1.5 text-[11px] text-fg-3">Waiting on {p.requestedReviewers.join(', ')}</div>
                ) : null}
                <div className="mt-1 text-[11px] text-fg-3">Linked: {LINKED_BY[p.linkedBy]}</div>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}

function BugsCard({ t, onLog }: { t: TestCaseDetail; onLog: () => void }) {
  return (
    <Card>
      <CardHeader
        title="Bugs"
        icon={<BugIcon className="size-4 text-fg-3" aria-hidden />}
        actions={
          <Button size="sm" variant="ghost" onClick={onLog}>
            Log bug
          </Button>
        }
      />
      <CardBody>
        {t.openBugs.length === 0 ? (
          <p className="text-xs text-fg-3">No open bugs linked to this test.</p>
        ) : (
          <ul className="space-y-2">
            {t.openBugs.map((b) => (
              <li key={b.id} className="rounded-lg border border-border p-2.5">
                <div className="flex items-start gap-2">
                  <BugBadge bug={b} />
                  <span className="min-w-0 flex-1 text-[13px] text-fg">{b.title}</span>
                </div>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  <BugStatusBadge status={b.status} />
                  {b.severity ? <SeverityBadge severity={b.severity} /> : null}
                  {b.verification !== 'n/a' ? <VerificationBadge v={b.verification} /> : null}
                </div>
              </li>
            ))}
          </ul>
        )}
        <Link to={`/bugs?bucket=all`} className="mt-3 inline-block text-xs text-fg-2 hover:text-fg hover:underline">
          All bugs →
        </Link>
      </CardBody>
    </Card>
  );
}
