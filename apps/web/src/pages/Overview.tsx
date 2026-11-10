import { useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import {
  ArrowRight,
  CircleCheck,
  FileSpreadsheet,
  GitPullRequest,
  ListChecks,
  MessageSquare,
  Shuffle,
  TriangleAlert,
  Upload,
  Zap,
} from 'lucide-react';
import { folderLabel, type RouteStatus, type ScopeSource, type Summary, type TriageCategory } from '@ptd/shared';
import { useBugStats, useIntegrations, usePullRequests, useSummary, useTriggerOverview } from '../api/hooks';
import { Card, CardBody, CardHeader } from '../components/ui/card';
import { Skeleton } from '../components/ui/skeleton';
import { EmptyState, ErrorState } from '../components/ui/empty-state';
import { PageHeader, SegmentedBar } from '../components/ui/misc';
import { linkButton } from '../components/ui/link-button';
import { CoverageTrendChart } from '../components/charts/CoverageTrendChart';
import { RunTrendChart } from '../components/charts/RunTrendChart';
import { FlakyMeter, REVIEW_META, TRIAGE_META } from '../components/status';
import { PipelineFunnel, stageHref } from '../components/pipeline';
import { RunGroupChip } from '../components/RunGroup';
import { kindsLabel, ScopeButton } from '../components/ScopeButton';
import { ActiveFilters } from '../components/ActiveFilters';
import { useScopeBranch, useScopeExclude, useScopeFolder, useScopeKinds, useScopeTests } from '../lib/scopeBranch';
import { cn, fmtNumber, fmtPct, fmtRelative, pluralize } from '../lib/utils';

export function OverviewPage() {
  const [branch, setBranch] = useScopeBranch();
  const [folder, setFolder] = useScopeFolder();
  const [tests, setTests] = useScopeTests();
  const [kinds, setKinds] = useScopeKinds();
  const [exclude, setExclude] = useScopeExclude();
  const summary = useSummary(branch, folder, tests, kinds, exclude);

  if (summary.isError) return <ErrorState error={summary.error} onRetry={() => void summary.refetch()} />;
  if (!summary.data) return <OverviewSkeleton />;
  const s = summary.data;
  const empty = s.coverage.total === 0 && !s.latestRun;

  return (
    <>
      <PageHeader
        title="Overview"
        description="Automation coverage and the health of your automated runs."
        actions={
          <>
            <ScopeButton
              scope={{ branch, folder, tests, kinds, exclude }}
              onChange={(p) => {
                if ('branch' in p) setBranch(p.branch ?? null);
                if ('folder' in p) setFolder(p.folder ?? null);
                if ('tests' in p) setTests(p.tests ?? null);
                if ('kinds' in p) setKinds(p.kinds ?? null);
                if ('exclude' in p) setExclude(p.exclude ?? null);
              }}
            />
            <Link to="/import" className={linkButton('outline')}>
              <Upload /> Import
            </Link>
          </>
        }
      />
      <ActiveFilters
        className="mb-4"
        scope={{ folder, kinds, exclude }}
        onChange={(p) => {
          if ('folder' in p) setFolder(p.folder ?? null);
          if ('kinds' in p) setKinds(p.kinds ?? null);
          if ('exclude' in p) setExclude(p.exclude ?? null);
        }}
      />
      {empty ? (
        <Card>
          <EmptyState
            icon={<ListChecks />}
            title="No data yet"
            actions={
              <>
                <Link to="/import#spreadsheet" className={linkButton('primary')}>
                  <FileSpreadsheet /> Import Excel tracker
                </Link>
                <Link to="/import#allure" className={linkButton('outline')}>
                  <Upload /> Upload allure-results
                </Link>
              </>
            }
          >
            Import your Excel/CSV tracker to start from your existing inventory, or upload an allure-results folder
            from a pytest run — test cases are created automatically.
          </EmptyState>
        </Card>
      ) : (
        <div className="space-y-4">
          <KpiRow s={s} />
          <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
            <RoutesCard branch={branch} folder={folder} tests={tests} kinds={kinds} exclude={exclude} />
            <NeedsAttention s={s} />
          </div>
          <PipelineCard s={s} />
          <div className="grid gap-4 xl:grid-cols-2">
            <Card>
              <CardHeader
                title="Coverage trend"
                description={s.coverage.unit === 'routes' ? 'Daily snapshot of the default branch: triggers vs tested' : 'Daily snapshot of total vs automated cases'}
              />
              <CardBody>
                {s.coverageTrend.length > 1 ? (
                  <CoverageTrendChart data={s.coverageTrend} totalLabel={s.coverage.unit === 'routes' ? 'Triggers' : 'Total cases'} />
                ) : (
                  <EmptyChart>The trend appears after the inventory changes on at least two days.</EmptyChart>
                )}
              </CardBody>
            </Card>
            <RunTrendCard s={s} />
          </div>
          <div className="grid gap-4 xl:grid-cols-3">
            <SuiteCard s={s} className="xl:col-span-2 xl:row-span-2" />
            <PrPipelineCard s={s} />
            <TriageCard s={s} />
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <FlakyCard s={s} />
            <OwnerCard s={s} />
          </div>
        </div>
      )}
    </>
  );
}

function EmptyChart({ children }: { children: ReactNode }) {
  return (
    <div className="grid h-[220px] place-items-center rounded-lg border border-dashed border-border text-center text-xs text-fg-3">
      <p className="max-w-60">{children}</p>
    </div>
  );
}

function OverviewSkeleton() {
  return (
    <div className="space-y-4" role="status" aria-label="Loading overview">
      <Skeleton className="h-7 w-40" />
      <Skeleton className="h-[92px]" />
      <Skeleton className="h-36" />
      <div className="grid gap-4 xl:grid-cols-2">
        <Skeleton className="h-72" />
        <Skeleton className="h-72" />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function Kpi({
  label,
  value,
  sub,
  to,
  tone,
  className,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  to?: string;
  tone?: 'bad' | 'good';
  className?: string;
}) {
  const inner = (
    <>
      <div className="text-[11px] font-semibold tracking-[0.07em] text-fg-3 uppercase">{label}</div>
      <div className="mt-1.5 font-mono text-[26px] leading-none font-medium tracking-tight text-fg tabular">{value}</div>
      {sub ? (
        <div className={cn('mt-2 truncate text-xs', tone === 'bad' ? 'text-bad' : tone === 'good' ? 'text-good' : 'text-fg-2')}>
          {sub}
        </div>
      ) : null}
    </>
  );
  const cls = cn('block min-w-0 bg-surface px-4 py-3.5', className);
  return to ? (
    <Link to={to} className={cn(cls, 'outline-none transition-colors hover:bg-surface-2 focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-ring/50')}>
      {inner}
    </Link>
  ) : (
    <div className={cls}>{inner}</div>
  );
}

/** The Triggers page showing the same branch and folder as the numbers. */
function triggersHref(c: Summary['coverage'], status?: 'automated' | 'missing'): string {
  const p = new URLSearchParams({ branch: c.branch ?? 'main' });
  if (c.folder) p.set('module', c.folder);
  if (c.kinds?.length) p.set('kinds', c.kinds.join(','));
  if (c.exclude) p.set('exclude', c.exclude);
  if (status) p.set('status', status);
  return `/triggers?${p.toString()}`;
}

function KpiRow({ s }: { s: Summary }) {
  const c = s.coverage;
  const lr = s.latestRun;
  return (
    <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border md:grid-cols-3 xl:grid-cols-5">
      {c.unit === 'routes' ? (
        <Kpi
          label="Unique triggers"
          value={fmtNumber(c.total)}
          sub={`${c.folder ? `in ${folderLabel(c.folder)} on ${c.branch ?? 'main'}` : `in the trigger repo on ${c.branch ?? 'main'}`}${c.kinds?.length ? ` · ${kindsLabel(c.kinds.join(','))} only` : ''}`}
          to={triggersHref(c)}
        />
      ) : (
        <Kpi label="Total cases" value={fmtNumber(c.total)} sub={`${fmtNumber(c.notAutomatable)} not automatable`} to="/tests" />
      )}
      {c.unit === 'routes' ? (
        <Kpi
          label="Triggers tested"
          value={
            <>
              {fmtNumber(c.automated)}
              <span className="ml-1.5 text-sm text-fg-3">of {fmtNumber(c.total)}</span>
            </>
          }
          sub={
            (c.unmerged ?? 0) > 0
              ? `${fmtPct(c.automationRate, 1)} · ${fmtNumber(c.unmerged ?? 0)} not merged yet`
              : `${fmtPct(c.automationRate, 1)} have one or more tests`
          }
          to={triggersHref(c, 'automated')}
        />
      ) : (
        <Kpi
          label="Automated"
          value={
            <>
              {fmtPct(c.automationRate, 1)}
              <span className="ml-1.5 text-sm text-fg-3">{fmtNumber(c.automated)}</span>
            </>
          }
          sub="of automatable cases"
          to="/tests?automationStatus=automated"
        />
      )}
      {c.unit === 'routes' ? (
        <Kpi label="No test yet" value={fmtNumber(c.notAutomated)} sub="no test on any scanned branch" to={triggersHref(c, 'missing')} />
      ) : (
        <Kpi
          label="In progress"
          value={fmtNumber(c.inProgress)}
          sub={
            <span className="inline-flex items-center gap-1">
              <GitPullRequest className="size-3" aria-hidden /> {fmtNumber(c.inOpenPr)} in open PRs
            </span>
          }
          to="/tests?automationStatus=in_progress"
        />
      )}
      <Kpi
        label="Last run pass rate"
        value={fmtPct(lr?.passRate, 1)}
        sub={
          lr ? (
            lr.changes.newFailures > 0 ? (
              <>▲ {pluralize(lr.changes.newFailures, 'new failure')}</>
            ) : (
              <>{lr.name} · {fmtRelative(lr.startedAt ?? lr.importedAt)}</>
            )
          ) : (
            'No runs yet'
          )
        }
        tone={lr && lr.changes.newFailures > 0 ? 'bad' : undefined}
        to={lr ? `/runs/${lr.id}` : '/runs'}
      />
      <Kpi
        label="Untriaged failures"
        value={fmtNumber(s.untriagedFailures)}
        sub={s.untriagedFailures > 0 ? 'Need a note or triage' : 'All failures triaged'}
        tone={s.untriagedFailures > 0 ? 'bad' : 'good'}
        to="/tests?lastStatus=failed"
        className="col-span-2 xl:col-span-1"
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Automation pipeline: progress bar + the GitHub-driven stage funnel

function PipelineCard({ s }: { s: Summary }) {
  const c = s.coverage;
  const automatable = c.total - c.notAutomatable;
  return (
    <Card>
      <CardHeader
        title="Automation progress"
        description={
          c.unit === 'routes'
            ? `${fmtNumber(c.automated)} of ${fmtNumber(automatable)} triggers have one or more tests${(c.unmerged ?? 0) > 0 ? ` (${fmtNumber(c.unmerged ?? 0)} not merged yet)` : ''} · stages below follow the test cases' PRs`
            : `${fmtNumber(c.automated)} of ${fmtNumber(automatable)} automatable cases automated · pipeline from GitHub PRs and runs`
        }
        actions={<span className="text-2xl font-semibold tracking-tight text-fg">{fmtPct(c.automationRate, 1)}</span>}
      />
      <CardBody>
        {/* Tall segmented bar: one whole split into parts; labels only where they fit. */}
        <div
          className="flex h-7 w-full gap-[2px] overflow-hidden rounded-md"
          role="img"
          aria-label={`Automated ${c.automated}, in progress ${c.inProgress}, not automated ${c.notAutomated}, not automatable ${c.notAutomatable}`}
        >
          {[
            { label: 'Automated', v: c.automated, color: 'var(--au-automated)', ink: '#fff' },
            { label: 'In progress', v: c.inProgress, color: 'var(--au-progress)', ink: '#0b0b0b' },
            { label: 'Not automated', v: c.notAutomated, color: 'var(--au-not)', ink: 'var(--fg)' },
          ]
            .filter((p) => p.v > 0)
            .map((p) => {
              const share = automatable > 0 ? p.v / automatable : 0;
              return (
                <div
                  key={p.label}
                  className="flex h-full min-w-[3px] items-center rounded-[4px] px-2 text-xs font-medium"
                  style={{ width: `${share * 100}%`, background: p.color, color: p.ink }}
                  title={`${p.label}: ${p.v} (${fmtPct(share)})`}
                >
                  {share >= 0.09 ? fmtPct(share) : null}
                </div>
              );
            })}
        </div>
        <PipelineFunnel counts={s.pipeline} className="mt-4" />
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[11px] text-fg-3">
          <span>Stages are derived from linked GitHub PRs (draft → review → approved → merged) and the next run after a merge.</span>
          <Link
            to={stageHref('not_automatable')}
            className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 outline-none hover:bg-surface-2 hover:text-fg focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <span className="hatch inline-block size-2.5 rounded-[3px] border border-border" aria-hidden />
            {fmtNumber(c.notAutomatable)} not automatable (excluded from %)
          </Link>
        </div>
      </CardBody>
    </Card>
  );
}

// ---------------------------------------------------------------------------

function RunTrendCard({ s }: { s: Summary }) {
  const groups = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of s.runTrend) m.set(r.runGroup, (m.get(r.runGroup) ?? 0) + 1);
    return [...m.entries()].map(([name, runs]) => ({ name, runs }));
  }, [s.runTrend]);
  const latestGroup = s.runTrend[s.runTrend.length - 1]?.runGroup ?? null;
  const [group, setGroup] = useState<string | null>(null);
  const active = group ?? latestGroup;
  const data = s.runTrend.filter((r) => r.runGroup === active);

  return (
    <Card>
      <CardHeader
        title="Results per run"
        description={`Last ${data.length} ${data.length === 1 ? 'run' : 'runs'} of this group by status — click a bar to open the run`}
        actions={
          groups.length > 1 ? (
            <select
              aria-label="Run group"
              value={active ?? ''}
              onChange={(e) => setGroup(e.target.value)}
              className="h-7 max-w-44 rounded-md border border-border-strong/70 bg-surface px-2 font-mono text-[11px] text-fg"
            >
              {groups.map((g) => (
                <option key={g.name} value={g.name}>
                  {g.name}
                </option>
              ))}
            </select>
          ) : active ? (
            <RunGroupChip group={active} />
          ) : null
        }
      />
      <CardBody>
        {data.length > 0 ? (
          <RunTrendChart data={data} />
        ) : (
          <EmptyChart>
            No runs yet. <Link to="/import#allure" className="link">Upload allure-results</Link> to
            see pass rates.
          </EmptyChart>
        )}
      </CardBody>
    </Card>
  );
}

function SuiteCard({ s, className }: { s: Summary; className?: string }) {
  const rows = [...s.bySuite].sort((a, b) => b.total - a.total);
  return (
    <Card className={className}>
      <CardHeader title="By suite" description="Automation coverage and last-result health per suite" />
      {rows.length === 0 ? (
        <CardBody>
          <p className="text-xs text-fg-3">No suites yet.</p>
        </CardBody>
      ) : (
        <div className="max-h-[360px] overflow-auto">
          <table className="w-full text-[13px]">
            <thead className="sticky top-0 z-10 bg-surface text-left text-[11px] font-medium tracking-wide text-fg-3 uppercase">
              <tr className="border-b border-border">
                <th className="px-4 py-2 font-medium">Suite</th>
                <th className="w-[34%] px-2 py-2 font-medium">Coverage</th>
                <th className="px-2 py-2 text-right font-medium">Cases</th>
                <th className="hidden px-4 py-2 text-right font-medium sm:table-cell">Pass / Fail</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                // Same definition as the headline rate: not-automatable cases are excluded.
                const automatable = r.total - r.notAutomatable;
                const rate = automatable > 0 ? r.automated / automatable : null;
                return (
                  <tr key={r.suite} className="border-b border-border last:border-0 hover:bg-surface-2/60">
                    <td className="max-w-0 px-4 py-2">
                      <Link
                        to={r.suite === '(none)' ? '/tests' : `/tests?suite=${encodeURIComponent(r.suite)}`}
                        className="block truncate text-fg hover:underline"
                      >
                        {r.suite}
                      </Link>
                    </td>
                    <td className="px-2 py-2">
                      <div className="flex items-center gap-2">
                        <SegmentedBar
                          label={`${r.suite} coverage`}
                          height={6}
                          parts={[
                            { label: 'Automated', value: r.automated, color: 'var(--au-automated)' },
                            { label: 'In progress', value: r.inProgress, color: 'var(--au-progress)' },
                            { label: 'Not automated', value: Math.max(0, automatable - r.automated - r.inProgress), color: 'var(--au-not)' },
                          ]}
                        />
                        <span className="w-10 shrink-0 text-right text-xs text-fg-2 tabular">{fmtPct(rate)}</span>
                      </div>
                    </td>
                    <td className="px-2 py-2 text-right text-fg-2 tabular">{fmtNumber(r.total)}</td>
                    <td className="hidden px-4 py-2 text-right text-xs tabular sm:table-cell">
                      <span className="text-fg-2">{r.passing}</span>
                      <span className="text-fg-3"> / </span>
                      <span className={r.failing > 0 ? 'font-medium text-bad' : 'text-fg-3'}>{r.failing}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function PrPipelineCard({ s }: { s: Summary }) {
  const p = s.prPipeline;
  const stages = [
    { label: 'Draft', value: p.draft, color: 'var(--fg-3)', to: '/pulls?filter=draft' },
    { label: REVIEW_META.review_required.label, value: p.reviewRequired, color: 'var(--warn)', to: '/pulls?filter=review_required' },
    { label: REVIEW_META.changes_requested.label, value: p.changesRequested, color: 'var(--st-failed)', to: '/pulls?filter=changes_requested' },
    { label: REVIEW_META.approved.label, value: p.approved, color: 'var(--st-passed)', to: '/pulls?filter=approved' },
  ];
  const max = Math.max(1, ...stages.map((x) => x.value));
  return (
    <Card>
      <CardHeader
        title="PR pipeline"
        icon={<GitPullRequest className="size-4 text-fg-3" aria-hidden />}
        description={`${pluralize(p.open, 'open automation PR')}`}
        actions={
          <Link to="/pulls" className={linkButton('ghost', 'sm')}>
            View all
          </Link>
        }
      />
      <CardBody>
        {p.open === 0 && p.draft === 0 ? (
          <p className="py-6 text-center text-xs text-fg-3">
            No open automation PRs. Connect GitHub on the{' '}
            <Link to="/integrations" className="link">
              Integrations
            </Link>{' '}
            page to track them.
          </p>
        ) : (
          <>
            <ol className="space-y-2">
              {stages.map((st) => (
                <li key={st.label}>
                  <Link to={st.to} className="group flex items-center gap-3 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
                    <span className="w-36 shrink-0 text-xs text-fg-2 group-hover:text-fg">{st.label}</span>
                    <span className="h-2 flex-1 overflow-hidden rounded-full bg-surface-2">
                      <span
                        className="block h-full rounded-full"
                        style={{ width: `${(st.value / max) * 100}%`, background: st.color, minWidth: st.value ? 6 : 0 }}
                      />
                    </span>
                    <span className="w-6 text-right text-[13px] font-semibold text-fg tabular">{st.value}</span>
                  </Link>
                </li>
              ))}
            </ol>
            <div className="mt-4 flex items-center gap-2 text-xs text-fg-2">
              <MessageSquare className="size-3.5 text-fg-3" aria-hidden />
              {pluralize(p.unresolvedThreads, 'unresolved comment thread')}
            </div>
            {p.needsAttention > 0 ? (
              <Link
                to="/pulls?filter=attention"
                className="mt-3 flex items-center gap-2 rounded-lg border border-[color-mix(in_oklab,var(--st-failed)_30%,transparent)] bg-[color-mix(in_oklab,var(--st-failed)_8%,transparent)] px-3 py-2 text-xs text-fg outline-none hover:bg-[color-mix(in_oklab,var(--st-failed)_12%,transparent)] focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                <TriangleAlert className="size-4 shrink-0 text-st-failed" aria-hidden />
                <span className="flex-1">
                  <b className="font-semibold">{p.needsAttention}</b> PR{p.needsAttention === 1 ? '' : 's'} need attention
                </span>
                <ArrowRight className="size-3.5 text-fg-3" aria-hidden />
              </Link>
            ) : null}
          </>
        )}
      </CardBody>
    </Card>
  );
}

function TriageCard({ s }: { s: Summary }) {
  const rows = [...s.triageBreakdown].sort((a, b) => b.count - a.count);
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <Card>
      <CardHeader
        title="Triage breakdown"
        description={s.untriagedFailures > 0 ? `${s.untriagedFailures} failures still untriaged` : 'Why failing cases fail'}
      />
      <CardBody>
        {rows.length === 0 ? (
          <p className="py-4 text-xs text-fg-3">No triaged failures yet. Add a note with a triage category on a failing case.</p>
        ) : (
          <ul className="space-y-2.5">
            {rows.map((r) => {
              const m = TRIAGE_META[r.triage as TriageCategory];
              return (
                <li key={r.triage}>
                  <Link to={`/tests?triage=${r.triage}`} className="group flex items-center gap-2 outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
                    <m.icon className="size-3.5 shrink-0" style={{ color: m.color }} aria-hidden />
                    <span className="w-32 shrink-0 truncate text-xs text-fg-2 group-hover:text-fg">{m.label}</span>
                    <span className="h-2 flex-1 overflow-hidden rounded-full bg-surface-2">
                      <span className="block h-full rounded-full" style={{ width: `${(r.count / max) * 100}%`, background: m.color }} />
                    </span>
                    <span className="w-6 text-right text-xs font-medium text-fg tabular">{r.count}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}

function FlakyCard({ s }: { s: Summary }) {
  return (
    <Card>
      <CardHeader
        title="Top flaky"
        icon={<Shuffle className="size-4 text-fg-3" aria-hidden />}
        actions={
          <Link to="/tests?flakyOnly=true&sort=flakiness&order=desc" className={linkButton('ghost', 'sm')}>
            All flaky
          </Link>
        }
      />
      <CardBody className="px-2">
        {s.topFlaky.length === 0 ? (
          <p className="px-2 py-4 text-xs text-fg-3">No flaky tests detected. Nice.</p>
        ) : (
          <ul>
            {s.topFlaky.slice(0, 8).map((t) => (
              <li key={t.id}>
                <Link to={`/tests/${t.id}`} className="flex items-center gap-3 rounded-md px-2 py-1.5 outline-none hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-ring/50">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] text-fg">{t.title}</span>
                    <span className="block truncate font-mono text-[11px] text-fg-3">{t.key}</span>
                  </span>
                  <FlakyMeter value={t.flakiness} />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}

function OwnerCard({ s }: { s: Summary }) {
  const rows = [...s.byOwner].sort((a, b) => b.total - a.total).slice(0, 10);
  return (
    <Card>
      <CardHeader title="By owner" />
      <CardBody>
        {rows.length === 0 ? (
          <p className="py-4 text-xs text-fg-3">No owners assigned yet.</p>
        ) : (
          <ul className="space-y-2.5">
            {rows.map((r) => (
              <li key={r.owner}>
                <Link to={`/tests?owner=${encodeURIComponent(r.owner)}`} className="group block outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
                  <div className="mb-1 flex items-center justify-between text-xs">
                    <span className="truncate text-fg-2 group-hover:text-fg">{r.owner}</span>
                    <span className="text-fg-3 tabular">
                      <span className="text-fg">{r.automated}</span> / {r.total - r.notAutomatable} · {fmtPct(r.total - r.notAutomatable > 0 ? r.automated / (r.total - r.notAutomatable) : null)}
                    </span>
                  </div>
                  <SegmentedBar
                    label={`${r.owner} automation`}
                    height={4}
                    parts={[
                      { label: 'Automated', value: r.automated, color: 'var(--au-automated)' },
                      { label: 'Not yet', value: Math.max(0, r.total - r.notAutomatable - r.automated), color: 'var(--au-not)' },
                    ]}
                  />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}


/** Prominent callout: bugs marked resolved whose linked tests still fail. */

// ---------------------------------------------------------------------------
// Route triggers on the default branch: what still needs a test

const ROUTE_STATUS: Record<RouteStatus, { label: string; tab: string; cls: string }> = {
  none: { label: 'No test', tab: 'No test', cls: 'text-fg-3' },
  branch: { label: 'Test not merged', tab: 'Not merged', cls: 'text-fg' },
  tested: { label: 'Tested', tab: 'Merged', cls: 'text-st-passed' },
};
const shortTest = (nodeId: string) => nodeId.split('::').pop() ?? nodeId;

/** One of the two scans the numbers come from: which repo, branch and commit, and what it found. */
function SourceStep({
  n,
  title,
  source,
  big,
  detail,
}: {
  n: number;
  title: string;
  source: ScopeSource | null;
  big: string;
  detail?: ReactNode;
}) {
  return (
    <div className="min-w-0 bg-surface px-4 py-3">
      <div className="flex items-center gap-2 text-[11px] font-semibold tracking-[0.07em] text-fg-3 uppercase">
        <span className="grid size-4 place-items-center rounded-full border border-border-strong font-mono text-[10px] tracking-normal text-fg-2">{n}</span>
        {title}
      </div>
      <div className="mt-1.5 text-[15px] font-semibold text-fg">{big}</div>
      {source ? (
        <div className="mt-0.5 truncate font-mono text-[11.5px] text-fg-3" title={source.repo ?? undefined}>
          {source.repo ?? 'uploaded scan'} @ {source.branch}
          {source.commit ? ` · ${source.commit.slice(0, 7)}` : ''} · {fmtRelative(source.scannedAt)}
        </div>
      ) : null}
      {detail ? <div className="mt-0.5 truncate text-xs text-fg-2">{detail}</div> : null}
    </div>
  );
}

function RoutesCard({ branch, folder, tests, kinds, exclude }: { branch: string | null; folder: string | null; tests: string | null; kinds: string | null; exclude: string | null }) {
  const [status, setStatus] = useState<RouteStatus | undefined>(undefined);
  const q = useTriggerOverview(status, 8, branch, folder, tests, kinds, exclude);
  const d = q.data;
  if (q.isPending) return <Skeleton className="h-[360px]" />;
  if (q.isError || !d) return <Card><ErrorState error={q.error} onRetry={() => void q.refetch()} /></Card>;
  if (!d.branch) {
    return (
      <Card>
        <EmptyState
          icon={<Zap />}
          title="No routes scanned yet"
          actions={
            <Link to="/triggers" className={linkButton('primary')}>
              Scan a branch
            </Link>
          }
        >
          Scan the Camel repo to list every route trigger (load file, schedule, direct, queue, Kafka, REST), and see which ones a test covers.
        </EmptyState>
      </Card>
    );
  }
  const shown = d.status;
  const total = d.counts[shown];
  const allParams = new URLSearchParams({ branch: d.branch });
  if (d.folder) allParams.set('module', d.folder);
  if (d.kinds) allParams.set('kinds', d.kinds.join(','));
  if (d.exclude) allParams.set('exclude', d.exclude);
  if (shown !== 'branch') allParams.set('status', shown === 'tested' ? 'automated' : 'missing');
  const allHref = `/triggers?${allParams.toString()}`;
  const where = `${d.kinds ? ` (${kindsLabel(d.kinds.join(','))})` : ''}${d.folder ? ` in ${folderLabel(d.folder)}` : ''}`;
  return (
    <Card>
      <div className="grid gap-px border-b border-border bg-border sm:grid-cols-2">
        <SourceStep
          n={1}
          title="Trigger repo"
          source={d.triggerRepo}
          big={d.triggerRepo ? `${fmtNumber(d.triggerRepo.triggers)} unique triggers${where}` : '—'}
          detail={d.triggerRepo && d.triggerRepo.routes !== d.triggerRepo.triggers ? `in ${pluralize(d.triggerRepo.routes, 'route')} (a route with several patterns counts each one)` : undefined}
        />
        <SourceStep
          n={2}
          title="Test repo"
          source={d.testRepo}
          big={d.testRepo ? `${fmtNumber(d.counts.tested + d.counts.branch)} ${where ? 'of them' : 'triggers'} have one or more tests` : 'Not scanned yet'}
          detail={
            d.testRepo ? (
              `${fmtNumber(d.counts.tested)} merged, ${fmtNumber(d.counts.branch)} only in unmerged branches · ${pluralize(d.testRepo.tests, 'test')} on ${d.testRepo.branch}`
            ) : (
              <Link to="/triggers" className="link">
                Scan the test repo's {d.branch}
              </Link>
            )
          }
        />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 pt-3 pb-2">
        <h2 className="text-[13px] font-semibold text-fg">
          Triggers{d.folder ? <> in <span className="font-mono">{folderLabel(d.folder)}</span></> : null} on <span className="font-mono">{d.branch}</span>
        </h2>
        <div role="group" aria-label="Route status" className="inline-flex rounded-md border border-border bg-surface-2 p-0.5">
          {(['none', 'branch', 'tested'] as const).map((k) => (
            <button
              key={k}
              type="button"
              aria-pressed={shown === k}
              onClick={() => setStatus(k)}
              className={cn(
                'inline-flex h-6 items-center gap-1.5 rounded-[5px] px-2.5 text-xs font-medium whitespace-nowrap outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50',
                shown === k ? 'bg-surface text-fg shadow-sm' : 'text-fg-2 hover:text-fg',
              )}
            >
              {ROUTE_STATUS[k].tab}
              <span className="font-mono text-[11px] text-fg-3 tabular">{fmtNumber(d.counts[k])}</span>
            </button>
          ))}
        </div>
      </div>
      {d.items.length === 0 ? (
        <p className="px-4 pt-2 pb-5 text-[13px] text-fg-3">
          {shown === 'none' ? 'Every trigger on this branch has a test.' : shown === 'branch' ? 'No trigger is covered only by an unmerged branch.' : 'No trigger has a merged test yet.'}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-y border-border text-left text-[11px] font-semibold tracking-[0.06em] text-fg-3 uppercase">
                <th scope="col" className="px-4 py-2 font-semibold">Route</th>
                <th scope="col" className="px-3 py-2 font-semibold">Kind</th>
                <th scope="col" className="px-3 py-2 font-semibold">Fires on</th>
                <th scope="col" className="px-3 py-2 font-semibold">{shown === 'branch' ? 'Branch' : 'Test'}</th>
                <th scope="col" className="px-4 py-2 font-semibold">Status</th>
              </tr>
            </thead>
            <tbody>
              {d.items.map((r) => {
                const name = r.routeId ?? r.key;
                return (
                  <tr key={r.key} className="border-b border-border last:border-b-0 hover:bg-surface-2/60">
                    <td className="max-w-64 px-4 py-2">
                      <Link
                        to={`/triggers?branch=${encodeURIComponent(d.branch!)}&q=${encodeURIComponent(name)}`}
                        className="block truncate font-mono font-medium text-fg outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/50"
                        title={name}
                      >
                        {name}
                      </Link>
                      {r.module ? <div className="truncate text-[11px] text-fg-3">{r.module}</div> : null}
                    </td>
                    <td className="px-3 py-2 font-mono text-xs text-fg-2">{r.scheme}</td>
                    <td className="max-w-56 truncate px-3 py-2 font-mono text-xs text-fg-2" title={r.firesOn}>
                      {r.firesOn}
                    </td>
                    <td className="max-w-56 truncate px-3 py-2 font-mono text-xs text-fg-2" title={(r.status === 'branch' ? r.branches : r.tests).join('\n')}>
                      {r.status === 'branch'
                        ? r.branches.join(', ')
                        : r.tests.length > 0
                          ? shortTest(r.tests[0]!) + (r.tests.length > 1 ? ` +${r.tests.length - 1}` : '')
                          : '—'}
                    </td>
                    <td className="px-4 py-2 whitespace-nowrap">
                      <span className={cn('inline-flex items-center gap-1.5 text-xs font-medium', ROUTE_STATUS[r.status].cls)}>
                        <span className="size-1.5 rounded-full bg-current" aria-hidden />
                        {ROUTE_STATUS[r.status].label}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {total > d.items.length ? (
        <div className="border-t border-border px-4 py-2.5 text-xs">
          <Link to={allHref} className="link">
            All {fmtNumber(total)} on Triggers
          </Link>
        </div>
      ) : null}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Needs attention: everything someone should act on, most urgent first

type Severity = 'bad' | 'warn' | 'info';
interface AttentionItem {
  id: string;
  severity: Severity;
  title: string;
  detail?: ReactNode;
  to: string;
  children?: ReactNode;
}
const STRIPE: Record<Severity, string> = { bad: 'bg-st-failed', warn: 'bg-warn', info: 'bg-fg-3' };

function NeedsAttention({ s }: { s: Summary }) {
  const bugs = useBugStats();
  const integrations = useIntegrations();
  const ready = s.pipeline.ready_to_merge;
  const prs = usePullRequests({ readyToMerge: true });
  const items: AttentionItem[] = [];

  const stillFailing = bugs.data?.stillFailingAfterFix ?? 0;
  if (stillFailing > 0)
    items.push({
      id: 'still-failing',
      severity: 'bad',
      title: `${pluralize(stillFailing, 'bug')} resolved but still failing`,
      detail: 'Linked tests failed in runs after the fix',
      to: '/bugs?bucket=resolved&verification=still_failing',
    });
  const lr = s.latestRun;
  if (lr && lr.changes.newFailures > 0)
    items.push({
      id: 'new-failures',
      severity: 'bad',
      title: `${pluralize(lr.changes.newFailures, 'new failure')} in the last run`,
      detail: <>{lr.name} · {fmtRelative(lr.startedAt ?? lr.importedAt)}</>,
      to: `/runs/${lr.id}`,
    });
  for (const i of integrations.data ?? []) {
    if (i.configured && i.state === 'error')
      items.push({
        id: `sync-${i.name}`,
        severity: 'bad',
        title: `${i.name === 'jira' ? 'Jira' : 'GitHub'} sync failed`,
        detail: i.lastError ?? undefined,
        to: '/integrations',
      });
  }
  if (s.untriagedFailures > 0)
    items.push({
      id: 'untriaged',
      severity: 'warn',
      title: `${pluralize(s.untriagedFailures, 'failure')} without triage`,
      detail: 'Add a note or a triage category',
      to: '/tests?lastStatus=failed',
    });
  if (ready > 0) {
    const c = s.coverage;
    const automatable = c.total - c.notAutomatable;
    const projected = c.unit === 'cases' && automatable > 0 ? (c.automated + ready) / automatable : null;
    const list = [...(prs.data ?? [])].sort((a, b) => (a.approvedAt ?? a.updatedAt).localeCompare(b.approvedAt ?? b.updatedAt));
    items.push({
      id: 'ready',
      severity: 'info',
      title: `${pluralize(ready, 'test')} approved, waiting on merge`,
      detail:
        projected !== null ? (
          <>
            Merging takes automation from {fmtPct(c.automationRate, 1)} to {fmtPct(projected, 1)}
          </>
        ) : (
          `${pluralize(s.prPipeline.readyToMerge, 'approved PR')} with green checks`
        ),
      to: '/pulls?filter=ready',
      children:
        list.length > 0 ? (
          <ul className="mt-1.5 space-y-0.5">
            {list.slice(0, 3).map((p) => (
              <li key={p.id}>
                <a href={p.url} target="_blank" rel="noopener noreferrer" className="group block rounded px-1 py-0.5 -mx-1 outline-none hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-ring/50">
                  <span className="block truncate text-xs text-fg group-hover:underline">{p.title}</span>
                  <span className="block truncate font-mono text-[11px] text-fg-3">
                    {p.repo}#{p.number} · {p.approvedAt ? `approved ${fmtRelative(p.approvedAt)}` : `updated ${fmtRelative(p.updatedAt)}`}
                  </span>
                </a>
              </li>
            ))}
            {list.length > 3 ? (
              <li>
                <Link to="/pulls?filter=ready" className="link text-[11px] text-fg-3">
                  +{list.length - 3} more
                </Link>
              </li>
            ) : null}
          </ul>
        ) : null,
    });
  }

  return (
    <Card>
      <section aria-labelledby="attention-title">
        <CardHeader title={<span id="attention-title">Needs attention</span>} />
        {items.length === 0 ? (
          <p className="flex items-center gap-2 px-4 pt-1 pb-4 text-[13px] text-fg-2">
            <CircleCheck className="size-4 text-st-passed" aria-hidden /> Nothing needs attention right now.
          </p>
        ) : (
          <ul className="pb-2">
            {items.map((it) => (
              <li key={it.id} className="flex gap-3 px-4 py-2">
                <span className={cn('w-[3px] shrink-0 self-stretch rounded-full', STRIPE[it.severity])} aria-hidden />
                <div className="min-w-0 flex-1">
                  <Link to={it.to} className="text-[13px] font-medium text-fg outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/50">
                    {it.title}
                  </Link>
                  {it.detail ? <div className="truncate text-xs text-fg-3">{it.detail}</div> : null}
                  {it.children}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </Card>
  );
}
