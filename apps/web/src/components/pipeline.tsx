import { Link } from 'react-router';
import { ChevronRight } from 'lucide-react';
import { PIPELINE_FUNNEL, type PipelineCounts, type PipelineStage, type PullRequestRef } from '@ptd/shared';
import { cn, fmtNumber } from '../lib/utils';
import { PIPELINE_META } from './status';

export const stageHref = (stage: PipelineStage) => `/tests?pipelineStage=${stage}`;

/**
 * The automation funnel: Not started → … → Automated, each stage a link to the
 * filtered test-case list. "Ready to merge" (done, awaiting merge) is emphasised.
 */
export function PipelineFunnel({ counts, className }: { counts: PipelineCounts; className?: string }) {
  const automatable = PIPELINE_FUNNEL.reduce((n, s) => n + counts[s], 0);
  return (
    <div className={className}>
      <ol className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7" aria-label="Automation pipeline">
        {PIPELINE_FUNNEL.map((stage, i) => {
          const M = PIPELINE_META[stage];
          const n = counts[stage];
          const share = automatable > 0 ? n / automatable : 0;
          const hot = stage === 'ready_to_merge' && n > 0;
          return (
            <li key={stage} className="relative min-w-0">
              <Link
                to={stageHref(stage)}
                aria-label={`${M.label}: ${n} test case${n === 1 ? '' : 's'}`}
                data-stage={stage}
                className={cn(
                  'block h-full rounded-lg border px-3 py-2.5 outline-none transition-colors hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-ring/50',
                  hot
                    ? 'border-[color-mix(in_oklab,var(--st-passed)_45%,transparent)] bg-[color-mix(in_oklab,var(--st-passed)_7%,var(--surface))]'
                    : 'border-border',
                )}
              >
                <span className="flex items-start gap-1.5 text-xs leading-4 text-fg-2">
                  <M.icon className="mt-px size-3.5 shrink-0" style={{ color: M.color }} aria-hidden />
                  <span className="min-w-0">{M.label}</span>
                </span>
                <span className="mt-1 block text-lg font-semibold text-fg tabular">{fmtNumber(n)}</span>
                <span className="mt-1.5 block h-1 overflow-hidden rounded-full bg-surface-3" aria-hidden>
                  <span
                    className="block h-full rounded-full"
                    style={{ width: `${share * 100}%`, minWidth: n > 0 ? 3 : 0, background: M.color }}
                  />
                </span>
              </Link>
              {i < PIPELINE_FUNNEL.length - 1 ? (
                <ChevronRight
                  className="absolute top-1/2 -right-[11px] z-10 hidden size-3.5 -translate-y-1/2 rounded-full bg-surface text-fg-3 lg:block"
                  aria-hidden
                />
              ) : null}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** Linked PRs that put a case in its current stage (for the detail page / tooltips). */
export function prsDrivingStage(stage: PipelineStage, prs: readonly PullRequestRef[]): PullRequestRef[] {
  switch (stage) {
    case 'ready_to_merge':
      return prs.filter((p) => p.readyToMerge);
    case 'in_review':
      return prs.filter((p) => p.state === 'open' && !p.readyToMerge);
    case 'pr_draft':
      return prs.filter((p) => p.state === 'draft');
    case 'merged_awaiting_run': {
      const merged = prs.filter((p) => p.state === 'merged' && p.mergedAt);
      const latest = merged.reduce<string | null>((m, p) => (m === null || p.mergedAt! > m ? p.mergedAt! : m), null);
      return merged.filter((p) => p.mergedAt === latest);
    }
    default:
      return [];
  }
}

/** One-line explanation of a stage for the detail page. */
export const STAGE_HINT: Record<PipelineStage, string> = {
  not_started: 'Not automated yet and no pull request linked.',
  in_progress: 'Someone is writing the automation; no open pull request yet.',
  pr_draft: 'A draft pull request is open.',
  in_review: 'A pull request is open but not ready: review, threads or checks pending.',
  ready_to_merge: 'Done: approved, checks green, no unresolved threads — waiting to be merged.',
  merged_awaiting_run: 'Merged — waiting for a passed/failed result in a run after the merge.',
  automated: 'Automated and running.',
  not_automatable: 'Manual by design; excluded from the coverage rate.',
};
