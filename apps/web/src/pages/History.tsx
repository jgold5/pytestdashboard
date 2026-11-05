import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { ChevronLeft, ChevronRight, GitBranch, Grid3x3, Search, TriangleAlert } from 'lucide-react';
import type { HistoryMatrix, ResultStatus } from '@ptd/shared';
import { useHistoryMatrix, useMeta } from '../api/hooks';
import { useDebounced } from '../lib/useDebounced';
import { useRunGroupSelection } from '../lib/runGroup';
import { cn, fmtDate, fmtDateTime, fmtNumber, fmtPct } from '../lib/utils';
import { Button } from '../components/ui/button';
import { Card } from '../components/ui/card';
import { EmptyState, ErrorState } from '../components/ui/empty-state';
import { Input } from '../components/ui/input';
import { Select } from '../components/ui/select';
import { Skeleton } from '../components/ui/skeleton';
import { linkButton } from '../components/ui/link-button';
import { RunsHeader } from '../components/RunsTabs';
import { RunGroupPicker } from '../components/RunGroup';
import { RESULT_META } from '../components/status';

/*
 * Tests × runs heatmap. Built for speed: cells are plain <div>s (no per-cell
 * components, listeners or tooltips). A single delegated pointer/focus handler
 * on the grid drives ONE tooltip element. Each cell = color + glyph so status
 * never relies on color alone.
 */

const CELL = 16; // px incl. gap
const GLYPH: Record<ResultStatus, string> = { passed: '', failed: '×', broken: '!', skipped: '–', unknown: '?' };
const RUN_OPTIONS = [10, 20, 30, 60];
// Passing cells recede so failures pop; still clearly green (and failures carry a glyph).
const PASSED_SOFT = 'color-mix(in oklab, var(--st-passed) 62%, var(--surface))';

type MRow = HistoryMatrix['rows'][number];
type MRun = HistoryMatrix['runs'][number];

export default function HistoryPage() {
  const { groups, value: group, setValue: setGroup, loading: groupsLoading } = useRunGroupSelection();
  const meta = useMeta();
  const [params, setParams] = useSearchParams();
  const runs = RUN_OPTIONS.includes(Number(params.get('runs'))) ? Number(params.get('runs')) : 30;
  const branch = params.get('branch') ?? undefined;
  const suite = params.get('suite') ?? undefined;
  const onlyUnstable = params.get('all') !== '1';
  const page = Math.max(1, Number(params.get('page')) || 1);
  const [search, setSearch] = useState(params.get('search') ?? '');
  const debounced = useDebounced(search.trim(), 300);

  const set = useCallback(
    (patch: Record<string, string | null>) =>
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
      ),
    [setParams],
  );

  useEffect(() => {
    if ((params.get('search') ?? '') !== debounced) set({ search: debounced || null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);

  const pageSize = 50;
  const matrix = useHistoryMatrix(
    { runs, runGroup: group ?? undefined, branch, suite, search: debounced || undefined, onlyUnstable, page, pageSize },
    { enabled: !groupsLoading },
  );
  const data = matrix.data;
  const pages = data ? Math.max(1, Math.ceil(data.total / pageSize)) : 1;

  return (
    <>
      <RunsHeader />
      <div className="mb-3 space-y-3">
        <RunGroupPicker groups={groups} value={group} onChange={setGroup} />
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative w-full sm:w-56">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-fg-3" aria-hidden />
            <Input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Filter tests…" aria-label="Filter tests" className="pl-8" />
          </div>
          <Select
            ariaLabel="Branch"
            value={branch ?? null}
            onValueChange={(v) => set({ branch: v })}
            options={(meta.data?.branches ?? []).map((b) => ({ value: b, label: b, icon: <GitBranch className="size-3.5 text-fg-3" aria-hidden /> }))}
            allowNone
            noneLabel="All branches"
            className="max-w-48"
          />
          <Select
            ariaLabel="Suite"
            value={suite ?? null}
            onValueChange={(v) => set({ suite: v })}
            options={(meta.data?.suites ?? []).map((s) => ({ value: s, label: s }))}
            allowNone
            noneLabel="All suites"
            className="max-w-48"
          />
          <Select
            ariaLabel="Number of runs"
            value={String(runs)}
            onValueChange={(v) => set({ runs: v })}
            options={RUN_OPTIONS.map((n) => ({ value: String(n), label: `Last ${n} runs` }))}
          />
          <div role="radiogroup" aria-label="Rows" className="inline-flex rounded-md border border-border bg-surface-2 p-0.5">
            {[
              { v: true, l: 'Unstable only' },
              { v: false, l: 'All tests' },
            ].map((o) => (
              <button
                key={o.l}
                type="button"
                role="radio"
                aria-checked={onlyUnstable === o.v}
                onClick={() => set({ all: o.v ? null : '1' })}
                className={cn(
                  'h-7 rounded-[5px] px-2.5 text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
                  onlyUnstable === o.v ? 'bg-surface text-fg shadow-sm' : 'text-fg-2 hover:text-fg',
                )}
              >
                {o.l}
              </button>
            ))}
          </div>
        </div>
      </div>

      <Card className="overflow-hidden">
        {matrix.isError ? (
          <ErrorState error={matrix.error} onRetry={() => void matrix.refetch()} />
        ) : !data ? (
          <MatrixSkeleton />
        ) : data.runs.length === 0 ? (
          <EmptyState
            icon={<Grid3x3 />}
            title="No runs in this group yet"
            actions={
              <Link to="/import#allure" className={linkButton('primary')}>
                Upload allure-results
              </Link>
            }
          >
            The matrix shows how every test behaved across the latest runs of one run group.
          </EmptyState>
        ) : data.rows.length === 0 ? (
          <EmptyState icon={<Grid3x3 />} title={onlyUnstable ? 'Nothing unstable — every test passed in this window' : 'No tests match'}>
            {onlyUnstable ? (
              <button type="button" className="link" onClick={() => set({ all: '1' })}>
                Show all tests
              </button>
            ) : (
              'Try a different filter.'
            )}
          </EmptyState>
        ) : (
          <div className={cn(matrix.isPlaceholderData && 'opacity-60 transition-opacity')}>
            <MatrixLegend data={data} onlyUnstable={onlyUnstable} />
            <MatrixGrid data={data} />
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-4 py-2 text-xs text-fg-2">
              <span className="tabular">
                {fmtNumber(data.total)} {onlyUnstable ? 'unstable ' : ''}tests · sorted by instability
              </span>
              {pages > 1 ? (
                <div className="flex items-center gap-2">
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
            </div>
          </div>
        )}
      </Card>
    </>
  );
}

function MatrixSkeleton() {
  return (
    <div className="space-y-1.5 p-4" role="status" aria-label="Loading history">
      {Array.from({ length: 12 }, (_, i) => (
        <div key={i} className="flex items-center gap-3">
          <Skeleton className="h-3.5 w-56" />
          <Skeleton className="h-3.5 flex-1" />
        </div>
      ))}
    </div>
  );
}

function MatrixLegend({ data, onlyUnstable }: { data: HistoryMatrix; onlyUnstable: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border px-4 py-2.5 text-xs text-fg-2">
      <span className="font-medium text-fg">
        {data.rows.length} tests × {data.runs.length} runs
      </span>
      {(['passed', 'failed', 'broken', 'skipped', 'unknown'] as const).map((s) => (
        <span key={s} className="inline-flex items-center gap-1.5">
          <span className="grid size-3 place-items-center rounded-[3px] text-[9px] leading-none font-bold text-white" style={{ background: s === 'passed' ? PASSED_SOFT : RESULT_META[s].color }} aria-hidden>
            {GLYPH[s]}
          </span>
          {RESULT_META[s].label}
        </span>
      ))}
      <span className="inline-flex items-center gap-1.5">
        <span className="size-3 rounded-[3px] border border-dashed border-border-strong" aria-hidden />
        Not run
      </span>
      {onlyUnstable ? (
        <span className="ml-auto inline-flex items-center gap-1 text-fg-3">
          <TriangleAlert className="size-3" aria-hidden /> Showing tests with ≥1 failure in this window
        </span>
      ) : null}
    </div>
  );
}

interface Hover {
  r: number;
  c: number;
  x: number;
  y: number;
}

function MatrixGrid({ data }: { data: HistoryMatrix }) {
  const navigate = useNavigate();
  const wrapRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<Hover | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Newest runs are on the right: start scrolled to the end on narrow screens.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [data.runs.length]);
  const nameCol = 'w-[150px] min-w-[150px] max-w-[150px] sm:w-auto sm:min-w-[260px] sm:max-w-[420px]';

  const locate = (target: EventTarget | null): Hover | null => {
    const el = (target as HTMLElement | null)?.closest<HTMLElement>('[data-c]');
    const wrap = wrapRef.current;
    if (!el || !wrap) return null;
    const rect = el.getBoundingClientRect();
    const wrect = wrap.getBoundingClientRect();
    return {
      r: Number(el.dataset.r),
      c: Number(el.dataset.c),
      x: rect.left - wrect.left + rect.width / 2,
      y: rect.top - wrect.top,
    };
  };

  const open = (h: Hover | null) => {
    if (!h || h.r < 0) return; // run header cells are real links
    const row = data.rows[h.r];
    const cell = row?.cells[h.c];
    if (row && cell?.status) void navigate(`/tests/${row.testCase.id}`);
  };

  return (
    <div className="relative" ref={wrapRef} onPointerLeave={() => setHover(null)}>
      <div
        ref={scrollRef}
        className="max-h-[calc(100dvh-300px)] min-h-64 overflow-auto overscroll-x-contain"
        onPointerOver={(e) => setHover(locate(e.target))}
        onClick={(e) => open(locate(e.target))}
        onScroll={() => setHover(null)}
      >
        <table className="w-full border-separate border-spacing-0 text-[12px]" role="grid" aria-label="Test history matrix" aria-rowcount={data.rows.length + 1}>
          <thead>
            <tr>
              <th scope="col" className={cn('sticky top-0 left-0 z-30 border-b border-border bg-surface px-4 pb-2 text-left align-bottom text-[11px] font-medium text-fg-3', nameCol)}>
                Test
                <span className="block font-normal">oldest → newest</span>
              </th>
              {data.runs.map((run, c) => (
                <RunHeaderCell key={run.id} run={run} c={c} last={c === data.runs.length - 1} />
              ))}
              <th scope="col" className="sticky top-0 z-20 border-b border-border bg-surface px-3 pb-2 text-right align-bottom text-[11px] font-medium whitespace-nowrap text-fg-3">
                Fails · flips
              </th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((row, r) => (
              <MatrixRow key={row.testCase.id} row={row} r={r} nameCol={nameCol} />
            ))}
          </tbody>
        </table>
      </div>
      {hover ? <CellTooltip data={data} hover={hover} /> : null}
    </div>
  );
}

const RunHeaderCell = memo(function RunHeaderCell({ run, c, last }: { run: MRun; c: number; last: boolean }) {
  const when = run.startedAt ?? run.importedAt;
  const rate = run.passRate;
  return (
    <th scope="col" className={cn('sticky top-0 z-20 border-b border-border bg-surface p-0 align-bottom font-normal', last && 'pr-2')}>
      <Link
        to={`/runs/${run.id}`}
        data-r={-1}
        data-c={c}
        className="flex h-[74px] flex-col items-center justify-end gap-1 pb-2 outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        style={{ width: CELL }}
        aria-label={`${run.name}, ${fmtDateTime(when)}, pass rate ${fmtPct(rate)}`}
      >
        <span className="text-[10px] whitespace-nowrap text-fg-3 tabular [writing-mode:vertical-rl] rotate-180">{fmtDate(when, 'MMM d')}</span>
        {/* pass-rate tick: height encodes rate */}
        <span className="relative h-2.5 w-[10px] overflow-hidden rounded-[2px] bg-surface-3" aria-hidden>
          <span
            className="absolute inset-x-0 bottom-0"
            style={{ height: `${(rate ?? 0) * 100}%`, background: rate == null ? 'transparent' : rate >= 0.95 ? 'var(--st-passed)' : rate >= 0.85 ? 'var(--warn)' : 'var(--st-failed)' }}
          />
        </span>
      </Link>
    </th>
  );
});

const MatrixRow = memo(function MatrixRow({ row, r, nameCol }: { row: MRow; r: number; nameCol: string }) {
  return (
    <tr className="group">
      <th scope="row" className={cn('sticky left-0 z-10 border-b border-border bg-surface px-4 py-0 text-left font-normal group-hover:bg-surface-2', nameCol)}>
        <Link
          to={`/tests/${row.testCase.id}`}
          className="block truncate py-[3px] text-[12px] text-fg outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/50"
          title={`${row.testCase.key}\n${row.testCase.title}`}
          aria-label={`${row.testCase.title}: ${row.failures} failures, ${row.flips} flips`}
        >
          {row.testCase.title}
        </Link>
      </th>
      {row.cells.map((cell, c) => {
        const s = cell.status;
        return (
          <td key={c} className="border-b border-border p-0 group-hover:bg-surface-2/60" aria-hidden>
            <div data-r={r} data-c={c} className={cn('grid place-items-center', s && 'cursor-pointer')} style={{ width: CELL, height: 22 }}>
              {s ? (
                <span className="grid size-3 place-items-center rounded-[3px] text-[9px] leading-none font-bold text-white" style={{ background: s === 'passed' ? PASSED_SOFT : RESULT_META[s].color }}>
                  {GLYPH[s]}
                </span>
              ) : (
                <span className="size-3 rounded-[3px] border border-dashed border-border" />
              )}
            </div>
          </td>
        );
      })}
      <td className="border-b border-border px-3 text-right text-[11px] whitespace-nowrap text-fg-2 tabular group-hover:bg-surface-2/60">
        <span className={row.failures > 0 ? 'font-medium text-fg' : ''}>{row.failures}</span>
        <span className="text-fg-3"> · {row.flips}</span>
      </td>
    </tr>
  );
});

function CellTooltip({ data, hover }: { data: HistoryMatrix; hover: Hover }) {
  const run = data.runs[hover.c];
  if (!run) return null;
  const when = run.startedAt ?? run.importedAt;
  const row = hover.r >= 0 ? data.rows[hover.r] : null;
  const status = row ? row.cells[hover.c]?.status ?? null : null;
  const M = status ? RESULT_META[status] : null;
  return (
    <div
      role="tooltip"
      className="pointer-events-none absolute z-40 max-w-72 -translate-x-1/2 -translate-y-full rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs shadow-md"
      style={{ left: hover.x, top: hover.y - 6 }}
    >
      {row ? <div className="mb-0.5 truncate font-medium text-fg">{row.testCase.title}</div> : null}
      {row ? (
        <div className="flex items-center gap-1.5">
          {M ? <M.icon className="size-3.5" style={{ color: M.color }} aria-hidden /> : null}
          <span className="font-semibold text-fg">{M ? M.label : 'Not run'}</span>
        </div>
      ) : (
        <div className="font-semibold text-fg">Pass rate {fmtPct(run.passRate, 1)}</div>
      )}
      <div className="mt-0.5 text-fg-2">
        {run.name} · {fmtDateTime(when)}
        {run.branch ? ` · ${run.branch}` : ''}
      </div>
    </div>
  );
}
