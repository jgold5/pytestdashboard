import {
  Bot,
  CircleCheck,
  CircleDashed,
  CircleDot,
  CircleHelp,
  CircleMinus,
  CircleX,
  Clock,
  Hand,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  Microscope,
  Bug,
  FlaskConical,
  Server,
  Shuffle,
  BookMarked,
  TriangleAlert,
  MessageSquare,
  UserRoundCheck,
  type LucideIcon,
} from 'lucide-react';
import {
  AUTOMATION_STATUS_LABELS,
  TRIAGE_LABELS,
  type AutomationStatus,
  type PullRequestRef,
  type ResultStatus,
  type TriageCategory,
} from '@ptd/shared';
import { cn } from '../lib/utils';
import { Tooltip } from './ui/tooltip';
import { fmtRelative } from '../lib/utils';

/*
 * One place for every status → (color, icon, label) mapping, so the same state
 * looks identical on every page. Color is never the only channel: every badge
 * carries an icon and a text label (or an aria-label + tooltip when compact).
 */

export interface StatusMeta {
  label: string;
  icon: LucideIcon;
  /** CSS color (var) for the icon / mark */
  color: string;
}

export const RESULT_META: Record<ResultStatus, StatusMeta> = {
  passed: { label: 'Passed', icon: CircleCheck, color: 'var(--st-passed)' },
  failed: { label: 'Failed', icon: CircleX, color: 'var(--st-failed)' },
  broken: { label: 'Broken', icon: TriangleAlert, color: 'var(--st-broken)' },
  skipped: { label: 'Skipped', icon: CircleMinus, color: 'var(--st-skipped)' },
  unknown: { label: 'Unknown', icon: CircleHelp, color: 'var(--st-unknown)' },
};

export const AUTOMATION_META: Record<AutomationStatus, StatusMeta> = {
  automated: { label: AUTOMATION_STATUS_LABELS.automated, icon: Bot, color: 'var(--au-automated)' },
  in_progress: { label: AUTOMATION_STATUS_LABELS.in_progress, icon: CircleDashed, color: 'var(--au-progress)' },
  not_automated: { label: AUTOMATION_STATUS_LABELS.not_automated, icon: CircleDot, color: 'var(--fg-3)' },
  not_automatable: { label: AUTOMATION_STATUS_LABELS.not_automatable, icon: Hand, color: 'var(--fg-3)' },
};

export const TRIAGE_META: Record<TriageCategory, StatusMeta> = {
  needs_investigation: { label: TRIAGE_LABELS.needs_investigation, icon: Microscope, color: 'var(--tr-needs_investigation)' },
  product_bug: { label: TRIAGE_LABELS.product_bug, icon: Bug, color: 'var(--tr-product_bug)' },
  test_bug: { label: TRIAGE_LABELS.test_bug, icon: FlaskConical, color: 'var(--tr-test_bug)' },
  environment: { label: TRIAGE_LABELS.environment, icon: Server, color: 'var(--tr-environment)' },
  flaky: { label: TRIAGE_LABELS.flaky, icon: Shuffle, color: 'var(--tr-flaky)' },
  known_issue: { label: TRIAGE_LABELS.known_issue, icon: BookMarked, color: 'var(--tr-known_issue)' },
};

export const PR_STATE_META: Record<PullRequestRef['state'], StatusMeta> = {
  open: { label: 'Open', icon: GitPullRequest, color: 'var(--st-passed)' },
  draft: { label: 'Draft', icon: GitPullRequestDraft, color: 'var(--fg-3)' },
  merged: { label: 'Merged', icon: GitMerge, color: 'var(--st-unknown)' },
  closed: { label: 'Closed', icon: GitPullRequestClosed, color: 'var(--st-failed)' },
};

export const REVIEW_META: Record<PullRequestRef['reviewState'], StatusMeta> = {
  review_required: { label: 'Review required', icon: Clock, color: 'var(--warn)' },
  changes_requested: { label: 'Changes requested', icon: TriangleAlert, color: 'var(--st-failed)' },
  approved: { label: 'Approved', icon: UserRoundCheck, color: 'var(--st-passed)' },
  none: { label: 'No review', icon: CircleMinus, color: 'var(--fg-3)' },
};

export const CHECKS_META: Record<PullRequestRef['checks'], StatusMeta> = {
  passing: { label: 'Checks passing', icon: CircleCheck, color: 'var(--st-passed)' },
  failing: { label: 'Checks failing', icon: CircleX, color: 'var(--st-failed)' },
  pending: { label: 'Checks pending', icon: CircleDashed, color: 'var(--warn)' },
  none: { label: 'No checks', icon: CircleMinus, color: 'var(--fg-3)' },
};

const badgeBase =
  'inline-flex max-w-full shrink-0 items-center gap-1 rounded-full border px-1.5 py-px text-[11px] leading-[18px] font-medium whitespace-nowrap';

function TintBadge({ meta, className, compact }: { meta: StatusMeta; className?: string; compact?: boolean }) {
  const Icon = meta.icon;
  const style = {
    background: `color-mix(in oklab, ${meta.color} 11%, transparent)`,
    borderColor: `color-mix(in oklab, ${meta.color} 26%, transparent)`,
  };
  if (compact) {
    return (
      <Tooltip content={meta.label}>
        <span className={cn('inline-flex shrink-0', className)} role="img" aria-label={meta.label}>
          <Icon className="size-4" style={{ color: meta.color }} aria-hidden />
        </span>
      </Tooltip>
    );
  }
  return (
    <span className={cn(badgeBase, 'text-fg', className)} style={style}>
      <Icon className="size-3" style={{ color: meta.color }} aria-hidden strokeWidth={2.4} />
      <span className="truncate">{meta.label}</span>
    </span>
  );
}

export function ResultBadge({ status, compact, className }: { status: ResultStatus; compact?: boolean; className?: string }) {
  return <TintBadge meta={RESULT_META[status]} compact={compact} className={className} />;
}

export function AutomationBadge({ status, className }: { status: AutomationStatus; className?: string }) {
  return <TintBadge meta={AUTOMATION_META[status]} className={className} />;
}

export function TriageBadge({ triage, className }: { triage: TriageCategory; className?: string }) {
  return <TintBadge meta={TRIAGE_META[triage]} className={className} />;
}

export function PrStateBadge({ state, className }: { state: PullRequestRef['state']; className?: string }) {
  return <TintBadge meta={PR_STATE_META[state]} className={className} />;
}

export function ReviewBadge({ state, className }: { state: PullRequestRef['reviewState']; className?: string }) {
  return <TintBadge meta={REVIEW_META[state]} className={className} />;
}

export function ChecksBadge({
  checks,
  className,
  compact,
}: {
  checks: PullRequestRef['checks'];
  className?: string;
  compact?: boolean;
}) {
  return <TintBadge meta={CHECKS_META[checks]} className={className} compact={compact} />;
}

export function ThreadsCount({ count, className }: { count: number; className?: string }) {
  const label = `${count} unresolved comment thread${count === 1 ? '' : 's'}`;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 text-xs tabular',
        count > 0 ? 'font-medium text-fg' : 'text-fg-3',
        className,
      )}
      aria-label={label}
      title={label}
    >
      <MessageSquare className="size-3.5" style={{ color: count > 0 ? 'var(--warn)' : undefined }} aria-hidden />
      {count}
    </span>
  );
}

/** Small colored dot + icon-less marker, used in legends next to text. */
export function Swatch({ color, className, shape = 'square' }: { color: string; className?: string; shape?: 'square' | 'line' | 'dot' }) {
  return (
    <span
      aria-hidden
      className={cn(
        'inline-block shrink-0',
        shape === 'square' && 'size-2.5 rounded-[3px]',
        shape === 'dot' && 'size-2 rounded-full',
        shape === 'line' && 'h-0.5 w-3 rounded-full',
        className,
      )}
      style={{ background: color }}
    />
  );
}

/** "In PR" badge with a tooltip listing each open linked PR and its review state. */
export function InPrBadge({ prs, className }: { prs: PullRequestRef[]; className?: string }) {
  const open = prs.filter((p) => p.state === 'open' || p.state === 'draft');
  if (open.length === 0) return null;
  const attention = open.some((p) => p.needsAttention);
  return (
    <Tooltip
      content={
        <div className="space-y-1.5 py-0.5">
          {open.map((p) => (
            <div key={`${p.repo}#${p.number}`} className="min-w-0">
              <div className="truncate font-medium">
                {p.repo}#{p.number} · {p.title}
              </div>
              <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-fg-2">
                <span>{PR_STATE_META[p.state].label}</span>
                <span>· {REVIEW_META[p.reviewState].label}</span>
                <span>· {CHECKS_META[p.checks].label}</span>
                {p.unresolvedThreads > 0 ? <span>· {p.unresolvedThreads} unresolved</span> : null}
                <span>· updated {fmtRelative(p.updatedAt)}</span>
              </div>
            </div>
          ))}
        </div>
      }
    >
      <span
        tabIndex={0}
        className={cn(
          badgeBase,
          'cursor-default border-[color-mix(in_oklab,var(--au-inpr)_30%,transparent)] bg-[color-mix(in_oklab,var(--au-inpr)_12%,transparent)] text-fg outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
          className,
        )}
        aria-label={`In ${open.length} open pull request${open.length > 1 ? 's' : ''}${attention ? ', needs attention' : ''}`}
      >
        <GitPullRequest className="size-3" style={{ color: 'var(--au-inpr)' }} aria-hidden strokeWidth={2.4} />
        In PR{open.length > 1 ? ` ·${open.length}` : ''}
        {attention ? <span className="ml-0.5 size-1.5 rounded-full bg-st-failed" aria-hidden /> : null}
      </span>
    </Tooltip>
  );
}

export function FlakyMeter({ value, className }: { value: number; className?: string }) {
  const pct = Math.round(value * 100);
  const color = value >= 0.3 ? 'var(--st-broken)' : value > 0 ? 'var(--warn)' : 'var(--fg-3)';
  return (
    <span className={cn('inline-flex items-center gap-1.5', className)} title={`Flakiness ${pct}%`}>
      <span className="h-1 w-10 overflow-hidden rounded-full bg-surface-3" aria-hidden>
        <span className="block h-full rounded-full" style={{ width: `${Math.max(pct, value > 0 ? 6 : 0)}%`, background: color }} />
      </span>
      <span className="text-xs tabular text-fg-2">{pct}%</span>
    </span>
  );
}
