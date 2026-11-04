import type { Run } from '@ptd/shared';
import { cn, fmtPct } from '../lib/utils';
import { SegmentedBar } from './ui/misc';
import { RESULT_META } from './status';

export function PassRateBar({ r, className }: { r: Pick<Run, 'counts' | 'passRate'>; className?: string }) {
  const c = r.counts;
  return (
    <div className={cn('flex items-center gap-2', className)}>
      <SegmentedBar
        label="Results"
        height={6}
        className="w-24 sm:w-32"
        parts={[
          { label: 'Passed', value: c.passed, color: RESULT_META.passed.color },
          { label: 'Failed', value: c.failed, color: RESULT_META.failed.color },
          { label: 'Broken', value: c.broken, color: RESULT_META.broken.color },
          { label: 'Skipped', value: c.skipped, color: RESULT_META.skipped.color },
          { label: 'Unknown', value: c.unknown, color: RESULT_META.unknown.color },
        ]}
      />
      <span className="w-12 text-right text-[13px] font-semibold text-fg tabular">{fmtPct(r.passRate)}</span>
    </div>
  );
}

