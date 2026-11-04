import { useId, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import {
  AutomationStatus,
  LIMITS,
  Priority,
  TestCaseCreate,
  TestCaseUpdate,
  type TestCase,
} from '@ptd/shared';
import { useCreateTestCase, useMeta } from '../api/hooks';
import { ApiError } from '../api/client';
import { Button } from './ui/button';
import { Dialog } from './ui/dialog';
import { Field, Input } from './ui/input';
import { Select } from './ui/select';
import { AUTOMATION_META } from './status';

export const AUTOMATION_OPTIONS = AutomationStatus.options.map((s) => {
  const M = AUTOMATION_META[s];
  return { value: s, label: M.label, text: M.label, icon: <M.icon className="size-3.5" style={{ color: M.color }} aria-hidden /> };
});
export const PRIORITY_OPTIONS = Priority.options.map((p) => ({ value: p, label: p }));

export interface CaseDraft {
  key: string;
  title: string;
  suite: string;
  priority: Priority | null;
  automationStatus: AutomationStatus;
  owner: string;
  tags: string;
  externalUrl: string;
  jiraKey: string;
  allureFullName: string;
  allureId: string;
}

export function draftFromCase(t?: TestCase): CaseDraft {
  return {
    key: t?.key ?? '',
    title: t?.title ?? '',
    suite: t?.suite ?? '',
    priority: t?.priority ?? null,
    automationStatus: t?.automationStatus ?? 'not_automated',
    owner: t?.owner ?? '',
    tags: t?.tags.join(', ') ?? '',
    externalUrl: t?.externalUrl ?? '',
    jiraKey: t?.jiraKey ?? '',
    allureFullName: t?.allureFullName ?? '',
    allureId: t?.allureId ?? '',
  };
}

const orNull = (s: string) => (s.trim() ? s.trim() : null);

export function draftToPayload(d: CaseDraft) {
  return {
    key: d.key,
    title: d.title,
    suite: orNull(d.suite),
    priority: d.priority,
    automationStatus: d.automationStatus,
    owner: orNull(d.owner),
    tags: d.tags
      .split(/[,;|]/)
      .map((t) => t.trim())
      .filter(Boolean),
    externalUrl: orNull(d.externalUrl),
    jiraKey: orNull(d.jiraKey)?.toUpperCase() ?? null,
    allureFullName: orNull(d.allureFullName),
    allureId: orNull(d.allureId),
  };
}

export function validateCase(d: CaseDraft, mode: 'create' | 'update') {
  const schema = mode === 'create' ? TestCaseCreate : TestCaseUpdate;
  const r = schema.safeParse(draftToPayload(d));
  if (r.success) return { ok: true as const, value: r.data };
  const errors: Record<string, string> = {};
  for (const i of r.error.issues) {
    const k = String(i.path[0] ?? 'form');
    errors[k] ??= i.message.startsWith('Too small') || i.code === 'too_small' ? 'Required' : i.message;
  }
  return { ok: false as const, errors };
}

export function CaseFields({
  draft,
  onChange,
  errors,
  showKey = true,
}: {
  draft: CaseDraft;
  onChange: (d: CaseDraft) => void;
  errors: Record<string, string>;
  showKey?: boolean;
}) {
  const id = useId();
  const meta = useMeta();
  const set = <K extends keyof CaseDraft>(k: K, v: CaseDraft[K]) => onChange({ ...draft, [k]: v });
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {showKey ? (
        <Field label="Key" htmlFor={`${id}-key`} error={errors.key} hint="Unique, e.g. TC-123">
          <Input id={`${id}-key`} value={draft.key} maxLength={LIMITS.keyMax} onChange={(e) => set('key', e.target.value)} aria-invalid={!!errors.key} className="font-mono" />
        </Field>
      ) : null}
      <Field label="Jira / Xray key" htmlFor={`${id}-jira`} error={errors.jiraKey} hint="e.g. QA-123">
        <Input id={`${id}-jira`} value={draft.jiraKey} maxLength={LIMITS.shortTextMax} onChange={(e) => set('jiraKey', e.target.value)} aria-invalid={!!errors.jiraKey} className="font-mono" />
      </Field>
      <Field label="Title" htmlFor={`${id}-title`} error={errors.title} className="sm:col-span-2">
        <Input id={`${id}-title`} value={draft.title} maxLength={LIMITS.titleMax} onChange={(e) => set('title', e.target.value)} aria-invalid={!!errors.title} />
      </Field>
      <Field label="Suite" htmlFor={`${id}-suite`} error={errors.suite}>
        <Input id={`${id}-suite`} list={`${id}-suites`} value={draft.suite} maxLength={LIMITS.shortTextMax} onChange={(e) => set('suite', e.target.value)} />
        <datalist id={`${id}-suites`}>
          {meta.data?.suites.map((s) => <option key={s} value={s} />)}
        </datalist>
      </Field>
      <Field label="Owner" htmlFor={`${id}-owner`} error={errors.owner}>
        <Input id={`${id}-owner`} list={`${id}-owners`} value={draft.owner} maxLength={LIMITS.shortTextMax} onChange={(e) => set('owner', e.target.value)} />
        <datalist id={`${id}-owners`}>
          {meta.data?.owners.map((s) => <option key={s} value={s} />)}
        </datalist>
      </Field>
      <Field label="Automation status" htmlFor={`${id}-status`}>
        <Select id={`${id}-status`} value={draft.automationStatus} onValueChange={(v) => v && set('automationStatus', v)} options={AUTOMATION_OPTIONS} className="w-full" />
      </Field>
      <Field label="Priority" htmlFor={`${id}-prio`}>
        <Select id={`${id}-prio`} value={draft.priority} onValueChange={(v) => set('priority', v)} options={PRIORITY_OPTIONS} allowNone noneLabel="None" className="w-full" />
      </Field>
      <Field label="Tags" htmlFor={`${id}-tags`} hint="Comma separated" error={errors.tags} className="sm:col-span-2">
        <Input id={`${id}-tags`} value={draft.tags} onChange={(e) => set('tags', e.target.value)} />
      </Field>
      <Field label="External URL" htmlFor={`${id}-url`} error={errors.externalUrl} className="sm:col-span-2">
        <Input id={`${id}-url`} type="url" value={draft.externalUrl} maxLength={LIMITS.urlMax} placeholder="https://…" onChange={(e) => set('externalUrl', e.target.value)} aria-invalid={!!errors.externalUrl} />
      </Field>
      <Field label="Allure fullName" htmlFor={`${id}-afn`} hint="Links imported results to this case" error={errors.allureFullName}>
        <Input id={`${id}-afn`} value={draft.allureFullName} maxLength={LIMITS.keyMax} onChange={(e) => set('allureFullName', e.target.value)} className="font-mono text-xs" />
      </Field>
      <Field label="Allure ID" htmlFor={`${id}-aid`} error={errors.allureId}>
        <Input id={`${id}-aid`} value={draft.allureId} maxLength={LIMITS.shortTextMax} onChange={(e) => set('allureId', e.target.value)} className="font-mono text-xs" />
      </Field>
    </div>
  );
}

export function NewTestCaseDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [draft, setDraft] = useState<CaseDraft>(draftFromCase());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const create = useCreateTestCase();
  const navigate = useNavigate();

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    const v = validateCase(draft, 'create');
    if (!v.ok) return setErrors(v.errors);
    setErrors({});
    create.mutate(v.value as never, {
      onSuccess: (tc) => {
        toast.success(`Created ${tc.key}`);
        onOpenChange(false);
        setDraft(draftFromCase());
        void navigate(`/tests/${tc.id}`);
      },
      onError: (err) => {
        if (err instanceof ApiError && err.status === 409) setErrors({ key: 'A test case with this key already exists.' });
      },
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="New test case"
      className="max-w-xl"
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => submit()} loading={create.isPending}>
            Create test case
          </Button>
        </>
      }
    >
      <form onSubmit={submit}>
        <CaseFields draft={draft} onChange={setDraft} errors={errors} />
        <button type="submit" className="hidden" aria-hidden tabIndex={-1} />
      </form>
    </Dialog>
  );
}
