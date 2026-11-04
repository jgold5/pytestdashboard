import { useId, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import {
  Bug as BugIcon,
  CircleCheck,
  CircleDashed,
  CircleDot,
  CircleSlash,
  ChevronsUp,
  ChevronUp,
  ChevronDown,
  Clock,
  Equal,
  Search,
  TriangleAlert,
  X,
  type LucideIcon,
} from 'lucide-react';
import { BugCreate, BugSeverity, BugStatus, LIMITS, type Bug, type BugRef, type BugVerification } from '@ptd/shared';
import { useCreateBug, useTestCases, useUpdateBug } from '../api/hooks';
import { ApiError } from '../api/client';
import { useDebounced } from '../lib/useDebounced';
import { safeHttpUrl } from '../lib/url';
import { cn, pluralize } from '../lib/utils';
import { Button } from './ui/button';
import { Dialog } from './ui/dialog';
import { Field, Input } from './ui/input';
import { Select } from './ui/select';
import { Tooltip } from './ui/tooltip';
import { ResultBadge } from './status';

interface Meta {
  label: string;
  icon: LucideIcon;
  color: string;
}

export const SEVERITY_META: Record<BugSeverity, Meta> = {
  critical: { label: 'Critical', icon: ChevronsUp, color: 'var(--st-failed)' },
  major: { label: 'Major', icon: ChevronUp, color: 'var(--st-broken)' },
  minor: { label: 'Minor', icon: Equal, color: 'var(--warn)' },
  trivial: { label: 'Trivial', icon: ChevronDown, color: 'var(--fg-3)' },
};

export const BUG_STATUS_META: Record<BugStatus, Meta> = {
  open: { label: 'Open', icon: CircleDot, color: 'var(--st-failed)' },
  in_progress: { label: 'In progress', icon: CircleDashed, color: 'var(--warn)' },
  resolved: { label: 'Resolved', icon: CircleCheck, color: 'var(--st-passed)' },
  closed: { label: 'Closed', icon: CircleCheck, color: 'var(--fg-3)' },
  wont_fix: { label: 'Won’t fix', icon: CircleSlash, color: 'var(--fg-3)' },
};

export const VERIFICATION_META: Record<BugVerification, Meta> = {
  verified_fixed: { label: 'Verified fixed', icon: CircleCheck, color: 'var(--st-passed)' },
  still_failing: { label: 'Still failing', icon: TriangleAlert, color: 'var(--st-failed)' },
  awaiting_run: { label: 'Awaiting run', icon: Clock, color: 'var(--accent)' },
  'n/a': { label: '—', icon: CircleDashed, color: 'var(--fg-3)' },
};

function Tint({ m, className }: { m: Meta; className?: string }) {
  return (
    <span
      className={cn('inline-flex items-center gap-1 rounded-full border px-1.5 py-px text-[11px] leading-[18px] font-medium whitespace-nowrap text-fg', className)}
      style={{ background: `color-mix(in oklab, ${m.color} 11%, transparent)`, borderColor: `color-mix(in oklab, ${m.color} 28%, transparent)` }}
    >
      <m.icon className="size-3" style={{ color: m.color }} strokeWidth={2.4} aria-hidden />
      {m.label}
    </span>
  );
}

export function SeverityBadge({ severity }: { severity: BugSeverity | null }) {
  if (!severity) return <span className="text-xs text-fg-3">—</span>;
  return <Tint m={SEVERITY_META[severity]} />;
}
export function BugStatusBadge({ status }: { status: BugStatus }) {
  return <Tint m={BUG_STATUS_META[status]} />;
}
export function VerificationBadge({ v }: { v: BugVerification }) {
  if (v === 'n/a') return <span className="text-xs text-fg-3">—</span>;
  return <Tint m={VERIFICATION_META[v]} />;
}

/** Compact bug chip (bug icon + key) with a tooltip — for tables / headers. */
export function BugBadge({ bug, className }: { bug: BugRef; className?: string }) {
  const stillFailing = bug.verification === 'still_failing';
  const label = bug.jiraKey ?? `#${bug.id}`;
  const href = safeHttpUrl(bug.url);
  const content = (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-px font-mono text-[11px] leading-[18px] whitespace-nowrap text-fg',
        stillFailing ? 'border-[color-mix(in_oklab,var(--st-failed)_45%,transparent)]' : 'border-[color-mix(in_oklab,var(--st-broken)_30%,transparent)]',
        'bg-[color-mix(in_oklab,var(--st-broken)_9%,transparent)]',
        className,
      )}
    >
      <BugIcon className="size-3" style={{ color: stillFailing ? 'var(--st-failed)' : 'var(--st-broken)' }} aria-hidden />
      {label}
    </span>
  );
  return (
    <Tooltip
      content={
        <div className="space-y-1">
          <div className="font-medium">{bug.title}</div>
          <div className="flex flex-wrap gap-1">
            <BugStatusBadge status={bug.status} />
            {bug.severity ? <SeverityBadge severity={bug.severity} /> : null}
            {bug.verification !== 'n/a' ? <VerificationBadge v={bug.verification} /> : null}
          </div>
        </div>
      }
    >
      {href ? (
        <a href={href} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} aria-label={`Bug ${label}: ${bug.title}`} className="rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
          {content}
        </a>
      ) : (
        <span tabIndex={0} aria-label={`Bug ${label}: ${bug.title}`} className="rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
          {content}
        </span>
      )}
    </Tooltip>
  );
}

// ---------------------------------------------------------------------------
// Test-case multi picker

export interface PickedCase {
  id: number;
  key: string;
  title: string;
}

export function TestCasePicker({ value, onChange, id }: { value: PickedCase[]; onChange: (v: PickedCase[]) => void; id: string }) {
  const [q, setQ] = useState('');
  const debounced = useDebounced(q.trim(), 200);
  const results = useTestCases({ search: debounced, pageSize: 8 }, { enabled: debounced.length > 0 });
  const options = (results.data?.items ?? []).filter((t) => !value.some((v) => v.id === t.id));
  return (
    <div>
      {value.length > 0 ? (
        <ul className="mb-2 flex flex-wrap gap-1.5" aria-label="Linked test cases">
          {value.map((v) => (
            <li key={v.id} className="inline-flex max-w-full items-center gap-1 rounded-md border border-border bg-surface-2 py-0.5 pr-0.5 pl-1.5 text-xs">
              <span className="font-mono text-fg-2">{v.key}</span>
              <span className="max-w-40 truncate text-fg">{v.title}</span>
              <button
                type="button"
                onClick={() => onChange(value.filter((x) => x.id !== v.id))}
                aria-label={`Remove ${v.key}`}
                className="grid size-5 place-items-center rounded text-fg-3 outline-none hover:bg-surface-3 hover:text-fg focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                <X className="size-3" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-fg-3" aria-hidden />
        <Input id={id} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search test cases to link…" className="pl-8" autoComplete="off" />
      </div>
      {debounced && options.length > 0 ? (
        <ul className="mt-1 max-h-48 overflow-auto rounded-md border border-border bg-surface p-1 shadow-sm" role="listbox" aria-label="Matching test cases">
          {options.map((t) => (
            <li key={t.id}>
              <button
                type="button"
                role="option"
                aria-selected={false}
                onClick={() => {
                  onChange([...value, { id: t.id, key: t.key, title: t.title }]);
                  setQ('');
                }}
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] outline-none hover:bg-surface-2 focus-visible:bg-surface-2"
              >
                <span className="w-20 shrink-0 truncate font-mono text-[11px] text-fg-3">{t.key}</span>
                <span className="min-w-0 flex-1 truncate text-fg">{t.title}</span>
                {t.lastResult ? <ResultBadge status={t.lastResult.status} /> : null}
              </button>
            </li>
          ))}
        </ul>
      ) : debounced && results.data && options.length === 0 ? (
        <p className="mt-1 text-xs text-fg-3">No matching test cases.</p>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create / edit dialog

export interface BugPrefill {
  title?: string;
  testCases?: PickedCase[];
  failureSignatures?: string[];
  foundInRunId?: number | null;
}

const SEVERITY_OPTIONS = BugSeverity.options.map((s) => {
  const M = SEVERITY_META[s];
  return { value: s, label: M.label, icon: <M.icon className="size-3.5" style={{ color: M.color }} aria-hidden /> };
});
const STATUS_OPTIONS = BugStatus.options.map((s) => {
  const M = BUG_STATUS_META[s];
  return { value: s, label: M.label, icon: <M.icon className="size-3.5" style={{ color: M.color }} aria-hidden /> };
});

export function BugDialog({
  open,
  onOpenChange,
  prefill,
  bug,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  prefill?: BugPrefill;
  /** When set, edits this bug. */
  bug?: Bug;
}) {
  const id = useId();
  const init = () => ({
    title: bug?.title ?? prefill?.title ?? '',
    jiraKey: bug?.jiraKey ?? '',
    url: bug?.url ?? '',
    status: bug?.status ?? ('open' as BugStatus),
    severity: bug?.severity ?? null,
    assignee: bug?.assignee ?? '',
    cases: bug?.testCases.map((t) => ({ id: t.id, key: t.key, title: t.title })) ?? prefill?.testCases ?? [],
  });
  const [d, setD] = useState(init);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const create = useCreateBug();
  const update = useUpdateBug();

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    const payload = {
      title: d.title,
      jiraKey: d.jiraKey.trim() ? d.jiraKey.trim().toUpperCase() : null,
      url: d.url.trim() || null,
      status: d.status,
      severity: d.severity,
      assignee: d.assignee.trim() || null,
      testCaseIds: d.cases.map((c) => c.id),
    };
    const r = BugCreate.safeParse({ ...payload, failureSignatures: bug ? bug.failureSignatures : (prefill?.failureSignatures ?? []), foundInRunId: prefill?.foundInRunId ?? null });
    if (!r.success) {
      const errs: Record<string, string> = {};
      r.error.issues.forEach((i) => (errs[String(i.path[0])] ??= i.code === 'too_small' ? 'Required' : i.message));
      return setErrors(errs);
    }
    setErrors({});
    const onError = (err: Error) => {
      if (err instanceof ApiError && err.status === 409) setErrors({ jiraKey: 'A bug with this Jira key already exists.' });
    };
    if (bug) {
      update.mutate(
        { id: bug.id, patch: payload },
        { onSuccess: () => { toast.success('Bug updated'); onOpenChange(false); }, onError },
      );
    } else {
      create.mutate(r.data, {
        onSuccess: (b) => {
          toast.success(`Bug logged${b.jiraKey ? `: ${b.jiraKey}` : ''}`, { description: `Linked to ${pluralize(b.testCases.length, 'test case')}` });
          onOpenChange(false);
        },
        onError,
      });
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (o) {
          setD(init());
          setErrors({});
        }
        onOpenChange(o);
      }}
      title={bug ? 'Edit bug' : 'Log bug'}
      description={bug ? undefined : 'Track a defect found by your tests. Linked tests verify the fix automatically once it’s resolved.'}
      className="max-w-xl"
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => submit()} loading={create.isPending || update.isPending}>
            {bug ? 'Save' : 'Log bug'}
          </Button>
        </>
      }
    >
      <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2">
        <Field label="Title" htmlFor={`${id}-title`} error={errors.title} className="sm:col-span-2">
          <Input id={`${id}-title`} value={d.title} maxLength={LIMITS.titleMax} onChange={(e) => setD({ ...d, title: e.target.value })} autoFocus aria-invalid={!!errors.title} />
        </Field>
        <Field label="Jira key" htmlFor={`${id}-jira`} error={errors.jiraKey} hint="Optional, e.g. PAY-123 — status syncs from Jira">
          <Input id={`${id}-jira`} value={d.jiraKey} maxLength={LIMITS.shortTextMax} onChange={(e) => setD({ ...d, jiraKey: e.target.value })} className="font-mono" aria-invalid={!!errors.jiraKey} />
        </Field>
        <Field label="Link" htmlFor={`${id}-url`} error={errors.url}>
          <Input id={`${id}-url`} type="url" value={d.url} maxLength={LIMITS.urlMax} placeholder="https://…" onChange={(e) => setD({ ...d, url: e.target.value })} aria-invalid={!!errors.url} />
        </Field>
        <Field label="Severity" htmlFor={`${id}-sev`}>
          <Select id={`${id}-sev`} value={d.severity} onValueChange={(v) => setD({ ...d, severity: v })} options={SEVERITY_OPTIONS} allowNone noneLabel="Not set" className="w-full" />
        </Field>
        <Field label="Status" htmlFor={`${id}-status`}>
          <Select id={`${id}-status`} value={d.status} onValueChange={(v) => v && setD({ ...d, status: v })} options={STATUS_OPTIONS} className="w-full" />
        </Field>
        <Field label="Assignee" htmlFor={`${id}-assignee`} className="sm:col-span-2">
          <Input id={`${id}-assignee`} value={d.assignee} maxLength={LIMITS.shortTextMax} onChange={(e) => setD({ ...d, assignee: e.target.value })} />
        </Field>
        <Field label="Linked test cases" htmlFor={`${id}-cases`} className="sm:col-span-2" error={errors.testCaseIds}>
          <TestCasePicker id={`${id}-cases`} value={d.cases} onChange={(cases) => setD({ ...d, cases })} />
        </Field>
        {prefill?.failureSignatures?.length && !bug ? (
          <p className="text-[11px] text-fg-3 sm:col-span-2">Future failures with the same error signature will be matched to this bug.</p>
        ) : null}
      </form>
    </Dialog>
  );
}
