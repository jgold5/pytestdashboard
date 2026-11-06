import { useMemo, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import { toast } from 'sonner';
import {
  Area,
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { addDays, differenceInCalendarDays, format, parseISO } from 'date-fns';
import {
  ArrowDownRight,
  ArrowUpRight,
  Bot,
  Bug,
  CircleCheck,
  CircleHelp,
  CircleX,
  Flag,
  GitMerge,
  GitPullRequest,
  Link2,
  MessageSquare,
  Printer,
  Settings2,
  Shuffle,
  Sparkles,
  Target,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react';
import { BugSeverity, LIMITS, Settings, type Report } from '@ptd/shared';
import { useReport, useSession, useSettings, useUpdateSettings } from '../api/hooks';
import { useCssVars } from '../lib/theme';
import { cn, fmtDate, fmtNumber, fmtPct, pluralize } from '../lib/utils';
import { Button } from '../components/ui/button';
import { Dialog } from '../components/ui/dialog';
import { ErrorState } from '../components/ui/empty-state';
import { Field, Input } from '../components/ui/input';
import { Skeleton } from '../components/ui/skeleton';
import { ChartTooltipBox, Legend } from '../components/charts/ChartTooltip';
import { FoundResolvedChart } from '../components/charts/FoundResolvedChart';
import { SEVERITY_META } from '../components/bugs';
import { PIPELINE_META, REVIEW_META } from '../components/status';

const PERIODS = [7, 30, 90, 180] as const;

export default function ReportPage() {
  const [params, setParams] = useSearchParams();
  const period = PERIODS.find((p) => p === Number(params.get('period'))) ?? 30;
  const report = useReport(period);
  const session = useSession();
  const isEditor = session.data?.role !== 'viewer';
  const [settingsOpen, setSettingsOpen] = useState(false);

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      toast.success('Link copied');
    } catch {
      toast.error('Could not copy — copy the address bar instead.');
    }
  };

  const r = report.data;

  return (
    <div className="print-full mx-auto w-full max-w-[1200px] px-4 py-6 sm:px-8 sm:py-10">
      {/* Header */}
      <header className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <p className="text-xs font-medium tracking-[0.12em] text-fg-3 uppercase">Test automation report</p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight text-fg sm:text-4xl">{r?.teamName ?? 'Quality & automation'}</h1>
          <p className="mt-1.5 text-sm text-fg-2">
            Last {period} days
            {r ? (
              <>
                {' '}
                · {fmtDate(addDays(parseISO(r.generatedAt), -period).toISOString(), 'MMM d')} – {fmtDate(r.generatedAt)}
              </>
            ) : null}
          </p>
        </div>
        <div className="no-print flex flex-wrap items-center gap-2">
          <div role="radiogroup" aria-label="Period" className="inline-flex rounded-md border border-border bg-surface-2 p-0.5">
            {PERIODS.map((p) => (
              <button
                key={p}
                type="button"
                role="radio"
                aria-checked={p === period}
                onClick={() =>
                  setParams((prev) => {
                    const n = new URLSearchParams(prev);
                    n.set('period', String(p));
                    return n;
                  }, { replace: true })
                }
                className={cn('h-7 rounded-[5px] px-3 text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring/50', p === period ? 'bg-surface text-fg shadow-sm' : 'text-fg-2 hover:text-fg')}
              >
                {p}d
              </button>
            ))}
          </div>
          <Button variant="outline" size="sm" onClick={() => void copyLink()}>
            <Link2 /> Copy link
          </Button>
          <Button variant="outline" size="sm" onClick={() => window.print()}>
            <Printer /> Print / PDF
          </Button>
          {isEditor ? (
            <Button variant="ghost" size="icon-sm" onClick={() => setSettingsOpen(true)} aria-label="Report settings">
              <Settings2 />
            </Button>
          ) : null}
        </div>
      </header>

      {report.isError ? (
        <ErrorState error={report.error} onRetry={() => void report.refetch()} />
      ) : !r ? (
        <ReportSkeleton />
      ) : (
        <div className={cn('space-y-10', report.isPlaceholderData && 'opacity-60 transition-opacity')}>
          <Headline r={r} isEditor={isEditor} onSetGoal={() => setSettingsOpen(true)} />
          <Section title="Automation coverage" subtitle="Automated cases over time, with the goal and the projected path at the current pace.">
            <CoverageGoalChart r={r} />
          </Section>
          <InFlightSection r={r} />
          <QualitySection r={r} />
          <SuitesSection r={r} />
          <WinsAndRisks r={r} />
          <BugsSection r={r} />
          <PrSection r={r} />
          <footer className="border-t border-border pt-4 text-xs text-fg-3">
            Generated {fmtDate(r.generatedAt, 'MMM d, yyyy HH:mm')} · Automation rate = automated ÷ (total − not automatable)
          </footer>
        </div>
      )}
      {isEditor ? <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} /> : null}
    </div>
  );
}

function ReportSkeleton() {
  return (
    <div className="space-y-8" role="status" aria-label="Loading report">
      <div className="grid gap-6 lg:grid-cols-3">
        <Skeleton className="h-48 lg:col-span-2" />
        <Skeleton className="h-48" />
      </div>
      <Skeleton className="h-72" />
      <Skeleton className="h-56" />
    </div>
  );
}

function Section({ title, subtitle, children, className, aside }: { title: string; subtitle?: string; children: ReactNode; className?: string; aside?: ReactNode }) {
  return (
    <section className={cn('print-avoid-break', className)}>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold tracking-tight text-fg">{title}</h2>
          {subtitle ? <p className="mt-0.5 text-sm text-fg-2">{subtitle}</p> : null}
        </div>
        {aside}
      </div>
      {children}
    </section>
  );
}

function Panel({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('rounded-2xl border border-border bg-surface p-5 shadow-sm sm:p-6', className)}>{children}</div>;
}

// ---------------------------------------------------------------------------
// Headline

const STATUS_META: Record<NonNullable<Report['projection']['status']>, { label: string; color: string; icon: LucideIcon }> = {
  ahead: { label: 'Ahead of plan', color: 'var(--st-passed)', icon: ArrowUpRight },
  on_track: { label: 'On track', color: 'var(--st-passed)', icon: CircleCheck },
  at_risk: { label: 'At risk', color: 'var(--warn)', icon: TriangleAlert },
  behind: { label: 'Behind', color: 'var(--st-failed)', icon: ArrowDownRight },
};

function StatusPill({ status }: { status: NonNullable<Report['projection']['status']> }) {
  const m = STATUS_META[status];
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm font-semibold text-fg"
      style={{ background: `color-mix(in oklab, ${m.color} 13%, transparent)`, borderColor: `color-mix(in oklab, ${m.color} 35%, transparent)` }}
    >
      <m.icon className="size-4" style={{ color: m.color }} aria-hidden strokeWidth={2.4} />
      {m.label}
    </span>
  );
}

function GoalRing({ value, target }: { value: number; target: number }) {
  const size = 148;
  const stroke = 12;
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const progress = Math.min(1, target > 0 ? value / target : 0);
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`${fmtPct(progress)} of the way to the ${fmtPct(target)} goal`} className="shrink-0">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--surface-3)" strokeWidth={stroke} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="var(--au-automated)"
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={`${circ * progress} ${circ}`}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
      <text x="50%" y="46%" textAnchor="middle" dominantBaseline="middle" className="fill-fg text-[26px] font-semibold">
        {fmtPct(progress)}
      </text>
      <text x="50%" y="64%" textAnchor="middle" dominantBaseline="middle" className="fill-fg-3 text-[11px]">
        of goal
      </text>
    </svg>
  );
}

function Delta({ value, unit = 'pts', invert = false, className }: { value: number | null; unit?: string; invert?: boolean; className?: string }) {
  if (value == null || Number.isNaN(value)) return null;
  const v = value * 100;
  const good = invert ? v < 0 : v > 0;
  const flat = Math.abs(v) < 0.05;
  const Icon = v >= 0 ? ArrowUpRight : ArrowDownRight;
  return (
    <span className={cn('inline-flex items-center gap-0.5 font-semibold tabular', flat ? 'text-fg-2' : good ? 'text-good' : 'text-bad', className)}>
      {!flat ? <Icon className="size-4" aria-hidden /> : null}
      {flat ? '±0' : `${v > 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}`} {unit}
    </span>
  );
}

function Headline({ r, isEditor, onSetGoal }: { r: Report; isEditor: boolean; onSetGoal: () => void }) {
  const c = r.coverage;
  const delta = c.automationRate != null && r.coverageAtPeriodStart.automationRate != null ? c.automationRate - r.coverageAtPeriodStart.automationRate : null;
  const p = r.projection;
  return (
    <div className="grid gap-5 lg:grid-cols-5">
      <Panel className="lg:col-span-3">
        <div className="text-sm font-medium text-fg-2">Automated</div>
        <div className="mt-2 flex flex-wrap items-end gap-x-4 gap-y-1">
          <span className="text-6xl leading-none font-semibold tracking-tight text-fg sm:text-7xl">{fmtPct(c.automationRate, 1)}</span>
          <span className="pb-1.5 text-base">
            <Delta value={delta} /> <span className="font-normal text-fg-3">this period</span>
          </span>
        </div>
        {r.automationInFlight.projectedAutomationRate != null && r.automationInFlight.projectedAutomated > c.automated ? (
          <p className="mt-2 text-base text-fg-2">
            {fmtPct(c.automationRate)} automated ·{' '}
            <b className="font-semibold text-fg">{fmtPct(r.automationInFlight.projectedAutomationRate)}</b> once ready PRs merge
          </p>
        ) : null}
        <p className="mt-3 text-sm text-fg-2">
          <b className="font-semibold text-fg">{fmtNumber(c.automated)}</b> of{' '}
          {c.unit === 'routes' ? (
            <>
              {fmtNumber(c.total)} unique triggers have one or more tests
              {(c.unmerged ?? 0) > 0 ? <>, {fmtNumber(c.unmerged ?? 0)} of them in branches not merged yet</> : null} (file and schedule
              triggers in the source code)
            </>
          ) : (
            <>
              {fmtNumber(c.total - c.notAutomatable)} automatable test cases · {fmtNumber(c.total)} total
            </>
          )}
        </p>
        {/* Meter: whole inventory split into parts */}
        <div className="mt-5 flex h-3 w-full gap-[2px] overflow-hidden rounded-full" role="img" aria-label={`Automated ${c.automated}, in progress ${c.inProgress}, not automated ${c.notAutomated}`}>
          {[
            { v: c.automated, color: 'var(--au-automated)' },
            { v: c.inProgress, color: 'var(--au-progress)' },
            { v: c.notAutomated, color: 'var(--au-not)' },
          ]
            .filter((x) => x.v > 0)
            .map((x, i) => (
              <span key={i} className="h-full first:rounded-l-full last:rounded-r-full" style={{ width: `${(x.v / Math.max(1, c.total - c.notAutomatable)) * 100}%`, background: x.color }} />
            ))}
        </div>
        <div className="mt-2.5 flex flex-wrap gap-x-5 gap-y-1 text-xs text-fg-2">
          {c.unit === 'routes' ? (
            <>
              <LegendDot color="var(--au-automated)" label="Tested" value={c.automated} />
              <LegendDot color="var(--au-inpr)" label="of which not merged yet" value={c.unmerged ?? 0} />
              <LegendDot color="var(--au-not)" label="No test yet" value={c.notAutomated} />
            </>
          ) : (
            <>
              <LegendDot color="var(--au-automated)" label="Automated" value={c.automated} />
              <LegendDot color="var(--au-inpr)" label="In open PRs" value={c.inOpenPr} />
              <LegendDot color="var(--au-progress)" label="In progress" value={c.inProgress} />
              <LegendDot color="var(--au-not)" label="Not automated" value={c.notAutomated} />
            </>
          )}
        </div>
      </Panel>
      <Panel className="lg:col-span-2">
        {r.goal ? (
          <div className="flex h-full flex-col gap-4 sm:flex-row sm:items-center lg:flex-col lg:items-start xl:flex-row xl:items-center">
            <GoalRing value={c.automationRate ?? 0} target={r.goal.targetRate} />
            <div className="min-w-0 space-y-2.5">
              <div className="flex items-center gap-1.5 text-sm text-fg-2">
                <Target className="size-4 text-fg-3" aria-hidden />
                Goal: <b className="font-semibold text-fg">{fmtPct(r.goal.targetRate)}</b> by {fmtDate(r.goal.targetDate)}
              </div>
              {p.status ? <StatusPill status={p.status} /> : null}
              <dl className="space-y-1 text-sm">
                <div className="flex gap-2">
                  <dt className="text-fg-3">Projected</dt>
                  <dd className="font-medium text-fg">{p.projectedGoalDate ? fmtDate(p.projectedGoalDate) : p.remainingToGoal === 0 ? 'Reached' : 'Not at current pace'}</dd>
                </div>
                <div className="flex gap-2">
                  <dt className="text-fg-3">Remaining</dt>
                  <dd className="font-medium text-fg">{p.remainingToGoal != null ? pluralize(p.remainingToGoal, 'case') : '—'}</dd>
                </div>
                <div className="flex gap-2">
                  <dt className="text-fg-3">Pace</dt>
                  <dd className="font-medium text-fg">{p.weeklyVelocity.toFixed(1)} cases / week</dd>
                </div>
              </dl>
            </div>
          </div>
        ) : (
          <div className="flex h-full flex-col items-start justify-center gap-3">
            <Flag className="size-6 text-fg-3" aria-hidden />
            <p className="text-sm text-fg-2">
              No automation goal set. Pace: <b className="text-fg">{p.weeklyVelocity.toFixed(1)}</b> newly automated cases per week.
            </p>
            {isEditor ? (
              <Button variant="outline" size="sm" onClick={onSetGoal} className="no-print">
                <Target /> Set a goal
              </Button>
            ) : null}
          </div>
        )}
      </Panel>
    </div>
  );
}

function LegendDot({ color, label, value }: { color: string; label: string; value: number }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="size-2.5 rounded-[3px]" style={{ background: color }} aria-hidden />
      {label} <b className="font-semibold text-fg tabular">{fmtNumber(value)}</b>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Coverage chart with goal + projection

function CoverageGoalChart({ r }: { r: Report }) {
  const c = useCssVars(['au-automated', 'fg-3', 'fg-2', 'grid', 'axis', 'surface', 'st-passed'] as const);
  const automatable = r.coverage.total - r.coverage.notAutomatable;
  const goalCount = r.goal ? Math.ceil(r.goal.targetRate * automatable) : null;

  const { data, domain } = useMemo(() => {
    const pts: { t: number; automated?: number; total?: number; projection?: number }[] = r.coverageTrend.map((p) => ({
      t: parseISO(p.date).getTime(),
      automated: p.automated,
      total: p.total,
    }));
    const last = pts[pts.length - 1];
    let end = last?.t ?? parseISO(r.generatedAt).getTime();
    if (last && r.goal && goalCount != null) {
      last.projection = last.automated;
      const target = parseISO(r.goal.targetDate).getTime();
      if (r.projection.projectedGoalDate) {
        const projected = parseISO(r.projection.projectedGoalDate).getTime();
        // Cap the projection at ~1.5× the horizon to the target to keep the chart readable.
        const cap = last.t + Math.max(target - last.t, 1) * 1.5;
        const tEnd = Math.min(projected, cap);
        const frac = projected > last.t ? (tEnd - last.t) / (projected - last.t) : 1;
        pts.push({ t: tEnd, projection: Math.round((last.automated ?? 0) + ((goalCount - (last.automated ?? 0)) * frac)) });
        end = Math.max(tEnd, target);
      } else {
        end = Math.max(end, target);
      }
    }
    const start = pts[0]?.t ?? end;
    return { data: pts, domain: [start, end] as [number, number] };
  }, [r, goalCount]);

  if (r.coverageTrend.length < 2) {
    return (
      <Panel>
        <p className="py-12 text-center text-sm text-fg-3">Not enough history yet — the trend fills in as the inventory changes over time.</p>
      </Panel>
    );
  }
  const days = differenceInCalendarDays(domain[1], domain[0]);
  return (
    <Panel>
      <div className="mb-3">
        <Legend
          items={[
            { label: 'Automated cases', color: c['au-automated'], shape: 'line' },
            ...(r.goal ? [{ label: `Goal (${fmtNumber(goalCount ?? 0)})`, color: c['st-passed'], shape: 'dashed' as const }, { label: 'Projection', color: c['au-automated'], shape: 'dashed' as const }] : []),
          ]}
        />
      </div>
      <div className="h-[280px]" role="img" aria-label="Automated cases over time with goal and projection">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 10, right: 16, bottom: 0, left: -4 }}>
            <CartesianGrid vertical={false} stroke={c.grid} />
            <XAxis
              type="number"
              dataKey="t"
              domain={domain}
              scale="time"
              tickFormatter={(t: number) => format(t, days > 200 ? 'MMM yyyy' : 'MMM d')}
              tick={{ fontSize: 12, fill: c['fg-3'] }}
              tickLine={false}
              axisLine={{ stroke: c.axis }}
              minTickGap={40}
            />
            <YAxis
              tick={{ fontSize: 12, fill: c['fg-3'] }}
              tickLine={false}
              axisLine={false}
              width={48}
              allowDecimals={false}
              domain={[0, (max: number) => Math.max(max, goalCount ?? 0)]}
              tickFormatter={(v: number) => fmtNumber(v)}
            />
            <Tooltip
              cursor={{ stroke: c.axis }}
              content={({ active, payload }) => {
                const p = active && payload?.[0] ? (payload[0].payload as (typeof data)[number]) : null;
                if (!p) return null;
                const rows = [];
                if (p.automated != null) rows.push({ color: c['au-automated'], label: 'Automated', value: fmtNumber(p.automated) });
                if (p.automated == null && p.projection != null) rows.push({ color: c['au-automated'], label: 'Projected', value: fmtNumber(p.projection) });
                if (p.total != null) rows.push({ color: c['fg-3'], label: r.coverage.unit === 'routes' ? 'Triggers' : 'Total cases', value: fmtNumber(p.total) });
                return <ChartTooltipBox title={format(p.t, 'MMM d, yyyy')} rows={rows} />;
              }}
            />
            {goalCount != null && r.goal ? (
              <>
                <ReferenceLine y={goalCount} stroke={c['st-passed']} strokeDasharray="6 4" strokeWidth={1.5} ifOverflow="extendDomain" />
                <ReferenceLine
                  x={parseISO(r.goal.targetDate).getTime()}
                  stroke={c.axis}
                  strokeWidth={1}
                  label={{ value: `Target ${fmtDate(r.goal.targetDate, 'MMM d')}`, position: 'insideTopRight', fill: c['fg-2'], fontSize: 11 }}
                />
              </>
            ) : null}
            <Area type="monotone" dataKey="automated" stroke={c['au-automated']} strokeWidth={2} fill={c['au-automated']} fillOpacity={0.05} isAnimationActive={false} connectNulls={false} activeDot={{ r: 4, stroke: c.surface, strokeWidth: 2 }} />
            <Line type="linear" dataKey="projection" stroke={c['au-automated']} strokeWidth={2} strokeDasharray="5 5" dot={false} isAnimationActive={false} connectNulls />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Quality

function QualitySection({ r }: { r: Report }) {
  const q = r.quality;
  const c = useCssVars(['accent', 'fg-3', 'grid', 'axis', 'surface-2'] as const);
  const delta = q.periodAvgPassRate != null && q.previousPeriodAvgPassRate != null ? q.periodAvgPassRate - q.previousPeriodAvgPassRate : null;
  return (
    <Section title="Quality" subtitle={`${pluralize(q.runsInPeriod, 'automated run')} in this period.`}>
      <div className="grid gap-5 lg:grid-cols-3">
        <Panel className="flex flex-col justify-between gap-5">
          <div>
            <div className="text-sm text-fg-2">Latest pass rate</div>
            <div className="mt-1 text-5xl font-semibold tracking-tight text-fg">{fmtPct(q.latestPassRate, 1)}</div>
          </div>
          <div>
            <div className="text-sm text-fg-2">Average this period</div>
            <div className="mt-1 flex items-baseline gap-2">
              <span className="text-3xl font-semibold tracking-tight text-fg">{fmtPct(q.periodAvgPassRate, 1)}</span>
              <Delta value={delta} className="text-sm" />
            </div>
            <div className="text-xs text-fg-3">vs {fmtPct(q.previousPeriodAvgPassRate, 1)} the period before</div>
          </div>
        </Panel>
        <Panel className="lg:col-span-2">
          <div className="mb-2 text-sm font-medium text-fg-2">Weekly pass rate</div>
          {q.weeklyPassRate.some((w) => w.passRate != null) ? (
            <div className="h-48" role="img" aria-label="Weekly pass rate">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={q.weeklyPassRate} margin={{ top: 18, right: 4, bottom: 0, left: 0 }} maxBarSize={28}>
                  <CartesianGrid vertical={false} stroke={c.grid} />
                  <XAxis dataKey="weekStart" tickFormatter={(d: string) => fmtDate(d, 'MMM d')} tick={{ fontSize: 11, fill: c['fg-3'] }} tickLine={false} axisLine={{ stroke: c.axis }} minTickGap={16} />
                  <YAxis domain={[0, 1]} ticks={[0, 0.5, 0.8, 1]} tickFormatter={(v: number) => fmtPct(v)} tick={{ fontSize: 11, fill: c['fg-3'] }} tickLine={false} axisLine={false} width={40} />
                  <Tooltip
                    cursor={{ fill: c['surface-2'] }}
                    content={({ active, payload }) => {
                      const p = active && payload?.[0] ? (payload[0].payload as (typeof q.weeklyPassRate)[number]) : null;
                      if (!p) return null;
                      return <ChartTooltipBox title={`Week of ${fmtDate(p.weekStart)}`} rows={[{ color: c.accent, label: `pass rate · ${pluralize(p.runs, 'run')}`, value: fmtPct(p.passRate, 1), shape: 'square' }]} />;
                    }}
                  />
                  <Bar dataKey="passRate" fill={c.accent} radius={[4, 4, 0, 0]} isAnimationActive={false} label={q.weeklyPassRate.length <= 8 ? { position: 'top', fontSize: 11, fill: c['fg-3'], formatter: (v: unknown) => (typeof v === 'number' ? fmtPct(v) : '') } : undefined} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <p className="py-10 text-center text-sm text-fg-3">No runs in this period.</p>
          )}
        </Panel>
      </div>
      {q.byRunGroup.length > 0 ? (
        <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {q.byRunGroup.map((g) => (
            <Panel key={g.runGroup} className="p-4 sm:p-4">
              <div className="truncate font-mono text-xs text-fg-2">{g.runGroup}</div>
              <div className="mt-1 flex items-baseline gap-2">
                <span className="text-2xl font-semibold text-fg">{fmtPct(g.latestPassRate, 1)}</span>
                <span className="text-xs text-fg-3">latest</span>
              </div>
              <div className="mt-1 text-xs text-fg-2">
                Avg {fmtPct(g.periodAvgPassRate, 1)} · {pluralize(g.runsInPeriod, 'run')}
                {g.lastRunAt ? ` · last ${fmtDate(g.lastRunAt, 'MMM d')}` : ''}
              </div>
            </Panel>
          ))}
        </div>
      ) : null}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Suites

const HEALTH = {
  green: { label: 'Healthy', icon: CircleCheck, color: 'var(--st-passed)' },
  amber: { label: 'Watch', icon: TriangleAlert, color: 'var(--warn)' },
  red: { label: 'At risk', icon: CircleX, color: 'var(--st-failed)' },
  unknown: { label: 'No data', icon: CircleHelp, color: 'var(--fg-3)' },
} as const;

function SuitesSection({ r }: { r: Report }) {
  if (r.suites.length === 0) return null;
  const counts = r.suites.reduce<Record<string, number>>((a, s) => ({ ...a, [s.health]: (a[s.health] ?? 0) + 1 }), {});
  return (
    <Section
      title="Suite readiness"
      subtitle="Each feature area by automation coverage and the pass rate of its latest results."
      aside={
        <div className="flex flex-wrap gap-3 text-xs text-fg-2">
          {(Object.keys(HEALTH) as (keyof typeof HEALTH)[]).map((h) =>
            counts[h] ? (
              <span key={h} className="inline-flex items-center gap-1">
                {(() => {
                  const I = HEALTH[h].icon;
                  return <I className="size-3.5" style={{ color: HEALTH[h].color }} aria-hidden />;
                })()}
                {HEALTH[h].label} <b className="text-fg">{counts[h]}</b>
              </span>
            ) : null,
          )}
        </div>
      }
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {r.suites.map((s) => {
          const H = HEALTH[s.health];
          return (
            <div
              key={s.suite}
              className="print-avoid-break rounded-lg border bg-surface p-4"
              style={{ borderColor: `color-mix(in oklab, ${H.color} 35%, var(--border))`, boxShadow: `inset 3px 0 0 ${H.color}` }}
            >
              <div className="flex items-start justify-between gap-2">
                <span className="min-w-0 truncate text-sm font-semibold text-fg">{s.suite}</span>
                <span className="inline-flex shrink-0 items-center gap-1 text-xs text-fg-2">
                  <H.icon className="size-3.5" style={{ color: H.color }} aria-hidden />
                  {H.label}
                </span>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2">
                <div>
                  <div className="text-xl font-semibold text-fg">{fmtPct(s.automationRate)}</div>
                  <div className="text-[11px] text-fg-3">automated</div>
                </div>
                <div>
                  <div className="text-xl font-semibold text-fg">{fmtPct(s.lastPassRate)}</div>
                  <div className="text-[11px] text-fg-3">passing</div>
                </div>
              </div>
              <div className="mt-2 text-[11px] text-fg-3">
                {fmtNumber(s.automated)} / {fmtNumber(s.automatable)} automatable
              </div>
            </div>
          );
        })}
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------------------

function MetricTile({ icon: Icon, value, label, tone }: { icon: LucideIcon; value: number; label: string; tone: 'win' | 'risk' }) {
  const color = tone === 'win' ? 'var(--st-passed)' : value > 0 ? 'var(--st-failed)' : 'var(--fg-3)';
  return (
    <div className="print-avoid-break rounded-lg border border-border bg-surface p-4">
      <Icon className="size-4" style={{ color }} aria-hidden />
      <div className="mt-2 text-3xl font-semibold tracking-tight text-fg tabular">{fmtNumber(value)}</div>
      <div className="mt-0.5 text-xs text-fg-2">{label}</div>
    </div>
  );
}

function WinsAndRisks({ r }: { r: Report }) {
  const h = r.highlights;
  const k = r.risks;
  return (
    <div className="grid gap-8 lg:grid-cols-2">
      <Section title="Highlights" subtitle="What moved forward this period.">
        <div className="grid grid-cols-2 gap-3">
          <MetricTile tone="win" icon={Sparkles} value={h.newlyAutomated} label="Newly automated cases" />
          <MetricTile tone="win" icon={GitMerge} value={h.prsMerged} label="Automation PRs merged" />
          <MetricTile tone="win" icon={Bot} value={h.bugsFoundByAutomation} label="Bugs found by automation" />
          <MetricTile tone="win" icon={CircleCheck} value={h.bugsVerifiedFixed} label="Fixes verified by tests" />
        </div>
        <p className="mt-3 text-xs text-fg-3">
          Also: {pluralize(h.casesAdded, 'case')} added · {pluralize(h.failuresTriaged, 'failure')} triaged · {pluralize(h.bugsResolved, 'bug')} resolved
        </p>
      </Section>
      <Section title="Risks" subtitle="What needs attention.">
        <div className="grid grid-cols-2 gap-3">
          <MetricTile tone="risk" icon={TriangleAlert} value={k.untriagedFailures} label="Untriaged failures" />
          <MetricTile tone="risk" icon={Shuffle} value={k.flakyTests} label="Flaky tests" />
          <MetricTile tone="risk" icon={Bug} value={k.openCriticalBugs} label="Open critical bugs" />
          <MetricTile tone="risk" icon={CircleX} value={k.stillFailingAfterFix} label="“Fixed” bugs still failing" />
        </div>
        <p className="mt-3 text-xs text-fg-3">
          Also: {pluralize(k.openBugs, 'open bug')} · {pluralize(k.productBugsOpen, 'case')} failing on product bugs · {pluralize(k.prsNeedingAttention, 'PR')} needing attention
        </p>
      </Section>
    </div>
  );
}

function BugsSection({ r }: { r: Report }) {
  const b = r.bugs;
  const maxSev = Math.max(1, ...b.bySeverity.map((s) => s.open));
  return (
    <Section title="Bugs" subtitle={`${pluralize(r.highlights.bugsFoundByAutomation, 'bug')} found by automation this period.`}>
      <div className="grid gap-5 lg:grid-cols-3">
        <Panel>
          <div className="text-sm font-medium text-fg-2">Open by severity</div>
          <ul className="mt-4 space-y-3">
            {BugSeverity.options.map((s) => {
              const n = b.bySeverity.find((x) => x.severity === s)?.open ?? 0;
              const M = SEVERITY_META[s];
              return (
                <li key={s} className="flex items-center gap-2">
                  <M.icon className="size-4" style={{ color: M.color }} aria-hidden />
                  <span className="w-16 text-sm text-fg-2">{M.label}</span>
                  <span className="h-2.5 flex-1 overflow-hidden rounded-full bg-surface-2">
                    <span className="block h-full rounded-full" style={{ width: `${(n / maxSev) * 100}%`, background: M.color }} />
                  </span>
                  <span className="w-6 text-right text-sm font-semibold text-fg tabular">{n}</span>
                </li>
              );
            })}
          </ul>
          <div className="mt-5 grid grid-cols-2 gap-3 border-t border-border pt-4">
            <div>
              <div className="text-2xl font-semibold text-fg">{b.meanDaysToResolve != null ? b.meanDaysToResolve.toFixed(1) : '—'}</div>
              <div className="text-[11px] text-fg-3">mean days to resolve</div>
            </div>
            <div>
              <div className="text-2xl font-semibold text-fg">{fmtNumber(r.highlights.bugsVerifiedFixed)}</div>
              <div className="text-[11px] text-fg-3">verified fixes</div>
            </div>
          </div>
        </Panel>
        <Panel className="lg:col-span-2">
          <div className="mb-2 text-sm font-medium text-fg-2">Found vs resolved</div>
          <FoundResolvedChart trend={b.trend} height={230} />
        </Panel>
      </div>
    </Section>
  );
}

/** Work that is done or nearly done but not yet counted as automated. */
function InFlightSection({ r }: { r: Report }) {
  const f = r.automationInFlight;
  const c = r.coverage;
  const automatable = Math.max(1, c.total - c.notAutomatable);
  const tiles = [
    { stage: 'in_review', note: 'open PRs still in review, CI or discussion' },
    { stage: 'ready_to_merge', note: 'approved, checks green — waiting to be merged' },
    { stage: 'merged_awaiting_run', note: 'merged, waiting for the next run to confirm' },
  ] as const;
  const extra = Math.max(0, f.projectedAutomated - c.automated);
  return (
    <Section title="Automation in flight" subtitle="Test automation that is written but not yet merged or not yet confirmed by a run.">
      <div className="grid gap-5 lg:grid-cols-5">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 lg:col-span-3">
          {tiles.map(({ stage, note }) => {
            const M = PIPELINE_META[stage];
            return (
              <div key={stage} className="print-avoid-break rounded-lg border border-border bg-surface p-4">
                <div className="flex items-center gap-1.5 text-xs text-fg-2">
                  <M.icon className="size-3.5" style={{ color: M.color }} aria-hidden />
                  {M.label}
                </div>
                <div className="mt-1 text-3xl font-semibold text-fg tabular">{fmtNumber(f.stages[stage])}</div>
                <p className="mt-1 text-xs text-fg-3">{note}</p>
              </div>
            );
          })}
        </div>
        <Panel className="lg:col-span-2">
          <div className="text-sm font-medium text-fg-2">Automated incl. ready-to-merge</div>
          <div className="mt-2 flex flex-wrap items-baseline gap-x-3">
            <span className="text-4xl font-semibold tracking-tight text-fg">{fmtPct(f.projectedAutomationRate, 1)}</span>
            <span className="text-sm text-fg-3">
              vs {fmtPct(c.automationRate, 1)} today{extra > 0 ? ` · +${pluralize(extra, 'case')}` : ''}
            </span>
          </div>
          <div
            className="mt-4 flex h-2.5 w-full gap-[2px] overflow-hidden rounded-full bg-surface-3"
            role="img"
            aria-label={`Automated ${c.automated}, ready to merge or merged awaiting run ${extra}, of ${automatable} automatable`}
          >
            <span className="h-full rounded-l-full" style={{ width: `${(c.automated / automatable) * 100}%`, background: 'var(--au-automated)' }} />
            {extra > 0 ? (
              <span className="hatch h-full" style={{ width: `${(extra / automatable) * 100}%`, background: 'color-mix(in oklab, var(--st-passed) 55%, transparent)' }} />
            ) : null}
          </div>
          <p className="mt-2.5 text-xs text-fg-3">Projection counts cases whose PR is approved with green checks, or merged and waiting for a run.</p>
        </Panel>
      </div>
    </Section>
  );
}

function PrSection({ r }: { r: Report }) {
  const p = r.prPipeline;
  const stages = [
    { label: 'Draft', value: p.draft, color: 'var(--fg-3)', icon: GitPullRequest },
    { label: REVIEW_META.review_required.label, value: p.reviewRequired, color: 'var(--warn)', icon: REVIEW_META.review_required.icon },
    { label: REVIEW_META.changes_requested.label, value: p.changesRequested, color: 'var(--st-failed)', icon: REVIEW_META.changes_requested.icon },
    { label: REVIEW_META.approved.label, value: p.approved, color: 'var(--st-passed)', icon: REVIEW_META.approved.icon },
  ];
  return (
    <Section title="Automation in review" subtitle={`${pluralize(p.open, 'open pull request')} adding or changing automated tests.`}>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {stages.map((s) => (
          <div key={s.label} className="print-avoid-break rounded-lg border border-border bg-surface p-4">
            <div className="flex items-center gap-1.5 text-xs text-fg-2">
              <s.icon className="size-3.5" style={{ color: s.color }} aria-hidden />
              {s.label}
            </div>
            <div className="mt-1 text-3xl font-semibold text-fg tabular">{fmtNumber(s.value)}</div>
          </div>
        ))}
      </div>
      <p className="mt-3 flex items-center gap-1.5 text-sm text-fg-2">
        <MessageSquare className="size-4 text-fg-3" aria-hidden />
        {pluralize(p.unresolvedThreads, 'unresolved review thread')} · {pluralize(p.needsAttention, 'PR')} waiting on the author
      </p>
    </Section>
  );
}

// ---------------------------------------------------------------------------

function SettingsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const settings = useSettings();
  const update = useUpdateSettings();
  const [team, setTeam] = useState('');
  const [rate, setRate] = useState('');
  const [date, setDate] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    const s = settings.data;
    setTeam(s?.teamName ?? '');
    setRate(s?.goal ? String(Math.round(s.goal.targetRate * 100)) : '');
    setDate(s?.goal?.targetDate ?? '');
    setError(null);
  };

  const save = () => {
    const hasGoal = rate.trim() !== '' || date !== '';
    if (hasGoal && (rate.trim() === '' || date === '')) return setError('Set both a target % and a target date (or clear both).');
    const parsed = Settings.safeParse({
      teamName: team.trim() || null,
      goal: hasGoal ? { targetRate: Number(rate) / 100, targetDate: date } : null,
    });
    if (!parsed.success) return setError(parsed.error.issues[0]?.message ?? 'Invalid settings');
    update.mutate(parsed.data, {
      onSuccess: () => {
        toast.success('Report settings saved');
        onOpenChange(false);
      },
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (o) load();
        onOpenChange(o);
      }}
      title="Report settings"
      description="Shown to everyone who views the report."
      className="max-w-md"
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" onClick={save} loading={update.isPending}>
            Save
          </Button>
        </>
      }
    >
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <Field label="Team name" htmlFor="rs-team">
          <Input id="rs-team" value={team} maxLength={LIMITS.shortTextMax} placeholder="e.g. Payments QA" onChange={(e) => setTeam(e.target.value)} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Automation goal (%)" htmlFor="rs-rate">
            <Input id="rs-rate" type="number" inputMode="numeric" min={1} max={100} value={rate} placeholder="80" onChange={(e) => setRate(e.target.value)} />
          </Field>
          <Field label="Target date" htmlFor="rs-date">
            <Input id="rs-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
        </div>
        {error ? (
          <p className="text-xs text-bad" role="alert">
            {error}
          </p>
        ) : null}
        <button type="submit" className="hidden" tabIndex={-1} aria-hidden />
      </form>
    </Dialog>
  );
}
