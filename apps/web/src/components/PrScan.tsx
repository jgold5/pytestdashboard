import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CircleCheck, CircleDashed, CircleX, GitPullRequest, Loader2, MinusCircle } from 'lucide-react';
import type { PrScanStatus } from '@ptd/shared';
import { usePrScan, useStartPrScan, useTriggerGithub } from '../api/hooks';
import { errorMessage } from '../api/client';
import { qk } from '../api/hooks';
import { cn, fmtNumber, fmtRelative, pluralize } from '../lib/utils';
import { Button } from './ui/button';
import { Dialog } from './ui/dialog';
import { Tooltip } from './ui/tooltip';

type Row = PrScanStatus['prs'][number];
const STATUS: Record<Row['status'], { label: string; icon: typeof CircleCheck; cls: string }> = {
  pending: { label: 'Waiting', icon: CircleDashed, cls: 'text-fg-3' },
  scanning: { label: 'Scanning…', icon: Loader2, cls: 'text-fg' },
  scanned: { label: 'Scanned', icon: CircleCheck, cls: 'text-st-passed' },
  up_to_date: { label: 'Up to date', icon: CircleCheck, cls: 'text-fg-2' },
  failed: { label: 'Failed', icon: CircleX, cls: 'text-st-failed' },
  skipped: { label: 'Skipped', icon: MinusCircle, cls: 'text-fg-3' },
};
const ORDER: Row['status'][] = ['scanning', 'failed', 'pending', 'scanned', 'up_to_date', 'skipped'];

/**
 * "Scan open PRs": scans every open PR branch of the test repo, a few at a time, until all are
 * done. PRs already scanned at their latest commit are skipped, so running it again is quick.
 */
export function PrScanButton() {
  const gh = useTriggerGithub();
  const [open, setOpen] = useState(false);
  const start = useStartPrScan();
  if (!gh.data?.configured) return null;
  return (
    <>
      <Button
        size="sm"
        variant="outline"
        onClick={() => {
          setOpen(true);
          start.mutate();
        }}
      >
        <GitPullRequest /> Scan open PRs
      </Button>
      {open ? <PrScanDialog onClose={() => setOpen(false)} start={start} /> : null}
    </>
  );
}

function PrScanDialog({ onClose, start }: { onClose: () => void; start: ReturnType<typeof useStartPrScan> }) {
  const q = usePrScan();
  const st = q.data;
  const qc = useQueryClient();
  // when a run finishes, the numbers everywhere else change
  const was = useRef(st?.state);
  useEffect(() => {
    if (was.current === 'running' && st && st.state !== 'running') {
      void qc.invalidateQueries({ queryKey: ['triggers'] });
      void qc.invalidateQueries({ queryKey: qk.summary });
      void qc.invalidateQueries({ queryKey: ['report'] });
    }
    was.current = st?.state;
  }, [st, qc]);

  const running = st?.state === 'running' || start.isPending;
  const prs = st?.prs ?? [];
  const count = (s: Row['status']) => prs.filter((p) => p.status === s).length;
  const finished = prs.length - count('pending') - count('scanning');
  const rows = [...prs].sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status) || b.number - a.number);

  return (
    <Dialog
      open
      onOpenChange={(o) => (!o ? onClose() : undefined)}
      title="Open PRs in the test repo"
      description="Each open PR's branch is scanned as tests, 3 at a time, until all are done. A PR already scanned at its latest commit is skipped. Its tests count as not merged yet on the branch the PR targets."
      className="max-w-2xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          <Button variant="primary" onClick={() => start.mutate()} loading={running} disabled={running}>
            {running ? 'Scanning…' : 'Scan again'}
          </Button>
        </>
      }
    >
      {start.isError ? <p className="mb-3 text-[13px] text-bad">{errorMessage(start.error)}</p> : null}
      {st?.state === 'error' && st.error ? <p className="mb-3 text-[13px] text-bad">{st.error}</p> : null}
      {st && st.repos.length > 0 ? (
        <div className="mb-3 space-y-2">
          <div className="flex flex-wrap items-baseline justify-between gap-2 text-[13px]">
            <span className="font-mono text-xs text-fg-2">{st.repos.join(', ')}</span>
            <span className="text-fg-2 tabular">
              {running ? (
                <>
                  {fmtNumber(finished)} of {fmtNumber(prs.length)} done
                </>
              ) : st.finishedAt ? (
                <>Finished {fmtRelative(st.finishedAt)}</>
              ) : null}
            </span>
          </div>
          <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-surface-3" role="progressbar" aria-valuemin={0} aria-valuemax={prs.length} aria-valuenow={finished} aria-label="PR branches done">
            <span className="h-full bg-accent transition-[width]" style={{ width: `${prs.length ? (finished / prs.length) * 100 : running ? 5 : 100}%` }} />
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-fg-2 tabular">
            <span>{pluralize(count('scanned'), 'scanned now', 'scanned now')}</span>
            <span>{fmtNumber(count('up_to_date'))} up to date (skipped)</span>
            {count('pending') + count('scanning') > 0 ? <span>{fmtNumber(count('pending') + count('scanning'))} to go</span> : null}
            {count('failed') > 0 ? <span className="text-bad">{fmtNumber(count('failed'))} failed</span> : null}
            {count('skipped') > 0 ? <span>{fmtNumber(count('skipped'))} not scannable</span> : null}
            {st.removed > 0 ? <span>{pluralize(st.removed, 'closed PR')} removed</span> : null}
          </div>
        </div>
      ) : running ? (
        <p className="text-[13px] text-fg-2">Listing open PRs…</p>
      ) : null}
      {rows.length > 0 ? (
        <div className="-mx-1 max-h-[45vh] overflow-auto">
          <table className="w-full text-[13px]">
            <tbody>
              {rows.map((p) => {
                const s = STATUS[p.status];
                return (
                  <tr key={`${p.repo}#${p.number}`} className="border-b border-border last:border-b-0">
                    <td className="max-w-64 px-1 py-1.5">
                      <div className="truncate text-fg" title={p.title}>
                        <span className="font-mono text-xs text-fg-3">#{p.number}</span> {p.title}
                      </div>
                      <div className="truncate font-mono text-[11px] text-fg-3" title={`${p.branch} → ${p.base}`}>
                        {p.branch} → {p.base}
                      </div>
                    </td>
                    <td className="px-1 py-1.5 text-right whitespace-nowrap">
                      <Tooltip content={p.error ?? (p.commit ? `at ${p.commit}${p.scannedAt ? `, scanned ${fmtRelative(p.scannedAt)}` : ''}` : null)} side="left">
                        <span className={cn('inline-flex items-center gap-1.5 text-xs font-medium', s.cls)}>
                          <s.icon className={cn('size-3.5', p.status === 'scanning' && 'animate-spin')} aria-hidden />
                          {s.label}
                          {p.commit && (p.status === 'scanned' || p.status === 'up_to_date') ? <span className="font-mono font-normal text-fg-3">{p.commit.slice(0, 7)}</span> : null}
                        </span>
                      </Tooltip>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : st?.state === 'done' ? (
        <p className="text-[13px] text-fg-2">No open PRs in the test repo.</p>
      ) : null}
    </Dialog>
  );
}
