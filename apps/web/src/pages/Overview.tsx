import { useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import {
  ArrowRight,
  Bot,
  CircleDashed,
  FileSpreadsheet,
  GitPullRequest,
  ListChecks,
  MessageSquare,
  Shuffle,
  TriangleAlert,
  Upload,
} from 'lucide-react';
import type { Summary, TriageCategory } from '@ptd/shared';
import { useBugStats, useSummary } from '../api/hooks';
import { Card, CardBody, CardHeader } from '../components/ui/card';
import { Skeleton } from '../components/ui/skeleton';
import { EmptyState, ErrorState } from '../components/ui/empty-state';
import { PageHeader, SegmentedBar } from '../components/ui/misc';
import { linkButton } from '../components/ui/link-button';
import { CoverageTrendChart } from '../components/charts/CoverageTrendChart';
import { RunTrendChart } from '../components/charts/RunTrendChart';
import { FlakyMeter, REVIEW_META, Swatch, TRIAGE_META } from '../components/status';
import { RunGroupChip } from '../components/RunGroup';
import { cn, fmtNumber, fmtPct, fmtRelative, pluralize } from '../lib/utils';

export function OverviewPage() {
  const summary = useSummary();

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
          <Link to="/import" className={linkButton('outline')}>
            <Upload /> Import
          </Link>
        }
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
          <StillFailingCallout />
          <PipelineCard s={s} />
          <div className="grid gap-4 xl:grid-cols-2">
            <Card>
              <CardHeader title="Coverage trend" description="Daily snapshot of total vs automated cases" />
              <CardBody>
                {s.coverageTrend.length > 1 ? (
                  <CoverageTrendChart data={s.coverageTrend} />
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
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        {Array.from({ length: 5 }, (_, i) => (
          <Skeleton key={i} className="h-[92px]" />
        ))}
      </div>
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
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  to?: string;
  tone?: 'bad' | 'good';
}) {
  const inner = (
    <>
      <div className="text-xs font-medium text-fg-2">{label}</div>
      <div className="mt-1.5 text-[26px] leading-none font-semibold tracking-tight text-fg">{value}</div>
      {sub ? (
        <div className={cn('mt-2 truncate text-xs', tone === 'bad' ? 'text-bad' : tone === 'good' ? 'text-good' : 'text-fg-3')}>
          {sub}
        </div>
      ) : null}
    </>
  );
  const cls = 'block rounded-xl border border-border bg-surface px-4 py-3.5 shadow-sm';
  return to ? (
    <Link to={to} className={cn(cls, 'outline-none transition-colors hover:border-border-strong focus-visible:ring-2 focus-visible:ring-ring/50')}>
      {inner}
    </Link>
  ) : (
    <div className={cls}>{inner}</div>
  );
}

function KpiRow({ s }: { s: Summary }) {
  const c = s.coverage;
  const lr = s.latestRun;
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
      <Kpi label="Total cases" value={fmtNumber(c.total)} sub={`${fmtNumber(c.notAutomatable)} not automatable`} to="/tests" />
      <Kpi
        label="Automated"
        value={
          <>
            {fmtPct(c.automationRate, 1)}
            <span className="ml-1.5 text-sm font-medium text-fg-3">{fmtNumber(c.automated)}</span>
          </>
        }
        sub="of automatable cases"
        to="/tests?automationStatus=automated"
      />
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
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Automation pipeline: Automated / In PR / In progress / Not automated

function PipelineCard({ s }: { s: Summary }) {
  const c = s.coverage;
  const automatable = c.total - c.notAutomatable;
  const stages = [
    { key: 'automated', label: 'Automated', value: c.automated, color: 'var(--au-automated)', icon: Bot, to: '/tests?automationStatus=automated' },
    { key: 'inpr', label: 'In PR', value: c.inOpenPr, color: 'var(--au-inpr)', icon: GitPullRequest, to: '/tests?inOpenPr=true', note: 'open PR linked' },
    { key: 'progress', label: 'In progress', value: c.inProgress, color: 'var(--au-progress)', icon: CircleDashed, to: '/tests?automationStatus=in_progress' },
    { key: 'not', label: 'Not automated', value: c.notAutomated, color: 'var(--au-not)', icon: ListChecks, to: '/tests?automationStatus=not_automated' },
  ];
  return (
    <Card>
      <CardHeader
        title="Automation progress"
        description={`${fmtNumber(c.automated)} of ${fmtNumber(automatable)} automatable cases automated`}
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
        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-5">
          {stages.map((st, i) => (
            <Link
              key={st.key}
              to={st.to}
              className="group relative rounded-lg border border-border px-3 py-2.5 outline-none transition-colors hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              <div className="flex items-center gap-1.5 text-xs text-fg-2">
                <Swatch color={st.color} />
                {st.label}
              </div>
              <div className="mt-1 flex items-baseline gap-1.5">
                <span className="text-lg font-semibold text-fg tabular">{fmtNumber(st.value)}</span>
                {st.note ? <span className="text-[11px] text-fg-3">{st.note}</span> : null}
              </div>
              {i < stages.length - 1 ? (
                <ArrowRight className="absolute top-1/2 -right-[11px] z-10 hidden size-3.5 -translate-y-1/2 rounded-full bg-surface text-fg-3 sm:block" aria-hidden />
              ) : null}
            </Link>
          ))}
          <Link
            to="/tests?automationStatus=not_automatable"
            className="col-span-2 rounded-lg border border-dashed border-border px-3 py-2.5 outline-none hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-ring/50 sm:col-span-4 lg:col-span-1"
          >
            <div className="flex items-center gap-1.5 text-xs text-fg-2">
              <span className="hatch inline-block size-2.5 rounded-[3px] border border-border" aria-hidden />
              Not automatable
            </div>
            <div className="mt-1 flex items-baseline gap-1.5">
              <span className="text-lg font-semibold text-fg tabular">{fmtNumber(c.notAutomatable)}</span>
              <span className="text-[11px] text-fg-3">excluded from %</span>
            </div>
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
        description="Last 30 runs by status — click a bar to open the run"
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
                  {g.name} ({g.runs})
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
            No runs yet. <Link to="/import#allure" className="text-accent hover:underline">Upload allure-results</Link> to
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
                <th className="w-[40%] px-2 py-2 font-medium">Coverage</th>
                <th className="px-2 py-2 text-right font-medium">Cases</th>
                <th className="hidden px-4 py-2 text-right font-medium sm:table-cell">Pass / Fail</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const rate = r.total ? r.automated / r.total : 0;
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
                            { label: 'Other', value: Math.max(0, r.total - r.automated - r.inProgress), color: 'var(--au-not)' },
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
            <Link to="/integrations" className="text-accent hover:underline">
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
                      <span className="text-fg">{r.automated}</span> / {r.total} · {fmtPct(r.total ? r.automated / r.total : null)}
                    </span>
                  </div>
                  <SegmentedBar
                    label={`${r.owner} automation`}
                    height={4}
                    parts={[
                      { label: 'Automated', value: r.automated, color: 'var(--au-automated)' },
                      { label: 'Not yet', value: r.total - r.automated, color: 'var(--au-not)' },
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
function StillFailingCallout() {
  const stats = useBugStats();
  const n = stats.data?.stillFailingAfterFix ?? 0;
  if (n === 0) return null;
  return (
    <Link
      to="/bugs?bucket=resolved&verification=still_failing"
      className="flex items-center gap-3 rounded-xl border border-[color-mix(in_oklab,var(--st-failed)_40%,transparent)] bg-[color-mix(in_oklab,var(--st-failed)_7%,var(--surface))] px-4 py-3 shadow-sm outline-none hover:bg-[color-mix(in_oklab,var(--st-failed)_10%,var(--surface))] focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      <span className="grid size-8 shrink-0 place-items-center rounded-full bg-st-failed text-white">
        <TriangleAlert className="size-4" aria-hidden />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] font-semibold text-fg">
          {n} bug{n === 1 ? ' is' : 's are'} marked resolved but still failing
        </span>
        <span className="block text-xs text-fg-2">Linked tests failed in runs after the fix — reopen or investigate.</span>
      </span>
      <ArrowRight className="size-4 text-fg-3" aria-hidden />
    </Link>
  );
}
