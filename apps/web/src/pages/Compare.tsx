import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { ArrowRight, Check, GitBranch, GitCompareArrows, Minus, Plus, Repeat, Snail, ArrowUp, ArrowLeftRight } from 'lucide-react';
import type { Run, RunCompareEntry, RunComparison } from '@ptd/shared';
import { useCompare, useRuns } from '../api/hooks';
import { useRunGroupSelection } from '../lib/runGroup';
import { cn, fmtDate, fmtDateTime, fmtDuration, fmtNumber, fmtPct } from '../lib/utils';
import { Button } from '../components/ui/button';
import { Card, CardHeader } from '../components/ui/card';
import { EmptyState, ErrorState } from '../components/ui/empty-state';
import { Skeleton } from '../components/ui/skeleton';
import { RunsHeader } from '../components/RunsTabs';
import { RunGroupChip, RunGroupPicker } from '../components/RunGroup';
import { ResultBadge } from '../components/status';
import { ApiError } from '../api/client';

type SectionKey = 'newFailures' | 'fixed' | 'stillFailing' | 'added' | 'removed' | 'slower';

const SECTIONS: { key: SectionKey; label: string; icon: typeof Check; color: string; empty: string }[] = [
  { key: 'newFailures', label: 'New failures', icon: ArrowUp, color: 'var(--st-failed)', empty: 'No new failures.' },
  { key: 'fixed', label: 'Fixed', icon: Check, color: 'var(--st-passed)', empty: 'Nothing was fixed.' },
  { key: 'stillFailing', label: 'Still failing', icon: Repeat, color: 'var(--st-broken)', empty: 'Nothing is still failing.' },
  { key: 'added', label: 'Added', icon: Plus, color: 'var(--accent)', empty: 'No tests added.' },
  { key: 'removed', label: 'Removed', icon: Minus, color: 'var(--fg-3)', empty: 'No tests removed.' },
  { key: 'slower', label: 'Slower', icon: Snail, color: 'var(--warn)', empty: 'No notable slowdowns (≥1.5× and +1s).' },
];

function runLabel(r: Pick<Run, 'name' | 'startedAt' | 'importedAt' | 'branch'>) {
  return `${r.name} — ${fmtDate(r.startedAt ?? r.importedAt, 'MMM d, HH:mm')}${r.branch ? ` (${r.branch})` : ''}`;
}

export default function ComparePage() {
  const { groups, value: group, setValue: setGroup } = useRunGroupSelection();
  const [params, setParams] = useSearchParams();
  const headParam = Number(params.get('head')) || null;
  const baseParam = Number(params.get('base')) || null;
  const runs = useRuns({ runGroup: group ?? undefined, pageSize: 100 });
  const runList = runs.data?.items ?? [];
  const head = headParam ?? runList[0]?.id ?? null;
  const cmp = useCompare(head, baseParam);

  const setRun = (k: 'base' | 'head', v: string) =>
    setParams(
      (prev) => {
        const n = new URLSearchParams(prev);
        if (v) n.set(k, v);
        else n.delete(k);
        return n;
      },
      { replace: true },
    );

  const swap = () => {
    if (!cmp.data) return;
    setParams(
      (prev) => {
        const n = new URLSearchParams(prev);
        n.set('base', String(cmp.data.head.id));
        n.set('head', String(cmp.data.base.id));
        return n;
      },
      { replace: true },
    );
  };

  // Include the currently compared runs even if they're not in the group's first page.
  const options = useMemo(() => {
    const m = new Map<number, Pick<Run, 'id' | 'name' | 'startedAt' | 'importedAt' | 'branch'>>();
    runList.forEach((r) => m.set(r.id, r));
    if (cmp.data) {
      m.set(cmp.data.base.id, cmp.data.base);
      m.set(cmp.data.head.id, cmp.data.head);
    }
    return [...m.values()].sort((a, b) => (b.startedAt ?? b.importedAt).localeCompare(a.startedAt ?? a.importedAt));
  }, [runList, cmp.data]);

  const noPrevious = cmp.error instanceof ApiError && cmp.error.status === 400 && !baseParam;

  return (
    <>
      <RunsHeader />
      <div className="mb-3">
        <RunGroupPicker
          groups={groups}
          value={group}
          onChange={(g) => {
            setGroup(g);
            setParams((prev) => {
              const n = new URLSearchParams(prev);
              n.delete('base');
              n.delete('head');
              n.set('group', g);
              return n;
            }, { replace: true });
          }}
        />
      </div>

      <Card className="mb-4 p-4">
        <div className="grid items-end gap-3 md:grid-cols-[1fr_auto_1fr]">
          <RunPicker
            id="cmp-base"
            label="Base (before)"
            value={baseParam ?? cmp.data?.base.id ?? null}
            options={options}
            onChange={(v) => setRun('base', v)}
            hint={!baseParam ? 'Defaults to the head run’s previous run' : undefined}
          />
          <Button variant="ghost" size="icon" onClick={swap} aria-label="Swap base and head" className="justify-self-center" disabled={!cmp.data}>
            <ArrowLeftRight />
          </Button>
          <RunPicker id="cmp-head" label="Head (after)" value={head} options={options} onChange={(v) => setRun('head', v)} />
        </div>
      </Card>

      {runs.isPending && !headParam ? (
        <Skeleton className="h-64" />
      ) : !head ? (
        <Card>
          <EmptyState icon={<GitCompareArrows />} title="No runs to compare">
            Import at least two runs in this run group to compare them.
          </EmptyState>
        </Card>
      ) : noPrevious ? (
        <Card>
          <EmptyState icon={<GitCompareArrows />} title="This run has no previous run">
            It’s the first run in its group/branch. Pick a base run above to compare against.
          </EmptyState>
        </Card>
      ) : cmp.isError ? (
        <Card>
          <ErrorState error={cmp.error} onRetry={() => void cmp.refetch()} />
        </Card>
      ) : !cmp.data ? (
        <div className="space-y-3" role="status" aria-label="Loading comparison">
          <Skeleton className="h-20" />
          <Skeleton className="h-64" />
        </div>
      ) : (
        <div className={cn('space-y-4', cmp.isPlaceholderData && 'opacity-60')}>
          <CompareSummary c={cmp.data} />
          {SECTIONS.map((s) => (
            <CompareSection key={s.key} section={s} entries={cmp.data[s.key]} count={cmp.data.counts[s.key]} defaultOpen={s.key !== 'removed'} />
          ))}
        </div>
      )}
    </>
  );
}

function RunPicker({
  id,
  label,
  value,
  options,
  onChange,
  hint,
}: {
  id: string;
  label: string;
  value: number | null;
  options: Pick<Run, 'id' | 'name' | 'startedAt' | 'importedAt' | 'branch'>[];
  onChange: (v: string) => void;
  hint?: string;
}) {
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="mb-1 block text-xs font-medium text-fg-2">
        {label}
      </label>
      <select
        id={id}
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
        className="h-9 w-full rounded-md border border-border-strong/70 bg-surface px-2.5 text-[13px] text-fg shadow-sm outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-ring/40"
      >
        {value == null ? <option value="">Select a run…</option> : null}
        {options.map((r) => (
          <option key={r.id} value={r.id}>
            {runLabel(r)}
          </option>
        ))}
      </select>
      {hint ? <p className="mt-1 text-[11px] text-fg-3">{hint}</p> : null}
    </div>
  );
}

function RunSide({ r, side }: { r: Run; side: string }) {
  return (
    <div className="min-w-0 flex-1">
      <div className="text-[11px] font-medium tracking-wide text-fg-3 uppercase">{side}</div>
      <Link to={`/runs/${r.id}`} className="mt-0.5 block truncate text-[15px] font-semibold text-fg hover:underline">
        {r.name}
      </Link>
      <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-fg-2">
        <RunGroupChip group={r.runGroup} />
        {r.branch ? (
          <span className="inline-flex items-center gap-1 font-mono text-[11px]">
            <GitBranch className="size-3" aria-hidden />
            {r.branch}
          </span>
        ) : null}
        <span>{fmtDateTime(r.startedAt ?? r.importedAt)}</span>
      </div>
      <div className="mt-2 text-2xl font-semibold tracking-tight text-fg">
        {fmtPct(r.passRate, 1)}
        <span className="ml-1.5 text-xs font-normal text-fg-3">pass rate · {fmtNumber(r.counts.total)} tests</span>
      </div>
    </div>
  );
}

function CompareSummary({ c }: { c: RunComparison }) {
  const delta = c.head.passRate != null && c.base.passRate != null ? c.head.passRate - c.base.passRate : null;
  return (
    <Card className="p-4">
      <div className="flex flex-col gap-4 md:flex-row md:items-center">
        <RunSide r={c.base} side="Base" />
        <div className="flex items-center gap-2 self-center text-fg-3">
          <ArrowRight className="size-5" aria-hidden />
          {delta != null ? (
            <span className={cn('rounded-full px-2 py-0.5 text-xs font-semibold tabular', delta > 0.0005 ? 'text-good' : delta < -0.0005 ? 'text-bad' : 'text-fg-2')}>
              {delta > 0 ? '+' : delta < 0 ? '−' : '±'}
              {Math.abs(delta * 100).toFixed(1)} pts
            </span>
          ) : null}
        </div>
        <RunSide r={c.head} side="Head" />
      </div>
      <div className="mt-4 flex flex-wrap gap-2 border-t border-border pt-4">
        {SECTIONS.map((s) => (
          <a
            key={s.key}
            href={`#cmp-${s.key}`}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs outline-none hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-ring/50',
              c.counts[s.key] === 0 && 'opacity-60',
            )}
            style={
              c.counts[s.key] > 0
                ? { background: `color-mix(in oklab, ${s.color} 10%, transparent)`, borderColor: `color-mix(in oklab, ${s.color} 30%, transparent)` }
                : undefined
            }
          >
            <s.icon className="size-3.5" style={{ color: s.color }} aria-hidden />
            <b className="font-semibold text-fg tabular">{fmtNumber(c.counts[s.key])}</b>
            <span className="text-fg-2">{s.label.toLowerCase()}</span>
          </a>
        ))}
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs text-fg-3">
          <span className="tabular">{fmtNumber(c.counts.unchangedPass)}</span> unchanged passing
        </span>
      </div>
    </Card>
  );
}

function CompareSection({
  section,
  entries,
  count,
  defaultOpen,
}: {
  section: (typeof SECTIONS)[number];
  entries: RunCompareEntry[];
  count: number;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const isSlower = section.key === 'slower';
  return (
    <Card id={`cmp-${section.key}`} className="scroll-mt-16 overflow-hidden">
      <CardHeader
        title={
          <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="inline-flex items-center gap-2 rounded outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
            <section.icon className="size-4" style={{ color: section.color }} aria-hidden />
            {section.label}
            <span className="rounded-full bg-surface-2 px-1.5 text-[11px] font-medium text-fg-2 tabular">{fmtNumber(count)}</span>
          </button>
        }
        actions={count > entries.length ? <span className="text-[11px] text-fg-3">showing first {entries.length}</span> : null}
      />
      {open ? (
        entries.length === 0 ? (
          <p className="px-4 pb-4 text-xs text-fg-3">{section.empty}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[600px] text-[13px]">
              <thead className="bg-surface-2/60 text-left text-[11px] font-medium tracking-wide text-fg-3 uppercase">
                <tr className="border-y border-border">
                  <th className="px-4 py-1.5 font-medium">Test</th>
                  <th className="w-56 px-2 py-1.5 font-medium">Status</th>
                  <th className="w-44 px-2 py-1.5 pr-4 text-right font-medium">Duration</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <tr key={e.testCase.id} className="border-b border-border align-top last:border-0 hover:bg-surface-2/50">
                    <td className="max-w-0 px-4 py-2">
                      <Link to={`/tests/${e.testCase.id}`} className="block truncate text-fg hover:underline">
                        {e.testCase.title}
                      </Link>
                      <div className="truncate font-mono text-[11px] text-fg-3">
                        {e.testCase.key}
                        {e.testCase.suite ? ` · ${e.testCase.suite}` : ''}
                      </div>
                      {e.headMessage && (section.key === 'newFailures' || section.key === 'stillFailing') ? (
                        <div className="mt-1 line-clamp-2 font-mono text-[11px] text-bad">{e.headMessage}</div>
                      ) : null}
                    </td>
                    <td className="px-2 py-2">
                      <span className="inline-flex flex-wrap items-center gap-1">
                        {e.baseStatus ? <ResultBadge status={e.baseStatus} /> : <span className="text-[11px] text-fg-3">not run</span>}
                        <ArrowRight className="size-3 text-fg-3" aria-label="to" />
                        {e.headStatus ? <ResultBadge status={e.headStatus} /> : <span className="text-[11px] text-fg-3">not run</span>}
                      </span>
                    </td>
                    <td className="px-2 py-2 pr-4 text-right text-xs whitespace-nowrap text-fg-2 tabular">
                      {fmtDuration(e.baseDurationMs)} → <span className={cn(isSlower && 'font-semibold text-fg')}>{fmtDuration(e.headDurationMs)}</span>
                      {isSlower && e.baseDurationMs && e.headDurationMs ? (
                        <div className="text-[11px] text-warn">{(e.headDurationMs / e.baseDurationMs).toFixed(1)}× slower</div>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : null}
    </Card>
  );
}
