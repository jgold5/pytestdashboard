import { useId, useState, type FormEvent } from 'react';
import { NoteCreate, TriageCategory, LIMITS, type Note } from '@ptd/shared';
import { useAuthor } from '../lib/author';
import { Button } from './ui/button';
import { Field, Input, Textarea } from './ui/input';
import { Select } from './ui/select';
import { Dialog } from './ui/dialog';
import { TRIAGE_META } from './status';
import { useBulkNote } from '../api/hooks';
import { toast } from 'sonner';
import { pluralize } from '../lib/utils';

export const TRIAGE_OPTIONS = TriageCategory.options.map((t) => {
  const M = TRIAGE_META[t];
  return {
    value: t,
    text: M.label,
    label: M.label,
    icon: <M.icon className="size-3.5" style={{ color: M.color }} aria-hidden />,
  };
});

export interface NoteDraft {
  body: string;
  triage: TriageCategory | null;
  ticketUrl: string;
}

/** Validates a draft with the shared schema; returns field errors or the clean values. */
export function validateNote(d: NoteDraft, author: string) {
  const r = NoteCreate.omit({ testCaseId: true }).safeParse({
    author,
    body: d.body,
    triage: d.triage,
    ticketUrl: d.ticketUrl.trim() ? d.ticketUrl.trim() : null,
  });
  if (r.success) return { ok: true as const, value: r.data };
  const errors: Record<string, string> = {};
  for (const issue of r.error.issues) {
    const k = String(issue.path[0] ?? 'form');
    errors[k] ??= k === 'body' && d.body.trim() === '' ? 'Write a note.' : issue.message;
  }
  return { ok: false as const, errors };
}

/** Inline "your name" field shown until an author name is stored (convenience only). */
export function AuthorField({ value, onChange, error }: { value: string; onChange: (v: string) => void; error?: string }) {
  const id = useId();
  return (
    <Field label="Your name" htmlFor={id} hint="Remembered in this browser for future notes." error={error}>
      <Input id={id} value={value} maxLength={LIMITS.shortTextMax} onChange={(e) => onChange(e.target.value)} autoComplete="name" />
    </Field>
  );
}

export function NoteFields({
  draft,
  onChange,
  errors,
  autoFocus,
}: {
  draft: NoteDraft;
  onChange: (d: NoteDraft) => void;
  errors?: Record<string, string>;
  autoFocus?: boolean;
}) {
  const id = useId();
  return (
    <div className="space-y-3">
      <Field label="Note" htmlFor={`${id}-body`} hint="Markdown supported. Links open in a new tab." error={errors?.body}>
        <Textarea
          id={`${id}-body`}
          value={draft.body}
          autoFocus={autoFocus}
          maxLength={LIMITS.noteBodyMax}
          placeholder="Why is this failing? e.g. “Staging DB was down during the run”"
          onChange={(e) => onChange({ ...draft, body: e.target.value })}
          aria-invalid={!!errors?.body}
        />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Triage" htmlFor={`${id}-triage`} error={errors?.triage}>
          <Select
            id={`${id}-triage`}
            value={draft.triage}
            onValueChange={(v) => onChange({ ...draft, triage: v })}
            options={TRIAGE_OPTIONS}
            allowNone
            noneLabel="No triage"
            className="w-full"
          />
        </Field>
        <Field label="Ticket URL" htmlFor={`${id}-ticket`} error={errors?.ticketUrl}>
          <Input
            id={`${id}-ticket`}
            type="url"
            inputMode="url"
            value={draft.ticketUrl}
            maxLength={LIMITS.urlMax}
            placeholder="https://jira…/browse/QA-123"
            onChange={(e) => onChange({ ...draft, ticketUrl: e.target.value })}
            aria-invalid={!!errors?.ticketUrl}
          />
        </Field>
      </div>
    </div>
  );
}

/** Add the same note (e.g. triage) to many cases at once — POST /api/notes/bulk. */
export function BulkNoteDialog({
  open,
  onOpenChange,
  testCaseIds,
  runId,
  title = 'Add note',
  description,
  defaultTriage = null,
  onDone,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  testCaseIds: number[];
  runId?: number | null;
  title?: string;
  description?: string;
  defaultTriage?: TriageCategory | null;
  onDone?: () => void;
}) {
  const [author, setAuthor] = useAuthor();
  const [authorDraft, setAuthorDraft] = useState(author);
  const [draft, setDraft] = useState<NoteDraft>({ body: '', triage: defaultTriage, ticketUrl: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const bulk = useBulkNote();
  const effectiveAuthor = author || authorDraft;

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    const v = validateNote(draft, effectiveAuthor.trim());
    if (!v.ok) {
      setErrors({ ...v.errors, ...(v.errors.author ? { author: 'Enter your name.' } : {}) });
      return;
    }
    if (!author) setAuthor(authorDraft);
    bulk.mutate(
      { ...v.value, testCaseIds, runId: runId ?? null },
      {
        onSuccess: (r) => {
          toast.success(`Note added to ${pluralize(r.created, 'case')}`);
          setDraft({ body: '', triage: defaultTriage, ticketUrl: '' });
          setErrors({});
          onOpenChange(false);
          onDone?.();
        },
      },
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description ?? `The same note will be added to ${pluralize(testCaseIds.length, 'test case')}.`}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => submit()} loading={bulk.isPending}>
            Add to {pluralize(testCaseIds.length, 'case')}
          </Button>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-3">
        {!author ? <AuthorField value={authorDraft} onChange={setAuthorDraft} error={errors.author} /> : null}
        <NoteFields draft={draft} onChange={setDraft} errors={errors} autoFocus />
      </form>
    </Dialog>
  );
}

export type { Note };
