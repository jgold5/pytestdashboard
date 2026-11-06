import { useId, useMemo, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { CircleCheck, CircleDashed, Clock, Copy, FileInput, GitBranch, GitCompareArrows, Search, Terminal, Trash2, TriangleAlert, Zap } from 'lucide-react';
import type { TriggerChange, TriggerListResponse, TriggerRow } from '@ptd/shared';
import { useDeleteTriggerBranch, useScanGithubBranch, useTriggerBranches, useTriggerGithub, useTriggers } from '../api/hooks';
import { errorMessage } from '../api/client';
import { cn, fmtNumber, fmtPct, fmtRelative, pluralize } from '../lib/utils';
import { Button } from '../components/ui/button';
import { Card, CardBody, CardHeader } from '../components/ui/card';
import { ConfirmDialog } from '../components/ui/confirm';
import { EmptyState, ErrorState } from '../components/ui/empty-state';
import { Dialog } from '../components/ui/dialog';
import { Field, Input } from '../components/ui/input';
import { Chip, PageHeader } from '../components/ui/misc';
import { Select } from '../components/ui/select';
import { SkeletonRows } from '../components/ui/skeleton';
import { Tooltip } from '../components/ui/tooltip';

const STATUS_FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'automated', label: 'Automated' },
  { key: 'missing', label: 'Not automated' },
  { key: 'changes', label: 'Changed on this branch', compareOnly: true },
] as const;
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
  const branch = params.get('branch') || undefined;
  const compare = (branch && params.get('compare')) || undefined;
  const kind = params.get('kind') || null;
  const module = params.get('module') || null;
  const [limit, setLimit] = useState(PAGE);
  const status = (STATUS_FILTERS.find((f) => f.key === params.get('status'))?.key ?? 'all') as StatusKey;
  const [search, setSearch] = useState(params.get('q') ?? '');
  const res = useTriggers({ branch, compare });

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
  /** The triggers the folder, type and search pick: what the tiles count (the status tabs only narrow the list). */
  const scoped = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (data?.items ?? [])
      .filter((r) => !kind || r.kind === kind)
      .filter((r) => !module || r.module === module)
      .filter((r) => !q || [r.routeId, r.resolvedUri, r.sourceFile, r.filePattern, r.schedule, r.target, r.doneFile].some((v) => v?.toLowerCase().includes(q)));
  }, [data, kind, module, search]);
  const rows = useMemo(() => {
    return scoped
      .filter((r) =>
        status === 'automated'
          ? automated(r) && r.change !== 'removed'
          : status === 'missing'
            ? !automated(r) && r.change !== 'removed'
            : status === 'changes'
              ? r.change !== 'unchanged' || newlyAutomated(r) || lostTest(r)
              : true,
      )
      .sort((a, b) => (compare ? CHANGE_ORDER[a.change ?? 'unchanged'] - CHANGE_ORDER[b.change ?? 'unchanged'] : 0));
  }, [scoped, status, compare]);
  const modules = useMemo(() => [...new Set((data?.items ?? []).map((r) => r.module).filter((m): m is string => !!m))].sort(), [data]);

  const branchOptions = (data?.branches ?? []).map((b) => ({ value: b.branch, label: b.branch }));

  return (
    <>
      <PageHeader
        title="Triggers"
        description="Camel routes started by a load file or a schedule, scanned from the repo — the scope to automate, and which of it has tests."
        actions={
          data && data.branches.length > 0 ? (
            <>
              <ScanBranchButton onScanned={(b) => set({ branch: b, compare: b === 'main' ? null : compare ?? (b !== 'main' && branchOptions.some((o) => o.value === 'main') ? 'main' : null) })} />
              {branch && !DEFAULT_BRANCHES.includes(branch) ? <RemoveBranchButton branch={branch} onRemoved={() => set({ branch: null, compare: null })} /> : null}
              <Select
                size="sm"
                ariaLabel="Branch"
                value={branch ?? null}
                onValueChange={(v) => set({ branch: v, compare: v ? compare ?? null : null })}
                options={branchOptions}
                allowNone
                noneLabel="All branches"
                className="w-48"
              />
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
          <Totals data={data} items={scoped} scope={[module ? `in ${module}/` : null, kind ? (kind === 'file' ? 'load file' : 'schedule') : null, search.trim() ? `matching “${search.trim()}”` : null].filter(Boolean).join(' · ')} />
          <Sources data={data} />
          <div className="mt-4 mb-3 flex flex-wrap items-center gap-2">
            <div role="tablist" aria-label="Filter triggers" className="flex flex-wrap gap-1.5">
              {STATUS_FILTERS.filter((f) => !('compareOnly' in f) || compare).map((f) => (
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
                </button>
              ))}
            </div>
            <div className="ml-auto flex flex-wrap gap-1.5">
              {modules.length > 1 ? (
                <Select
                  size="sm"
                  ariaLabel="Folder"
                  value={module}
                  onValueChange={(v) => set({ module: v })}
                  options={modules.map((m) => ({ value: m, label: `${m} · ${fmtNumber((data?.items ?? []).filter((r) => r.module === m && r.change !== 'removed').length)}` }))}
                  allowNone
                  noneLabel="All folders"
                  className="w-48"
                />
              ) : null}
              <Select
                size="sm"
                ariaLabel="Trigger type"
                value={kind}
                onValueChange={(v) => set({ kind: v })}
                options={[
                  { value: 'file', label: 'Load file' },
                  { value: 'schedule', label: 'Schedule' },
                ]}
                allowNone
                noneLabel="All types"
                className="w-32"
              />
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
                <TriggerTable rows={rows.slice(0, limit)} showBranches={!branch} compare={compare ?? null} />
                {rows.length > limit ? (
                  <div className="border-t border-border p-2 text-center">
                    <Button size="sm" variant="ghost" onClick={() => setLimit(limit + PAGE * 5)}>
                      Show more ({fmtNumber(rows.length - limit)} not shown)
                    </Button>
                  </div>
                ) : null}
              </>
            )}
          </Card>
          {data.divergence ? <Divergence d={data.divergence} branch={data.branch ?? ''} compare={data.compare ?? ''} /> : null}
          <p className="mt-2 text-xs text-fg-3">
            {pluralize(rows.length, 'trigger')} shown. A route with several inputs, several file patterns, or a choice on the file name counts each one as its own trigger. A test covers a trigger when one of its Allure labels or pytest markers names the route id, the schedule, the job a file is sent to, or a load file the trigger picks up.
          </p>
        </>
      ) : null}
    </>
  );
}

/** Where the routes and the tests come from (they can be different repos, scanned per branch). */
function Sources({ data }: { data: TriggerListResponse }) {
  if (!data.branch) {
    return (
      <p className="mt-2 text-xs text-fg-3">
        All branches · {pluralize(data.tests.read, 'test')} read, {fmtNumber(data.tests.linked)} linked to a trigger
      </p>
    );
  }
  const part = (label: string, from: string | null, own: string) =>
    from === null ? (
      <span>
        no {label} scanned yet
      </span>
    ) : (
      <span>
        {label} from <span className={cn('font-mono', from === own ? 'text-fg' : 'text-fg-2')}>{from}</span>
        {from !== own ? ' (no scan on this branch)' : ''}
      </span>
    );
  return (
    <p className="mt-2 text-xs text-fg-3">
      {part('Routes', data.routesFrom, data.branch)} · {part('tests', data.testsFrom, data.branch)} ·{' '}
      <span className={data.tests.read > 0 && data.tests.linked === 0 ? 'text-warn' : undefined}>
        {pluralize(data.tests.read, 'test')} read, {fmtNumber(data.tests.linked)} linked to a trigger
      </span>
      {data.compare ? (
        <>
          {' '}
          — compared with routes from <span className="font-mono">{data.compareRoutesFrom ?? '—'}</span>, tests from{' '}
          <span className="font-mono">{data.compareTestsFrom ?? '—'}</span>
        </>
      ) : null}
    </p>
  );
}

/** `items`: the triggers in scope (folder, type, search), `scope`: how they were picked, for the labels. */
function Totals({ data, items, scope }: { data: TriggerListResponse; items: TriggerRow[]; scope: string }) {
  const live = items.filter((r) => r.change !== 'removed');
  const covered = live.filter(automated).length;
  const files = live.filter((r) => r.kind === 'file').length;
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
        value={fmtNumber(live.length)}
        sub={`${fmtNumber(files)} load file · ${fmtNumber(live.length - files)} schedule`}
      />
      <Tile
        label="Automated"
        value={
          <>
            {fmtPct(live.length ? covered / live.length : null, 0)}
            <span className="ml-1.5 text-sm font-medium text-fg-3">{fmtNumber(covered)}</span>
          </>
        }
        sub={data.branch ? `by tests on ${data.testsFrom ?? data.branch} only` : 'by tests on any branch'}
      />
      <Tile
        label="Not automated"
        value={fmtNumber(live.length - covered)}
        sub={live.length - covered > 0 ? (data.branch ? 'no test there names them' : 'no test names them') : 'every trigger covered'}
        tone={live.length - covered > 0 ? 'bad' : 'good'}
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

function TriggerTable({ rows, showBranches, compare }: { rows: TriggerRow[]; showBranches: boolean; compare: string | null }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[860px] text-left text-[13px]">
        <thead>
          <tr className="border-b border-border text-xs text-fg-2">
            <th className="px-4 py-2 font-medium">Route</th>
            <th className="px-2 py-2 font-medium">Trigger</th>
            <th className="px-2 py-2 font-medium">Tests</th>
            {showBranches ? <th className="px-2 py-2 font-medium">Branches</th> : null}
            {compare ? <th className="px-2 py-2 pr-4 font-medium">vs {compare}</th> : null}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={`${r.key}-${r.change ?? ''}`} className={cn('border-b border-border align-top last:border-0 hover:bg-surface-2/50', r.change === 'removed' && 'opacity-60')}>
              <td className="max-w-[260px] px-4 py-2.5">
                <div className="truncate font-medium text-fg">{r.routeId ?? <span className="text-fg-3 italic">no route id</span>}</div>
                <div className="truncate font-mono text-[11px] text-fg-3" title={`${r.sourceFile}:${r.line}`}>
                  {r.module ? <span className="font-sans text-fg-2">{r.module} · </span> : null}
                  {r.sourceFile.split('/').pop()}:{r.line}
                  {r.input > 1 ? <span className="ml-1.5 font-sans">· input {r.input}</span> : null}
                </div>
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
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TriggerSpec({ r }: { r: TriggerRow }) {
  const Icon = r.kind === 'file' ? FileInput : Clock;
  return (
    <div className="flex min-w-0 gap-2">
      <Tooltip content={r.kind === 'file' ? `Load file (${r.scheme})` : `Schedule (${r.scheme})`}>
        <Icon className="mt-0.5 size-3.5 shrink-0 text-fg-3" aria-label={r.kind === 'file' ? 'Load file' : 'Schedule'} />
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
            <div className="truncate font-mono text-xs text-fg">{r.schedule ?? <span className="text-fg-3">no schedule found</span>}</div>
            <div className="truncate font-mono text-[11px] text-fg-3" title={r.resolvedUri}>
              {r.resolvedUri.split('?')[0]}
            </div>
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

function Coverage({ r }: { r: TriggerRow }) {
  if (r.coveredBy.length === 0) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-fg-3">
        <CircleDashed className="size-3.5" aria-hidden /> Not automated
      </span>
    );
  }
  return (
    <div className="min-w-0">
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-st-passed">
        <CircleCheck className="size-3.5" aria-hidden /> {pluralize(r.coveredBy.length, 'test')}
      </span>
      <ul className="mt-0.5 space-y-0.5">
        {r.coveredBy.slice(0, 3).map((c) => {
          const name = c.test.split('::').pop();
          return (
            <li key={c.test} className="truncate text-[11px] text-fg-2" title={`${c.test} — via "${c.via}"`}>
              {c.testCaseId ? (
                <Link to={`/tests/${c.testCaseId}`} className="font-mono hover:underline">
                  {name}
                </Link>
              ) : (
                <span className="font-mono">{name}</span>
              )}
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
  const snippet = `# Run on main and on every PR branch, in each repo. Use the upload-only INGEST token.
# Camel repo: route XML and properties
git ls-files '*.xml' '*.properties' | zip -q -@ scan.zip
curl -fsS -X POST "${origin}/api/triggers/scan" -H "Authorization: Bearer $PTD_INGEST_TOKEN" \\
  --form-string "branch=$GIT_BRANCH" --form-string "commit=$GIT_COMMIT" --form-string "only=routes" \\
  -F "file=@scan.zip;type=application/zip"

# Test repo: pytest files
git ls-files '*test_*.py' '*_test.py' | zip -q -@ scan.zip
curl -fsS -X POST "${origin}/api/triggers/scan" -H "Authorization: Bearer $PTD_INGEST_TOKEN" \\
  --form-string "branch=$GIT_BRANCH" --form-string "commit=$GIT_COMMIT" --form-string "only=tests" \\
  -F "file=@scan.zip;type=application/zip"`;
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
